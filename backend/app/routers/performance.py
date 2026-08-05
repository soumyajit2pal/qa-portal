import datetime
import os
from typing import List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department, require_not_requester
from ..constants import Role, QA_DEPARTMENT, PERFORMANCE_EDITABLE_STATUSES, is_readiness_evidence_editable, application_name_block_message
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

router = APIRouter(prefix="/api/performance-requests", tags=["performance"])

# These identify *which* request this actually is -- changing them once the
# request exists is an Admin-only action (see update_performance below; same
# restriction/reasoning as update_sast in routers/sast_dast.py). A submitted
# value equal to the current one is let through for anyone -- that's not
# actually a change, just the form resubmitting a field it also displays.
_ADMIN_ONLY_FIELDS = {"application_name", "epic_number", "cr_number"}

# ---------------------------------------------------------------------------
# Performance Testing lifecycle -- auto-created from a QA Request when
# "Performance Testing" is one of its request types (see
# routers/qa_requests.py::_sync_linked_child_requests), same pattern as
# SAST/DAST.
#
#   Draft -> Submit -> SM Approval -> Department Head Approval -> Readiness
#   -> Feasibility -> Planning -> Environment Setup -> Script Development ->
#   Baseline -> Load Test Execution -> Result Analysis -> [issues ->
#   Defect/Fix/Retest -> back to Load Test Execution, or clean ->] Report ->
#   Sign-off -> Requester Verification -> Closed.
# ---------------------------------------------------------------------------


def _log(db, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type="PERFORMANCE", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected, action: str):
    if isinstance(expected, str):
        expected = [expected]
    if obj.status not in expected:
        raise HTTPException(400, f"'{action}' requires status in {expected} (currently '{obj.status}')")


def _get_or_404(db: Session, req_id: int):
    obj = db.query(models.PerformanceRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "Performance request not found")
    return obj


def _it_qa_user(db: Session, user_id: int | None, role: str, label: str) -> models.User:
    user = db.query(models.User).get(user_id) if user_id else None
    if not user or not user.is_active or not user.has_role(role) or user.department != QA_DEPARTMENT:
        raise HTTPException(400, f"{label} must be an active {role.replace('_', ' ').title()} from {QA_DEPARTMENT}")
    return user


def _require_assigned_qa_lead(obj: "models.PerformanceRequest", user: models.User) -> None:
    if not user.has_role(Role.ADMIN) and obj.engineer_id != user.id:
        raise HTTPException(403, "Only the QA Lead assigned by the Department Head can perform this action")


def _performance_tester_ids(obj: "models.PerformanceRequest") -> set[int]:
    return {int(value) for value in (obj.assigned_tester_ids or "").split(",") if value}


def _require_performance_execution_owner(obj: "models.PerformanceRequest", user: models.User) -> None:
    if user.has_role(Role.ADMIN):
        return
    if obj.engineer_id == user.id and user.has_role(Role.QA_LEAD):
        return
    if user.id in _performance_tester_ids(obj) and user.has_role(Role.QA_ENGINEER):
        return
    raise HTTPException(403, "Only the assigned QA Lead or an assigned IT-QA QA Tester can perform this action")


@router.get("", response_model=List[schemas.PerformanceOut])
def list_performance(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.PerformanceRequest).order_by(models.PerformanceRequest.created_at.desc()).all()


