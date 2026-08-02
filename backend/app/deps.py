from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy.orm import Session

from .database import get_db
from . import models
from .auth import decode_access_token
from .constants import Role

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> models.User:
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

    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None or not user.is_active:
        raise credentials_exception
    return user


def require_roles(*roles):
    """Dependency factory: restricts an endpoint to users holding at least one
    of the given roles (ADMIN always allowed). A user may hold several roles
    at once -- all are active simultaneously, so this passes if ANY assigned
    role qualifies."""
    def checker(current_user: models.User = Depends(get_current_user)) -> models.User:
        if not current_user.has_role(*roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"None of your roles ({', '.join(current_user.roles) or 'none assigned'}) "
                       f"are permitted to perform this action.",
            )
        return current_user
    return checker


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

    entity_department may be None (e.g. a requester with no department set on
    their profile, or a standalone security request with nothing to match
    against) -- in that case the check is skipped rather than blocking
    everyone, since there's nothing meaningful to compare against.
    """
    if current_user.has_role(Role.ADMIN):
        return
    if not entity_department:
        return
    if (current_user.department or None) != entity_department:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"You can only act on requests from your own department. This request belongs to "
                f"'{entity_department}', but your profile is mapped to '{current_user.department or 'no department'}'."
            ),
        )


def require_not_requester(current_user: models.User, requester_id) -> None:
    """A person must never be able to approve their own request at an
    SM/Department Head/QA Lead/Executive COE decision checkpoint, even if
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
