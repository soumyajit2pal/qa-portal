from typing import Optional
from collections import defaultdict, deque
from threading import Lock
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from jose import JWTError
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .. import models, schemas, pagination, email_notifications
from ..database import get_db
from ..audit_service import snapshot_changes, user_snapshot, write_audit
from ..auth import (
    verify_password, create_access_token, ldap_authenticate, ldap_authenticate_with_profile, LDAPAuthError,
)
from ..deps import (
    get_current_user, require_roles, oauth2_scheme, active_qa_workspace_scope,
    active_qa_workspace_scope_ids,
)
from ..auth import renew_access_token
from ..constants import (
    Role, ALL_ROLES, LoginType, ALL_LOGIN_TYPES,
    DEPARTMENT_ADMIN_ASSIGNABLE_ROLES, QA_ADMIN_ASSIGNABLE_ROLES, CONFIDENTIAL_ROLES,
    DOCUMENT_PORTAL_ROLES,
    OTHER_DEPARTMENT,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

_LOGIN_WINDOW_SECONDS = 15 * 60
_LOGIN_MAX_FAILURES = 5
_login_failures = defaultdict(deque)
_login_failure_lock = Lock()


def _login_key(request: Request, username: str) -> tuple[str, str]:
    return ((request.client.host if request.client else "unknown"), username)


def _prune_login_failures(attempts, now: float) -> None:
    while attempts and now - attempts[0] >= _LOGIN_WINDOW_SECONDS:
        attempts.popleft()


def _enforce_login_rate_limit(request: Request, username: str) -> None:
    now = time.monotonic()
    with _login_failure_lock:
        attempts = _login_failures[_login_key(request, username)]
        _prune_login_failures(attempts, now)
        if len(attempts) >= _LOGIN_MAX_FAILURES:
            retry_after = max(1, int(_LOGIN_WINDOW_SECONDS - (now - attempts[0])))
            raise HTTPException(
                status_code=429,
                detail="Too many failed sign-in attempts. Try again later.",
                headers={"Retry-After": str(retry_after)},
            )


def _record_login_failure(request: Request, username: str) -> None:
    now = time.monotonic()
    with _login_failure_lock:
        attempts = _login_failures[_login_key(request, username)]
        _prune_login_failures(attempts, now)
        attempts.append(now)


def _clear_login_failures(request: Request, username: str) -> None:
    with _login_failure_lock:
        _login_failures.pop(_login_key(request, username), None)


@router.post("/admin/test-email", response_model=schemas.AdminTestEmailResult)
def send_admin_test_email(payload: schemas.AdminTestEmailRequest, request: Request,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.ADMIN))):
    recipient = str(payload.recipient).strip()
    try:
        email_notifications.send_test_email(recipient, current_user.full_name or current_user.username)
    except Exception as exc:
        write_audit(
            db, event_type="SYSTEM_CONFIGURATION", action="SMTP_TEST_EMAIL",
            outcome="FAILED", actor=current_user, request=request, status_code=502,
            target_type="EMAIL", target_name=recipient,
            details={"recipient": recipient, "error_type": type(exc).__name__},
        )
        raise HTTPException(502, f"Test email could not be sent: {exc}")
    write_audit(
        db, event_type="SYSTEM_CONFIGURATION", action="SMTP_TEST_EMAIL",
        actor=current_user, request=request, status_code=200,
        target_type="EMAIL", target_name=recipient,
        details={"recipient": recipient},
    )
    return {"ok": True, "message": f"Test email sent successfully to {recipient}."}


def _canonical_login_username(username: str) -> str:
    """Use one canonical, case-insensitive username form at sign-in.

    LDAP bank IDs and local portal usernames are managed as lowercase
    identities. Normalizing at the API boundary also protects non-browser
    clients from bypassing the login screen's lowercase input behavior.
    """
    return (username or "").strip().lower()


def _is_document_only_ldap_username(username: str) -> bool:
    """External identities do not use the bank `b…` username convention.

    `b0` is already covered by this rule because it begins with `b`; the
    explicit normalization keeps the decision stable regardless of LDAP's
    username casing.  These accounts are deliberately limited to Document
    Portal Viewer on their first login, pending Administrator review.
    """
    return not username.strip().casefold().startswith("b")


def _redact_confidential_roles(user: "models.User", viewer: "models.User") -> "schemas.UserOut":
    """Strips CONFIDENTIAL_ROLES (currently just SCALE_6_PLUS -- see its own
    comment in constants.py) out of a user's `roles` before it's serialized
    for a non-Admin viewer. Reported directly: this role must be "not visible
    to noone except admin" -- without this, list_users (the general active-
    users picker fetched by every logged-in user throughout the app, e.g.
    "assign tester") and list_local_admin_users would both include it in the
    plain JSON response, visible to anyone with browser devtools open even if
    no current UI happens to render it. Builds a real schemas.UserOut (rather
    than mutating the ORM row's computed `roles` property, which reads
    directly from the role_assignments relationship and isn't safely
    overridable per-response) so this can be dropped straight into a
    response_model=UserOut/list[UserOut] return without any other change.
    A viewer who IS Admin gets the untouched, full role list."""
    out = schemas.UserOut.model_validate(user)
    if not viewer.has_role(Role.ADMIN):
        out.roles = [r for r in out.roles if r not in CONFIDENTIAL_ROLES]
    return out


