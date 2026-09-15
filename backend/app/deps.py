from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from starlette.concurrency import run_in_threadpool
from jose import JWTError
from sqlalchemy import and_, false, func, or_, true
from sqlalchemy.orm import Session, selectinload

from .database import SessionLocal, get_db
from . import models
from .auth import decode_access_token
from .constants import Role

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

_SAFE_READ_METHODS = {"GET", "HEAD", "OPTIONS"}
_VIEW_ONLY_SELF_SERVICE_PATHS = {"/api/auth/logout", "/api/auth/renew", "/api/auth/me/email"}
_VIEW_ONLY_READ_OPERATION_POST_PATHS = {"/api/document-portal/download-selection"}
_VIEW_ONLY_ROLE_GATED_READ_PREFIXES = (
    "/api/qa-requests",
    "/api/functional-requests",
    "/api/sast-requests",
    "/api/dast-requests",
    "/api/performance-requests",
    "/api/suppressions",
    "/api/signoffs",
    "/api/approvals",
    "/api/dashboard",
    "/api/export",
    "/api/test-projects",
    "/api/test-repository",
    "/api/test-execution",
    "/api/test-reports",
    "/api/defects",
    "/api/application-names",
)

_NO_WORKSPACE_SELF_SERVICE_PATHS = {
    "/api/auth/me",
    "/api/auth/me/email",
    "/api/auth/logout",
    "/api/auth/renew",
}


def _enforce_view_only_request(
    request: Request,
    user: models.User,
    db: Session | None = None,
) -> None:
    """Fail closed for the organisation-wide View Only permission profile.

    Endpoint role checks remain the source of truth for operational roles;
    this additional boundary guarantees that a View Only account cannot
    mutate business data through a direct API call or a stale browser page.
    Logout and completion of the user's own required LDAP email are the only
    non-read self-service operations allowed.
    """
    if Role.VIEW_ONLY not in user.roles:
        return
    if request.method.upper() in _SAFE_READ_METHODS:
        return
    if request.url.path in _VIEW_ONLY_SELF_SERVICE_PATHS:
        return
    selected_workspace_id = getattr(user, "active_qa_workspace_id", None)
    selected_workspace = (
        db.get(models.QAWorkspace, selected_workspace_id)
        if db is not None and selected_workspace_id else None
    )
    coordinator_scope_ids = {
        selected_workspace_id,
        selected_workspace.parent_workspace_id if selected_workspace else None,
    }
    if db is not None and request.url.path.startswith("/api/auth/local-admin") and any(
        assignment.is_active and assignment.workspace_id in coordinator_scope_ids
        for assignment in user.department_coordinator_access
    ):
        # Department Coordinator is an explicit, tightly-scoped management
        # grant. It remains usable even when the person's ordinary permission
        # profile is View Only.
        return
    # Document Portal has its own independent permission profile. Combining
    # VIEW_ONLY with Contributor/Manager keeps core workflow data read-only
    # while still honoring the explicitly assigned document capability.
    if (
        request.url.path.startswith("/api/document-portal")
        and user.has_role(Role.DOCUMENT_PORTAL_CONTRIBUTOR, Role.DOCUMENT_PORTAL_MANAGER)
    ):
        return
    if (
        request.url.path in _VIEW_ONLY_READ_OPERATION_POST_PATHS
        or request.url.path.endswith("/export-xlsx/jobs")
    ):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Your View Only role does not permit creating, changing, approving, uploading, or deleting data.",
    )


def _enforce_parent_workspace_viewer_request(request: Request, access_mode: str | None) -> None:
    """Make an inherited Parent Viewer grant read-only at the API boundary."""
    if access_mode != "PARENT_VIEWER" or request.method.upper() in _SAFE_READ_METHODS:
        return
    if request.url.path in (
        _VIEW_ONLY_SELF_SERVICE_PATHS
        | {"/api/workspaces/preference/current", "/api/qa-workspaces/preference/current"}
    ):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Parent Workspace Viewer access is read-only across this workspace hierarchy.",
    )


