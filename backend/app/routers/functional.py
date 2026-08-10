import os
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from .. import models, pagination, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department, require_not_requester, dashboard_department_scope
from ..constants import Role, QAStatus, QA_DEPARTMENT, FUNCTIONAL_EDITABLE_STATUSES, is_readiness_evidence_editable, validate_environment_promotion, validate_target_release_date, application_name_block_message
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store
from .. import application_names as app_names

router = APIRouter(prefix="/api/functional-requests", tags=["functional"])

# ---------------------------------------------------------------------------
# Functional Testing Request lifecycle -- covers whichever of Functional
# Testing/Sanity Testing/Regression Testing/UAT Support were selected on a QA
# Request (see routers/qa_requests.py::_sync_linked_child_requests), combined
# into a single request/workflow (models.FunctionalRequest). Carries the full
# lifecycle that used to live directly on the QA Request itself:
#
#   Draft -> Submit -> same-department SM Approval -> same-department
#   Department Head Approval (assigns a COE - Quality Assurance QA Lead) -> that lead starts
#   Readiness Verification -> QA Activity (Planning -> Tester
#   Assignment -> Test Design -> Execution, with a Defect -> Waiting For Fix
#   -> Retesting -> Regression Testing cycle) -> QA Completed -> QA Sign-off
#   -> Requester Verification -> Closed.
# ---------------------------------------------------------------------------


