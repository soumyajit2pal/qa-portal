from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role, REQUEST_TYPES
from ..workspace_service import (
    QA_WORKSPACE_ROLES,
    PARENT_WORKSPACE_ROLES,
    can_configure_workspace,
    can_create_child_workspace,
    can_manage_workspace_members,
    ensure_administrator_workspace_memberships,
    remove_default_membership_after_assignment,
    selectable_workspace_ids,
)

router = APIRouter(tags=["Workspaces"])


def _workspace(db: Session, workspace_id: int) -> models.QAWorkspace:
    row = db.query(models.QAWorkspace).options(
        joinedload(models.QAWorkspace.parent_workspace),
        joinedload(models.QAWorkspace.members).joinedload(models.QAWorkspaceMember.user),
        joinedload(models.QAWorkspace.department_coordinators).joinedload(models.DepartmentCoordinatorAssignment.user),
        joinedload(models.QAWorkspace.department_coordinators).joinedload(models.DepartmentCoordinatorAssignment.department),
        joinedload(models.QAWorkspace.department_coordinators).joinedload(models.DepartmentCoordinatorAssignment.department_unit),
        joinedload(models.QAWorkspace.coverage_rules).joinedload(models.QAWorkspaceCoverage.department),
        joinedload(models.QAWorkspace.coverage_rules).joinedload(models.QAWorkspaceCoverage.department_unit),
        joinedload(models.QAWorkspace.coverage_rules).joinedload(models.QAWorkspaceCoverage.application_master),
    ).filter(models.QAWorkspace.id == workspace_id).first()
    if not row:
        raise HTTPException(404, "Workspace not found")
    return row


def _ensure_workspace_fallback(db: Session, user: models.User, excluded_workspace_id: int) -> int:
    """Keep an active user in a workspace after an administrator removes access."""
    existing = db.query(models.QAWorkspaceMember).join(models.QAWorkspace).filter(
        models.QAWorkspaceMember.user_id == user.id,
        models.QAWorkspaceMember.workspace_id != excluded_workspace_id,
        models.QAWorkspaceMember.is_active == True,  # noqa: E712
        models.QAWorkspace.is_active == True,  # noqa: E712
    ).order_by(models.QAWorkspace.is_default.desc(), models.QAWorkspace.id).first()
    if existing is not None:
        return existing.workspace_id

    excluded = db.get(models.QAWorkspace, excluded_workspace_id)
    if excluded is not None and excluded.is_default:
        raise HTTPException(
            409,
            "Assign this user to another workspace before removing their Default Workspace membership",
        )

    # Prefer the organisation default. If the excluded workspace itself is
    # the default, the first other active workspace is the only valid safe
    # fallback because adding the user back would cancel the removal.
    fallback = db.query(models.QAWorkspace).filter(
        models.QAWorkspace.id != excluded_workspace_id,
        models.QAWorkspace.is_active == True,  # noqa: E712
    ).order_by(models.QAWorkspace.is_default.desc(), models.QAWorkspace.id).first()
    if fallback is None:
        raise HTTPException(
            409,
            "Create another active workspace before removing this user's only workspace membership",
        )

    membership = db.query(models.QAWorkspaceMember).filter_by(
        workspace_id=fallback.id, user_id=user.id, role="WORKSPACE_MEMBER",
    ).first()
    if membership is None:
        db.add(models.QAWorkspaceMember(
            workspace_id=fallback.id, user_id=user.id,
            role="WORKSPACE_MEMBER", is_active=True,
        ))
    else:
        membership.is_active = True
    return fallback.id