def _resolve_current_user(request: Request, token: str, db: Session) -> models.User:
    """Resolve an authenticated user while the supplied session is open."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_access_token(token)
        username = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # role_assignments eagerly loaded (selectinload, a second targeted query
    # rather than a join) so `user.roles`/`user.roles_csv` are cheap to
    # compute below without a lazy-load-per-role-check surprise elsewhere in
    # this same request.
    user = (
        db.query(models.User)
        .options(
            selectinload(models.User.role_assignments),
            selectinload(models.User.department_assignments),
            selectinload(models.User.qa_workspace_memberships).selectinload(models.QAWorkspaceMember.workspace),
            selectinload(models.User.department_coordinator_assignments).selectinload(models.DepartmentCoordinatorAssignment.workspace),
            selectinload(models.User.department_coordinator_assignments).selectinload(models.DepartmentCoordinatorAssignment.department),
            selectinload(models.User.department_coordinator_assignments).selectinload(models.DepartmentCoordinatorAssignment.department_unit),
        )
        .filter(models.User.username == username)
        .first()
    )
    if user is None or not user.is_active:
        raise credentials_exception
    # X-Workspace-ID is the public tenant selector. Keep the old header as a
    # temporary compatibility fallback for already-open clients.
    workspace_header = (
        request.headers.get("X-Workspace-ID")
        or request.headers.get("X-QA-Workspace-ID")
        or ""
    ).strip()
    from .workspace_service import (
        ensure_default_workspace_membership,
        inherited_workspace_access_mode,
        selectable_workspace_ids,
    )
    workspace_ids = selectable_workspace_ids(db, user)
    access_review_complete = bool(user.roles) and not (
        user.needs_department_selection or user.needs_role_review
    )
    if access_review_complete and not workspace_ids:
        # Older/seeded accounts may predate workspace membership. Repair the
        # invariant once at authentication time so they enter the explicit
        # Default Workspace instead of receiving an unscoped portal session.
        if ensure_default_workspace_membership(db, user):
            db.commit()
            db.refresh(user)
            workspace_ids = selectable_workspace_ids(db, user)
    if (
        not workspace_ids
        and request.url.path not in _NO_WORKSPACE_SELF_SERVICE_PATHS
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No active workspace access is assigned to your account.",
        )
    preferred = user.preferred_qa_workspace_id
    fallback_workspace_id = (
        preferred if preferred in workspace_ids else next(iter(workspace_ids), None)
    )
    if workspace_header:
        try:
            selected_workspace_id = int(workspace_header)
        except ValueError:
            raise HTTPException(status_code=400, detail="X-Workspace-ID must be a numeric workspace ID")
        if selected_workspace_id not in workspace_ids:
            # A browser can retain the previous account's workspace, or the
            # Default Workspace that was selected before a first-login access
            # request was approved. Identity/self-service calls must be able
            # to recover that session so the client can learn the server's
            # valid selection. Business endpoints remain fail-closed.
            if request.url.path in _NO_WORKSPACE_SELF_SERVICE_PATHS:
                selected_workspace_id = fallback_workspace_id
            else:
                raise HTTPException(status_code=403, detail="You do not have access to the selected workspace")
        user.active_qa_workspace_id = selected_workspace_id
    else:
        user.active_qa_workspace_id = fallback_workspace_id
    from .workspace_service import (
        active_workspace_scope_ids, set_current_workspace_id,
        set_current_workspace_scope_ids,
    )
    selected_workspace_id = getattr(user, "active_qa_workspace_id", None)
    set_current_workspace_id(selected_workspace_id)
    user.active_workspace_scope_ids = tuple(
        active_workspace_scope_ids(db, user, selected_workspace_id)
        if selected_workspace_id is not None else set()
    )
    set_current_workspace_scope_ids(user.active_workspace_scope_ids)
    access_mode = inherited_workspace_access_mode(db, user, selected_workspace_id)
    _enforce_parent_workspace_viewer_request(request, access_mode)
    _enforce_view_only_request(request, user, db)
    from .workflow_authority import configure_request
    configure_request(db, user, request, workflow=bool(getattr(request.state, "workflow_operation", False)))
    from .project_workspace_ownership import bind_actor, guard_request
    bind_actor(db, user)
    guard_request(db, user, request)
    # AUD-008 -- stash the already-resolved user on the request so
    # main.py's _write_request_audit (which runs after the response, as a
    # BackgroundTask on this same request object) can reuse it instead of
    # decoding the JWT and querying User a second time.
    request.state.current_user = user
    # ...but _write_request_audit must NOT read attributes off that object
    # directly -- by the time it runs, `db` (this request's own session) is
    # already closed. A DetachedInstanceError follows the very first
    # attribute touch that isn't already resolved AND unexpired: reported
    # directly, twice. First via `.roles_csv` -> `.role_assignments`, an
    # unloaded relationship nothing in a plain read-only request happened to
    # touch. Then, after that relationship was eager-loaded above, via the
    # plainer `.username` -- a column that WAS already loaded, but got
    # expired anyway by SQLAlchemy's default expire_on_commit=True the
    # moment any mutating request's handler called db.commit(), which
    # invalidates every already-loaded attribute on every object tied to
    # that session, not just the ones a schema/property touched. Eager-
    # loading a relationship only ever fixes the first failure mode, not
    # the second -- there is no way to defensively "preload enough" to
    # survive a session that may later expire everything wholesale.
    # The only reliable fix is to never touch the ORM object across that
    # session boundary at all: snapshot the plain values _write_request_audit
    # actually needs into an ordinary dict, here, while `db` is unquestionably
    # open and nothing is expired yet.
    request.state.current_user_snapshot = {
        "id": user.id, "username": user.username, "full_name": user.full_name, "roles_csv": user.roles_csv,
    }
    return user


async def get_current_user(
    request: Request, token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> models.User:
    """Core-API user dependency; its request session is closed after the response."""
    from .workspace_service import workspace_context
    user = await run_in_threadpool(_resolve_current_user, request, token, db)
    from .workflow_authority import workflow_context
    with workspace_context(user.active_qa_workspace_id, user.active_workspace_scope_ids), workflow_context(
        user, enabled=bool(getattr(request.state, "workflow_operation", False)),
    ):
        yield user


def _resolve_document_portal_user(
    request: Request, token: str = Depends(oauth2_scheme),
) -> models.User:
    """Authenticate a Document Portal request without pinning an Oracle session.

    File uploads, downloads and ZIP streams can run for minutes. A normal
    FastAPI generator dependency closes its database session only after that
    response has finished streaming, which would let a few document transfers
    exhaust this service's deliberately small Oracle pool. Resolve the user,
    eagerly load the role/department assignments, then detach and close the
    session before the filesystem operation begins.
    """
    with SessionLocal() as db:
        user = _resolve_current_user(request, token, db)
        db.expunge(user)
        return user


async def get_document_portal_current_user(
    request: Request, token: str = Depends(oauth2_scheme),
):
    from .workspace_service import workspace_context
    user = await run_in_threadpool(_resolve_document_portal_user, request, token)
    from .workflow_authority import workflow_context
    with workspace_context(user.active_qa_workspace_id, user.active_workspace_scope_ids), workflow_context(
        user, enabled=bool(getattr(request.state, "workflow_operation", False)),
    ):
        yield user


async def get_workflow_user(
    request: Request, token: str = Depends(oauth2_scheme), db: Session = Depends(get_db),
):
    """Explicit operational authority; administrator privileges do not qualify."""
    request.state.workflow_operation = True
    from .workspace_service import workspace_context
    from .workflow_authority import workflow_context
    user = await run_in_threadpool(_resolve_current_user, request, token, db)
    with workspace_context(user.active_qa_workspace_id, user.active_workspace_scope_ids), workflow_context(user):
        yield user


def require_workflow_roles(*roles):
    return require_roles(*roles, workflow=True)


def require_roles(*roles, workflow=False):
    """Dependency factory: restricts an endpoint to users holding at least one
    of the given roles (ADMIN always allowed). A user may hold several roles
    at once -- all are active simultaneously, so this passes if ANY assigned
    role qualifies."""
    def checker(request: Request, current_user: models.User = Depends(get_workflow_user if workflow else get_current_user)) -> models.User:
        view_only_read = request.method.upper() in _SAFE_READ_METHODS
        view_only_export_job = request.url.path.endswith("/export-xlsx/jobs")
        if (
            Role.VIEW_ONLY in current_user.roles
            and (view_only_read or view_only_export_job)
            and request.url.path.startswith(_VIEW_ONLY_ROLE_GATED_READ_PREFIXES)
        ):
            return current_user
        workspace_roles = {Role.QA_ENGINEER, Role.QA_LEAD, Role.SECURITY_ANALYST, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
        requested_workspace_roles = workspace_roles & set(roles)
        permitted = current_user.has_role(*roles)
        if requested_workspace_roles and not current_user.has_role(Role.ADMIN):
            permitted = current_user.has_qa_workspace_role(
                *requested_workspace_roles,
                workspace_id=getattr(current_user, "active_qa_workspace_id", None),
            )
        if not permitted:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"None of your roles ({', '.join(current_user.roles) or 'none assigned'}) "
                       f"are permitted to perform this action.",
            )
        return current_user
    return checker


def require_document_portal_viewer(current_user: models.User = Depends(get_document_portal_current_user)) -> models.User:
    if not current_user.has_role(
        Role.DOCUMENT_PORTAL_VIEWER, Role.DOCUMENT_PORTAL_CONTRIBUTOR, Role.DOCUMENT_PORTAL_MANAGER,
    ):
        raise HTTPException(status_code=403, detail="You do not have access to Document Management")
    _require_ldap_notification_email(current_user)
    return current_user


def require_document_portal_contributor(current_user: models.User = Depends(get_document_portal_current_user)) -> models.User:
    if not current_user.has_role(Role.DOCUMENT_PORTAL_CONTRIBUTOR, Role.DOCUMENT_PORTAL_MANAGER):
        raise HTTPException(status_code=403, detail="You have view-only Document Management access")
    _require_ldap_notification_email(current_user)
    return current_user


def require_document_portal_manager(current_user: models.User = Depends(get_document_portal_current_user)) -> models.User:
    """Allow destructive Document Portal operations only to its manager role."""
    if not current_user.has_role(Role.DOCUMENT_PORTAL_MANAGER):
        raise HTTPException(status_code=403, detail="Only a Document Portal Manager can delete documents or folders")
    _require_ldap_notification_email(current_user)
    return current_user


def _require_ldap_notification_email(current_user: models.User) -> None:
    """Mirror the core API's mandatory LDAP email-completion guard.

    Document Portal runs in a separate process and therefore cannot rely on
    core ``main.py`` middleware.  Keeping this check in the shared document
    access dependencies closes the direct-URL bypass while allowing first
    login department selection/access review to complete normally.
    """
    if (
        current_user.login_type == "LDAP"
        and not current_user.needs_department_selection
        and not current_user.needs_role_review
        and current_user.roles
        and not (current_user.email or "").strip()
    ):
        raise HTTPException(
            status_code=403,
            detail="Add your notification email address before using QA Portal.",
        )


def require_same_department(current_user: models.User, entity_department) -> None:
    """Business-side approval checkpoints (SM, Department Head) may only be
    actioned by someone in the SAME department as the request they're
    approving -- e.g. a requester from DBD can only be approved by an SM/
    Department Head who is also mapped to DBD. This does NOT apply to the QA
    side of the workflow (QA Lead / QA Engineer / Security Analyst readiness,
    scanning, security-complete, report-ready, etc.) since QA is the team
    *receiving* the request, not a same-department stakeholder -- callers
    should only invoke this from the SM/Department Head decision endpoints.
    ADMIN always bypasses this check.

    A missing entity department fails closed for non-Admin users. Allowing
    it through would make a malformed/legacy record actionable by every SM
    or Department Head regardless of business ownership.
    """
    if current_user.has_role(Role.ADMIN):
        return
    if not entity_department:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This record has no department ownership and cannot be accessed until its linkage is repaired.",
        )
    # 2026-08 "one user can be on multiple departments" CR -- any overlap
    # between the request's department and ANY of the approver's own
    # departments is sufficient, not just their primary one.
    if not current_user.has_department(entity_department):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"You can only act on requests from your own department. This request belongs to "
                f"'{entity_department}', but your profile is mapped to "
                f"'{', '.join(current_user.departments) or 'no department'}'."
            ),
        )


def require_department_visibility(
    current_user: models.User,
    entity_department: Optional[str],
    *,
    requester_id: Optional[int] = None,
    delegated: bool = False,
    entity_workspace_id: Optional[int] = None,
) -> None:
    """Enforce the same scope on direct record URLs as their list queries.

    QA/Security/Admin-wide roles receive ``None`` from
    dashboard_department_scope and may view across departments. Business
    users need an assigned department match; the original requester and a
    verified active delegate retain access to their own record.
    """
    from .workspace_service import current_workspace_scope_ids
    workspace_ids = set(current_workspace_scope_ids())
    if workspace_ids and entity_workspace_id not in workspace_ids:
        raise HTTPException(status_code=403, detail="This record belongs to another workspace.")
    scope = dashboard_department_scope(current_user)
    if scope is None:
        return
    if requester_id is not None and requester_id == current_user.id:
        return
    if delegated:
        return
    if entity_department and entity_department in scope:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You do not have access to this record.",
    )


def active_qa_workspace_scope(current_user: models.User) -> Optional[int]:
    """Workspace selected for this request, or None for non-QA users."""
    if current_user.has_role(Role.ADMIN) or current_user.qa_workspace_access:
        return getattr(current_user, "active_qa_workspace_id", None)
    return None


def active_qa_workspace_scope_ids(current_user: models.User) -> tuple[int, ...]:
    """Selected workspace plus accessible direct children for parent views."""
    if not (current_user.has_role(Role.ADMIN) or current_user.qa_workspace_access):
        return ()
    from .workspace_service import current_workspace_scope_ids
    scope = current_workspace_scope_ids()
    if scope:
        return scope
    selected = getattr(current_user, "active_qa_workspace_id", None)
    return (selected,) if selected is not None else ()


# Reported directly: "In dashboard, every-where show data from which
# department user belong to only," then extended to every standalone request
# list, then extended once more (reported directly): "Department head also
# restricted / bind to Department. the department where they belong to only
# details render to them." A business Department Head (DEPARTMENT_HEAD_CM/
# AGM) was the last unrestricted business-side role -- now removed from this
# set, so it's confined to its own department the same as Requester/
# Business Analyst/SM/Application Owner/Admin.
#
# Still unrestricted: the QA/Security/Executive roles that review
# requests raised by every business department as their actual job
# (QA_LEAD, QA_ENGINEER, SECURITY_ANALYST, CHIEF_MANAGER_QA/AGM_QA) --
# these roles act within the selected workspace and review requests from its
# covered departments, so scoping them to their personal organisational
# department would hide work they are responsible for. Also unrestricted: Role.SCALE_6_PLUS -- a
# System-Admin-only, confidential super-access role added per request ("that
# user can see data across covered departments") specifically so it can be granted to
# someone outside the QA department who still needs the same org-wide view.
DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES = {
    Role.QA_LEAD, Role.QA_ENGINEER, Role.SECURITY_ANALYST,
    Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    Role.SCALE_6_PLUS, Role.VIEW_ONLY,
}


def dashboard_department_scope(current_user: models.User) -> Optional[list]:
    """Returns the list of departments a Dashboard query should be confined
    to (callers should filter with `.in_(scope)`, not `== scope`), or None
    for "no restriction, show every department."

    2026-08 "one user can be on multiple departments" CR -- was a single
    department string; a user belonging to several departments now sees the
    UNION of all of them here, not just their primary one. Every caller of
    this function was updated from `.filter(Model.department == scope)` to
    `.filter(Model.department.in_(scope))` accordingly.

    2026-08 "Admin and Scale 6+ Access-Control Requirement" -- reported
    directly, as a formal spec, that this was a "critical role-mapping and
    authorization defect": an ADMIN account with no other role was being
    scoped to its own single department here, same as a plain business
    user, unless it ALSO held SCALE_6_PLUS (or one of the QA/Security
    roles) -- i.e. `ADMIN AND SCALE_6_PLUS` in effect, when the required
    behavior is `ADMIN` alone, independent of department, scale, or any
    other role. This reverses an EARLIER, explicitly "confirmed directly"
    decision in this same codebase's history that deliberately checked the
    raw roles list instead of has_role() specifically so Admin WOULD be
    scoped here -- that decision has now been explicitly superseded by this
    later, more detailed requirement, which is unambiguous on this exact
    point ("The system shall grant administrative access without checking
    ... Department"). Admin now always bypasses first, same as
    require_same_department already does and always has.

    A scoped user with no assigned department receives an empty scope. This
    is deliberately fail closed: missing profile data must never expand a
    business user's access to every department."""
    if current_user.has_role(Role.ADMIN):
        return None
    selected_workspace_id = getattr(current_user, "active_qa_workspace_id", None)
    if selected_workspace_id is not None and any(
        membership.is_active
        and membership.workspace_id == selected_workspace_id
        and membership.role in {"PARENT_WORKSPACE_VIEWER", "PARENT_WORKSPACE_ADMIN"}
        for membership in current_user.qa_workspace_memberships
    ):
        # This explicit parent grant is department-independent. The active
        # workspace scope still confines results to this hierarchy.
        return None
    # QA working roles retain their established cross-department scope.
    if set(current_user.roles) & DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES:
        return None
    return current_user.departments


def department_unit_visibility_condition(db: Session, current_user: models.User,
                                         department_column, unit_column):
    """Compatibility wrapper for department-only organization visibility.

    Operational team boundaries are child workspaces. Legacy unit columns
    are intentionally ignored so they cannot grant or deny record access.
    """
    departments = dashboard_department_scope(current_user)
    if departments is None:
        # This helper is consumed as a SQL predicate. ``None`` does not mean
        # "skip this filter" to SQLAlchemy when a caller passes it to
        # Query.filter(); it compiles to ``WHERE NULL`` and hides every row.
        # Parent Workspace Viewer/Admin access deliberately returns an
        # unrestricted department scope inside the selected workspace
        # hierarchy, so represent that scope with an always-true predicate.
        return true()
    return department_column.in_(departments) if departments else false()


def require_department_unit_visibility(db: Session, current_user: models.User,
                                       entity_department: Optional[str], entity_unit_id: Optional[int],
                                       *, requester_id: Optional[int] = None,
                                       delegated: bool = False) -> None:
    """Direct-record counterpart to ``department_unit_visibility_condition``."""
    departments = dashboard_department_scope(current_user)
    if departments is None or requester_id == current_user.id or delegated:
        return
    if not entity_department or entity_department not in departments:
        raise HTTPException(status_code=403, detail="You do not have access to this record.")
    return


def require_department_unit_action_scope(db: Session, current_user: models.User,
                                         entity_department: Optional[str], entity_unit_id: Optional[int]) -> None:
    """Compatibility wrapper for department-scoped approval authority."""
    if current_user.has_role(Role.ADMIN):
        return
    if not entity_department or not current_user.has_department(entity_department):
        raise HTTPException(status_code=403, detail="This approval is outside your department scope.")
    return


def has_department_unit_action_scope(db: Session, current_user: models.User,
                                     entity_department: Optional[str], entity_unit_id: Optional[int]) -> bool:
    try:
        require_department_unit_action_scope(
            db, current_user, entity_department, entity_unit_id,
        )
        return True
    except HTTPException:
        return False


def viewable_project_ids(db: Session, current_user: models.User) -> Optional[list]:
    """2026-08 -- reported directly: "one logged in user can [only] show
    projects which are under that user department only. now add ... view
    only access to department as well as particular user ... if any project
    cross departmental." Same `None` == unrestricted convention as
    dashboard_department_scope (Admin/QA-tier roles see every project
    regardless, so callers should skip filtering entirely rather than
    resolving a concrete id list for them). For everyone else: their own
    department-scoped TestProject ids, UNION any project a
    TestProjectViewGrant (see that model's own docstring) explicitly grants
    them read-only visibility into -- either granted straight to their
    account, or to any department they currently belong to (checked live
    against current_user.departments, same as every other department-scoped
    check in this app, not a snapshot taken when the grant was created).

    This only ever WIDENS which projects a scoped user's list/aggregate
    queries include -- it has no bearing on create/edit/execute permissions,
    which stay gated by this app's existing role checks exactly as before a
    grant existed. See routers/test_projects.py::list_test_projects,
    test_reports.py::_scoped_project_ids, and
    test_execution.py::list_blocked_failed_executions for the three call
    sites this widens; routers/defects.py::_scoped_defects also calls this
    directly for the "grant recipients also see the project's Defects"
    parity decision."""
    workspace_scope = active_qa_workspace_scope_ids(current_user)
    if workspace_scope:
        owned_workspace_ids = [row[0] for row in db.query(models.TestProject.id).filter(
            models.TestProject.qa_workspace_id.in_(workspace_scope),
        ).all()]
        shared_workspace_ids = [row[0] for row in db.query(models.TestProjectViewGrant.project_id).filter(
            models.TestProjectViewGrant.workspace_id.in_(workspace_scope),
        ).all()]
        return list(dict.fromkeys(owned_workspace_ids + shared_workspace_ids))
    scope = dashboard_department_scope(current_user)
    if scope is None:
        return None
    own_ids = [row[0] for row in db.query(models.TestProject.id).filter(models.TestProject.department.in_(scope)).all()]
    granted_ids = [row[0] for row in db.query(models.TestProjectViewGrant.project_id).filter(
        or_(
            models.TestProjectViewGrant.user_id == current_user.id,
            models.TestProjectViewGrant.department.in_(current_user.departments),
        )
    ).all()]
    return list(dict.fromkeys(own_ids + granted_ids))


def require_project_visibility(db: Session, project_id: int, current_user: models.User) -> None:
    """Reject direct Test Management URLs outside the caller's project scope."""
    visible_ids = viewable_project_ids(db, current_user)
    if visible_ids is not None and project_id not in visible_ids:
        raise HTTPException(status_code=404, detail="Test Project not found")


def resolve_entity_department(db: Session, entity_type: str, entity_id: int) -> Optional[str]:
    """Given an ApprovalAction-style entity_type/entity_id pair, returns the
    underlying record's department -- shared by list_approvals (approvals.py)
    and the audit-evidence report (routers/reports.py), both of which need to
    apply dashboard_department_scope to the same cross-entity approval/audit
    feed. Lives here rather than in either router since no router imports
    from another router anywhere else in this app (one narrow, documented
    exception aside). TEST_PROJECT/TEST_CASE/TEST_CYCLE and any other
    entity_type not handled here fall through to None, which a scoped
    caller's filter treats as "excluded" -- fail closed (hide anything we
    can't positively confirm is in-scope) rather than fail open."""
    if entity_type == "QA_REQUEST":
        obj = db.query(models.QARequest).get(entity_id)
        return obj.department if obj else None
    if entity_type == "FUNCTIONAL_REQUEST":
        obj = db.query(models.FunctionalRequest).get(entity_id)
        return obj.department if obj else None
    if entity_type == "SAST":
        obj = db.query(models.SASTRequest).get(entity_id)
        return obj.department if obj else None
    if entity_type == "DAST":
        obj = db.query(models.DASTRequest).get(entity_id)
        return obj.department if obj else None
    if entity_type == "SAST_DAST":
        sast = db.query(models.SASTRequest).get(entity_id)
        if sast:
            return sast.department
        dast = db.query(models.DASTRequest).get(entity_id)
        return dast.department if dast else None
    if entity_type == "PERFORMANCE":
        obj = db.query(models.PerformanceRequest).get(entity_id)
        return obj.department if obj else None
    if entity_type == "SUPPRESSION":
        obj = db.query(models.SuppressionRequest).get(entity_id)
        return obj.department if obj else None
    if entity_type == "SIGNOFF":
        obj = db.query(models.QASignOff).get(entity_id)
        return obj.request_department if obj else None
    if entity_type == "DEFECT":
        obj = db.query(models.Defect).get(entity_id)
        return obj.department if obj else None
    if entity_type == "TEST_PROJECT":
        obj = db.query(models.TestProject).get(entity_id)
        return obj.department if obj else None
    if entity_type == "TEST_CASE":
        obj = db.query(models.TestCase).get(entity_id)
        return obj.project.department if obj and obj.project else None
    if entity_type == "TEST_CYCLE":
        obj = db.query(models.TestCycle).get(entity_id)
        return obj.project.department if obj and obj.project else None
    if entity_type == "TEST_EXECUTION":
        obj = db.get(models.TestExecution, entity_id)
        return obj.cycle.project.department if obj and obj.cycle and obj.cycle.project else None
    return None


def resolve_entity_workspace_id(db: Session, entity_type: str, entity_id: int) -> Optional[int]:
    """Resolve the persisted Workspace for any workflow/audit entity."""
    normalized = (entity_type or "").strip().upper()
    if normalized == "QA_REQUEST":
        row = db.query(models.QARequest.qa_workspace_id).filter(models.QARequest.id == entity_id).first()
    elif normalized in {"FUNCTIONAL_REQUEST", "SAST", "DAST", "PERFORMANCE"}:
        model = {
            "FUNCTIONAL_REQUEST": models.FunctionalRequest, "SAST": models.SASTRequest,
            "DAST": models.DASTRequest, "PERFORMANCE": models.PerformanceRequest,
        }[normalized]
        row = db.query(models.QARequest.qa_workspace_id).join(
            model, model.qa_request_id == models.QARequest.id,
        ).filter(model.id == entity_id).first()
    elif normalized == "SAST_DAST":
        return (resolve_entity_workspace_id(db, "SAST", entity_id)
                or resolve_entity_workspace_id(db, "DAST", entity_id))
    elif normalized == "SUPPRESSION":
        row = db.query(models.SuppressionRequest.qa_workspace_id).filter(models.SuppressionRequest.id == entity_id).first()
    elif normalized == "SIGNOFF":
        row = db.query(models.QASignOff.qa_workspace_id).filter(models.QASignOff.id == entity_id).first()
    elif normalized == "DEFECT":
        row = db.query(models.Defect.qa_workspace_id).filter(models.Defect.id == entity_id).first()
    elif normalized in {"TEST_PROJECT", "TEST_CASE", "TEST_CYCLE", "TEST_EXECUTION"}:
        if normalized == "TEST_PROJECT":
            row = db.query(models.TestProject.qa_workspace_id).filter(models.TestProject.id == entity_id).first()
        elif normalized == "TEST_CASE":
            row = db.query(func.coalesce(models.TestCase.origin_workspace_id, models.TestProject.qa_workspace_id)).select_from(models.TestProject).join(
                models.TestCase, models.TestCase.project_id == models.TestProject.id,
            ).filter(models.TestCase.id == entity_id).first()
        else:
            q = db.query(func.coalesce(models.TestCycle.origin_workspace_id, models.TestProject.qa_workspace_id)).select_from(models.TestProject).join(
                models.TestCycle, models.TestCycle.project_id == models.TestProject.id,
            )
            if normalized == "TEST_EXECUTION":
                q = q.join(models.TestExecution, models.TestExecution.cycle_id == models.TestCycle.id).filter(
                    models.TestExecution.id == entity_id)
            else:
                q = q.filter(models.TestCycle.id == entity_id)
            row = q.first()
    else:
        return None
    return row[0] if row else None


def require_entity_workspace_visibility(db: Session, current_user: models.User,
                                        entity_type: str, entity_id: int) -> None:
    # Shared project content remains readable across its participating
    # workspaces. Creating-workspace ownership governs writes, not reads.
    content_model = {"TEST_CASE": models.TestCase, "TEST_CYCLE": models.TestCycle,
                     "TEST_EXECUTION": models.TestExecution}.get(entity_type)
    if content_model:
        content = db.get(content_model, entity_id)
        if not content:
            raise HTTPException(404, "Record not found")
        project_id = content.cycle.project_id if entity_type == "TEST_EXECUTION" else content.project_id
        require_project_visibility(db, project_id, current_user)
        return
    selected = active_qa_workspace_scope(current_user)
    if selected is not None:
        from .workspace_service import active_workspace_scope_ids
        visible_workspace_ids = active_workspace_scope_ids(db, current_user, selected)
        if resolve_entity_workspace_id(db, entity_type, entity_id) not in visible_workspace_ids:
            raise HTTPException(status_code=404, detail="Record not found in the active workspace")


def require_not_requester(current_user: models.User, requester_id) -> None:
    """A person must never be able to approve their own request at an
    SM/Department Head/QA Lead/Executive  decision checkpoint, even if
    they separately hold that approving role for the request's own
    department -- e.g. someone who is both a Requester in IT-Software AND
    that department's SM must have a DIFFERENT SM decide their own request;
    wearing two hats does not let one person self-approve. Reported directly:
    without this check, `require_same_department` alone was not enough,
    since it only verifies the approver's department matches the request's
    department -- it says nothing about whether the approver IS the
    requester. ADMIN always bypasses this check, same convention as
    require_same_department.

    requester_id may be None (e.g. a standalone SAST/DAST request or
    Suppression request with nothing meaningful to compare against) -- in
    that case the check is skipped rather than blocking everyone.
    """
    if current_user.has_role(Role.ADMIN):
        return
    if not requester_id:
        return
    if current_user.id == requester_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You raised this request yourself, so you cannot also be the one to approve it "
                   "at this checkpoint -- ask another person who holds this approval role to decide it.",
        )


