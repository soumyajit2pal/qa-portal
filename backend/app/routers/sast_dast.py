import datetime
import os
from typing import List, Optional, Tuple
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import Role, SAST_DAST_EDITABLE_STATUSES
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

router = APIRouter(tags=["sast-dast"])


def _uname(db: Session, uid: Optional[int]) -> Optional[str]:
    if not uid:
        return None
    u = db.query(models.User).get(uid)
    return u.full_name if u else None


def _sast_dast_history(db: Session, req_id: int) -> Tuple[list, Optional[str]]:
    """SAST and DAST share one entity_type ("SAST_DAST") in the generic
    qap_approval_actions audit log, keyed only by entity_id -- but SASTRequest
    and DASTRequest each have their own independent id sequence (see
    models.pk_column), so a SAST request and a DAST request can end up with
    the same numeric id. Rather than risk showing one module's signer history
    on the other's export, this checks for that collision first and returns
    an explanatory note instead of the (possibly mixed-up) rows whenever both
    a SAST and a DAST request currently share this exact id."""
    sast_has = db.query(models.SASTRequest.id).filter_by(id=req_id).first() is not None
    dast_has = db.query(models.DASTRequest.id).filter_by(id=req_id).first() is not None
    if sast_has and dast_has:
        return [], ("Workflow history for this ID is shared between a SAST and a DAST request with the same "
                     "numeric ID and can't be reliably separated here -- see the Approval Workflow Log page for "
                     "the full combined audit trail.")
    rows = (db.query(models.ApprovalAction)
            .filter_by(entity_type="SAST_DAST", entity_id=req_id)
            .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in rows:
        history.append((h.step_name or "—", h.decision or "—", _uname(db, h.actor_id) or "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))
    return history, None


def _sast_dast_history_rows(db: Session, req_id: int) -> List["models.ApprovalAction"]:
    """Same collision guard as _sast_dast_history() above, but returns the raw
    ApprovalAction ORM rows (for the GET .../history endpoint / History tab,
    which renders them itself and resolves actor names client-side) instead
    of pre-formatted tuples (for the PDF exporter). On a collision, returns
    an empty list rather than risk silently mixing the two modules' rows --
    same safe-default choice the PDF export already makes."""
    sast_has = db.query(models.SASTRequest.id).filter_by(id=req_id).first() is not None
    dast_has = db.query(models.DASTRequest.id).filter_by(id=req_id).first() is not None
    if sast_has and dast_has:
        return []
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SAST_DAST", entity_id=req_id)
            .order_by(models.ApprovalAction.created_at).all())

# These identify *which* request this actually is -- changing them once the
# request exists is an Admin-only action (see update_sast below; DAST has no
# editable equivalent of these -- application_name/project_name/cr_number are
# delegated read-only from the gateway there, so there's nothing to guard).
# A submitted value equal to the current one is let through for anyone --
# that's not actually a change, just the form resubmitting a field it also
# displays.
_ADMIN_ONLY_FIELDS = {"application_name", "project_name", "cr_number"}

# ---------------------------------------------------------------------------
# Independent SAST/DAST lifecycle (identical for both -- see the long comment
# above SAST_DAST_STATUSES in constants.py):
#
#   Draft -> Submit -> SM Approval -> Department Head Approval (also assigns
#   a Security Lead) -> Security Readiness (passed by the assigned Security
#   Lead or a QA Lead) -> Planning -> Configuration -> Scanning -> Complete
#   Scan -> Finding Validation -> [no findings need remediation ->] Security
#   Complete, or [findings need remediation ->] Remediation -> Assigned To
#   Requester -> Waiting For Fix -> (requester marks fixed) -> Assigned To
#   Lead -> Rescan -> Rescan Decision (Passed -> Security Complete / Failed ->
#   back to Scanning) -> Report Ready (gated on any linked Suppression
#   request being "Done").
#
# Implemented once as generic helpers parameterized by model instance (a
# models.SASTRequest or models.DASTRequest row), with a thin pair of route
# functions per step so SAST and DAST keep separate URLs but never drift out
# of sync with each other.
# ---------------------------------------------------------------------------


def _log(db, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type="SAST_DAST", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected, action: str):
    if isinstance(expected, str):
        expected = [expected]
    if obj.status not in expected:
        raise HTTPException(400, f"'{action}' requires status in {expected} (currently '{obj.status}')")


def _findings_summary(findings) -> list:
    """Export-friendly summary of a SAST/DAST request's findings -- just a
    count per severity level plus an Open/Total split, not the full
    issue-by-issue detail (issue_id/description) shown on the Findings tab
    itself. Keeps the PDF export short and skimmable rather than dumping
    every finding's full text into a printed document."""
    if not findings:
        return [("Findings", "None logged")]
    by_severity: dict = {}
    open_count = 0
    for f in findings:
        sev = f.severity or "Unspecified"
        by_severity[sev] = by_severity.get(sev, 0) + 1
        if f.status == "Open":
            open_count += 1
    rows = [(sev, str(count)) for sev, count in sorted(by_severity.items())]
    rows.append(("Total", f"{len(findings)} ({open_count} Open, {len(findings) - open_count} Resolved)"))
    return rows


def _get_or_404(db: Session, model_cls, req_id: int, label: str):
    obj = db.query(model_cls).get(req_id)
    if not obj:
        raise HTTPException(404, f"{label} request not found")
    return obj


def _submit(db: Session, obj, current_user):
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "DRAFT", "Submit")
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


def _resubmit(db: Session, obj, current_user):
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_DEPARTMENT_HEAD":
        # A genuine direct return from Department Head Approval itself.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_SECURITY_LEAD" and obj.needs_dept_head_reapproval:
        # Security Lead returned it but flagged that the fix needs a fresh
        # Department Head approval before Security Readiness resumes.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted",
             "Returned request re-submitted (Department Head re-approval required)")
    else:
        obj.status = "SECURITY_READINESS"
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Security Readiness", current_user, "Resubmitted", "Returned request re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