@router.post("/login", response_model=schemas.Token)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    username = _canonical_login_username(form_data.username)
    _enforce_login_rate_limit(request, username)
    user = db.query(models.User).filter(func.lower(models.User.username) == username).first()
    just_provisioned = False
    document_only_ldap_account = False

    if not user:
        # Unknown username: just-in-time provision from LDAP rather than requiring
        # an admin to pre-create the account. A successful directory bind on this
        # first login creates a local User row with *no* application role.
        # The person must first select their department, then an Administrator
        # or that department's Coordinator approves access by assigning roles.
        # This deliberately never grants Requester (or any other) access from
        # an unaudited self-service selection.
        try:
            profile = ldap_authenticate_with_profile(username, form_data.password)
        except LDAPAuthError:
            profile = None
        if not profile:
            _record_login_failure(request, username)
            write_audit(db, event_type="AUTHENTICATION", action="LOGIN_FAILED", outcome="FAILED",
                        actor_username=username, request=request, status_code=401,
                        details={"reason": "Invalid username or password"})
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

        document_only_ldap_account = _is_document_only_ldap_username(username)
        user = models.User(
            username=username,
            full_name=profile.get("full_name") or username,
            email=profile.get("email"),
            department=OTHER_DEPARTMENT if document_only_ldap_account else profile.get("department"),
            department_assignments=(
                [models.UserDepartment(department=OTHER_DEPARTMENT)]
                if document_only_ldap_account else []
            ),
            role_assignments=(
                [models.UserRole(role=Role.DOCUMENT_PORTAL_VIEWER)]
                if document_only_ldap_account else []
            ),
            login_type=LoginType.LDAP,
            hashed_password=None,
            needs_role_review=True,
            # Prompt this person once, right after this first login, to
            # explicitly confirm/pick their department from our own
            # qap_departments list -- whatever profile.get("department") just
            # returned from the directory (often blank, or free text that
            # doesn't exactly match one of our canonical department names) is
            # only ever a starting guess. See PATCH /api/auth/me below.
            needs_department_selection=not document_only_ldap_account,
        )
        db.add(user)
        try:
            from ..workspace_service import ensure_default_workspace_membership
            ensure_default_workspace_membership(db, user)
            db.commit()
            db.refresh(user)
            just_provisioned = True
        except IntegrityError:
            # Lost a race with a concurrent first-login for the same username.
            db.rollback()
            user = db.query(models.User).filter(func.lower(models.User.username) == username).first()

    if not user.is_active:
        write_audit(db, event_type="AUTHENTICATION", action="LOGIN_BLOCKED", outcome="FAILED",
                    actor=user, request=request, status_code=403, details={"reason": "User is disabled"})
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is disabled")

    if not just_provisioned:
        # Credentials were already verified above for a just-provisioned account;
        # otherwise verify them the normal way for this account's login type.
        if user.login_type == LoginType.LDAP:
            try:
                authenticated = ldap_authenticate(username, form_data.password)
            except LDAPAuthError as e:
                write_audit(db, event_type="AUTHENTICATION", action="LOGIN_ERROR", outcome="FAILED",
                            actor=user, request=request, status_code=503,
                            details={"reason": "LDAP authentication unavailable"})
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                                     detail=f"LDAP authentication unavailable: {e}")
            if not authenticated:
                _record_login_failure(request, username)
                write_audit(db, event_type="AUTHENTICATION", action="LOGIN_FAILED", outcome="FAILED",
                            actor=user, request=request, status_code=401,
                            details={"reason": "Invalid username or password"})
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
        else:
            if not user.hashed_password or not verify_password(form_data.password, user.hashed_password):
                _record_login_failure(request, username)
                write_audit(db, event_type="AUTHENTICATION", action="LOGIN_FAILED", outcome="FAILED",
                            actor=user, request=request, status_code=401,
                            details={"reason": "Invalid username or password"})
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    _clear_login_failures(request, username)
    token = create_access_token({"sub": user.username, "roles": user.roles}, )
    if just_provisioned:
        # An external/document-only identity is already placed in Other and
        # can safely use only Document Portal. Alert every active Admin when
        # SMTP is enabled so the remaining access review is not overlooked.
        queued_admin_notifications = (
            email_notifications.queue_access_review_notifications(db, user)
            if document_only_ldap_account else 0
        )
        write_audit(db, event_type="ACCESS_MANAGEMENT", action="USER_AUTO_PROVISIONED",
                    actor=user, request=request, status_code=201, target_type="USER",
                    target_id=user.id, target_name=user.full_name,
                    details={
                        "after": user_snapshot(user),
                        "source": "LDAP first login",
                        "document_only": document_only_ldap_account,
                        "admin_notifications_queued": queued_admin_notifications,
                    })
    write_audit(db, event_type="AUTHENTICATION", action="LOGIN_SUCCESS", actor=user,
                request=request, status_code=200,
                details={"login_type": user.login_type, "just_provisioned": just_provisioned})
    return schemas.Token(access_token=token, roles=user.roles, full_name=user.full_name, username=user.username)


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db),
           current_user: models.User = Depends(get_current_user)):
    write_audit(db, event_type="AUTHENTICATION", action="LOGOUT", actor=current_user,
                request=request, status_code=200)
    return {"status": "ok"}


@router.post("/renew", response_model=schemas.Token)
def renew(response: Response, token: str = Depends(oauth2_scheme),
          current_user: models.User = Depends(get_current_user)):
    # get_current_user rechecks the database account and resolves current roles.
    try:
        renewed = renew_access_token(token, current_user.username, current_user.roles)
    except JWTError:
        raise HTTPException(401, "Your session has ended. Please sign in again.")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return schemas.Token(access_token=renewed, roles=current_user.roles,
                         full_name=current_user.full_name, username=current_user.username)


