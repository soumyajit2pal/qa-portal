from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .. import models, schemas
from ..database import get_db
from ..audit_service import snapshot_changes, user_snapshot, write_audit
from ..auth import (
    verify_password, create_access_token, ldap_authenticate, ldap_authenticate_with_profile, LDAPAuthError,
)
from ..deps import get_current_user, require_roles
from ..constants import (
    Role, ALL_ROLES, LoginType, ALL_LOGIN_TYPES, DEFAULT_LDAP_PROVISION_ROLE,
    DEPARTMENT_ADMIN_ASSIGNABLE_ROLES, QA_ADMIN_ASSIGNABLE_ROLES,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=schemas.Token)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == form_data.username).first()
    just_provisioned = False

    if not user:
        # Unknown username: just-in-time provision from LDAP rather than requiring
        # an admin to pre-create the account. A successful directory bind on this
        # first login creates the local User row automatically, defaulting to the
        # lowest-privilege role and flagged for an admin to review in the Admin
        # section (needs_role_review) -- this is where "proper access" gets granted.
        try:
            profile = ldap_authenticate_with_profile(form_data.username, form_data.password)
        except LDAPAuthError:
            profile = None
        if not profile:
            write_audit(db, event_type="AUTHENTICATION", action="LOGIN_FAILED", outcome="FAILED",
                        actor_username=form_data.username, request=request, status_code=401,
                        details={"reason": "Invalid username or password"})
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

        user = models.User(
            username=form_data.username,
            full_name=profile.get("full_name") or form_data.username,
            email=profile.get("email"),
            department=profile.get("department"),
            role_assignments=[models.UserRole(role=DEFAULT_LDAP_PROVISION_ROLE)],
            login_type=LoginType.LDAP,
            hashed_password=None,
            needs_role_review=True,
            # Prompt this person once, right after this first login, to
            # explicitly confirm/pick their department from our own
            # qap_departments list -- whatever profile.get("department") just
            # returned from the directory (often blank, or free text that
            # doesn't exactly match one of our canonical department names) is
            # only ever a starting guess. See PATCH /api/auth/me below.
            needs_department_selection=True,
        )
        db.add(user)
        try:
            db.commit()
            db.refresh(user)
            just_provisioned = True
        except IntegrityError:
            # Lost a race with a concurrent first-login for the same username.
            db.rollback()
            user = db.query(models.User).filter(models.User.username == form_data.username).first()

    if not user.is_active:
        write_audit(db, event_type="AUTHENTICATION", action="LOGIN_BLOCKED", outcome="FAILED",
                    actor=user, request=request, status_code=403, details={"reason": "User is disabled"})
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is disabled")

    if not just_provisioned:
        # Credentials were already verified above for a just-provisioned account;
        # otherwise verify them the normal way for this account's login type.
        if user.login_type == LoginType.LDAP:
            try:
                authenticated = ldap_authenticate(form_data.username, form_data.password)
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
        write_audit(db, event_type="ACCESS_MANAGEMENT", action="USER_AUTO_PROVISIONED",
                    actor=user, request=request, status_code=201, target_type="USER",
                    target_id=user.id, target_name=user.full_name,
                    details={"after": user_snapshot(user), "source": "LDAP first login"})
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


@router.patch("/me", response_model=schemas.UserOut)
def update_me(payload: schemas.DepartmentSelection, request: Request, db: Session = Depends(get_db),
              current_user: models.User = Depends(get_current_user)):
    """Self-service -- the one field any logged-in user (not just an Admin)
    can set on their own profile. Currently only used by the first-LDAP-login
    department-selection popup, but written generically (validates against
    the same active-department list as the Admin-only PATCH /users/{id}
    below) rather than as a one-shot "first login only" endpoint, so it also
    works if someone's department simply needs correcting later."""
    if not payload.department or not payload.department.strip():
        raise HTTPException(status_code=400, detail="Department is required")
    _validate_department(db, payload.department)
    before = user_snapshot(current_user)
    current_user.department = payload.department
    current_user.needs_department_selection = False
    db.commit()
    db.refresh(current_user)
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="SELF_PROFILE_UPDATED",
                actor=current_user, request=request, status_code=200, target_type="USER",
                target_id=current_user.id, target_name=current_user.full_name,
                details={"changes": snapshot_changes(before, user_snapshot(current_user))})
    return current_user


