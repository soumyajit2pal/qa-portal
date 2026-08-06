"""Shared multi-document upload/list/download helpers for every request type
EXCEPT the Gateway QA Request (which keeps its own dedicated
QARequestDocument table/endpoints in routers/qa_requests.py -- Module 1,
field 4.1.2, predates this file). Used by Functional/SAST/DAST/
Performance/Suppression/Sign-off and rich comment images so each supports uploading multiple
documents after the request has been raised, without repeating the same
storage/table plumbing 6 times -- see models.RequestDocument for the shared
table and why its (module, request_id) keying is collision-safe."""
import os
import shutil
import uuid
from typing import List, Optional
from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from . import models
from .constants import Role

# Shares the same physical uploads folder as QARequest's own documents
# (routers/qa_requests.py::UPLOAD_ROOT), just under a per-module
# subdirectory so filenames never collide across modules.
UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)


def list_documents(db: Session, module: str, request_id: int) -> List[models.RequestDocument]:
    return (db.query(models.RequestDocument)
            .filter_by(module=module, request_id=request_id)
            .order_by(models.RequestDocument.uploaded_at).all())


def list_documents_for_items(db: Session, module: str, item_ids: List[int]) -> List[models.RequestDocument]:
    """Batched counterpart to list_documents above, for the "*_ITEM" modules
    (FUNCTIONAL_ITEM/SAST_ITEM/DAST_ITEM/PERFORMANCE_ITEM) where request_id
    actually stores a checklist item's own id, not the parent request's --
    one query for every item's documents instead of one query per item, so
    routes like GET .../checklist/documents can return everything a page
    needs in a single round trip (see ChecklistItemDocumentOut). Caller is
    responsible for grouping the flat result back out by .request_id
    (== item id) since that's response-shape-specific."""
    if not item_ids:
        return []
    return (db.query(models.RequestDocument)
            .filter(models.RequestDocument.module == module,
                    models.RequestDocument.request_id.in_(item_ids))
            .order_by(models.RequestDocument.uploaded_at).all())


def _log_document_action(db: Session, entity_type: Optional[str], entity_id: Optional[int],
                          actor: Optional["models.User"], decision: str, comments: str) -> None:
    """Shared ApprovalAction logging for document upload/removal -- reported
    directly: "any upload of document, remove should be log in activity."
    Deliberately opt-in: entity_type/entity_id/actor all default to None on
    save_documents/delete_document below, so nothing changes for a call site
    that doesn't pass them. TEST_EXEC_IMAGE (already covered by its own
    "Attempt Recorded" entry, see test_execution.py::_record_attempt),
    COMMENT_IMAGE (already covered by the comment's own "Commented" entry,
    see approvals.py::_create_comment), and the QA Request wizard's pre-raise
    draft checklist evidence (nothing meaningful to attribute yet -- the
    request isn't even raised) deliberately never pass these, so they stay
    exactly as before, un-double-logged."""
    if not entity_type or not entity_id or not actor:
        return
    db.add(models.ApprovalAction(
        entity_type=entity_type, entity_id=entity_id, step_name="Document",
        actor_id=actor.id, actor_role=actor.roles_csv,
        decision=decision, comments=comments,
    ))