@router.get("/me", response_model=schemas.UserOut)
def me(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    if current_user.has_role(Role.SCALE_6_PLUS):
        out = schemas.UserOut.model_validate(current_user)
        workspaces = db.query(models.QAWorkspace).filter(
            models.QAWorkspace.is_active == True,  # noqa: E712
        ).order_by(models.QAWorkspace.name).all()
        access = [schemas.QAWorkspaceAccessOut(
            id=-row.id, workspace_id=row.id, role="WORKSPACE_VIEWER", is_active=True,
            workspace_name=row.name, workspace_key=row.workspace_key,
            parent_workspace_id=row.parent_workspace_id,
            parent_workspace_name=row.parent_workspace_name,
            parent_workspace_key=row.parent_workspace_key,
        ) for row in workspaces]
        out.workspace_access = access
        out.qa_workspace_access = access
        return out
    return current_user


@router.patch("/me/email", response_model=schemas.UserOut)
def complete_ldap_email(
    payload: schemas.LdapEmailCompletion,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Save the mandatory notification address for an approved LDAP account.

    The browser displays this only when an LDAP account has completed its
    access review and the directory supplied no email.  Enforcing the same
    condition here prevents the endpoint from being used as a broader
    profile-edit API, while still allowing an already-approved person to
    recover from the missing LDAP attribute without waiting for an admin.
    """
    if current_user.login_type != LoginType.LDAP:
        raise HTTPException(status_code=403, detail="This email completion step applies only to LDAP accounts.")
    if current_user.needs_department_selection or current_user.needs_role_review or not current_user.roles:
        raise HTTPException(
            status_code=403,
            detail="Your access must be approved before you can complete the notification email step.",
        )

    if (current_user.email or "").strip():
        raise HTTPException(
            status_code=409,
            detail="A notification email is already configured. Ask an Administrator or Department Coordinator to change it.",
        )

    email = str(payload.email).strip().lower()

    before = user_snapshot(current_user)
    current_user.email = email
    db.commit()
    db.refresh(current_user)
    write_audit(
        db,
        event_type="ACCESS_MANAGEMENT",
        action="LDAP_NOTIFICATION_EMAIL_COMPLETED",
        actor=current_user,
        request=request,
        status_code=200,
        target_type="USER",
        target_id=current_user.id,
        target_name=current_user.full_name,
        details={"changes": snapshot_changes(before, user_snapshot(current_user))},
    )
    return current_user


@router.patch("/me", response_model=schemas.UserOut)
def update_me(payload: schemas.DepartmentSelection, request: Request, db: Session = Depends(get_db),
              current_user: models.User = Depends(get_current_user)):
    """One-time LDAP self-service selection of exactly one primary department.

    Secondary departments and every later correction are deliberately
    Admin-only through PATCH /api/auth/users/{id}; users cannot broaden their
    own organizational scope after onboarding.
    """
    if current_user.login_type != LoginType.LDAP or not current_user.needs_department_selection:
        raise HTTPException(
            status_code=403,
            detail="Department self-selection is available only during first-time LDAP onboarding. Ask an Administrator to change or add departments.",
        )
    primary_department = payload.department.strip()
    _validate_department(db, primary_department)
    before = user_snapshot(current_user)
    _set_user_departments(db, current_user, [primary_department])
    _set_user_department_units(db, current_user, [])
    current_user.needs_department_selection = False

    db.commit()
    db.refresh(current_user)
    # The durable `needs_role_review` state is the approval request. It is
    # visible first in Admin's review queue and in the selected department's
    # Coordinator roster. Either authorized reviewer completes it by assigning
    # a role through their existing, server-scoped access-management endpoint.
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="LDAP_ACCESS_APPROVAL_REQUESTED",
                actor=current_user, request=request, status_code=200, target_type="USER",
                target_id=current_user.id, target_name=current_user.full_name,
                details={
                    "changes": snapshot_changes(before, user_snapshot(current_user)),
                    "department": primary_department,
                    "approvers": ["Administrator", "Department Coordinator"],
                })
    return current_user


@router.get("/users", response_model=list[schemas.UserOut])
def list_users(all_workspaces: bool = False, db: Session = Depends(get_db),
               current_user: models.User = Depends(get_current_user)):
    """Active users only -- used throughout the app for pickers (assign tester, etc.).
    Reachable by any logged-in user, so CONFIDENTIAL_ROLES are redacted from
    every row unless the caller is an Admin -- see _redact_confidential_roles.

    SRS 7.2 pagination rollout -- deliberately left unpaginated. 9 separate
    call sites across the app (QARequests/index.tsx, Performance.tsx,
    Suppression.tsx, SAST.tsx, DAST.tsx, Defects.tsx, Approvals.tsx,
    SignOff.tsx, Functional.tsx) all use this purely as a name-lookup/
    assignee-picker source needing the complete active directory at once,
    same as the app's other reference-data endpoints (`/api/departments`,
    `/api/application-names`) that were never paginated either -- see
    `list_all_users` below for the actual browsable Admin Users table this
    is not."""
    q = db.query(models.User).filter(models.User.is_active == True)  # noqa: E712
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if all_workspaces and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only an Administrator can list users across workspaces")
    if workspace_ids and not all_workspaces:
        member_ids = select(models.QAWorkspaceMember.user_id).where(
            models.QAWorkspaceMember.workspace_id.in_(workspace_ids),
            models.QAWorkspaceMember.is_active == True,  # noqa: E712
        )
        requester_ids = select(models.QARequest.requester_id).where(
            models.QARequest.qa_workspace_id.in_(workspace_ids),
            models.QARequest.requester_id.isnot(None),
        )
        q = q.filter(or_(models.User.id == current_user.id,
                         models.User.id.in_(member_ids), models.User.id.in_(requester_ids)))
    rows = q.order_by(models.User.full_name).all()
    return [_redact_confidential_roles(u, current_user) for u in rows]


@router.get("/users/all", response_model=pagination.Page[schemas.UserOut])
def list_all_users(
    account_filter: Optional[str] = Query(None, description="'active'|'disabled'|'review', omitted for all"),
    login_type: Optional[str] = None,
    params: pagination.PageParams = Depends(),
    db: Session = Depends(get_db), current_user: models.User = Depends(require_roles(Role.ADMIN)),
):
    """Admin section (Module 9): full user directory, including disabled
    accounts.

    SRS 7.2 pagination rollout -- Admin.tsx's own three filter controls
    (account status, login type, free-text search) all become server-side
    here instead of the in-browser `.filter()` over the whole directory it
    used to fetch in one shot. `account_filter` encapsulates the exact
    active/disabled/needs-review tri-state Admin.tsx's own dropdown already
    offered (mirrors the `queue=`/`assignment=` convention used by
    Defects/Test Executions elsewhere in this rollout) rather than trying
    to force it through the generic multi-value `status` param, since
    "needs review" isn't a value of the `is_active` column at all. See
    `user_summary` below for the account-summary strip / sidebar badge
    counts this list can no longer compute client-side from just the
    current page."""
    q = db.query(models.User)
    if account_filter == "active":
        q = q.filter(models.User.is_active == True)  # noqa: E712
    elif account_filter == "disabled":
        q = q.filter(models.User.is_active == False)  # noqa: E712
    elif account_filter == "review":
        q = q.filter(models.User.needs_role_review == True)  # noqa: E712
    if login_type:
        q = q.filter(models.User.login_type == login_type)
    # Search deliberately doesn't cover role labels (unlike Admin.tsx's old
    # client-side search) -- `roles` is a many-to-many join, not a plain
    # column, and role-name search is a small enough slice of this box's
    # real usage not to justify a join here. Same reasoning now applies to
    # `department` post-2026-08 CR: this still matches only the legacy
    # column (kept in sync with each user's PRIMARY department), not every
    # secondary department -- a minor, deliberate gap, not a join over
    # department_assignments, for the same low-value-vs-complexity reason.
    q = pagination.apply_search(q, params, models.User.full_name, models.User.username, models.User.email, models.User.department)
    # Reported directly: "Surface accounts awaiting review first" -- a
    # two-column order (needs_role_review desc, then name) that doesn't map
    # onto apply_sort's single-column + id-secondary shape, so it's kept as
    # an explicit order_by instead of going through that helper.
    q = q.order_by(models.User.needs_role_review.desc(), models.User.full_name)
    result = pagination.paginate(q, params)
    return pagination.to_page_response(result, params)


@router.get("/users/summary", response_model=schemas.UserSummaryOut)
def user_summary(db: Session = Depends(get_db), current_user: models.User = Depends(require_roles(Role.ADMIN))):
    total = db.query(func.count(models.User.id)).scalar() or 0
    active_count = db.query(func.count(models.User.id)).filter(models.User.is_active == True).scalar() or 0  # noqa: E712
    ldap_count = db.query(func.count(models.User.id)).filter(models.User.login_type == "LDAP").scalar() or 0
    review_count = db.query(func.count(models.User.id)).filter(models.User.needs_role_review == True).scalar() or 0  # noqa: E712
    return {"total": total, "active_count": active_count, "ldap_count": ldap_count, "review_count": review_count}


def _validate_roles(roles: list):
    if not roles:
        raise HTTPException(status_code=400, detail="A user must be assigned at least one role")
    invalid = [r for r in roles if r not in ALL_ROLES]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid role(s): {invalid}")
    incompatible_with_view_only = set(roles) - ({Role.VIEW_ONLY} | DOCUMENT_PORTAL_ROLES)
    if Role.VIEW_ONLY in roles and incompatible_with_view_only:
        raise HTTPException(
            status_code=400,
            detail="View Only can only be combined with dedicated Document Portal roles.",
        )


def _dedupe_roles(roles: list) -> list:
    """De-duplicates while preserving order -- a payload with the same role
    listed twice (e.g. ["ADMIN", "ADMIN"]) would otherwise try to insert two
    UserRole rows with the same (user_id, role) and trip the unique
    constraint on commit."""
    return list(dict.fromkeys(roles))


def _validate_department(db: Session, department):
    """Departments are now DB-backed (models.Department, managed via
    /api/departments) instead of a hardcoded list -- validate against active
    rows there."""
    if not department:
        return
    exists = db.query(models.Department).filter(
        models.Department.name == department, models.Department.is_active == True  # noqa: E712
    ).first()
    if not exists:
        raise HTTPException(status_code=400, detail=f"Invalid department '{department}'")


# 2026-08 "one user can be on multiple departments" CR -- helpers shared by
# create_user/update_user/update_me below.
_UNSET = object()


def _validate_departments(db: Session, departments: list) -> list:
    """Validates every entry against active Department rows (same rule as
    _validate_department, applied per-item), de-duplicating while preserving
    order and dropping any blank entries."""
    cleaned = list(dict.fromkeys(d for d in (departments or []) if d and d.strip()))
    for d in cleaned:
        _validate_department(db, d)
    return cleaned


def _resolve_departments_payload(department, departments) -> list:
    """A create/update payload may arrive as the new plural `departments`
    list (Admin.tsx's multi-select), or -- backward compatibility -- the
    legacy singular `department` string. `departments`, if present, always
    wins outright (even an empty list, meaning "clear all departments")."""
    if departments is not None:
        return list(departments)
    return [department] if department else []


def _set_user_departments(db: Session, user: models.User, departments: list) -> None:
    """Replaces user.department_assignments wholesale (not a merge) -- same
    delete-then-flush-then-insert pattern update_user already uses for roles
    below, so an unchanged department in the new list doesn't trip
    uq_qap_user_departments by trying to INSERT before the old row's DELETE
    is flushed. Also keeps the legacy `department` column in sync with the
    new primary (first) entry, for every consumer that still reads that
    column directly instead of `.departments`/`.has_department(...)`."""
    for da in list(user.department_assignments):
        db.delete(da)
    db.flush()
    for d in departments:
        db.add(models.UserDepartment(user_id=user.id, department=d))
    user.department = departments[0] if departments else None
    db.flush()
    db.expire(user, ["department_assignments"])


def _validated_department_units(db: Session, unit_ids: list[int] | None, departments: list[str]):
    ids = list(dict.fromkeys(unit_ids or []))
    if not ids:
        return []
    rows = db.query(models.DepartmentUnit).join(models.Department).filter(
        models.DepartmentUnit.id.in_(ids),
        models.DepartmentUnit.is_active == True,  # noqa: E712
        models.Department.is_active == True,  # noqa: E712
    ).all()
    if {row.id for row in rows} != set(ids):
        raise HTTPException(400, "One or more selected department units are invalid or inactive")
    invalid = [row.name for row in rows if row.department.name not in departments]
    if invalid:
        raise HTTPException(400, "Department units must belong to one of the user's assigned departments")
    by_id = {row.id: row for row in rows}
    return [by_id[value] for value in ids]


def _set_user_department_units(db: Session, user: models.User, units) -> None:
    for assignment in list(user.department_unit_assignments):
        db.delete(assignment)
    db.flush()
    for unit in units:
        db.add(models.UserDepartmentUnit(user_id=user.id, unit_id=unit.id))
    db.flush()
    db.expire(user, ["department_unit_assignments"])


@router.post("/users", response_model=schemas.UserOut)
def create_user(payload: schemas.UserCreate, request: Request, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): user mapping = department(s) + one or more
    roles (access types). A user can hold several roles, and (2026-08 CR)
    several departments, at once -- all are active simultaneously."""
    from ..auth import hash_password
    if db.query(models.User).filter(models.User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="Username already exists")
    _validate_roles(payload.roles)
    roles = _dedupe_roles(payload.roles)
    departments = _validate_departments(db, _resolve_departments_payload(payload.department, payload.departments))
    units = _validated_department_units(db, payload.department_unit_ids, departments)
    login_type = payload.login_type or LoginType.STANDARD
    if login_type not in ALL_LOGIN_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid login_type '{login_type}'")
    if login_type == LoginType.STANDARD and not payload.password:
        raise HTTPException(status_code=400, detail="password is required for Standard accounts")

    user = models.User(
        username=payload.username, full_name=payload.full_name, email=payload.email,
        department=departments[0] if departments else None, login_type=login_type,
        show_in_user_dropdowns=payload.show_in_user_dropdowns,
        role_assignments=[models.UserRole(role=r) for r in roles],
        department_assignments=[models.UserDepartment(department=d) for d in departments],
        hashed_password=hash_password(payload.password) if login_type == LoginType.STANDARD else None,
    )
    db.add(user)
    db.flush()
    if payload.department_unit_ids is not None:
        _set_user_department_units(db, user, units)
    from ..workspace_service import ensure_default_workspace_membership
    ensure_default_workspace_membership(db, user)
    db.commit()
    db.refresh(user)
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="USER_CREATED", actor=current_user,
                request=request, status_code=201, target_type="USER", target_id=user.id,
                target_name=user.full_name, details={"after": user_snapshot(user)})
    return user


@router.patch("/users/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: int, payload: schemas.UserUpdate, request: Request, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): reassign role(s)/department(s), change login type, activate/deactivate, edit profile fields."""
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    before = user_snapshot(user)

    data = payload.model_dump(exclude_unset=True)
    new_roles = data.pop("roles", None)
    if new_roles is not None:
        _validate_roles(new_roles)
        new_roles = _dedupe_roles(new_roles)

    # An administrator must never be able to lock themselves out of the
    # administration boundary.  This check belongs on the API (not only in
    # Admin.tsx), because the endpoint can also be called directly.  Another
    # administrator may still remove this user's ADMIN role or deactivate
    # the account, which preserves the requested two-person control.
    is_self_admin_update = user.id == current_user.id and user.has_role(Role.ADMIN)
    if is_self_admin_update and new_roles is not None and Role.ADMIN not in new_roles:
        raise HTTPException(
            status_code=403,
            detail="You cannot remove your own Administrator access. Another Administrator must make this change.",
        )
    if is_self_admin_update and data.get("is_active") is False:
        raise HTTPException(
            status_code=403,
            detail="You cannot deactivate your own Administrator account. Another Administrator must make this change.",
        )
    # 2026-08 CR -- `departments` (plural), if the caller sent it at all
    # (even as an empty list), takes priority over the legacy singular
    # `department`. Popped out of `data` so the generic setattr loop below
    # never writes the legacy column directly -- _set_user_departments is
    # the only thing that's allowed to touch it now, so it stays in sync
    # with department_assignments.
    raw_department = data.pop("department", _UNSET)
    raw_departments = data.pop("departments", _UNSET)
    raw_unit_ids = data.pop("department_unit_ids", _UNSET)
    new_departments = None
    if raw_departments is not _UNSET:
        new_departments = _validate_departments(db, raw_departments)
    elif raw_department is not _UNSET:
        new_departments = _validate_departments(db, [raw_department] if raw_department else [])
    effective_departments = new_departments if new_departments is not None else user.departments
    new_units = None
    if raw_unit_ids is not _UNSET:
        new_units = _validated_department_units(db, raw_unit_ids, effective_departments)
    # Role assignment is exact.  Workspace membership is
    # an organisational scope, not an implicit grant of QA Engineer or
    # Document Portal access.  This lets an administrator assign an
    # executive-only role (for example AGM - QA) without silently expanding
    # that person's permissions.
    effective_roles = new_roles if new_roles is not None else user.roles
    if "login_type" in data and data["login_type"] not in ALL_LOGIN_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid login_type '{data['login_type']}'")
    # Note: switching an LDAP account to Standard leaves it with no usable
    # password until an admin sets one via POST /users/{id}/reset-password.

    for k, v in data.items():
        setattr(user, k, v)
    if new_departments is not None:
        _set_user_departments(db, user, new_departments)
    if new_units is not None:
        _set_user_department_units(db, user, new_units)
    if set(effective_roles) != set(user.roles):
        # Replace the full set of role assignments (not a merge/append).
        # Delete the old rows and flush *before* adding the new ones -- if we
        # instead did `user.role_assignments = [...]` in one step, and the new
        # list happens to include a role the user already had (e.g. keeping
        # QA_LEAD while also adding SECURITY_ANALYST), SQLAlchemy can attempt
        # to INSERT the new (user_id, role) row before the old orphaned row's
        # DELETE has been issued, which trips the uq_qap_user_roles unique
        # constraint and raises an unhandled IntegrityError (500).
        for ra in list(user.role_assignments):
            db.delete(ra)
        db.flush()
        for r in effective_roles:
            db.add(models.UserRole(user_id=user.id, role=r))
        db.flush()
        db.expire(user, ["role_assignments"])
        # An explicit role assignment is exactly the review action the
        # "needs_role_review" flag (set on auto-provisioned LDAP accounts) is
        # waiting for.
        if effective_roles:
            user.needs_role_review = False
    # Re-submitting an already present provisional role is still an explicit
    # Administrator approval. The review flag, rather than role difference,
    # is the authoritative onboarding gate.
    if new_roles is not None and effective_roles:
        user.needs_role_review = False

    if user.is_active:
        from ..workspace_service import ensure_default_workspace_membership
        ensure_default_workspace_membership(db, user)
    db.commit()
    db.refresh(user)
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="USER_ACCESS_UPDATED", actor=current_user,
                request=request, status_code=200, target_type="USER", target_id=user.id,
                target_name=user.full_name,
                details={"changes": snapshot_changes(before, user_snapshot(user))})
    return user


@router.post("/users/{user_id}/reset-password", response_model=schemas.UserOut)
def reset_password(user_id: int, payload: schemas.PasswordReset, request: Request, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): set/reset a Standard account's local password."""
    from ..auth import hash_password
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.login_type != LoginType.STANDARD:
        raise HTTPException(status_code=400,
                             detail="Only Standard accounts have a local password to reset")
    if not payload.new_password:
        raise HTTPException(status_code=400, detail="new_password is required")
    user.hashed_password = hash_password(payload.new_password)
    db.commit()
    db.refresh(user)
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="PASSWORD_RESET", actor=current_user,
                request=request, status_code=200, target_type="USER", target_id=user.id,
                target_name=user.full_name,
                details={"changed": "local password", "password_value_stored_in_audit": False})
    return user


