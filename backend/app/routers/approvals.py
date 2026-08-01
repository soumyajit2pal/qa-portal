from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
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
    if entity_type == "SAST":
        obj = db.query(models.SASTRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "DAST":
        obj = db.query(models.DASTRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "SAST_DAST":
        # Legacy rows logged before SAST/DAST were split into their own
        # distinct entity_type values above (see the long comment on
        # routers/sast_dast.py::_legacy_history_rows) -- entity_id here may
        # belong to either table, so this is a best-effort lookup only, kept
        # for rows written before the split.
        sast = db.query(models.SASTRequest).get(entity_id)
        if sast:
            return sast.request_id
        dast = db.query(models.DASTRequest).get(entity_id)
        return dast.request_id if dast else None
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
        "step_name": row.step_name, "actor_id": row.actor_id, "actor_name": row.actor_name, "actor_role": row.actor_role,
        "decision": row.decision, "comments": row.comments, "created_at": row.created_at,
    }


@router.get("", response_model=List[schemas.ApprovalActionOut])
def list_approvals(entity_type: Optional[str] = None, entity_id: Optional[int] = None, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Module 7: cross-entity approval/audit feed (QA_REQUEST, TEST_CASE, SAST_DAST, SUPPRESSION, SIGNOFF)."""
    q = db.query(models.ApprovalAction)
    if entity_type:
        q = q.filter(models.ApprovalAction.entity_type == entity_type)
    if entity_id is not None:
        q = q.filter(models.ApprovalAction.entity_id == entity_id)
    rows = q.order_by(models.ApprovalAction.created_at.desc()).limit(500).all()
    return [_to_out(db, r) for r in rows]


_COMMENT_ENTITY_MODELS = {
    "QA_REQUEST": models.QARequest,
    "FUNCTIONAL_REQUEST": models.FunctionalRequest,
    "SAST": models.SASTRequest,
    "DAST": models.DASTRequest,
    "PERFORMANCE": models.PerformanceRequest,
    "SUPPRESSION": models.SuppressionRequest,
    "SIGNOFF": models.QASignOff,
    "TEST_PROJECT": models.TestProject,
    "TEST_CASE": models.TestCase,
    "TEST_CYCLE": models.TestCycle,
}


@router.post("/{entity_type}/{entity_id}/comments", response_model=schemas.ApprovalActionOut)
def add_comment(entity_type: str, entity_id: int, payload: schemas.CommentCreate,
                db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Append a Jira-style standalone comment to any supported module's
    existing audit stream. Comments are immutable audit events and therefore
    remain visible alongside workflow actions and approvals."""
    normalized_type = entity_type.strip().upper()
    model = _COMMENT_ENTITY_MODELS.get(normalized_type)
    if not model:
        raise HTTPException(400, f"Comments are not supported for entity type '{entity_type}'")
    if not db.query(model).get(entity_id):
        raise HTTPException(404, "Record not found")
    body = payload.body.strip()
    if not body:
        raise HTTPException(400, "Comment cannot be blank")
    if len(body) > 5000:
        raise HTTPException(400, "Comment cannot exceed 5,000 characters")
    row = models.ApprovalAction(
        entity_type=normalized_type, entity_id=entity_id, step_name="Comment",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Commented", comments=body,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(db, row)


@router.get("/pending-mine", response_model=List[schemas.ApprovalActionOut])
def my_recent_actions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = (db.query(models.ApprovalAction)
            .filter(models.ApprovalAction.actor_id == current_user.id)
            .order_by(models.ApprovalAction.created_at.desc()).limit(100).all())
    return [_to_out(db, r) for r in rows]