@router.get("/users", response_model=list[schemas.UserOut])
def list_users(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Active users only -- used throughout the app for pickers (assign tester, etc.)."""
    return db.query(models.User).filter(models.User.is_active == True).order_by(models.User.full_name).all()  # noqa: E712


@router.get("/users/all", response_model=list[schemas.UserOut])
def list_all_users(db: Session = Depends(get_db), current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): full user directory, including disabled accounts."""
    return db.query(models.User).order_by(models.User.full_name).all()


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


@router.post("/users", response_model=schemas.UserOut)
def create_user(payload: schemas.UserCreate, request: Request, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): user mapping = department + one or more roles
    (access types). A user can hold several roles at once (e.g. QA Lead +
    Security Analyst) -- all are active simultaneously."""
    from ..auth import hash_password
    if db.query(models.User).filter(models.User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="Username already exists")
    _validate_roles(payload.roles)
    roles = _dedupe_roles(payload.roles)
    _validate_department(db, payload.department)
    login_type = payload.login_type or LoginType.STANDARD
    if login_type not in ALL_LOGIN_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid login_type '{login_type}'")
    if login_type == LoginType.STANDARD and not payload.password:
        raise HTTPException(status_code=400, detail="password is required for Standard accounts")

    user = models.User(
        username=payload.username, full_name=payload.full_name, email=payload.email,
        department=payload.department, login_type=login_type,
        role_assignments=[models.UserRole(role=r) for r in roles],
        hashed_password=hash_password(payload.password) if login_type == LoginType.STANDARD else None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    write_audit(db, event_type="ACCESS_MANAGEMENT", action="USER_CREATED", actor=current_user,
                request=request, status_code=201, target_type="USER", target_id=user.id,
                target_name=user.full_name, details={"after": user_snapshot(user)})
    return user


@router.patch("/users/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: int, payload: schemas.UserUpdate, request: Request, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): reassign role(s), change login type, activate/deactivate, edit profile fields."""
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    before = user_snapshot(user)

    data = payload.model_dump(exclude_unset=True)
    new_roles = data.pop("roles", None)
    if new_roles is not None:
        _validate_roles(new_roles)
        new_roles = _dedupe_roles(new_roles)
    if "department" in data:
        _validate_department(db, data["department"])
    if "login_type" in data and data["login_type"] not in ALL_LOGIN_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid login_type '{data['login_type']}'")
    # Note: switching an LDAP account to Standard leaves it with no usable
    # password until an admin sets one via POST /users/{id}/reset-password.

    for k, v in data.items():
        setattr(user, k, v)
    if new_roles is not None:
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
        for r in new_roles:
            db.add(models.UserRole(user_id=user.id, role=r))
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
# gets DEPARTMENT_ADMIN_ASSIGNABLE_ROLES; an Executive COE -- who is mapped
# to constants.QA_DEPARTMENT same as every other QA staffer, so the
# department-scoping below already confines them to QA -- gets
# QA_ADMIN_ASSIGNABLE_ROLES instead), can never touch ADMIN/
# DEPARTMENT_HEAD_CM/DEPARTMENT_HEAD_AGM/DEPARTMENT_HEAD_COE_CM/
# DEPARTMENT_HEAD_COE_AGM on anyone (including roles a target user already
# holds outside their own assignable subset -- see the "preserved" logic
# below, which protects the OTHER kind of local admin's roles too), and can
# never edit their own account this way.
def _require_own_department_target(current_user: models.User, target: models.User) -> None:
    if target.id == current_user.id:
        raise HTTPException(status_code=403, detail="You cannot manage your own account here")
    if "ADMIN" in target.roles:
        raise HTTPException(status_code=403, detail="Administrator accounts cannot be managed from here")
    if target.admin_managed_only:
        raise HTTPException(status_code=403,
                             detail="This account is managed by a System Admin only")
    if not current_user.department:
        raise HTTPException(status_code=403, detail="Your own profile has no department set")
    if target.department != current_user.department:
        raise HTTPException(
            status_code=403,
            detail=f"You can only manage users mapped to your own department "
                   f"('{current_user.department}').",
        )


def _local_admin_assignable_roles(current_user: models.User) -> list:
    """Which role subset this particular local admin may assign -- the
    Executive COE (QA department's own local admin) gets QA_ADMIN_ASSIGNABLE_ROLES,
    every other local admin (a business Department Head) gets
    DEPARTMENT_ADMIN_ASSIGNABLE_ROLES. Checked by role rather than by
    department string so it stays correct even if QA_DEPARTMENT's exact
    value ever changes. Deliberately checks `.roles` directly rather than
    `has_role()` -- `has_role()` always returns True for an Administrator
    account regardless of which role(s) it's asked about, which would
    wrongly hand an Admin who somehow hits this endpoint the QA subset."""
    if Role.DEPARTMENT_HEAD_COE_CM in current_user.roles or Role.DEPARTMENT_HEAD_COE_AGM in current_user.roles:
        return QA_ADMIN_ASSIGNABLE_ROLES
    return DEPARTMENT_ADMIN_ASSIGNABLE_ROLES


@router.get("/local-admin/users", response_model=list[schemas.UserOut])
def list_local_admin_users(db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(
                                Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM,
                                Role.DEPARTMENT_HEAD_COE_CM, Role.DEPARTMENT_HEAD_COE_AGM))):
    """Every user mapped to the local admin's own department (any status,
    so a previously-disabled account can be re-activated too), excluding
    their own account, any Administrator accounts, and any account flagged
    admin_managed_only -- mirrors the guard rails in
    _require_own_department_target/update_local_admin_user below."""
    if not current_user.department:
        raise HTTPException(status_code=400, detail="Your own profile has no department set")
    rows = (
        db.query(models.User)
        .filter(models.User.department == current_user.department, models.User.id != current_user.id)
        .order_by(models.User.full_name)
        .all()
    )
    return [u for u in rows if "ADMIN" not in u.roles and not u.admin_managed_only]


@router.patch("/local-admin/users/{user_id}", response_model=schemas.UserOut)
def update_local_admin_user(user_id: int, payload: schemas.LocalAdminUserUpdate, request: Request,
                             db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(
                                 Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM,
                                 Role.DEPARTMENT_HEAD_COE_CM, Role.DEPARTMENT_HEAD_COE_AGM))):
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    _require_own_department_target(current_user, user)
    before = user_snapshot(user)

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
        # their own submitted list, and vice versa for an Executive COE and
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
                         "scope": current_user.department})
    return user
