import datetime
import json
import os
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from .. import models, pagination, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department, require_not_requester, dashboard_department_scope
from ..constants import Role, QA_DEPARTMENT, SAST_DAST_EDITABLE_STATUSES, SAST_DAST_ANALYST_REASSIGNABLE_STATUSES, SAST_DAST_STATUS_LABELS, is_readiness_evidence_editable, application_name_block_message
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store
from .. import application_names as app_names
from .. import reassignment
from ..fortify_ssc import FortifySSCClient, FortifySSCError

router = APIRouter(tags=["sast-dast"])


def _uname(db: Session, uid: Optional[int]) -> Optional[str]:
    if not uid:
        return None
    u = db.query(models.User).get(uid)
    return u.full_name if u else None


def _legacy_history_rows(db: Session, req_id: int) -> List["models.ApprovalAction"]:
    """Rows logged before the entity_type split described on _log() below,
    when SAST and DAST unsafely shared the single string "SAST_DAST" in the
    generic qap_approval_actions audit log despite SASTRequest and
    DASTRequest each having their own independent id sequence (see
    models.pk_column) -- so a SAST request and a DAST request could easily
    end up with the same numeric id, and this shared entity_type made
    "SAST_DAST" + entity_id NOT uniquely identify a request. Only safe to
    surface these older rows when there's no such collision for this exact
    id -- otherwise they could belong to either request, and showing them
    risks mixing the two modules' workflow history together (this was, in
    fact, the actual bug: with no fallback at all, EVERY id shared between a
    SAST and a DAST row made both requests' History tabs come back
    completely empty -- not just the ambiguous "SAST_DAST" rows)."""
    sast_has = db.query(models.SASTRequest.id).filter_by(id=req_id).first() is not None
    dast_has = db.query(models.DASTRequest.id).filter_by(id=req_id).first() is not None
    if sast_has and dast_has:
        return []
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SAST_DAST", entity_id=req_id).all())


def _sast_dast_history_rows(db: Session, kind: str, req_id: int) -> List["models.ApprovalAction"]:
    """kind is "SAST" or "DAST" -- returns that module's own workflow history
    (logged distinctly since the entity_type split, see _log() below) merged
    with any pre-existing "SAST_DAST" rows from before the fix (only when
    unambiguous, see _legacy_history_rows), oldest first."""
    rows = (db.query(models.ApprovalAction)
            .filter_by(entity_type=kind, entity_id=req_id).all())
    rows += _legacy_history_rows(db, req_id)
    rows.sort(key=lambda r: r.created_at or datetime.datetime.min)
    return rows