def _sm_decision(db: Session, obj, payload, current_user):
    require_same_department(current_user, obj.department)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    if payload.decision == "Approved":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
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


def _department_head_decision(db: Session, obj, payload, current_user):
    """Approving also assigns a Security Lead (a Security Analyst user) who
    owns Security Readiness onward -- mirrors how the QA Request's Department
    Head decision assigns a QA Lead."""
    require_same_department(current_user, obj.department)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    if payload.decision == "Approved":
        if not payload.security_lead_id:
            raise HTTPException(400, "security_lead_id is required when approving (a Security Lead must be assigned)")
        lead = db.query(models.User).get(payload.security_lead_id)
        if not lead or not lead.has_role(Role.SECURITY_ANALYST):
            raise HTTPException(400, "security_lead_id must reference an active Security Analyst user")
        obj.security_lead_id = payload.security_lead_id
        obj.status = "SECURITY_LEAD_ASSIGNED"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
    elif payload.decision == "Rejected":
        obj.status = "DEPARTMENT_HEAD_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _start_readiness(db: Session, obj, current_user):
    _require(obj, "SECURITY_LEAD_ASSIGNED", "Start readiness")
    obj.status = "SECURITY_READINESS"
    _log(db, obj.id, "Security Readiness", current_user, "Started", None)
    db.commit()
    db.refresh(obj)
    return obj


def _readiness_decision(db: Session, obj, payload, current_user):
    _require(obj, "SECURITY_READINESS", "Readiness decision")
    if payload.decision == "Passed":
        obj.status = "PLANNING"
    elif payload.decision == "Failed":
        # The assigned Security Lead chooses, right here, whether this return
        # needs a fresh Department Head approval (routes back through
        # DEPARTMENT_HEAD_APPROVAL_PENDING on resubmit) or can go straight
        # back to them once the requester fixes it (the default -- same
        # Security Lead, no re-approval needed). Status is always
        # RETURNED_BY_SECURITY_LEAD -- the Security Lead is who actually
        # returned it -- never RETURNED_BY_DEPARTMENT_HEAD; the re-approval
        # choice is tracked separately via needs_dept_head_reapproval (see
        # models.SASTRequest/DASTRequest for why).
        obj.status = "RETURNED_BY_SECURITY_LEAD"
        obj.needs_dept_head_reapproval = payload.require_dept_head_reapproval
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Security Readiness", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _start_configuration(db: Session, obj, current_user):
    _require(obj, "PLANNING", "Start configuration")
    obj.status = "CONFIGURATION"
    _log(db, obj.id, "Planning", current_user, "Configuration Started", None)
    db.commit()
    db.refresh(obj)
    return obj


