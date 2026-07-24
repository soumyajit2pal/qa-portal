import datetime
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import Role

router = APIRouter(prefix="/api/suppressions", tags=["suppression"])

# ---------------------------------------------------------------------------
# Suppression request lifecycle (Application Owner step removed entirely):
#
#   Requester raises the request with all details -> Draft -> submit ->
#   SM_APPROVAL_PENDING -> sm-decision (SM assigns to Department Head) ->
#   DEPARTMENT_HEAD_APPROVAL_PENDING -> department-head-decision ->
#   SECURITY_TEAM_VERIFICATION -> security-team-decision (Accept -> Done,
#   Reject -> Rejected). A SAST/DAST request can only be marked Report Ready
#   once every Suppression request raised against it is "Done" -- enforced in
#   routers/sast_dast.py's _mark_report_ready.
# ---------------------------------------------------------------------------


def _log(db, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type="SUPPRESSION", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected, action: str):
    if isinstance(expected, str):
        expected = [expected]
    if obj.status not in expected:
        raise HTTPException(400, f"'{action}' requires status in {expected} (currently '{obj.status}')")


@router.get("", response_model=List[schemas.SuppressionOut])
def list_suppressions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SuppressionRequest).order_by(models.SuppressionRequest.created_at.desc()).all()


@router.post("", response_model=schemas.SuppressionOut)
def create_suppression(payload: schemas.SuppressionCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Requester raises the suppression request with all details -- starts life
    as a Draft (see models.SuppressionRequest.status default) until explicitly
    submitted below. A single scan often has multiple findings, so this
    covers a list of them (payload.items) under one suppression request
    rather than requiring a separate request per finding."""
    data = payload.model_dump()
    items_data = data.pop("items")
    if not items_data:
        raise HTTPException(400, "At least one finding/issue is required")
    obj = models.SuppressionRequest(**data, created_by_id=current_user.id, status="Draft")
    obj.items = [models.SuppressionItem(**item) for item in items_data]
    db.add(obj)
    db.flush()
    _log(db, obj.id, "Requester", current_user, "Drafted")
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{sup_id}", response_model=schemas.SuppressionOut)
def get_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    return obj


@router.put("/{sup_id}", response_model=schemas.SuppressionOut)
def update_suppression(sup_id: int, payload: schemas.SuppressionCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can edit this request")
    if obj.status != "Draft":
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump()
    items_data = data.pop("items", None)
    for k, v in data.items():
        setattr(obj, k, v)
    if items_data is not None:
        for item in list(obj.items):
            db.delete(item)
        db.flush()
        obj.items = [models.SuppressionItem(**item) for item in items_data]
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/submit", response_model=schemas.SuppressionOut)
def submit_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "Draft", "Submit")
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "SM Approval", current_user, "Submitted", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/resubmit", response_model=schemas.SuppressionOut)
def resubmit_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned request re-submitted")
    else:
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/sm-decision", response_model=schemas.SuppressionOut)
def sm_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                current_user: models.User = Depends(require_roles(Role.SM))):
    """SM assigns the request on to the Department Head (Approve), sends it
    back to the requester (Return), or rejects it outright."""
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    require_same_department(current_user, obj.department)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    obj.sm_decision = payload.decision
    obj.sm_id = current_user.id
    obj.sm_decided_at = datetime.datetime.utcnow()
    if payload.decision == "Approved":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "Rejected"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/dept-head-decision", response_model=schemas.SuppressionOut)
def dept_head_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    require_same_department(current_user, obj.department)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    obj.dept_head_decision = payload.decision
    obj.dept_head_id = current_user.id
    obj.dept_head_decided_at = datetime.datetime.utcnow()
    if payload.decision == "Approved":
        obj.status = "SECURITY_TEAM_VERIFICATION"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
    elif payload.decision == "Rejected":
        obj.status = "Rejected"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/security-team-decision", response_model=schemas.SuppressionOut)
def security_team_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    """Security Team verifies the suppression is legitimate and accepts (Done
    -- unblocks the linked SAST/DAST request's mark-report-ready) or rejects
    it."""
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require(obj, "SECURITY_TEAM_VERIFICATION", "Security team decision")
    decision = payload.decision
    if decision not in ("Accepted", "Approved", "Rejected"):
        raise HTTPException(400, "decision must be one of: Accepted, Rejected")
    obj.security_decision = decision
    obj.security_id = current_user.id
    obj.security_decided_at = datetime.datetime.utcnow()
    obj.status = "Done" if decision in ("Accepted", "Approved") else "Rejected"
    _log(db, obj.id, "Security Team Verification", current_user, decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{sup_id}/history", response_model=List[schemas.ApprovalActionOut])
def suppression_history(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SUPPRESSION", entity_id=sup_id)
            .order_by(models.ApprovalAction.created_at).all())