def get_or_404(db: Session, model, obj_id: int, label: str):
    """Generic version of the "get_or_404" shape repeated inline, standalone
    (no shared helper), throughout most routers in this app -- e.g.
    `obj = db.query(Model).get(id); if not obj: raise HTTPException(404,
    "X not found")`. Not retrofitted onto every existing call site (dozens,
    across nearly every router) in one sweep -- many of those inline blocks
    have entity-specific extra logic sitting between the lookup and the
    raise (permission/department checks, etc.) that must stay untouched, so
    a blind mechanical rewrite across the whole app risked more than it was
    worth. This is here so call sites that are a plain lookup-or-404 with no
    extra logic (like the get_project_or_404 case above) can adopt it
    incrementally instead of writing the same three lines again."""
    obj = db.query(model).get(obj_id)
    if not obj:
        raise HTTPException(404, f"{label} not found")
    return obj


def get_project_or_404(db: Session, project_id: int) -> models.TestProject:
    """Was independently defined (byte-identical) in test_execution.py,
    test_reports.py, and test_repository.py -- all three Test Management
    routers look up a TestProject by id constantly. Consolidated here so
    there's one implementation instead of three to keep in sync."""
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    return obj


# ---------------------------------------------------------------------------
# Test Management -- project-scoped role enforcement (SRS PRJ-005/GOV-001).
#
# TestProjectMember.project_role (constants.TEST_PROJECT_ROLES) was originally
# purely descriptive -- visible on the Members list but not actually
# enforced anywhere, per models.py's own TestProjectMember docstring, which
# already flagged this as the intended follow-up ("Repository/cycle/report
# access is meant to be constrained by this membership... not just by
# holding QA_ENGINEER/QA_LEAD generally"). These helpers are that follow-up.
#
# Deliberately backward-compatible / opt-in per project for AUTHOR/EXECUTION
# capability: someone who is NOT a member of a given project keeps whatever
# access their SYSTEM role (QA_ENGINEER/QA_LEAD/ADMIN, still checked by the
# caller via require_roles at the endpoint level exactly as before) already
# grants them everywhere -- can_author_repository/can_execute_project only
# ever ADD a restriction, for people an owner has explicitly added as a
# member with a narrower project role. An existing project with zero
# members configured behaves exactly as it did before project roles
# existed; an owner opts a project into tighter per-person control simply
# by populating membership with specific roles.
#
# REVIEW-tier capability (can_review_repository) is the one deliberate
# exception to that backward-compatible fallback -- see its own docstring
# below. A QA_ENGINEER only gets review/governance rights on a project
# where they're an actual member holding Reviewer/Project Lead/Owner; a
# non-member QA_ENGINEER never gets a free pass here even though they would
# for authoring/execution. Same reasoning as CYC-007's
# _require_scope_change_permission in test_execution.py.
#
# Role -> capability mapping (by direct product decision):
#   Author        -- repository authoring (create/edit/submit test cases, folders)
#   Reviewer      -- review workflow + repository governance (approve/return,
#                    archive/restore, checkout override, delete folder) --
#                    membership-gated even for QA_ENGINEER, see above
#   Tester        -- execution (record results, assign runners, link defects)
#   Project Lead  -- Author + Reviewer + Tester, plus cycle deletion
#                    governance. Deliberately NOT spelled
#                    "QA Lead" -- reported directly as confusing since it's a
#                    completely different mechanism from the app-wide
#                    Role.QA_LEAD system role (this is one project; that's
#                    everywhere) that used to share the exact same name.
#   Owner         -- everything above, plus membership management
#   Viewer        -- none of the above; read-only
# ---------------------------------------------------------------------------
_REPOSITORY_AUTHOR_ROLES = {"Author", "Project Lead", "Owner"}
_REPOSITORY_REVIEW_ROLES = {"Reviewer", "Project Lead", "Owner"}
_EXECUTION_WRITE_ROLES = {"Tester", "Project Lead", "Owner"}
_EXECUTION_GOVERNANCE_ROLES = {"Project Lead", "Owner"}