# ---- Department Coordinator local administration -------------------------
# The grant is an explicit (user, department, workspace) assignment managed
# by a System Admin. It is intentionally independent of job title: CM/AGM
# roles no longer imply local-admin access, and any user may be assigned.
def _coordinator_assignments_for_active_workspace(
    db: Session,
    current_user: models.User,
) -> list[models.DepartmentCoordinatorAssignment]:
    workspace_id = getattr(current_user, "active_qa_workspace_id", None)
    workspace = db.get(models.QAWorkspace, workspace_id) if workspace_id is not None else None
    if workspace is None or not workspace.is_active:
        return []
    applicable_workspace_ids = {workspace.id}
    if workspace.parent_workspace_id is not None:
        applicable_workspace_ids.add(workspace.parent_workspace_id)
    return [
        assignment for assignment in current_user.department_coordinator_access
        if assignment.is_active and assignment.workspace_id in applicable_workspace_ids
    ]


def _coordinator_department_names(db: Session, current_user: models.User) -> list[str]:
    return list(dict.fromkeys(
        assignment.department_name
        for assignment in _coordinator_assignments_for_active_workspace(db, current_user)
        if assignment.department_name
    ))


def _require_department_coordinator(db: Session, current_user: models.User) -> list[str]:
    departments = _coordinator_department_names(db, current_user)
    if not departments:
        raise HTTPException(
            status_code=403,
            detail="You are not a Department Coordinator in the active workspace",
        )
    return departments


