import os
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session, joinedload

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_not_requester, dashboard_department_scope
from ..constants import Role, SIGNOFF_EDITABLE_STATUSES, QAStatus, QA_DEPARTMENT, validate_environment_promotion
from ..pdf_export import RichTextValue, build_request_detail_pdf, parse_electronic_signature
from .. import documents as doc_store

router = APIRouter(prefix="/api/signoffs", tags=["signoff"])

# ---------------------------------------------------------------------------
# Module 8: QA Sign-off Certificate lifecycle -- Draft (QA Engineer fills
# in the certificate) -> QA Lead Approval -> Executive  Approval -> Issued.
# The linked application may belong to any department, but this certificate
# workflow is owned entirely by COE - Quality Assurance.
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


def _get_visible_or_404(db: Session, signoff_id: int, user: models.User) -> "models.QASignOff":
    """Resolve a certificate while enforcing request-department privacy."""
    obj = _get_or_404(db, signoff_id)
    scope = dashboard_department_scope(user)
    if scope and obj.request_department not in scope:
        # Deliberately 404 instead of 403 so another department cannot use
        # sequential IDs to discover whether a private certificate exists.
        raise HTTPException(404, "Sign-off certificate not found")
    return obj


def _sync_linked_functional_request(db: Session, obj: "models.QASignOff", current_user: models.User):
    """A certificate reaching ISSUED after Executive  final approval
    previously never moved the linked Functional Testing Request off
    "QA Sign-off Pending" -- that hop only ever happened via a separate,
    manual "Confirm Sign-off" button (routers/functional.py::confirm_signoff)
    that a QA Lead had to remember to click themselves, and which didn't even
    check that the certificate was actually Issued before letting them.
    Since the certificate's own QA Engineer -> QA Lead ->  approval
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
            comments=f"Certificate {obj.certificate_id} issued by Executive",
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
    if not user.has_department(QA_DEPARTMENT):
        raise HTTPException(
            403,
            f"QA Sign-off is restricted to the '{QA_DEPARTMENT}' department. "
            f"Your profile is mapped to '{', '.join(user.departments) or 'no department'}'.",
        )


def _validate_rich_text_before_progress(obj: models.QASignOff) -> None:
    """Block workflow advancement for legacy records saved before the API
    enforced the editor's 10,000-character contract. Return/reject decisions
    remain available so an approver can send an invalid record back; callers
    invoke this only for submit/resubmit/approve paths.
    """
    fields = (
        ("Exit Criteria Validation Notes", obj.exit_criteria_notes),
        ("Open Defect Review Summary", obj.open_defect_summary),
        ("Residual Risk Documentation", obj.residual_risk_notes),
    )
    oversized = [
        f"{label} ({len(value):,}/{schemas.RICH_TEXT_MAX_LENGTH:,})"
        for label, value in fields
        if value is not None and len(value) > schemas.RICH_TEXT_MAX_LENGTH
    ]
    if oversized:
        raise HTTPException(
            400,
            "Cannot continue the QA Sign-off workflow because rich-text content exceeds the limit: "
            + "; ".join(oversized)
            + ". Edit the certificate and reduce each field to 10,000 characters or fewer.",
        )


@router.get("", response_model=List[schemas.SignOffOut])
def list_signoffs(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # The module is visible to every authenticated account, but business
    # users may only see certificates originating from their own department.
    # QA delivery/executive roles and Administrators are intentionally
    # unscoped by dashboard_department_scope because their governed workflow
    # responsibilities span departments. Filter on the linked request's
    # department, not QASignOff.department (the latter is always the COE - Quality Assurance
    # approval owner and would make business privacy filtering meaningless).
    # Perf tuning (2026-08, reported directly: "some of the apis are taking
    # lot of timing") -- SignOffOut.request_department reads
    # source_functional_request (a viewonly relationship matched on business
    # ID, not a normal FK), previously lazy-loaded once per row. joinedload
    # here turns that into a single extra LEFT JOIN for the whole page
    # instead of one query per certificate.
    q = db.query(models.QASignOff).options(joinedload(models.QASignOff.source_functional_request))
    scope = dashboard_department_scope(current_user)
    if scope:
        q = (q.join(
                models.FunctionalRequest,
                models.FunctionalRequest.request_id == models.QASignOff.testing_request_id,
            )
            .join(models.QARequest, models.QARequest.id == models.FunctionalRequest.qa_request_id)
            .filter(models.QARequest.department.in_(scope)))
    return q.order_by(models.QASignOff.created_at.desc()).all()


@router.get("/{signoff_id}", response_model=schemas.SignOffOut)
def get_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_visible_or_404(db, signoff_id, current_user)


@router.post("", response_model=schemas.SignOffOut)
def create_signoff(payload: schemas.SignOffCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """Raised by the QA Engineer who executed testing -- or, 2026-08 (reported
    directly: "'Request Sign Off' button is not enable[d] for QA lead ... if
    tester [is] no[t] available then at least [o]n behalf of QA he can raise
    the request"), by the QA Lead group on behalf of a request whose tester
    isn't available to raise it themselves. Starts as a Draft either way --
    no different downstream handling based on who created it."""
    _require_qa_department(current_user)
    data = payload.model_dump()
    # Never trust the linked business request's department for approval
    # routing: the sign-off certificate is a COE - Quality Assurance-owned record.
    data["department"] = QA_DEPARTMENT
    # Same Environment Tested/Target Promotion Environment ordering rule as
    # routers/qa_requests.py::create_request/edit_request and
    # routers/functional.py::update_functional -- reuses the same shared
    # validate_environment_promotion helper rather than a duplicate check.
    # The frontend's own two selects already only offer valid combinations,
    # this is the defense-in-depth backstop before a direct API call.
    try:
        validate_environment_promotion(data.get("environment_tested"), data.get("target_promotion_environment"))
    except ValueError as e:
        raise HTTPException(400, str(e))
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
    a QA Lead/Executive  return; a QA Lead can additionally edit it
    directly while it's sitting at their approval checkpoint rather than
    returning it first just to fix something minor. Executive 
    gets no edit window; their only actions are Approve/Return/Reject."""
    obj = _get_or_404(db, signoff_id)
    is_own = obj.requester_id == current_user.id
    is_admin = current_user.has_role(Role.ADMIN)
    # Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on every QA-Lead-
    # gated action, same as ADMIN -- see ORACLE_MIGRATION_2026-07.md
    # section 59.
    is_qa_lead = current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)

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
    # Same shared-method ordering check as create_signoff -- only actually
    # re-validated when the client sent at least one of the two fields
    # (exclude_unset=True-aware, same pattern as qa_requests.py::edit_request),
    # falling back to obj's own current value for whichever field wasn't sent.
    if "environment_tested" in data or "target_promotion_environment" in data:
        final_environment_tested = data.get("environment_tested", obj.environment_tested)
        final_target = data.get("target_promotion_environment", obj.target_promotion_environment)
        try:
            validate_environment_promotion(final_environment_tested, final_target)
        except ValueError as e:
            raise HTTPException(400, str(e))
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
    _validate_rich_text_before_progress(obj)
    obj.status = "SUBMITTED"
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "QA Lead Approval", current_user, "Pending", "Awaiting QA Lead decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/resubmit", response_model=schemas.SignOffOut)
def resubmit_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Re-submits a certificate returned by QA Lead or Executive  -- or
    reopens one rejected by QA Lead (SM_REJECTED; see SIGNOFF_STATUS_LABELS
    -- this checkpoint is labeled "QA Lead" here even though it reuses the
    SM_* status names). Reported directly: a Rejected-by-QA-Lead certificate
    used to be a dead end; it's now reopenable the same way a Return is:
    edit details, then call this to send it straight back to
    SM_APPROVAL_PENDING for a fresh decision. A return from Executive 
    goes straight back to their own queue (QA Lead already approved it
    once) -- the direct return goes back to Executive  rather than
    repeating QA Lead approval."""
    obj = _get_or_404(db, signoff_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this certificate")
    _require(obj, ["RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPT_HEAD_COE"], "Resubmit")
    _validate_rich_text_before_progress(obj)
    if obj.status in ("RETURNED_BY_SM", "SM_REJECTED"):
        reopening = obj.status == "SM_REJECTED"
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "QA Lead Approval", current_user,
             "Reopened" if reopening else "Resubmitted",
             "Rejected certificate reopened and re-submitted" if reopening else "Returned certificate re-submitted")
    else:
        obj.status = "DEPT_HEAD_QA_APPROVAL_PENDING"
        _log(db, obj.id, "Executive Approval", current_user, "Resubmitted", "Returned certificate re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/qa-lead-decision", response_model=schemas.SignOffOut)
def qa_lead_decision(signoff_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                     current_user: models.User = Depends(
                         require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """QA Lead approval checkpoint before Executive  final approval."""
    obj = _get_or_404(db, signoff_id)
    _require_qa_department(current_user)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, "SM_APPROVAL_PENDING", "QA Lead decision")
    if payload.decision == "Approved":
        _validate_rich_text_before_progress(obj)
        obj.status = "DEPT_HEAD_QA_APPROVAL_PENDING"
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
                           current_user: models.User = Depends(require_roles(
                               Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    # 2026-08 -- this is now the "Executive Group" any-active-member
    # checkpoint: any active Chief Manager QA or AGM QA holds identical
    # authority here and either one's action completes this stage (reported
    # directly -- see constants.py::Role's own comment on the
    # CHIEF_MANAGER_QA/AGM_QA consolidation). Previously 3 roles
    # (CHEIF_MANAGER_COE/CHEIF_MANAGER_QA/AGM_COE) with the COE variants
    # retired; existing UserRole rows were migrated by the one-time
    # role-consolidation data-fix script.
    """Final COE - Quality Assurance approval by Executive  (the QA Executive Group); approval issues the certificate."""
    obj = _get_or_404(db, signoff_id)
    _require_qa_department(current_user)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, "DEPT_HEAD_QA_APPROVAL_PENDING", "Executive  decision")
    # Maker-checker separation across the two approval stages. A Chief
    # Manager/AGM may be eligible for both role groups, but once that person
    # records the QA Lead decision they cannot sign the final Executive
    # decision on the same certificate. Admin retains its explicit oversight
    # bypass, consistent with the other sign-off permission checks.
    if obj.reviewed_by_id == current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(
            403,
            "Final Executive approval must be completed by a different approver; "
            "your QA Lead approval is already recorded on this certificate.",
        )
    if payload.decision == "Approved":
        _validate_rich_text_before_progress(obj)
        obj.status = "ISSUED"
        obj.approved_by_id = current_user.id
        _sync_linked_functional_request(db, obj, current_user)
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPT_HEAD_COE"
    elif payload.decision == "Rejected":
        obj.status = "DEPT_HEAD_COE_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Executive Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{signoff_id}/history", response_model=List[schemas.ApprovalActionOut])
def signoff_history(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_visible_or_404(db, signoff_id, current_user)
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SIGNOFF", entity_id=signoff_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{signoff_id}/export")
def export_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this QA Sign-off Certificate, plus who requested,
    reviewed and approved it and when, as one downloadable PDF -- the
    offline/printable copy of the certificate itself."""
    obj = _get_visible_or_404(db, signoff_id, current_user)

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
            ("Request Department", obj.request_department),
            ("QA Approval Department", obj.department),
            ("Testing Request ID", obj.testing_request_id),
            ("CR Number/EPIC Number", obj.change_request_ids),
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
            ("Exit Criteria Notes", RichTextValue(obj.exit_criteria_notes or "")),
            ("Open Defect Summary", RichTextValue(obj.open_defect_summary or "")),
            ("Residual Risk Notes", RichTextValue(obj.residual_risk_notes or "")),
        ]),
        # Mandatory on a fully-Issued certificate -- one name per approval
        # stage of the QA Team -> QA Lead -> Executive  chain.
        ("Requested / Reviewed / Approved", [
            ("Requested By (QA Team)", uname(obj.requester_id)),
            ("Approved By (QA Lead)", uname(obj.reviewed_by_id)),
            ("Approved By (Executive)", uname(obj.approved_by_id)),
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="SIGNOFF", entity_id=signoff_id)
                     .order_by(models.ApprovalAction.created_at).all())
    signatures = [
        signature for row in history_rows
        if (signature := parse_electronic_signature(row.comments, stage=row.step_name or "Approval"))
    ]
    if signatures:
        sections.append(("Electronic Signatures", [
            (f"{signature.stage} - Signature {index}", signature)
            for index, signature in enumerate(signatures, start=1)
        ]))
    history = []
    for h in history_rows:
        history.append((h.step_name or "—", h.decision or "—", uname(h.actor_id) or "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.certificate_id} — {obj.application_name}",
        subtitle="QA Sign-off Certificate — Full Detail Export",
        sections=sections, history=history,
        history_title=None,
        generated_by=current_user.full_name,
        generated_at=models.now().strftime("%Y-%m-%d %H:%M IST"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.certificate_id}.pdf"'},
    )


def _can_upload_documents(db: Session, obj: "models.QASignOff", user: models.User) -> bool:
    """Reported directly: "uploading document should be non editable if not
    assigned, or in other person's bucket. only the assigned person can
    update" -- the original requester used to always pass here regardless of
    status, so once the certificate moved on to QA Lead/Executive , the
    requester could still upload/remove documents alongside whoever it
    actually currently sat with. Reworked to be exclusive, matching
    update_signoff's own editable-status window above: the requester only
    while the certificate is genuinely in their own hands (Draft or
    Returned-by-*/Rejected -- see SIGNOFF_EDITABLE_STATUSES), and exclusively
    whichever single actor the certificate's *current* status is actually
    sitting with otherwise -- QA Lead during QA Lead approval (legacy status
    SM_APPROVAL_PENDING) or Executive  during final approval. Admin always
    bypasses, same convention as every other permission check."""
    if user.has_role(Role.ADMIN):
        return True
    status = obj.status
    if status in ("DRAFT", "SUBMITTED", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPT_HEAD_COE"):
        return obj.requester_id == user.id
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA) and user.has_department(QA_DEPARTMENT)
    if status == "DEPT_HEAD_QA_APPROVAL_PENDING":
        return obj.reviewed_by_id != user.id and user.has_role(
            Role.CHIEF_MANAGER_QA, Role.AGM_QA,
        ) and user.has_department(QA_DEPARTMENT)
    return False


# ---- Supporting documents (multiple files, uploaded any time after the
# certificate has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_signoff_documents(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_visible_or_404(db, signoff_id, current_user)
    return doc_store.list_documents(db, "SIGNOFF", signoff_id)


@router.post("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_signoff_documents(signoff_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                              current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, signoff_id)
    if not _can_upload_documents(db, obj, current_user):
        raise HTTPException(403, "Only the QA requester, QA Lead, or Executive  currently reviewing this certificate can upload documents")
    return doc_store.save_documents(db, "SIGNOFF", signoff_id, obj.certificate_id, files, current_user.id,
                                     log_entity_type="SIGNOFF", log_entity_id=obj.id, log_actor=current_user)


@router.get("/{signoff_id}/documents/{doc_id}/download")
def download_signoff_document(signoff_id: int, doc_id: int, db: Session = Depends(get_db),
                               current_user: models.User = Depends(get_current_user)):
    _get_visible_or_404(db, signoff_id, current_user)
    doc = doc_store.get_document_or_404(db, "SIGNOFF", signoff_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/{signoff_id}/documents/{doc_id}")
def delete_signoff_document(signoff_id: int, doc_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, signoff_id)
    doc = doc_store.get_document_or_404(db, "SIGNOFF", signoff_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(db, obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="SIGNOFF", log_entity_id=signoff_id, log_actor=current_user)
    return {"ok": True}