def _log(db: Session, entity_id: int, step: str, user: models.User, decision: str, comments: Optional[str] = None):
    db.add(models.ApprovalAction(
        entity_type="FUNCTIONAL_REQUEST", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected_statuses, action: str):
    if isinstance(expected_statuses, str):
        expected_statuses = [expected_statuses]
    if obj.status not in expected_statuses:
        raise HTTPException(
            400, f"'{action}' requires status in {expected_statuses} (currently '{obj.status}')"
        )


def _get_or_404(db: Session, req_id: int) -> "models.FunctionalRequest":
    obj = db.query(models.FunctionalRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "Functional Testing Request not found")
    return obj


def _it_qa_user(db: Session, user_id: Optional[int], role: str, label: str) -> models.User:
    user = db.query(models.User).get(user_id) if user_id else None
    if not user or not user.is_active or not user.has_role(role) or user.department != QA_DEPARTMENT:
        raise HTTPException(400, f"{label} must be an active {role.replace('_', ' ').title()} from {QA_DEPARTMENT}")
    return user


def _require_assigned_qa_lead(obj: "models.FunctionalRequest", user: models.User) -> None:
    if not user.has_role(Role.ADMIN) and obj.qa_lead_id != user.id:
        raise HTTPException(403, "Only the QA Lead assigned by the Department Head can perform this action")


def _assigned_tester_ids(obj: "models.FunctionalRequest") -> set[int]:
    return {int(value) for value in (obj.assigned_tester_ids or "").split(",") if value}


def _require_assigned_tester(obj: "models.FunctionalRequest", user: models.User) -> None:
    if not user.has_role(Role.ADMIN) and user.id not in _assigned_tester_ids(obj):
        raise HTTPException(403, "Only a COE - Quality Assurance QA Tester assigned by the QA Lead can perform this action")


@router.get("", response_model=pagination.Page[schemas.FunctionalListOut])
def list_functional(params: pagination.PageParams = Depends(), requester_id: Optional[int] = None,
                     db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # department/application_name/epic_number/application_master_status are
    # all delegated (read-only) properties resolved through the `qa_request`
    # relationship (see models.FunctionalRequest), not real columns -- every
    # filter that touches them needs the same join dashboard_department_scope
    # already required, and every row needs qa_request (+ its own
    # application_master) eager-loaded so FunctionalListOut's read of those
    # properties doesn't turn into a lazy-load-per-row N+1 (PAG-007/DBP-005).
    # isouter=True (not an inner join): qa_request_id is nullable (standalone
    # creation is disabled now, see create_functional above, but older rows
    # from before that -- if any -- would otherwise silently vanish from
    # every list view under an inner join).
    q = db.query(models.FunctionalRequest).join(
        models.QARequest, models.FunctionalRequest.qa_request_id == models.QARequest.id, isouter=True
    ).options(
        joinedload(models.FunctionalRequest.qa_request).joinedload(models.QARequest.application_master)
    )
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.filter(models.QARequest.department == scope)
    q = pagination.apply_search(q, params, models.FunctionalRequest.request_id, models.QARequest.application_name)
    q = pagination.apply_status_filter(q, params, models.FunctionalRequest.status)
    q = pagination.apply_department_filter(q, params, models.QARequest.department)
    # Module-specific, same reasoning/reported issue as qa_requests.py's own
    # requester_id addition -- lets Dashboard.tsx's "My Requests" tab filter
    # server-side instead of over a department-wide, page_size=100-capped
    # fetch that could silently omit a user's own older requests.
    if requester_id is not None:
        q = q.filter(models.FunctionalRequest.requester_id == requester_id)
    q = pagination.apply_sort(
        q, params,
        sortable={
            "created_at": models.FunctionalRequest.created_at,
            "updated_at": models.FunctionalRequest.updated_at,
            "status": models.FunctionalRequest.status,
            "application_name": models.QARequest.application_name,
        },
        default_column=models.FunctionalRequest.created_at, id_column=models.FunctionalRequest.id,
    )
    result = pagination.paginate(q, params)
    return pagination.to_page_response(result, params)


@router.get("/{req_id}", response_model=schemas.FunctionalOut)
def get_functional(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_or_404(db, req_id)


# Standalone creation is DISABLED -- a Functional Testing Request can only
# originate from a QA Request that includes Functional Testing/Sanity
# Testing/Regression Testing/UAT Support in its request types.
@router.post("", response_model=schemas.FunctionalOut)
def create_functional(payload: schemas.FunctionalCreate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    raise HTTPException(
        400,
        "Standalone Functional Testing Requests can no longer be raised directly -- include "
        "Functional Testing / Sanity Testing / Regression Testing / UAT Support in a QA Request's "
        "request types instead.",
    )


# Priority/risk_rating are real columns on FunctionalRequest itself; every
# other editable field is delegated (read-only property) from the parent QA
# Request, so it has to be written onto obj.qa_request instead of obj -- a
# plain setattr(obj, k, v) loop would raise AttributeError (no setter) for
# any of these. See schemas.FunctionalUpdate for the full field list/reasoning.
_FUNCTIONAL_OWN_FIELDS = {"priority", "risk_rating"}

# These identify *which* request this actually is -- changing them once the
# request exists (i.e. once it's been raised, since standalone creation is
# disabled) is an Admin-only action, same restriction as SAST/DAST/
# Performance's own Edit Details (see update_sast/update_dast/
# update_performance). A submitted value equal to the current one is let
# through for anyone -- that's not actually a change, just the form
# resubmitting a field it also displays.
_ADMIN_ONLY_FIELDS = {"application_name", "epic_number", "cr_number"}


@router.put("/{req_id}", response_model=schemas.FunctionalOut)
def update_functional(req_id: int, payload: schemas.FunctionalUpdate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    """Lets the requester (or SM/Department Head of the requester's own
    department) fix up a Functional Testing Request's details after it's
    been raised -- including the "Application & Change Details"/"Release &
    Environment" fields that are otherwise stuck once the QA Request gateway
    itself leaves DRAFT (see constants.GATEWAY_EDITABLE_STATUSES), since this
    request type has always shown them but, until now, had no way back in to
    correct one. QA (QA Lead/QA Engineer) deliberately has NO edit access
    here -- editing is a business-side (requester/SM/Department Head)
    concern, not QA's; QA's own recourse is to Return the request, which
    puts it back into an editable status for the requester. Same
    editable-status gate as the other modules' Edit Details endpoints
    (RETURNED_BY_QA_LEAD is still in FUNCTIONAL_EDITABLE_STATUSES -- that's
    "returned to requester", not "QA may edit"). Application Name/Epic
    Number/CR Number are further restricted to Admins only -- see
    _ADMIN_ONLY_FIELDS."""
    obj = _get_or_404(db, req_id)
    # See _can_edit_details's own docstring below for the full permission
    # model (requester while it's theirs/returned to them; SM/Department
    # Head only while it's genuinely pending their own decision).
    if obj.status not in FUNCTIONAL_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    if not _can_edit_details(obj, current_user):
        raise HTTPException(403, "You do not have permission to edit this request in its current status")
    data = payload.model_dump(exclude_unset=True)
    if not current_user.has_role(Role.ADMIN):
        for f in _ADMIN_ONLY_FIELDS:
            if f in data and data[f] != getattr(obj, f):
                raise HTTPException(403, f"Only an Administrator can change {f.replace('_', ' ').title()}")
    checked_items = data.pop("checked_items", None)
    # Same Deployment/Target Promotion Environment ordering rule as
    # routers/qa_requests.py's create_request/edit_request -- environment/
    # target_promotion_environment are delegated (read-only) properties on
    # `obj` that resolve through obj.qa_request, so they can be read directly
    # here as the "not part of this particular edit" fallback the same way
    # edit_request falls back to its own obj's current values.
    if "environment" in data or "target_promotion_environment" in data:
        final_environment = data.get("environment", obj.environment)
        final_target = data.get("target_promotion_environment", obj.target_promotion_environment)
        try:
            validate_environment_promotion(final_environment, final_target)
        except ValueError as e:
            raise HTTPException(400, str(e))
    if "target_release_date" in data:
        try:
            validate_target_release_date(data["target_release_date"])
        except ValueError as e:
            raise HTTPException(400, str(e))
    # Reported directly ("Duplicate Application Name Validation Across All
    # Request Actions"): application_name used to fall straight into the
    # generic setattr(obj.qa_request, k, v) branch below -- a bare string
    # write with zero case/whitespace normalization and no dedup check
    # against models.ApplicationMaster, and obj.qa_request.application_master_id
    # was never updated to match, leaving the gateway's own approval-status
    # tracking stale. Popped out and routed through the same
    # resolve_application_name/cleanup_orphaned_application_master pair
    # routers/qa_requests.py::edit_request already uses for this exact field
    # on this exact same underlying QARequest row, so an Admin correcting a
    # typo here reuses an existing name (any case/spacing variant) instead of
    # silently creating a near-duplicate ApplicationMaster entry, same as
    # every other Application Name entry point in the app. Only re-resolved
    # when genuinely different from what's already saved (case/whitespace-
    # insensitive) -- same guard edit_request uses, so a plain re-save of an
    # unrelated field never re-touches it.
    application_name_in = data.pop("application_name", None)
    if application_name_in is not None and obj.qa_request:
        incoming_upper = (application_name_in or "").strip().upper()
        if incoming_upper != (obj.qa_request.application_name or "").strip().upper():
            old_master_id = obj.qa_request.application_master_id
            obj.qa_request.application_name, obj.qa_request.application_master_id = app_names.resolve_application_name(
                db, application_name_in, obj.qa_request.department, current_user.id, qa_request_id=obj.qa_request.id,
            )
            app_names.cleanup_orphaned_application_master(db, old_master_id, obj.qa_request.id)
    for k, v in data.items():
        if k in _FUNCTIONAL_OWN_FIELDS:
            setattr(obj, k, v)
        elif obj.qa_request:
            # Standalone creation is disabled (see create_functional above),
            # so obj.qa_request should always be set for a real row -- this
            # guard just avoids a crash on the theoretical legacy row with
            # none, rather than silently pretending the edit succeeded.
            setattr(obj.qa_request, k, v)
    if checked_items is not None:
        # Lets the requester revisit their "Ready for Testing" readiness
        # checklist self-declaration from this same Edit Details modal --
        # previously the only place to tick these was the QA Request wizard
        # at intake time, with no way back in at all afterward (unlike
        # Performance/SAST/DAST, which already supported this).
        checked_set = set(checked_items)
        for item in obj.checklist_items:
            item.requester_checked = item.item in checked_set
    db.commit()
    db.refresh(obj)
    return obj


# ---- Requester: Draft -> Submitted -> SM Approval Pending ----
@router.post("/{req_id}/submit", response_model=schemas.FunctionalOut)
def submit_request(req_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST))):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, QAStatus.DRAFT, "Submit")
    obj.status = QAStatus.SUBMITTED
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    if obj.application_master_status == "REJECTED":
        # The Application Name this request uses (delegated from its parent
        # QA Request) was already rejected by an SM -- see
        # routers/applications.py::_auto_reject_linked_requests, which
        # force-rejects any request that's already sitting at SM Approval
        # the moment the name is rejected. This covers the other case: a
        # sibling request (e.g. SAST/DAST) that only reaches Submit
        # *after* the name was already rejected shouldn't get a fresh shot at
        # SM Approval under a name that's already known-bad -- it lands
        # straight at Rejected instead.
        obj.status = QAStatus.SM_REJECTED
        _log(db, obj.id, "SM Approval", current_user, "Rejected",
             "Auto-rejected: this request's Application Name was rejected by SM")
    else:
        obj.status = QAStatus.SM_APPROVAL_PENDING
        _log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/resubmit", response_model=schemas.FunctionalOut)
def resubmit_request(req_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST))):
    """Re-submits a request returned by SM, by the Department Head, or by the
    QA Lead -- or reopens one rejected by SM. Reported directly: a Rejected-
    by-SM request used to be a dead end (see QA_REQUEST_TERMINAL_STATUSES),
    with no way back in even if the requester fixed whatever caused the
    rejection. It's now reopenable the same way a Return is: edit details,
    then call this endpoint to send it straight back to SM_APPROVAL_PENDING
    for a fresh decision."""
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, [QAStatus.RETURNED_BY_SM, QAStatus.SM_REJECTED,
                   QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD],
             "Resubmit")
    if obj.status in (QAStatus.RETURNED_BY_SM, QAStatus.SM_REJECTED):
        reopening = obj.status == QAStatus.SM_REJECTED
        if obj.application_master_status == "REJECTED":
            obj.status = QAStatus.SM_REJECTED
            _log(db, obj.id, "SM Approval", current_user, "Rejected",
                 "Auto-rejected: this request's Application Name was rejected by SM")
        else:
            obj.status = QAStatus.SM_APPROVAL_PENDING
            _log(db, obj.id, "SM Approval", current_user,
                 "Reopened" if reopening else "Resubmitted",
                 "Rejected request reopened and re-submitted" if reopening else "Returned request re-submitted")
    elif obj.status == QAStatus.RETURNED_BY_DEPARTMENT_HEAD:
        # A genuine direct return from Department Head Approval itself.
        obj.status = QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == QAStatus.RETURNED_BY_QA_LEAD and obj.needs_dept_head_reapproval:
        # QA Lead returned it but flagged that the fix needs a fresh
        # Department Head approval before Readiness Verification resumes.
        obj.status = QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted",
             "Returned request re-submitted (Department Head re-approval required)")
    else:
        obj.status = QAStatus.READINESS_VERIFICATION
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Readiness Verification", current_user, "Resubmitted", "Returned request re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