def _coordinator_scope_allows(db: Session, current_user: models.User, target: models.User) -> bool:
    for assignment in _coordinator_assignments_for_active_workspace(db, current_user):
        if not assignment.department_name:
            continue
        if target.has_department(assignment.department_name):
            return True
    return False


def _coordinator_approval_workspace_rows(
    db: Session,
    current_user: models.User,
) -> list[dict]:
    """Return direct coordinator workspaces and their active descendants."""
    assignments = [
        assignment for assignment in current_user.department_coordinator_access
        if assignment.is_active and assignment.department_name
    ]
    direct_departments: dict[int, set[str]] = defaultdict(set)
    for assignment in assignments:
        direct_departments[assignment.workspace_id].add(assignment.department_name)
    if not direct_departments:
        return []

    workspaces = db.query(models.QAWorkspace).filter(
        models.QAWorkspace.is_active == True,  # noqa: E712
    ).order_by(models.QAWorkspace.name).all()
    by_id = {workspace.id: workspace for workspace in workspaces}
    result: list[dict] = []
    for workspace in workspaces:
        departments: set[str] = set()
        current = workspace
        visited: set[int] = set()
        while current is not None and current.id not in visited:
            visited.add(current.id)
            departments.update(direct_departments.get(current.id, set()))
            current = by_id.get(current.parent_workspace_id)
        if departments:
            result.append({
                "id": workspace.id,
                "workspace_key": workspace.workspace_key,
                "name": workspace.name,
                "parent_workspace_id": workspace.parent_workspace_id,
                "coordinator_departments": sorted(departments),
            })
    return result


