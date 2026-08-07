import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..constants import (
    Role, QA_DEPARTMENT, GatewayStatus,
    QA_REQUEST_STATUS_LABELS, SAST_DAST_STATUS_LABELS, PERFORMANCE_STATUS_LABELS,
    SUPPRESSION_STATUS_LABELS, APPLICATION_MASTER_STATUS_LABELS, SIGNOFF_STATUS_LABELS,
)

router = APIRouter(prefix="/api/pending-approvals", tags=["pending-approvals"])

# Reported directly: "The system shall provide a Pending Approvals section in
# the navigation bar to display all approval requests awaiting action from
# the logged-in user." This is the single aggregator behind that nav item --
# every approval/decision checkpoint anywhere in the app (see the inventory
# below) is checked against the current user's own roles/department/specific
# assignment, and only the ones genuinely awaiting THIS user's decision right
# now are returned. There is deliberately no cross-entity "assigned_to"
# column anywhere in this schema to join against -- each category works out
# "is this awaiting me" the exact same way its own decision endpoint already
# gates the actual Approve/Reject call (require_roles/require_same_department/
# require_not_requester/an explicit *_lead_id column match), so this list can
# never show something the viewer isn't actually allowed to act on, and can
# never hide something they are.
#
# ADMIN sees every category, org-wide, with no department/assignment
# filtering at all -- has_role(...) already treats ADMIN as satisfying any
# role check (see models.User.has_role), and every one of the underlying
# decision endpoints this mirrors lets ADMIN bypass require_same_department/
# require_not_requester/the specific-assignment checks the same way -- so an
# Admin account already CAN act on every one of these; this list is just
# honest about that instead of hiding items an Admin could actually open and
# decide.
#
# Deliberately NOT covered here (out of scope for this pass): Functional/
# Performance "Requester Verification" (the requester confirming their own
# already-approved work, not a peer approving someone else's request) and
# Test Case review (QA Lead approving test-case CONTENT, not a request/
# workflow entity at all). Flagged in ORACLE_MIGRATION_2026-07.md as a
# possible follow-up rather than silently folded in.


def _item(category, entity_type, entity_id, display_id, title, status, status_label,
          department, submitted_by, submitted_at, path,
          parent_request_id=None, parent_path=None) -> dict:
    return {
        "category": category, "entity_type": entity_type, "entity_id": entity_id,
        "display_id": display_id, "title": title, "status": status, "status_label": status_label,
        "department": department, "submitted_by": submitted_by, "submitted_at": submitted_at, "path": path,
        "parent_request_id": parent_request_id, "parent_path": parent_path,
    }


def _parent_context(obj):
    gateway = getattr(obj, "qa_request", None)
    if not gateway or not gateway.request_id:
        return None, None
    return gateway.request_id, f"/qa-requests?search={gateway.request_id}"


def _name(user: Optional["models.User"]) -> Optional[str]:
    return user.full_name if user else None


def _user_name(db: Session, user_id: Optional[int]) -> Optional[str]:
    """SuppressionRequest.created_by_id has no `created_by` relationship
    defined on the model (unlike every other *_id/created_by pair in this
    app) -- a plain lookup instead of adding a relationship purely for this
    read-only feed."""
    if not user_id:
        return None
    row = db.query(models.User).get(user_id)
    return row.full_name if row else None