# Standalone creation is DISABLED -- Performance requests can only originate
# from a QA Request that includes "Performance Testing" in its request types.
@router.post("", response_model=schemas.PerformanceOut)
def create_performance(payload: schemas.PerformanceCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    raise HTTPException(
        400,
        "Standalone Performance Testing requests can no longer be raised directly -- include "
        "'Performance Testing' in a QA Request's request types instead.",
    )


@router.put("/{req_id}", response_model=schemas.PerformanceOut)
def update_performance(req_id: int, payload: schemas.PerformanceUpdate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    # See _can_edit_details's own docstring below for the full permission
    # model (requester while it's theirs/returned to them; SM/Department
    # Head only while it's genuinely pending their own decision).
    if obj.status not in PERFORMANCE_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    if not _can_edit_details(obj, current_user):
        raise HTTPException(403, "You do not have permission to edit this request in its current status")
    data = payload.model_dump(exclude_unset=True)
    if not current_user.has_role(Role.ADMIN):
        for f in _ADMIN_ONLY_FIELDS:
            if f in data and data[f] != getattr(obj, f):
                raise HTTPException(403, f"Only an Administrator can change {f.replace('_', ' ').title()}")
    checked_items = data.pop("checked_items", None)
    for k, v in data.items():
        setattr(obj, k, v)
    if checked_items is not None:
        # Lets the requester update their readiness-checklist self-declaration
        # from this same "Edit Details" modal while the request is still
        # editable-by-requester -- see schemas.PerformanceUpdate.checked_items.
        checked_set = set(checked_items)
        for item in obj.checklist_items:
            item.requester_checked = item.item in checked_set
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/submit", response_model=schemas.PerformanceOut)
def submit_performance(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "DRAFT", "Submit")
    obj.status = "SUBMITTED"
    # Mirrors routers/functional.py::submit_request -- logs the requester's
    # own "Submitted" step before immediately moving on to SM Approval, same
    # fix as SAST/DAST so every request type's History tab reads
    # the same way.
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    if obj.application_master_status == "REJECTED":
        # See routers/functional.py::submit_request for the full reasoning --
        # this request's Application Name was already rejected by an SM
        # (possibly via a sibling request's own screen), so it shouldn't get
        # a fresh shot at SM Approval under a name that's already known-bad.
        obj.status = "SM_REJECTED"
        _log(db, obj.id, "SM Approval", current_user, "Rejected",
             "Auto-rejected: this request's Application Name was rejected by SM")
    else:
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/resubmit", response_model=schemas.PerformanceOut)
def resubmit_performance(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Re-submits a request returned by SM, by the Department Head, or after
    a failed Readiness review -- or reopens one rejected by SM. Reported
    directly: a Rejected-by-SM request used to be a dead end; it's now
    reopenable the same way a Return is: edit details, then call this to
    send it straight back to SM_APPROVAL_PENDING for a fresh decision."""
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, ["RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_ENGINEER"], "Resubmit")
    if obj.status in ("RETURNED_BY_SM", "SM_REJECTED"):
        reopening = obj.status == "SM_REJECTED"
        if obj.application_master_status == "REJECTED":
            obj.status = "SM_REJECTED"
            _log(db, obj.id, "SM Approval", current_user, "Rejected",
                 "Auto-rejected: this request's Application Name was rejected by SM")
        else:
            obj.status = "SM_APPROVAL_PENDING"
            _log(db, obj.id, "SM Approval", current_user,
                 "Reopened" if reopening else "Resubmitted",
                 "Rejected request reopened and re-submitted" if reopening else None)
    elif obj.status == "RETURNED_BY_DEPARTMENT_HEAD":
        # A genuine direct return from Department Head Approval itself.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", None)
    elif obj.status == "RETURNED_BY_ENGINEER" and obj.needs_dept_head_reapproval:
        # Readiness failure flagged that the fix needs a fresh Department
        # Head approval before Readiness resumes.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted",
             "Returned request re-submitted (Department Head re-approval required)")
    else:
        obj.status = "READINESS"
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Readiness", current_user, "Resubmitted", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/sm-decision", response_model=schemas.PerformanceOut)
def sm_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.SM))):
    obj = _get_or_404(db, req_id)
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(400, application_name_block_message(obj.application_master_status, "sm"))
    if payload.decision == "Approved":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "SM_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/department-head-decision", response_model=schemas.PerformanceOut)
def department_head_decision(req_id: int, payload: schemas.PerformanceDeptHeadDecisionIn, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM))):
    """Approval requires assignment to an active IT-QA QA Lead."""
    obj = _get_or_404(db, req_id)
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(400, application_name_block_message(obj.application_master_status, "department_head"))
    if payload.decision == "Approved":
        qa_lead_id = payload.qa_lead_id or payload.engineer_id
        qa_lead = _it_qa_user(db, qa_lead_id, Role.QA_LEAD, "qa_lead_id")
        obj.engineer_id = qa_lead.id
        obj.status = "ENGINEER_ASSIGNED"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
    elif payload.decision == "Rejected":
        obj.status = "DEPARTMENT_HEAD_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-readiness", response_model=schemas.PerformanceOut)
def start_readiness(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, "ENGINEER_ASSIGNED", "Start readiness")
    _require_assigned_qa_lead(obj, current_user)
    obj.status = "READINESS"
    _log(db, obj.id, "Readiness", current_user, "Started", "Readiness started by assigned QA Lead")
    db.commit()
    db.refresh(obj)
    return obj


def _advance(db, obj, expected, next_status, step_label, current_user):
    _require(obj, expected, f"Advance from {expected}")
    obj.status = next_status
    _log(db, obj.id, step_label, current_user, "Complete", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/readiness-decision", response_model=schemas.PerformanceOut)
def readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Passed requires every item the requester self-declared ready on
    "L1: Pre-Testing Readiness Checklist" (Annexure VIII) to be QA-verified
    (is_complete), not just the mandatory ones -- see the long comment
    inline below -- before advancing to Feasibility. Failed is new: a
    discrepancy found during Readiness (beyond just an incomplete checklist
    -- e.g. something the assigned engineer notices is wrong with the
    request itself) returns it to the requester, with the QA Lead choosing
    (via require_dept_head_reapproval) whether the fix needs a fresh
    Department Head approval or can come straight back to Readiness once
    addressed (the default -- same assigned engineer, no re-approval
    needed)."""
    obj = _get_or_404(db, req_id)
    _require(obj, "READINESS", "Readiness decision")
    _require_assigned_qa_lead(obj, current_user)
    if payload.decision == "Passed":
        # Every item the requester actually self-declared ready
        # (requester_checked) must be QA-verified (is_complete) before
        # Passed. Scoped to requester_checked rather than every item on the
        # list -- an item the requester never declared ready can't be
        # verified anyway (see update_checklist_item's own gate below), so
        # requiring it here too would permanently block Passed with no way
        # forward. This checklist is Admin-configurable now (see
        # checklist_config.py) and CAN ship mandatory items -- but a
        # mandatory item is already forced to be self-declared
        # (requester_checked) before the request can even be raised (see
        # routers/qa_requests.py::submit_request's pending_checklist_items
        # gate), so by the time a Performance request reaches Readiness at
        # all, every mandatory item is already inside the requester_checked
        # set below -- no separate mandatory-only check is needed here on
        # top of it.
        pending = [c.item for c in obj.checklist_items if c.requester_checked and not c.is_complete]
        if pending:
            raise HTTPException(400, f"Pre-testing readiness checklist incomplete: {', '.join(pending)}")
        obj.status = "FEASIBILITY"
    elif payload.decision == "Failed":
        # Status is always RETURNED_BY_ENGINEER, never RETURNED_BY_DEPARTMENT_HEAD
        # (misleading -- the Department Head hasn't seen this yet); the
        # re-approval choice is tracked separately (see
        # models.PerformanceRequest.needs_dept_head_reapproval).
        obj.status = "RETURNED_BY_ENGINEER"
        obj.needs_dept_head_reapproval = payload.require_dept_head_reapproval
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Readiness", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- L1: Pre-Testing Readiness Checklist (Annexure VIII) ----
# requester_checked is the requester's own self-declaration, made once on the
# QA Request wizard's Performance step at raise time -- reference only. QA
# still independently verifies every item via is_complete below, same
# self-declare/QA-verify split as Functional's checklist
# (previously this endpoint let REQUESTER tick is_complete directly with no
# stage gate at all -- unified here to match).
@router.get("/{req_id}/checklist", response_model=List[schemas.PerformanceChecklistItemOut])
def get_checklist(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.PerformanceChecklistItem).filter_by(performance_request_id=req_id).all()


@router.put("/{req_id}/checklist/{item_id}", response_model=schemas.PerformanceChecklistItemOut)
def update_checklist_item(req_id: int, item_id: int, payload: schemas.PerformanceChecklistItemUpdate,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    item = db.query(models.PerformanceChecklistItem).filter_by(id=item_id, performance_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    parent = _get_or_404(db, req_id)
    if parent.status != "READINESS":
        raise HTTPException(
            400,
            "Pre-testing readiness checklist items can only be verified while the request is in "
            "Readiness (i.e. by QA after Department Head approval) -- not while still in Draft or "
            "any other stage.",
        )
    _require_assigned_qa_lead(parent, current_user)
    # QA verifies the requester's own self-declaration -- they can't tick an
    # item the requester never declared ready in the first place (see the
    # frontend's matching disabled-checkbox behavior in Performance.tsx).
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
        item.approved_at = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    else:
        item.approved_by_id = None
        item.approved_at = None
    db.commit()
    db.refresh(item)
    return item


@router.post("/{req_id}/complete-feasibility", response_model=schemas.PerformanceOut)
def complete_feasibility(req_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require_assigned_qa_lead(obj, current_user)
    return _advance(db, obj, "FEASIBILITY", "PLANNING", "Feasibility", current_user)


@router.post("/{req_id}/complete-planning", response_model=schemas.PerformanceOut)
def complete_planning(req_id: int, payload: schemas.AssignTesterIn, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, "PLANNING", "Assign QA Tester")
    _require_assigned_qa_lead(obj, current_user)
    if not payload.tester_ids:
        raise HTTPException(400, "At least one tester_id is required")
    tester_ids = list(dict.fromkeys(payload.tester_ids))
    testers = [_it_qa_user(db, tester_id, Role.QA_ENGINEER, f"tester_id {tester_id}") for tester_id in tester_ids]
    obj.assigned_tester_ids = ",".join(str(value) for value in tester_ids)
    obj.status = "ENVIRONMENT_SETUP"
    _log(db, obj.id, "Planning", current_user, "QA Tester Assigned",
         f"Assigned tester(s): {', '.join(tester.full_name for tester in testers)}")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/complete-environment-setup", response_model=schemas.PerformanceOut)
def complete_environment_setup(req_id: int, db: Session = Depends(get_db),
                                current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require_performance_execution_owner(obj, current_user)
    return _advance(db, obj, "ENVIRONMENT_SETUP", "SCRIPT_DEVELOPMENT", "Environment Setup", current_user)


@router.post("/{req_id}/complete-script-development", response_model=schemas.PerformanceOut)
def complete_script_development(req_id: int, db: Session = Depends(get_db),
                                 current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require_performance_execution_owner(obj, current_user)
    return _advance(db, obj, "SCRIPT_DEVELOPMENT", "BASELINE", "Script Development", current_user)


@router.post("/{req_id}/complete-baseline", response_model=schemas.PerformanceOut)
def complete_baseline(req_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require_performance_execution_owner(obj, current_user)
    return _advance(db, obj, "BASELINE", "LOAD_TEST_EXECUTION", "Baseline", current_user)


@router.post("/{req_id}/complete-load-test", response_model=schemas.PerformanceOut)
def complete_load_test(req_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require_performance_execution_owner(obj, current_user)
    return _advance(db, obj, "LOAD_TEST_EXECUTION", "RESULT_ANALYSIS", "Load Test Execution", current_user)


@router.post("/{req_id}/result-analysis-decision", response_model=schemas.PerformanceOut)
def result_analysis_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, "RESULT_ANALYSIS", "Result analysis decision")
    _require_assigned_qa_lead(obj, current_user)
    if payload.decision == "Passed":
        obj.status = "REPORT"
    elif payload.decision == "Failed":
        obj.status = "DEFECT_FIX_RETEST"
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Result Analysis", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/complete-defect-fix-retest", response_model=schemas.PerformanceOut)
def complete_defect_fix_retest(req_id: int, db: Session = Depends(get_db),
                                current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    """Loops back to Load Test Execution for a re-run once the fix is in."""
    obj = _get_or_404(db, req_id)
    _require_performance_execution_owner(obj, current_user)
    return _advance(db, obj, "DEFECT_FIX_RETEST", "LOAD_TEST_EXECUTION", "Defect / Fix / Retest", current_user)


@router.post("/{req_id}/complete-report", response_model=schemas.PerformanceOut)
def complete_report(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require_assigned_qa_lead(obj, current_user)
    return _advance(db, obj, "REPORT", "SIGNOFF_PENDING", "Report", current_user)


@router.post("/{req_id}/sign-off", response_model=schemas.PerformanceOut)
def sign_off(req_id: int, db: Session = Depends(get_db),
             current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, "SIGNOFF_PENDING", "Sign off")
    _require_assigned_qa_lead(obj, current_user)
    _log(db, obj.id, "Sign-off", current_user, "Signed Off", None)
    obj.status = "REQUESTER_VERIFICATION"
    _log(db, obj.id, "Requester Verification", current_user, "Pending", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/requester-decision", response_model=schemas.PerformanceOut)
def requester_decision(req_id: int, payload: schemas.RequesterDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can confirm this")
    _require(obj, "REQUESTER_VERIFICATION", "Requester decision")
    if payload.decision == "Accepted":
        obj.status = "CLOSED"
    elif payload.decision == "ChangesRequired":
        obj.status = "LOAD_TEST_EXECUTION"
    else:
        raise HTTPException(400, "decision must be one of: Accepted, ChangesRequired")
    _log(db, obj.id, "Requester Verification", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- Walkthrough sessions ----
# Own dedicated table (PerformanceWalkthrough), mirroring Functional's
# WalkthroughSession -- see routers/functional.py for the same pattern.
@router.get("/{req_id}/walkthroughs", response_model=List[schemas.WalkthroughOut])
def list_walkthroughs(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.PerformanceWalkthrough).filter_by(performance_request_id=req_id).all()


@router.post("/{req_id}/walkthroughs", response_model=schemas.WalkthroughOut)
def add_walkthrough(req_id: int, payload: schemas.WalkthroughCreate, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(
                         Role.BUSINESS_ANALYST, Role.REQUESTER, Role.QA_ENGINEER, Role.QA_LEAD))):
    if not db.query(models.PerformanceRequest).get(req_id):
        raise HTTPException(404, "Performance request not found")
    obj = models.PerformanceWalkthrough(performance_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/walkthroughs/{wt_id}/acknowledge", response_model=schemas.WalkthroughOut)
def acknowledge_walkthrough(req_id: int, wt_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD))):
    obj = db.query(models.PerformanceWalkthrough).filter_by(id=wt_id, performance_request_id=req_id).first()
    if not obj:
        raise HTTPException(404, "Walkthrough session not found")
    import datetime
    obj.qa_acknowledged_by_id = current_user.id
    obj.qa_acknowledged_at = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def request_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="PERFORMANCE", entity_id=req_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{req_id}/export")
def export_performance(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this Performance Testing request (including the ones
    delegated from its parent QA Request gateway), its readiness checklist,
    and its full approval/workflow history -- who submitted, approved,
    returned, etc., and when -- as one downloadable PDF."""
    obj = _get_or_404(db, req_id)

    def uname(uid):
        if not uid:
            return None
        u = db.query(models.User).get(uid)
        return u.full_name if u else None

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Priority", obj.priority),
            ("Risk Category", obj.risk_category),
        ]),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Epic Number", obj.epic_number),
            ("CR Number", obj.cr_number),
            ("Department", obj.department),
            ("Change Type", obj.change_type),
            ("Request Type", obj.request_type),
        ]),
        ("Test Parameters & Environment", [
            ("Tool Used", obj.tool_used),
            ("Target Load", obj.target_load),
            ("Environment", obj.environment),
            ("Target Promotion Environment", obj.target_promotion_environment),
        ]),
        ("Release & Vendor", [
            ("Release Version", obj.release_version),
            ("Build Number", obj.build_number),
            ("Hash Value", obj.hash_value),
            ("Vendor / SI Partner", obj.vendor_si_partner),
            ("Technology Stack", obj.technology_stack),
        ]),
        ("People", [
            ("Requester", uname(obj.requester_id)),
            ("Assigned QA Lead", uname(obj.engineer_id)),
            ("Assigned QA Testers", ", ".join(
                filter(None, (uname(int(uid)) for uid in (obj.assigned_tester_ids or "").split(",") if uid))
            )),
        ]),
        ("Readiness Checklist", [
            (c.item, f"Requester declared: {'Yes' if c.requester_checked else 'No'} | QA verified: {'Yes' if c.is_complete else 'No'}")
            for c in obj.checklist_items
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="PERFORMANCE", entity_id=req_id)
                     .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in history_rows:
        history.append((h.step_name or "—", h.decision or "—", uname(h.actor_id) or "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="Performance Testing Request — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.request_id}.pdf"'},
    )


# Post-Engineer-assignment statuses (own lifecycle -- see constants.PERFORMANCE_STATUSES).
_ENGINEER_OWNED_STATUSES = (
    "ENGINEER_ASSIGNED", "READINESS", "FEASIBILITY", "PLANNING", "ENVIRONMENT_SETUP",
    "SCRIPT_DEVELOPMENT", "BASELINE", "LOAD_TEST_EXECUTION", "RESULT_ANALYSIS",
    "DEFECT_FIX_RETEST", "REPORT", "SIGNOFF_PENDING",
)


def _can_upload_documents(obj: "models.PerformanceRequest", user: models.User) -> bool:
    """Reported bug: upload had no restriction at all -- any logged-in user
    could attach documents to any Performance Testing request. Scoped to the
    original requester (always) plus whoever the request's *current* status
    is actually sitting with: SM during SM_APPROVAL_PENDING, Department Head
    during DEPARTMENT_HEAD_APPROVAL_PENDING (both same-department-scoped), or
    a qualified central QA user for every post-readiness status.
    Admin always bypasses, same convention as every other permission check."""
    if user.has_role(Role.ADMIN):
        return True
    if obj.requester_id == user.id:
        return True
    status = obj.status
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.SM) and user.department == obj.department
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.department == obj.department
    if status in _ENGINEER_OWNED_STATUSES:
        if obj.engineer_id == user.id:
            return True
        return status not in ("ENGINEER_ASSIGNED", "READINESS", "FEASIBILITY", "PLANNING", "RESULT_ANALYSIS", "REPORT", "SIGNOFF_PENDING") \
            and user.id in _performance_tester_ids(obj)
    return False


def _can_edit_details(obj: "models.PerformanceRequest", user: models.User) -> bool:
    """Reported bug: an SM could still edit a request's own details after
    already returning it themselves (status RETURNED_BY_SM) -- a dead end,
    since only the requester/admin can ever call resubmit, so the SM ended
    up with edit access they could never actually push forward. Clarified:
    edit access for a reviewer (SM/Department Head) should exist only while
    the request is genuinely pending *their own* decision
    (SM_APPROVAL_PENDING / DEPARTMENT_HEAD_APPROVAL_PENDING) -- fix
    something, then Approve/Return/Reject -- and disappears the moment
    they've decided either way. Once returned to the requester
    (RETURNED_BY_SM/RETURNED_BY_DEPARTMENT_HEAD/RETURNED_BY_ENGINEER), only
    the requester (or admin) may edit; reviewers are never involved again
    for a request already past their own checkpoint -- edit access for SM/
    Department Head stops at Department Head's own decision, never
    extending into the post-approval Readiness stage. Same department-
    scoping as those stages' own decision endpoints above.

    SM_REJECTED is included alongside the RETURNED_BY_* statuses too --
    reported directly, a rejected request is now reopenable (edit + call
    resubmit_performance), not a dead end, so the requester needs the same
    edit access here as they'd have after a Return."""
    if user.has_role(Role.ADMIN):
        return True
    status = obj.status
    if status in ("DRAFT", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_ENGINEER"):
        return obj.requester_id == user.id
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.SM) and user.department == obj.department
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.department == obj.department
    return False


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_performance_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "PERFORMANCE", req_id)


@router.post("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_performance_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester, central QA team, or the SM/Department Head currently reviewing the request can upload documents")
    return doc_store.save_documents(db, "PERFORMANCE", req_id, obj.request_id, files, current_user.id)


@router.get("/{req_id}/documents/{doc_id}/download")
def download_performance_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                                   current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "PERFORMANCE", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/{req_id}/documents/{doc_id}")
def delete_performance_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                                 current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "PERFORMANCE", req_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it")
    doc_store.delete_document(db, doc)
    return {"ok": True}


def _performance_checklist_item_or_404(db: Session, req_id: int, item_id: int):
    item = db.query(models.PerformanceChecklistItem).filter_by(
        id=item_id, performance_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    return item


@router.get("/{req_id}/checklist/documents", response_model=List[schemas.ChecklistItemDocumentOut])
def list_performance_checklist_documents_batch(req_id: int, db: Session = Depends(get_db),
                                                current_user: models.User = Depends(get_current_user)):
    """Batched counterpart to list_performance_checklist_documents below --
    see ChecklistItemDocumentOut for why this exists."""
    _get_or_404(db, req_id)
    item_ids = [row.id for row in db.query(models.PerformanceChecklistItem.id)
                .filter_by(performance_request_id=req_id).all()]
    docs = doc_store.list_documents_for_items(db, "PERFORMANCE_ITEM", item_ids)
    return [schemas.ChecklistItemDocumentOut(
        id=d.id, file_name=d.file_name, content_type=d.content_type,
        file_size=d.file_size, uploaded_by_id=d.uploaded_by_id, uploaded_at=d.uploaded_at,
        item_id=d.request_id) for d in docs]


@router.get("/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_performance_checklist_documents(req_id: int, item_id: int, db: Session = Depends(get_db),
                                          current_user: models.User = Depends(get_current_user)):
    _performance_checklist_item_or_404(db, req_id, item_id)
    return doc_store.list_documents(db, "PERFORMANCE_ITEM", item_id)


@router.post("/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_performance_checklist_documents(req_id: int, item_id: int, files: List[UploadFile] = File(...),
                                            db: Session = Depends(get_db),
                                            current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    _performance_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester or this request's current stage owner can attach checklist evidence")
    return doc_store.save_documents(db, "PERFORMANCE_ITEM", item_id,
                                    f"{obj.request_id}/checklist-{item_id}", files, current_user.id)


@router.get("/{req_id}/checklist/{item_id}/documents/{doc_id}/download")
def download_performance_checklist_document(req_id: int, item_id: int, doc_id: int,
                                             db: Session = Depends(get_db),
                                             current_user: models.User = Depends(get_current_user)):
    _performance_checklist_item_or_404(db, req_id, item_id)
    doc = doc_store.get_document_or_404(db, "PERFORMANCE_ITEM", item_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name,
                        media_type=doc.content_type or "application/octet-stream")


@router.delete("/{req_id}/checklist/{item_id}/documents/{doc_id}")
def delete_performance_checklist_document(req_id: int, item_id: int, doc_id: int,
                                           db: Session = Depends(get_db),
                                           current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    _performance_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    doc = doc_store.get_document_or_404(db, "PERFORMANCE_ITEM", item_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user):
        raise HTTPException(403, "Only whoever uploaded this evidence, or an admin, can delete it")
    doc_store.delete_document(db, doc)
    return {"ok": True}