def get_project_member_role(db: Session, project_id: int, user_id: int) -> Optional[str]:
    """This user's TestProjectMember.project_role on this specific project,
    or None if they are not a member of it at all (the "unrestricted,
    fall back to system role" case every check below treats identically)."""
    member = db.query(models.TestProjectMember).filter_by(project_id=project_id, user_id=user_id).first()
    return member.project_role if member else None


def _project_role_permits(db: Session, project_id: int, current_user: models.User, allowed: set) -> bool:
    if current_user.has_role(Role.ADMIN):
        return True
    role = get_project_member_role(db, project_id, current_user.id)
    if role is None:
        # CM-QA/AGM-QA enter Test Management through an explicit project
        # assignment (normally Stage 2 default -> Project Lead). Do not give
        # that role the legacy non-member access retained for QA staff.
        # Bug found via debugging pass: this only named CHIEF_MANAGER_QA --
        # an AGM_QA-only account (no QA_ENGINEER/QA_LEAD) fell through to
        # `return True` below and got the same unrestricted "legacy QA
        # staff" access on every project that this check exists specifically
        # to deny CM-QA. Both executive roles now get the identical
        # restriction, matching their identical standing everywhere else
        # (Author-tier, Stage 2 approval, Executive ).
        if current_user.has_role(Role.CHIEF_MANAGER_QA, Role.AGM_QA) and not current_user.has_role(
            Role.QA_ENGINEER, Role.QA_LEAD
        ):
            return False
        return True
    return role in allowed