@router.get("/api/workspaces", response_model=list[schemas.QAWorkspaceOut])
@router.get("/api/qa-workspaces", response_model=list[schemas.QAWorkspaceOut], include_in_schema=False)
def list_workspaces(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    query = db.query(models.QAWorkspace).options(
        joinedload(models.QAWorkspace.parent_workspace),
        joinedload(models.QAWorkspace.members).joinedload(models.QAWorkspaceMember.user),
        joinedload(models.QAWorkspace.department_coordinators).joinedload(models.DepartmentCoordinatorAssignment.user),
        joinedload(models.QAWorkspace.department_coordinators).joinedload(models.DepartmentCoordinatorAssignment.department),
        joinedload(models.QAWorkspace.department_coordinators).joinedload(models.DepartmentCoordinatorAssignment.department_unit),
        joinedload(models.QAWorkspace.coverage_rules).joinedload(models.QAWorkspaceCoverage.department),
        joinedload(models.QAWorkspace.coverage_rules).joinedload(models.QAWorkspaceCoverage.department_unit),
        joinedload(models.QAWorkspace.coverage_rules).joinedload(models.QAWorkspaceCoverage.application_master),
    ).order_by(models.QAWorkspace.name)
    if not current_user.has_role(Role.ADMIN):
        ids = selectable_workspace_ids(db, current_user)
        query = query.filter(models.QAWorkspace.id.in_(ids or [-1]), models.QAWorkspace.is_active == True)  # noqa: E712
    return query.all()


@router.post("/api/workspaces", response_model=schemas.QAWorkspaceOut)
@router.post("/api/qa-workspaces", response_model=schemas.QAWorkspaceOut, include_in_schema=False)
def create_workspace(payload: schemas.QAWorkspaceCreate, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    key = payload.workspace_key.strip().upper().replace(" ", "-")
    name = payload.name.strip()
    if not key or not name:
        raise HTTPException(400, "Workspace key and name are required")
    if db.query(models.QAWorkspace).filter(
        (models.QAWorkspace.workspace_key == key) | (models.QAWorkspace.name == name)
    ).first():
        raise HTTPException(409, "A workspace with this key or name already exists")
    if key == "DEFAULT":
        raise HTTPException(409, "DEFAULT is reserved for the seeded Default Workspace")
    parent = None
    if payload.parent_workspace_id is not None:
        parent = db.get(models.QAWorkspace, payload.parent_workspace_id)
        if not parent or not parent.is_active:
            raise HTTPException(400, "Select an active parent workspace")
        if parent.parent_workspace_id is not None:
            raise HTTPException(400, "A child workspace cannot contain another workspace")
    if not can_create_child_workspace(current_user, parent):
        raise HTTPException(403, "Only a System Administrator can create a workspace")
    row = models.QAWorkspace(
        **payload.model_dump(exclude={"workspace_key", "name", "is_default", "parent_workspace_id"}),
        workspace_key=key, name=name, is_default=False,
        parent_workspace_id=parent.id if parent else None,
        created_by_id=current_user.id,
    )
    db.add(row)
    db.flush()
    ensure_administrator_workspace_memberships(db, workspace=row)
    db.commit()
    return _workspace(db, row.id)


@router.patch("/api/workspaces/{workspace_id:int}", response_model=schemas.QAWorkspaceOut)
@router.patch("/api/qa-workspaces/{workspace_id:int}", response_model=schemas.QAWorkspaceOut, include_in_schema=False)
def update_workspace(workspace_id: int, payload: schemas.QAWorkspaceUpdate,
                     db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    row = _workspace(db, workspace_id)
    if not can_configure_workspace(current_user, row):
        raise HTTPException(403, "You do not have administrative access to this workspace")
    data = payload.model_dump(exclude_unset=True)
    if not current_user.has_role(Role.ADMIN) and "parent_workspace_id" in data:
        if data["parent_workspace_id"] != row.parent_workspace_id:
            raise HTTPException(403, "Only a System Administrator can change workspace hierarchy")
    if "is_default" in data:
        raise HTTPException(400, "The seeded DEFAULT workspace is the fixed first-login workspace")
    if row.workspace_key == "DEFAULT":
        if data.get("is_active") is False:
            raise HTTPException(400, "The Default Workspace cannot be deactivated")
        if "name" in data and data["name"].strip() != "Default Workspace":
            raise HTTPException(400, "The Default Workspace name is fixed")
    if "parent_workspace_id" in data:
        parent_id = data["parent_workspace_id"]
        if row.is_default and parent_id is not None:
            raise HTTPException(400, "The Default Workspace must remain top-level")
        if parent_id == row.id:
            raise HTTPException(400, "A workspace cannot be its own parent")
        if parent_id is not None:
            parent = db.get(models.QAWorkspace, parent_id)
            if not parent or not parent.is_active:
                raise HTTPException(400, "Select an active parent workspace")
            if parent.parent_workspace_id is not None:
                raise HTTPException(400, "A child workspace cannot contain another workspace")
            if row.child_workspaces:
                raise HTTPException(400, "A parent workspace cannot be moved below another workspace")
    if data.get("is_active") is False and row.is_active:
        member_user_ids = {member.user_id for member in row.members if member.is_active}
        for user_id in member_user_ids:
            member_user = db.get(models.User, user_id)
            if member_user:
                fallback_id = _ensure_workspace_fallback(db, member_user, row.id)
                if member_user.preferred_qa_workspace_id == row.id:
                    member_user.preferred_qa_workspace_id = fallback_id
    for key, value in data.items():
        setattr(row, key, value.strip() if isinstance(value, str) else value)
    db.commit()
    return _workspace(db, row.id)


@router.put("/api/workspaces/{workspace_id:int}/members", response_model=schemas.QAWorkspaceOut)
@router.put("/api/qa-workspaces/{workspace_id:int}/members", response_model=schemas.QAWorkspaceOut, include_in_schema=False)
def replace_members(workspace_id: int, payload: schemas.QAWorkspaceMembersReplace,
                    db: Session = Depends(get_db), _: models.User = Depends(get_current_user)):
    workspace = _workspace(db, workspace_id)
    current_user = _
    if not can_manage_workspace_members(current_user, workspace):
        raise HTTPException(403, "You do not have permission to manage membership in this workspace")
    # Parent-level Viewer/Admin grants define inherited access and may be
    # assigned or changed only by a System Administrator. A Parent Workspace
    # Admin may manage ordinary direct members on the parent, but must
    # preserve every existing parent permission exactly.
    protected_parent_access = {
        row.user_id: row.role
        for row in db.query(models.QAWorkspaceMember).filter(
            models.QAWorkspaceMember.workspace_id == workspace_id,
            models.QAWorkspaceMember.role.in_(PARENT_WORKSPACE_ROLES),
            models.QAWorkspaceMember.is_active == True,  # noqa: E712
        )
    } if not current_user.has_role(Role.ADMIN) else {}
    desired: set[tuple[int, str]] = set()
    for member in payload.members:
        user = db.get(models.User, member.user_id)
        if not user or (not user.is_active and not user.has_role(Role.ADMIN)):
            raise HTTPException(400, f"Active user {member.user_id} was not found")
        roles = member.roles or ["WORKSPACE_MEMBER"]
        access_roles = {
            role for role in roles
            if role in {"WORKSPACE_MEMBER", "WORKSPACE_VIEWER", *PARENT_WORKSPACE_ROLES}
        }
        if len(access_roles) > 1:
            raise HTTPException(400, "Select exactly one workspace access level for each user")
        access_role = next(iter(access_roles), "WORKSPACE_MEMBER")
        if access_role in PARENT_WORKSPACE_ROLES and (
            workspace.parent_workspace_id is not None or workspace.is_default
        ):
            raise HTTPException(400, "Parent Viewer/Admin can be assigned only on a non-default top-level workspace")
        if not current_user.has_role(Role.ADMIN) and (
            access_role in PARENT_WORKSPACE_ROLES or member.user_id in protected_parent_access
        ) and protected_parent_access.get(member.user_id) != access_role:
            raise HTTPException(
                403,
                "Parent Workspace Viewer/Admin permissions are managed by a System Administrator",
            )
        for role in roles:
            if role not in QA_WORKSPACE_ROLES:
                raise HTTPException(400, f"{role} is not a workspace role")
            # Global role remains the coarse feature capability used by the
            # existing navigation. Membership supplies the actual workspace
            # boundary, so administrators do not need two separate updates.
            if role not in {"WORKSPACE_MEMBER", "WORKSPACE_VIEWER", *PARENT_WORKSPACE_ROLES} and not any(assignment.role == role for assignment in user.role_assignments):
                user.role_assignments.append(models.UserRole(role=role))
        # The membership stores one boundary access level. Operational roles
        # remain in the user's global permission profile.
        desired.add((member.user_id, "WORKSPACE_MEMBER" if user.has_role(Role.ADMIN) else access_role))
    if protected_parent_access and any(
        (user_id, role) not in desired for user_id, role in protected_parent_access.items()
    ):
        raise HTTPException(
            409,
            "Parent Workspace Viewer/Admin permissions are managed by a System Administrator",
        )
    current_user_ids = {
        row.user_id for row in db.query(models.QAWorkspaceMember).filter(
            models.QAWorkspaceMember.workspace_id == workspace_id,
            models.QAWorkspaceMember.is_active == True,  # noqa: E712
        )
    }
    desired_user_ids = {user_id for user_id, _ in desired}
    inherited_parent_user_ids: set[int] = set()
    if workspace.parent_workspace_id is not None:
        inherited_parent_user_ids = {
            user_id for (user_id,) in db.query(models.QAWorkspaceMember.user_id).filter(
                models.QAWorkspaceMember.workspace_id == workspace.parent_workspace_id,
                models.QAWorkspaceMember.role.in_(PARENT_WORKSPACE_ROLES),
                models.QAWorkspaceMember.is_active == True,  # noqa: E712
            ).distinct()
        }
    removed_protected_ids = (current_user_ids - desired_user_ids) & inherited_parent_user_ids
    if removed_protected_ids:
        raise HTTPException(
            409,
            "Parent Workspace Viewer/Admin access is inherited and cannot be removed from a child workspace",
        )
    administrator_ids = {
        user_id for (user_id,) in db.query(models.UserRole.user_id).filter(
            models.UserRole.role == Role.ADMIN,
        ).distinct()
    }
    missing_administrator_ids = administrator_ids - desired_user_ids
    if missing_administrator_ids:
        raise HTTPException(
            409,
            "System Administrators are required members of every workspace and cannot be removed",
        )
    if workspace is not None and not workspace.is_default:
        for user_id in desired_user_ids - administrator_ids:
            user = db.get(models.User, user_id)
            if user is not None:
                remove_default_membership_after_assignment(db, user, workspace_id)
    for user_id in current_user_ids - desired_user_ids:
        user = db.get(models.User, user_id)
        if user:
            fallback_id = _ensure_workspace_fallback(db, user, workspace_id)
            if user.preferred_qa_workspace_id == workspace_id:
                user.preferred_qa_workspace_id = fallback_id
    db.query(models.DepartmentCoordinatorAssignment).filter(
        models.DepartmentCoordinatorAssignment.workspace_id == workspace_id,
        models.DepartmentCoordinatorAssignment.user_id.in_(current_user_ids - desired_user_ids),
    ).delete(synchronize_session=False)
    db.query(models.QAWorkspaceMember).filter(models.QAWorkspaceMember.workspace_id == workspace_id).delete()
    db.add_all([models.QAWorkspaceMember(workspace_id=workspace_id, user_id=user_id, role=role)
                for user_id, role in sorted(desired)])
    db.commit()
    return _workspace(db, workspace_id)


@router.get(
    "/api/workspaces/{workspace_id:int}/member-candidates",
    response_model=list[schemas.LocalAdminWorkspaceCandidateOut],
)
def list_workspace_member_candidates(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Full active directory for an authorized workspace-membership administrator."""
    workspace = _workspace(db, workspace_id)
    if not can_manage_workspace_members(current_user, workspace):
        raise HTTPException(403, "You do not have permission to manage membership in this workspace")
    direct_member_ids = select(models.QAWorkspaceMember.user_id).where(
        models.QAWorkspaceMember.workspace_id == workspace.id,
        models.QAWorkspaceMember.is_active == True,  # noqa: E712
    )
    inherited_member_ids = select(models.QAWorkspaceMember.user_id).where(
        models.QAWorkspaceMember.workspace_id == workspace.parent_workspace_id,
        models.QAWorkspaceMember.role.in_(PARENT_WORKSPACE_ROLES),
        models.QAWorkspaceMember.is_active == True,  # noqa: E712
    )
    return db.query(models.User).filter(
        models.User.is_active == True,  # noqa: E712
        models.User.show_in_user_dropdowns == True,  # noqa: E712
        ~models.User.id.in_(direct_member_ids),
        ~models.User.id.in_(inherited_member_ids),
    ).order_by(models.User.full_name).all()


@router.post(
    "/api/workspaces/{workspace_id:int}/department-coordinators",
    response_model=schemas.DepartmentCoordinatorOut,
)
def add_department_coordinator(
    workspace_id: int,
    payload: schemas.DepartmentCoordinatorCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    workspace = _workspace(db, workspace_id)
    if not can_configure_workspace(current_user, workspace):
        raise HTTPException(403, "You do not have administrative access to this workspace")
    if not workspace.is_active:
        raise HTTPException(400, "Select an active workspace")
    user = db.get(models.User, payload.user_id)
    if not user or not user.is_active:
        raise HTTPException(400, "Select an active user")
    if not user.show_in_user_dropdowns:
        raise HTTPException(400, "The selected user is hidden from assignment dropdowns")
    department = db.get(models.Department, payload.department_id)
    if not department or not department.is_active:
        raise HTTPException(400, "Select an active department")
    if payload.department_unit_id is not None:
        raise HTTPException(400, "Team scope is represented by a child workspace. Select the department only.")

    row = db.query(models.DepartmentCoordinatorAssignment).filter_by(
        workspace_id=workspace_id,
        user_id=user.id,
        department_id=department.id,
        department_unit_id=None,
    ).first()
    if row is None:
        row = models.DepartmentCoordinatorAssignment(
            workspace_id=workspace_id,
            user_id=user.id,
            department_id=department.id,
            department_unit_id=None,
            is_active=True,
            created_by_id=current_user.id,
        )
        db.add(row)
    else:
        row.is_active = True
        row.created_by_id = current_user.id

    # Coordinator assignment needs workspace access, but must not add a
    # second access level when the user already has Viewer/Admin access.
    # That duplicate previously made the member editor submit two mutually
    # exclusive levels and blocked unrelated additions to the workspace.
    active_access = db.query(models.QAWorkspaceMember).filter(
        models.QAWorkspaceMember.workspace_id == workspace_id,
        models.QAWorkspaceMember.user_id == user.id,
        models.QAWorkspaceMember.role.in_({
            "WORKSPACE_MEMBER", "WORKSPACE_VIEWER", *PARENT_WORKSPACE_ROLES,
        }),
        models.QAWorkspaceMember.is_active == True,  # noqa: E712
    ).first()
    if active_access is None:
        membership = db.query(models.QAWorkspaceMember).filter_by(
            workspace_id=workspace_id,
            user_id=user.id,
            role="WORKSPACE_MEMBER",
        ).first()
        if membership is None:
            db.add(models.QAWorkspaceMember(
                workspace_id=workspace_id, user_id=user.id,
                role="WORKSPACE_MEMBER", is_active=True,
            ))
        else:
            membership.is_active = True
    remove_default_membership_after_assignment(db, user, workspace_id)
    if user.preferred_qa_workspace_id is None:
        user.preferred_qa_workspace_id = workspace_id
    db.commit()
    return db.query(models.DepartmentCoordinatorAssignment).options(
        joinedload(models.DepartmentCoordinatorAssignment.user),
        joinedload(models.DepartmentCoordinatorAssignment.department),
        joinedload(models.DepartmentCoordinatorAssignment.workspace),
    ).filter(models.DepartmentCoordinatorAssignment.id == row.id).one()


@router.delete(
    "/api/workspaces/{workspace_id:int}/department-coordinators/{assignment_id:int}",
    status_code=204,
)
def delete_department_coordinator(
    workspace_id: int,
    assignment_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if not can_configure_workspace(current_user, _workspace(db, workspace_id)):
        raise HTTPException(403, "You do not have administrative access to this workspace")
    row = db.query(models.DepartmentCoordinatorAssignment).filter(
        models.DepartmentCoordinatorAssignment.id == assignment_id,
        models.DepartmentCoordinatorAssignment.workspace_id == workspace_id,
    ).first()
    if row is None:
        raise HTTPException(404, "Department coordinator assignment not found")
    db.delete(row)
    db.commit()


@router.post("/api/workspaces/{workspace_id:int}/coverage", response_model=schemas.QAWorkspaceCoverageOut)
@router.post("/api/qa-workspaces/{workspace_id:int}/coverage", response_model=schemas.QAWorkspaceCoverageOut, include_in_schema=False)
def add_coverage(workspace_id: int, payload: schemas.QAWorkspaceCoverageCreate,
                 db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    workspace = _workspace(db, workspace_id)
    if not can_configure_workspace(current_user, workspace):
        raise HTTPException(403, "You do not have administrative access to this workspace")
    if payload.department_id and not db.get(models.Department, payload.department_id):
        raise HTTPException(400, "Department not found")
    if payload.department_unit_id:
        raise HTTPException(400, "Unit routing has been replaced by child workspaces")
    if payload.application_master_id and not db.get(models.ApplicationMaster, payload.application_master_id):
        raise HTTPException(400, "Application not found")
    request_type = payload.request_type.strip() if payload.request_type else None
    if request_type and request_type not in REQUEST_TYPES:
        raise HTTPException(400, "Select a configured QA request type")
    duplicate = db.query(models.QAWorkspaceCoverage).filter_by(
        workspace_id=workspace_id,
        department_id=payload.department_id,
        department_unit_id=payload.department_unit_id,
        application_master_id=payload.application_master_id,
        request_type=request_type,
    ).first()
    if duplicate:
        raise HTTPException(409, "This workspace already has the same coverage rule")
    data = payload.model_dump(exclude={"request_type"})
    row = models.QAWorkspaceCoverage(workspace_id=workspace_id, request_type=request_type, **data)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/api/workspaces/{workspace_id:int}/coverage/{coverage_id:int}", status_code=204)
@router.delete("/api/qa-workspaces/{workspace_id:int}/coverage/{coverage_id:int}", status_code=204, include_in_schema=False)
def delete_coverage(workspace_id: int, coverage_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    if not can_configure_workspace(current_user, _workspace(db, workspace_id)):
        raise HTTPException(403, "You do not have administrative access to this workspace")
    row = db.query(models.QAWorkspaceCoverage).filter(
        models.QAWorkspaceCoverage.id == coverage_id,
        models.QAWorkspaceCoverage.workspace_id == workspace_id,
    ).first()
    if not row:
        raise HTTPException(404, "Coverage rule not found")
    db.delete(row)
    db.commit()


@router.patch("/api/workspaces/preference/current", response_model=schemas.UserOut)
@router.patch("/api/qa-workspaces/preference/current", response_model=schemas.UserOut, include_in_schema=False)
def set_preference(payload: schemas.QAWorkspacePreference, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    workspace = db.get(models.QAWorkspace, payload.workspace_id)
    if not workspace or not workspace.is_active or workspace.id not in selectable_workspace_ids(db, current_user):
        raise HTTPException(403, "You do not have access to this workspace")
    current_user.preferred_qa_workspace_id = workspace.id
    db.commit()
    db.refresh(current_user)
    return current_user


@router.patch("/api/workspaces/requests/{request_id:int}/route", response_model=schemas.QARequestOut)
@router.patch("/api/qa-workspaces/requests/{request_id:int}/route", response_model=schemas.QARequestOut, include_in_schema=False)
def manually_route_request(request_id: int, payload: schemas.QAWorkspaceRouteRequest,
                           db: Session = Depends(get_db), _: models.User = Depends(require_roles(Role.ADMIN))):
    request = db.get(models.QARequest, request_id)
    workspace = db.get(models.QAWorkspace, payload.workspace_id)
    if not request:
        raise HTTPException(404, "QA Request not found")
    if not workspace or not workspace.is_active:
        raise HTTPException(400, "Select an active workspace")
    request.qa_workspace_id = workspace.id
    request.workspace_routing_status = "MANUALLY_ROUTED"
    db.commit()
    db.refresh(request)
    return request


from ..defect_workflow import WorkflowPolicy


@router.get('/api/workspaces/{workspace_id:int}/defect-workflow/history', response_model=list[WorkflowPolicy])
def defect_workflow_history(workspace_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    import json
    from ..defect_workflow import policy
    row = _workspace(db, workspace_id)
    if not can_configure_workspace(current_user, row):
        raise HTTPException(403, 'Only a workspace configuration administrator can view workflow history')
    versions = {}
    for entry in json.loads(row.defect_workflow_history_json or '[]'):
        for key in ('previous', 'published'):
            snapshot = WorkflowPolicy.model_validate(entry[key]).model_dump()
            versions[snapshot['version']] = snapshot
    current = policy(row.defect_workflow_json)
    versions[current['version']] = current
    return [versions[number] for number in sorted(versions, reverse=True)]


@router.put('/api/workspaces/{workspace_id:int}/defect-workflow', response_model=schemas.QAWorkspaceOut)
def publish_defect_workflow(workspace_id: int, payload: WorkflowPolicy,
                            db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    import json
    from ..defect_workflow import policy
    row = _workspace(db, workspace_id)
    if not can_configure_workspace(current_user, row):
        raise HTTPException(403, 'Only a workspace configuration administrator can publish a workflow')
    db.query(models.QAWorkspace).filter_by(id=row.id).with_for_update().populate_existing().one()
    current = policy(row.defect_workflow_json)
    if payload.version != current['version']:
        raise HTTPException(409, 'Workflow changed. Refresh before publishing.')
    updated = payload.model_dump()
    updated['version'] = current['version'] + 1
    history = json.loads(row.defect_workflow_history_json or '[]')
    history.append({'previous': current, 'published': updated, 'user_id': current_user.id,
                    'at': models.now().isoformat()})
    row.defect_workflow_json = json.dumps(updated)
    row.defect_workflow_history_json = json.dumps(history)
    db.commit()
    return _workspace(db, row.id)