def _sast_dast_history(db: Session, kind: str, req_id: int) -> Tuple[list, Optional[str]]:
    """Same rows as _sast_dast_history_rows() above, pre-formatted as tuples
    for the PDF exporter."""
    rows = _sast_dast_history_rows(db, kind, req_id)
    history = [(h.step_name or "—", h.decision or "—", _uname(db, h.actor_id) or "—",
                h.actor_role or "—", h.comments or "—",
                h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—") for h in rows]
    return history, None

# These identify *which* request this actually is -- changing them once the
# request exists is an Admin-only action (see update_sast below; DAST has no
# editable equivalent of these -- application_name/epic_number/cr_number are
# delegated read-only from the gateway there, so there's nothing to guard).
# A submitted value equal to the current one is let through for anyone --
# that's not actually a change, just the form resubmitting a field it also
# displays.
_ADMIN_ONLY_FIELDS = {"application_name", "epic_number", "cr_number"}

# ---------------------------------------------------------------------------
# Independent SAST/DAST lifecycle (identical for both -- see the long comment
# above SAST_DAST_STATUSES in constants.py):
#
#   Draft -> Submit -> same-department SM Approval -> same-department
#   Department Head Approval (assigns a COE - Quality Assurance QA Lead) -> Security Readiness
#   (owned by that QA Lead) -> Planning (QA Lead assigns a COE - Quality Assurance Security
#   Analyst) -> Configuration -> Scanning -> Complete
#   Scan, gated on a confirmation pop-up ("Are you sure no security findings
#   were identified during the scan?"):
#     - Yes (clean scan) -> Security Complete -> Report Ready -> Closed, all
#       chained automatically in one step (see _auto_close_if_clean). Every
#       hop into Security Complete (here, in _validate_findings, and in
#       _rescan_decision's Passed branch) and the Security Complete ->
#       Report Ready hop are both gated on any linked Suppression request
#       being "Done" (see _require_no_pending_suppressions) -- a request
#       can't be called Security Complete while a suppression raised against
#       it is still an open decision.
#     - No (findings identified) -> Finding Validation, and the UI switches
#       to the Findings tab -> [no open findings after all ->] Security
#       Complete, or [open findings ->] Remediation -> Assigned To Requester
#       -> Waiting For Fix -> (requester marks fixed) -> Assigned To Lead ->
#       Rescan -> the same confirmation pop-up again (Rescan Decision):
#         - Passed (no findings remain) -> Security Complete -> Report Ready
#           -> Closed, same auto-chain (and same suppression gate) as above.
#         - Failed (findings still exist) -> back to Finding Validation, UI
#           returns to the Findings tab -> repeat remediation/rescan.
#
# Implemented once as generic helpers parameterized by model instance (a
# models.SASTRequest or models.DASTRequest row), with a thin pair of route
# functions per step so SAST and DAST keep separate URLs but never drift out
# of sync with each other.
# ---------------------------------------------------------------------------


def _log(db, obj, step, user, decision, comments=None):
    """Logs against a request-type-specific entity_type ("SAST" or "DAST")
    rather than a single shared "SAST_DAST" string -- see the long comment on
    _legacy_history_rows() above for why that used to make a request's own
    History tab come back empty whenever a SAST and a DAST request happened
    to share the same numeric id."""
    entity_type = "SAST" if isinstance(obj, models.SASTRequest) else "DAST"
    db.add(models.ApprovalAction(
        entity_type=entity_type, entity_id=obj.id, step_name=step,
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


def _it_qa_user(db: Session, user_id: Optional[int], role: str, label: str) -> models.User:
    user = db.query(models.User).get(user_id) if user_id else None
    if not user or not user.is_active or not user.has_role(role) or not user.has_department(QA_DEPARTMENT):
        raise HTTPException(400, f"{label} must be an active {role.replace('_', ' ').title()} from {QA_DEPARTMENT}")
    return user


def _require_assigned_qa_lead(obj, user: models.User) -> None:
    # Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on every QA-Lead-
    # gated action, same as ADMIN, without being listed as "QA Lead group"
    # members (display-only concern, kept to literal QA_LEAD elsewhere --
    # see ORACLE_MIGRATION_2026-07.md section 59).
    if not user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        raise HTTPException(403, "Only a member of the QA Lead group can perform this action")


def _require_assigned_security_analyst(obj, user: models.User) -> None:
    if not user.has_role(Role.ADMIN) and obj.security_analyst_id != user.id:
        raise HTTPException(403, "Only the Security Analyst assigned by the QA Lead can perform this action")


# 2026-08 Reassignment CR, reported directly: "Reassignment shall be
# permitted to: the current assignee, the Department Head of the department
# to which the current assignee belongs, or Admin users." Applies once this
# is a genuine reassignment (status already past the initial PLANNING
# assignment) -- the first assignment stays QA-Lead-group-only
# (_require_assigned_qa_lead), unchanged. See functional.py's identically-
# shaped _require_can_reassign_tester for the full reasoning.
def _require_can_reassign_security_analyst(obj, user: models.User) -> None:
    if user.has_role(Role.ADMIN):
        return
    if obj.security_analyst_id and obj.security_analyst_id == user.id:
        return
    if user.has_department(QA_DEPARTMENT) and user.has_role(*reassignment.department_head_roles(QA_DEPARTMENT)):
        return
    # 2026-08 -- reported directly: QA_LEAD is required to keep reassignment
    # rights here too, mirroring functional.py/performance.py's identical
    # fix -- the CR's own eligibility list would otherwise narrow existing
    # behavior, where a plain QA_LEAD could reassign the analyst, same as
    # the initial-assignment gate (_require_assigned_qa_lead) allows.
    if user.has_role(Role.QA_LEAD):
        return
    raise HTTPException(
        403,
        "Only the currently assigned Security Analyst, a QA Lead, the QA Department Head (Chief Manager QA / AGM QA), "
        "or an Administrator can reassign the Security Analyst on this request",
    )


def _can_upload_documents(obj, user: models.User) -> bool:
    """Reported directly (Document and Evidence Access Control Based on
    Workflow Stage): access follows exactly 3 stages, then locks hard --
    (1) the requester, while the request is genuinely in their own hands
    (Draft/Submitted, Returned-by-*, Rejected) may upload any number of
    files; (2) the SM, and only the SM, may upload while
    SM_APPROVAL_PENDING; (3) the Department Head, and only the Department
    Head, may upload while DEPARTMENT_HEAD_APPROVAL_PENDING. After
    Department Head approval, EVERY status is locked -- including
    WAITING_FOR_FIX, previously a dual requester/security-analyst window --
    no Security Lead, Analyst, or requester may upload here until the
    request is returned to the requester (a RETURNED_BY_* status), which
    re-opens stage (1). This intentionally removes the prior post-readiness
    upload window (every status from SECURITY_LEAD_ASSIGNED through
    SECURITY_COMPLETE) -- any evidence Security generates during actual
    scanning/remediation belongs in that finding's own record, not this
    readiness-facing Documents/Checklist Evidence store. Admin always
    bypasses, same convention as every other permission check."""
    if user.has_role(Role.ADMIN):
        return True
    status = obj.status
    if status in ("DRAFT", "SUBMITTED", "RETURNED_BY_SM", "SM_REJECTED",
                  "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD"):
        delegation = obj.active_delegation
        return (bool(delegation and delegation.assigned_to_id == user.id)
                or (obj.requester_id == user.id and not delegation))
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.SM) and user.has_department(obj.department)
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.has_department(obj.department)
    # Every post-readiness/terminal status -- locked for everyone but Admin
    # until the request is returned to the requester above.
    return False


def _can_edit_details(obj, user: models.User) -> bool:
    """Reported bug: an SM could still edit a request's own details after
    already returning it themselves (status RETURNED_BY_SM) -- a dead end,
    since only the requester/admin can ever call resubmit (see _resubmit),
    so the SM ended up with edit access they could never actually push
    forward. Clarified: edit access for a reviewer (SM/Department Head)
    should exist only while the request is genuinely pending *their own*
    decision (SM_APPROVAL_PENDING / DEPARTMENT_HEAD_APPROVAL_PENDING) -- fix
    something, then Approve/Return/Reject -- and disappears the moment
    they've decided either way. Once returned to the requester
    (RETURNED_BY_SM/RETURNED_BY_DEPARTMENT_HEAD/RETURNED_BY_SECURITY_LEAD),
    only the requester (or admin) may edit; reviewers are never involved
    again for a request already past their own checkpoint -- edit access for
    SM/Department Head stops at Department Head's own decision, never
    extending into Security's post-approval readiness stage. Same
    department-scoping as those stages' own decision endpoints above.

    SM_REJECTED is included alongside the RETURNED_BY_* statuses too --
    reported directly, a rejected request is now reopenable (edit + call
    _resubmit), not a dead end, so the requester needs the same edit access
    here as they'd have after a Return."""
    if user.has_role(Role.ADMIN):
        return True
    status = obj.status
    if status in ("DRAFT", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD"):
        delegation = obj.active_delegation
        return (bool(delegation and delegation.assigned_to_id == user.id)
                or (obj.requester_id == user.id and not delegation))
    if status == "SM_APPROVAL_PENDING":
        return user.has_role(Role.SM) and user.has_department(obj.department)
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM) and user.has_department(obj.department)
    return False


def _require_checklist_ready(obj):
    """The Security Readiness checklist's mandatory items (Admin-configurable
    now -- see checklist_config.py) must be self-declared ready by the
    requester before this request can be Submitted for SM Approval at all --
    these are prerequisites (repo
    access, test environment reachability, credentials, etc.) the requester
    needs to have lined up themselves before a scan is worth scheduling,
    checked here rather than waiting until Security Readiness. This is
    requester_checked (self-declaration), not is_complete (Security/QA's own
    independent verification, still gated separately at Security Readiness
    -- see _readiness_decision)."""
    pending = [c.item for c in obj.checklist_items if c.is_mandatory and not c.requester_checked]
    if pending:
        raise HTTPException(
            400,
            "Cannot submit -- the following mandatory Security Readiness checklist item(s) must be "
            "self-declared ready first (Edit Details): " + ", ".join(pending),
        )


def _submit(db: Session, obj, current_user):
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "DRAFT", "Submit")
    _require_checklist_ready(obj)
    obj.status = "SUBMITTED"
    # Mirrors routers/functional.py::submit_request -- logs the requester's
    # own "Submitted" step before immediately moving on to SM Approval, so
    # the History tab reads the same way across every request type instead
    # of SAST/DAST's own history jumping straight to "SM Approval" with no
    # record of who actually submitted it or when.
    _log(db, obj, "Requester", current_user, "Submitted", None)
    if obj.application_master_status == "REJECTED":
        # See routers/functional.py::submit_request for the full reasoning --
        # this request's Application Name was already rejected by an SM
        # (possibly via a sibling request's own screen), so it shouldn't get
        # a fresh shot at SM Approval under a name that's already known-bad.
        obj.status = "SM_REJECTED"
        _log(db, obj, "SM Approval", current_user, "Rejected",
             "Auto-rejected: this request's Application Name was rejected by SM")
    else:
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


def _resubmit(db: Session, obj, current_user):
    """Re-submits a request returned by SM, by the Department Head, or by the
    Security Lead -- or reopens one rejected by SM. Reported directly: a
    Rejected-by-SM request used to be a dead end; it's now reopenable the
    same way a Return is: edit details, then call this to send it straight
    back to SM_APPROVAL_PENDING for a fresh decision."""
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    if obj.active_delegation:
        raise HTTPException(400, "The active delegation must be returned or recalled before resubmission")
    _require(obj, ["RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD"],
             "Resubmit")
    if obj.status in ("RETURNED_BY_SM", "SM_REJECTED"):
        reopening = obj.status == "SM_REJECTED"
        _require_checklist_ready(obj)
        if obj.application_master_status == "REJECTED":
            obj.status = "SM_REJECTED"
            _log(db, obj, "SM Approval", current_user, "Rejected",
                 "Auto-rejected: this request's Application Name was rejected by SM")
        else:
            obj.status = "SM_APPROVAL_PENDING"
            _log(db, obj, "SM Approval", current_user,
                 "Reopened" if reopening else "Resubmitted",
                 "Rejected request reopened and re-submitted" if reopening else "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_DEPARTMENT_HEAD":
        # A genuine direct return from Department Head Approval itself.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_SECURITY_LEAD" and obj.needs_dept_head_reapproval:
        # Security Lead returned it but flagged that the fix needs a fresh
        # Department Head approval before Security Readiness resumes.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        obj.needs_dept_head_reapproval = False
        _log(db, obj, "Department Head Approval", current_user, "Resubmitted",
             "Returned request re-submitted (Department Head re-approval required)")
    else:
        obj.status = "SECURITY_READINESS"
        obj.needs_dept_head_reapproval = False
        _log(db, obj, "Security Readiness", current_user, "Resubmitted", "Returned request re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


def _sm_decision(db: Session, obj, payload, current_user):
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(400, application_name_block_message(obj.application_master_status, "sm"))
    if payload.decision == "Approved":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "SM_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _department_head_decision(db: Session, obj, payload, current_user):
    """Approval requires assignment to an active COE - Quality Assurance QA Lead."""
    require_same_department(current_user, obj.department)
    require_not_requester(current_user, obj.requester_id)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    if payload.decision == "Approved" and obj.application_master_status not in (None, "APPROVED"):
        raise HTTPException(400, application_name_block_message(obj.application_master_status, "department_head"))
    if payload.decision == "Approved":
        obj.security_lead_id = None
        obj.security_analyst_id = None
        obj.status = "SECURITY_LEAD_ASSIGNED"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
    elif payload.decision == "Rejected":
        obj.status = "DEPARTMENT_HEAD_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _start_readiness(db: Session, obj, current_user):
    _require(obj, "SECURITY_LEAD_ASSIGNED", "Start readiness")
    _require_assigned_qa_lead(obj, current_user)
    obj.status = "SECURITY_READINESS"
    _log(db, obj, "Security Readiness", current_user, "Started", "Readiness started by assigned QA Lead")
    db.commit()
    db.refresh(obj)
    return obj


def _readiness_decision(db: Session, obj, payload, current_user):
    _require(obj, "SECURITY_READINESS", "Readiness decision")
    _require_assigned_qa_lead(obj, current_user)
    if payload.decision == "Passed":
        # Every item the requester actually self-declared ready
        # (requester_checked) must be QA/Security-verified (is_complete)
        # before this can Pass -- not just the mandatory ones (mandatory
        # items are already forced self-declared at Submit time, before this
        # request even existed -- see _require_checklist_ready -- so this
        # naturally covers them too). Scoped to requester_checked rather than
        # every item on the list -- an item the requester never declared
        # ready can't be verified anyway (see update_checklist_item's own
        # gate), so requiring it here too would permanently block Passed with
        # no way forward.
        pending = [c.item for c in obj.checklist_items if c.requester_checked and not c.is_complete]
        if pending:
            raise HTTPException(400, f"Security Readiness checklist incomplete: {', '.join(pending)}")
        obj.status = "PLANNING"
    elif payload.decision == "Failed":
        # The Security/QA user acting here chooses whether this return
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
    _log(db, obj, "Security Readiness", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _assign_security_analyst(db: Session, obj, payload, current_user):
    """2026-08 Reassignment CR, reported directly: "Everywhere the system
    provides an Assign option ... it must also provide a Reassign option."
    Previously single-shot -- callable only while status was exactly
    PLANNING. Now also callable through the rest of the active-scan window
    (SAST_DAST_ANALYST_REASSIGNABLE_STATUSES: Configuration..Security
    Complete), by either the QA Lead group (unchanged -- the initial
    assignment gate) or, once a reassignment, the CR's own eligibility list
    (current analyst / QA Department Head / Admin) with a mandatory reason.
    Reassigning after the initial PLANNING->CONFIGURATION transition
    deliberately does NOT touch `status` -- a request already at, say,
    SCANNING must stay there after an analyst swap."""
    _require(obj, SAST_DAST_ANALYST_REASSIGNABLE_STATUSES, "Assign Security Analyst")
    is_initial_assignment = obj.status == "PLANNING"
    previous_id = obj.security_analyst_id
    if is_initial_assignment:
        _require_assigned_qa_lead(obj, current_user)
    else:
        _require_can_reassign_security_analyst(obj, current_user)
        reassignment.require_reason(payload.reason)
    analyst = _it_qa_user(db, payload.security_analyst_id, Role.SECURITY_ANALYST,
                          "security_analyst_id")
    obj.security_analyst_id = analyst.id
    if is_initial_assignment:
        obj.status = "CONFIGURATION"
    decision = "Security Analyst Assigned" if is_initial_assignment else "Security Analyst Reassigned"
    step = "Planning" if is_initial_assignment else SAST_DAST_STATUS_LABELS.get(obj.status, obj.status)
    _log(db, obj, step, current_user, decision, f"Assigned Security Analyst: {analyst.full_name}")
    if not is_initial_assignment:
        entity_type = "SAST" if isinstance(obj, models.SASTRequest) else "DAST"
        previous_user = db.query(models.User).get(previous_id) if previous_id else None
        reassignment.record_reassignment(
            db, entity_type, obj.id, current_user,
            previous_user.full_name if previous_user else "Unassigned", analyst.full_name, payload.reason,
        )
    db.commit()
    db.refresh(obj)
    return obj


def _start_configuration(db: Session, obj, current_user):
    raise HTTPException(
        400,
        "A Security Analyst must be assigned before configuration can start. "
        "Use Assign Security Analyst and select an active COE - Quality Assurance Security Analyst.",
    )


def _start_scan(db: Session, obj, payload: schemas.SecurityScanStartIn, current_user):
    _require(obj, "CONFIGURATION", "Start scan")
    _require_assigned_security_analyst(obj, current_user)
    kind = "SAST" if isinstance(obj, models.SASTRequest) else "DAST"
    try:
        snapshot = FortifySSCClient(kind).retrieve_snapshot(
            payload.application_name, payload.application_version,
        )
    except FortifySSCError as exc:
        # Do not advance the workflow if SSC cannot resolve/import the exact
        # application version selected by the analyst.
        raise HTTPException(502, str(exc)) from exc

    scan_result = models.SecurityScanResult(
        request_type=kind, request_id=obj.id,
        application_name=snapshot.application_name,
        application_version=snapshot.application_version,
        provider="Fortify SSC", provider_version_id=snapshot.project_version_id,
        critical_count=snapshot.critical_count, high_count=snapshot.high_count,
        medium_count=snapshot.medium_count, low_count=snapshot.low_count,
        total_count=snapshot.total_count, audit_url=snapshot.audit_url,
        filters_json=json.dumps(snapshot.filters), imported_by_id=current_user.id,
    )
    db.add(scan_result)
    obj.status = "SCANNING"
    _log(
        db, obj, "Configuration", current_user, "SSC Results Imported / Scanning Started",
        f"Fortify SSC application '{snapshot.application_name}', version '{snapshot.application_version}', "
        f"provider version ID {snapshot.project_version_id}; {snapshot.total_count} finding(s) across filter sets.",
    )
    db.commit()
    db.refresh(obj)
    db.refresh(scan_result)
    return obj, scan_result


def _scan_results(db: Session, kind: str, request_id: int):
    return (
        db.query(models.SecurityScanResult)
        .filter_by(request_type=kind, request_id=request_id)
        .order_by(models.SecurityScanResult.imported_at.desc(), models.SecurityScanResult.id.desc())
        .all()
    )


def _close_request(db: Session, obj, current_user):
    """Report Ready -> Closed. This is the lifecycle's actual terminal step
    (see constants.SAST_DAST_TERMINAL_STATUSES) -- previously nothing ever
    moved a SAST/DAST request out of Report Ready, so Closed was defined but
    unreachable."""
    _require(obj, "REPORT_READY", "Close request")
    _require_assigned_security_analyst(obj, current_user)
    obj.status = "CLOSED"
    _log(db, obj, "Report Ready", current_user, "Closed", None)
    db.commit()
    db.refresh(obj)
    return obj


def _auto_close_if_clean(db: Session, obj, current_user, sup_filter_col):
    """Best-effort chain from Security Complete through Report Ready to
    Closed -- used right after the Complete Scan / Rescan confirmation
    pop-up confirms no findings were identified, so a clean scan reaches
    Closed in one step instead of three separate manual clicks. Stops
    (without raising) at Report Ready's existing suppression gate if any
    linked Suppression / False Positive request isn't Done yet -- the
    analyst then finishes the remaining hop(s) manually via the existing
    Mark Report Ready / Close actions once that's resolved."""
    try:
        _mark_report_ready(db, obj, current_user, sup_filter_col)
    except HTTPException:
        return obj  # left at SECURITY_COMPLETE; suppression still pending
    return _close_request(db, obj, current_user)


def _complete_scan(db: Session, obj, current_user, no_findings: bool, comments, sup_filter_col):
    _require(obj, "SCANNING", "Complete scan")
    _require_assigned_security_analyst(obj, current_user)
    if no_findings:
        # Confirmed clean -- skip Finding Validation/Remediation entirely
        # and fast-track toward closure, unless a suppression raised earlier
        # against this same request is still outstanding.
        _require_no_pending_suppressions(db, obj, sup_filter_col, "Security Complete")
        obj.status = "SECURITY_COMPLETE"
        _log(db, obj, "Scanning", current_user, "Scan Complete - No Findings", comments)
        db.commit()
        db.refresh(obj)
        return _auto_close_if_clean(db, obj, current_user, sup_filter_col)
    obj.status = "FINDING_VALIDATION"
    _log(db, obj, "Scanning", current_user, "Scan Complete - Findings Identified", comments)
    db.commit()
    db.refresh(obj)
    return obj


def _validate_findings(db: Session, obj, current_user, sup_filter_col):
    """Moves from Finding Validation into Remediation if any findings need
    fixing, or straight to Security Complete if the scan came back clean --
    unless a suppression raised against this request is still outstanding,
    in which case Security Complete stays blocked until it's Done."""
    _require(obj, "FINDING_VALIDATION", "Validate findings")
    _require_assigned_security_analyst(obj, current_user)
    open_findings = [f for f in obj.findings if f.status == "Open"]
    if open_findings:
        obj.status = "REMEDIATION"
        _log(db, obj, "Finding Validation", current_user, "Findings Confirmed",
             f"{len(open_findings)} finding(s) require remediation")
    else:
        _require_no_pending_suppressions(db, obj, sup_filter_col, "Security Complete")
        obj.status = "SECURITY_COMPLETE"
        _log(db, obj, "Finding Validation", current_user, "No Findings", "Nothing to remediate")
    db.commit()
    db.refresh(obj)
    return obj


def _assign_to_requester(db: Session, obj, current_user):
    """Remediation -> Assigned To Requester -> Waiting For Fix. The
    "Assigned To Requester" hop is logged in the audit trail but not held as
    a resting status (mirrors how QA Request's Submitted/SAST-DAST's own
    Submitted step is transient on the way to the next real checkpoint)."""
    _require(obj, "REMEDIATION", "Assign to requester")
    _require_assigned_security_analyst(obj, current_user)
    _log(db, obj, "Remediation", current_user, "Assigned To Requester", None)
    obj.status = "WAITING_FOR_FIX"
    _log(db, obj, "Waiting For Fix", current_user, "Awaiting Fix", None)
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
    if obj.requester_id != current_user.id:
        _require_assigned_security_analyst(obj, current_user)
    _log(db, obj, "Waiting For Fix", current_user, "Fix Submitted", "Assigned to Lead for rescan")
    obj.status = "RESCAN"
    _log(db, obj, "Rescan", current_user, "Rescanning", None)
    db.commit()
    db.refresh(obj)
    return obj


def _rescan_decision(db: Session, obj, payload, current_user, sup_filter_col):
    """Driven by the same "any findings identified?" confirmation pop-up as
    Complete Scan -- Passed means the rescan confirmed no findings remain
    (fast-track to Closed, same as a clean Complete Scan); Failed means
    findings still exist, so this loops back to Finding Validation (not a
    fresh Scanning cycle) so the analyst can log the remaining findings and
    repeat the remediation/rescan workflow."""
    _require(obj, "RESCAN", "Rescan decision")
    _require_assigned_security_analyst(obj, current_user)
    if payload.decision == "Passed":
        _require_no_pending_suppressions(db, obj, sup_filter_col, "Security Complete")
        obj.status = "SECURITY_COMPLETE"
        _log(db, obj, "Rescan", current_user, payload.decision, payload.comments)
        db.commit()
        db.refresh(obj)
        return _auto_close_if_clean(db, obj, current_user, sup_filter_col)
    elif payload.decision == "Failed":
        obj.status = "FINDING_VALIDATION"
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj, "Rescan", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


def _pending_suppression_ids(db: Session, obj, sup_filter_col) -> list:
    """IDs of any Suppression / False Positive requests raised against this
    SAST/DAST id that aren't marked 'Done' yet (see constants.
    SUPPRESSION_STATUSES). Shared by the Security Complete gate (below, in
    _validate_findings/_complete_scan/_rescan_decision) and Report Ready's own
    gate in _mark_report_ready -- a suppression is still an open decision
    about a finding, so neither checkpoint should be reachable while one's
    outstanding."""
    linked_sups = db.query(models.SuppressionRequest).filter(sup_filter_col == obj.id).all()
    return [s.suppression_id for s in linked_sups if s.status != "Done"]


def _require_no_pending_suppressions(db: Session, obj, sup_filter_col, action: str):
    pending = _pending_suppression_ids(db, obj, sup_filter_col)
    if pending:
        raise HTTPException(
            400,
            f"Cannot mark {action} -- suppression request(s) still pending: "
            + ", ".join(pending) + ". They must be marked Done first.",
        )


def _mark_report_ready(db: Session, obj, current_user, sup_filter_col):
    """Blocked while any Suppression request raised against this SAST/DAST id
    hasn't been marked 'Done' (see constants.SUPPRESSION_STATUSES) -- same
    gate as Security Complete below, checked again here since Report Ready is
    reachable independently via its own manual button too."""
    _require(obj, "SECURITY_COMPLETE", "Mark report ready")
    _require_assigned_security_analyst(obj, current_user)
    _require_no_pending_suppressions(db, obj, sup_filter_col, "Report Ready")
    obj.status = "REPORT_READY"
    _log(db, obj, "Security Complete", current_user, "Report Ready", None)
    db.commit()
    db.refresh(obj)
    return obj


def _resolve_finding(db: Session, finding, current_user):
    finding.status = "Fixed"
    db.commit()
    db.refresh(finding)
    return finding


# ---------------- Module 4: SAST ----------------
@router.get("/api/sast-requests", response_model=pagination.Page[schemas.SASTListOut])
def list_sast(params: pagination.PageParams = Depends(), requester_id: Optional[int] = None,
              db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # department/application_name/application_master_status are delegated
    # properties (models.SASTRequest.department etc.), not real columns --
    # every filter/read that touches them needs qa_request (+ its own
    # application_master) eager-loaded, same reasoning as list_functional in
    # routers/functional.py. findings is selectinload'd (a second, batched
    # query) rather than joinedload'd (which would multiply row count via
    # the one-to-many join) so SASTListOut.findings_count doesn't lazy-load
    # per row. isouter=True on the QARequest join so a standalone (no
    # qa_request_id) SAST request isn't dropped for every caller, not just
    # scoped ones -- the original code only joined at all when `scope` was
    # set, so this preserves that "never silently excluded" behavior now
    # that the join always happens (needed for search/sort on the delegated
    # fields).
    q = db.query(models.SASTRequest).join(
        models.QARequest, models.SASTRequest.qa_request_id == models.QARequest.id, isouter=True
    ).options(
        joinedload(models.SASTRequest.qa_request).joinedload(models.QARequest.application_master),
        selectinload(models.SASTRequest.findings),
    )
    scope = dashboard_department_scope(current_user)
    delegated_to_user = models.QARequest.delegations.any(and_(
        models.QARequestDelegation.target_type == "SAST",
        models.QARequestDelegation.target_id == models.SASTRequest.id,
        models.QARequestDelegation.status == "ACTIVE",
        models.QARequestDelegation.assigned_to_id == current_user.id,
    ))
    if scope:
        q = q.filter(or_(models.QARequest.department.in_(scope), delegated_to_user))
    q = pagination.apply_search(q, params, models.SASTRequest.request_id, models.QARequest.application_name)
    q = pagination.apply_status_filter(q, params, models.SASTRequest.status)
    q = pagination.apply_department_filter(q, params, models.QARequest.department)
    # Module-specific, same reasoning as qa_requests.py/functional.py's own
    # requester_id addition (reported directly -- Dashboard.tsx's "My
    # Requests" tab).
    if requester_id is not None:
        q = q.filter(models.SASTRequest.requester_id == requester_id)
    q = pagination.apply_sort(
        q, params,
        sortable={
            "created_at": models.SASTRequest.created_at,
            "updated_at": models.SASTRequest.updated_at,
            "status": models.SASTRequest.status,
            "application_name": models.QARequest.application_name,
        },
        default_column=models.SASTRequest.created_at, id_column=models.SASTRequest.id,
    )
    result = pagination.paginate(q, params)
    return pagination.to_page_response(result, params)


@router.get("/api/sast-requests/{req_id}", response_model=schemas.SASTOut)
def get_sast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # PAG-006 -- the detail endpoint the frontend fetches from when a list
    # row is opened, now that the list above only returns SASTListOut. Also
    # closes a real gap: this endpoint did not exist before (every other
    # module already had one), and frontend code that re-fetched the entire
    # unpaginated list just to find one row by id (see SAST.tsx's own
    # resolveFinding) now uses this instead.
    return _get_or_404(db, models.SASTRequest, req_id, "SAST")


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
    # See _can_edit_details's own docstring above for the full permission
    # model (requester while it's theirs/returned to them; SM/Department
    # Head only while it's genuinely pending their own decision).
    if obj.status not in SAST_DAST_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    if not _can_edit_details(obj, current_user):
        raise HTTPException(403, "You do not have permission to edit this request in its current status")
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
    checked_items = data.pop("checked_items", None)
    # Reported directly ("Duplicate Application Name Validation Across All
    # Request Actions"): application_name used to fall straight into the
    # generic setattr(obj, k, v) loop below -- a bare string write over
    # SASTRequest's own disconnected application_name column (it has no
    # application_master_id FK, unlike QARequest/FunctionalRequest), with
    # zero case/whitespace normalization and no dedup check against
    # models.ApplicationMaster. Popped out and routed through the same
    # resolve_application_name every other Application Name entry point
    # uses, so an Admin correcting a typo here reuses an existing name (any
    # case/spacing variant) instead of silently creating a near-duplicate
    # ApplicationMaster entry. Only the normalized NAME is kept -- the
    # returned application_master_id is discarded since this column has
    # nothing to link it to, and cleanup_orphaned_application_master is
    # deliberately not called here for the same reason (no old_master_id was
    # ever tracked for this disconnected column to begin with). Re-resolved
    # only when genuinely different (case/whitespace-insensitive) from
    # what's already saved, so a plain re-save of an unrelated field never
    # re-touches it.
    application_name_in = data.pop("application_name", None)
    if application_name_in is not None:
        incoming_upper = (application_name_in or "").strip().upper()
        if incoming_upper != (obj.application_name or "").strip().upper():
            obj.application_name, _ = app_names.resolve_application_name(
                db, application_name_in, obj.department, current_user.id, qa_request_id=obj.qa_request_id,
            )
    for k, v in data.items():
        setattr(obj, k, v)
    if components is not None:
        obj.components = [models.SASTComponent(**c) for c in components]
    if checked_items is not None:
        # Lets the requester update their Security Readiness checklist
        # self-declaration from this same Edit Details modal -- see
        # schemas.SASTUpdate.checked_items.
        checked_set = set(checked_items)
        for item in obj.checklist_items:
            item.requester_checked = item.item in checked_set
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
                                   current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM))):
    return _department_head_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/start-readiness", response_model=schemas.SASTOut)
def sast_start_readiness(req_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    return _start_readiness(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/readiness-decision", response_model=schemas.SASTOut)
def sast_readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    return _readiness_decision(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)


@router.post("/api/sast-requests/{req_id}/start-configuration", response_model=schemas.SASTOut)
def sast_start_configuration(req_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    return _start_configuration(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), current_user)


@router.post("/api/sast-requests/{req_id}/assign-security-analyst", response_model=schemas.SASTOut)
def sast_assign_security_analyst(req_id: int, payload: schemas.AssignSecurityAnalystIn,
                                  db: Session = Depends(get_db),
                                  # 2026-08 Reassignment CR -- widened to include
                                  # SECURITY_ANALYST so the currently-assigned analyst
                                  # can hand their own assignment off (self-handoff,
                                  # same shape as Functional/Performance's tester
                                  # reassignment); _assign_security_analyst itself
                                  # still enforces exactly who may call it at each
                                  # stage (QA Lead group for the initial assignment,
                                  # the CR's narrower list once it's a reassignment).
                                  current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA, Role.SECURITY_ANALYST))):
    return _assign_security_analyst(
        db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user
    )


@router.post("/api/sast-requests/{req_id}/start-scan", response_model=schemas.SASTScanStartOut)
def sast_start_scan(req_id: int, payload: schemas.SecurityScanStartIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj, result = _start_scan(db, _get_or_404(db, models.SASTRequest, req_id, "SAST"), payload, current_user)
    return {"request": obj, "scan_result": result}


@router.get("/api/sast-requests/{req_id}/scan-results", response_model=List[schemas.SecurityScanResultOut])
def sast_scan_results(req_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _scan_results(db, "SAST", req_id)


@router.post("/api/sast-requests/{req_id}/complete-scan", response_model=schemas.SASTOut)
def sast_complete_scan(req_id: int, payload: schemas.ScanCompletionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _complete_scan(db, obj, current_user, payload.no_findings, payload.comments,
                           models.SuppressionRequest.sast_request_id)


@router.post("/api/sast-requests/{req_id}/validate-findings", response_model=schemas.SASTOut)
def sast_validate_findings(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _validate_findings(db, obj, current_user, models.SuppressionRequest.sast_request_id)


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
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _rescan_decision(db, obj, payload, current_user, models.SuppressionRequest.sast_request_id)


@router.post("/api/sast-requests/{req_id}/mark-report-ready", response_model=schemas.SASTOut)
def sast_mark_report_ready(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _mark_report_ready(db, obj, current_user, models.SuppressionRequest.sast_request_id)


@router.post("/api/sast-requests/{req_id}/close", response_model=schemas.SASTOut)
def sast_close_request(req_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    return _close_request(db, obj, current_user)


@router.post("/api/sast-requests/{req_id}/findings/{finding_id}/resolve", response_model=schemas.SASTFindingOut)
def resolve_sast_finding(req_id: int, finding_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    _require_assigned_security_analyst(obj, current_user)
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
            ("CR Number/EPIC Number", obj.cr_number or obj.epic_number),
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
            ("Assigned QA Lead", _uname(db, obj.security_lead_id)),
            ("Assigned Security Analyst", _uname(db, obj.security_analyst_id)),
        ]),
        ("Repository Components", [
            (f"Repository {i + 1}", f"{c.repository_url} | Branch: {c.git_branch} | Commit: {c.commit_id} | "
                                     f"Tech Stack: {c.technology_stack} | Build: {c.build_number}")
            for i, c in enumerate(obj.components)
        ]),
        ("Findings", _findings_summary(obj.findings)),
    ]

    history, history_note = _sast_dast_history(db, "SAST", req_id)
    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="SAST Request — Full Detail Export",
        sections=sections, history=history, history_note=history_note,
        generated_by=current_user.full_name,
        generated_at=models.now().strftime("%Y-%m-%d %H:%M IST"),
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
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester, central Security/QA team, or the SM/Department Head currently reviewing the request can upload documents")
    return doc_store.save_documents(db, "SAST", req_id, obj.request_id, files, current_user.id,
                                    log_entity_type="SAST", log_entity_id=obj.id, log_actor=current_user)


@router.get("/api/sast-requests/{req_id}/documents/{doc_id}/download")
def download_sast_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "SAST", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/api/sast-requests/{req_id}/documents/{doc_id}")
def delete_sast_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    doc = doc_store.get_document_or_404(db, "SAST", req_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="SAST", log_entity_id=req_id, log_actor=current_user)
    return {"ok": True}


def _sast_checklist_item_or_404(db: Session, req_id: int, item_id: int):
    item = db.query(models.SASTChecklistItem).filter_by(id=item_id, sast_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    return item


@router.get("/api/sast-requests/{req_id}/checklist/documents", response_model=List[schemas.ChecklistItemDocumentOut])
def list_sast_checklist_documents_batch(req_id: int, db: Session = Depends(get_db),
                                        current_user: models.User = Depends(get_current_user)):
    """Batched counterpart to list_sast_checklist_documents below -- see
    ChecklistItemDocumentOut for why this exists."""
    _get_or_404(db, models.SASTRequest, req_id, "SAST")
    item_ids = [row.id for row in db.query(models.SASTChecklistItem.id)
                .filter_by(sast_request_id=req_id).all()]
    docs = doc_store.list_documents_for_items(db, "SAST_ITEM", item_ids)
    return [schemas.ChecklistItemDocumentOut(
        id=d.id, file_name=d.file_name, content_type=d.content_type,
        file_size=d.file_size, uploaded_by_id=d.uploaded_by_id, uploaded_at=d.uploaded_at,
        item_id=d.request_id) for d in docs]


@router.get("/api/sast-requests/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_sast_checklist_documents(req_id: int, item_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    _sast_checklist_item_or_404(db, req_id, item_id)
    return doc_store.list_documents(db, "SAST_ITEM", item_id)


@router.post("/api/sast-requests/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_sast_checklist_documents(req_id: int, item_id: int, files: List[UploadFile] = File(...),
                                    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    item = _sast_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester or this request's current stage owner can attach checklist evidence")
    return doc_store.save_documents(db, "SAST_ITEM", item_id,
                                    f"{obj.request_id}/checklist-{item_id}", files, current_user.id,
                                    log_entity_type="SAST", log_entity_id=obj.id, log_actor=current_user,
                                    log_label=f"checklist item '{item.item}'")


@router.get("/api/sast-requests/{req_id}/checklist/{item_id}/documents/{doc_id}/download")
def download_sast_checklist_document(req_id: int, item_id: int, doc_id: int,
                                     db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _sast_checklist_item_or_404(db, req_id, item_id)
    doc = doc_store.get_document_or_404(db, "SAST_ITEM", item_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/api/sast-requests/{req_id}/checklist/{item_id}/documents/{doc_id}")
def delete_sast_checklist_document(req_id: int, item_id: int, doc_id: int,
                                   db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.SASTRequest, req_id, "SAST")
    item = _sast_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    doc = doc_store.get_document_or_404(db, "SAST_ITEM", item_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this evidence, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="SAST", log_entity_id=obj.id,
                              log_actor=current_user, log_label=f"checklist item '{item.item}'")
    return {"ok": True}


# ---- Security Readiness checklist -- SAST previously had no checklist
# concept at all, unlike Functional/Performance. Mirrors
# routers/performance.py's get_checklist/update_checklist_item (own dedicated
# table, requester-self-declare vs QA/Security-verify, same "can't verify
# what the requester hasn't self-declared" guard as round 69). ----
@router.get("/api/sast-requests/{req_id}/checklist", response_model=List[schemas.ChecklistItemOut])
def get_sast_checklist(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SASTChecklistItem).filter_by(sast_request_id=req_id).all()


@router.put("/api/sast-requests/{req_id}/checklist/{item_id}", response_model=schemas.ChecklistItemOut)
def update_sast_checklist_item(req_id: int, item_id: int, payload: schemas.ChecklistItemUpdate,
                                db: Session = Depends(get_db),
                                current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    item = db.query(models.SASTChecklistItem).filter_by(id=item_id, sast_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    parent = db.query(models.SASTRequest).get(req_id)
    if not parent or parent.status != "SECURITY_READINESS":
        raise HTTPException(
            400,
            "Security Readiness checklist items can only be verified while the request is in "
            "Security Readiness -- not while still in Draft or any other stage.",
        )
    _require_assigned_qa_lead(parent, current_user)
    if payload.is_complete and not item.requester_checked:
        raise HTTPException(
            400,
            "Cannot verify this item -- the requester has not self-declared it ready. "
            "Ask the requester to tick it first (Edit Details), then verify it here.",
        )
    item.is_complete = payload.is_complete
    if payload.is_complete:
        item.approved_by_id = current_user.id
        item.approved_at = models.now()
    else:
        item.approved_by_id = None
        item.approved_at = None
    db.commit()
    db.refresh(item)
    return item


@router.get("/api/sast-requests/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def sast_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _sast_dast_history_rows(db, "SAST", req_id)


# ---------------- Module 5: DAST ----------------
def _can_view_dast_credentials(obj: models.DASTRequest, current_user: models.User) -> bool:
    delegation = obj.active_delegation
    return (obj.requester_id == current_user.id
            or bool(delegation and delegation.assigned_to_id == current_user.id)
            or current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN))


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


@router.get("/api/dast-requests", response_model=pagination.Page[schemas.DASTListOut])
def list_dast(params: pagination.PageParams = Depends(), requester_id: Optional[int] = None,
              db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # See list_sast's matching comment just above -- identical reasoning.
    # DASTListOut has no `targets` field at all (see its own docstring in
    # schemas.py), so _dast_out's per-row credential-masking below is only
    # ever needed for the single-record detail endpoint, not this list.
    q = db.query(models.DASTRequest).join(
        models.QARequest, models.DASTRequest.qa_request_id == models.QARequest.id, isouter=True
    ).options(
        joinedload(models.DASTRequest.qa_request).joinedload(models.QARequest.application_master),
        selectinload(models.DASTRequest.findings),
    )
    scope = dashboard_department_scope(current_user)
    delegated_to_user = models.QARequest.delegations.any(and_(
        models.QARequestDelegation.target_type == "DAST",
        models.QARequestDelegation.target_id == models.DASTRequest.id,
        models.QARequestDelegation.status == "ACTIVE",
        models.QARequestDelegation.assigned_to_id == current_user.id,
    ))
    if scope:
        q = q.filter(or_(models.QARequest.department.in_(scope), delegated_to_user))
    q = pagination.apply_search(q, params, models.DASTRequest.request_id, models.QARequest.application_name)
    q = pagination.apply_status_filter(q, params, models.DASTRequest.status)
    q = pagination.apply_department_filter(q, params, models.QARequest.department)
    # Module-specific, same reasoning as qa_requests.py/functional.py's own
    # requester_id addition (reported directly -- Dashboard.tsx's "My
    # Requests" tab).
    if requester_id is not None:
        q = q.filter(models.DASTRequest.requester_id == requester_id)
    q = pagination.apply_sort(
        q, params,
        sortable={
            "created_at": models.DASTRequest.created_at,
            "updated_at": models.DASTRequest.updated_at,
            "status": models.DASTRequest.status,
            "application_name": models.QARequest.application_name,
        },
        default_column=models.DASTRequest.created_at, id_column=models.DASTRequest.id,
    )
    result = pagination.paginate(q, params)
    return pagination.to_page_response(result, params)


@router.get("/api/dast-requests/{req_id}", response_model=schemas.DASTOut)
def get_dast(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # PAG-006, same reasoning as get_sast above -- did not exist before.
    return _dast_out(_get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)


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
    # See _can_edit_details's own docstring (above, on update_sast) for the
    # full permission model -- same reasoning applies here.
    if obj.status not in SAST_DAST_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    if not _can_edit_details(obj, current_user):
        raise HTTPException(403, "You do not have permission to edit this request in its current status")
    data = payload.model_dump(exclude_unset=True)
    # `targets` is a relationship, not a plain column -- see the identical
    # `components` handling in update_sast above for why this replaces the
    # whole set wholesale rather than setattr-ing a list of dicts.
    targets = data.pop("targets", None)
    checked_items = data.pop("checked_items", None)
    for k, v in data.items():
        setattr(obj, k, v)
    if targets is not None:
        obj.targets = [models.DASTTarget(**t) for t in targets]
    if checked_items is not None:
        # See update_sast's identical checked_items handling above -- same
        # reasoning, for DAST's own Security Readiness checklist.
        checked_set = set(checked_items)
        for item in obj.checklist_items:
            item.requester_checked = item.item in checked_set
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
                                   current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM))):
    obj = _department_head_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/start-readiness", response_model=schemas.DASTOut)
def dast_start_readiness(req_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    obj = _start_readiness(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/readiness-decision", response_model=schemas.DASTOut)
def dast_readiness_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    obj = _readiness_decision(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/start-configuration", response_model=schemas.DASTOut)
def dast_start_configuration(req_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    obj = _start_configuration(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/assign-security-analyst", response_model=schemas.DASTOut)
def dast_assign_security_analyst(req_id: int, payload: schemas.AssignSecurityAnalystIn,
                                  db: Session = Depends(get_db),
                                  # 2026-08 Reassignment CR -- see sast_assign_security_analyst's
                                  # identical comment for why SECURITY_ANALYST is added here.
                                  current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA, Role.SECURITY_ANALYST))):
    obj = _assign_security_analyst(
        db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user
    )
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/start-scan", response_model=schemas.DASTScanStartOut)
def dast_start_scan(req_id: int, payload: schemas.SecurityScanStartIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj, result = _start_scan(db, _get_or_404(db, models.DASTRequest, req_id, "DAST"), payload, current_user)
    return {"request": _dast_out(obj, current_user), "scan_result": result}


@router.get("/api/dast-requests/{req_id}/scan-results", response_model=List[schemas.SecurityScanResultOut])
def dast_scan_results(req_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    _get_or_404(db, models.DASTRequest, req_id, "DAST")
    return _scan_results(db, "DAST", req_id)


@router.post("/api/dast-requests/{req_id}/complete-scan", response_model=schemas.DASTOut)
def dast_complete_scan(req_id: int, payload: schemas.ScanCompletionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    obj = _complete_scan(db, obj, current_user, payload.no_findings, payload.comments,
                          models.SuppressionRequest.dast_request_id)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/validate-findings", response_model=schemas.DASTOut)
def dast_validate_findings(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    obj = _validate_findings(db, obj, current_user, models.SuppressionRequest.dast_request_id)
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
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    obj = _rescan_decision(db, obj, payload, current_user, models.SuppressionRequest.dast_request_id)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/mark-report-ready", response_model=schemas.DASTOut)
def dast_mark_report_ready(req_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    obj = _mark_report_ready(db, obj, current_user, models.SuppressionRequest.dast_request_id)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/close", response_model=schemas.DASTOut)
def dast_close_request(req_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    obj = _close_request(db, obj, current_user)
    return _dast_out(obj, current_user)


@router.post("/api/dast-requests/{req_id}/findings/{finding_id}/resolve", response_model=schemas.DASTFindingOut)
def resolve_dast_finding(req_id: int, finding_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    _require_assigned_security_analyst(obj, current_user)
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
            ("CR Number/EPIC Number", obj.cr_number or obj.epic_number),
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
            ("Assigned QA Lead", _uname(db, obj.security_lead_id)),
            ("Assigned Security Analyst", _uname(db, obj.security_analyst_id)),
        ]),
        ("Scan Targets", [
            (f"Target {i + 1}", f"{t.application_url} | Environment: {t.environment or '—'} | "
                                 f"Auth Required: {t.authentication_required or 'No'}")
            for i, t in enumerate(obj.targets)
        ]),
        ("Findings", _findings_summary(obj.findings)),
    ]

    history, history_note = _sast_dast_history(db, "DAST", req_id)
    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="DAST Request — Full Detail Export",
        sections=sections, history=history, history_note=history_note,
        generated_by=current_user.full_name,
        generated_at=models.now().strftime("%Y-%m-%d %H:%M UTC"),
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
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester, central Security/QA team, or the SM/Department Head currently reviewing the request can upload documents")
    return doc_store.save_documents(db, "DAST", req_id, obj.request_id, files, current_user.id,
                                    log_entity_type="DAST", log_entity_id=obj.id, log_actor=current_user)


@router.get("/api/dast-requests/{req_id}/documents/{doc_id}/download")
def download_dast_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "DAST", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/api/dast-requests/{req_id}/documents/{doc_id}")
def delete_dast_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    doc = doc_store.get_document_or_404(db, "DAST", req_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="DAST", log_entity_id=req_id, log_actor=current_user)
    return {"ok": True}


def _dast_checklist_item_or_404(db: Session, req_id: int, item_id: int):
    item = db.query(models.DASTChecklistItem).filter_by(id=item_id, dast_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    return item


@router.get("/api/dast-requests/{req_id}/checklist/documents", response_model=List[schemas.ChecklistItemDocumentOut])
def list_dast_checklist_documents_batch(req_id: int, db: Session = Depends(get_db),
                                        current_user: models.User = Depends(get_current_user)):
    """Batched counterpart to list_dast_checklist_documents below -- see
    ChecklistItemDocumentOut for why this exists."""
    _get_or_404(db, models.DASTRequest, req_id, "DAST")
    item_ids = [row.id for row in db.query(models.DASTChecklistItem.id)
                .filter_by(dast_request_id=req_id).all()]
    docs = doc_store.list_documents_for_items(db, "DAST_ITEM", item_ids)
    return [schemas.ChecklistItemDocumentOut(
        id=d.id, file_name=d.file_name, content_type=d.content_type,
        file_size=d.file_size, uploaded_by_id=d.uploaded_by_id, uploaded_at=d.uploaded_at,
        item_id=d.request_id) for d in docs]


@router.get("/api/dast-requests/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_dast_checklist_documents(req_id: int, item_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    _dast_checklist_item_or_404(db, req_id, item_id)
    return doc_store.list_documents(db, "DAST_ITEM", item_id)


@router.post("/api/dast-requests/{req_id}/checklist/{item_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_dast_checklist_documents(req_id: int, item_id: int, files: List[UploadFile] = File(...),
                                    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    item = _dast_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    if not _can_upload_documents(obj, current_user):
        raise HTTPException(403, "Only the requester or this request's current stage owner can attach checklist evidence")
    return doc_store.save_documents(db, "DAST_ITEM", item_id,
                                    f"{obj.request_id}/checklist-{item_id}", files, current_user.id,
                                    log_entity_type="DAST", log_entity_id=obj.id, log_actor=current_user,
                                    log_label=f"checklist item '{item.item}'")


@router.get("/api/dast-requests/{req_id}/checklist/{item_id}/documents/{doc_id}/download")
def download_dast_checklist_document(req_id: int, item_id: int, doc_id: int,
                                     db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _dast_checklist_item_or_404(db, req_id, item_id)
    doc = doc_store.get_document_or_404(db, "DAST_ITEM", item_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/api/dast-requests/{req_id}/checklist/{item_id}/documents/{doc_id}")
def delete_dast_checklist_document(req_id: int, item_id: int, doc_id: int,
                                   db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, models.DASTRequest, req_id, "DAST")
    item = _dast_checklist_item_or_404(db, req_id, item_id)
    if not is_readiness_evidence_editable(obj.status):
        raise HTTPException(400, "Checklist evidence is locked after Department Head approval unless the request is returned for correction")
    doc = doc_store.get_document_or_404(db, "DAST_ITEM", item_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this evidence, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="DAST", log_entity_id=obj.id,
                              log_actor=current_user, log_label=f"checklist item '{item.item}'")
    return {"ok": True}


# ---- Security Readiness checklist -- see the equivalent SAST block above
# for the full reasoning; identical pattern, DAST's own table. ----
@router.get("/api/dast-requests/{req_id}/checklist", response_model=List[schemas.ChecklistItemOut])
def get_dast_checklist(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.DASTChecklistItem).filter_by(dast_request_id=req_id).all()


@router.put("/api/dast-requests/{req_id}/checklist/{item_id}", response_model=schemas.ChecklistItemOut)
def update_dast_checklist_item(req_id: int, item_id: int, payload: schemas.ChecklistItemUpdate,
                                db: Session = Depends(get_db),
                                current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    item = db.query(models.DASTChecklistItem).filter_by(id=item_id, dast_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    parent = db.query(models.DASTRequest).get(req_id)
    if not parent or parent.status != "SECURITY_READINESS":
        raise HTTPException(
            400,
            "Security Readiness checklist items can only be verified while the request is in "
            "Security Readiness -- not while still in Draft or any other stage.",
        )
    _require_assigned_qa_lead(parent, current_user)
    if payload.is_complete and not item.requester_checked:
        raise HTTPException(
            400,
            "Cannot verify this item -- the requester has not self-declared it ready. "
            "Ask the requester to tick it first (Edit Details), then verify it here.",
        )
    item.is_complete = payload.is_complete
    if payload.is_complete:
        item.approved_by_id = current_user.id
        item.approved_at = models.now()
    else:
        item.approved_by_id = None
        item.approved_at = None
    db.commit()
    db.refresh(item)
    return item


@router.get("/api/dast-requests/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def dast_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _sast_dast_history_rows(db, "DAST", req_id)