def _project_is_owned_by_active_workspace(
    db: Session, project_id: int, current_user: models.User,
) -> bool:
    """Whether the active workspace scope owns the project itself."""
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if not workspace_ids:
        return True
    return db.query(models.TestProject.id).filter(
        models.TestProject.id == project_id,
        models.TestProject.qa_workspace_id.in_(workspace_ids),
    ).first() is not None


# 2026-08 "Simplified Test Management Review and Approval" requirement
# ("whole module" scope, per ORACLE_MIGRATION_2026-07.md) -- repository
# authoring is a stateless, current-moment permission (unlike the
# TestCaseVersion review chain below, which has an old/new-vocabulary
# status to discriminate an in-flight item's workflow generation), so it
# moves to the plain system-role model immediately: every router endpoint
# that calls this already sits behind require_roles(*_AUTHOR_ROLES) in
# test_repository.py (QA_ENGINEER/QA_LEAD/CHIEF_MANAGER_QA/AGM_QA), so this
# is now a pass-through -- TestProjectMember's "Author" project role is no
# longer read here (table/data kept for history only, per the additive-only
# schema convention; no migration needed since there was never a per-item
# status tracking who authored under which model).
def _project_allows_workspace_content(db, project_id, user):
    from .project_workspace_ownership import workspace_can_contribute
    if getattr(user, "active_qa_workspace_id", None) is not None:
        return workspace_can_contribute(db, project_id, user)
    return _project_is_owned_by_active_workspace(db, project_id, user)


