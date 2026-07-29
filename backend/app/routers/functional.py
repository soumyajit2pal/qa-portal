import datetime
import os
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import Role, QAStatus, FUNCTIONAL_EDITABLE_STATUSES
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

router = APIRouter(prefix="/api/functional-requests", tags=["functional"])

# ---------------------------------------------------------------------------
# Functional Testing Request lifecycle -- covers whichever of Functional
# Testing/Sanity Testing/Regression Testing/UAT Support were selected on a QA
# Request (see routers/qa_requests.py::_sync_linked_child_requests), combined
# into a single request/workflow (models.FunctionalRequest). Carries the full
# lifecycle that used to live directly on the QA Request itself:
#
#   Draft -> Submit -> SM Approval -> Department Head Approval (assigns QA
#   Lead) -> Readiness Verification -> QA Activity (Planning -> Tester
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


@router.get("", response_model=List[schemas.FunctionalOut])
def list_functional(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.FunctionalRequest).order_by(models.FunctionalRequest.created_at.desc()).all()


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
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        # SM/Department Head editing is their own recourse after they've
        # actually reviewed the request and returned it for changes
        # (RETURNED_BY_SM/RETURNED_BY_DEPARTMENT_HEAD/RETURNED_BY_QA_LEAD) --
        # while it's still a plain DRAFT, it hasn't reached their approval
        # checkpoint at all yet, so only the requester (or an admin) may
        # touch it.
        if obj.status == QAStatus.DRAFT:
            raise HTTPException(403, "Only the requester or an admin can edit a request while it is still in Draft")
        if not current_user.has_role(Role.SM, Role.DEPARTMENT_HEAD):
            raise HTTPException(403, "Only the requester, SM, Department Head, or an admin can edit this request")
        require_same_department(current_user, obj.department)
    if obj.status not in FUNCTIONAL_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump(exclude_unset=True)
    if not current_user.has_role(Role.ADMIN):
        for f in _ADMIN_ONLY_FIELDS:
            if f in data and data[f] != getattr(obj, f):
                raise HTTPException(403, f"Only an Administrator can change {f.replace('_', ' ').title()}")
    checked_items = data.pop("checked_items", None)
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
    """Re-submits a request returned by SM, by the Department Head, or by the QA Lead."""
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, [QAStatus.RETURNED_BY_SM, QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD],
             "Resubmit")
    if obj.status == QAStatus.RETURNED_BY_SM:
        if obj.application_master_status == "REJECTED":
            obj.status = QAStatus.SM_REJECTED
            _log(db, obj.id, "SM Approval", current_user, "Rejected",
                 "Auto-rejected: this request's Application Name was rejected by SM")
        else:
            obj.status = QAStatus.SM_APPROVAL_PENDING
            _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned request re-submitted")
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
    _require(obj, QAStatus.SM_APPROVAL_PENDING, "SM decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(
            400,
            "This request's Application Name is not yet Approved -- decide it first "
            "(see the Application Name banner above) before approving the request itself.",
        )
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


# ---- Department Head Approval: Approve (+ assign QA Lead) / Return / Reject ----
@router.post("/{req_id}/department-head-decision", response_model=schemas.FunctionalOut)
def department_head_decision(req_id: int, payload: schemas.DepartmentHeadDecisionIn, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    """Department Head reviews the request raised by their own department and,
    on approval, assigns the QA Lead who will own it going forward. A Return
    goes back to the requester for correction; a Reject closes it out."""
    obj = _get_or_404(db, req_id)
    require_same_department(current_user, obj.department)
    _require(obj, QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, "Department Head decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(
            400,
            "This request's Application Name is not yet Approved by SM -- it must be decided "
            "before this request can be approved.",
        )
    obj.department_head_id = current_user.id

    if payload.decision == "Approved":
        if not payload.qa_lead_id:
            raise HTTPException(400, "qa_lead_id is required when approving (a QA Lead must be assigned)")
        qa_lead = db.query(models.User).get(payload.qa_lead_id)
        if not qa_lead or not qa_lead.has_role(Role.QA_LEAD):
            raise HTTPException(400, "qa_lead_id must reference an active QA Lead user")
        obj.qa_lead_id = payload.qa_lead_id
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
    if obj.qa_lead_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the assigned QA Lead or an admin can start readiness verification")
    _require(obj, QAStatus.QA_LEAD_ASSIGNED, "Start readiness verification")
    obj.status = QAStatus.READINESS_VERIFICATION
    _log(db, obj.id, "QA Lead Assignment", current_user, "Started", "Readiness verification started")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/readiness-decision", response_model=schemas.FunctionalOut)
def readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.READINESS_VERIFICATION, "Readiness decision")
    if payload.decision == "Passed":
        # Every item the requester actually self-declared ready
        # (requester_checked) must be QA-verified (is_complete) before
        # Readiness Verification can Pass -- not just the mandatory ones
        # (none of DEFAULT_CHECKLIST_ITEMS ship mandatory, see constants.py,
        # so a mandatory-only gate here was a no-op: the QA Lead could click
        # "Passed" the moment Readiness Verification started, without ever
        # ticking a single item). Scoped to requester_checked rather than
        # every item on the list -- an item the requester never declared
        # ready in the first place can't be QA-verified anyway (see
        # update_checklist_item's own gate below), so requiring it here too
        # would permanently block Passed with no way forward; the requester
        # simply never claimed it, so it isn't part of what QA is confirming.
        pending = [c.item for c in obj.checklist_items if c.requester_checked and not c.is_complete]
        if pending:
            raise HTTPException(400, f"Readiness checklist incomplete: {', '.join(pending)}")
        obj.status = QAStatus.QA_ACTIVITY_INITIATED
    elif payload.decision == "Failed":
        # The assigned QA Lead chooses, right here, whether this return needs
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
    if not payload.tester_ids:
        raise HTTPException(400, "At least one tester_id is required")
    obj.assigned_tester_ids = ",".join(str(i) for i in payload.tester_ids)
    obj.status = QAStatus.TESTER_ASSIGNED
    # Resolve to full names for the history log -- previously logged the raw
    # numeric ids (e.g. "Assigned tester user ids: [3]"), which meant nothing
    # to anyone reading the History tab. Falls back to "user #<id>" for any
    # id that doesn't resolve (e.g. a since-deleted account).
    testers = db.query(models.User).filter(models.User.id.in_(payload.tester_ids)).all()
    name_by_id = {u.id: u.full_name for u in testers}
    tester_names = [name_by_id.get(i, f"user #{i}") for i in payload.tester_ids]
    _log(db, obj.id, "Planning", current_user, "Tester Assigned", f"Assigned tester(s): {', '.join(tester_names)}")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-test-design", response_model=schemas.FunctionalOut)