def _start_scan(db: Session, obj, current_user):
    _require(obj, "CONFIGURATION", "Start scan")
    obj.status = "SCANNING"
    _log(db, obj.id, "Configuration", current_user, "Scanning Started", None)
    db.commit()
    db.refresh(obj)
    return obj


def _complete_scan(db: Session, obj, current_user):
    _require(obj, "SCANNING", "Complete scan")
    obj.status = "FINDING_VALIDATION"
    _log(db, obj.id, "Scanning", current_user, "Scan Complete", None)
    db.commit()
    db.refresh(obj)
    return obj


def _validate_findings(db: Session, obj, current_user):
    """Moves from Finding Validation into Remediation if any findings need
    fixing, or straight to Security Complete if the scan came back clean."""
    _require(obj, "FINDING_VALIDATION", "Validate findings")
    open_findings = [f for f in obj.findings if f.status == "Open"]
    if open_findings:
        obj.status = "REMEDIATION"
        _log(db, obj.id, "Finding Validation", current_user, "Findings Confirmed",
             f"{len(open_findings)} finding(s) require remediation")
    else:
        obj.status = "SECURITY_COMPLETE"
        _log(db, obj.id, "Finding Validation", current_user, "No Findings", "Nothing to remediate")
    db.commit()
    db.refresh(obj)
    return obj


def _assign_to_requester(db: Session, obj, current_user):
    """Remediation -> Assigned To Requester -> Waiting For Fix. The
    "Assigned To Requester" hop is logged in the audit trail but not held as
    a resting status (mirrors how QA Request's Submitted/SAST-DAST's own
    Submitted step is transient on the way to the next real checkpoint)."""
    _require(obj, "REMEDIATION", "Assign to requester")
    _log(db, obj.id, "Remediation", current_user, "Assigned To Requester", None)
    obj.status = "WAITING_FOR_FIX"
    _log(db, obj.id, "Waiting For Fix", current_user, "Awaiting Fix", None)
    db.commit()
    db.refresh(obj)
    return obj


def _mark_fixed(db: Session, obj, current_user):
    """Requester (or a security analyst/admin) marks the fix as submitted --
    hands it back to the Security Lead (transient Assigned To Lead) and moves
    straight into Rescan."""
    if obj.requester_id != current_user.id and not current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN):
        raise HTTPException(403, "Only the requester, a security analyst, or an admin can mark this fixed")
    _require(obj, "WAITING_FOR_FIX", "Mark fixed")
    _log(db, obj.id, "Waiting For Fix", current_user, "Fix Submitted", "Assigned to Lead for rescan")
    obj.status = "RESCAN"
    _log(db, obj.id, "Rescan", current_user, "Rescanning", None)
    db.commit()
    db.refresh(obj)
    return obj


def _rescan_decision(db: Session, obj, payload, current_user):
    _require(obj, "RESCAN", "Rescan decision")
    if payload.decision == "Passed":
        obj.status = "SECURITY_COMPLETE"
    elif payload.decision == "Failed":
        # Still more to fix -- back to Scanning so new findings can be logged.
        obj.status = "SCANNING"
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Rescan", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _mark_report_ready(db: Session, obj, current_user, sup_filter_col):
    """Blocked while any Suppression request raised against this SAST/DAST id
    hasn't been marked 'Done' (see constants.SUPPRESSION_STATUSES)."""
    _require(obj, "SECURITY_COMPLETE", "Mark report ready")
    linked_sups = db.query(models.SuppressionRequest).filter(sup_filter_col == obj.id).all()
    not_done = [s.suppression_id for s in linked_sups if s.status != "Done"]
    if not_done:
        raise HTTPException(
            400,
            "Cannot mark Report Ready -- suppression request(s) still pending: "
            + ", ".join(not_done) + ". They must be marked Done first.",
        )
    obj.status = "REPORT_READY"
    _log(db, obj.id, "Security Complete", current_user, "Report Ready", None)
    db.commit()
    db.refresh(obj)
    return obj


