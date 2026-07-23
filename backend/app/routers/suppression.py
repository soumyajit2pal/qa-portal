import datetime
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/suppressions", tags=["suppression"])


def _log(db, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type="SUPPRESSION", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


@router.get("", response_model=List[schemas.SuppressionOut])
def list_suppressions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SuppressionRequest).order_by(models.SuppressionRequest.created_at.desc()).all()


@router.post("", response_model=schemas.SuppressionOut)
def create_suppression(payload: schemas.SuppressionCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(
                            Role.SECURITY_ANALYST, Role.APPLICATION_OWNER, Role.REQUESTER))):
    """Developer raises the suppression/false-positive request (workflow: Developer -> App Owner -> Dept Head).
    A single scan often has multiple findings, so this covers a list of them
    (payload.items) under one suppression request rather than requiring a
    separate request per finding."""
    data = payload.model_dump()
    items_data = data.pop("items")
    if not items_data:
        raise HTTPException(400, "At least one finding/issue is required")
    obj = models.SuppressionRequest(**data, created_by_id=current_user.id,
                                     status="Pending Application Owner")
    obj.items = [models.SuppressionItem(**item) for item in items_data]
    db.add(obj)
    db.flush()
    _log(db, obj.id, "Developer", current_user, "Submitted")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/app-owner-decision", response_model=schemas.SuppressionOut)
def app_owner_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.APPLICATION_OWNER))):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.status != "Pending Application Owner":
        raise HTTPException(400, f"Not awaiting Application Owner decision (status: {obj.status})")
    obj.app_owner_decision = payload.decision
    obj.app_owner_id = current_user.id
    obj.app_owner_decided_at = datetime.datetime.utcnow()
    obj.status = "Pending Department Head" if payload.decision == "Approved" else "Rejected"
    _log(db, obj.id, "Application Owner", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/dept-head-decision", response_model=schemas.SuppressionOut)
def dept_head_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.status != "Pending Department Head":
        raise HTTPException(400, f"Not awaiting Department Head decision (status: {obj.status})")
    obj.dept_head_decision = payload.decision
    obj.dept_head_id = current_user.id
    obj.dept_head_decided_at = datetime.datetime.utcnow()
    obj.status = "Approved" if payload.decision == "Approved" else "Rejected"
    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{sup_id}/history", response_model=List[schemas.ApprovalActionOut])
def suppression_history(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SUPPRESSION", entity_id=sup_id)
            .order_by(models.ApprovalAction.created_at).all())