def can_author_repository(db: Session, project_id: int, current_user: models.User) -> bool:
    return _project_allows_workspace_content(db, project_id, current_user)


def can_review_repository(db: Session, project_id: int, current_user: models.User) -> bool:
    """Review-tier repository governance (approve/return a submitted test
    case, checkout override, archive/restore, delete a folder, bulk-approve)
    is this app's maker-checker control (GOV-002). Deliberately does NOT use
    _project_role_permits' "not a member = unrestricted" fallback the way
    can_author_repository/can_execute_project do -- reported directly:
    "one user is QA engineer, and mark him as Project lead, so he cant
    approve?" surfaced that this had to be a real decision, not an accident.
    If a QA_ENGINEER is now admitted past the router-level role check at
    all (see test_repository.py's review/archive/restore/checkout-override/
    bulk-approve/delete-folder endpoints, which used to require system
    QA_LEAD outright), the permissive fallback would let ANY QA_ENGINEER
    approve on ANY project that simply has no members configured yet --
    far broader than "a QA_ENGINEER who's this specific project's Reviewer/
    Project Lead/Owner." So this checks membership directly: system
    QA_LEAD/Admin always pass; anyone else must be an actual member of
    THIS project holding Reviewer, Project Lead, or Owner. Same reasoning
    as test_execution.py's CYC-007 _require_scope_change_permission, which
    is strict for an identical reason."""
    if not _project_allows_workspace_content(db, project_id, current_user):
        return False
    if current_user.has_role(Role.QA_LEAD):  # has_role() already bypasses for ADMIN too
        return True
    role = get_project_member_role(db, project_id, current_user.id)
    return role in _REPOSITORY_REVIEW_ROLES


