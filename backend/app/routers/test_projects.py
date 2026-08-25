from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError

from .. import models, schemas, pagination
from ..database import get_db
from ..deps import (
    get_current_user, require_roles, dashboard_department_scope, viewable_project_ids, get_project_member_role,
    can_author_repository, can_review_repository, can_execute_project, can_manage_execution_governance,
    can_give_final_approval, require_can_manage_project, get_or_404, get_project_or_404,
)
from ..constants import Role, TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS

router = APIRouter(prefix="/api/test-projects", tags=["test-management"])

# Project Management module -- one Project per Application (see the header
# comment on models.TestProject for why). QA Engineer + QA Lead both manage
# Projects (create/edit) as well as author/execute test cases under them --
# Admin always bypasses via require_roles/has_role.
_MANAGE_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD)


# Reported directly: "while creating project with same project name you can
# not create project, project should be unique as well." No DB-level UNIQUE
# constraint on TestProject.name. Retrofitting a hard UNIQUE constraint onto
# an existing, already-populated production table risks failing outright if any
# duplicate names already exist there. Enforced here at the application
# layer instead, same as every other "must be unique" business rule this
# router already checks by hand (e.g. the department-must-exist-and-be-
# active check just above/below this). Case-insensitive and whitespace-
# trimmed -- "MILTON" and "milton " should collide, not silently coexist as
# two "different" projects a person would never intend. Deliberately checks
# every project regardless of Active/Inactive/Archived status (no carve-out
# for reusing an old, retired project's name) -- matches how Department.name
# and ApplicationMaster.name are both unique at the DB level with no such
# carve-out either.
def _require_unique_project_name(db: Session, name: str, exclude_id: Optional[int] = None) -> None:
    q = db.query(models.TestProject).filter(func.lower(models.TestProject.name) == name.lower())
    if exclude_id is not None:
        q = q.filter(models.TestProject.id != exclude_id)
    existing = q.first()
    if existing:
        raise HTTPException(409, f"A test project named \"{existing.name}\" already exists. Project names must be unique.")


# Reported directly, as a follow-up to the name-uniqueness fix above: "also
# under one application create one project only. more than one project
# under same application should not be allowed?" -- discussed directly
# rather than assumed: the chosen rule is one project per application only
# while an existing project for that application hasn't been Archived yet
# (SRS PRJ-003's three states -- Active/Inactive/Archived, see is_archived's
# own comment on models.TestProject). Deliberately NOT keyed off is_active --
# a merely Inactive (not yet Archived) project can be reactivated at any
# time and is still "the" current project for that application, so it still
# blocks a duplicate; only Archived (a deliberate, more final retirement --
# see archive_test_project below) frees the application up for a fresh
# project. Skipped entirely when application_master_id is None -- plenty of
# projects have no application link at all (nullable field, department-only
# projects), and those shouldn't collide with each other just for both being
# unlinked. Same "application layer, not a DB constraint" reasoning as
# _require_unique_project_name above -- no unique=True added to
# application_master_id, since retrofitting that onto an existing,
# already-populated production table risks failing outright if any
# application already has more than one non-archived project today.
def _require_no_active_project_for_application(db: Session, application_master_id: Optional[int], exclude_id: Optional[int] = None) -> None:
    if not application_master_id:
        return
    # is_archived is nullable (no nullable=False -- see its own comment on
    # models.TestProject); a legacy row could in principle be NULL rather
    # than False. Explicit OR with is_(None) rather than a bare `== False`,
    # since Oracle's three-valued boolean logic means `is_archived != True`
    # would evaluate to NULL/unknown (and so be filtered OUT) for a NULL row
    # -- the safe reading of "no explicit archive flag" is "not archived",
    # matching the Python-side `not project.is_archived` checks elsewhere
    # (test_reports.py's project-count summary) where None is already
    # treated as falsy.
    q = db.query(models.TestProject).filter(
        models.TestProject.application_master_id == application_master_id,
        or_(
            models.TestProject.is_archived == False,  # noqa: E712 - Oracle requires = 0, not IS 0
            models.TestProject.is_archived.is_(None),
        ),
    )
    if exclude_id is not None:
        q = q.filter(models.TestProject.id != exclude_id)
    existing = q.first()
    if existing:
        raise HTTPException(
            409,
            f"Application \"{existing.application_master.name if existing.application_master else ''}\" "
            f"already has an active test project (\"{existing.name}\"). Archive it first, or reuse the "
            "existing project, before creating another one for the same application.",
        )


