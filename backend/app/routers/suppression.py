import datetime
import os
from typing import List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department, require_not_requester, dashboard_department_scope
from ..constants import Role, SAST_DAST_PRE_SCANNING_STATUSES, SAST_DAST_COMPLETED_STATUSES
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

router = APIRouter(prefix="/api/suppressions", tags=["suppression"])

# ---------------------------------------------------------------------------
# Suppression request lifecycle (Application Owner step removed entirely):
#
#   Requester raises the request with all details -> Draft -> submit ->
#   SM_APPROVAL_PENDING -> sm-decision (SM assigns to Department Head) ->
#   DEPARTMENT_HEAD_APPROVAL_PENDING -> department-head-decision ->
#   SECURITY_TEAM_VERIFICATION -> security-team-decision (Accept -> Done,
#   Reject -> Rejected). A SAST/DAST request can only be marked Report Ready
#   once every Suppression request raised against it is "Done" -- enforced in
#   routers/sast_dast.py's _mark_report_ready.
# ---------------------------------------------------------------------------


def _log(db, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type="SUPPRESSION", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected, action: str):
    if isinstance(expected, str):
        expected = [expected]
    if obj.status not in expected:
        raise HTTPException(400, f"'{action}' requires status in {expected} (currently '{obj.status}')")


def _require_linked_request(db: Session, data: dict):
    """Every field on the New/Edit Suppression form is now mandatory --
    including the SAST/DAST Request ID link itself (previously optional,
    allowing a "standalone" finding with no linked scan). Enforced here
    rather than in schemas.py to match this router's existing validation
    style (see the decision-endpoint checks above/below).

    Reported directly: also reject a link to a SAST/DAST request that
    hasn't reached Scanning yet -- a suppression is a decision about a
    *finding*, and nothing exists to suppress before a scan has actually
    started (Draft through Scan Configuration -- see
    constants.SAST_DAST_PRE_SCANNING_STATUSES). Mirrors the frontend's own
    dropdown filter in Suppression.tsx, which hides those requests from the
    picker entirely -- this is the server-side backstop in case the client
    submits a stale/hand-crafted id anyway.

    Reported directly (follow-up): also reject a link to a SAST/DAST request
    that has already reached Security Complete or later (see
    constants.SAST_DAST_COMPLETED_STATUSES) -- once a request is declared
    Security Complete it's finalized, so a new suppression can no longer be
    raised against it either. Combined with the Scanning-or-later check
    above, this narrows the eligible window to Scanning through the stage
    right before Security Complete."""
    if bool(data.get("sast_request_id")) == bool(data.get("dast_request_id")):
        raise HTTPException(400, "Exactly one of SAST or DAST Request ID must be selected")
    if data.get("sast_request_id"):
        linked = db.query(models.SASTRequest).get(data["sast_request_id"])
        kind = "SAST"
    else:
        linked = db.query(models.DASTRequest).get(data["dast_request_id"])
        kind = "DAST"
    if not linked:
        raise HTTPException(400, f"Linked {kind} request not found")
    if linked.status in SAST_DAST_PRE_SCANNING_STATUSES:
        raise HTTPException(
            400,
            f"The linked {kind} request hasn't reached Scanning yet (currently "
            f"'{linked.status}') -- a suppression can only be raised once scanning has started.",
        )
    if linked.status in SAST_DAST_COMPLETED_STATUSES:
        raise HTTPException(
            400,
            f"The linked {kind} request has already reached '{linked.status}' -- a suppression can no "
            f"longer be raised against it once the security review is complete.",
        )