# 2026-08 "Test Approval Workflow" refactor (Test_Approval_Workflow_
# Requirements.docx) -- the single review step above became a strict
# two-stage chain, Author -> Reviewer -> QA Lead. can_review_repository
# above now specifically means STAGE 1 (Reviewer recommends or returns a
# version sitting "In Review"). This is STAGE 2 (QA Lead gives final
# approval, return, or reject on a version sitting "Review Completed") --
# deliberately narrower: plain "Reviewer" project role can recommend but
# cannot give final approval (core operating model: "Reviewer... may
# recommend approval or return... QA Lead... may approve and activate,
# return, or reject" -- section 2's own permission-authority column makes
# this distinction explicit). Same strict-membership pattern as
# can_review_repository (no non-member fallback) for the same reason.
# Project ownership is administrative and must not imply QA approval
# authority. Stage 2 belongs only to system QA Lead/Admin or the project's
# explicitly designated Project Lead.
_FINAL_APPROVAL_ROLES = {"Project Lead"}


def can_give_final_approval(db: Session, project_id: int, current_user: models.User) -> bool:
    # Test-case Stage 2 is the shared QA-management queue. Either CM QA or
    # AGM QA may complete it; Admin retains oversight access.
    if not _project_allows_workspace_content(db, project_id, current_user):
        return False
    if current_user.has_role(Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        return True
    return False


def require_can_give_final_approval(db: Session, project_id: int, current_user: models.User) -> None:
    if not can_give_final_approval(db, project_id, current_user):
        raise HTTPException(403, "Final approval is available only to CM QA, AGM QA, or an Administrator.")


# 2026-08 "Simplified Test Management Review and Approval" requirement --
# repository governance actions that are NOT tied to a specific
# TestCaseVersion's old/new-workflow status (folder deletion, checkout
# override, archive/restore of an already-Approved baseline) move to the
# QA Lead Group system-role model, the same set used for Stage 2 final
# approval under the new workflow (QA_LEAD/CHIEF_MANAGER_QA/AGM_QA --
# CM-QA/AGM-QA's Executive bypass already covers this, see
# ORACLE_MIGRATION_2026-07.md section 59). Deliberately NOT touching
# can_review_repository/require_can_review_repository above -- those stay
# the OLD-path-only helper for a TestCaseVersion still sitting at legacy
# "In Review"/"Review Completed" (test_repository.py's
# bulk_recommend_test_cases is_old_path branch calls it directly),
# unchanged per the "new cases only" migration decision.
def can_manage_repository_governance(
    current_user: models.User, db: Session | None = None, project_id: int | None = None,
) -> bool:
    if db is not None and project_id is not None and not _project_allows_workspace_content(db, project_id, current_user):
        return False
    return current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)


