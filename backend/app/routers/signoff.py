import datetime
import os
from typing import List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role, SIGNOFF_EDITABLE_STATUSES, QAStatus, QA_DEPARTMENT
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

router = APIRouter(prefix="/api/signoffs", tags=["signoff"])

# ---------------------------------------------------------------------------
# Module 8: QA Sign-off Certificate lifecycle -- Draft (QA Engineer fills
# in the certificate) -> QA Lead Approval -> Executive COE Approval -> Issued.
# The linked application may belong to any department, but this certificate
# workflow is owned entirely by IT - QA.
# ---------------------------------------------------------------------------


def _log(db: Session, entity_id: int, step: str, user: models.User, decision: str, comments: Optional[str] = None):
    db.add(models.ApprovalAction(
        entity_type="SIGNOFF", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected_statuses, action: str):
    if isinstance(expected_statuses, str):
        expected_statuses = [expected_statuses]
    if obj.status not in expected_statuses:
        raise HTTPException(400, f"'{action}' requires status in {expected_statuses} (currently '{obj.status}')")


def _get_or_404(db: Session, signoff_id: int) -> "models.QASignOff":
    obj = db.query(models.QASignOff).get(signoff_id)
    if not obj:
        raise HTTPException(404, "Sign-off certificate not found")
    return obj


def _sync_linked_functional_request(db: Session, obj: "models.QASignOff", current_user: models.User):
    """A certificate reaching ISSUED after Executive COE final approval
    previously never moved the linked Functional Testing Request off
    "QA Sign-off Pending" -- that hop only ever happened via a separate,
    manual "Confirm Sign-off" button (routers/functional.py::confirm_signoff)
    that a QA Lead had to remember to click themselves, and which didn't even
    check that the certificate was actually Issued before letting them.
    Since the certificate's own QA Engineer -> QA Lead -> Executive COE approval
    chain already fully covers "is this sign-off actually approved", that
    separate manual step is redundant and easy to forget -- so this now
    syncs automatically the moment the certificate is Issued, and the
    Functional Testing Request's own "Confirm Sign-off" button has been
    removed from the frontend (see Functional.tsx). Mirrors confirm_signoff's
    own two-step log (QA Sign-off "Signed Off", then Requester Verification
    "Pending") so the History tab reads identically either way."""
    linked = (db.query(models.FunctionalRequest)
              .filter_by(signoff_id=obj.id, status=QAStatus.QA_SIGNOFF_PENDING).all())
    for fr in linked:
        fr.status = QAStatus.QA_SIGNED_OFF
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=fr.id, step_name="QA Sign-off",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Signed Off",
            comments=f"Certificate {obj.certificate_id} issued by Executive COE",
        ))
        fr.status = QAStatus.REQUESTER_VERIFICATION
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=fr.id, step_name="Requester Verification",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Pending",
            comments="Sent for requester verification",
        ))


def _require_qa_department(user: models.User) -> None:
    if user.has_role(Role.ADMIN):
        return
    if user.department != QA_DEPARTMENT:
        raise HTTPException(
            403,
            f"QA Sign-off is restricted to the '{QA_DEPARTMENT}' department. "
            f"Your profile is mapped to '{user.department or 'no department'}'.",
        )


@router.get("", response_model=List[schemas.SignOffOut])
def list_signoffs(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.QASignOff).order_by(models.QASignOff.created_at.desc()).all()


@router.get("/{signoff_id}", response_model=schemas.SignOffOut)
def get_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_or_404(db, signoff_id)


