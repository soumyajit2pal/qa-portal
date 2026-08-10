from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import models, schemas, pagination
from ..database import get_db
from ..deps import (
    get_current_user, require_roles, dashboard_department_scope, get_project_member_role,
    can_author_repository, can_review_repository, can_execute_project, can_manage_execution_governance,
    can_give_final_approval, require_can_manage_project, get_or_404, get_project_or_404,
)
from ..constants import Role, TEST_PROJECT_ROLES, TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS

router = APIRouter(prefix="/api/test-projects", tags=["test-management"])

# Project Management module -- one Project per Application (see the header
# comment on models.TestProject for why). QA Engineer + QA Lead both manage
# Projects (create/edit) as well as author/execute test cases under them --
# Admin always bypasses via require_roles/has_role.
_MANAGE_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD)


def _ensure_default_member_role(db: Session, project_id: int, user_id: int | None,
                                project_role: str, added_by_id: int) -> None:
    """Keep approval defaults and project membership aligned.

    A default Reviewer must be able to perform Stage 1 on this project, and
    the default CM-QA must be able to perform Stage 2 as its Project Lead.
    Never downgrade the broader Owner/Project Lead roles when the same person
    is selected for more than one responsibility.

    Bug fix (uq_qap_tpm_project_user unique-constraint violation): both
    create_test_project and update_test_project call this helper twice per
    request -- once for the default Reviewer, once for the default Project
    Lead/CM-QA -- with no db.flush() between the two calls, and SessionLocal
    runs with autoflush=False (database.py). Nothing stops the two defaults
    from being the same user, so when they are and that user isn't already a
    member, the first call's DB query correctly finds nothing and db.add()s a
    new TestProjectMember row; the second call's own identical DB query never
    sees that first call's still-unflushed insert and adds a byte-for-byte
    duplicate for the same (project_id, user_id), which then violates
    uq_qap_tpm_project_user at flush/commit time. Same bug class, same fix
    shape, as defects.py's _ensure_case_link -- check this session's own
    pending (db.new) objects first, in addition to the DB, so the second call
    in the same request sees what the first one just added.
    """
    if not user_id:
        return
    protected_roles = {"Owner", "Project Lead"} if project_role == "Reviewer" else {"Owner"}
    pending_member = next((
        obj for obj in db.new
        if isinstance(obj, models.TestProjectMember)
        and obj.project_id == project_id and obj.user_id == user_id
    ), None)
    if pending_member:
        if pending_member.project_role not in protected_roles:
            pending_member.project_role = project_role
        return
    member = db.query(models.TestProjectMember).filter_by(
        project_id=project_id, user_id=user_id,
    ).first()
    if member:
        if member.project_role not in protected_roles:
            member.project_role = project_role
        return
    db.add(models.TestProjectMember(
        project_id=project_id, user_id=user_id, project_role=project_role,
        added_by_id=added_by_id,
    ))


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
        .filter(models.User.is_active == True, models.User.department.in_(TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS))  # noqa: E712
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
    query = db.query(models.TestProject)
    if not include_inactive:
        query = query.filter(models.TestProject.is_active == True)  # noqa: E712
    scope = dashboard_department_scope(current_user)
    if scope:
        query = query.filter(models.TestProject.department == scope)
    query = pagination.apply_search(query, params, models.TestProject.name, models.TestProject.project_key)
    query = query.order_by(models.TestProject.is_active.desc(), models.TestProject.name)
    result = pagination.paginate(query, params)
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

    department = payload.department.strip()
    application_master_id = payload.application_master_id
    if application_master_id:
        app_master = get_or_404(db, models.ApplicationMaster, application_master_id, "Application")
        department = (app_master.department or "").strip()
        if not department:
            raise HTTPException(400, "The selected Application does not have a mapped department")
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
    db.flush()
    _ensure_default_member_role(
        db, obj.id, payload.default_reviewer_id, "Reviewer", current_user.id,
    )
    _ensure_default_member_role(
        db, obj.id, payload.default_qa_lead_id, "Project Lead", current_user.id,
    )
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{project_id}", response_model=schemas.TestProjectOut)
def get_test_project(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = get_project_or_404(db, project_id)
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
    is_qa_lead_or_admin = current_user.has_role(Role.QA_LEAD)
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

    # Defaults are actionable assignments, not display-only metadata. Ensure
    # the chosen people appear in Members with the project roles required by
    # their approval stages. Old defaults are intentionally not auto-removed
    # when changed because their membership may have been assigned manually.
    _ensure_default_member_role(
        db, obj.id, obj.default_reviewer_id, "Reviewer", current_user.id,
    )
    _ensure_default_member_role(
        db, obj.id, obj.default_qa_lead_id, "Project Lead", current_user.id,
    )

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


@router.post("/{project_id}/activation-review", response_model=schemas.TestProjectOut)
def review_project_activation(project_id: int, payload: schemas.TestProjectActivationReview,
                               db: Session = Depends(get_db),
                               current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
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
                         current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
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
                           current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Lifts is_archived only -- the project comes back as Inactive, not
    Active, so reactivating it for new work is still its own deliberate
    decision through update_test_project (or a QA Engineer's own
    approval-gated request through the same endpoint)."""
    obj = get_project_or_404(db, project_id)
    if not obj.is_archived:
        raise HTTPException(400, "This project is not archived")
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


# ---- Membership (PRJ-005/GOV-001) ----
def _is_project_owner_or_lead(db: Session, project: models.TestProject, current_user: models.User) -> bool:
    if current_user.has_role(Role.QA_LEAD):
        return True
    return project.owner_id == current_user.id


@router.get("/{project_id}/members", response_model=List[schemas.TestProjectMemberOut])
def list_project_members(project_id: int, db: Session = Depends(get_db),
                         current_user: models.User = Depends(get_current_user)):
    obj = get_project_or_404(db, project_id)
    return (db.query(models.TestProjectMember).filter_by(project_id=project_id)
            .order_by(models.TestProjectMember.added_at).all())


@router.post("/{project_id}/members", response_model=schemas.TestProjectMemberOut)
def add_project_member(project_id: int, payload: schemas.TestProjectMemberCreate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    """PRJ-005 "Project owners shall add project members with project-level
    roles without granting broader system roles" -- restricted to the
    project's own owner (or QA Lead/Admin), NOT every QA Engineer, even
    though QA Engineers can otherwise manage most project fields."""
    obj = get_project_or_404(db, project_id)
    if not _is_project_owner_or_lead(db, obj, current_user):
        raise HTTPException(403, "Only this project's owner or a QA Lead can add members")
    role = (payload.project_role or "Tester").strip()
    if role not in TEST_PROJECT_ROLES:
        raise HTTPException(400, f"project_role must be one of: {', '.join(TEST_PROJECT_ROLES)}")
    user = get_or_404(db, models.User, payload.user_id, "User")
    existing = db.query(models.TestProjectMember).filter_by(project_id=project_id, user_id=payload.user_id).first()
    if existing:
        raise HTTPException(400, f"{user.full_name} is already a member of this project")
    member = models.TestProjectMember(
        project_id=project_id, user_id=payload.user_id, project_role=role, added_by_id=current_user.id,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


@router.patch("/{project_id}/members/{member_id}", response_model=schemas.TestProjectMemberOut)
def update_project_member(project_id: int, member_id: int, payload: schemas.TestProjectMemberUpdate,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    obj = get_project_or_404(db, project_id)
    if not _is_project_owner_or_lead(db, obj, current_user):
        raise HTTPException(403, "Only this project's owner or a QA Lead can change member roles")
    member = db.query(models.TestProjectMember).filter_by(id=member_id, project_id=project_id).first()
    if not member:
        raise HTTPException(404, "Member not found in this project")
    role = (payload.project_role or "").strip()
    if role not in TEST_PROJECT_ROLES:
        raise HTTPException(400, f"project_role must be one of: {', '.join(TEST_PROJECT_ROLES)}")
    if member.user_id == obj.owner_id and role != "Owner":
        raise HTTPException(400, "The project owner's membership role cannot be changed away from Owner -- reassign ownership first")
    member.project_role = role
    db.commit()
    db.refresh(member)
    return member


@router.delete("/{project_id}/members/{member_id}")
def remove_project_member(project_id: int, member_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    obj = get_project_or_404(db, project_id)
    if not _is_project_owner_or_lead(db, obj, current_user):
        raise HTTPException(403, "Only this project's owner or a QA Lead can remove members")
    member = db.query(models.TestProjectMember).filter_by(id=member_id, project_id=project_id).first()
    if not member:
        raise HTTPException(404, "Member not found in this project")
    if member.user_id == obj.owner_id:
        raise HTTPException(400, "The project owner cannot be removed from the project -- reassign ownership first")
    db.delete(member)
    db.commit()
    return {"ok": True}

