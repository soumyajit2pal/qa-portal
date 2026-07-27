import datetime
import os
from typing import List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

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


@router.get("/{signoff_id}/history", response_model=List[schemas.ApprovalActionOut])
def signoff_history(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SIGNOFF", entity_id=signoff_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{signoff_id}/export")
def export_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this QA Sign-off Certificate, plus who issued and
    signed it and when, as one downloadable PDF -- the offline/printable
    copy of the certificate itself."""
    obj = db.query(models.QASignOff).get(signoff_id)
    if not obj:
        raise HTTPException(404, "Sign-off certificate not found")

    def uname(uid):
        if not uid:
            return None
        u = db.query(models.User).get(uid)
        return u.full_name if u else None

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Certificate Type", obj.certificate_type),
            ("Testing Type", obj.testing_type),
            ("Certificate Date", obj.certificate_date),
        ]),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Application Owner", obj.application_owner),
            ("Department", obj.department),
            ("Testing Request ID", obj.testing_request_id),
            ("Change Request ID(s)", obj.change_request_ids),
            ("Vendor / SI Partner", obj.vendor_si_partner),
            ("Technology Stack", obj.technology_stack),
        ]),
        ("Release & Environment", [
            ("Risk Tier", obj.risk_tier),
            ("Release Version", obj.release_version),
            ("Build Number", obj.build_number),
            ("Environment Tested", obj.environment_tested),
            ("Target Promotion Environment", obj.target_promotion_environment),
            ("Validity", f"{obj.validity_from or '—'} to {obj.validity_to or '—'}"),
        ]),
        ("Exit Criteria & Risk", [
            ("Exit Criteria Notes", obj.exit_criteria_notes),
            ("Open Defect Summary", obj.open_defect_summary),
            ("Residual Risk Notes", obj.residual_risk_notes),
        ]),
        ("Who Signed", [
            ("Issued By (TQA Lead / CM-QA)", uname(obj.issued_by_id)),
            ("Signed By (CM-QA)", uname(obj.signed_by_id)),
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="SIGNOFF", entity_id=signoff_id)
                     .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in history_rows:
        history.append((h.step_name or "—", h.decision or "—", uname(h.actor_id) or "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.certificate_id} — {obj.application_name}",
        subtitle="QA Sign-off Certificate — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.certificate_id}.pdf"'},
    )


# ---- Supporting documents (multiple files, uploaded any time after the
# certificate has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_signoff_documents(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "SIGNOFF", signoff_id)


@router.post("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_signoff_documents(signoff_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                              current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QASignOff).get(signoff_id)
    if not obj:
        raise HTTPException(404, "Sign-off certificate not found")
    return doc_store.save_documents(db, "SIGNOFF", signoff_id, obj.certificate_id, files, current_user.id)


@router.get("/{signoff_id}/documents/{doc_id}/download")
def download_signoff_document(signoff_id: int, doc_id: int, db: Session = Depends(get_db),
                               current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "SIGNOFF", signoff_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")