# ---- SM Approval: Approve (-> Department Head) / Return / Reject ----
@router.post("/{req_id}/sm-decision", response_model=schemas.FunctionalOut)
def sm_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                current_user: models.User = Depends(require_roles(Role.SM))):
    """Checkpoint between the requester's submission and Department Head
    approval. A Return goes back to the requester for correction; a Reject
    closes the request out (SM_REJECTED, terminal)."""
    obj = _get_or_404(db, req_id)
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, QAStatus.SM_APPROVAL_PENDING, "SM decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(400, application_name_block_message(obj.application_master_status, "sm"))
    if payload.decision == "Approved":
        obj.status = QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING
    elif payload.decision == "Returned":
        obj.status = QAStatus.RETURNED_BY_SM
    elif payload.decision == "Rejected":
        obj.status = QAStatus.SM_REJECTED
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- Department Head Approval: Approve / Return / Reject ----
@router.post("/{req_id}/department-head-decision", response_model=schemas.FunctionalOut)
def department_head_decision(req_id: int, payload: schemas.DepartmentHeadDecisionIn, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM))):
    """Department Head reviews the request and assigns a COE - Quality Assurance QA Lead."""
    obj = _get_or_404(db, req_id)
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, "Department Head decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(400, application_name_block_message(obj.application_master_status, "department_head"))
    obj.department_head_id = current_user.id

    if payload.decision == "Approved":
        qa_lead = _it_qa_user(db, payload.qa_lead_id, Role.QA_LEAD, "qa_lead_id")
        obj.qa_lead_id = qa_lead.id
        obj.status = QAStatus.QA_LEAD_ASSIGNED
    elif payload.decision == "Returned":
        obj.status = QAStatus.RETURNED_BY_DEPARTMENT_HEAD
    elif payload.decision == "Rejected":
        obj.status = QAStatus.DEPARTMENT_HEAD_REJECTED
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")

    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- QA Lead: Readiness Verification ----
@router.post("/{req_id}/start-readiness-verification", response_model=schemas.FunctionalOut)
def start_readiness_verification(req_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.QA_LEAD_ASSIGNED, "Start readiness verification")
    _require_assigned_qa_lead(obj, current_user)
    obj.status = QAStatus.READINESS_VERIFICATION
    _log(db, obj.id, "QA Readiness", current_user, "Started", "Readiness verification started by assigned QA Lead")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/readiness-decision", response_model=schemas.FunctionalOut)
def readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.READINESS_VERIFICATION, "Readiness decision")
    _require_assigned_qa_lead(obj, current_user)
    if payload.decision == "Passed":
        # Every item the requester actually self-declared ready
        # (requester_checked) must be QA-verified (is_complete) before
        # Readiness Verification can Pass. Scoped to requester_checked rather
        # than every item on the list -- an item the requester never declared
        # ready in the first place can't be QA-verified anyway (see
        # update_checklist_item's own gate below), so requiring it here too
        # would permanently block Passed with no way forward; the requester
        # simply never claimed it, so it isn't part of what QA is confirming.
        # This checklist is Admin-configurable now (see checklist_config.py)
        # -- a mandatory item is already forced to be self-declared
        # (requester_checked) before the request can even be raised (see
        # routers/qa_requests.py::submit_request's pending_checklist_items
        # gate), so by the time a request reaches Readiness Verification at
        # all, every mandatory item is already inside the requester_checked
        # set checked below -- no separate mandatory-only check is needed
        # here on top of it.
        pending = [c.item for c in obj.checklist_items if c.requester_checked and not c.is_complete]
        if pending:
            raise HTTPException(400, f"Readiness checklist incomplete: {', '.join(pending)}")
        obj.status = QAStatus.QA_ACTIVITY_INITIATED
    elif payload.decision == "Failed":
        # The QA Lead acting here chooses whether this return needs
        # a fresh Department Head approval (routes back through
        # DEPARTMENT_HEAD_APPROVAL_PENDING on resubmit) or can go straight
        # back to them once the requester fixes it (the default -- same QA
        # Lead, no re-approval needed). Status is always RETURNED_BY_QA_LEAD --
        # the QA Lead is who actually returned it -- never
        # RETURNED_BY_DEPARTMENT_HEAD (misleading: that reads as though the
        # Department Head personally returned it, when they haven't even seen
        # it yet). The re-approval choice is tracked separately via
        # needs_dept_head_reapproval, which `resubmit` below reads to decide
        # routing, and which the frontend surfaces as a note next to the
        # (accurate) status badge.
        obj.status = QAStatus.RETURNED_BY_QA_LEAD
        obj.needs_dept_head_reapproval = payload.require_dept_head_reapproval
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Readiness Verification", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- QA Activity: Planning -> Tester Assignment -> Test Design -> Execution ----
@router.post("/{req_id}/begin-planning", response_model=schemas.FunctionalOut)
def begin_planning(req_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.QA_ACTIVITY_INITIATED, "Begin planning")
    _require_assigned_qa_lead(obj, current_user)
    obj.status = QAStatus.PLANNING
    _log(db, obj.id, "QA Activity Initiated", current_user, "Planning Started", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/assign-tester", response_model=schemas.FunctionalOut)
def assign_tester(req_id: int, payload: schemas.AssignTesterIn, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.PLANNING, "Assign tester")
    _require_assigned_qa_lead(obj, current_user)
    if not payload.tester_ids:
        raise HTTPException(400, "At least one tester_id is required")
    unique_ids = list(dict.fromkeys(payload.tester_ids))
    testers = [_it_qa_user(db, tester_id, Role.QA_ENGINEER, f"tester_id {tester_id}") for tester_id in unique_ids]
    obj.assigned_tester_ids = ",".join(str(i) for i in unique_ids)
    obj.status = QAStatus.TESTER_ASSIGNED
    # Resolve to full names for the history log -- previously logged the raw
    # numeric ids (e.g. "Assigned tester user ids: [3]"), which meant nothing
    # to anyone reading the History tab. Falls back to "user #<id>" for any
    # id that doesn't resolve (e.g. a since-deleted account).
    name_by_id = {u.id: u.full_name for u in testers}
    tester_names = [name_by_id[i] for i in unique_ids]
    _log(db, obj.id, "Planning", current_user, "Tester Assigned", f"Assigned tester(s): {', '.join(tester_names)}")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-test-design", response_model=schemas.FunctionalOut)
def start_test_design(req_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles( Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.TESTER_ASSIGNED, "Start test design")
    _require_assigned_tester(obj, current_user)
    obj.status = QAStatus.TEST_DESIGN
    _log(db, obj.id, "Tester Assigned", current_user, "Test Design Started", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-execution", response_model=schemas.FunctionalOut)
def start_execution(req_id: int, payload: schemas.StartFunctionalExecutionIn,
                     db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.TEST_DESIGN, "Start execution")
    _require_assigned_tester(obj, current_user)
    # A link can be created from either side of the relationship. Resolve it
    # before evaluating this request so starting from Functional never asks
    # for (or creates) a second link when Test Lifecycle already linked one.
    existing_link = (db.query(models.TestCycleChildRequestLink)
                     .filter_by(child_type="Functional", child_id=obj.id)
                     .order_by(models.TestCycleChildRequestLink.id.asc())
                     .first())
    cycle = existing_link.cycle if existing_link else None
    if payload.link_test_cycle:
        if payload.test_cycle_id is None:
            raise HTTPException(400, "Select a test cycle before starting execution")
        selected_cycle = (db.query(models.TestCycle)
                          .join(models.TestProject, models.TestCycle.project_id == models.TestProject.id)
                          .filter(models.TestCycle.id == payload.test_cycle_id,
                                  models.TestProject.is_active == True,  # noqa: E712 - Oracle requires = 1, not IS 1
                          models.TestCycle.status == "In Progress")
                          .first())
        if not selected_cycle:
            raise HTTPException(400, "The selected test cycle is no longer active or eligible")
        if existing_link and existing_link.cycle_id != selected_cycle.id:
            raise HTTPException(400, f"Test cycle {cycle.cycle_key} is already linked to this request")
        cycle = selected_cycle
        application_master_id = obj.qa_request.application_master_id if obj.qa_request else None
        if (application_master_id and cycle.project.application_master_id is not None
                and cycle.project.application_master_id != application_master_id):
            raise HTTPException(400, "The selected test cycle is not relevant to this request's application")
        cycle_link = db.query(models.TestCycleChildRequestLink).filter_by(cycle_id=cycle.id).first()
        if cycle_link:
            if cycle_link.child_type != "Functional" or cycle_link.child_id != obj.id:
                raise HTTPException(400, "This test cycle is already linked to another request")
        else:
            db.add(models.TestCycleChildRequestLink(
                cycle_id=cycle.id, child_type="Functional", child_id=obj.id, child_key=obj.request_id,
            ))
    obj.status = QAStatus.EXECUTION_IN_PROGRESS
    _log(
        db, obj.id, "Test Design", current_user, "Execution Started",
        f"Linked test cycle {cycle.cycle_key} - {cycle.name}" if cycle else "Started without a linked test cycle",
    )
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{req_id}/eligible-test-cycles", response_model=List[schemas.EligibleTestCycleOut])
def eligible_test_cycles(req_id: int, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.TEST_DESIGN, "List eligible test cycles")
    _require_assigned_tester(obj, current_user)
    query = (db.query(models.TestCycle)
             .join(models.TestProject, models.TestCycle.project_id == models.TestProject.id)
             .outerjoin(models.TestCycleChildRequestLink, models.TestCycleChildRequestLink.cycle_id == models.TestCycle.id)
             .filter(models.TestProject.is_active == True,  # noqa: E712 - Oracle requires = 1, not IS 1
                     models.TestCycle.status == "In Progress",
                     models.TestCycleChildRequestLink.id.is_(None)))
    application_master_id = obj.qa_request.application_master_id if obj.qa_request else None
    if application_master_id:
        # Older Test Projects and projects created without an Application
        # Master mapping have NULL here. They are still valid candidates;
        # only projects explicitly mapped to a different application are
        # irrelevant and excluded.
        query = query.filter(or_(
            models.TestProject.application_master_id == application_master_id,
            models.TestProject.application_master_id.is_(None),
        ))
    cycles = query.order_by(models.TestCycle.created_at.desc()).all()
    return [{
        "id": cycle.id, "cycle_key": cycle.cycle_key, "project_id": cycle.project_id,
        "project_key": cycle.project.project_key, "project_name": cycle.project.name,
        "name": cycle.name, "status": cycle.status, "start_date": cycle.start_date,
        "end_date": cycle.end_date,
    } for cycle in cycles]


@router.delete("/{req_id}/test-cycles/{cycle_id}", response_model=schemas.FunctionalOut)
def unlink_test_cycle(req_id: int, cycle_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    can_manage = (current_user.has_role(Role.ADMIN) or obj.qa_lead_id == current_user.id
                  or current_user.id in _assigned_tester_ids(obj))
    if not can_manage:
        raise HTTPException(403, "Only the assigned QA Lead or Tester can unlink this test cycle")
    link = db.query(models.TestCycleChildRequestLink).filter_by(
        cycle_id=cycle_id, child_type="Functional", child_id=obj.id,
    ).first()
    if not link:
        raise HTTPException(404, "This test cycle is not linked to the Functional Testing request")
    if link.cycle.status in ("Blocked", "Completed"):
        raise HTTPException(400, f"This Test Cycle is {link.cycle.status} and its request link cannot be changed")
    cycle_key = link.cycle.cycle_key
    cycle_name = link.cycle.name
    db.delete(link)
    _log(db, obj.id, "Test Execution", current_user, "Test Cycle Unlinked",
         f"Unlinked test cycle {cycle_key} - {cycle_name}")
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=cycle_id, step_name="Request Link",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Functional Request Unlinked", comments=f"Unlinked {obj.request_id}",
    ))
    db.commit()
    db.refresh(obj)
    return obj


# ---- Defect -> Fix -> Retest -> Regression cycle ----
# Workflow change (reported directly: "raise defect, start retest currently
# not required as everything is linked with test cycle"): once a Test Cycle
# is linked to this request (see start_execution's link_test_cycle option),
# defects are raised, tracked, and retested through Test Execution + the
# Defects module -- both scoped to that Test Cycle -- instead of this
# request's own manual Defect Raised -> Waiting For Fix -> Retesting states.
# This whole 3-endpoint sub-flow (raise_defect/mark_waiting_for_fix/
# start_retesting) is therefore now reachable only for a request that was
# started WITHOUT linking a cycle (still a supported path -- see
# eligible_test_cycles/start_execution's own link_test_cycle=False branch),
# where it remains the only defect-tracking mechanism available. See
# complete_qa below for the matching linked-cycle-completion gate.
def _require_no_linked_cycle_for_manual_defect_flow(obj: "models.FunctionalRequest", action: str) -> None:
    if obj.linked_test_cycles:
        raise HTTPException(
            400,
            f"'{action}' is not used once a Test Cycle is linked -- raise, fix, and retest defects from "
            "Test Execution / the Defects module against the linked Test Cycle instead.",
        )


@router.post("/{req_id}/raise-defect", response_model=schemas.FunctionalOut)
def raise_defect(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.EXECUTION_IN_PROGRESS, "Raise defect")
    _require_assigned_tester(obj, current_user)
    _require_no_linked_cycle_for_manual_defect_flow(obj, "Raise Defect")
    obj.status = QAStatus.DEFECT_RAISED
    _log(db, obj.id, "Execution In Progress", current_user, "Defect Raised", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/mark-waiting-for-fix", response_model=schemas.FunctionalOut)
def mark_waiting_for_fix(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.DEFECT_RAISED, "Mark waiting for fix")
    _require_assigned_tester(obj, current_user)
    obj.status = QAStatus.WAITING_FOR_FIX
    _log(db, obj.id, "Defect Raised", current_user, "Waiting For Fix", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-retesting", response_model=schemas.FunctionalOut)
def start_retesting(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.WAITING_FOR_FIX, "Start retesting")
    _require_assigned_tester(obj, current_user)
    obj.status = QAStatus.RETESTING
    _log(db, obj.id, "Waiting For Fix", current_user, "Retesting Started", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/complete-qa", response_model=schemas.FunctionalOut)
def complete_qa(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.QA_ENGINEER))):
    """Marks QA activity complete -- reachable directly from execution (no issues found)
    or after the defect/retest cycle.

    Not gated on any SAST/DAST/Performance sibling raised alongside it on the
    same gateway QA Request -- every request type runs its own fully
    independent workflow end-to-end (see models.QARequest's own docstring:
    "QA request form is the gateway only"), so Functional completing has
    never depended on -- and now explicitly does not wait for -- a sibling
    request's own status."""
    obj = _get_or_404(db, req_id)
    _require(obj, [QAStatus.EXECUTION_IN_PROGRESS, QAStatus.RETESTING], "Complete QA")
    _require_assigned_tester(obj, current_user)

    # Workflow change (reported directly): once execution is tracked through
    # a linked Test Cycle, that cycle's own lifecycle is the real record of
    # whether testing actually finished -- QA Complete can no longer jump
    # ahead of it. Every linked cycle must reach "Completed" first. A
    # request that was started without linking a cycle (link_test_cycle=
    # False at Start Execution) has nothing to wait on and keeps today's
    # behavior unchanged. See raise_defect's matching comment above for why
    # the Defect Raised/Waiting For Fix/Retesting states are no longer part
    # of this path once a cycle is linked.
    open_cycles = [cycle for cycle in obj.linked_test_cycles if cycle.status != "Completed"]
    if open_cycles:
        names = ", ".join(f"{cycle.cycle_key} ({cycle.status})" for cycle in open_cycles)
        raise HTTPException(
            400,
            f"Mark QA Complete requires every linked Test Cycle to reach Completed first. "
            f"Still open: {names}",
        )

    obj.status = QAStatus.QA_COMPLETED
    _log(db, obj.id, "Execution", current_user, "QA Completed", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- QA Sign-off -> Requester Verification -> Closed ----
@router.post("/{req_id}/request-signoff", response_model=schemas.FunctionalOut)
def request_signoff(req_id: int, payload: schemas.RequestSignoffIn = schemas.RequestSignoffIn(),
                     db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.QA_COMPLETED, "Request sign-off")
    _require_assigned_tester(obj, current_user)
    # The frontend now creates the QA Sign-off Certificate (POST /api/signoffs)
    # right before calling this, via SignOff.tsx's NewSignOffModal opened from
    # this request's own "Request Sign-off" button -- link it immediately
    # rather than leaving it to confirm-signoff, so the certificate is
    # associated with this request from the moment sign-off is requested.
    if payload.signoff_id is not None:
        cert = db.query(models.QASignOff).get(payload.signoff_id)
        if not cert:
            raise HTTPException(400, "signoff_id does not reference an existing sign-off certificate")
        obj.signoff_id = payload.signoff_id
    obj.status = QAStatus.QA_SIGNOFF_PENDING
    _log(db, obj.id, "QA Completed", current_user, "Sign-off Requested", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/confirm-signoff", response_model=schemas.FunctionalOut)
def confirm_signoff(req_id: int, payload: schemas.ConfirmSignoffIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Confirms the QA Sign-off certificate (optionally linking a Module 8 QASignOff
    record created via /api/signoffs) and hands the request to the requester for
    final verification.

    Superseded for the normal case: routers/signoff.py::department_head_coe_decision
    now does this automatically the instant a certificate reaches ISSUED (see
    _sync_linked_functional_request there) -- a QA Lead no longer needs to
    remember a separate manual click, and the frontend's own "Confirm Sign-off"
    button has been removed (see Functional.tsx). Left in place, not deleted, as
    a manual fallback (e.g. a certificate issued before this change existed, with
    no linked FunctionalRequest.signoff_id yet to auto-sync against) -- reachable
    only while status is still QA_SIGNOFF_PENDING, which the auto-sync above
    already moves past for every certificate it successfully links."""
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.QA_SIGNOFF_PENDING, "Confirm sign-off")
    if payload.signoff_id is not None:
        cert = db.query(models.QASignOff).get(payload.signoff_id)
        if not cert:
            raise HTTPException(400, "signoff_id does not reference an existing sign-off certificate")
        obj.signoff_id = payload.signoff_id
    obj.status = QAStatus.QA_SIGNED_OFF
    _log(db, obj.id, "QA Sign-off", current_user, "Signed Off", payload.comments)
    obj.status = QAStatus.REQUESTER_VERIFICATION
    _log(db, obj.id, "Requester Verification", current_user, "Pending", "Sent for requester verification")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/requester-decision", response_model=schemas.FunctionalOut)
def requester_decision(req_id: int, payload: schemas.RequesterDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(
                            Role.REQUESTER, Role.BUSINESS_ANALYST, Role.APPLICATION_OWNER))):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can record this decision")
    _require(obj, QAStatus.REQUESTER_VERIFICATION, "Requester decision")
    if payload.decision == "Accepted":
        obj.status = QAStatus.CLOSED
    elif payload.decision == "ChangesRequired":
        obj.status = QAStatus.QA_LEAD_ASSIGNED
    else:
        raise HTTPException(400, "decision must be one of: Accepted, ChangesRequired")
    _log(db, obj.id, "Requester Verification", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- Readiness checklist (Ready for Testing gate) ----
@router.get("/{req_id}/checklist", response_model=List[schemas.ChecklistItemOut])
def get_checklist(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.ReadinessChecklistItem).filter_by(functional_request_id=req_id).all()


@router.put("/{req_id}/checklist/{item_id}", response_model=schemas.ChecklistItemOut)
def update_checklist_item(req_id: int, item_id: int, payload: schemas.ChecklistItemUpdate,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    item = db.query(models.ReadinessChecklistItem).filter_by(id=item_id, functional_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    parent = db.query(models.FunctionalRequest).get(req_id)
    if not parent or parent.status != QAStatus.READINESS_VERIFICATION:
        raise HTTPException(
            400,
            "Readiness checklist items can only be verified while the request is in "
            "Readiness Verification (i.e. by the QA Lead after Executive Approval) -- "
            "not while still in Draft or any other stage.",
        )
    _require_assigned_qa_lead(parent, current_user)
    # The QA Lead verifies the requester's own self-declaration -- they can't
    # tick an item the requester never declared ready in the first place (see
    # the frontend's matching disabled-checkbox behavior in Functional.tsx).
    if payload.is_complete and not item.requester_checked:
        raise HTTPException(
            400,
            "Cannot verify this item -- the requester has not self-declared it ready. "
            "Ask the requester to tick it first (Edit Details), then verify it here.",
        )
    item.is_complete = payload.is_complete
    if payload.is_complete:
        item.approved_by_id = current_user.id
        import datetime
        item.approved_at = models.now()
    else:
        item.approved_by_id = None
        item.approved_at = None
    db.commit()
    db.refresh(item)
    return item


# ---- Walkthrough sessions ----
@router.get("/{req_id}/walkthroughs", response_model=List[schemas.WalkthroughOut])
def list_walkthroughs(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.WalkthroughSession).filter_by(functional_request_id=req_id).all()


@router.post("/{req_id}/walkthroughs", response_model=schemas.WalkthroughOut)
def add_walkthrough(req_id: int, payload: schemas.WalkthroughCreate, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(
                         Role.BUSINESS_ANALYST, Role.REQUESTER, Role.QA_ENGINEER, Role.QA_LEAD))):
    if not db.query(models.FunctionalRequest).get(req_id):
        raise HTTPException(404, "Functional Testing Request not found")
    obj = models.WalkthroughSession(functional_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/walkthroughs/{wt_id}/acknowledge", response_model=schemas.WalkthroughOut)
def acknowledge_walkthrough(req_id: int, wt_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD))):
    obj = db.query(models.WalkthroughSession).filter_by(id=wt_id, functional_request_id=req_id).first()
    if not obj:
        raise HTTPException(404, "Walkthrough session not found")
    import datetime
    obj.qa_acknowledged_by_id = current_user.id
    obj.qa_acknowledged_at = models.now()
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def request_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="FUNCTIONAL_REQUEST", entity_id=req_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{req_id}/export")
def export_functional(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this Functional QA request (including the ones
    delegated from its parent QA Request gateway), its readiness checklist,
    and its full approval/workflow history -- who submitted, approved,
    returned, signed off, etc., and when -- as one downloadable PDF."""
    obj = _get_or_404(db, req_id)

    tester_names = []
    for uid in (obj.assigned_tester_ids or "").split(","):
        uid = uid.strip()
        if not uid:
            continue
        u = db.query(models.User).get(int(uid))
        if u:
            tester_names.append(u.full_name)

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Priority", obj.priority),
            ("Risk Rating", obj.risk_rating),
            ("Request Type(s)", obj.request_types),
        ]),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Epic Number", obj.epic_number),
            ("Change Request ID(s)", obj.cr_number),
            ("Change Type", obj.change_type),
            ("Department", obj.department),
        ]),
        ("Environment & Release", [
            ("Deployment Environment", obj.environment),
            ("Target Promotion Environment", obj.target_promotion_environment),
            ("Release Version / Hash Value", obj.release_version),
            ("Build Number / Hash Value", obj.build_number),
            ("Target Release Date", obj.target_release_date),
        ]),
        ("People", [
            ("Requester", obj.requester.full_name if obj.requester else None),
            ("Department Head", db.query(models.User).get(obj.department_head_id).full_name if obj.department_head_id else None),
            ("Assigned QA Lead", db.query(models.User).get(obj.qa_lead_id).full_name if obj.qa_lead_id else None),
            ("Assigned Tester(s)", ", ".join(tester_names) if tester_names else None),
        ]),
        ("Readiness Checklist", [
            (c.item, f"Requester declared: {'Yes' if c.requester_checked else 'No'} | QA verified: {'Yes' if c.is_complete else 'No'}"
                      + (" (Mandatory)" if c.is_mandatory else ""))
            for c in obj.checklist_items
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="FUNCTIONAL_REQUEST", entity_id=req_id)
                     .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in history_rows:
        actor = db.query(models.User).get(h.actor_id) if h.actor_id else None
        history.append((h.step_name or "—", h.decision or "—", actor.full_name if actor else "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="Functional QA Request — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=models.now().strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.request_id}.pdf"'},
    )


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
def _can_upload_documents(obj: "models.FunctionalRequest", user: models.User) -> bool:
    """Reported directly (Document and Evidence Access Control Based on
    Workflow Stage): access follows exactly 3 stages, then locks hard --
    (1) the requester, while the request is genuinely in their own hands
    (Draft/Submitted, Returned-by-*, Rejected, or back for their own final
    verification) may upload any number of files; (2) the SM, and only the
    SM, may upload while SM_APPROVAL_PENDING; (3) the Department Head, and
    only the Department Head, may upload while
    DEPARTMENT_HEAD_APPROVAL_PENDING. After Department Head approval, EVERY
    status is locked -- no QA Lead, tester, or anyone else may upload here
    -- until the request is returned to the requester (a RETURNED_BY_*
    status), which re-opens stage (1). This intentionally removes the prior
    QA-activity-status upload window (QA_LEAD_ASSIGNED through
    QA_SIGNOFF_PENDING) -- any evidence QA generates during actual execution
    belongs in Test Execution's own attempt-artifact system (TEST_EXEC_IMAGE
    in documents.py), not this readiness-facing Documents/Checklist
    Evidence store. Admin always bypasses, same convention as every other
    permission check in this file."""
    if user.has_role(Role.ADMIN):
        return True
    status = obj.status
    if status in (QAStatus.DRAFT, QAStatus.SUBMITTED, QAStatus.RETURNED_BY_SM, QAStatus.SM_REJECTED,
                  QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD,
                  QAStatus.REQUESTER_VERIFICATION):
        return obj.requester_id == user.id
    if status == QAStatus.SM_APPROVAL_PENDING:
        return user.has_role(Role.SM) and user.department == obj.department
    if status == QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING:
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.department == obj.department
    # Every QA-activity/post-approval/terminal status -- locked for everyone
    # but Admin until the request is returned to the requester above.
    return False


def _can_edit_details(obj: "models.FunctionalRequest", user: models.User) -> bool:
    """Reported bug: an SM could still edit a request's own details after
    already returning it themselves (status RETURNED_BY_SM) -- a dead end,
    since only the requester/admin can ever call resubmit_request, so the SM
    ended up with edit access they could never actually push forward.
    Clarified: edit access for a reviewer (SM/Department Head) should exist
    only while the request is genuinely pending *their own* decision
    (SM_APPROVAL_PENDING / DEPARTMENT_HEAD_APPROVAL_PENDING) -- fix
    something, then Approve/Return/Reject -- and disappears the moment
    they've decided either way. Once returned to the requester
    (RETURNED_BY_SM/RETURNED_BY_DEPARTMENT_HEAD/RETURNED_BY_QA_LEAD), only
    the requester (or admin) may edit; reviewers are never involved again
    for a request already past their own checkpoint -- edit access for SM/
    Department Head stops at Department Head's own decision, never
    extending into QA's post-approval readiness/execution stages. Same
    department-scoping as those stages' own decision endpoints.

    SM_REJECTED is included alongside the RETURNED_BY_* statuses too --
    reported directly, a rejected request is now reopenable (edit + call
    resubmit_request), not a dead end, so the requester needs the same edit
    access here as they'd have after a Return."""
    if user.has_role(Role.ADMIN):
        return True
    status = obj.status
    if status in (QAStatus.DRAFT, QAStatus.RETURNED_BY_SM, QAStatus.SM_REJECTED,
                  QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD):
        return obj.requester_id == user.id
    if status == QAStatus.SM_APPROVAL_PENDING:
        return user.has_role(Role.SM) and user.department == obj.department
    if status == QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING:
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.department == obj.department
    return False


@router.get("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_functional_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "FUNCTIONAL", req_id)


@router.post("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_functional_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                 current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester, central QA team, assigned tester, or the SM/Department Head currently reviewing the request can upload documents")
    return doc_store.save_documents(db, "FUNCTIONAL", req_id, obj.request_id, files, current_user.id,
                                    log_entity_type="FUNCTIONAL_REQUEST", log_entity_id=obj.id, log_actor=current_user)


@router.get("/{req_id}/documents/{doc_id}/download")
def download_functional_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "FUNCTIONAL", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/{req_id}/documents/{doc_id}")
def delete_functional_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                                current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    doc = doc_store.get_document_or_404(db, "FUNCTIONAL", req_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="FUNCTIONAL_REQUEST", log_entity_id=req_id, log_actor=current_user)
    return {"ok": True}


# ---- Evidence attached to one readiness-checklist row. Kept in the same
# shared document store under a distinct module key, so it remains separate
# from the request-level Documents tab and requires no schema migration. ----
def _functional_checklist_item_or_404(db: Session, req_id: int, item_id: int):
    item = db.query(models.ReadinessChecklistItem).filter_by(
        id=item_id, functional_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    return item


@router.get("/{req_id}/checklist/documents", response_model=List[schemas.ChecklistItemDocumentOut])
def list_functional_checklist_documents_batch(req_id: int, db: Session = Depends(get_db),
                                               current_user: models.User = Depends(get_current_user)):
    """Batched counterpart to list_functional_checklist_documents below --
    see ChecklistItemDocumentOut for why this exists."""
    _get_or_404(db, req_id)
    item_ids = [row.id for row in db.query(models.ReadinessChecklistItem.id)
                .filter_by(functional_request_id=req_id).all()]
    docs = doc_store.list_documents_for_items(db, "FUNCTIONAL_ITEM", item_ids)
    return [schemas.ChecklistItemDocumentOut(
        id=d.id, file_name=d.file_name, content_type=d.content_type,
        file_size=d.file_size, uploaded_by_id=d.uploaded_by_id, uploaded_at=d.uploaded_at,
        item_id=d.request_id) for d in docs]


@router.get("/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_functional_checklist_documents(req_id: int, item_id: int, db: Session = Depends(get_db),
                                         current_user: models.User = Depends(get_current_user)):
    _functional_checklist_item_or_404(db, req_id, item_id)
    return doc_store.list_documents(db, "FUNCTIONAL_ITEM", item_id)


@router.post("/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_functional_checklist_documents(req_id: int, item_id: int, files: List[UploadFile] = File(...),
                                           db: Session = Depends(get_db),
                                           current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    item = _functional_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester or this request's current stage owner can attach checklist evidence")
    return doc_store.save_documents(db, "FUNCTIONAL_ITEM", item_id,
                                    f"{obj.request_id}/checklist-{item_id}", files, current_user.id,
                                    log_entity_type="FUNCTIONAL_REQUEST", log_entity_id=obj.id, log_actor=current_user,
                                    log_label=f"checklist item '{item.item}'")


@router.get("/{req_id}/checklist/{item_id}/documents/{doc_id}/download")
def download_functional_checklist_document(req_id: int, item_id: int, doc_id: int,
                                            db: Session = Depends(get_db),
                                            current_user: models.User = Depends(get_current_user)):
    _functional_checklist_item_or_404(db, req_id, item_id)
    doc = doc_store.get_document_or_404(db, "FUNCTIONAL_ITEM", item_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name,
                        media_type=doc.content_type or "application/octet-stream")


@router.delete("/{req_id}/checklist/{item_id}/documents/{doc_id}")
def delete_functional_checklist_document(req_id: int, item_id: int, doc_id: int,
                                          db: Session = Depends(get_db),
                                          current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    item = _functional_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    doc = doc_store.get_document_or_404(db, "FUNCTIONAL_ITEM", item_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this evidence, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="FUNCTIONAL_REQUEST", log_entity_id=obj.id,
                              log_actor=current_user, log_label=f"checklist item '{item.item}'")
    return {"ok": True}
