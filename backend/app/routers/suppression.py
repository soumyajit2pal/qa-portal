import os
from typing import List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session, selectinload, joinedload

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department, require_not_requester, dashboard_department_scope
from ..constants import Role, SAST_DAST_PRE_SCANNING_STATUSES, SAST_DAST_COMPLETED_STATUSES, SUPPRESSION_TERMINAL_STATUSES
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
    return linked, kind


def _require_no_existing_pending_suppression(db: Session, linked, kind: str, exclude_id: int = None) -> None:
    """Reported directly: "if pending supression request there, then dont
    allow to create new suppression request." One suppression decision
    against a given SAST/DAST request at a time -- current rule (see the two
    follow-ups below): block a new one unless every existing suppression
    against this linked request is Rejected. `exclude_id` lets
    update_suppression re-check a re-linked request without the suppression
    being edited blocking itself.

    Reported directly (follow-up bug): "Supression request is now rejected,
    but still user not able to create supression request." This originally
    checked `status != "Done"`, which -- unlike _pending_suppression_ids in
    sast_dast.py, where treating Rejected as still-blocking is correct per
    FR-06's literal rule text -- wrongly treated Rejected as still "pending"
    here too, permanently locking a requester out of ever raising another
    suppression once one got rejected. Rejected is terminal for THIS check:
    the natural next step after a rejection is either remediate the finding
    or raise a fresh, better-justified suppression, not a dead end.

    Reported directly (follow-up, reversed for Done specifically): "for same
    sast request, even though supression request is present and mark
    completed, again asking for new supression request and relink." Treating
    Done the same as Rejected here let a requester raise a SECOND suppression
    against a request that already had an APPROVED one -- but per the
    requirement doc's Section 4, once Approved the next step is reassigning
    to the analyst (Mark Fixed), not another suppression. So Done blocks a
    new suppression here (same as a still-pending one), while Rejected still
    doesn't -- the frontend's canInitiateSuppression mirrors this exactly
    (hasOpenSuppression OR hasDoneSuppression both disable Initiate/Link)."""
    sup_col = models.SuppressionRequest.sast_request_id if kind == "SAST" else models.SuppressionRequest.dast_request_id
    q = db.query(models.SuppressionRequest).filter(
        sup_col == linked.id, models.SuppressionRequest.status != "Rejected",
    )
    if exclude_id is not None:
        q = q.filter(models.SuppressionRequest.id != exclude_id)
    existing = q.first()
    if existing:
        raise HTTPException(
            400,
            f"A suppression request ({existing.suppression_id}) already exists against this {kind} request "
            f"({'pending decision' if existing.status != 'Done' else 'already approved'}) -- "
            + ("it must be resolved (marked Done) before another can be raised."
               if existing.status != "Done"
               else "reassign the request to the Security Analyst (Mark Fixed) instead of raising another one."),
        )


def _require_requester_of_linked(linked, current_user: models.User) -> None:
    """Reported directly: "suppression requests CAN ONLY be raised by
    requester, so this should be enable for requester, not QA team." Until
    now create_suppression had no permission check at all beyond being
    logged in -- any authenticated user, including a Security Analyst/QA
    team member with no relationship to the request, could raise a
    suppression against someone else's SAST/DAST request. Restricted to the
    linked request's own requester (or Admin, same bypass convention as
    every other check in this file).

    Reported directly (follow-up): "requester delegated, to qa ... Full
    stand-in for requester" briefly extended this to the linked SAST/DAST
    request's active Delegate for Input too, matching Mark Fixed's own
    delegate stand-in.

    Reported directly (reversed, immediately after seeing it in practice):
    "INITIATE SUPPRESSION REQUEST SHOULD BE FROM REQUESTER SIDE, NOT QA
    SIDE" -- the concrete case was a requester who'd delegated a
    WAITING_FOR_FIX request to a Security Analyst (a completely normal,
    intended use of "full stand-in"), and that analyst could then raise a
    suppression against their own team's finding, which defeats the point
    of suppression being the requester's own exception request. Suppression
    is now carved OUT of delegate stand-in entirely -- it's the one
    requester-side action that ALWAYS stays with the literal original
    requester (or Admin), regardless of whether the linked request currently
    has an active delegation. Since the delegate can no longer act here at
    all, the original requester is correspondingly no longer blocked while
    delegated out (there'd be nobody left who could raise a suppression
    otherwise) -- every OTHER requester-side action (Mark Fixed, etc.) is
    unaffected and stays exclusively the delegate's during an active
    delegation, per sast_dast.py's _mark_fixed and the frontend's
    requesterInputEditor."""
    if current_user.has_role(Role.ADMIN):
        return
    if linked.requester_id != current_user.id:
        raise HTTPException(
            403,
            "Only the requester of the linked SAST/DAST request (or an admin) can raise a suppression "
            "request against it -- this is not delegable, even while the request has an active "
            "Delegate for Input assigned.",
        )


