from typing import List, Optional
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/api/approvals", tags=["approval-workflow-engine"])


def _resolve_request_ref(db: Session, entity_type: str, entity_id: int) -> Optional[str]:
    """Human-readable business ID for an ApprovalAction's entity_type/entity_id
    (e.g. "TQA-REQ-...", "SAST-...", "SUP-...") -- shown in the Approval
    Workflow Log instead of the raw internal entity_id. Returns None if the
    underlying record no longer exists."""
    if entity_type == "QA_REQUEST":
        obj = db.query(models.QARequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "FUNCTIONAL_REQUEST":
        obj = db.query(models.FunctionalRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "SAST_DAST":
        # entity_id may belong to either table -- SAST and DAST decisions
        # both log under this one entity_type (see routers/sast_dast.py).
        sast = db.query(models.SASTRequest).get(entity_id)
        if sast:
            return sast.request_id
        dast = db.query(models.DASTRequest).get(entity_id)
        return dast.request_id if dast else None
    if entity_type == "AUTOMATION":
        obj = db.query(models.AutomationRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "PERFORMANCE":
        obj = db.query(models.PerformanceRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "SUPPRESSION":
        obj = db.query(models.SuppressionRequest).get(entity_id)
        return obj.suppression_id if obj else None
    if entity_type == "SIGNOFF":
        obj = db.query(models.QASignOff).get(entity_id)
        return obj.certificate_id if obj else None
    return None


def _to_out(db: Session, row: models.ApprovalAction) -> dict:
    return {
        "id": row.id, "entity_type": row.entity_type, "entity_id": row.entity_id,
        "request_ref": _resolve_request_ref(db, row.entity_type, row.entity_id),
        "step_name": row.step_name, "actor_id": row.actor_id, "actor_role": row.actor_role,
        "decision": row.decision, "comments": row.comments, "created_at": row.created_at,
    }


@router.get("", response_model=List[schemas.ApprovalActionOut])
def list_approvals(entity_type: Optional[str] = None, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Module 7: cross-entity approval/audit feed (QA_REQUEST, TEST_CASE, SAST_DAST, SUPPRESSION, SIGNOFF)."""
    q = db.query(models.ApprovalAction)
    if entity_type:
        q = q.filter(models.ApprovalAction.entity_type == entity_type)
    rows = q.order_by(models.ApprovalAction.created_at.desc()).limit(500).all()
    return [_to_out(db, r) for r in rows]


@router.get("/pending-mine", response_model=List[schemas.ApprovalActionOut])
def my_recent_actions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = (db.query(models.ApprovalAction)
            .filter(models.ApprovalAction.actor_id == current_user.id)
            .order_by(models.ApprovalAction.created_at.desc()).limit(100).all())
    return [_to_out(db, r) for r in rows]