def _coordinator_can_place_user_in_workspace(
    db: Session,
    current_user: models.User,
    target: models.User,
    workspace_id: int,
) -> bool:
    """Validate an explicit first-login workspace choice.

    A coordinator may approve into any active workspace where they hold an
    active coordinator assignment for one of the target user's departments.
    The choice is not inferred from the page's currently selected workspace.
    """
    return any(
        row["id"] == workspace_id
        and any(target.has_department(department) for department in row["coordinator_departments"])
        for row in _coordinator_approval_workspace_rows(db, current_user)
    )


def _coordinator_can_manage_unit(current_user: models.User, unit: models.DepartmentUnit) -> bool:
    """Return whether a unit sits inside one of the coordinator's active scopes."""
    workspace_id = getattr(current_user, "active_qa_workspace_id", None)
    lineage: set[int] = set()
    current = unit
    while current and current.id not in lineage:
        lineage.add(current.id)
        current = current.parent
    return any(
        assignment.workspace_id == workspace_id
        and assignment.department_id == unit.department_id
        and (assignment.department_unit_id is None or assignment.department_unit_id in lineage)
        for assignment in current_user.department_coordinator_access
    )


def _coordinator_has_department_scope(current_user: models.User, department_id: int) -> bool:
    workspace_id = getattr(current_user, "active_qa_workspace_id", None)
    return any(
        assignment.workspace_id == workspace_id
        and assignment.department_id == department_id
        and assignment.department_unit_id is None
        for assignment in current_user.department_coordinator_access
    )