def _application_master_items(db: Session, user: models.User) -> List[dict]:
    """Application Name -- Application Owner tier (PENDING_APP_OWNER) and SM
    tier (PENDING_SM). See routers/applications.py::decide_app_owner_name /
    decide_application_name -- both keyed by the ApplicationMaster row's own
    id, department-scoped the same way as every SM/Department Head
    checkpoint. There's no dedicated page for this decision (see
    components/ApplicationNameBanner.tsx's own docstring: it renders inline
    on the master QA Request gateway's own Overview tab) -- links to the
    gateway that most recently introduced/used this exact name so the
    banner is right there to act on."""
    results: List[dict] = []
    is_admin = user.has_role(Role.ADMIN)

    # Reported directly: "Draft requests should not appear under Pending
    # Approvals." A name only introduced by (or still attached to) a Draft
    # gateway hasn't actually been Submitted/Raised yet -- there's nothing
    # for an Application Owner to act on until then (see submit_request's
    # PENDING_APP_OWNER-defers-child-creation branch), so it shouldn't show
    # up as "awaiting approval" just because a requester saved a Draft with
    # a brand-new name. Cancelled gateways are excluded the same way (never
    # going anywhere either). One name can be reused across more than one
    # separately-raised QA Request over time, so this looks for ANY such
    # gateway, not just the one originally recorded on ApplicationMaster.
    # qa_request_id (see _resolve_application_name).
    def _active_gateway(app_id: int):
        return (
            db.query(models.QARequest)
            .filter(
                models.QARequest.application_master_id == app_id,
                models.QARequest.status.notin_([GatewayStatus.DRAFT, GatewayStatus.CANCELLED]),
            )
            .order_by(models.QARequest.created_at.desc())
            .first()
        )

    def _gateway_path(gw) -> str:
        if gw and gw.request_id:
            return f"/qa-requests?open={gw.request_id}"
        return "/qa-requests"

    if user.has_role(Role.APPLICATION_OWNER):
        q = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.status == "PENDING_APP_OWNER")
        if not is_admin:
            q = q.filter(models.ApplicationMaster.department == user.department)
        for obj in q.order_by(models.ApplicationMaster.created_at).all():
            gw = _active_gateway(obj.id)
            if not gw:
                continue
            results.append(_item(
                "Application Name -- Application Owner Approval", "APPLICATION_MASTER", obj.id, None,
                f"New Application Name: {obj.name}", obj.status,
                APPLICATION_MASTER_STATUS_LABELS.get(obj.status, obj.status),
                obj.department, _name(obj.requested_by), obj.created_at, _gateway_path(gw),
                gw.request_id, _gateway_path(gw),
            ))

    if user.has_role(Role.SM):
        q = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.status == "PENDING_SM")
        if not is_admin:
            q = q.filter(models.ApplicationMaster.department == user.department)
        for obj in q.order_by(models.ApplicationMaster.created_at).all():
            gw = _active_gateway(obj.id)
            if not gw:
                continue
            results.append(_item(
                "Application Name -- SM Approval", "APPLICATION_MASTER", obj.id, None,
                f"New Application Name: {obj.name}", obj.status,
                APPLICATION_MASTER_STATUS_LABELS.get(obj.status, obj.status),
                obj.department, _name(obj.requested_by), obj.created_at, _gateway_path(gw),
                gw.request_id, _gateway_path(gw),
            ))
    return results


# One entry per (model, business-id prefix, path, category label, status
# label map, requester-column-name) -- Functional/SAST/DAST/Performance all
# share the exact same SM Approval / Department Head Approval checkpoint
# shape, department delegated from their own qa_request, so this single
# table-driven loop covers all four instead of repeating the same two
# queries four times.
_SM_DEPT_HEAD_MODULES = [
    (models.FunctionalRequest, "FUNCTIONAL_REQUEST", "/functional-requests", "Functional Testing",
     QA_REQUEST_STATUS_LABELS),
    (models.SASTRequest, "SAST", "/sast", "SAST", SAST_DAST_STATUS_LABELS),
    (models.DASTRequest, "DAST", "/dast", "DAST", SAST_DAST_STATUS_LABELS),
    (models.PerformanceRequest, "PERFORMANCE", "/performance", "Performance Testing", PERFORMANCE_STATUS_LABELS),
]

# Readiness-style checkpoint (assigned to one specific QA Lead, not a
# department-wide pool) -- column name differs per module (qa_lead_id /
# security_lead_id / security_lead_id / engineer_id).
_READINESS_MODULES = [
    (models.FunctionalRequest, "FUNCTIONAL_REQUEST", "/functional-requests", "Functional Testing",
     QA_REQUEST_STATUS_LABELS, "qa_lead_id", "READINESS_VERIFICATION"),
    (models.SASTRequest, "SAST", "/sast", "SAST", SAST_DAST_STATUS_LABELS, "security_lead_id", "SECURITY_READINESS"),
    (models.DASTRequest, "DAST", "/dast", "DAST", SAST_DAST_STATUS_LABELS, "security_lead_id", "SECURITY_READINESS"),
    (models.PerformanceRequest, "PERFORMANCE", "/performance", "Performance Testing", PERFORMANCE_STATUS_LABELS,
     "engineer_id", "READINESS"),
]


