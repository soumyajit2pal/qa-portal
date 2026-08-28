from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload

from .database import get_db
from . import models
from .auth import decode_access_token
from .constants import Role

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(
    request: Request, token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> models.User:
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
        )
        .filter(models.User.username == username)
        .first()
    )
    if user is None or not user.is_active:
        raise credentials_exception
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


def require_document_portal_viewer(current_user: models.User = Depends(get_current_user)) -> models.User:
    if not current_user.has_role(
        Role.DOCUMENT_PORTAL_VIEWER, Role.DOCUMENT_PORTAL_CONTRIBUTOR, Role.DOCUMENT_PORTAL_MANAGER,
    ):
        raise HTTPException(status_code=403, detail="You do not have access to Document Management")
    return current_user


def require_document_portal_contributor(current_user: models.User = Depends(get_current_user)) -> models.User:
    if not current_user.has_role(Role.DOCUMENT_PORTAL_CONTRIBUTOR, Role.DOCUMENT_PORTAL_MANAGER):
        raise HTTPException(status_code=403, detail="You have view-only Document Management access")
    return current_user


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
# these roles are all mapped to the fixed QA_DEPARTMENT ("COE - Quality Assurance"), never the
# business department of the request they're reviewing, so scoping them the
# same way as a Requester/SM would show them nothing rather than something
# narrower (confirmed directly). Also unrestricted: Role.SCALE_6_PLUS -- a
# System-Admin-only, confidential super-access role added per request ("that
# user can see all data like COE - Quality Assurance has") specifically so it can be granted to
# someone outside the QA department who still needs the same org-wide view.
DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES = {
    Role.QA_LEAD, Role.QA_ENGINEER, Role.SECURITY_ANALYST,
    Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    Role.SCALE_6_PLUS,
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

    A user with no department set on their own profile is treated the same
    as require_same_department treats a None entity_department: there's
    nothing meaningful to scope by, so this returns None (unrestricted)
    rather than filtering down to "department IS NULL" rows only."""
    if current_user.has_role(Role.ADMIN):
        return None
    # QA working roles retain their established cross-department scope.
    if set(current_user.roles) & DASHBOARD_DEPARTMENT_UNRESTRICTED_ROLES:
        return None
    return current_user.departments or None


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
    if entity_type == "DEFECT":
        obj = db.query(models.Defect).get(entity_id)
        return obj.qa_request.department if obj and obj.qa_request else None
    return None


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
def can_author_repository(db: Session, project_id: int, current_user: models.User) -> bool:
    return True


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
def can_manage_repository_governance(current_user: models.User) -> bool:
    return current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)


def require_can_manage_repository_governance(current_user: models.User) -> None:
    if not can_manage_repository_governance(current_user):
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
    return current_user.has_role(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)


def can_manage_execution_governance(db: Session, project_id: int, current_user: models.User) -> bool:
    return current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)


def require_can_author_repository(db: Session, project_id: int, current_user: models.User) -> None:
    if not can_author_repository(db, project_id, current_user):
        raise HTTPException(403, "Your project role on this Test Project doesn't include repository authoring -- "
                                  "ask the project owner to change your role to Author, Project Lead, or Owner.")


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
    if current_user.has_role(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
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