@router.get("/eligible-users", response_model=List[schemas.UserOut])
def list_eligible_test_management_users(db: Session = Depends(get_db),
                                        current_user: models.User = Depends(get_current_user)):
    """Reported directly: "everywhere in test management whenever asking for
    users/members just show only users from COE - Quality Assurance, and make as list, so that
    in future if I want to add any other team like TCS-QA along with COE - Quality Assurance
    that can work, rather than long code change."

    Every Test Management user picker (Project owner/members, default
    Reviewer/QA Lead, per-item Reviewer/QA Lead reassignment, Cycle owner)
    calls this endpoint instead of the app-wide `GET /api/auth/users` list
    (which every other module still uses unfiltered, since Requesters/
    Department Heads/Business Analysts etc. legitimately need users outside
    COE - Quality Assurance). Filtered to `constants.TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS` --
    adding another team there is the only change needed to widen every
    picker in Projects/Repository/Execution at once, plus the matching
    runner/assignment-manager checks in `test_execution.py`, which read the
    same list.

    Declared here (not in a shared/generic module) because this is the one
    router every Test Management screen already depends on for its own
    project list -- same reasoning as `list_test_projects`'s own docstring
    above about being "the single entry point every Test Management screen
    picks a project from."
    """
    return (
        db.query(models.User)
        .filter(
            models.User.is_active == True,  # noqa: E712
            models.User.department_assignments.any(
                models.UserDepartment.department.in_(TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS)
            ),
        )
        .order_by(models.User.full_name)
        .all()
    )


