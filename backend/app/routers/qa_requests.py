import os
import shutil
import uuid
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import (
    Role, DEFAULT_CHECKLIST_ITEMS, CONDITIONAL_CHECKLIST_ITEMS, checklist_item_is_mandatory,
    QAStatus, QA_REQUEST_EDITABLE_STATUSES, QA_REQUEST_TERMINAL_STATUSES, QA_REQUEST_CANCELLABLE_STATUSES,
    SAST_DAST_TERMINAL_STATUSES,
)

router = APIRouter(prefix="/api/qa-requests", tags=["qa-requests"])

# All uploaded documents live under backend/app/uploads/<request_id>/<filename>,
# e.g. app/uploads/TQA-REQ-20260721-A1B2C3/BRD_v2.pdf
UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)


def _log(db: Session, entity_id: int, step: str, user: models.User, decision: str, comments: Optional[str]):
    db.add(models.ApprovalAction(
        entity_type="QA_REQUEST", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


@router.get("", response_model=List[schemas.QARequestOut])
def list_requests(status_filter: Optional[str] = None, department: Optional[str] = None,
                   application_name: Optional[str] = None, search: Optional[str] = None,
                   db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    q = db.query(models.QARequest)
    if status_filter:
        q = q.filter(models.QARequest.status == status_filter)
    if department:
        q = q.filter(models.QARequest.department == department)
    if application_name:
        q = q.filter(models.QARequest.application_name.ilike(f"%{application_name}%"))
    if search:
        # Broad "projects, requests or IDs" search (topbar search box and the
        # QA Requests list's own search field) -- matches Request ID,
        # Application Name, or Project Name, not just application name.
        like = f"%{search}%"
        q = q.filter(or_(
            models.QARequest.request_id.ilike(like),
            models.QARequest.application_name.ilike(like),
            models.QARequest.project_name.ilike(like),
        ))
    return q.order_by(models.QARequest.created_at.desc()).all()


@router.get("/{req_id}", response_model=schemas.QARequestOut)
def get_request(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    return obj


def _require(obj, expected_statuses, action: str):
    if isinstance(expected_statuses, str):
        expected_statuses = [expected_statuses]
    if obj.status not in expected_statuses:
        raise HTTPException(
            400, f"'{action}' requires status in {expected_statuses} (currently '{obj.status}')"
        )


def _sync_linked_security_requests(db: Session, qa_request: "models.QARequest", request_types: list):
    """Auto-creates a linked SAST and/or DAST Request when the QA Request's
    request_types include SAST/DAST, so security testing still gets its own
    trackable unique ID (via the normal SAST-.../DAST-... generator) while
    staying linked back to the originating QA Request (typically raised
    alongside Functional Testing). Only creates what's missing -- calling
    this again after request_types changes won't duplicate an existing link.
    Standalone SAST/DAST requests raised directly via their own modules are
    untouched by this and simply keep qa_request_id = None."""
    existing_types = set()
    if any(True for _ in qa_request.linked_sast_requests):
        existing_types.add("SAST")
    if any(True for _ in qa_request.linked_dast_requests):
        existing_types.add("DAST")

    if "SAST" in request_types and "SAST" not in existing_types:
        db.add(models.SASTRequest(
            application_name=qa_request.application_name,
            project_name=qa_request.project_name,
            cr_number=qa_request.cr_number,
            risk_category=qa_request.risk_rating,
            requester_id=qa_request.requester_id,
            qa_request_id=qa_request.id,
        ))
    if "DAST" in request_types and "DAST" not in existing_types:
        db.add(models.DASTRequest(
            application_url=f"To be confirmed — linked from {qa_request.request_id}",
            environment=qa_request.environment,
            target_release=qa_request.release_version,
            risk_category=qa_request.risk_rating,
            requester_id=qa_request.requester_id,
            qa_request_id=qa_request.id,
        ))


@router.post("", response_model=schemas.QARequestOut)
def create_request(payload: schemas.QARequestCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST))):
    """Creates the request in DRAFT. Call POST /{id}/submit to send it for Executive Approval."""
    data = payload.model_dump()
    # Department is always sourced from the requester's own user profile, not
    # from client input -- ignore whatever the payload sent.
    data["department"] = current_user.department
    request_types = data.pop("request_types", [])
    checked_items = set(data.pop("checked_items", []) or [])
    obj = models.QARequest(**data, request_types=",".join(request_types), requester_id=current_user.id,
                            status=QAStatus.DRAFT)
    db.add(obj)
    db.flush()
    for item, owner in DEFAULT_CHECKLIST_ITEMS:
        # `requester_checked` is the requester's own self-declaration made at
        # raise-time -- it is reference/pre-fill only. It does NOT set
        # `is_complete`; the QA Lead must still independently verify every
        # item during Readiness Verification.
        db.add(models.ReadinessChecklistItem(
            qa_request_id=obj.id, item=item, owner=owner,
            is_mandatory=checklist_item_is_mandatory(item, request_types),
            requester_checked=item in checked_items,
        ))
    _sync_linked_security_requests(db, obj, request_types)
    _log(db, obj.id, "Requester", current_user, "Drafted", "QA Request created as draft")
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{req_id}", response_model=schemas.QARequestOut)
def edit_request(req_id: int, payload: schemas.QARequestUpdate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can edit this request")
    if obj.status not in QA_REQUEST_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump(exclude_unset=True)
    # Department tracks the requester's own profile, not something edited per-request.
    data.pop("department", None)
    request_types = data.pop("request_types", None)
    checked_items = data.pop("checked_items", None)
    for k, v in data.items():
        setattr(obj, k, v)
    if request_types is not None:
        obj.request_types = ",".join(request_types)
        # Re-evaluate which readiness-checklist items are mandatory now that
        # the request types may have changed (e.g. SAST/DAST added, or the
        # request became/stopped being security-only), and auto-create any
        # newly-needed linked SAST/DAST request. Every item is recomputed
        # (not just the conditional SAST/DAST ones) since the security-only
        # exception affects the unconditional items too.
        for item in obj.checklist_items:
            item.is_mandatory = checklist_item_is_mandatory(item.item, request_types)
        _sync_linked_security_requests(db, obj, request_types)
    if checked_items is not None:
        # Requester updating their self-declared readiness ticks -- still
        # reference-only, does not touch is_complete (QA Lead's call).
        checked_set = set(checked_items)
        for item in obj.checklist_items:
            item.requester_checked = item.item in checked_set
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/cancel", response_model=schemas.QARequestOut)
def cancel_request(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can cancel this request")
    if obj.status in QA_REQUEST_TERMINAL_STATUSES:
        raise HTTPException(400, f"Request is already '{obj.status}' and cannot be cancelled")
    # Once the Department Head has approved and a QA Lead is assigned, the
    # request is committed to QA and cancellation is no longer offered --
    # only Draft/Submitted/Department Head Approval Pending/Returned by
    # Department Head may still be cancelled.
    if obj.status not in QA_REQUEST_CANCELLABLE_STATUSES:
        raise HTTPException(
            400,
            f"Request is already past Department Head approval ('{obj.status}') and can no longer be cancelled",
        )
    obj.status = QAStatus.CANCELLED
    _log(db, obj.id, "Requester", current_user, "Cancelled", None)
    db.commit()
    db.refresh(obj)
    return obj


# ---- Requester: Draft -> Submitted -> SM Approval Pending ----
@router.post("/{req_id}/submit", response_model=schemas.QARequestOut)
def submit_request(req_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, QAStatus.DRAFT, "Submit")
    obj.status = QAStatus.SUBMITTED
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    obj.status = QAStatus.SM_APPROVAL_PENDING
    _log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/resubmit", response_model=schemas.QARequestOut)
def resubmit_request(req_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST))):
    """Re-submits a request returned by SM, by the Department Head, or by the QA Lead."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, [QAStatus.RETURNED_BY_SM, QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD],
             "Resubmit")
    if obj.status == QAStatus.RETURNED_BY_SM:
        obj.status = QAStatus.SM_APPROVAL_PENDING
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == QAStatus.RETURNED_BY_DEPARTMENT_HEAD:
        obj.status = QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    else:
        obj.status = QAStatus.READINESS_VERIFICATION
        _log(db, obj.id, "Readiness Verification", current_user, "Resubmitted", "Returned request re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


# ---- SM Approval: Approve (-> Department Head) / Return / Reject ----
@router.post("/{req_id}/sm-decision", response_model=schemas.QARequestOut)
def sm_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                current_user: models.User = Depends(require_roles(Role.SM))):
    """New checkpoint between the requester's submission and Department Head
    approval. A Return goes back to the requester for correction; a Reject
    closes the request out (SM_REJECTED, terminal)."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    require_same_department(current_user, obj.department)
    _require(obj, QAStatus.SM_APPROVAL_PENDING, "SM decision")
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
@router.post("/{req_id}/department-head-decision", response_model=schemas.QARequestOut)
def department_head_decision(req_id: int, payload: schemas.DepartmentHeadDecisionIn, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    """Department Head reviews the request raised by their own department and,
    on approval, assigns the QA Lead who will own it going forward. A Return
    goes back to the requester for correction; a Reject closes it out."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    require_same_department(current_user, obj.department)
    _require(obj, QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, "Department Head decision")
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
@router.post("/{req_id}/start-readiness-verification", response_model=schemas.QARequestOut)
def start_readiness_verification(req_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.qa_lead_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the assigned QA Lead or an admin can start readiness verification")
    _require(obj, QAStatus.QA_LEAD_ASSIGNED, "Start readiness verification")
    obj.status = QAStatus.READINESS_VERIFICATION
    _log(db, obj.id, "QA Lead Assignment", current_user, "Started", "Readiness verification started")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/readiness-decision", response_model=schemas.QARequestOut)
def readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.READINESS_VERIFICATION, "Readiness decision")
    if payload.decision == "Passed":
        pending = [c.item for c in obj.checklist_items if c.is_mandatory and not c.is_complete]
        if pending:
            raise HTTPException(400, f"Readiness checklist incomplete: {', '.join(pending)}")
        obj.status = QAStatus.QA_ACTIVITY_INITIATED
    elif payload.decision == "Failed":
        obj.status = QAStatus.RETURNED_BY_QA_LEAD
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Readiness Verification", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- QA Activity: Planning -> Tester Assignment -> Test Design -> Execution ----
@router.post("/{req_id}/begin-planning", response_model=schemas.QARequestOut)
def begin_planning(req_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.QA_ACTIVITY_INITIATED, "Begin planning")
    obj.status = QAStatus.PLANNING
    _log(db, obj.id, "QA Activity Initiated", current_user, "Planning Started", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/assign-tester", response_model=schemas.QARequestOut)
def assign_tester(req_id: int, payload: schemas.AssignTesterIn, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.PLANNING, "Assign tester")
    if not payload.tester_ids:
        raise HTTPException(400, "At least one tester_id is required")
    obj.assigned_tester_ids = ",".join(str(i) for i in payload.tester_ids)
    obj.status = QAStatus.TESTER_ASSIGNED
    _log(db, obj.id, "Planning", current_user, "Tester Assigned", f"Assigned tester user ids: {payload.tester_ids}")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-test-design", response_model=schemas.QARequestOut)
def start_test_design(req_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.TESTER_ASSIGNED, "Start test design")
    obj.status = QAStatus.TEST_DESIGN
    _log(db, obj.id, "Tester Assigned", current_user, "Test Design Started", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-execution", response_model=schemas.QARequestOut)
def start_execution(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.TEST_DESIGN, "Start execution")
    obj.status = QAStatus.EXECUTION_IN_PROGRESS
    _log(db, obj.id, "Test Design", current_user, "Execution Started", None)
    db.commit()
    db.refresh(obj)
    return obj


# ---- Defect -> Fix -> Retest -> Regression cycle ----
@router.post("/{req_id}/raise-defect", response_model=schemas.QARequestOut)
def raise_defect(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.EXECUTION_IN_PROGRESS, "Raise defect")
    obj.status = QAStatus.DEFECT_RAISED
    _log(db, obj.id, "Execution In Progress", current_user, "Defect Raised", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/mark-waiting-for-fix", response_model=schemas.QARequestOut)
def mark_waiting_for_fix(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.DEFECT_RAISED, "Mark waiting for fix")
    obj.status = QAStatus.WAITING_FOR_FIX
    _log(db, obj.id, "Defect Raised", current_user, "Waiting For Fix", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-retesting", response_model=schemas.QARequestOut)
def start_retesting(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.WAITING_FOR_FIX, "Start retesting")
    obj.status = QAStatus.RETESTING
    _log(db, obj.id, "Waiting For Fix", current_user, "Retesting Started", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-regression", response_model=schemas.QARequestOut)
def start_regression(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    """Optional broader-impact regression pass after retesting, before QA completion."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.RETESTING, "Start regression testing")
    obj.status = QAStatus.REGRESSION_TESTING
    _log(db, obj.id, "Retesting", current_user, "Regression Testing Started", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/complete-qa", response_model=schemas.QARequestOut)
def complete_qa(req_id: int, payload: schemas.CommentIn, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    """Marks QA activity complete -- reachable directly from execution (no issues found)
    or after the defect/retest/regression cycle.

    Blocked while any linked SAST/DAST request (see _sync_linked_security_requests)
    hasn't itself reached a terminal state (Report Ready or Closed) -- a QA
    Request can't be signed off as complete while its own security testing is
    still open."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, [QAStatus.EXECUTION_IN_PROGRESS, QAStatus.RETESTING, QAStatus.REGRESSION_TESTING], "Complete QA")

    open_security = [
        s.request_id for s in list(obj.linked_sast_requests) + list(obj.linked_dast_requests)
        if s.status not in SAST_DAST_TERMINAL_STATUSES
    ]
    if open_security:
        raise HTTPException(
            400,
            "QA cannot be marked complete while linked SAST/DAST request(s) are still open: "
            + ", ".join(open_security) + ". They must reach Report Ready or Closed first.",
        )

    obj.status = QAStatus.QA_COMPLETED
    _log(db, obj.id, "Execution", current_user, "QA Completed", payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- QA Sign-off -> Requester Verification -> Closed ----
@router.post("/{req_id}/request-signoff", response_model=schemas.QARequestOut)
def request_signoff(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    _require(obj, QAStatus.QA_COMPLETED, "Request sign-off")
    obj.status = QAStatus.QA_SIGNOFF_PENDING
    _log(db, obj.id, "QA Completed", current_user, "Sign-off Requested", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/confirm-signoff", response_model=schemas.QARequestOut)
def confirm_signoff(req_id: int, payload: schemas.ConfirmSignoffIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Confirms the QA Sign-off certificate (optionally linking a Module 8 QASignOff
    record created via /api/signoffs) and hands the request to the requester for
    final verification."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
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


@router.post("/{req_id}/requester-decision", response_model=schemas.QARequestOut)
def requester_decision(req_id: int, payload: schemas.RequesterDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(
                            Role.REQUESTER, Role.BUSINESS_ANALYST, Role.APPLICATION_OWNER))):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
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
    return db.query(models.ReadinessChecklistItem).filter_by(qa_request_id=req_id).all()


@router.put("/{req_id}/checklist/{item_id}", response_model=schemas.ChecklistItemOut)
def update_checklist_item(req_id: int, item_id: int, payload: schemas.ChecklistItemUpdate,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(
                               Role.QA_LEAD, Role.QA_ENGINEER, Role.BUSINESS_ANALYST))):
    item = db.query(models.ReadinessChecklistItem).filter_by(id=item_id, qa_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    parent = db.query(models.QARequest).get(req_id)
    if not parent or parent.status != QAStatus.READINESS_VERIFICATION:
        raise HTTPException(
            400,
            "Readiness checklist items can only be verified while the request is in "
            "Readiness Verification (i.e. by the QA Lead after Executive Approval) -- "
            "not while still in Draft or any other stage.",
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
    return db.query(models.WalkthroughSession).filter_by(qa_request_id=req_id).all()


@router.post("/{req_id}/walkthroughs", response_model=schemas.WalkthroughOut)
def add_walkthrough(req_id: int, payload: schemas.WalkthroughCreate, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(
                         Role.BUSINESS_ANALYST, Role.REQUESTER, Role.QA_ENGINEER, Role.QA_LEAD))):
    if not db.query(models.QARequest).get(req_id):
        raise HTTPException(404, "QA Request not found")
    obj = models.WalkthroughSession(qa_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/walkthroughs/{wt_id}/acknowledge", response_model=schemas.WalkthroughOut)
def acknowledge_walkthrough(req_id: int, wt_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD))):
    obj = db.query(models.WalkthroughSession).filter_by(id=wt_id, qa_request_id=req_id).first()
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
            .filter_by(entity_type="QA_REQUEST", entity_id=req_id)
            .order_by(models.ApprovalAction.created_at).all())


# ---- Supporting documents (Module 1, field 4.1.2 -- multiple files per request) ----
@router.get("/{req_id}/documents", response_model=List[schemas.QARequestDocumentOut])
def list_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.QARequestDocument)
            .filter_by(qa_request_id=req_id)
            .order_by(models.QARequestDocument.uploaded_at).all())


@router.post("/{req_id}/documents", response_model=List[schemas.QARequestDocumentOut])
def upload_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(
                          Role.REQUESTER, Role.BUSINESS_ANALYST, Role.QA_ENGINEER, Role.QA_LEAD))):
    """Accepts one or more files (multipart/form-data, field name 'files') and
    stores them under UPLOAD_ROOT/<request_id>/, named to avoid collisions."""
    req = db.query(models.QARequest).get(req_id)
    if not req:
        raise HTTPException(404, "QA Request not found")

    request_dir = os.path.join(UPLOAD_ROOT, req.request_id)
    os.makedirs(request_dir, exist_ok=True)

    created = []
    for f in files:
        original_name = os.path.basename(f.filename or "unnamed_file")
        dest_path = os.path.join(request_dir, original_name)
        if os.path.exists(dest_path):
            stem, ext = os.path.splitext(original_name)
            original_name = f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
            dest_path = os.path.join(request_dir, original_name)

        with open(dest_path, "wb") as out:
            shutil.copyfileobj(f.file, out)

        doc = models.QARequestDocument(
            qa_request_id=req.id,
            file_name=f.filename or original_name,
            stored_path=os.path.join(req.request_id, original_name),
            content_type=f.content_type,
            file_size=os.path.getsize(dest_path),
            uploaded_by_id=current_user.id,
        )
        db.add(doc)
        created.append(doc)

    db.commit()
    for d in created:
        db.refresh(d)
    return created


@router.get("/{req_id}/documents/{doc_id}/download")
def download_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    doc = db.query(models.QARequestDocument).filter_by(id=doc_id, qa_request_id=req_id).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    full_path = os.path.join(UPLOAD_ROOT, doc.stored_path)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name,
                         media_type=doc.content_type or "application/octet-stream")
