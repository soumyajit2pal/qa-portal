from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .. import models, schemas
from ..database import get_db
from ..auth import (
    verify_password, create_access_token, ldap_authenticate, ldap_authenticate_with_profile, LDAPAuthError,
)
from ..deps import get_current_user, require_roles
from ..constants import Role, ALL_ROLES, LoginType, ALL_LOGIN_TYPES, DEFAULT_LDAP_PROVISION_ROLE, DEPARTMENTS

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=schemas.Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
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
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is disabled")

    if not just_provisioned:
        # Credentials were already verified above for a just-provisioned account;
        # otherwise verify them the normal way for this account's login type.
        if user.login_type == LoginType.LDAP:
            try:
                authenticated = ldap_authenticate(form_data.username, form_data.password)
            except LDAPAuthError as e:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                                     detail=f"LDAP authentication unavailable: {e}")
            if not authenticated:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
        else:
            if not user.hashed_password or not verify_password(form_data.password, user.hashed_password):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    token = create_access_token({"sub": user.username, "roles": user.roles})
    return schemas.Token(access_token=token, roles=user.roles, full_name=user.full_name, username=user.username)


@router.get("/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(get_current_user)):
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


def _validate_department(department):
    if department and department not in DEPARTMENTS:
        raise HTTPException(status_code=400, detail=f"Invalid department '{department}'")


@router.post("/users", response_model=schemas.UserOut)
def create_user(payload: schemas.UserCreate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): user mapping = department + one or more roles
    (access types). A user can hold several roles at once (e.g. QA Lead +
    Security Analyst) -- all are active simultaneously."""
    from ..auth import hash_password
    if db.query(models.User).filter(models.User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="Username already exists")
    _validate_roles(payload.roles)
    roles = _dedupe_roles(payload.roles)
    _validate_department(payload.department)
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
    return user


@router.patch("/users/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: int, payload: schemas.UserUpdate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section (Module 9): reassign role(s), change login type, activate/deactivate, edit profile fields."""
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    data = payload.model_dump(exclude_unset=True)
    new_roles = data.pop("roles", None)
    if new_roles is not None:
        _validate_roles(new_roles)
        new_roles = _dedupe_roles(new_roles)
    if "department" in data:
        _validate_department(data["department"])
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
    return user


@router.post("/users/{user_id}/reset-password", response_model=schemas.UserOut)
def reset_password(user_id: int, payload: schemas.PasswordReset, db: Session = Depends(get_db),
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
    return user