@router.get("", response_model=pagination.Page[schemas.TestProjectOut])
def list_test_projects(include_inactive: bool = Query(False), params: pagination.PageParams = Depends(),
                       db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    # Reported directly: "Test Management also restrict to Department only" --
    # same dashboard_department_scope rule as every other list endpoint
    # (TestProject.department is a real column, so a direct .filter() is
    # enough). This is the single entry point every Test Management screen
    # (Projects, Repository, Execution) picks a project from, so scoping it
    # here keeps a scoped user from ever reaching another department's
    # folders/test cases/cycles/executions through the normal UI -- same
    # convention as everywhere else: individual get-by-id endpoints (e.g.
    # get_test_project) are left unscoped, matching every other module's
    # own get-by-id endpoints (e.g. functional.py::get_functional).
    #
    # SRS 7.2 pagination rollout (task #82) -- Test Projects is a flat,
    # already-lightweight list (TestProjectOut has no heavy nested arrays)
    # that's never browsed through the app's real paginated <Table>
    # (TestProjects.tsx renders it as a card gallery, naturally bounded by
    # how many projects a department actually stands up). Wrapped in the
    # standard Page[T] envelope purely for API-contract consistency with
    # the rest of the app; every frontend consumer requests page_size=100
    # and unwraps .items rather than getting a real pager UI, since this
    # entity was never facing the unbounded-growth problem pagination
    # exists to solve. The original two-column ordering
    # (is_active desc, name) doesn't map onto apply_sort's single-column
    # + id-secondary shape, so it's kept as an explicit order_by here
    # instead of going through that helper.
    # Perf tuning (2026-08, reported directly: "some of the apis are taking
    # lot of timing") -- TestProjectOut resolves 5 separate *_name fields
    # (owner/pending_requested_by/archived_by/default_reviewer/
    # default_qa_lead), each its own many-to-one User FK, previously
    # lazy-loaded -- up to 5 extra SELECTs per project row. joinedload is
    # used (not selectinload) because these are all many-to-one -- a single
    # LEFT JOIN per relationship, no row multiplication risk the way a
    # one-to-many collection would have.
    query = db.query(models.TestProject).options(
        joinedload(models.TestProject.owner),
        joinedload(models.TestProject.pending_requested_by),
        joinedload(models.TestProject.archived_by),
        joinedload(models.TestProject.default_reviewer),
        joinedload(models.TestProject.default_qa_lead),
    )
    if not include_inactive:
        query = query.filter(models.TestProject.is_active == True)  # noqa: E712
    # 2026-08 "view-only access to department/user" CR -- widened from a
    # plain department filter to viewable_project_ids, which also folds in
    # any TestProjectViewGrant naming this user or one of their departments.
    # See that function's own docstring in deps.py.
    project_ids = viewable_project_ids(db, current_user)
    if project_ids is not None:
        query = query.filter(models.TestProject.id.in_(project_ids))
    query = pagination.apply_search(query, params, models.TestProject.name, models.TestProject.project_key)
    query = query.order_by(models.TestProject.is_active.desc(), models.TestProject.name)
    result = pagination.paginate(query, params)
    # PRJ view-access CR: stamp each returned row with whether the CURRENT
    # user only sees it via a grant (own department -> full access, same as
    # before this feature existed) vs their real department membership --
    # the frontend uses this to badge the card "View only" and disable
    # mutating controls, without duplicating the department/grant logic
    # client-side. Computed here rather than as a TestProject @property
    # since it's inherently per-viewer, not a fact about the project itself.
    own_scope = dashboard_department_scope(current_user)
    project_ids_on_page = [row.id for row in result.items]
    shared_project_ids = set()
    if project_ids_on_page:
        grant_query = db.query(models.TestProjectViewGrant.project_id).filter(
            models.TestProjectViewGrant.project_id.in_(project_ids_on_page),
            or_(
                models.TestProjectViewGrant.user_id == current_user.id,
                models.TestProjectViewGrant.department.in_(current_user.departments or ["__none__"]),
            ),
        )
        shared_project_ids = {project_id for (project_id,) in grant_query.all()}
    for row in result.items:
        row.view_only = bool(own_scope is not None and not current_user.has_department(row.department))
        row.shared_with_you = row.id in shared_project_ids
    return pagination.to_page_response(result, params)


@router.get("/{project_id}/my-access", response_model=schemas.TestProjectMyAccessOut)
def get_my_project_access(project_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    """SRS PRJ-005/GOV-001 -- what the signed-in user is actually allowed to
    do on THIS project, combining their project-level role (if they're a
    member) with the deps.py enforcement helpers that test_repository.py and
    test_execution.py's write endpoints already check server-side. The
    frontend calls this once per project selection so it can hide/disable
    controls the backend would reject anyway, rather than duplicating the
    role -> capability mapping client-side. This is advisory only -- every
    mutating endpoint still enforces these same rules itself regardless of
    what the UI shows."""
    obj = get_project_or_404(db, project_id)
    role = get_project_member_role(db, project_id, current_user.id)
    return schemas.TestProjectMyAccessOut(
        project_id=project_id,
        project_role=role,
        is_member=role is not None,
        can_author_repository=can_author_repository(db, project_id, current_user),
        can_review_repository=can_review_repository(db, project_id, current_user),
        can_give_final_approval=can_give_final_approval(db, project_id, current_user),
        can_execute=can_execute_project(db, project_id, current_user),
        can_manage_execution_governance=can_manage_execution_governance(db, project_id, current_user),
    )


@router.post("", response_model=schemas.TestProjectOut)
def create_test_project(payload: schemas.TestProjectCreate, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Project name cannot be blank")
    if len(name) > 150:
        raise HTTPException(400, "Project name cannot exceed 150 characters")
    _require_unique_project_name(db, name)

    department = payload.department.strip()
    application_master_id = payload.application_master_id
    if application_master_id:
        app_master = get_or_404(db, models.ApplicationMaster, application_master_id, "Application")
        department = (app_master.department or "").strip()
        if not department:
            raise HTTPException(400, "The selected Application does not have a mapped department")
        _require_no_active_project_for_application(db, application_master_id)
    if not department:
        raise HTTPException(400, "Department is required")
    department_row = db.query(models.Department).filter(
        models.Department.name == department,
        models.Department.is_active == True,  # noqa: E712 - Oracle boolean column
    ).first()
    if not department_row:
        raise HTTPException(400, "The selected department is not active in the system department list")

    owner_id = payload.owner_id or current_user.id
    if payload.owner_id:
        owner = get_or_404(db, models.User, payload.owner_id, "Selected owner")
    if payload.default_reviewer_id in {current_user.id, owner_id}:
        raise HTTPException(400, "The project creator or owner cannot also be selected as the Default Reviewer (Stage 1)")
    if payload.default_reviewer_id and not db.query(models.User).get(payload.default_reviewer_id):
        raise HTTPException(404, "Selected default Reviewer not found")

    obj = models.TestProject(
        name=name, application_master_id=application_master_id, department=department,
        description=payload.description, is_active=True, owner_id=owner_id,
        created_by_id=current_user.id,
        default_reviewer_id=payload.default_reviewer_id, default_qa_lead_id=payload.default_qa_lead_id,
    )
    db.add(obj)
    db.flush()
    # PRJ-001/PRJ-005 -- the owner is always a member from day one, so
    # add_project_member's own owner-authorization check has someone to
    # authorize against immediately, without a separate bootstrap step.
    db.add(models.TestProjectMember(
        project_id=obj.id, user_id=owner_id, project_role="Owner", added_by_id=current_user.id,
    ))
    # 2026-08 "Simplified Test Management Review and Approval" requirement --
    # no more auto-creating a Reviewer/Project Lead TestProjectMember row
    # from default_reviewer_id/default_qa_lead_id. Stage 1/Stage 2 authority
    # now comes entirely from the QA Group/QA Lead Group system-role model
    # (see test_repository.py's review_test_case), not project membership --
    # see ORACLE_MIGRATION_2026-07.md for the full writeup.
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{project_id}", response_model=schemas.TestProjectOut)
def get_test_project(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = get_project_or_404(db, project_id)
    own_scope = dashboard_department_scope(current_user)
    obj.view_only = bool(own_scope is not None and not current_user.has_department(obj.department))
    return obj


@router.patch("/{project_id}", response_model=schemas.TestProjectOut)
def update_test_project(project_id: int, payload: schemas.TestProjectUpdate, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    """Reported directly: "Once Project is created, give option to edit
    details" (name/application link/department/description all editable by
    either manage role, same as at creation) and, separately: "Project
    Activation, deactivation should need approval from QA lead" -- only
    is_active is gated: a QA Lead (or Admin, via has_role()'s bypass) still
    flips it immediately, same as before, but a QA Engineer's request only
    records what they're asking for (pending_is_active) without touching the
    live is_active at all, until a QA Lead resolves it via
    review_project_activation below."""
    obj = get_project_or_404(db, project_id)
    # Only the "edit the project record itself" fields are Owner/QA-Lead
    # gated -- deliberately NOT applied when the payload is is_active-only,
    # since that's the separate PRJ-004 activate/deactivate request flow
    # below, which any QA_ENGINEER/QA_LEAD must still be able to use (a QA
    # Engineer can always REQUEST activation/deactivation; only resolving
    # that request is QA-Lead-gated, via requested_active/is_qa_lead_or_admin
    # further down -- unrelated to who owns the project).
    _DETAIL_FIELDS = {"name", "department", "application_master_id", "description", "owner_id",
                       "default_reviewer_id", "default_qa_lead_id"}
    if _DETAIL_FIELDS & payload.model_fields_set:
        require_can_manage_project(obj, current_user)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        data["name"] = data["name"].strip()
        if not data["name"]:
            raise HTTPException(400, "Project name cannot be blank")
        if len(data["name"]) > 150:
            raise HTTPException(400, "Project name cannot exceed 150 characters")
        if data["name"].lower() != obj.name.lower():
            _require_unique_project_name(db, data["name"], exclude_id=obj.id)
    if "department" in data:
        department = (data["department"] or "").strip()
        if not department:
            raise HTTPException(400, "Department is required")
        department_row = db.query(models.Department).filter(
            models.Department.name == department,
            models.Department.is_active == True,  # noqa: E712 - Oracle boolean column
        ).first()
        if not department_row:
            raise HTTPException(400, "Select an active department from the system department list")
        data["department"] = department
    if "application_master_id" in data and data["application_master_id"] != obj.application_master_id:
        _require_no_active_project_for_application(db, data["application_master_id"], exclude_id=obj.id)
    # Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on every QA-Lead-
    # gated action, same as ADMIN -- see ORACLE_MIGRATION_2026-07.md
    # section 59. (Variable name predates has_role()'s own ADMIN bypass.)
    is_qa_lead_or_admin = current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)
    requested_active = data.pop("is_active", None)
    if "owner_id" in data:
        new_owner_id = data.pop("owner_id")
        if new_owner_id is not None:
            new_owner = get_or_404(db, models.User, new_owner_id, "Selected owner")
            obj.owner_id = new_owner_id
            # Reassigning ownership always ensures the new owner is at least
            # a member with the Owner project role, mirroring create's own
            # bootstrap -- PRJ-005 "project owners shall add members", which
            # only makes sense if the owner is themselves always a member.
            existing_membership = db.query(models.TestProjectMember).filter_by(
                project_id=obj.id, user_id=new_owner_id).first()
            if existing_membership:
                existing_membership.project_role = "Owner"
            else:
                db.add(models.TestProjectMember(
                    project_id=obj.id, user_id=new_owner_id, project_role="Owner",
                    added_by_id=current_user.id,
                ))
    if "application_master_id" in data:
        new_app_id = data.pop("application_master_id")
        if new_app_id is not None:
            app_master = get_or_404(db, models.ApplicationMaster, new_app_id, "Application")
            obj.application_master_id = new_app_id
            mapped_department = (app_master.department or "").strip()
            if not mapped_department:
                raise HTTPException(400, "The selected Application does not have a mapped department")
            mapped_row = db.query(models.Department).filter(
                models.Department.name == mapped_department,
                models.Department.is_active == True,  # noqa: E712 - Oracle boolean column
            ).first()
            if not mapped_row:
                raise HTTPException(400, "The selected Application's department is not active")
            data["department"] = mapped_department
        else:
            obj.application_master_id = None
    elif obj.application_master_id and "department" in data:
        # A linked Application owns the department even if a caller attempts
        # to PATCH only the department and omit application_master_id.
        app_master = db.query(models.ApplicationMaster).get(obj.application_master_id)
        mapped_department = (app_master.department or "").strip() if app_master else ""
        if not mapped_department:
            raise HTTPException(400, "The linked Application does not have a mapped department")
        data["department"] = mapped_department
    for field in ("name", "department", "description"):
        if field in data and data[field] is not None:
            setattr(obj, field, data[field])
    # APR-001 -- project-level default Reviewer/QA Lead. Explicit null is
    # allowed (clears the default back to "unset"), unlike owner_id above
    # which a project can never be without.
    if "default_reviewer_id" in data:
        new_reviewer_id = data.pop("default_reviewer_id")
        if new_reviewer_id is not None and not db.query(models.User).get(new_reviewer_id):
            raise HTTPException(404, "Selected default Reviewer not found")
        if new_reviewer_id is not None and new_reviewer_id == obj.owner_id:
            raise HTTPException(400, "The project owner cannot also be selected as the Default Reviewer (Stage 1)")
        obj.default_reviewer_id = new_reviewer_id
    if "default_qa_lead_id" in data:
        new_qa_lead_id = data.pop("default_qa_lead_id")
        obj.default_qa_lead_id = new_qa_lead_id

    # 2026-08 "Simplified Test Management Review and Approval" requirement --
    # no more auto-creating/updating a Reviewer/Project Lead TestProjectMember
    # row from these defaults. default_reviewer_id/default_qa_lead_id are
    # kept purely as legacy metadata (still read by test_repository.py's
    # OLD-path Stage 2 approval notify list for projects with in-flight
    # pre-existing drafts) -- new Stage 1/Stage 2 authority comes entirely
    # from the QA Group/QA Lead Group system-role model, not project
    # membership.

    if requested_active is not None:
        if requested_active == obj.is_active:
            # Requesting the state the project is already in -- e.g. a second
            # tab racing a request that was just approved. Quietly clears any
            # now-stale pending request instead of erroring; not a state
            # change worth its own audit row.
            obj.pending_is_active = None
            obj.pending_requested_by_id = None
            obj.pending_requested_at = None
        elif is_qa_lead_or_admin:
            obj.is_active = requested_active
            obj.pending_is_active = None
            obj.pending_requested_by_id = None
            obj.pending_requested_at = None
            db.add(models.ApprovalAction(
                entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision="Reactivated" if obj.is_active else "Deactivated",
                comments="Project reactivated for new test work" if obj.is_active else "Project deactivated; existing test assets retained",
            ))
        else:
            if obj.pending_is_active == requested_active:
                raise HTTPException(400, "This request is already pending QA Lead approval")
            obj.pending_is_active = requested_active
            obj.pending_requested_by_id = current_user.id
            obj.pending_requested_at = models.now()
            db.add(models.ApprovalAction(
                entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision="Reactivation requested" if requested_active else "Deactivation requested",
                comments="Awaiting QA Lead approval before taking effect.",
            ))
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{project_id}/view-access", response_model=List[schemas.TestProjectViewGrantOut])
def list_project_view_access(project_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(get_current_user)):
    """2026-08 "view-only access to department/user" CR. Visible to anyone
    who can already see the project at all (same as get_test_project) --
    only ADDING/REMOVING a grant is Owner/QA-Lead-Group/Admin gated below,
    same as this project's other detail-management fields."""
    obj = get_project_or_404(db, project_id)
    return (
        db.query(models.TestProjectViewGrant)
        .filter(models.TestProjectViewGrant.project_id == obj.id)
        .order_by(models.TestProjectViewGrant.created_at)
        .all()
    )


@router.post("/{project_id}/view-access", response_model=schemas.TestProjectViewGrantOut)
def create_project_view_grant(project_id: int, payload: schemas.TestProjectViewGrantCreate,
                               db: Session = Depends(get_db),
                               current_user: models.User = Depends(get_current_user)):
    """Grants read-only visibility into this ONE project (its Test
    Execution/Repository/Reports, plus its linked Defects) to a department
    or a specific user who isn't otherwise in scope for it -- see
    models.TestProjectViewGrant's own docstring for the full reasoning.
    Gated exactly like editing the project's other detail fields
    (require_can_manage_project -- Owner, QA Lead Group, or Admin)."""
    obj = get_project_or_404(db, project_id)
    require_can_manage_project(obj, current_user)
    department = (payload.department or "").strip() or None
    user_id = payload.user_id
    if bool(department) == bool(user_id):
        raise HTTPException(400, "Grant exactly one of a department or a user, not both and not neither.")
    if department:
        who = department
        department_row = db.query(models.Department).filter(
            models.Department.name == department,
            models.Department.is_active == True,  # noqa: E712 - Oracle boolean column
        ).first()
        if not department_row:
            raise HTTPException(400, "Select an active department from the system department list")
        if department == obj.department:
            raise HTTPException(400, "This project's own department already has full access -- no grant needed")
        existing = db.query(models.TestProjectViewGrant).filter_by(project_id=obj.id, department=department).first()
        if existing:
            raise HTTPException(409, f"{department} already has view access to this project")
    else:
        target_user = get_or_404(db, models.User, user_id, "User")
        if target_user.has_department(obj.department):
            raise HTTPException(400, "This user is already in the project's own department -- no grant needed")
        who = target_user.full_name
        existing = db.query(models.TestProjectViewGrant).filter_by(project_id=obj.id, user_id=user_id).first()
        if existing:
            raise HTTPException(409, f"{who} already has view access to this project")
    grant = models.TestProjectViewGrant(
        project_id=obj.id, department=department, user_id=user_id, granted_by_id=current_user.id,
    )
    db.add(grant)
    try:
        db.commit()
    except IntegrityError:
        # Same race-safe fallback as test_execution.py's
        # create_cycle_folder_access -- see that function's own comment.
        # Reported directly (vague at first -- "sometimes getting key
        # issue" on an unnamed modal); this project-view-grant modal has
        # the identical check-then-insert race window.
        db.rollback()
        raise HTTPException(409, f"{who} already has view access to this project")
    db.refresh(grant)
    return grant


@router.delete("/{project_id}/view-access/{grant_id}", status_code=204)
def delete_project_view_grant(project_id: int, grant_id: int, db: Session = Depends(get_db),
                               current_user: models.User = Depends(get_current_user)):
    obj = get_project_or_404(db, project_id)
    require_can_manage_project(obj, current_user)
    grant = db.query(models.TestProjectViewGrant).filter_by(id=grant_id, project_id=obj.id).first()
    if not grant:
        raise HTTPException(404, "View-access grant not found")
    db.delete(grant)
    db.commit()


@router.post("/{project_id}/activation-review", response_model=schemas.TestProjectOut)
def review_project_activation(project_id: int, payload: schemas.TestProjectActivationReview,
                               db: Session = Depends(get_db),
                               current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """QA Lead (or Admin) resolves a pending activate/deactivate request from
    a QA Engineer -- Approve applies the requested value to is_active,
    Reject discards the request and leaves is_active untouched. Reported
    directly alongside update_test_project's gate above."""
    obj = get_project_or_404(db, project_id)
    if obj.pending_is_active is None:
        raise HTTPException(400, "This project has no pending activation request")
    decision = payload.decision.strip().upper()
    comments = (payload.comments or "").strip()
    if decision not in {"APPROVE", "REJECT"}:
        raise HTTPException(400, "Decision must be APPROVE or REJECT")
    if decision == "REJECT" and not comments:
        raise HTTPException(400, "A reason is required when rejecting an activation request")
    requested_active = obj.pending_is_active
    requested_by_name = obj.pending_requested_by_name
    if decision == "APPROVE":
        obj.is_active = requested_active
        action = "Reactivation approved" if requested_active else "Deactivation approved"
        comments = comments or (
            f"{'Reactivation' if requested_active else 'Deactivation'} requested by "
            f"{requested_by_name or 'a QA Engineer'} was approved."
        )
    else:
        action = "Reactivation request rejected" if requested_active else "Deactivation request rejected"
    obj.pending_is_active = None
    obj.pending_requested_by_id = None
    obj.pending_requested_at = None
    db.add(models.ApprovalAction(
        entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision=action, comments=comments,
    ))
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{project_id}/archive", response_model=schemas.TestProjectOut)
def archive_test_project(project_id: int, payload: schemas.TestProjectArchive, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """PRJ-003 -- a more deliberate retirement than a plain deactivation,
    reserved for QA Lead/Admin (no QA-Engineer-request path, unlike
    is_active's own approval workflow above -- archiving is meant to be
    final enough that it doesn't need a two-step ask/approve dance).
    Always also forces is_active False in the same action so every existing
    `if not project.is_active` authoring/execution gate already rejects an
    archived project -- see models.py's own comment on is_archived."""
    obj = get_project_or_404(db, project_id)
    if obj.is_archived:
        raise HTTPException(400, "This project is already archived")
    obj.is_archived = True
    obj.is_active = False
    obj.archived_by_id = current_user.id
    obj.archived_at = models.now()
    obj.archived_reason = (payload.reason or "").strip() or None
    obj.pending_is_active = None
    obj.pending_requested_by_id = None
    obj.pending_requested_at = None
    db.add(models.ApprovalAction(
        entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Archived", comments=obj.archived_reason or "Project archived.",
    ))
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{project_id}/unarchive", response_model=schemas.TestProjectOut)
def unarchive_test_project(project_id: int, db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """Lifts is_archived only -- the project comes back as Inactive, not
    Active, so reactivating it for new work is still its own deliberate
    decision through update_test_project (or a QA Engineer's own
    approval-gated request through the same endpoint)."""
    obj = get_project_or_404(db, project_id)
    if not obj.is_archived:
        raise HTTPException(400, "This project is not archived")
    # Closes the gap the one-project-per-application rule would otherwise
    # leave open: Archive project A for application X (frees X up) -> create
    # project B for X (now allowed) -> Unarchive A -- without this check, X
    # would end up with two non-archived projects again, exactly what
    # create/update_test_project block up front.
    _require_no_active_project_for_application(db, obj.application_master_id, exclude_id=obj.id)
    obj.is_archived = False
    obj.archived_by_id = None
    obj.archived_at = None
    obj.archived_reason = None
    db.add(models.ApprovalAction(
        entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Unarchived", comments="Project restored from archive; still Inactive until reactivated.",
    ))
    db.commit()
    db.refresh(obj)
    return obj


# ---- Membership (PRJ-005/GOV-001) -- read-only historical record only,
# see list_project_members' docstring below for why. ----
@router.get("/{project_id}/members", response_model=List[schemas.TestProjectMemberOut])
def list_project_members(project_id: int, db: Session = Depends(get_db),
                         current_user: models.User = Depends(get_current_user)):
    """2026-08 "Simplified Test Management Review and Approval" requirement
    (TM-PROJ-002 "no project member-management UI") -- project membership is
    no longer an active authorization mechanism (see deps.py's
    can_author_repository/can_execute_project/can_manage_execution_governance,
    all moved to the QA Group/QA Lead Group system-role model). This list
    stays read-only, purely so any pre-existing TestProjectMember rows
    remain visible for historical/audit reference; add/update/remove below
    are disabled."""
    obj = get_project_or_404(db, project_id)
    return (db.query(models.TestProjectMember).filter_by(project_id=project_id)
            .order_by(models.TestProjectMember.added_at).all())


@router.post("/{project_id}/members", response_model=schemas.TestProjectMemberOut)
def add_project_member(project_id: int, payload: schemas.TestProjectMemberCreate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    """Retained temporarily for older clients; project membership management
    is disabled -- see list_project_members' docstring above."""
    raise HTTPException(
        409,
        "Project membership management is disabled; Test Management now routes automatically by "
        "QA Group / QA Lead Group system role.",
    )


@router.patch("/{project_id}/members/{member_id}", response_model=schemas.TestProjectMemberOut)
def update_project_member(project_id: int, member_id: int, payload: schemas.TestProjectMemberUpdate,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    """Retained temporarily for older clients; project membership management
    is disabled -- see list_project_members' docstring above."""
    raise HTTPException(
        409,
        "Project membership management is disabled; Test Management now routes automatically by "
        "QA Group / QA Lead Group system role.",
    )


@router.delete("/{project_id}/members/{member_id}")
def remove_project_member(project_id: int, member_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    """Retained temporarily for older clients; project membership management
    is disabled -- see list_project_members' docstring above."""
    raise HTTPException(
        409,
        "Project membership management is disabled; Test Management now routes automatically by "
        "QA Group / QA Lead Group system role.",
    )