@router.post("", response_model=schemas.SignOffOut)
def create_signoff(payload: schemas.SignOffCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.QA_ENGINEER))):
    """Raised by the QA Engineer who executed testing; starts as a Draft."""
    _require_qa_department(current_user)
    data = payload.model_dump()
    # Never trust the linked business request's department for approval
    # routing: the sign-off certificate is an IT - QA-owned record.
    data["department"] = QA_DEPARTMENT
    obj = models.QASignOff(**data, status="DRAFT", requester_id=current_user.id)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    _log(db, obj.id, "Requester", current_user, "Drafted", "QA Sign-off Certificate created as draft")
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{signoff_id}", response_model=schemas.SignOffOut)
def update_signoff(signoff_id: int, payload: schemas.SignOffUpdate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Two different actors, two different windows: the QA requester
    can edit while the certificate is DRAFT or sitting back with them after
    a QA Lead/Executive COE return; a QA Lead can additionally edit it
    directly while it's sitting at their approval checkpoint rather than
    returning it first just to fix something minor. Executive COE
    gets no edit window; their only actions are Approve/Return/Reject."""
    obj = _get_or_404(db, signoff_id)
    is_own = obj.requester_id == current_user.id
    is_admin = current_user.has_role(Role.ADMIN)
    is_qa_lead = current_user.has_role(Role.QA_LEAD)

    # Checked in this order deliberately: the QA-Lead-reviewing-right-now window
    # is checked first so a user who happens to be both the original
    # requester AND holds the QA Lead role isn't wrongly blocked by the
    # requester's own (narrower) editable-status gate below.
    if is_qa_lead and obj.status == "SM_APPROVAL_PENDING":
        _require_qa_department(current_user)
    elif is_admin:
        pass  # admin bypasses the status gate, same convention as every other module
    elif is_own:
        if obj.status not in SIGNOFF_EDITABLE_STATUSES:
            raise HTTPException(400, f"Certificate cannot be edited while in status '{obj.status}'")
    else:
        raise HTTPException(403, "Only the requester, a QA Lead during approval, or an admin can edit this certificate")

    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/submit", response_model=schemas.SignOffOut)
def submit_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, signoff_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this certificate")
    _require(obj, "DRAFT", "Submit")
    obj.status = "SUBMITTED"
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "QA Lead Approval", current_user, "Pending", "Awaiting QA Lead decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/resubmit", response_model=schemas.SignOffOut)
def resubmit_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Re-submits a certificate returned by QA Lead or Executive COE. A
    return from Executive COE goes straight back to their own queue
    (QA Lead already approved it once) -- the direct return goes back to
    Executive COE rather than repeating QA Lead approval."""
    obj = _get_or_404(db, signoff_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this certificate")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPT_HEAD_COE"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "QA Lead Approval", current_user, "Resubmitted", "Returned certificate re-submitted")
    else:
        obj.status = "DEPT_HEAD_COE_APPROVAL_PENDING"
        _log(db, obj.id, "Executive COE Approval", current_user, "Resubmitted", "Returned certificate re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/qa-lead-decision", response_model=schemas.SignOffOut)
def qa_lead_decision(signoff_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """QA Lead approval checkpoint before Executive COE final approval."""
    obj = _get_or_404(db, signoff_id)
    _require_qa_department(current_user)
    _require(obj, "SM_APPROVAL_PENDING", "QA Lead decision")
    if payload.decision == "Approved":
        obj.status = "DEPT_HEAD_COE_APPROVAL_PENDING"
        obj.reviewed_by_id = current_user.id
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "SM_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "QA Lead Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/department-head-coe-decision", response_model=schemas.SignOffOut, include_in_schema=False)
@router.post("/{signoff_id}/executive-coe-decision", response_model=schemas.SignOffOut)
def executive_coe_decision(signoff_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_COE))):
    """Final IT - QA approval by Executive COE; approval issues the certificate."""
    obj = _get_or_404(db, signoff_id)
    _require_qa_department(current_user)
    _require(obj, "DEPT_HEAD_COE_APPROVAL_PENDING", "Executive COE decision")
    if payload.decision == "Approved":
        obj.status = "ISSUED"
        obj.approved_by_id = current_user.id
        _sync_linked_functional_request(db, obj, current_user)
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPT_HEAD_COE"
    elif payload.decision == "Rejected":
        obj.status = "DEPT_HEAD_COE_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Executive COE Approval", current_user, payload.decision, payload.comments)
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
    """Every field on this QA Sign-off Certificate, plus who requested,
    reviewed and approved it and when, as one downloadable PDF -- the
    offline/printable copy of the certificate itself."""
    obj = _get_or_404(db, signoff_id)

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
        # Mandatory on a fully-Issued certificate -- one name per approval
        # stage of the QA Team -> QA Lead -> Executive COE chain.
        ("Requested / Reviewed / Approved", [
            ("Requested By (QA Team)", uname(obj.requester_id)),
            ("Approved By (QA Lead)", uname(obj.reviewed_by_id)),
            ("Approved By (Executive COE)", uname(obj.approved_by_id)),
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
        generated_at=datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M IST"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.certificate_id}.pdf"'},
    )


def _can_upload_documents(db: Session, obj: "models.QASignOff", user: models.User) -> bool:
    """Reported bug: upload had no restriction at all -- any logged-in user
    could attach documents to any QA Sign-off certificate. Scoped to the
    original QA requester plus the IT - QA stage owner: QA Lead during
    QA Lead approval (legacy status SM_APPROVAL_PENDING) or Executive COE
    during final approval. Admin always
    bypasses, same convention as every other permission check."""
    if user.has_role(Role.ADMIN):
        return True
    if obj.requester_id == user.id:
        return True
    status = obj.status
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.QA_LEAD) and user.department == QA_DEPARTMENT
    if status == "DEPT_HEAD_COE_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_COE) and user.department == QA_DEPARTMENT
    return False


# ---- Supporting documents (multiple files, uploaded any time after the
# certificate has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_signoff_documents(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "SIGNOFF", signoff_id)


@router.post("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_signoff_documents(signoff_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                              current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, signoff_id)
    if not _can_upload_documents(db, obj, current_user):
        raise HTTPException(403, "Only the QA requester, QA Lead, or Executive COE currently reviewing this certificate can upload documents")
    return doc_store.save_documents(db, "SIGNOFF", signoff_id, obj.certificate_id, files, current_user.id)


@router.get("/{signoff_id}/documents/{doc_id}/download")
def download_signoff_document(signoff_id: int, doc_id: int, db: Session = Depends(get_db),
                               current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "SIGNOFF", signoff_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/{signoff_id}/documents/{doc_id}")
def delete_signoff_document(signoff_id: int, doc_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "SIGNOFF", signoff_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it")
    doc_store.delete_document(db, doc)
    return {"ok": True}