def save_documents(db: Session, module: str, request_id: int, folder_name: str,
                    files: List[UploadFile], uploaded_by_id: int,
                    log_entity_type: Optional[str] = None, log_entity_id: Optional[int] = None,
                    log_actor: Optional["models.User"] = None,
                    log_label: Optional[str] = None) -> List[models.RequestDocument]:
    """Accepts one or more files (multipart/form-data, field name 'files')
    and stores them under UPLOAD_ROOT/<module>/<folder_name>/, named to
    avoid collisions. `folder_name` should be the request's own human-
    readable request_id/suppression_id/certificate_id string.

    log_entity_type/log_entity_id/log_actor: when all three are given, also
    appends one "Uploaded" ApprovalAction against that entity (see
    _log_document_action above) -- entity_type/entity_id should be the
    PARENT request's own Activity-tab identity (e.g. "FUNCTIONAL_REQUEST"/
    obj.id), not this module/request_id pair, since request_id here is a
    checklist item's own id for the "*_ITEM" modules, which has no Activity
    tab of its own. log_label, if given, is folded into the log message
    (e.g. "checklist item 'Test Data Prepared'") so an item-level upload
    reads distinctly from a top-level Documents-tab one."""
    request_dir = os.path.join(UPLOAD_ROOT, module, folder_name)
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

        doc = models.RequestDocument(
            module=module, request_id=request_id,
            file_name=f.filename or original_name,
            stored_path=os.path.join(module, folder_name, original_name),
            content_type=f.content_type,
            file_size=os.path.getsize(dest_path),
            uploaded_by_id=uploaded_by_id,
        )
        db.add(doc)
        created.append(doc)

    if created:
        names = ", ".join(d.file_name for d in created)
        suffix = f" to {log_label}" if log_label else ""
        _log_document_action(
            db, log_entity_type, log_entity_id, log_actor, "Uploaded",
            f"Uploaded {len(created)} file{'s' if len(created) != 1 else ''}{suffix}: {names}",
        )

    db.commit()
    for d in created:
        db.refresh(d)
    return created


def get_document_or_404(db: Session, module: str, request_id: int, doc_id: int) -> models.RequestDocument:
    doc = db.query(models.RequestDocument).filter_by(id=doc_id, module=module, request_id=request_id).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc


def full_path(doc: models.RequestDocument) -> str:
    return os.path.join(UPLOAD_ROOT, doc.stored_path)


def can_delete_document(doc, user: "models.User", is_current_stage_actor: bool = True) -> bool:
    """Reported directly (Document and Evidence Access Control Based on
    Workflow Stage): a file must stay deletable only by whoever uploaded it,
    and only for as long as *that same person* is still the request's
    current stage owner -- once the request moves on (SM's own file becomes
    read-only the moment it reaches Department Head; Department Head's own
    file becomes read-only the moment it reaches the next stage; everything
    becomes read-only after Department Head approval until the request is
    returned to the requester), even the uploader can no longer remove it.
    `is_current_stage_actor` is the caller's own `_can_upload_documents(obj,
    user)` result for THIS request right now -- i.e. exactly the same check
    that decided whether `user` may upload here at all -- so deletion is
    always a strict subset of "could I upload here right now", never wider.
    Defaults to `True` for the one caller (qa_requests.py's own separate
    document table) where upload was never staged in the first place --
    that gateway has no SM/Department Head review of its own, so its
    documents are always the requester's (or admin's) alone at any
    non-cancelled status, matching the prior unconditional behavior exactly.
    Admin always bypasses both conditions, same convention as every other
    permission check in this app."""
    if user.has_role(Role.ADMIN):
        return True
    return bool(is_current_stage_actor and doc.uploaded_by_id and doc.uploaded_by_id == user.id)


def delete_document(db: Session, doc: models.RequestDocument,
                     log_entity_type: Optional[str] = None, log_entity_id: Optional[int] = None,
                     log_actor: Optional["models.User"] = None,
                     log_label: Optional[str] = None) -> None:
    """See save_documents' matching docstring for what log_entity_type/
    log_entity_id/log_actor/log_label do -- same opt-in logging, this time
    an "Removed" ApprovalAction. file_name is captured before the row is
    deleted so the log message still names the file afterward."""
    path = full_path(doc)
    if os.path.exists(path):
        os.remove(path)
    file_name = doc.file_name
    db.delete(doc)
    suffix = f" from {log_label}" if log_label else ""
    _log_document_action(db, log_entity_type, log_entity_id, log_actor, "Removed", f"Removed {file_name}{suffix}")
    db.commit()
