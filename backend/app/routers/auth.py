from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .. import models, schemas, pagination, email_notifications
from ..database import get_db
from ..audit_service import snapshot_changes, user_snapshot, write_audit
from ..auth import (
    verify_password, create_access_token, ldap_authenticate, ldap_authenticate_with_profile, LDAPAuthError,
)
from ..deps import get_current_user, require_roles
from ..constants import (
    Role, ALL_ROLES, LoginType, ALL_LOGIN_TYPES,
    DEPARTMENT_ADMIN_ASSIGNABLE_ROLES, QA_ADMIN_ASSIGNABLE_ROLES, CONFIDENTIAL_ROLES,
    QA_DEPARTMENT, OTHER_DEPARTMENT,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


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
                write_audit(db, event_type="AUTHENTICATION", action="LOGIN_FAILED", outcome="FAILED",
                            actor=user, request=request, status_code=401,
                            details={"reason": "Invalid username or password"})
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
        else:
            if not user.hashed_password or not verify_password(form_data.password, user.hashed_password):
                write_audit(db, event_type="AUTHENTICATION", action="LOGIN_FAILED", outcome="FAILED",
                            actor=user, request=request, status_code=401,
                            details={"reason": "Invalid username or password"})
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

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


@router.get("/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(get_current_user)):
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
def list_users(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
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
    rows = db.query(models.User).filter(models.User.is_active == True).order_by(models.User.full_name).all()  # noqa: E712
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
    login_type = payload.login_type or LoginType.STANDARD
    if login_type not in ALL_LOGIN_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid login_type '{login_type}'")
    if login_type == LoginType.STANDARD and not payload.password:
        raise HTTPException(status_code=400, detail="password is required for Standard accounts")

    user = models.User(
        username=payload.username, full_name=payload.full_name, email=payload.email,
        department=departments[0] if departments else None, login_type=login_type,
        role_assignments=[models.UserRole(role=r) for r in roles],
        department_assignments=[models.UserDepartment(department=d) for d in departments],
        hashed_password=hash_password(payload.password) if login_type == LoginType.STANDARD else None,
    )
    db.add(user)
    db.flush()
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
    new_departments = None
    if raw_departments is not _UNSET:
        new_departments = _validate_departments(db, raw_departments)
    elif raw_department is not _UNSET:
        new_departments = _validate_departments(db, [raw_department] if raw_department else [])
    # Role assignment is exact.  Being mapped to COE - Quality Assurance is
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
        user.needs_role_review = False

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


# ---- Local admin: a Department Head (business departments) or an Executive
# COE (the QA department) managing their own department's users -- see
# constants.DEPARTMENT_ADMIN_ASSIGNABLE_ROLES/QA_ADMIN_ASSIGNABLE_ROLES --
# reduces sole dependency on a System Admin for routine role assignment
# within one department. Two deliberately narrow endpoints, not a widened
# version of the Admin-only ones above: a local admin can only ever see/
# touch users already mapped to their own department, can only assign
# their own kind's working-level role subset (a business Department Head
# gets DEPARTMENT_ADMIN_ASSIGNABLE_ROLES; a QA Executive -- who is mapped
# to constants.QA_DEPARTMENT same as every other QA staffer, so the
# department-scoping below already confines them to QA -- gets
# QA_ADMIN_ASSIGNABLE_ROLES instead), can never touch ADMIN/
# DEPARTMENT_HEAD_CM/DEPARTMENT_HEAD_AGM/CHIEF_MANAGER_QA/AGM_QA on anyone
# (including roles a target user already holds outside their own assignable
# subset -- see the "preserved" logic below, which protects the OTHER kind
# of local admin's roles too), and can never edit their own account this
# way.
def _require_own_department_target(current_user: models.User, target: models.User) -> None:
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
    if not current_user.departments:
        raise HTTPException(status_code=403, detail="Your own profile has no department set")
    # 2026-08 "one user can be on multiple departments" CR -- a local admin
    # who now belongs to several departments may manage a target user mapped
    # to ANY of them (not just their first/primary one), and the target
    # itself may also belong to several departments -- any overlap is
    # sufficient, same rule as reassignment.py's Department Head check.
    if not target.has_department(*current_user.departments):
        raise HTTPException(
            status_code=403,
            detail=f"You can only manage users mapped to one of your own departments "
                   f"({', '.join(current_user.departments)}).",
        )


def _local_admin_assignable_roles(current_user: models.User) -> list:
    """Which role subset this particular local admin may assign -- the
    QA Executive (QA department's own local admin) gets QA_ADMIN_ASSIGNABLE_ROLES,
    every other local admin (a business Department Head) gets
    DEPARTMENT_ADMIN_ASSIGNABLE_ROLES. Checked by role rather than by
    department string so it stays correct even if QA_DEPARTMENT's exact
    value ever changes. Deliberately checks `.roles` directly rather than
    `has_role()` -- `has_role()` always returns True for an Administrator
    account regardless of which role(s) it's asked about, which would
    wrongly hand an Admin who somehow hits this endpoint the QA subset."""
    if any(role in current_user.roles for role in (
        Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    )):
        return QA_ADMIN_ASSIGNABLE_ROLES
    return DEPARTMENT_ADMIN_ASSIGNABLE_ROLES


@router.get("/local-admin/users", response_model=list[schemas.UserOut])
def list_local_admin_users(db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(
                                Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM,
                                Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
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
    if not current_user.departments:
        raise HTTPException(status_code=400, detail="Your own profile has no department set")
    # 2026-08 CR -- union of every department this local admin belongs to,
    # not just their primary one (mirrors _require_own_department_target).
    rows = (
        db.query(models.User)
        .filter(
            models.User.department_assignments.any(
                models.UserDepartment.department.in_(current_user.departments)
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
    ]


@router.patch("/local-admin/users/{user_id}", response_model=schemas.UserOut)
def update_local_admin_user(user_id: int, payload: schemas.LocalAdminUserUpdate, request: Request,
                             db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(
                                 Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM,
                                 Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    _require_own_department_target(current_user, user)
    before = user_snapshot(user)

    # A valid notification address is operational contact data, not an
    # access-control attribute. Local Department Coordinators may maintain it
    # for people in their own department, under the same scope/protected-user
    # restrictions as role and activation changes above.
    updates = payload.model_dump(exclude_unset=True)
    if "email" in updates:
        user.email = (updates["email"] or "").strip() or None

    if payload.roles is not None:
        assignable = _local_admin_assignable_roles(current_user)
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
        preserved = [r for r in user.roles if r not in assignable]
        new_roles = list(dict.fromkeys(preserved + payload.roles))
        for ra in list(user.role_assignments):
            db.delete(ra)
        db.flush()
        for r in new_roles:
            db.add(models.UserRole(user_id=user.id, role=r))
        user.needs_role_review = False

    if payload.is_active is not None:
        user.is_active = payload.is_active

    db.commit()
    db.refresh(user)
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="DEPARTMENT_USER_ACCESS_UPDATED",
                actor=current_user, request=request, status_code=200, target_type="USER",
                target_id=user.id, target_name=user.full_name,
                details={"changes": snapshot_changes(before, user_snapshot(user)),
                         "scope": ", ".join(current_user.departments)})
    return user