@router.get("", response_model=List[schemas.SuppressionOut])
def list_suppressions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Reported directly, then extended to "everywhere" (see list_requests'
    # matching comment in routers/qa_requests.py) -- applied unconditionally.
    # SuppressionRequest.department is a real column (auto-populated at
    # creation time, see its own column comment in models.py), so this is a
    # plain filter, no join needed.
    # Perf tuning (2026-08, reported directly: "some of the apis are taking
    # lot of timing") -- SuppressionOut.items (one-to-many) and
    # .linked_request (resolved from sast_request/dast_request, both
    # many-to-one) were all previously lazy-loaded per row -- up to 3 extra
    # SELECTs per suppression. selectinload for the collection (avoids a
    # join-driven row explosion), joinedload for the two many-to-one FKs.
    q = db.query(models.SuppressionRequest).options(
        selectinload(models.SuppressionRequest.items),
        joinedload(models.SuppressionRequest.sast_request),
        joinedload(models.SuppressionRequest.dast_request),
    )
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.filter(models.SuppressionRequest.department.in_(scope))
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
    linked, kind = _require_linked_request(db, data)
    _require_requester_of_linked(linked, current_user)
    _require_no_existing_pending_suppression(db, linked, kind)
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
    linked, kind = _require_linked_request(db, data)
    # Re-checked here too, not just in create_suppression -- an edit can
    # re-point sast_request_id/dast_request_id at a different request
    # entirely, so the *new* link's requester must still be this same
    # requester (obj.created_by_id, already verified above), otherwise a
    # requester could quietly relink their own Draft suppression onto
    # someone else's SAST/DAST request.
    _require_requester_of_linked(linked, current_user)
    # Same re-link case as above -- exclude_id=obj.id so this suppression
    # (which is itself still pending) doesn't block its own edit; only a
    # DIFFERENT already-pending suppression against the (possibly new)
    # linked request should.
    _require_no_existing_pending_suppression(db, linked, kind, exclude_id=obj.id)
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


@router.post("/{sup_id}/relink", response_model=schemas.SuppressionOut)
def relink_suppression(sup_id: int, payload: schemas.SuppressionRelinkIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Reported directly: "give option to link and delink supression request
    from sast request and supression both." Unlike update_suppression above
    (full-form edit, Draft only), relinking -- pointing this suppression at
    a *different* SAST/DAST request -- is allowed any time the suppression
    itself hasn't reached a terminal outcome yet (SUPPRESSION_TERMINAL_
    STATUSES: Done or Rejected), not just while still Draft. A suppression
    must always be linked to exactly one SAST/DAST request (no "unlinked"
    state) -- "delink" means pointing it at a different one via this same
    endpoint, not clearing the link entirely."""
    obj = db.query(models.SuppressionRequest).get(sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can relink this request")
    if obj.status in SUPPRESSION_TERMINAL_STATUSES:
        raise HTTPException(400, f"Cannot relink a suppression request that has already reached '{obj.status}'")
    data = payload.model_dump()
    linked, kind = _require_linked_request(db, data)
    _require_requester_of_linked(linked, current_user)
    _require_no_existing_pending_suppression(db, linked, kind, exclude_id=obj.id)
    obj.sast_request_id = data.get("sast_request_id")
    obj.dast_request_id = data.get("dast_request_id")
    obj.scan_type = kind
    # Re-derive the application identity fields from the newly linked
    # request, same as the New Suppression form's own auto-populate --
    # keeps them consistent with the new link rather than stale from the old
    # one.
    obj.application_name = linked.application_name
    obj.department = linked.department
    obj.application_owner = linked.application_owner
    _log(db, obj.id, "Requester", current_user, "Relinked", f"Relinked to {kind} request {linked.request_id}")
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
    obj.sm_decided_at = models.now()
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
    obj.dept_head_decided_at = models.now()
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
    obj.security_decided_at = models.now()
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
        generated_at=models.now().strftime("%Y-%m-%d %H:%M IST"),
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
        return user.has_role(Role.SM) and user.has_department(obj.department)
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.has_department(obj.department)
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

