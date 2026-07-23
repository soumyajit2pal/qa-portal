from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/signoffs", tags=["signoff"])


@router.get("", response_model=List[schemas.SignOffOut])
def list_signoffs(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.QASignOff).order_by(models.QASignOff.created_at.desc()).all()


@router.get("/{signoff_id}", response_model=schemas.SignOffOut)
def get_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QASignOff).get(signoff_id)
    if not obj:
        raise HTTPException(404, "Sign-off certificate not found")
    return obj


@router.post("", response_model=schemas.SignOffOut)
def create_signoff(payload: schemas.SignOffCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.DEPARTMENT_HEAD_COE))):
    obj = models.QASignOff(**payload.model_dump(), status="Draft", issued_by_id=current_user.id)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/issue", response_model=schemas.SignOffOut)
def issue_signoff(signoff_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """QA Lead (CM-QA) signs and issues the certificate."""
    obj = db.query(models.QASignOff).get(signoff_id)
    if not obj:
        raise HTTPException(404, "Sign-off certificate not found")
    obj.status = "Issued"
    obj.signed_by_id = current_user.id
    db.add(models.ApprovalAction(
        entity_type="SIGNOFF", entity_id=obj.id, step_name="CM-QA Sign-off",
        actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Approved",
    ))
    db.commit()
    db.refresh(obj)
    return obj