def require_can_manage_repository_governance(
    current_user: models.User, db: Session | None = None, project_id: int | None = None,
) -> None:
    if not can_manage_repository_governance(current_user, db, project_id):
        raise HTTPException(403, "This action is available only to the QA Lead Group (QA Lead, CM QA, or AGM QA).")


# 2026-08 "Simplified Test Management" whole-module scope: test execution
# is a stateless, current-moment permission -- no in-flight item status
# discriminates an "old" execution from a "new" one the way
# TestCaseVersion.status does for the review chain above, so it moves to
# the QA Group / QA Lead Group system-role model immediately, no
# migration/dual-path needed. TestProjectMember's Tester/Project
# Lead/Owner project roles are no longer read here (table/data kept for
# history only).
def can_execute_project(db: Session, project_id: int, current_user: models.User) -> bool:
    return _project_allows_workspace_content(db, project_id, current_user) and current_user.has_role(
        Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    )


def can_manage_execution_governance(db: Session, project_id: int, current_user: models.User) -> bool:
    return _project_allows_workspace_content(db, project_id, current_user) and current_user.has_role(
        Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    )


def require_can_author_repository(db: Session, project_id: int, current_user: models.User) -> None:
    if not can_author_repository(db, project_id, current_user):
        raise HTTPException(403, "Repository authoring requires an eligible QA role and an owning or shared workspace.")


def require_can_review_repository(db: Session, project_id: int, current_user: models.User) -> None:
    if not can_review_repository(db, project_id, current_user):
        raise HTTPException(403, "This action needs system QA Lead/Administrator, or project role Reviewer, "
                                  "Project Lead, or Owner on this specific Test Project -- ask the project "
                                  "owner to add you as a member with one of those roles, or ask a QA Lead.")


def require_can_execute_project(db: Session, project_id: int, current_user: models.User) -> None:
    if not can_execute_project(db, project_id, current_user):
        raise HTTPException(403, "Your project role on this Test Project doesn't include test execution -- "
                                  "ask the project owner to change your role to Tester, Project Lead, or Owner.")


def require_can_manage_execution_governance(db: Session, project_id: int, current_user: models.User) -> None:
    if not can_manage_execution_governance(db, project_id, current_user):
        raise HTTPException(403, "Your project role on this Test Project doesn't include cycle deletion governance -- "
                                  "ask the project owner to change your role to Project Lead or Owner.")


def can_manage_project(project: models.TestProject, current_user: models.User) -> bool:
    """SRS PRJ-001/PRJ-005 -- editing a Test Project's own record (name,
    department, linked application, description, owner reassignment) is
    restricted to that project's designated Owner, or system QA_LEAD/Admin
    (who keep the original blanket "QA Engineer + QA Lead manage Projects"
    rule the rest of this router still uses for creation/membership).
    A QA_ENGINEER who is only an Author/Tester/Reviewer member of this
    project -- or not a member at all -- can no longer edit the project
    record itself, even though they can still act within it per their own
    project role. Checked against TestProject.owner_id directly, NOT
    TestProjectMember, since owner_id is the single authoritative "who owns
    this project" field -- a project whose owner_id was set by
    test_management_migration.py's _migrate_project_owners backfill (rather
    than through create/update_test_project, which also insert/refresh an
    Owner TestProjectMember row) may not have a matching membership row, so
    relying on membership here could incorrectly lock out a real owner."""
    # Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on every QA-Lead-
    # gated action, same as ADMIN -- see ORACLE_MIGRATION_2026-07.md
    # section 59. has_role() already bypasses for ADMIN too.
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if workspace_ids and project.qa_workspace_id not in workspace_ids:
        return False
    if current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        return True
    return project.owner_id == current_user.id


def require_can_manage_project(project: models.TestProject, current_user: models.User) -> None:
    if not can_manage_project(project, current_user):
        raise HTTPException(403, "Only this Test Project's owner or a QA Lead/Administrator can edit its details.")


def can_view_cycle_folder(folder: models.TestCycleFolder, current_user: models.User) -> bool:
    """Reported directly: "Create Test Cycle Folder, in which I can give
    access department based or user level, same behaviour like project
    has." Deliberately the OPPOSITE of viewable_project_ids/
    TestProjectViewGrant above (which only ever WIDEN visibility) -- a
    TestCycleFolder with at least one TestCycleFolderAccess row RESTRICTS
    visibility to just the department(s)/user(s) it names. A folder with no
    access rows at all is unrestricted (same as an Unfiled cycle, or every
    folder before this feature existed).

    Reported directly as a follow-up: QA Group (QA_ENGINEER) added to the
    bypass list alongside QA Lead Group -- both groups, plus the project's
    own owner, always bypass, same "QA Group/QA Lead Group govern everything"
    convention can_manage_project/can_execute_project already use elsewhere
    in this module -- plus this folder's own creator, so nobody can
    restrict themselves out of a folder they just made. has_role() already
    bypasses for ADMIN too. In practice this means a folder's access grants
    only ever matter for accounts that hold none of these roles (e.g. a
    business department user who can otherwise view Test Execution at all,
    since list_cycles/get_cycle carry no role gate of their own) -- every
    QA_ENGINEER/QA_LEAD/CHIEF_MANAGER_QA/AGM_QA account sees every folder
    regardless of grants."""
    if current_user.has_role(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA, Role.VIEW_ONLY):
        return True
    if folder.project and folder.project.owner_id == current_user.id:
        return True
    if folder.created_by_id == current_user.id:
        return True
    grants = folder.access_grants
    if not grants:
        return True
    for grant in grants:
        if grant.user_id == current_user.id:
            return True
        if grant.department and current_user.has_department(grant.department):
            return True
    return False


def require_can_view_cycle_folder(folder: models.TestCycleFolder, current_user: models.User) -> None:
    if not can_view_cycle_folder(folder, current_user):
        raise HTTPException(
            403,
            "You don't have access to this Test Cycle Folder -- ask the project owner or a QA Lead "
            "to grant your department or account access.",
        )
