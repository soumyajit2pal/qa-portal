"""Shared multi-document upload/list/download helpers for every request type
EXCEPT the Gateway QA Request (which keeps its own dedicated
QARequestDocument table/endpoints in routers/qa_requests.py -- Module 1,
field 4.1.2, predates this file). Used by Functional/SAST/DAST/Automation/
Performance/Suppression/Sign-off so each one supports uploading multiple
documents after the request has been raised, without repeating the same
storage/table plumbing 7 times -- see models.RequestDocument for the shared
table and why its (module, request_id) keying is collision-safe."""
import os
import shutil
import uuid
from typing import List
from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from . import models

# Shares the same physical uploads folder as QARequest's own documents
# (routers/qa_requests.py::UPLOAD_ROOT), just under a per-module
# subdirectory so filenames never collide across modules.
UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)


def list_documents(db: Session, module: str, request_id: int) -> List[models.RequestDocument]:
    return (db.query(models.RequestDocument)
            .filter_by(module=module, request_id=request_id)
            .order_by(models.RequestDocument.uploaded_at).all())


def save_documents(db: Session, module: str, request_id: int, folder_name: str,
                    files: List[UploadFile], uploaded_by_id: int) -> List[models.RequestDocument]:
    """Accepts one or more files (multipart/form-data, field name 'files')
    and stores them under UPLOAD_ROOT/<module>/<folder_name>/, named to
    avoid collisions. `folder_name` should be the request's own human-
    readable request_id/suppression_id/certificate_id string."""
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