def _require_managed_department_target(
    db: Session,
    current_user: models.User,
    target: models.User,
    *,
    require_workspace_membership: bool,
) -> None:
    if target.id == current_user.id:
        raise HTTPException(status_code=403, detail="You cannot manage your own account here")
    if "ADMIN" in target.roles:
        raise HTTPException(status_code=403, detail="Administrator accounts cannot be managed from here")
    # See Role.SCALE_6_PLUS's own comment in constants.py -- a confidential,
    # System-Admin-only role. Given the SAME "cannot be managed/seen from
    # here" treatment as an ADMIN account itself, not merely a redacted
    # label, so a local admin can't even discover this role exists by probing
    # a user ID directly.
    if any(r in target.roles for r in CONFIDENTIAL_ROLES):
        raise HTTPException(status_code=403, detail="This account cannot be managed from here")
    if target.admin_managed_only:
        raise HTTPException(status_code=403,
                             detail="This account is managed by a System Admin only")
    managed_departments = _require_department_coordinator(db, current_user)
    workspace_id = getattr(current_user, "active_qa_workspace_id", None)
    if require_workspace_membership and not any(
        membership.workspace_id == workspace_id for membership in target.qa_workspace_access
    ):
        raise HTTPException(
            status_code=403,
            detail="You can only manage users who belong to the active workspace",
        )
    if not _coordinator_scope_allows(db, current_user, target):
        raise HTTPException(
            status_code=403,
            detail=f"You can only manage users in your assigned coordinator scope "
                   f"({', '.join(managed_departments)}).",
        )


def _require_own_department_target(db: Session, current_user: models.User, target: models.User) -> None:
    _require_managed_department_target(
        db, current_user, target, require_workspace_membership=True,
    )


def _local_admin_assignable_roles(current_user: models.User, target: models.User, db: Session = None) -> list[str]:
    """Non-privileged roles available inside the explicit managed scope.

    QA teams may have any department name, so role availability cannot depend
    on one hard-coded COE department label. The target guard has already
    proved department/workspace scope before this helper is called.
    """
    if db is not None:
        import json
        setting = db.query(models.SystemSetting).filter_by(key='coordinator_assignable_roles').first()
        if setting is not None:
            return [role for role in json.loads(setting.value) if role in ALL_ROLES and role not in {Role.ADMIN, *CONFIDENTIAL_ROLES}]
    return list(dict.fromkeys(
        DEPARTMENT_ADMIN_ASSIGNABLE_ROLES + QA_ADMIN_ASSIGNABLE_ROLES
    ))


