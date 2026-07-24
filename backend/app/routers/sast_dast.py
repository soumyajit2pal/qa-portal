from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import Role, SAST_DAST_EDITABLE_STATUSES

router = APIRouter(tags=["sast-dast"])

# ---------------------------------------------------------------------------
# Independent SAST/DAST lifecycle (identical rules for both -- see the long
# comment above SAST_DAST_STATUSES in constants.py):
#
#   Requested -> submit -> SM_APPROVAL_PENDING -> sm-decision ->
#   DEPARTMENT_HEAD_APPROVAL_PENDING -> department-head-decision ->
#   READINESS_CHECK -> readiness-decision (QA Lead or Security Analyst) ->
#   Allocated -> start-scan -> Scanning -> [finding logged -> WAITING_FOR_FIX
#   -> requester fixes -> mark-fixed -> Scanning again] -> mark-security-complete
#   (once no Open findings remain) -> SECURITY_COMPLETE -> mark-report-ready
#   (blocked while any linked Suppression request isn't "Done") -> Report Ready.
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


def _get_or_404(db: Session, model_cls, req_id: int, label: str):
    obj = db.query(model_cls).get(req_id)
    if not obj:
        raise HTTPException(404, f"{label} request not found")
    return obj


def _submit(db: Session, obj, current_user):
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "Requested", "Submit")
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


def _resubmit(db: Session, obj, current_user):
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_QA_LEAD"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_DEPARTMENT_HEAD":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    else:
        obj.status = "READINESS_CHECK"
        _log(db, obj.id, "Readiness Check", current_user, "Resubmitted", "Returned request re-submitted")
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
        obj.status = "Closed"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _department_head_decision(db: Session, obj, payload, current_user):
    require_same_department(current_user, obj.department)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    if payload.decision == "Approved":
        obj.status = "READINESS_CHECK"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
    elif payload.decision == "Rejected":
        obj.status = "Closed"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _readiness_decision(db: Session, obj, payload, current_user):
    """QA Lead or Security Analyst check readiness for scanning to begin.
    Assumption: no separate 'Security Lead' role exists in the system yet, so
    Security Analyst stands in for it here -- extend the require_roles(...)
    on the routes below if a dedicated role is added later."""
    _require(obj, "READINESS_CHECK", "Readiness decision")
    if payload.decision == "Passed":
        obj.status = "Allocated"
    elif payload.decision == "Failed":
        obj.status = "RETURNED_BY_QA_LEAD"
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Readiness Check", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _start_scan(db: Session, obj, current_user):
    _require(obj, "Allocated", "Start scan")
    obj.status = "Scanning"
    _log(db, obj.id, "Security Team", current_user, "Scanning Started", None)
    db.commit()
    db.refresh(obj)
    return obj


def _mark_fixed(db: Session, obj, current_user):
    """Requester (whose responsibility the fix is) or a security analyst/admin
    marks the fix as submitted -- triggers a rescan."""
    if obj.requester_id != current_user.id and not current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN):
        raise HTTPException(403, "Only the requester, a security analyst, or an admin can mark this fixed")
    _require(obj, "WAITING_FOR_FIX", "Mark fixed")
    obj.status = "Scanning"
    _log(db, obj.id, "Waiting For Fix", current_user, "Fix Submitted", "Rescanning")
    db.commit()
    db.refresh(obj)
    return obj


def _mark_security_complete(db: Session, obj, current_user):
    _require(obj, "Scanning", "Mark security complete")
    open_findings = [f for f in obj.findings if f.status == "Open"]
    if open_findings:
        raise HTTPException(
            400,
            f"{len(open_findings)} finding(s) still Open -- resolve them (or leave in Waiting For Fix / "
            "rescan) before marking security complete.",
        )
    obj.status = "SECURITY_COMPLETE"
    _log(db, obj.id, "Security Team", current_user, "Security Complete", None)
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
    obj.status = "Report Ready"
    _log(db, obj.id, "Security Team", current_user, "Report Ready", None)
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
    # A newly-logged (Open) finding while a scan is in progress means a
    # vulnerability was found -- automatically move to Waiting For Fix so the
    # requester knows remediation is on them, rather than requiring a separate
    # manual "mark waiting for fix" click.
    if obj.status == "Scanning" and finding.status == "Open":
        obj.status = "WAITING_FOR_FIX"
        _log(db, obj.id, "Scanning", current_user, "Vulnerability Found", "Waiting For Fix (requester)")
    db.commit()
    db.refresh(finding)
    return finding