def _resolve_finding(db: Session, finding, current_user):
    finding.status = "Fixed"
    db.commit()
    db.refresh(finding)
    return finding


def _add_finding(db: Session, obj, payload, current_user):
    finding_cls = models.SASTFinding if isinstance(obj, models.SASTRequest) else models.DASTFinding
    fk_field = "sast_request_id" if isinstance(obj, models.SASTRequest) else "dast_request_id"
    finding = finding_cls(**{fk_field: obj.id}, **payload.model_dump())
    db.add(finding)
    db.commit()
    db.refresh(finding)
    return finding


# ---------------- Module 4: SAST ----------------
@router.get("/api/sast-requests", response_model=List[schemas.SASTOut])
def list_sast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SASTRequest).order_by(models.SASTRequest.created_at.desc()).all()


# Standalone SAST request creation is DISABLED per request -- SAST requests
# must now originate from a QA Request (include "SAST" in its request types;
# see _sync_linked_child_requests in routers/qa_requests.py, which still
# creates the linked SASTRequest via direct ORM insert, bypassing this
# endpoint entirely, so that auto-linking keeps working).
@router.post("/api/sast-requests", response_model=schemas.SASTOut)
def create_sast(payload: schemas.SASTCreate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    raise HTTPException(
        400,
        "Standalone SAST requests can no longer be raised directly -- include SAST in a QA Request's "
        "request types instead, then fill in the remaining details on the auto-created SAST request.",
    )


@router.put("/api/sast-requests/{req_id}", response_model=schemas.SASTOut)
def update_sast(req_id: int, payload: schemas.SASTUpdate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN):
        raise HTTPException(403, "Only the requester, a security analyst, or an admin can edit this request")
    if obj.status not in SAST_DAST_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump(exclude_unset=True)
    if not current_user.has_role(Role.ADMIN):
        for f in _ADMIN_ONLY_FIELDS:
            if f in data and data[f] != getattr(obj, f):
                raise HTTPException(403, f"Only an Administrator can change {f.replace('_', ' ').title()}")
    # `components` is a relationship, not a plain column -- can't just
    # setattr it with a list of dicts. Simplest correct semantics for a
    # "+"-driven repeatable list: replace the whole set wholesale with
    # whatever the form submitted (SQLAlchemy's delete-orphan cascade on
    # SASTRequest.components cleans up the rows being replaced).
    components = data.pop("components", None)
    for k, v in data.items():
        setattr(obj, k, v)
    if components is not None:
        obj.components = [models.SASTComponent(**c) for c in components]
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/sast-requests/{req_id}/submit", response_model=schemas.SASTOut)
def submit_sast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _submit(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/resubmit", response_model=schemas.SASTOut)
def resubmit_sast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _resubmit(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/sm-decision", response_model=schemas.SASTOut)
def sast_sm_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.SM))):
    return _sm_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/department-head-decision", response_model=schemas.SASTOut)
def sast_department_head_decision(req_id: int, payload: schemas.SecurityDeptHeadDecisionIn, db: Session = Depends(get_db),
                                   current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    return _department_head_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/start-readiness", response_model=schemas.SASTOut)
def sast_start_readiness(req_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST, Role.QA_LEAD))):
    return _start_readiness(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/readiness-decision", response_model=schemas.SASTOut)
def sast_readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.SECURITY_ANALYST))):
    return _readiness_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/start-configuration", response_model=schemas.SASTOut)
