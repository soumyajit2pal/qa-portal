from typing import Optional

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


# Reported directly: "In dashboard, every-where show data from which
# department user belong to only," then extended to every standalone request
# list, then extended once more (reported directly): "Department head also
# restricted / bind to Department. the department where they belong to only
# details render to them." A business Department Head (DEPARTMENT_HEAD_CM/
# AGM) was the last unrestricted business-side role -- now removed from this
# set, so it's confined to its own department the same as Requester/
# Business Analyst/SM/Application Owner/Admin.
#
# Still unrestricted: the QA/Security/Executive-COE roles that review
# requests raised by every business department as their actual job
# (QA_LEAD, QA_ENGINEER, SECURITY_ANALYST, DEPARTMENT_HEAD_COE_CM/AGM) --
# these four are all mapped to the fixed QA_DEPARTMENT ("IT - QA"), never the
# business department of the request they're reviewing, so scoping them the
# same way as a Requester/SM would show them nothing rather than something
# narrower (confirmed directly). Also unrestricted: Role.SCALE_6_PLUS -- a
# System-Admin-only, confidential super-access role added per request ("that
# user can see all data like IT-QA has") specifically so it can be granted to
# someone outside the QA department who still needs the same org-wide view.
DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES = {
    Role.QA_LEAD, Role.QA_ENGINEER, Role.SECURITY_ANALYST,
    Role.DEPARTMENT_HEAD_COE_CM, Role.DEPARTMENT_HEAD_COE_AGM,
    Role.SCALE_6_PLUS,
}


def dashboard_department_scope(current_user: models.User) -> Optional[str]:
    """Returns the single department a Dashboard query should be confined to,
    or None for "no restriction, show every department." Checked directly
    against the raw roles list (models.User.roles), NOT has_role() --
    has_role() treats ADMIN as satisfying any role check, which would
    incorrectly also exempt an Admin account from this scoping even though
    Admin is one of the roles that IS meant to be scoped here (confirmed
    directly).

    A user with no department set on their own profile is treated the same
    as require_same_department treats a None entity_department: there's
    nothing meaningful to scope by, so this returns None (unrestricted)
    rather than filtering down to "department IS NULL" rows only."""
    if set(current_user.roles) & DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES:
        return None
    return current_user.department or None


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
        return obj.department if obj else None
    return None


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