# ---------------- Module 4: SAST ----------------
@router.get("/api/sast-requests", response_model=List[schemas.SASTOut])
def list_sast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SASTRequest).order_by(models.SASTRequest.created_at.desc()).all()


# Standalone SAST request creation is DISABLED per request -- SAST requests
# must now originate from a QA Request (include "SAST" in its request types;
# see _sync_linked_security_requests in routers/qa_requests.py, which still
# creates the linked SASTRequest via direct ORM insert, bypassing this
# endpoint entirely, so that auto-linking keeps working). Once created it
# runs its own independent Requested -> Submit -> SM -> Department Head ->
# Readiness -> Scanning lifecycle -- see module docstring above.
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
    for k, v in data.items():
        setattr(obj, k, v)
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
def sast_department_head_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                                   current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    return _department_head_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/readiness-decision", response_model=schemas.SASTOut)
def sast_readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.SECURITY_ANALYST))):
    return _readiness_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/start-scan", response_model=schemas.SASTOut)
def sast_start_scan(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _start_scan(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/mark-fixed", response_model=schemas.SASTOut)
def sast_mark_fixed(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _mark_fixed(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/mark-security-complete", response_model=schemas.SASTOut)
def sast_mark_security_complete(req_id: int, db: Session = Depends(get_db),
                                 current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _mark_security_complete(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


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


# ---------------- Module 5: DAST ----------------
@router.get("/api/dast-requests", response_model=List[schemas.DASTOut])
def list_dast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.DASTRequest).order_by(models.DASTRequest.created_at.desc()).all()


# Standalone DAST request creation is DISABLED per request -- same reasoning
# as create_sast above: DAST requests must now originate from a QA Request
# (include "DAST" in its request types), then run the same independent
# lifecycle described in the module docstring.
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
    for k, v in data.items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/dast-requests/{req_id}/submit", response_model=schemas.DASTOut)
def submit_dast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _submit(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)


@router.post("/api/dast-requests/{req_id}/resubmit", response_model=schemas.DASTOut)
def resubmit_dast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _resubmit(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)


@router.post("/api/dast-requests/{req_id}/sm-decision", response_model=schemas.DASTOut)
def dast_sm_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.SM))):
    return _sm_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)


@router.post("/api/dast-requests/{req_id}/department-head-decision", response_model=schemas.DASTOut)
def dast_department_head_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                                   current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    return _department_head_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)


@router.post("/api/dast-requests/{req_id}/readiness-decision", response_model=schemas.DASTOut)
def dast_readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.SECURITY_ANALYST))):
    return _readiness_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)


@router.post("/api/dast-requests/{req_id}/start-scan", response_model=schemas.DASTOut)
def dast_start_scan(req_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _start_scan(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)


@router.post("/api/dast-requests/{req_id}/mark-fixed", response_model=schemas.DASTOut)
def dast_mark_fixed(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _mark_fixed(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)


@router.post("/api/dast-requests/{req_id}/mark-security-complete", response_model=schemas.DASTOut)
def dast_mark_security_complete(req_id: int, db: Session = Depends(get_db),
                                 current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    return _mark_security_complete(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)


@router.post("/api/dast-requests/{req_id}/mark-report-ready", response_model=schemas.DASTOut)
def dast_mark_report_ready(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    return _mark_report_ready(db, obj, current_user, models.SuppressionRequest.dast_request_id)


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