def start_test_design(req_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.TESTER_ASSIGNED, "Start test design")
    obj.status = QAStatus.TEST_DESIGN
    _log(db, obj.id, "Tester Assigned", current_user, "Test Design Started", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-execution", response_model=schemas.FunctionalOut)
def start_execution(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.TEST_DESIGN, "Start execution")
    obj.status = QAStatus.EXECUTION_IN_PROGRESS
    _log(db, obj.id, "Test Design", current_user, "Execution Started", None)
    db.commit()
    db.refresh(obj)
    return obj


# ---- Defect -> Fix -> Retest -> Regression cycle ----
@router.post("/{req_id}/raise-defect", response_model=schemas.FunctionalOut)
def raise_defect(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.EXECUTION_IN_PROGRESS, "Raise defect")
    obj.status = QAStatus.DEFECT_RAISED
    _log(db, obj.id, "Execution In Progress", current_user, "Defect Raised", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/mark-waiting-for-fix", response_model=schemas.FunctionalOut)
def mark_waiting_for_fix(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.DEFECT_RAISED, "Mark waiting for fix")
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
    obj.status = QAStatus.RETESTING
    _log(db, obj.id, "Waiting For Fix", current_user, "Retesting Started", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-regression", response_model=schemas.FunctionalOut)
def start_regression(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    """Optional broader-impact regression pass after retesting, before QA completion."""
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.RETESTING, "Start regression testing")
    obj.status = QAStatus.REGRESSION_TESTING
    _log(db, obj.id, "Retesting", current_user, "Regression Testing Started", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/complete-qa", response_model=schemas.FunctionalOut)
def complete_qa(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    """Marks QA activity complete -- reachable directly from execution (no issues found)
    or after the defect/retest/regression cycle.

    Not gated on any SAST/DAST/Performance sibling raised alongside it on the
    same gateway QA Request -- every request type runs its own fully
    independent workflow end-to-end (see models.QARequest's own docstring:
    "QA request form is the gateway only"), so Functional completing has
    never depended on -- and now explicitly does not wait for -- a sibling
    request's own status."""
    obj = _get_or_404(db, req_id)
    _require(obj, [QAStatus.EXECUTION_IN_PROGRESS, QAStatus.RETESTING, QAStatus.REGRESSION_TESTING], "Complete QA")

    obj.status = QAStatus.QA_COMPLETED
    _log(db, obj.id, "Execution", current_user, "QA Completed", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- QA Sign-off -> Requester Verification -> Closed ----
@router.post("/{req_id}/request-signoff", response_model=schemas.FunctionalOut)
def request_signoff(req_id: int, payload: schemas.RequestSignoffIn = schemas.RequestSignoffIn(),
                     db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, QAStatus.QA_COMPLETED, "Request sign-off")
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
    final verification."""
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
                           current_user: models.User = Depends(require_roles(
                               Role.QA_LEAD, Role.QA_ENGINEER, Role.BUSINESS_ANALYST))):
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
        item.approved_at = datetime.datetime.utcnow()
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
    obj.qa_acknowledged_at = datetime.datetime.utcnow()
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
            ("QA Lead", db.query(models.User).get(obj.qa_lead_id).full_name if obj.qa_lead_id else None),
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
        generated_at=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.request_id}.pdf"'},
    )


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_functional_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "FUNCTIONAL", req_id)


@router.post("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_functional_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                 current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    return doc_store.save_documents(db, "FUNCTIONAL", req_id, obj.request_id, files, current_user.id)


@router.get("/{req_id}/documents/{doc_id}/download")
def download_functional_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "FUNCTIONAL", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")