def _sm_dept_head_items(db: Session, user: models.User) -> List[dict]:
    """Functional/SAST/DAST/Performance requests are always spun off from a
    QA Request gateway now (standalone creation is disabled for all four --
    see e.g. routers/sast_dast.py::create_sast), so qa_request_id is
    effectively always set on anything created going forward. It stays
    nullable on the model purely for pre-existing legacy rows from before
    that restriction (see each model's own qa_request_id column comment) --
    an outer join (not an inner join) so those legacy standalone rows still
    surface here rather than silently vanishing, with the same "no
    department to compare against, so don't block on it" fallback
    require_same_department itself uses (see deps.py) for the department
    filter below."""
    results: List[dict] = []
    is_admin = user.has_role(Role.ADMIN)
    for model, entity_type, path, module_label, labels in _SM_DEPT_HEAD_MODULES:
        if user.has_role(Role.SM):
            q = (
                db.query(model)
                .outerjoin(models.QARequest, model.qa_request_id == models.QARequest.id)
                .filter(model.status == "SM_APPROVAL_PENDING")
            )
            if not is_admin:
                q = q.filter(
                    or_(models.QARequest.department == user.department, models.QARequest.department.is_(None)),
                    model.requester_id != user.id,
                )
            for obj in q.order_by(model.created_at).all():
                results.append(_item(
                    f"{module_label} -- SM Approval", entity_type, obj.id, obj.request_id,
                    f"{module_label}: {obj.application_name or '—'}", obj.status,
                    labels.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                    obj.created_at, f"{path}?open={obj.request_id}",
                    *_parent_context(obj),
                ))
        if user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
            q = (
                db.query(model)
                .outerjoin(models.QARequest, model.qa_request_id == models.QARequest.id)
                .filter(model.status == "DEPARTMENT_HEAD_APPROVAL_PENDING")
            )
            if not is_admin:
                q = q.filter(
                    or_(models.QARequest.department == user.department, models.QARequest.department.is_(None)),
                    model.requester_id != user.id,
                )
            for obj in q.order_by(model.created_at).all():
                results.append(_item(
                    f"{module_label} -- Department Head Approval", entity_type, obj.id, obj.request_id,
                    f"{module_label}: {obj.application_name or '—'}", obj.status,
                    labels.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                    obj.created_at, f"{path}?open={obj.request_id}",
                    *_parent_context(obj),
                ))
    return results


def _readiness_items(db: Session, user: models.User) -> List[dict]:
    """QA Lead / Security Lead / Engineer readiness checkpoints -- assigned to
    one SPECIFIC person by the Department Head (see the *_lead_id/engineer_id
    column), not a department-wide pool, so ADMIN aside, this is the one
    category scoped by exact user id rather than department."""
    if not user.has_role(Role.QA_LEAD):
        return []
    results: List[dict] = []
    is_admin = user.has_role(Role.ADMIN)
    for model, entity_type, path, module_label, labels, lead_column, waiting_status in _READINESS_MODULES:
        q = db.query(model).filter(model.status == waiting_status)
        if not is_admin:
            q = q.filter(getattr(model, lead_column) == user.id)
        for obj in q.order_by(model.created_at).all():
            results.append(_item(
                f"{module_label} -- Readiness Verification", entity_type, obj.id, obj.request_id,
                f"{module_label}: {obj.application_name or '—'}", obj.status,
                labels.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                obj.created_at, f"{path}?open={obj.request_id}",
                *_parent_context(obj),
            ))
    return results


def _suppression_items(db: Session, user: models.User) -> List[dict]:
    """Suppression's own SM / Department Head / Security Team checkpoints --
    department is a real column here (not delegated), and the Security Team
    step is deliberately department-agnostic (any SECURITY_ANALYST, shared
    pool -- see routers/suppression.py::security_team_decision's own
    docstring), so no department filter applies there at all, admin or not."""
    results: List[dict] = []
    is_admin = user.has_role(Role.ADMIN)

    def _query(status: str):
        return db.query(models.SuppressionRequest).filter(models.SuppressionRequest.status == status)

    if user.has_role(Role.SM):
        q = _query("SM_APPROVAL_PENDING")
        if not is_admin:
            q = q.filter(models.SuppressionRequest.department == user.department,
                         models.SuppressionRequest.created_by_id != user.id)
        for obj in q.order_by(models.SuppressionRequest.created_at).all():
            results.append(_item(
                "Suppression -- SM Approval", "SUPPRESSION", obj.id, obj.suppression_id,
                f"Suppression: {obj.application_name or '—'}", obj.status,
                SUPPRESSION_STATUS_LABELS.get(obj.status, obj.status), obj.department,
                _user_name(db, obj.created_by_id),
                obj.created_at, f"/suppression?open={obj.suppression_id}",
            ))
    if user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
        q = _query("DEPARTMENT_HEAD_APPROVAL_PENDING")
        if not is_admin:
            q = q.filter(models.SuppressionRequest.department == user.department,
                         models.SuppressionRequest.created_by_id != user.id)
        for obj in q.order_by(models.SuppressionRequest.created_at).all():
            results.append(_item(
                "Suppression -- Department Head Approval", "SUPPRESSION", obj.id, obj.suppression_id,
                f"Suppression: {obj.application_name or '—'}", obj.status,
                SUPPRESSION_STATUS_LABELS.get(obj.status, obj.status), obj.department,
                _user_name(db, obj.created_by_id),
                obj.created_at, f"/suppression?open={obj.suppression_id}",
            ))
    if user.has_role(Role.SECURITY_ANALYST):
        for obj in _query("SECURITY_TEAM_VERIFICATION").order_by(models.SuppressionRequest.created_at).all():
            results.append(_item(
                "Suppression -- Security Team Verification", "SUPPRESSION", obj.id, obj.suppression_id,
                f"Suppression: {obj.application_name or '—'}", obj.status,
                SUPPRESSION_STATUS_LABELS.get(obj.status, obj.status), obj.department,
                _user_name(db, obj.created_by_id),
                obj.created_at, f"/suppression?open={obj.suppression_id}",
            ))
    return results


