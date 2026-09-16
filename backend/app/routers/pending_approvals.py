import datetime
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select, union_all
from sqlalchemy.orm import Session

from .. import models, pagination, schemas
from ..database import get_db
from ..project_workspace_ownership import workspace_can_contribute
from ..workflow_authority import workflow_endpoint, is_system_admin, admin_department_allowed
from ..deps import (
    get_workflow_user as get_current_user, active_qa_workspace_scope,
    active_qa_workspace_scope_ids,
    department_unit_visibility_condition,
    can_review_repository, can_give_final_approval,
)
from ..constants import (
    Role, GatewayStatus,
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
# Administrator is not a workflow role. Both public endpoints enter the
# workflow authority context, requiring explicit operational roles and all
# maker-checker rules. Administrators with such roles are additionally
# restricted to records in their own departments, including login counts.
#
# Deliberately NOT covered here (out of scope for this pass): Functional/
# Performance "Requester Verification" (the requester confirming their own
# already-approved work, not a peer approving someone else's request).
#
# The queue is returned through the shared page contract. Pagination is
# applied only after every role/department/maker-checker gate below has built
# the complete authorized queue, so totals cannot expose or count approvals
# the viewer cannot act on. Complete category counts travel with every page
# so filtering remains accurate even when a category has no row on the
# current page.
#
# Test Case review (2026-08 "Test Approval Workflow" refactor, APR-007
# "Pending Approval shall show only items on which the logged-in user can
# act") IS covered now -- see _test_case_items below. This was flagged as a
# deliberate gap in an earlier pass; closing it here.


def _item(category, entity_type, entity_id, display_id, title, status, status_label,
          department, submitted_by, submitted_at, path,
          parent_request_id=None, parent_path=None, parent_label=None, folder_name=None) -> dict:
    return {
        "category": category, "entity_type": entity_type, "entity_id": entity_id,
        "display_id": display_id, "title": title, "status": status, "status_label": status_label,
        "department": department, "submitted_by": submitted_by, "submitted_at": submitted_at, "path": path,
        "parent_request_id": parent_request_id, "parent_path": parent_path,
        "parent_label": parent_label, "folder_name": folder_name,
    }


def _pending_sort_key(item: dict):
    submitted_at = item.get("submitted_at")
    if submitted_at is None:
        submitted_at = datetime.datetime.min
    elif submitted_at.tzinfo is not None:
        submitted_at = submitted_at.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return submitted_at, item["category"], item["entity_type"], item["entity_id"]


def _paginate_pending_items(items: List[dict], params: pagination.PageParams,
                            category: Optional[str]) -> dict:
    """Build stable category facets, then slice only the requested queue."""
    ordered = sorted(items, key=_pending_sort_key)
    category_counts: dict[str, int] = {}
    for item in ordered:
        category_counts[item["category"]] = category_counts.get(item["category"], 0) + 1

    normalized_category = category.strip() if category and category.strip() else None
    filtered = [item for item in ordered if item["category"] == normalized_category] if normalized_category else ordered
    total = len(filtered)
    total_pages = max(1, -(-total // params.page_size))
    start = (params.page - 1) * params.page_size
    return {
        "items": filtered[start:start + params.page_size],
        "page": params.page,
        "page_size": params.page_size,
        "total": total,
        "total_pages": total_pages,
        "has_next": params.page < total_pages,
        "has_previous": params.page > 1,
        "category_counts": category_counts,
    }


def _parent_context(obj):
    gateway = getattr(obj, "qa_request", None)
    if not gateway or not gateway.request_id:
        return None, None
    return gateway.request_id, _detail_path("/qa-requests", gateway.request_id, gateway.id)


def _suppression_team_scope_condition(db: Session, user: models.User):
    gateway_scope = department_unit_visibility_condition(
        db, user, models.QARequest.department, models.QARequest.department_unit_id,
    )
    return or_(
        models.SuppressionRequest.sast_request.has(
            models.SASTRequest.qa_request.has(gateway_scope),
        ),
        models.SuppressionRequest.dast_request.has(
            models.DASTRequest.qa_request.has(gateway_scope),
        ),
    )


def _detail_path(path: str, display_id: str, entity_id: int) -> str:
    """Build a deep link that can open an exact record, regardless of pagination.

    ``open`` remains the readable business identifier used by existing links,
    while ``openId`` is the database identifier the destination page can fetch
    directly.  Pending Approvals must not depend on whether its target happens
    to be on the first page of a module list.
    """
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}open={quote(str(display_id), safe='')}&openId={entity_id}"


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
    workspace_ids = active_qa_workspace_scope_ids(user)

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
        q = db.query(models.QARequest).filter(
                models.QARequest.application_master_id == app_id,
                models.QARequest.status.notin_([GatewayStatus.DRAFT, GatewayStatus.CANCELLED]),
            )
        if workspace_ids:
            q = q.filter(models.QARequest.qa_workspace_id.in_(workspace_ids))
        if not is_admin:
            q = q.filter(department_unit_visibility_condition(
                db, user, models.QARequest.department, models.QARequest.department_unit_id,
            ))
        return q.order_by(models.QARequest.created_at.desc()).first()

    def _gateway_path(gw) -> str:
        if gw and gw.request_id:
            return _detail_path("/qa-requests", gw.request_id, gw.id)
        return "/qa-requests"

    if user.has_role(Role.APPLICATION_OWNER):
        q = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.status == "PENDING_APP_OWNER")
        if not is_admin:
            q = q.filter(models.ApplicationMaster.department.in_(user.departments))
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
            q = q.filter(models.ApplicationMaster.department.in_(user.departments))
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

# Readiness checkpoints belong to the shared QA Lead group. Legacy lead-ID
# columns remain in the model for historical records but no longer scope the
# queue. Each module actually has TWO consecutive QA-Lead-group checkpoints
# gated by the exact same has_role(QA_LEAD) check (see each module's own
# _require_assigned_qa_lead): "assigned_status" is the "Start Readiness
# Verification" stage (QA_LEAD_ASSIGNED / SECURITY_LEAD_ASSIGNED /
# ENGINEER_ASSIGNED -- e.g. functional.py::start_readiness_verification),
# and "verification_status" is the "Readiness Passed/Failed" decision stage
# right after it (e.g. functional.py::readiness_decision). Both surface
# here, not just the latter.
_READINESS_MODULES = [
    (models.FunctionalRequest, "FUNCTIONAL_REQUEST", "/functional-requests", "Functional Testing",
     QA_REQUEST_STATUS_LABELS, "qa_lead_id", "QA_LEAD_ASSIGNED", "READINESS_VERIFICATION"),
    (models.SASTRequest, "SAST", "/sast", "SAST", SAST_DAST_STATUS_LABELS, "security_lead_id",
     "SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS"),
    (models.DASTRequest, "DAST", "/dast", "DAST", SAST_DAST_STATUS_LABELS, "security_lead_id",
     "SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS"),
    (models.PerformanceRequest, "PERFORMANCE", "/performance", "Performance Testing", PERFORMANCE_STATUS_LABELS,
     "engineer_id", "ENGINEER_ASSIGNED", "READINESS"),
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
    workspace_ids = active_qa_workspace_scope_ids(user)
    for model, entity_type, path, module_label, labels in _SM_DEPT_HEAD_MODULES:
        if user.has_role(Role.SM):
            q = (
                db.query(model)
                .outerjoin(models.QARequest, model.qa_request_id == models.QARequest.id)
                .filter(model.status == "SM_APPROVAL_PENDING")
            )
            if workspace_ids:
                q = q.filter(models.QARequest.qa_workspace_id.in_(workspace_ids))
            if not is_admin:
                team_scope = department_unit_visibility_condition(
                    db, user, models.QARequest.department, models.QARequest.department_unit_id,
                )
                q = q.filter(
                    team_scope,
                    model.requester_id != user.id,
                )
            for obj in q.order_by(model.created_at).all():
                results.append(_item(
                    f"{module_label} -- SM Approval", entity_type, obj.id, obj.request_id,
                    f"{module_label}: {obj.application_name or '—'}", obj.status,
                    labels.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                    obj.created_at, _detail_path(path, obj.request_id, obj.id),
                    *_parent_context(obj),
                ))
        if user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
            q = (
                db.query(model)
                .outerjoin(models.QARequest, model.qa_request_id == models.QARequest.id)
                .filter(model.status == "DEPARTMENT_HEAD_APPROVAL_PENDING")
            )
            if workspace_ids:
                q = q.filter(models.QARequest.qa_workspace_id.in_(workspace_ids))
            if not is_admin:
                team_scope = department_unit_visibility_condition(
                    db, user, models.QARequest.department, models.QARequest.department_unit_id,
                )
                q = q.filter(
                    team_scope,
                    model.requester_id != user.id,
                )
            for obj in q.order_by(model.created_at).all():
                results.append(_item(
                    f"{module_label} -- Department Head Approval", entity_type, obj.id, obj.request_id,
                    f"{module_label}: {obj.application_name or '—'}", obj.status,
                    labels.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                    obj.created_at, _detail_path(path, obj.request_id, obj.id),
                    *_parent_context(obj),
                ))
    return results


def _readiness_items(db: Session, user: models.User) -> List[dict]:
    """Readiness checkpoints shared by every active QA Lead, plus the
    CHIEF_MANAGER_QA/AGM_QA Executive bypass (see ORACLE_MIGRATION_2026-07.md
    section 59) -- both the not-yet-started "Start Readiness Verification"
    stage and the in-progress "Readiness Passed/Failed" decision stage,
    since both are gated by the identical has_role(QA_LEAD, CHIEF_MANAGER_QA,
    AGM_QA) check on the backend (see each module's own
    _require_assigned_qa_lead)."""
    if not user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        return []
    results: List[dict] = []
    workspace_ids = active_qa_workspace_scope_ids(user)
    for (model, entity_type, path, module_label, labels, lead_column, assigned_status,
         verification_status) in _READINESS_MODULES:
        q = db.query(model).filter(model.status.in_([assigned_status, verification_status]))
        if workspace_ids:
            q = q.filter(model.qa_request_id.in_(select(models.QARequest.id).where(
                models.QARequest.qa_workspace_id.in_(workspace_ids))))
        for obj in q.order_by(model.created_at).all():
            action = "Start Readiness Verification" if obj.status == assigned_status else "Readiness Verification"
            results.append(_item(
                f"{module_label} -- {action}", entity_type, obj.id, obj.request_id,
                f"{module_label}: {obj.application_name or '—'}", obj.status,
                labels.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                obj.created_at, _detail_path(path, obj.request_id, obj.id),
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
    workspace_ids = active_qa_workspace_scope_ids(user)

    def _query(status: str):
        q = db.query(models.SuppressionRequest).filter(models.SuppressionRequest.status == status)
        return q.filter(models.SuppressionRequest.qa_workspace_id.in_(workspace_ids)) if workspace_ids else q

    if user.has_role(Role.SM):
        q = _query("SM_APPROVAL_PENDING")
        if not is_admin:
            q = q.filter(_suppression_team_scope_condition(db, user),
                         models.SuppressionRequest.created_by_id != user.id)
        for obj in q.order_by(models.SuppressionRequest.created_at).all():
            results.append(_item(
                "Suppression -- SM Approval", "SUPPRESSION", obj.id, obj.suppression_id,
                f"Suppression: {obj.application_name or '—'}", obj.status,
                SUPPRESSION_STATUS_LABELS.get(obj.status, obj.status), obj.department,
                _user_name(db, obj.created_by_id),
                obj.created_at, _detail_path("/suppression", obj.suppression_id, obj.id),
            ))
    if user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
        q = _query("DEPARTMENT_HEAD_APPROVAL_PENDING")
        if not is_admin:
            q = q.filter(_suppression_team_scope_condition(db, user),
                         models.SuppressionRequest.created_by_id != user.id)
        for obj in q.order_by(models.SuppressionRequest.created_at).all():
            results.append(_item(
                "Suppression -- Department Head Approval", "SUPPRESSION", obj.id, obj.suppression_id,
                f"Suppression: {obj.application_name or '—'}", obj.status,
                SUPPRESSION_STATUS_LABELS.get(obj.status, obj.status), obj.department,
                _user_name(db, obj.created_by_id),
                obj.created_at, _detail_path("/suppression", obj.suppression_id, obj.id),
            ))
    if user.has_role(Role.SECURITY_ANALYST):
        for obj in _query("SECURITY_TEAM_VERIFICATION").order_by(models.SuppressionRequest.created_at).all():
            results.append(_item(
                "Suppression -- Security Team Verification", "SUPPRESSION", obj.id, obj.suppression_id,
                f"Suppression: {obj.application_name or '—'}", obj.status,
                SUPPRESSION_STATUS_LABELS.get(obj.status, obj.status), obj.department,
                _user_name(db, obj.created_by_id),
                obj.created_at, _detail_path("/suppression", obj.suppression_id, obj.id),
            ))
    return results


def _signoff_items(db: Session, user: models.User) -> List[dict]:
    """QA Clearance checkpoints scoped to the selected workspace."""
    is_admin = user.has_role(Role.ADMIN)
    results: List[dict] = []
    workspace_id = active_qa_workspace_scope(user)
    workspace_ids = active_qa_workspace_scope_ids(user)
    if not is_admin and not user.has_qa_workspace_role(
        Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
        workspace_id=workspace_id,
    ):
        return []

    def _query(status: str):
        q = db.query(models.QASignOff).filter(models.QASignOff.status == status)
        if workspace_ids:
            q = q.filter(models.QASignOff.qa_workspace_id.in_(workspace_ids))
        if not is_admin:
            q = q.filter(models.QASignOff.requester_id != user.id)
        return q

    if user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        for obj in _query("SM_APPROVAL_PENDING").order_by(models.QASignOff.created_at).all():
            results.append(_item(
                "QA Clearance -- QA Lead Approval", "SIGNOFF", obj.id, obj.certificate_id,
                f"QA Clearance: {obj.application_name or '—'}", obj.status,
                SIGNOFF_STATUS_LABELS.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                obj.created_at, _detail_path("/signoff", obj.certificate_id, obj.id),
            ))
    if user.has_role(Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        q = _query("DEPT_HEAD_QA_APPROVAL_PENDING")
        if not is_admin:
            q = q.filter(or_(models.QASignOff.reviewed_by_id.is_(None), models.QASignOff.reviewed_by_id != user.id))
        for obj in q.order_by(models.QASignOff.created_at).all():
            results.append(_item(
                "QA Clearance -- Executive Approval", "SIGNOFF", obj.id, obj.certificate_id,
                f"QA Clearance: {obj.application_name or '—'}", obj.status,
                SIGNOFF_STATUS_LABELS.get(obj.status, obj.status), obj.department, _user_name(db, obj.requester_id),
                obj.created_at, _detail_path("/signoff", obj.certificate_id, obj.id),
            ))
    return results


def _test_project_items(db: Session, user: models.User) -> List[dict]:
    """Test Project activation/deactivation -- reported directly: "Project
    Activation, deactivation should need approval from QA lead." See
    routers/test_projects.py::review_project_activation -- QA Lead
    (QA_LEAD/CHIEF_MANAGER_QA/AGM_QA Executive bypass, see ORACLE_MIGRATION_
    2026-07.md section 59)/ADMIN only, org-wide (no department scoping, no
    requester exclusion -- mirrors that endpoint's own gate exactly, not
    invented here)."""
    if not user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        return []
    results: List[dict] = []
    q = db.query(models.TestProject).filter(models.TestProject.pending_is_active.isnot(None))
    workspace_ids = active_qa_workspace_scope_ids(user)
    if workspace_ids:
        q = q.filter(models.TestProject.qa_workspace_id.in_(workspace_ids))
    for obj in q.order_by(models.TestProject.pending_requested_at).all():
        action = "Reactivation" if obj.pending_is_active else "Deactivation"
        results.append(_item(
            "Test Project -- Activation Approval", "TEST_PROJECT", obj.id, obj.project_key,
            f"{action} requested: {obj.name}", "PENDING_ACTIVATION_APPROVAL",
            f"{action} Approval Pending", obj.department, obj.pending_requested_by_name,
            obj.pending_requested_at, _detail_path("/test-projects", obj.project_key, obj.id),
        ))
    return results


def _test_case_items(db: Session, user: models.User) -> List[dict]:
    """Return testcase decisions available to this user's workflow group."""
    results: List[dict] = []
    selected_workspace = getattr(user, "active_qa_workspace_id", None)
    contribution_access = {}
    checkpoints = (
        ("In Review", "Test Case -- Stage 1 QA Review"),
        ("Review Completed", "Test Case -- QA Management Approval"),
        ("Recommendation Pending", "Test Case -- QA Recommendation (Stage 1)"),
        ("QA Lead Approval Pending", "Test Case -- QA Lead Approval (Stage 2)"),
    )
    for status, category in checkpoints:
        q = (
            db.query(models.TestCaseVersion)
            .join(models.TestCase, models.TestCaseVersion.test_case_id == models.TestCase.id)
            .join(models.TestProject, models.TestCase.project_id == models.TestProject.id)
            .filter(models.TestCaseVersion.status == status,
                    models.TestCase.current_draft_version_id == models.TestCaseVersion.id,
                    models.TestCase.is_deleted == False, models.TestProject.is_active == True)
        )
        workspace_ids = active_qa_workspace_scope_ids(user)
        if selected_workspace is not None or workspace_ids:
            # Actions follow the content's creating workspace, not the shared
            # project's owner or a parent workspace's read-only child scope.
            q = q.filter(func.coalesce(models.TestCase.origin_workspace_id,
                                      models.TestProject.qa_workspace_id).in_(
                (selected_workspace,) if selected_workspace is not None else workspace_ids))
        for draft in q.order_by(models.TestCaseVersion.submitted_at).all():
            is_admin = user.has_role(Role.ADMIN)
            if not is_admin and draft.author_id == user.id:
                continue
            if not is_admin and status == "Recommendation Pending" and draft.submitted_by_id == user.id:
                continue
            if not is_admin and status == "QA Lead Approval Pending" and user.id in (draft.submitted_by_id, draft.reviewed_by_id):
                continue
            case = draft.test_case
            if not case:
                continue
            project = case.project
            if not project:
                continue
            if selected_workspace is not None:
                if project.id not in contribution_access:
                    contribution_access[project.id] = workspace_can_contribute(db, project.id, user)
                if not contribution_access[project.id]:
                    continue
            if not is_admin:
                eligible = (
                    can_review_repository(db, project.id, user) if status == "In Review"
                    else can_give_final_approval(db, project.id, user) if status == "Review Completed"
                    else user.has_role(Role.QA_ENGINEER) if status == "Recommendation Pending"
                    else user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)
                )
                if not eligible:
                    continue
            # Reported directly: "Parent Section should be Project Name, the
            # Folder wise testcase segregation" -- Test Case items have no
            # QA Request parent, so every pending test case used to fall
            # into the frontend's "standalone" bucket and render as its own
            # one-item card. Populating parent_request_id/parent_path with
            # the owning Test Project (parent_label="Test Project" so the
            # frontend doesn't mislabel it "Parent QA Request") groups every
            # pending test case from the same project under one card, and
            # folder_name sub-groups within it exactly like the Test
            # Repository's own folder tree does.
            results.append(_item(
                category, "TEST_CASE", case.id, case.test_case_key,
                f"Test Case: {case.test_scenario or case.test_case_key}", draft.status, draft.status,
                project.department if project else None,
                draft.submitted_by_name or draft.author_name, draft.submitted_at or draft.created_at,
                # Reported bug while tracing this: TestRepository.tsx never
                # reads a `case` query param (only `project` and `open`, the
                # latter matched against a test case's own key) -- `case=`
                # here was a dead link that opened the right project but not
                # the pending test case itself. Fixed to the param the page
                # actually consumes.
                f"/test-repository?project={case.project_id}&open={case.test_case_key}",
                parent_request_id=f"{project.project_key} — {project.name}" if project else None,
                parent_path=f"/test-repository?project={case.project_id}" if project else None,
                parent_label="Test Project",
                folder_name=case.folder_name or "Unfiled",
            ))
    return results


def _pending_count_statement(db: Session, user: models.User):
    """Count all actionable checkpoints in one database round trip.

    Login needs only one integer. Building the detailed feed there made its
    latency grow with every pending record because labels, links and related
    users/projects/folders were also hydrated. Each branch below mirrors its
    detailed-feed helper above, but returns only COUNT(*); UNION ALL lets
    Oracle evaluate all applicable branches in one request.
    """
    counts = []
    is_admin = user.has_role(Role.ADMIN)
    workspace_ids = active_qa_workspace_scope_ids(user)

    def add_count(model, *conditions, join=None):
        statement = select(func.count()).select_from(model)
        if join is not None:
            target, on_clause, is_outer = join
            statement = statement.join(target, on_clause, isouter=is_outer)
        scoped_conditions = list(conditions)
        if workspace_ids:
            if model in {models.FunctionalRequest, models.SASTRequest, models.DASTRequest, models.PerformanceRequest}:
                scoped_conditions.append(model.qa_request_id.in_(select(models.QARequest.id).where(
                    models.QARequest.qa_workspace_id.in_(workspace_ids))))
            elif model in {models.SuppressionRequest, models.QASignOff, models.TestProject}:
                scoped_conditions.append(model.qa_workspace_id.in_(workspace_ids))
            elif model is models.TestCaseVersion:
                scoped_conditions.append(models.TestCaseVersion.test_case.has(
                    or_(models.TestCase.origin_workspace_id.in_(workspace_ids),
                        (models.TestCase.origin_workspace_id.is_(None) & models.TestCase.project.has(models.TestProject.qa_workspace_id.in_(workspace_ids))))))
        counts.append(statement.where(*scoped_conditions))

    active_gateway = (
        select(models.QARequest.id)
        .where(
            models.QARequest.application_master_id == models.ApplicationMaster.id,
            models.QARequest.status.notin_([GatewayStatus.DRAFT, GatewayStatus.CANCELLED]),
            *([models.QARequest.qa_workspace_id.in_(workspace_ids)] if workspace_ids else []),
            *([department_unit_visibility_condition(
                db, user, models.QARequest.department, models.QARequest.department_unit_id,
            )] if not is_admin else []),
        )
        .exists()
    )
    if user.has_role(Role.APPLICATION_OWNER):
        conditions = [models.ApplicationMaster.status == "PENDING_APP_OWNER", active_gateway]
        if not is_admin:
            conditions.append(models.ApplicationMaster.department.in_(user.departments))
        add_count(models.ApplicationMaster, *conditions)
    if user.has_role(Role.SM):
        conditions = [models.ApplicationMaster.status == "PENDING_SM", active_gateway]
        if not is_admin:
            conditions.append(models.ApplicationMaster.department.in_(user.departments))
        add_count(models.ApplicationMaster, *conditions)

    for model, _entity_type, _path, _module_label, _labels in _SM_DEPT_HEAD_MODULES:
        if user.has_role(Role.SM):
            conditions = [model.status == "SM_APPROVAL_PENDING"]
            if not is_admin:
                conditions.extend([
                    department_unit_visibility_condition(
                        db, user, models.QARequest.department, models.QARequest.department_unit_id,
                    ),
                    model.requester_id != user.id,
                ])
            add_count(model, *conditions, join=(models.QARequest, model.qa_request_id == models.QARequest.id, True))
        if user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
            conditions = [model.status == "DEPARTMENT_HEAD_APPROVAL_PENDING"]
            if not is_admin:
                conditions.extend([
                    department_unit_visibility_condition(
                        db, user, models.QARequest.department, models.QARequest.department_unit_id,
                    ),
                    model.requester_id != user.id,
                ])
            add_count(model, *conditions, join=(models.QARequest, model.qa_request_id == models.QARequest.id, True))

    if user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        for (model, _entity_type, _path, _module_label, _labels, _lead_column,
             assigned_status, verification_status) in _READINESS_MODULES:
            conditions = [model.status.in_([assigned_status, verification_status])]
            add_count(model, *conditions, join=(models.QARequest, model.qa_request_id == models.QARequest.id, True))

    if user.has_role(Role.SM):
        conditions = [models.SuppressionRequest.status == "SM_APPROVAL_PENDING"]
        if not is_admin:
            conditions.extend([
                _suppression_team_scope_condition(db, user),
                models.SuppressionRequest.created_by_id != user.id,
            ])
        add_count(models.SuppressionRequest, *conditions)
    if user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
        conditions = [models.SuppressionRequest.status == "DEPARTMENT_HEAD_APPROVAL_PENDING"]
        if not is_admin:
            conditions.extend([
                _suppression_team_scope_condition(db, user),
                models.SuppressionRequest.created_by_id != user.id,
            ])
        add_count(models.SuppressionRequest, *conditions)
    if user.has_role(Role.SECURITY_ANALYST):
        add_count(models.SuppressionRequest, models.SuppressionRequest.status == "SECURITY_TEAM_VERIFICATION")

    workspace_id = active_qa_workspace_scope(user)
    if is_admin or user.has_qa_workspace_role(
        Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
        workspace_id=workspace_id,
    ):
        if user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
            conditions = [models.QASignOff.status == "SM_APPROVAL_PENDING"]
            if not is_admin:
                conditions.append(models.QASignOff.requester_id != user.id)
            add_count(models.QASignOff, *conditions)
        if user.has_role(Role.CHIEF_MANAGER_QA, Role.AGM_QA):
            conditions = [models.QASignOff.status == "DEPT_HEAD_QA_APPROVAL_PENDING"]
            if not is_admin:
                conditions.extend([
                    models.QASignOff.requester_id != user.id,
                    or_(models.QASignOff.reviewed_by_id.is_(None), models.QASignOff.reviewed_by_id != user.id),
                ])
            add_count(models.QASignOff, *conditions)

    if user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        add_count(models.TestProject, models.TestProject.pending_is_active.isnot(None))

    if not counts:
        return select(func.count()).select_from(models.User).where(models.User.id == -1)
    return union_all(*counts)


@router.get("/count", response_model=schemas.PendingApprovalCount)
@workflow_endpoint
def count_pending_approvals(db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    """Fast login summary without materializing the detailed approval feed."""
    if is_system_admin(current_user):
        return {"count": len(_actionable_items(db, current_user))}
    branch_counts = db.execute(_pending_count_statement(db, current_user)).scalars().all()
    return {"count": sum(int(value or 0) for value in branch_counts) + len(_test_case_items(db, current_user))}


@router.get("", response_model=schemas.PendingApprovalPage)
@workflow_endpoint
def list_pending_approvals(
    params: pagination.PageParams = Depends(),
    category: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Everything genuinely awaiting the logged-in user's own decision right
    now, across every approval checkpoint in the app, using explicit workflow authority. Sorted oldest-submitted-first within the combined list (the
    frontend groups by category for display, but age is what should drive
    priority within a category)."""
    return _paginate_pending_items(_actionable_items(db, current_user), params, category)


def _actionable_items(db, current_user):
    items = (
        _application_master_items(db, current_user)
        + _sm_dept_head_items(db, current_user)
        + _readiness_items(db, current_user)
        + _suppression_items(db, current_user)
        + _signoff_items(db, current_user)
        + _test_project_items(db, current_user)
        + _test_case_items(db, current_user)
    )
    return [item for item in items if admin_department_allowed(current_user, item["department"])]
