import datetime
import os
from typing import List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import Role, SIGNOFF_EDITABLE_STATUSES, QAStatus
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

router = APIRouter(prefix="/api/signoffs", tags=["signoff"])

# ---------------------------------------------------------------------------
# Module 8: QA Sign-off Certificate lifecycle -- Draft (Tester/QA Lead fills
# in the certificate) -> Submit -> SM Approval (SM reviews, may edit details
# directly) -> Department Head COE Approval -> Issued. Mirrors the same
# Requester -> SM -> Department Head shape used everywhere else in the app
# (Functional/SAST/DAST/Performance/Suppression), just with
# "Department Head COE" standing in for the business-side Department Head and
# no QA-side stages after it -- Department Head COE's own approval IS the
# final sign-off now, replacing the old QA-Lead-only "Sign & Issue" step.
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
    """Reported bug: a certificate reaching ISSUED (Department Head COE's
    final approval) never moved the linked Functional Testing Request off
    "QA Sign-off Pending" -- that hop only ever happened via a separate,
    manual "Confirm Sign-off" button (routers/functional.py::confirm_signoff)
    that a QA Lead had to remember to click themselves, and which didn't even
    check that the certificate was actually Issued before letting them.
    Since the certificate's own Tester -> SM -> Department Head COE approval
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
            comments=f"Certificate {obj.certificate_id} issued by Department Head COE",
        ))
        fr.status = QAStatus.REQUESTER_VERIFICATION
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=fr.id, step_name="Requester Verification",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Pending",
            comments="Sent for requester verification",
        ))


def _requester_department(db: Session, obj: "models.QASignOff"):
    """Confirmed: "Sign off form raised by QA team, so it should be approved
    by QA team only" -- Department Head COE approval matches against the
    certificate's own REQUESTER's department (the Tester/QA Lead who raised
    it -- always someone on the QA team), not `obj.department` (the
    delegated business department of the underlying Functional Testing
    Request, e.g. "Digital Banking Department (DBD)" -- that field is what
    the SM step matches against instead, since SM is the genuine business-
    side reviewer). Using the requester's own department rather than
    hardcoding the literal string "QA Team" keeps this correct even if the
    QA team's department is ever renamed or split in Admin > Departments."""
    requester = db.query(models.User).get(obj.requester_id) if obj.requester_id else None
    return requester.department if requester else None


@router.get("", response_model=List[schemas.SignOffOut])
def list_signoffs(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.QASignOff).order_by(models.QASignOff.created_at.desc()).all()


@router.get("/{signoff_id}", response_model=schemas.SignOffOut)
def get_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_or_404(db, signoff_id)


@router.post("", response_model=schemas.SignOffOut)
def create_signoff(payload: schemas.SignOffCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD))):
    """Raised by the Tester (QA Engineer) who executed testing, or the QA
    Lead -- starts life as a Draft they can keep editing until Submit."""
    obj = models.QASignOff(**payload.model_dump(), status="DRAFT", requester_id=current_user.id)
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
    """Two different actors, two different windows: the Tester (requester)
    can edit while the certificate is DRAFT or sitting back with them after
    an SM/Department Head COE return; an SM can additionally edit it
    directly while it's sitting at their OWN SM_APPROVAL_PENDING review --
    "he will have option to modify details" -- rather than having to Return
    it to the Tester first just to fix something minor. Department Head COE
    gets no edit window; their only actions are Approve/Return/Reject."""
    obj = _get_or_404(db, signoff_id)
    is_own = obj.requester_id == current_user.id
    is_admin = current_user.has_role(Role.ADMIN)
    is_sm = current_user.has_role(Role.SM)

    # Checked in this order deliberately: the SM-reviewing-right-now window
    # is checked first so a user who happens to be both the original
    # requester AND holds the SM role isn't wrongly blocked by the
    # requester's own (narrower) editable-status gate below.
    if is_sm and obj.status == "SM_APPROVAL_PENDING":
        require_same_department(current_user, obj.department)
    elif is_admin:
        pass  # admin bypasses the status gate, same convention as every other module
    elif is_own:
        if obj.status not in SIGNOFF_EDITABLE_STATUSES:
            raise HTTPException(400, f"Certificate cannot be edited while in status '{obj.status}'")
    else:
        raise HTTPException(403, "Only the requester, an SM (during their own review), or an admin can edit this certificate")

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
    _log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/resubmit", response_model=schemas.SignOffOut)