def sast_start_configuration(req_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _start_configuration(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/start-scan", response_model=schemas.SASTOut)
def sast_start_scan(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _start_scan(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/complete-scan", response_model=schemas.SASTOut)
def sast_complete_scan(req_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _complete_scan(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/validate-findings", response_model=schemas.SASTOut)
def sast_validate_findings(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _validate_findings(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/assign-to-requester", response_model=schemas.SASTOut)
def sast_assign_to_requester(req_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _assign_to_requester(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/mark-fixed", response_model=schemas.SASTOut)
def sast_mark_fixed(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _mark_fixed(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/rescan-decision", response_model=schemas.SASTOut)
def sast_rescan_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _rescan_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/mark-report-ready", response_model=schemas.SASTOut)
def sast_mark_report_ready(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _mark_report_ready(db, obj, current_user, models.SuppressionRequest.sast_request_id)


@router.post("/api/sast-requests/{req_id}/findings", response_model=schemas.SASTFindingOut)
def add_sast_finding(req_id: int, payload: schemas.SASTFindingIn, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _add_finding(db, obj, payload, current_user)


@router.post("/api/sast-requests/{req_id}/findings/{finding_id}/resolve", response_model=schemas.SASTFindingOut)
def resolve_sast_finding(req_id: int, finding_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    finding = db.query(models.SASTFinding).filter_by(id=finding_id, sast_request_id=req_id).first()
    if not finding:
        raise HTTPException(404, "Finding not found")
    return _resolve_finding(db, finding, current_user)


@router.get("/api/sast-requests/{req_id}/export")
def export_sast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this SAST request (including the ones delegated from
    its parent QA Request gateway), its repository components, its findings,
    and its full approval/workflow history -- who submitted, approved,
    returned, etc., and when -- as one downloadable PDF."""
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Priority", obj.priority),
            ("Risk Category", obj.risk_category),
        ]),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Project", obj.project_name),
            ("CR Number", obj.cr_number),
            ("Department", obj.department),
            ("Application Owner", obj.application_owner),
        ]),
        ("Environment & Hash", [
            ("Deployment Environment", obj.environment),
            ("Target Promotion Environment", obj.target_promotion_environment),
            ("Hash Value", obj.hash_value),
        ]),
        ("People", [
            ("Requester", _uname(db, obj.requester_id)),
            ("Security Lead", _uname(db, obj.security_lead_id)),
        ]),
        ("Repository Components", [
            (f"Repository {i + 1}", f"{c.repository_url} | Branch: {c.git_branch} | Commit: {c.commit_id} | "
                                     f"Tech Stack: {c.technology_stack} | Build: {c.build_number}")
            for i, c in enumerate(obj.components)
        ]),
        ("Findings", _findings_summary(obj.findings)),
    ]

    history, history_note = _sast_dast_history(db, req_id)
    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="SAST Request — Full Detail Export",
        sections=sections, history=history, history_note=history_note,
        generated_by=current_user.full_name,
        generated_at=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.request_id}.pdf"'},
    )


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
@router.get("/api/sast-requests/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_sast_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "SAST", req_id)


@router.post("/api/sast-requests/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_sast_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                           current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return doc_store.save_documents(db, "SAST", req_id, obj.request_id, files, current_user.id)


@router.get("/api/sast-requests/{req_id}/documents/{doc_id}/download")
def download_sast_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "SAST", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


# ---- Walkthrough sessions + workflow history -- SAST previously had neither
# a Walkthroughs tab nor a History tab, unlike every other module. Mirrors
# Functional's routers/functional.py walkthrough endpoints; History reuses
# _sast_dast_history_rows() for the id-collision safety described above it. ----
@router.get("/api/sast-requests/{req_id}/walkthroughs", response_model=List[schemas.WalkthroughOut])
def list_sast_walkthroughs(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SASTWalkthrough).filter_by(sast_request_id=req_id).all()


@router.post("/api/sast-requests/{req_id}/walkthroughs", response_model=schemas.WalkthroughOut)
def add_sast_walkthrough(req_id: int, payload: schemas.WalkthroughCreate, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    _get_or_404(db, models.SASTRequest, req_id, "SAST")
    obj = models.SASTWalkthrough(sast_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/sast-requests/{req_id}/walkthroughs/{wt_id}/acknowledge", response_model=schemas.WalkthroughOut)
def acknowledge_sast_walkthrough(req_id: int, wt_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST, Role.QA_LEAD))):
    obj = db.query(models.SASTWalkthrough).filter_by(id=wt_id, sast_request_id=req_id).first()
    if not obj:
        raise HTTPException(404, "Walkthrough session not found")
    obj.qa_acknowledged_by_id = current_user.id
    obj.qa_acknowledged_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/api/sast-requests/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def sast_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _sast_dast_history_rows(db, req_id)


# ---------------- Module 5: DAST ----------------
def _can_view_dast_credentials(obj: models.DASTRequest, current_user: models.User) -> bool:
    return obj.requester_id == current_user.id or current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN)


def _dast_out(obj: models.DASTRequest, current_user: models.User) -> schemas.DASTOut:
    """Test Credentials is sensitive -- only the requester or a security
    analyst/admin should ever see it; every other viewer (SM, Department
    Head, other requesters, etc.) gets it blanked out here, per target row,
    in a fresh Pydantic object built off the ORM row. This never touches the
    ORM row or the DB session itself, so there's no risk of accidentally
    persisting the blank-out."""
    out = schemas.DASTOut.model_validate(obj)
    if not _can_view_dast_credentials(obj, current_user):
        for target in out.targets:
            target.test_credentials = None
    return out


@router.get("/api/dast-requests", response_model=List[schemas.DASTOut])
def list_dast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = db.query(models.DASTRequest).order_by(models.DASTRequest.created_at.desc()).all()
    return [_dast_out(r, current_user) for r in rows]


@router.post("/api/dast-requests", response_model=schemas.DASTOut)
def create_dast(payload: schemas.DASTCreate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    raise HTTPException(
        400,
        "Standalone DAST requests can no longer be raised directly -- include DAST in a QA Request's "
        "request types instead, then fill in the remaining details on the auto-created DAST request.",
    )


@router.put("/api/dast-requests/{req_id}", response_model=schemas.DASTOut)
def update_dast(req_id: int, payload: schemas.DASTUpdate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN):
        raise HTTPException(403, "Only the requester, a security analyst, or an admin can edit this request")
    if obj.status not in SAST_DAST_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump(exclude_unset=True)
    # `targets` is a relationship, not a plain column -- see the identical
    # `components` handling in update_sast above for why this replaces the
    # whole set wholesale rather than setattr-ing a list of dicts.
    targets = data.pop("targets", None)
    for k, v in data.items():
        setattr(obj, k, v)
    if targets is not None:
        obj.targets = [models.DASTTarget(**t) for t in targets]
    db.commit()
    db.refresh(obj)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/submit", response_model=schemas.DASTOut)
def submit_dast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _submit(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/resubmit", response_model=schemas.DASTOut)
def resubmit_dast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _resubmit(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/sm-decision", response_model=schemas.DASTOut)
def dast_sm_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.SM))):
    obj = _sm_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/department-head-decision", response_model=schemas.DASTOut)
def dast_department_head_decision(req_id: int, payload: schemas.SecurityDeptHeadDecisionIn, db: Session = Depends(get_db),
                                   current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    obj = _department_head_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/start-readiness", response_model=schemas.DASTOut)
def dast_start_readiness(req_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST, Role.QA_LEAD))):
    obj = _start_readiness(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/readiness-decision", response_model=schemas.DASTOut)
def dast_readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.SECURITY_ANALYST))):
    obj = _readiness_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/start-configuration", response_model=schemas.DASTOut)
def dast_start_configuration(req_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _start_configuration(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/start-scan", response_model=schemas.DASTOut)
def dast_start_scan(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _start_scan(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/complete-scan", response_model=schemas.DASTOut)
def dast_complete_scan(req_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _complete_scan(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/validate-findings", response_model=schemas.DASTOut)
def dast_validate_findings(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _validate_findings(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/assign-to-requester", response_model=schemas.DASTOut)
def dast_assign_to_requester(req_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _assign_to_requester(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/mark-fixed", response_model=schemas.DASTOut)
def dast_mark_fixed(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _mark_fixed(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/rescan-decision", response_model=schemas.DASTOut)
def dast_rescan_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _rescan_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/mark-report-ready", response_model=schemas.DASTOut)
def dast_mark_report_ready(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    obj = _mark_report_ready(db, obj, current_user, models.SuppressionRequest.dast_request_id)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/findings", response_model=schemas.DASTFindingOut)
def add_dast_finding(req_id: int, payload: schemas.SASTFindingIn, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    return _add_finding(db, obj, payload, current_user)


@router.post("/api/dast-requests/{req_id}/findings/{finding_id}/resolve", response_model=schemas.DASTFindingOut)
def resolve_dast_finding(req_id: int, finding_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    finding = db.query(models.DASTFinding).filter_by(id=finding_id, dast_request_id=req_id).first()
    if not finding:
        raise HTTPException(404, "Finding not found")
    return _resolve_finding(db, finding, current_user)


@router.get("/api/dast-requests/{req_id}/export")
def export_dast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this DAST request (including the ones delegated from
    its parent QA Request gateway), its scan targets, its findings, and its
    full approval/workflow history -- who submitted, approved, returned,
    etc., and when -- as one downloadable PDF. Test Credentials is
    deliberately omitted from the export regardless of who requests it (same
    sensitivity as the Targets tab -- exporting isn't a substitute for the
    existing masking rule)."""
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Priority", obj.priority),
            ("Risk Category", obj.risk_category),
        ]),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Project", obj.project_name),
            ("CR Number", obj.cr_number),
            ("Department", obj.department),
            ("Application Owner", obj.application_owner),
        ]),
        ("Environment & Release", [
            ("Deployment Environment", obj.deployment_environment),
            ("Target Promotion Environment", obj.target_promotion_environment),
            ("Target Release Date", obj.target_release_date),
        ]),
        ("People", [
            ("Requester", _uname(db, obj.requester_id)),
            ("Security Lead", _uname(db, obj.security_lead_id)),
        ]),
        ("Scan Targets", [
            (f"Target {i + 1}", f"{t.application_url} | Environment: {t.environment or '—'} | "
                                 f"Auth Required: {t.authentication_required or 'No'}")
            for i, t in enumerate(obj.targets)
        ]),
        ("Findings", _findings_summary(obj.findings)),
    ]

    history, history_note = _sast_dast_history(db, req_id)
    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="DAST Request — Full Detail Export",
        sections=sections, history=history, history_note=history_note,
        generated_by=current_user.full_name,
        generated_at=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.request_id}.pdf"'},
    )


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
@router.get("/api/dast-requests/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_dast_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "DAST", req_id)


@router.post("/api/dast-requests/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_dast_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                           current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    return doc_store.save_documents(db, "DAST", req_id, obj.request_id, files, current_user.id)


@router.get("/api/dast-requests/{req_id}/documents/{doc_id}/download")
def download_dast_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "DAST", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


# ---- Walkthrough sessions + workflow history -- see the equivalent SAST
# block above for the full reasoning; identical pattern, DAST's own table. ----
@router.get("/api/dast-requests/{req_id}/walkthroughs", response_model=List[schemas.WalkthroughOut])
def list_dast_walkthroughs(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.DASTWalkthrough).filter_by(dast_request_id=req_id).all()


@router.post("/api/dast-requests/{req_id}/walkthroughs", response_model=schemas.WalkthroughOut)
def add_dast_walkthrough(req_id: int, payload: schemas.WalkthroughCreate, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    _get_or_404(db, models.DASTRequest, req_id, "DAST")
    obj = models.DASTWalkthrough(dast_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/dast-requests/{req_id}/walkthroughs/{wt_id}/acknowledge", response_model=schemas.WalkthroughOut)
def acknowledge_dast_walkthrough(req_id: int, wt_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST, Role.QA_LEAD))):
    obj = db.query(models.DASTWalkthrough).filter_by(id=wt_id, dast_request_id=req_id).first()
    if not obj:
        raise HTTPException(404, "Walkthrough session not found")
    obj.qa_acknowledged_by_id = current_user.id
    obj.qa_acknowledged_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/api/dast-requests/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def dast_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _sast_dast_history_rows(db, req_id)
