"""Global workspace access and legacy request-routing compatibility."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from fastapi import HTTPException
from sqlalchemy import inspect
from sqlalchemy.orm import Session

from . import models
from .constants import Role

QA_WORKSPACE_ROLES = {
    "WORKSPACE_MEMBER", "WORKSPACE_VIEWER", "PARENT_WORKSPACE_VIEWER", "PARENT_WORKSPACE_ADMIN",
    "QA_ENGINEER", "QA_LEAD", "SECURITY_ANALYST", "CHIEF_MANAGER_QA", "AGM_QA",
}

PARENT_WORKSPACE_ROLES = {"PARENT_WORKSPACE_VIEWER", "PARENT_WORKSPACE_ADMIN"}


def ensure_administrator_workspace_memberships(
    db: Session,
    *,
    user: models.User | None = None,
    workspace: models.QAWorkspace | None = None,
) -> bool:
    """Keep every System Administrator in every workspace.

    A caller may limit synchronization to one user (after granting ADMIN) or
    one workspace (during workspace creation). With neither supplied, the
    function repairs the complete administrator/workspace matrix.
    """
    changed = False
    users_query = db.query(models.User).join(models.UserRole).filter(
        models.UserRole.role == Role.ADMIN,
    )
    if user is not None:
        if not user.has_role(Role.ADMIN):
            return False
        administrators = [user]
    else:
        administrators = users_query.all()

    workspaces = [workspace] if workspace is not None else db.query(models.QAWorkspace).all()
    for administrator in administrators:
        for target_workspace in workspaces:
            membership = db.query(models.QAWorkspaceMember).filter_by(
                workspace_id=target_workspace.id,
                user_id=administrator.id,
                role="WORKSPACE_MEMBER",
            ).first()
            if membership is None:
                db.add(models.QAWorkspaceMember(
                    workspace_id=target_workspace.id,
                    user_id=administrator.id,
                    role="WORKSPACE_MEMBER",
                    is_active=True,
                ))
                changed = True
            else:
                changed = changed or not membership.is_active
                membership.is_active = True
        if administrator.preferred_qa_workspace_id is None and workspaces:
            default = next((row for row in workspaces if row.is_default and row.is_active), None)
            first_active = next((row for row in workspaces if row.is_active), None)
            selected = default or first_active
            if selected is not None:
                administrator.preferred_qa_workspace_id = selected.id
                changed = True
    return changed

# Request-local workspace boundary.  This lets shared analytics helpers apply
# the selected workspace even where the older API only passed department
# scope through several layers of query builders.
_current_workspace_id: ContextVar[int | None] = ContextVar("qa_workspace_id", default=None)
_current_workspace_scope_ids: ContextVar[tuple[int, ...]] = ContextVar(
    "qa_workspace_scope_ids", default=(),
)


def set_current_workspace_id(workspace_id: int | None) -> None:
    _current_workspace_id.set(workspace_id)


def current_workspace_id() -> int | None:
    return _current_workspace_id.get()


def set_current_workspace_scope_ids(workspace_ids: set[int] | list[int] | tuple[int, ...]) -> None:
    _current_workspace_scope_ids.set(tuple(sorted(set(workspace_ids))))


def current_workspace_scope_ids() -> tuple[int, ...]:
    """Workspace IDs visible through the active parent/child context."""
    return _current_workspace_scope_ids.get()


@contextmanager
def workspace_context(workspace_id, scope_ids):
    """Bind and restore tenant context on the task that dispatches handlers."""
    selected_token = _current_workspace_id.set(workspace_id)
    scope_token = _current_workspace_scope_ids.set(tuple(sorted(set(scope_ids))))
    try:
        yield
    finally:
        _current_workspace_scope_ids.reset(scope_token)
        _current_workspace_id.reset(selected_token)


def require_active_workspace(user: models.User) -> int:
    """Return the selected global workspace or fail closed."""
    workspace_id = getattr(user, "active_qa_workspace_id", None)
    if workspace_id is None:
        ids = active_workspace_ids(user)
        workspace_id = next(iter(ids)) if len(ids) == 1 else None
    if workspace_id is None:
        raise HTTPException(403, "Select a workspace before creating or changing records")
    return workspace_id


def ensure_default_workspace_membership(db: Session, user: models.User) -> bool:
    """Ensure a user without active access belongs to the Default Workspace.

    Returns ``True`` when the session was changed.  This is also the repair
    path for older users created before global workspace membership existed.
    """
    # A few narrow unit-test schemas intentionally create only the User and
    # role tables. Production migrations always create these objects.
    inspector = inspect(db.connection())
    if not inspector.has_table(models.QAWorkspace.__tablename__):
        return False
    if not inspector.has_table(models.QAWorkspaceMember.__tablename__):
        return False
    if user.has_role(Role.ADMIN):
        return ensure_administrator_workspace_memberships(db, user=user)
    if any(
        membership.is_active and membership.workspace and membership.workspace.is_active
        for membership in user.qa_workspace_memberships
    ):
        return False
    workspace = db.query(models.QAWorkspace).filter(
        models.QAWorkspace.is_active == True,  # noqa: E712
        models.QAWorkspace.is_default == True,  # noqa: E712
    ).order_by(models.QAWorkspace.id).first()
    if workspace is None:
        return False

    # Removing a user can leave an inactive historical membership. Reactivate
    # that row rather than inserting a duplicate workspace/user/role tuple.
    membership = next((
        row for row in user.qa_workspace_memberships
        if row.workspace_id == workspace.id and row.role == "WORKSPACE_MEMBER"
    ), None)
    if membership is None:
        user.qa_workspace_memberships.append(models.QAWorkspaceMember(
            workspace_id=workspace.id, role="WORKSPACE_MEMBER", is_active=True,
        ))
    else:
        membership.is_active = True
    user.preferred_qa_workspace_id = workspace.id
    return True


def remove_default_membership_after_assignment(
    db: Session,
    user: models.User,
    workspace_id: int,
) -> None:
    """Make DEFAULT a fallback once a normal user joins a real workspace."""
    workspace = db.get(models.QAWorkspace, workspace_id)
    if workspace is None or workspace.is_default or user.has_role(Role.ADMIN):
        return
    default_ids = [
        row_id for (row_id,) in db.query(models.QAWorkspace.id).filter(
            models.QAWorkspace.is_default == True,  # noqa: E712
        )
    ]
    if not default_ids:
        return
    db.query(models.QAWorkspaceMember).filter(
        models.QAWorkspaceMember.user_id == user.id,
        models.QAWorkspaceMember.workspace_id.in_(default_ids),
    ).delete(synchronize_session=False)
    if user.preferred_qa_workspace_id in default_ids:
        user.preferred_qa_workspace_id = workspace_id


def active_workspace_ids(user: models.User) -> set[int]:
    return {row.workspace_id for row in user.qa_workspace_access}


def active_workspace_scope_ids(
    db: Session,
    user: models.User,
    selected_workspace_id: int | None = None,
) -> set[int]:
    """Return the safe data scope for the selected workspace.

    A leaf workspace sees only itself. A parent workspace ordinarily
    consolidates its own records plus child workspaces the user can access.
    An explicit Parent Workspace Viewer/Admin grant on the selected parent
    includes every active direct child without creating duplicate child
    memberships. Administrators are required members everywhere, so they
    also receive the complete child set.
    """
    selected = selected_workspace_id
    if selected is None:
        selected = getattr(user, "active_qa_workspace_id", None)
    if selected is None:
        return set()
    # Parent-scoped grants are real access even though they deliberately do
    # not create duplicate membership rows on every child. This includes the
    # explicit Parent Viewer/Admin roles and a Department Coordinator grant
    # placed on a top-level workspace.
    accessible = selectable_workspace_ids(db, user)
    if selected not in accessible:
        return set()
    scope = {selected}
    child_ids = {
        workspace_id for (workspace_id,) in db.query(models.QAWorkspace.id).filter(
            models.QAWorkspace.parent_workspace_id == selected,
            models.QAWorkspace.is_active == True,  # noqa: E712
        )
    }
    inherited = user.has_role(Role.ADMIN) or any(
        membership.is_active
        and membership.workspace_id == selected
        and membership.role in PARENT_WORKSPACE_ROLES
        for membership in user.qa_workspace_memberships
    )
    scope.update(child_ids if inherited else (child_ids & accessible))
    return scope


def inherited_workspace_access_mode(db: Session, user: models.User, workspace_id: int | None) -> str | None:
    """Return DIRECT, PARENT_VIEWER, or PARENT_ADMIN for one workspace.

    A direct child membership wins over a viewer grant inherited from its
    parent, so explicitly adding someone to a child preserves their normal
    operational permissions there.
    """
    if workspace_id is None:
        return None
    if user.has_role(Role.ADMIN):
        return "PARENT_ADMIN"
    direct_roles = {
        membership.role for membership in user.qa_workspace_memberships
        if membership.is_active and membership.workspace_id == workspace_id
    }
    if "PARENT_WORKSPACE_ADMIN" in direct_roles:
        return "PARENT_ADMIN"
    if "PARENT_WORKSPACE_VIEWER" in direct_roles:
        return "PARENT_VIEWER"
    if direct_roles:
        return "DIRECT"
    workspace = db.get(models.QAWorkspace, workspace_id)
    if workspace is None or workspace.parent_workspace_id is None:
        return None
    parent_roles = {
        membership.role for membership in user.qa_workspace_memberships
        if membership.is_active and membership.workspace_id == workspace.parent_workspace_id
    }
    if "PARENT_WORKSPACE_ADMIN" in parent_roles:
        return "PARENT_ADMIN"
    if "PARENT_WORKSPACE_VIEWER" in parent_roles:
        return "PARENT_VIEWER"
    return None


def selectable_workspace_ids(db: Session, user: models.User) -> set[int]:
    """Direct memberships plus children inherited through parent-scoped grants.

    A Department Coordinator assignment on a top-level workspace follows the
    same hierarchy boundary as Parent Viewer/Admin: it applies to every active
    direct child. Assigning the coordinator on a child remains child-only.
    """
    ids = active_workspace_ids(user)
    privileged_parent_ids = {
        membership.workspace_id for membership in user.qa_workspace_memberships
        if membership.is_active and membership.role in PARENT_WORKSPACE_ROLES
    }
    coordinator_parent_ids = {
        assignment.workspace_id for assignment in user.department_coordinator_access
        if assignment.is_active and assignment.workspace
        and assignment.workspace.is_active
        and assignment.workspace.parent_workspace_id is None
    }
    inherited_parent_ids = privileged_parent_ids | coordinator_parent_ids
    if inherited_parent_ids:
        ids.update(
            workspace_id for (workspace_id,) in db.query(models.QAWorkspace.id).filter(
                models.QAWorkspace.parent_workspace_id.in_(inherited_parent_ids),
                models.QAWorkspace.is_active == True,  # noqa: E712
            )
        )
    return ids


def can_administer_workspace(user: models.User, workspace: models.QAWorkspace | None) -> bool:
    """System Admin globally, or Parent Admin across its managed workspace tree."""
    if user.has_role(Role.ADMIN):
        return True
    if workspace is None:
        return False
    managed_parent_id = workspace.parent_workspace_id or workspace.id
    return any(
        membership.is_active
        and membership.workspace_id == managed_parent_id
        and membership.role == "PARENT_WORKSPACE_ADMIN"
        for membership in user.qa_workspace_memberships
    )


def can_configure_workspace(user: models.User, workspace: models.QAWorkspace | None) -> bool:
    """Only System Admin may change workspace identity, hierarchy or routing."""
    return bool(workspace is not None and user.has_role(Role.ADMIN))


def can_manage_workspace_members(user: models.User, workspace: models.QAWorkspace | None) -> bool:
    """System Admin globally, or Parent Admin across its managed workspace tree."""
    return can_administer_workspace(user, workspace)


def can_create_child_workspace(user: models.User, parent: models.QAWorkspace | None) -> bool:
    return user.has_role(Role.ADMIN)


def has_workspace_access(user: models.User, workspace_id: int | None = None, *roles: str) -> bool:
    return user.has_qa_workspace_role(*roles, workspace_id=workspace_id, allow_admin=False)


def resolve_workspace(
    db: Session,
    *,
    department_name: str | None,
    application_master_id: int | None,
    department_unit_id: int | None = None,
    request_types: list[str] | None = None,
) -> tuple[models.QAWorkspace | None, str]:
    """Resolve a route without silently choosing between equally specific teams.

    Specific application rules win, followed by department + request type,
    department defaults, and finally the single organisation default.
    Priority breaks ties only within the same specificity.
    """
    department_id = None
    if department_name:
        department = db.query(models.Department).filter(
            models.Department.name == department_name,
            models.Department.is_active == True,  # noqa: E712
        ).first()
        department_id = department.id if department else None
    requested_types = {value.strip() for value in (request_types or []) if value and value.strip()}
    rows = db.query(models.QAWorkspaceCoverage).join(models.QAWorkspace).filter(
        models.QAWorkspaceCoverage.is_active == True,  # noqa: E712
        models.QAWorkspace.is_active == True,  # noqa: E712
    ).all()
    candidates: list[tuple[int, int, int, models.QAWorkspace]] = []
    for row in rows:
        if row.application_master_id is not None and row.application_master_id != application_master_id:
            continue
        if row.department_id is not None and row.department_id != department_id:
            continue
        if row.department_unit_id is not None:
            continue
        if row.request_type is not None and row.request_type not in requested_types:
            continue
        specificity = (
            (4 if row.application_master_id is not None else 0)
            + (2 if row.department_id is not None else 0)
            + (1 if row.request_type is not None else 0)
        )
        candidates.append((specificity, 0, row.priority, row.workspace))
    if candidates:
        candidates.sort(key=lambda item: (-item[0], item[1], item[2], item[3].id))
        best_specificity, best_distance, best_priority, best = candidates[0]
        tied = {workspace.id for specificity, distance, priority, workspace in candidates
                if specificity == best_specificity and distance == best_distance and priority == best_priority}
        if len(tied) > 1:
            return None, "AMBIGUOUS"
        return best, "ROUTED"
    defaults = db.query(models.QAWorkspace).filter(
        models.QAWorkspace.is_active == True,  # noqa: E712
        models.QAWorkspace.is_default == True,  # noqa: E712
    ).all()
    if len(defaults) == 1:
        return defaults[0], "ROUTED_DEFAULT"
    return None, "ROUTING_REQUIRED"


def route_request(db: Session, request: models.QARequest) -> None:
    workspace, status = resolve_workspace(
        db,
        department_name=request.department,
        department_unit_id=request.department_unit_id,
        application_master_id=request.application_master_id,
        request_types=(request.request_types or "").split(","),
    )
    request.qa_workspace_id = workspace.id if workspace else None
    request.workspace_routing_status = status