def resubmit_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Re-submits a certificate returned by SM or Department Head COE. A
    return from Department Head COE goes straight back to their own queue
    (SM already approved it once) -- same "direct return skips back through
    SM" pattern as every other module's Department-Head-level return."""
    obj = _get_or_404(db, signoff_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this certificate")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPT_HEAD_COE"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned certificate re-submitted")
    else:
        obj.status = "DEPT_HEAD_COE_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head COE Approval", current_user, "Resubmitted", "Returned certificate re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/sm-decision", response_model=schemas.SignOffOut)
def sm_decision(signoff_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                current_user: models.User = Depends(require_roles(Role.SM))):
    """Checkpoint between the Tester's submission and Department Head COE
    approval -- the SM may also have directly edited the certificate's
    details just before deciding (see update_signoff)."""
    obj = _get_or_404(db, signoff_id)
    require_same_department(current_user, obj.department)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    if payload.decision == "Approved":
        obj.status = "DEPT_HEAD_COE_APPROVAL_PENDING"
        obj.reviewed_by_id = current_user.id
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "SM_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/department-head-coe-decision", response_model=schemas.SignOffOut)
def department_head_coe_decision(signoff_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_COE))):
    """Final approval -- Approved issues the certificate outright (no further
    QA-Lead sign step; this replaces the old /issue endpoint).

    Department mapping IS required here, same as SM/Department Head --
    confirmed explicitly: "Sign off form raised by QA team, so it should be
    approved by QA team only." The certificate's own REQUESTER (the Tester/
    QA Lead who raised it) is always someone on the QA team -- so this
    matches against *their* department (see _requester_department above),
    not `obj.department` (the delegated business department of the
    underlying Functional Testing Request, e.g. "Digital Banking Department
    (DBD)" -- that's what the SM step matches against instead, a couple of
    lines up, since SM genuinely is the business-side reviewer). Matching
    against `obj.department` here (an earlier revision's mistake, since
    corrected) would have compared the Executive COE's own department
    against the wrong side of the workflow entirely and could never pass."""
    obj = _get_or_404(db, signoff_id)
    require_same_department(current_user, _requester_department(db, obj))
    _require(obj, "DEPT_HEAD_COE_APPROVAL_PENDING", "Department Head COE decision")
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
    _log(db, obj.id, "Department Head COE Approval", current_user, payload.decision, payload.comments)
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
        # Mandatory on a fully-Issued certificate -- Requested By/Reviewed
        # By/Approved By, one name per approval stage of the Tester -> SM ->
        # Department Head COE chain (see models.QASignOff).
        ("Requested / Reviewed / Approved", [
            ("Requested By (Tester)", uname(obj.requester_id)),
            ("Reviewed By (SM)", uname(obj.reviewed_by_id)),
            ("Approved By (Department Head COE)", uname(obj.approved_by_id)),
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
    original requester (Tester/QA Lead who raised it, always) plus whoever
    the certificate's *current* status is actually sitting with: SM during
    SM_APPROVAL_PENDING (matches `obj.department`, the delegated business
    department -- SM is a genuine business-side reviewer), or Department
    Head COE during DEPT_HEAD_COE_APPROVAL_PENDING (matches the certificate's
    own requester's department instead -- see _requester_department and the
    matching comment on department_head_coe_decision -- "raised by QA team,
    so should be approved by QA team only"). Admin always bypasses, same
    convention as every other permission check in this file."""
    if user.has_role(Role.ADMIN):
        return True
    if obj.requester_id == user.id:
        return True
    status = obj.status
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.SM) and user.department == obj.department
    if status == "DEPT_HEAD_COE_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_COE) and user.department == _requester_department(db, obj)
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
        raise HTTPException(403, "Only the requester or this certificate's current stage owner (SM or Department Head COE currently reviewing it) can upload documents")
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