def _signoff_items(db: Session, user: models.User) -> List[dict]:
    """QA Sign-off's own QA Lead / Executive COE checkpoints -- gated by the
    REVIEWER's own department being IT-QA (see routers/signoff.py::
    _require_qa_department), not by matching the certificate's own
    (requesting) department -- unlike every SM/Department Head checkpoint
    above."""
    is_admin = user.has_role(Role.ADMIN)
    if user.department != QA_DEPARTMENT and not is_admin:
        return []
    results: List[dict] = []

    def _query(status: str):
        q = db.query(models.QASignOff).filter(models.QASignOff.status == status)
        if not is_admin:
            q = q.filter(models.QASignOff.requester_id != user.id)
        return q

    if user.has_role(Role.QA_LEAD):
        for obj in _query("SM_APPROVAL_PENDING").order_by(models.QASignOff.created_at).all():
            results.append(_item(
                "QA Sign-off -- QA Lead Approval", "SIGNOFF", obj.id, obj.certificate_id,
                f"QA Sign-off: {obj.application_name or '—'}", obj.status,
                SIGNOFF_STATUS_LABELS.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                obj.created_at, f"/signoff?open={obj.certificate_id}",
            ))
    if user.has_role(Role.DEPARTMENT_HEAD_COE_CM, Role.DEPARTMENT_HEAD_COE_AGM):
        for obj in _query("DEPT_HEAD_COE_APPROVAL_PENDING").order_by(models.QASignOff.created_at).all():
            results.append(_item(
                "QA Sign-off -- Executive COE Approval", "SIGNOFF", obj.id, obj.certificate_id,
                f"QA Sign-off: {obj.application_name or '—'}", obj.status,
                SIGNOFF_STATUS_LABELS.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                obj.created_at, f"/signoff?open={obj.certificate_id}",
            ))
    return results


def _test_project_items(db: Session, user: models.User) -> List[dict]:
    """Test Project activation/deactivation -- reported directly: "Project
    Activation, deactivation should need approval from QA lead." See
    routers/test_projects.py::review_project_activation -- QA_LEAD/ADMIN
    only, org-wide (no department scoping, no requester exclusion -- mirrors
    that endpoint's own gate exactly, not invented here)."""
    if not user.has_role(Role.QA_LEAD):
        return []
    results: List[dict] = []
    q = db.query(models.TestProject).filter(models.TestProject.pending_is_active.isnot(None))
    for obj in q.order_by(models.TestProject.pending_requested_at).all():
        action = "Reactivation" if obj.pending_is_active else "Deactivation"
        results.append(_item(
            "Test Project -- Activation Approval", "TEST_PROJECT", obj.id, obj.project_key,
            f"{action} requested: {obj.name}", "PENDING_ACTIVATION_APPROVAL",
            f"{action} Approval Pending", obj.department, obj.pending_requested_by_name,
            obj.pending_requested_at, f"/test-projects?open={obj.project_key}",
        ))
    return results


@router.get("", response_model=List[schemas.PendingApprovalItem])
def list_pending_approvals(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Everything genuinely awaiting the logged-in user's own decision right
    now, across every approval checkpoint in the app -- see this module's own
    docstring above for the full inventory and the ADMIN-sees-everything
    reasoning. Sorted oldest-submitted-first within the combined list (the
    frontend groups by category for display, but age is what should drive
    priority within a category)."""
    items = (
        _application_master_items(db, current_user)
        + _sm_dept_head_items(db, current_user)
        + _readiness_items(db, current_user)
        + _suppression_items(db, current_user)
        + _signoff_items(db, current_user)
        + _test_project_items(db, current_user)
    )
    items.sort(key=lambda i: i["submitted_at"] or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc))
    return items