@router.get('/local-admin/assignable-roles', response_model=list[str])
def coordinator_assignable_roles(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    if Role.ADMIN not in current_user.roles:
        _require_department_coordinator(db, current_user)
    return _local_admin_assignable_roles(current_user, current_user, db)


@router.put('/local-admin/assignable-roles', response_model=list[str])
def configure_coordinator_roles(roles: list[str], request: Request, db: Session = Depends(get_db),
                                current_user: models.User = Depends(require_roles(Role.ADMIN))):
    import json
    if Role.ADMIN not in current_user.roles:
        raise HTTPException(403, 'Only System Admin can configure coordinator roles')
    if any(role not in ALL_ROLES or role in {Role.ADMIN, *CONFIDENTIAL_ROLES} for role in roles):
        raise HTTPException(400, 'Choose valid roles. Administrator and confidential roles cannot be delegated.')
    selected = list(dict.fromkeys(roles))
    before = _local_admin_assignable_roles(current_user, current_user, db)
    setting = db.query(models.SystemSetting).filter_by(key='coordinator_assignable_roles').first()
    if setting is None:
        setting = models.SystemSetting(key='coordinator_assignable_roles', value=json.dumps(selected))
        db.add(setting)
    else:
        setting.value = json.dumps(selected)
    db.commit()
    write_audit(db, actor=current_user, event_type='ACCESS_MANAGEMENT', action='COORDINATOR_ROLE_POLICY_UPDATED', request=request,
                target_type='SYSTEM_SETTING', target_name='Coordinator assignable roles',
                details={'before': before, 'after': selected})
    return selected


@router.get("/local-admin/users", response_model=list[schemas.UserOut])
def list_local_admin_users(db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    """Every user mapped to the local admin's own department (any status,
    so a previously-disabled account can be re-activated too), excluding
    their own account, any Administrator accounts, any account flagged
    admin_managed_only, and any account holding a CONFIDENTIAL_ROLES role
    (see Role.SCALE_6_PLUS's own comment) -- mirrors the guard rails in
    _require_own_department_target/update_local_admin_user below.

    SRS 7.2 pagination rollout -- deliberately left unpaginated, unlike
    `list_all_users` above. This roster is scoped to a single department
    (one local admin's own headcount, minus admins/confidential roles), not
    an org-wide directory -- naturally bounded the same way Test Cycles/
    Test Projects and Pending Approvals were left alone elsewhere in this
    rollout, rather than the unbounded-growth case pagination exists for."""
    managed_departments = _require_department_coordinator(db, current_user)
    workspace_id = getattr(current_user, "active_qa_workspace_id", None)
    workspace_member_ids = select(models.QAWorkspaceMember.user_id).where(
        models.QAWorkspaceMember.workspace_id == workspace_id,
        models.QAWorkspaceMember.is_active == True,  # noqa: E712
    )
    rows = (
        db.query(models.User)
        .filter(
            or_(
                models.User.id.in_(workspace_member_ids),
                models.User.needs_role_review == True,  # noqa: E712
            ),
            or_(
                models.User.department.in_(managed_departments),
                models.User.department_assignments.any(
                    models.UserDepartment.department.in_(managed_departments)
                ),
            ),
            models.User.id != current_user.id,
        )
        .order_by(models.User.full_name)
        .all()
    )
    return [
        u for u in rows
        if "ADMIN" not in u.roles and not u.admin_managed_only
        and not any(r in u.roles for r in CONFIDENTIAL_ROLES)
        and _coordinator_scope_allows(db, current_user, u)
    ]


@router.get(
    "/local-admin/workspace-candidates",
    response_model=list[schemas.LocalAdminWorkspaceCandidateOut],
)
def list_local_admin_workspace_candidates(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _require_department_coordinator(db, current_user)
    return []


@router.get(
    "/local-admin/approval-workspaces",
    response_model=list[schemas.LocalAdminApprovalWorkspaceOut],
)
def list_local_admin_approval_workspaces(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Eligible onboarding destinations for this coordinator.

    A parent-level coordinator assignment covers the parent and all active
    descendants. A child-level assignment remains limited to that child.
    """
    _require_department_coordinator(db, current_user)
    return _coordinator_approval_workspace_rows(db, current_user)


@router.post("/local-admin/workspace-members", response_model=schemas.UserOut)
def add_local_admin_workspace_member(
    payload: schemas.LocalAdminWorkspaceMemberCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _require_department_coordinator(db, current_user)
    raise HTTPException(
        status_code=403,
        detail="Workspace membership is managed by a System Administrator or Parent Workspace Admin",
    )


@router.patch("/local-admin/users/{user_id}", response_model=schemas.UserOut)
def update_local_admin_user(user_id: int, payload: schemas.LocalAdminUserUpdate, request: Request,
                             db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    was_pending_review = bool(user.needs_role_review)
    _require_managed_department_target(
        db, current_user, user, require_workspace_membership=not was_pending_review,
    )
    before = user_snapshot(user)

    # A valid notification address is operational contact data, not an
    # access-control attribute. Local Department Coordinators may maintain it
    # for people in their own department, under the same scope/protected-user
    # restrictions as role and activation changes above.
    updates = payload.model_dump(exclude_unset=True)
    if payload.workspace_id is not None and not (was_pending_review and payload.roles is not None):
        raise HTTPException(
            status_code=400,
            detail="A destination workspace can be selected only while approving a first-login access request",
        )
    if "email" in updates:
        user.email = (updates["email"] or "").strip() or None

    if payload.roles is not None:
        assignable = _local_admin_assignable_roles(current_user, user, db)
        invalid = [r for r in payload.roles if r not in assignable]
        if invalid:
            raise HTTPException(
                status_code=403,
                detail=f"You are not permitted to assign: {invalid}. Ask a System Admin for these.",
            )
        # Preserve anything the user already holds outside THIS local admin's
        # own authority -- including roles that belong to the OTHER kind of
        # local admin's subset (e.g. a business Department Head must not be
        # able to strip someone's QA_LEAD role just because it wasn't in
        # their own submitted list, and vice versa for an Executive  and
        # e.g. SM) -- otherwise this would silently strip them, since the
        # assignable subset submitted here is only ever a partial view of
        # ALL_ROLES.
        if was_pending_review and not payload.roles:
            raise HTTPException(status_code=400, detail="Select at least one role to approve this access request")
        if was_pending_review and payload.workspace_id is None:
            raise HTTPException(status_code=400, detail="Select a destination workspace to approve this access request")
        if was_pending_review and not _coordinator_can_place_user_in_workspace(
            db, current_user, user, payload.workspace_id,
        ):
            raise HTTPException(
                status_code=403,
                detail="You cannot approve this user into the selected workspace",
            )
        preserved = [r for r in user.roles if r not in assignable]
        new_roles = list(dict.fromkeys(preserved + payload.roles))
        for ra in list(user.role_assignments):
            db.delete(ra)
        db.flush()
        for r in new_roles:
            db.add(models.UserRole(user_id=user.id, role=r))
        if new_roles:
            user.needs_role_review = False

        # Role review is an onboarding approval, not ordinary workspace
        # membership administration. The coordinator explicitly chooses a
        # permitted destination; later membership changes remain with
        # Parent/System Admin.
        if was_pending_review:
            workspace_id = payload.workspace_id
            membership = db.query(models.QAWorkspaceMember).filter(
                models.QAWorkspaceMember.workspace_id == workspace_id,
                models.QAWorkspaceMember.user_id == user.id,
            ).first()
            if membership is None:
                db.add(models.QAWorkspaceMember(
                    workspace_id=workspace_id, user_id=user.id,
                    role="WORKSPACE_MEMBER", is_active=True,
                ))
            else:
                membership.role = "WORKSPACE_MEMBER"
                membership.is_active = True
            from ..workspace_service import remove_default_membership_after_assignment
            remove_default_membership_after_assignment(db, user, workspace_id)
            user.preferred_qa_workspace_id = workspace_id

    if payload.is_active is not None:
        user.is_active = payload.is_active

    db.commit()
    db.refresh(user)
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="DEPARTMENT_USER_ACCESS_UPDATED",
                actor=current_user, request=request, status_code=200, target_type="USER",
                target_id=user.id, target_name=user.full_name,
                details={"changes": snapshot_changes(before, user_snapshot(user)),
                         "scope": ", ".join(_coordinator_department_names(db, current_user)),
                         "approved_workspace_id": payload.workspace_id if was_pending_review else None})
    return user
