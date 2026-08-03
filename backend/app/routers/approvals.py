import os
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from .. import documents as doc_store

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

_COMMENT_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_COMMENT_IMAGE_LIMIT = 8
_COMMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024


def _comment_target_or_404(db: Session, entity_type: str, entity_id: int):
    normalized_type = entity_type.strip().upper()
    model = _COMMENT_ENTITY_MODELS.get(normalized_type)
    if not model:
        raise HTTPException(400, f"Comments are not supported for entity type '{entity_type}'")
    if not db.query(model).get(entity_id):
        raise HTTPException(404, "Record not found")
    return normalized_type


def _validated_comment_body(body: str, allow_empty: bool = False) -> str:
    text = body.strip()
    if not text and not allow_empty:
        raise HTTPException(400, "Comment cannot be blank")
    if len(text) > 5000:
        raise HTTPException(400, "Comment cannot exceed 5,000 characters")
    return text


def _validate_comment_images(files: List[UploadFile]) -> None:
    if len(files) > _COMMENT_IMAGE_LIMIT:
        raise HTTPException(400, f"A comment can contain at most {_COMMENT_IMAGE_LIMIT} images")
    for image in files:
        if (image.content_type or "").lower() not in _COMMENT_IMAGE_TYPES:
            raise HTTPException(
                400,
                f"'{image.filename or 'pasted image'}' is not a supported image. "
                "Use PNG, JPEG, GIF, or WebP.",
            )
        image.file.seek(0, os.SEEK_END)
        size = image.file.tell()
        image.file.seek(0)
        if size > _COMMENT_IMAGE_MAX_BYTES:
            raise HTTPException(400, f"'{image.filename or 'pasted image'}' exceeds the 10 MB image limit")


def _create_comment(db: Session, normalized_type: str, entity_id: int, body: str,
                    current_user: models.User) -> models.ApprovalAction:
    row = models.ApprovalAction(
        entity_type=normalized_type, entity_id=entity_id, step_name="Comment",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Commented", comments=body or None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.post("/{entity_type}/{entity_id}/comments", response_model=schemas.ApprovalActionOut)
def add_comment(entity_type: str, entity_id: int, payload: schemas.CommentCreate,
                db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Append a Jira-style standalone comment to any supported module's
    existing audit stream. Comments are immutable audit events and therefore
    remain visible alongside workflow actions and approvals."""
    normalized_type = _comment_target_or_404(db, entity_type, entity_id)
    body = _validated_comment_body(payload.body)
    row = _create_comment(db, normalized_type, entity_id, body, current_user)
    return _to_out(db, row)


@router.post("/{entity_type}/{entity_id}/rich-comments", response_model=schemas.ApprovalActionOut)
def add_rich_comment(entity_type: str, entity_id: int, body: str = Form(""),
                     files: List[UploadFile] = File(default=[]), db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    """Post formatted comment text plus images pasted or selected in the
    shared Jira-style editor. Formatting is stored as safe Markdown text;
    images are immutable authenticated attachments owned by the comment."""
    normalized_type = _comment_target_or_404(db, entity_type, entity_id)
    _validate_comment_images(files)
    text = _validated_comment_body(body, allow_empty=bool(files))
    row = _create_comment(db, normalized_type, entity_id, text, current_user)
    if files:
        doc_store.save_documents(
            db, "COMMENT_IMAGE", row.id, f"comment-{row.id}", files, current_user.id
        )
    return _to_out(db, row)


def _comment_or_404(db: Session, comment_id: int) -> models.ApprovalAction:
    row = db.query(models.ApprovalAction).get(comment_id)
    if not row or row.decision != "Commented":
        raise HTTPException(404, "Comment not found")
    return row


@router.get("/comments/{comment_id}/attachments", response_model=List[schemas.RequestDocumentOut])
def list_comment_attachments(comment_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    _comment_or_404(db, comment_id)
    return doc_store.list_documents(db, "COMMENT_IMAGE", comment_id)


@router.get("/comments/{comment_id}/attachments/{document_id}/download")
def download_comment_attachment(comment_id: int, document_id: int, db: Session = Depends(get_db),
                                current_user: models.User = Depends(get_current_user)):
    _comment_or_404(db, comment_id)
    document = doc_store.get_document_or_404(db, "COMMENT_IMAGE", comment_id, document_id)
    path = doc_store.full_path(document)
    if not os.path.exists(path):
        raise HTTPException(404, "Comment image is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")


@router.get("/pending-mine", response_model=List[schemas.ApprovalActionOut])
def my_recent_actions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = (db.query(models.ApprovalAction)
            .filter(models.ApprovalAction.actor_id == current_user.id)
            .order_by(models.ApprovalAction.created_at.desc()).limit(100).all())
    return [_to_out(db, r) for r in rows]