@router.get("", response_model=List[schemas.SuppressionOut])
def list_suppressions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Reported directly, then extended to "everywhere" (see list_requests'
    # matching comment in routers/qa_requests.py) -- applied unconditionally.
    # SuppressionRequest.department is a real column (auto-populated at
    # creation time, see its own column comment in models.py), so this is a
    # plain filter, no join needed.
    q = db.query(models.SuppressionRequest)
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.filter(models.SuppressionRequest.department == scope)
    return q.order_by(models.SuppressionRequest.created_at.desc()).all()


@router.post("", response_model=schemas.SuppressionOut)
def create_suppression(payload: schemas.SuppressionCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Requester raises the suppression request with all details -- starts life
    as a Draft (see models.SuppressionRequest.status default) until explicitly
    submitted below. A single scan often has multiple findings, so this
    covers a list of them (payload.items) under one suppression request
    rather than requiring a separate request per finding."""
    data = payload.model_dump()
    items_data = data.pop("items")
    if not items_data:
        raise HTTPException(400, "At least one finding/issue is required")
    _require_linked_request(db, data)
    obj = models.SuppressionRequest(**data, created_by_id=current_user.id, status="Draft")
    obj.items = [models.SuppressionItem(**item) for item in items_data]
    db.add(obj)
    db.flush()
    _log(db, obj.id, "Requester", current_user, "Drafted")
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{sup_id}", response_model=schemas.SuppressionOut)
def get_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    return obj


@router.put("/{sup_id}", response_model=schemas.SuppressionOut)
def update_suppression(sup_id: int, payload: schemas.SuppressionCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can edit this request")
    if obj.status != "Draft":
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump()
    items_data = data.pop("items", None)
    _require_linked_request(db, data)
    for k, v in data.items():
        setattr(obj, k, v)
    if items_data is not None:
        for item in list(obj.items):
            db.delete(item)
        db.flush()
        obj.items = [models.SuppressionItem(**item) for item in items_data]
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/submit", response_model=schemas.SuppressionOut)
def submit_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "Draft", "Submit")
    # Mirrors routers/functional.py::submit_request -- logs the requester's
    # own "Submitted" step before immediately moving on to SM Approval, same
    # fix as SAST/DAST/Performance so every request type's History
    # tab reads the same way. Unlike those, Suppression has no intermediate
    # "SUBMITTED" value in SUPPRESSION_STATUSES, so obj.status goes straight
    # to SM_APPROVAL_PENDING -- only the history log itself gains the extra row.
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "SM Approval", current_user, "Submitted", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/resubmit", response_model=schemas.SuppressionOut)
def resubmit_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_TEAM"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_DEPARTMENT_HEAD":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    else:
        obj.status = "SECURITY_TEAM_VERIFICATION"
        _log(db, obj.id, "Security Team Verification", current_user, "Resubmitted", "Returned request re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/sm-decision", response_model=schemas.SuppressionOut)
def sm_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                current_user: models.User = Depends(require_roles(Role.SM))):
    """SM assigns the request on to the Department Head (Approve), sends it
    back to the requester (Return), or rejects it outright."""
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.created_by_id)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    obj.sm_decision = payload.decision
    obj.sm_id = current_user.id
    obj.sm_decided_at = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    if payload.decision == "Approved":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "Rejected"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/dept-head-decision", response_model=schemas.SuppressionOut)
def dept_head_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM))):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.created_by_id)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    obj.dept_head_decision = payload.decision
    obj.dept_head_id = current_user.id
    obj.dept_head_decided_at = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    if payload.decision == "Approved":
        obj.status = "SECURITY_TEAM_VERIFICATION"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
    elif payload.decision == "Rejected":
        obj.status = "Rejected"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/security-team-decision", response_model=schemas.SuppressionOut)
def security_team_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    """Security Team verifies the suppression is legitimate and accepts (Done
    -- unblocks the linked SAST/DAST request's mark-report-ready), rejects it
    outright (terminal), or returns it to the requester if something needs
    fixing first -- e.g. missing justification or evidence -- choosing (via
    require_dept_head_reapproval) whether the fix needs a fresh Department
    Head approval or can come straight back to Security Team Verification."""
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require(obj, "SECURITY_TEAM_VERIFICATION", "Security team decision")
    decision = payload.decision
    if decision not in ("Accepted", "Approved", "Rejected", "Returned"):
        raise HTTPException(400, "decision must be one of: Accepted, Rejected, Returned")
    obj.security_decision = decision
    obj.security_id = current_user.id
    obj.security_decided_at = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    if decision in ("Accepted", "Approved"):
        obj.status = "Done"
    elif decision == "Rejected":
        obj.status = "Rejected"
    else:
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD" if payload.require_dept_head_reapproval else "RETURNED_BY_SECURITY_TEAM"
    _log(db, obj.id, "Security Team Verification", current_user, decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{sup_id}/history", response_model=List[schemas.ApprovalActionOut])
def suppression_history(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SUPPRESSION", entity_id=sup_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{sup_id}/export")
def export_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this Suppression / False Positive request, every
    finding it covers, and its full approval/workflow history -- who
    submitted, decided (SM/Department Head/Security Team), etc., and when --
    as one downloadable PDF."""
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")

    def uname(uid):
        if not uid:
            return None
        u = db.query(models.User).get(uid)
        return u.full_name if u else None

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Scan Type", obj.scan_type),
            ("Linked Request", (obj.sast_request.request_id if obj.sast_request else None)
                                or (obj.dast_request.request_id if obj.dast_request else None)),
        ]),
        ("Application", [
            ("Application Name", obj.application_name),
            ("Department", obj.department),
            ("Application Owner", obj.application_owner),
        ]),
        ("Decisions", [
            ("SM Decision", f"{obj.sm_decision or 'Pending'} — {uname(obj.sm_id) or '—'}"),
            ("Department Head Decision", f"{obj.dept_head_decision or 'Pending'} — {uname(obj.dept_head_id) or '—'}"),
            ("Security Team Decision", f"{obj.security_decision or 'Pending'} — {uname(obj.security_id) or '—'}"),
        ]),
        ("Risk Assessment", [
            ("Risk Assessment", obj.risk_assessment),
        ]),
        ("Findings Covered", [
            (i.issue_id or f"Finding {i.id}", f"{i.severity} | {i.description or ''} | Justification: {i.justification or ''}")
            for i in obj.items
        ]),
        ("Requester", [
            ("Requester", uname(obj.created_by_id)),
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="SUPPRESSION", entity_id=sup_id)
                     .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in history_rows:
        history.append((h.step_name or "—", h.decision or "—", uname(h.actor_id) or "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.suppression_id} — {obj.application_name}",
        subtitle="Suppression / False Positive Request — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.suppression_id}.pdf"'},
    )


def _can_upload_documents(obj: "models.SuppressionRequest", user: models.User) -> bool:
    """Reported directly (Document and Evidence Access Control Based on
    Workflow Stage): access follows exactly 3 stages, then locks hard --
    (1) the requester, while the request is genuinely in their own hands
    (Draft or Returned-by-*) may upload any number of files; (2) the SM,
    and only the SM, may upload while SM_APPROVAL_PENDING; (3) the
    Department Head, and only the Department Head, may upload while
    DEPARTMENT_HEAD_APPROVAL_PENDING. After Department Head approval, EVERY
    status is locked -- including SECURITY_TEAM_VERIFICATION, previously a
    Security-Analyst upload window -- no Security Analyst may upload here
    until the request is returned to the requester (a RETURNED_BY_*
    status), which re-opens stage (1). Admin always bypasses, same
    convention as every other permission check in this file."""
    if user.has_role(Role.ADMIN):
        return True
    status = obj.status
    if status in ("Draft", "RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_TEAM"):
        return obj.created_by_id == user.id
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.SM) and user.department == obj.department
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.department == obj.department
    # SECURITY_TEAM_VERIFICATION/Done/Rejected -- locked for everyone but
    # Admin until the request is returned to the requester above.
    return False


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{sup_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_suppression_documents(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "SUPPRESSION", sup_id)


@router.post("/{sup_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_suppression_documents(sup_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester or this request's current stage owner (Security Team, or the SM/Department Head currently reviewing it) can upload documents")
    return doc_store.save_documents(db, "SUPPRESSION", sup_id, obj.suppression_id, files, current_user.id,
                                     log_entity_type="SUPPRESSION", log_entity_id=obj.id, log_actor=current_user)


@router.get("/{sup_id}/documents/{doc_id}/download")
def download_suppression_document(sup_id: int, doc_id: int, db: Session = Depends(get_db),
                                   current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "SUPPRESSION", sup_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/{sup_id}/documents/{doc_id}")
def delete_suppression_document(sup_id: int, doc_id: int, db: Session = Depends(get_db),
                                 current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    doc = doc_store.get_document_or_404(db, "SUPPRESSION", sup_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="SUPPRESSION", log_entity_id=sup_id, log_actor=current_user)
    return {"ok": True}


# ---- Walkthrough sessions ----
# Own dedicated table (SuppressionWalkthrough), mirroring Functional's
# WalkthroughSession -- see routers/functional.py for the same pattern.
# Suppression has no readiness-checklist concept, so it only gets
# Walkthroughs + History tabs on its detail page, not a Checklist tab.
@router.get("/{sup_id}/walkthroughs", response_model=List[schemas.WalkthroughOut])
def list_walkthroughs(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SuppressionWalkthrough).filter_by(suppression_request_id=sup_id).all()


@router.post("/{sup_id}/walkthroughs", response_model=schemas.WalkthroughOut)
def add_walkthrough(sup_id: int, payload: schemas.WalkthroughCreate, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(
                         Role.BUSINESS_ANALYST, Role.REQUESTER, Role.QA_ENGINEER, Role.QA_LEAD,
                         Role.SECURITY_ANALYST))):
    if not db.query(models.SuppressionRequest).get(sup_id):
        raise HTTPException(404, "Suppression request not found")
    obj = models.SuppressionWalkthrough(suppression_request_id=sup_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/walkthroughs/{wt_id}/acknowledge", response_model=schemas.WalkthroughOut)
def acknowledge_walkthrough(sup_id: int, wt_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(
                                 Role.SECURITY_ANALYST, Role.QA_LEAD))):
    obj = db.query(models.SuppressionWalkthrough).filter_by(id=wt_id, suppression_request_id=sup_id).first()
    if not obj:
        raise HTTPException(404, "Walkthrough session not found")
    obj.qa_acknowledged_by_id = current_user.id
    obj.qa_acknowledged_at = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    db.commit()
    db.refresh(obj)
    return obj
