from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from unittest.mock import patch
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import models
from app.constants import SEED_DEPARTMENTS
from app.workspace_service import (
    active_workspace_ids, active_workspace_scope_ids, ensure_administrator_workspace_memberships,
    can_administer_workspace, ensure_default_workspace_membership, inherited_workspace_access_mode,
    resolve_workspace, route_request, selectable_workspace_ids, set_current_workspace_id,
    set_current_workspace_scope_ids,
)
from app.routers.qa_workspaces import _ensure_workspace_fallback
from app.routers.qa_workspaces import (
    add_department_coordinator, create_workspace, list_workspace_member_candidates, replace_members,
)
from app.routers import auth as auth_router
from app.auth import create_access_token
from app.deps import _resolve_current_user
from app.routers.test_projects import list_eligible_test_management_users
from app.routers.test_repository import _require_stage_group_user
from app import schemas
from app.seed import DEMO_USERS, _seed_default_workspace, _seed_departments


def _session():
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def _request(path: str, workspace_id: int | None = None) -> Request:
    headers = (
        [(b"x-workspace-id", str(workspace_id).encode())]
        if workspace_id is not None else []
    )
    return Request({
        "type": "http", "method": "GET", "path": path,
        "raw_path": path.encode(), "query_string": b"", "headers": headers,
        "scheme": "http", "server": ("test", 80), "client": ("test", 1),
    })


def test_test_repository_group_validation_requires_active_workspace_access_and_stage_role():
    db = _session()
    project_workspace = models.QAWorkspace(workspace_key="PROJECT", name="Project QA", is_active=True)
    header_workspace = models.QAWorkspace(workspace_key="HEADER", name="Header QA", is_active=True)
    author = models.User(
        username="admin-author", full_name="Admin Author", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    project_reviewer = models.User(
        username="project-reviewer", full_name="Project Reviewer", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_ENGINEER")],
    )
    header_reviewer = models.User(
        username="header-reviewer", full_name="Header Reviewer", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_ENGINEER")],
    )
    project_lead = models.User(
        username="project-lead", full_name="Project Lead", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_LEAD")],
    )
    db.add_all([project_workspace, header_workspace, author, project_reviewer, header_reviewer, project_lead]); db.flush()
    project = models.TestProject(
        project_key="TQA-PROJ-CONTEXT", name="Context-safe project",
        qa_workspace_id=project_workspace.id, created_by_id=author.id, owner_id=author.id,
        is_active=True,
    )
    db.add(project); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=project_workspace.id, user_id=author.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=project_workspace.id, user_id=project_reviewer.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=project_workspace.id, user_id=project_lead.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=header_workspace.id, user_id=header_reviewer.id, role="WORKSPACE_MEMBER", is_active=True),
    ]); db.commit()

    project_reviewer.active_qa_workspace_id = project_workspace.id
    project_lead.active_qa_workspace_id = project_workspace.id
    header_reviewer.active_qa_workspace_id = header_workspace.id
    set_current_workspace_id(project_workspace.id)
    set_current_workspace_scope_ids({project_workspace.id})
    try:
        # Members can act from a contributing workspace with the correct
        # workflow role; an unrelated workspace grants no action access.
        _require_stage_group_user(db, project, project_reviewer, stage=1)
        _require_stage_group_user(db, project, project_lead, stage=2)
        with pytest.raises(HTTPException) as wrong_stage1_role:
            _require_stage_group_user(db, project, project_lead, stage=1)
        assert wrong_stage1_role.value.status_code == 403
        with pytest.raises(HTTPException) as wrong_stage2_role:
            _require_stage_group_user(db, project, project_reviewer, stage=2)
        assert wrong_stage2_role.value.status_code == 403
        with pytest.raises(HTTPException) as wrong_workspace:
            _require_stage_group_user(db, project, header_reviewer, stage=1)
        assert wrong_workspace.value.status_code == 403
    finally:
        set_current_workspace_id(None)
        set_current_workspace_scope_ids(set())


def test_application_rule_wins_over_department_default():
    db = _session()
    department = models.Department(name="Payments", is_active=True)
    app = models.ApplicationMaster(name="PAYMENTS API", status="APPROVED", department="Payments")
    general = models.QAWorkspace(workspace_key="GENERAL", name="General QA", is_active=True)
    specialist = models.QAWorkspace(workspace_key="PAY", name="Payments QA", is_active=True)
    db.add_all([department, app, general, specialist]); db.flush()
    db.add_all([
        models.QAWorkspaceCoverage(workspace_id=general.id, department_id=department.id, priority=50),
        models.QAWorkspaceCoverage(workspace_id=specialist.id, department_id=department.id,
                                   application_master_id=app.id, priority=10),
    ]); db.commit()
    workspace, status = resolve_workspace(db, department_name="Payments", application_master_id=app.id,
                                          request_types=["SAST"])
    assert workspace.id == specialist.id
    assert status == "ROUTED"


def test_equal_rules_fail_closed_as_ambiguous():
    db = _session()
    department = models.Department(name="Retail", is_active=True)
    first = models.QAWorkspace(workspace_key="A", name="QA A", is_active=True)
    second = models.QAWorkspace(workspace_key="B", name="QA B", is_active=True)
    db.add_all([department, first, second]); db.flush()
    db.add_all([
        models.QAWorkspaceCoverage(workspace_id=first.id, department_id=department.id, priority=50),
        models.QAWorkspaceCoverage(workspace_id=second.id, department_id=department.id, priority=50),
    ]); db.commit()
    workspace, status = resolve_workspace(db, department_name="Retail", application_master_id=None,
                                          request_types=["DAST"])
    assert workspace is None
    assert status == "AMBIGUOUS"


def test_legacy_department_unit_rule_does_not_override_workspace_scope():
    db = _session()
    department = models.Department(name="DBD IT", is_active=True)
    core = models.DepartmentUnit(department=department, name="Core Banking", is_active=True)
    general = models.QAWorkspace(workspace_key="DBD", name="DBD Workspace", is_active=True)
    specialist = models.QAWorkspace(workspace_key="CORE", name="Core Banking Workspace", is_active=True)
    db.add_all([department, core, general, specialist]); db.flush()
    db.add_all([
        models.QAWorkspaceCoverage(workspace_id=general.id, department_id=department.id, priority=10),
        models.QAWorkspaceCoverage(workspace_id=specialist.id, department_id=department.id,
                                   department_unit_id=core.id, priority=100),
    ]); db.commit()

    workspace, status = resolve_workspace(
        db, department_name="DBD IT", department_unit_id=core.id,
        application_master_id=None, request_types=["FUNCTIONAL"],
    )
    assert workspace.id == general.id
    assert status == "ROUTED"

    workspace, status = resolve_workspace(
        db, department_name="DBD IT", department_unit_id=None,
        application_master_id=None, request_types=["FUNCTIONAL"],
    )
    assert workspace.id == general.id
    assert status == "ROUTED"


def test_legacy_unit_only_routes_are_ignored():
    db = _session()
    department = models.Department(name="DBD IT", is_active=True)
    banking = models.DepartmentUnit(department=department, name="Banking", is_active=True)
    core = models.DepartmentUnit(department=department, parent=banking, name="Core", is_active=True)
    parent_workspace = models.QAWorkspace(workspace_key="BANK", name="Banking", is_active=True)
    child_workspace = models.QAWorkspace(workspace_key="CORE2", name="Core", is_active=True)
    db.add_all([department, banking, core, parent_workspace, child_workspace]); db.flush()
    db.add_all([
        models.QAWorkspaceCoverage(workspace_id=parent_workspace.id, department_id=department.id,
                                   department_unit_id=banking.id, priority=1),
        models.QAWorkspaceCoverage(workspace_id=child_workspace.id, department_id=department.id,
                                   department_unit_id=core.id, priority=100),
    ]); db.commit()

    workspace, status = resolve_workspace(
        db, department_name="DBD IT", department_unit_id=core.id,
        application_master_id=None, request_types=["FUNCTIONAL"],
    )
    assert workspace is None
    assert status == "ROUTING_REQUIRED"


def test_parent_workspace_scope_contains_only_accessible_children():
    db = _session()
    parent = models.QAWorkspace(workspace_key="DBD", name="DBD", is_active=True)
    child = models.QAWorkspace(workspace_key="ZEN", name="ZenLyfe", is_active=True, parent_workspace=parent)
    hidden_child = models.QAWorkspace(workspace_key="CBS", name="CBS", is_active=True, parent_workspace=parent)
    user = models.User(username="member", full_name="Member", hashed_password="x", is_active=True)
    db.add_all([parent, child, hidden_child, user]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=parent.id, user_id=user.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=child.id, user_id=user.id, role="WORKSPACE_MEMBER"),
    ])
    db.commit(); db.refresh(user)

    assert active_workspace_scope_ids(db, user, parent.id) == {parent.id, child.id}
    assert active_workspace_scope_ids(db, user, child.id) == {child.id}


def test_parent_viewer_inherits_every_active_child_as_read_only():
    db = _session()
    parent = models.QAWorkspace(workspace_key="DBD", name="DBD", is_active=True)
    first = models.QAWorkspace(workspace_key="ZEN", name="ZenLyfe", is_active=True, parent_workspace=parent)
    second = models.QAWorkspace(workspace_key="OTH", name="Other", is_active=True, parent_workspace=parent)
    inactive = models.QAWorkspace(workspace_key="OLD", name="Old", is_active=False, parent_workspace=parent)
    viewer = models.User(username="parent-viewer", full_name="Parent Viewer", hashed_password="x", is_active=True)
    db.add_all([parent, first, second, inactive, viewer]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=parent.id, user_id=viewer.id, role="PARENT_WORKSPACE_VIEWER", is_active=True,
    )); db.commit(); db.refresh(viewer)

    assert active_workspace_scope_ids(db, viewer, parent.id) == {parent.id, first.id, second.id}
    assert selectable_workspace_ids(db, viewer) == {parent.id, first.id, second.id}
    assert inherited_workspace_access_mode(db, viewer, parent.id) == "PARENT_VIEWER"
    assert inherited_workspace_access_mode(db, viewer, first.id) == "PARENT_VIEWER"


def test_parent_admin_inherits_children_and_direct_child_membership_wins():
    db = _session()
    parent = models.QAWorkspace(workspace_key="PARENT", name="Parent", is_active=True)
    child = models.QAWorkspace(workspace_key="CHILD", name="Child", is_active=True, parent_workspace=parent)
    administrator = models.User(username="parent-admin", full_name="Parent Admin", hashed_password="x", is_active=True)
    db.add_all([parent, child, administrator]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=parent.id, user_id=administrator.id, role="PARENT_WORKSPACE_ADMIN", is_active=True,
    )); db.commit(); db.refresh(administrator)

    assert active_workspace_scope_ids(db, administrator, parent.id) == {parent.id, child.id}
    assert inherited_workspace_access_mode(db, administrator, child.id) == "PARENT_ADMIN"
    assert can_administer_workspace(administrator, child)
    assert can_administer_workspace(administrator, parent)

    db.add(models.QAWorkspaceMember(
        workspace_id=child.id, user_id=administrator.id, role="WORKSPACE_MEMBER", is_active=True,
    )); db.commit(); db.refresh(administrator)
    assert inherited_workspace_access_mode(db, administrator, child.id) == "DIRECT"


def test_parent_admin_sees_full_directory_and_cannot_remove_inherited_parent_user_from_child():
    db = _session()
    parent = models.QAWorkspace(workspace_key="AREA", name="Area", is_active=True)
    child = models.QAWorkspace(workspace_key="AREA-ONE", name="Area One", is_active=True, parent_workspace=parent)
    parent_admin = models.User(username="area-admin", full_name="Area Admin", hashed_password="x", is_active=True)
    inherited_viewer = models.User(username="area-viewer", full_name="Area Viewer", hashed_password="x", is_active=True)
    directory_user = models.User(username="directory-user", full_name="Directory User", hashed_password="x", is_active=True)
    system_admin = models.User(
        username="system-admin", full_name="System Administrator", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    hidden_user = models.User(
        username="hidden-user", full_name="Hidden User", hashed_password="x", is_active=True,
        show_in_user_dropdowns=False,
    )
    db.add_all([parent, child, parent_admin, inherited_viewer, directory_user, system_admin, hidden_user]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(
            workspace_id=parent.id, user_id=parent_admin.id, role="PARENT_WORKSPACE_ADMIN", is_active=True,
        ),
        models.QAWorkspaceMember(
            workspace_id=parent.id, user_id=inherited_viewer.id, role="PARENT_WORKSPACE_VIEWER", is_active=True,
        ),
        # A legacy/direct duplicate must also remain protected while the parent grant exists.
        models.QAWorkspaceMember(
            workspace_id=child.id, user_id=inherited_viewer.id, role="WORKSPACE_MEMBER", is_active=True,
        ),
    ]); db.commit(); db.refresh(parent_admin)

    candidates = list_workspace_member_candidates(child.id, db=db, current_user=parent_admin)
    assert [row.id for row in candidates] == [directory_user.id, system_admin.id]

    try:
        replace_members(
            child.id,
            schemas.QAWorkspaceMembersReplace(members=[]),
            db=db,
            _=parent_admin,
        )
        assert False, "Inherited parent access must not be removable from a child"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 409


def test_parent_admin_manages_parent_members_without_changing_parent_permissions():
    db = _session()
    parent = models.QAWorkspace(workspace_key="AREA", name="Area", is_active=True)
    child = models.QAWorkspace(workspace_key="AREA-ONE", name="Area One", is_active=True, parent_workspace=parent)
    parent_admin = models.User(username="area-admin", full_name="Area Admin", hashed_password="x", is_active=True)
    viewer = models.User(username="area-viewer", full_name="Area Viewer", hashed_password="x", is_active=True)
    directory_user = models.User(username="directory-user", full_name="Directory User", hashed_password="x", is_active=True)
    db.add_all([parent, child, parent_admin, viewer, directory_user]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(
            workspace_id=parent.id, user_id=parent_admin.id, role="PARENT_WORKSPACE_ADMIN", is_active=True,
        ),
        models.QAWorkspaceMember(
            workspace_id=parent.id, user_id=viewer.id, role="PARENT_WORKSPACE_VIEWER", is_active=True,
        ),
    ]); db.commit(); db.refresh(parent_admin)

    candidates = list_workspace_member_candidates(parent.id, db=db, current_user=parent_admin)
    assert [row.id for row in candidates] == [directory_user.id]

    replace_members(
        parent.id,
        schemas.QAWorkspaceMembersReplace(members=[
            schemas.QAWorkspaceMemberInput(user_id=parent_admin.id, roles=["PARENT_WORKSPACE_ADMIN"]),
            schemas.QAWorkspaceMemberInput(user_id=viewer.id, roles=["PARENT_WORKSPACE_VIEWER"]),
            schemas.QAWorkspaceMemberInput(user_id=directory_user.id, roles=["WORKSPACE_MEMBER"]),
        ]),
        db=db,
        _=parent_admin,
    )
    parent_roles = {
        (row.user_id, row.role) for row in db.query(models.QAWorkspaceMember).filter_by(workspace_id=parent.id)
    }
    assert parent_roles == {
        (parent_admin.id, "PARENT_WORKSPACE_ADMIN"),
        (viewer.id, "PARENT_WORKSPACE_VIEWER"),
        (directory_user.id, "WORKSPACE_MEMBER"),
    }

    try:
        replace_members(
            parent.id,
            schemas.QAWorkspaceMembersReplace(members=[
                schemas.QAWorkspaceMemberInput(user_id=parent_admin.id, roles=["PARENT_WORKSPACE_ADMIN"]),
                schemas.QAWorkspaceMemberInput(user_id=directory_user.id, roles=["WORKSPACE_MEMBER"]),
            ]),
            db=db,
            _=parent_admin,
        )
        assert False, "Parent permission grants must remain System-Admin managed"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 409


def test_system_admin_can_assign_parent_viewer_access_level():
    db = _session()
    parent = models.QAWorkspace(workspace_key="AREA", name="Area", is_active=True)
    system_admin = models.User(
        username="system-admin", full_name="System Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    viewer = models.User(username="area-viewer", full_name="Area Viewer", hashed_password="x", is_active=True)
    db.add_all([parent, system_admin, viewer]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=parent.id, user_id=system_admin.id, role="WORKSPACE_MEMBER", is_active=True,
    )); db.commit()

    replace_members(
        parent.id,
        schemas.QAWorkspaceMembersReplace(members=[
            schemas.QAWorkspaceMemberInput(user_id=system_admin.id),
            schemas.QAWorkspaceMemberInput(user_id=viewer.id, roles=["PARENT_WORKSPACE_VIEWER"]),
        ]),
        db=db,
        _=system_admin,
    )
    db.refresh(viewer)
    assert viewer.qa_workspace_access[0].role == "PARENT_WORKSPACE_VIEWER"


def test_request_route_is_persisted_on_gateway():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="DEFAULT", name="Default QA", is_active=True, is_default=True)
    db.add(workspace); db.flush()
    request = models.QARequest(application_name="APP", department="Unknown", request_types="SAST,DAST")
    db.add(request); db.flush()
    route_request(db, request)
    assert request.qa_workspace_id == workspace.id
    assert request.workspace_routing_status == "ROUTED_DEFAULT"


def test_workspace_viewer_can_switch_without_receiving_a_global_qa_role():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="READ", name="Read Workspace", is_active=True)
    user = models.User(username="viewer", full_name="Workspace Viewer", hashed_password="x", is_active=True)
    db.add_all([workspace, user]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=workspace.id, user_id=user.id, role="WORKSPACE_VIEWER", is_active=True,
    )); db.commit(); db.refresh(user)

    assert active_workspace_ids(user) == {workspace.id}
    assert "QA_ENGINEER" not in user.roles
    assert user.has_qa_workspace_role("WORKSPACE_VIEWER", workspace_id=workspace.id)


def test_global_workspace_member_does_not_gain_qa_role():
    db = _session()
    workspace = models.QAWorkspace(
        workspace_key="ORG", name="Organisation Workspace", is_active=True, is_default=True,
    )
    user = models.User(
        username="requester", full_name="Requester", department="Retail",
        hashed_password="x", is_active=True,
    )
    db.add_all([workspace, user]); db.flush()
    ensure_default_workspace_membership(db, user)
    db.commit(); db.refresh(user)

    assert active_workspace_ids(user) == {workspace.id}
    assert user.preferred_qa_workspace_id == workspace.id
    assert user.has_qa_workspace_role("WORKSPACE_MEMBER", workspace_id=workspace.id)
    assert user.departments == ["Retail"]
    assert "QA_ENGINEER" not in user.roles


def test_authenticated_legacy_user_without_membership_is_repaired_to_default_workspace():
    db = _session()
    default = models.QAWorkspace(
        workspace_key="DEFAULT", name="Default Workspace", is_active=True, is_default=True,
    )
    user = models.User(
        username="legacy-ba", full_name="Legacy BA", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="BUSINESS_ANALYST")],
    )
    db.add_all([default, user]); db.commit()

    resolved = _resolve_current_user(
        _request("/api/dashboard/summary"),
        create_access_token({"sub": user.username, "roles": user.roles}),
        db,
    )

    assert resolved.active_qa_workspace_id == default.id
    assert resolved.preferred_qa_workspace_id == default.id
    assert {(row.workspace_id, row.role) for row in resolved.qa_workspace_access} == {
        (default.id, "WORKSPACE_MEMBER"),
    }


def test_approved_user_without_workspace_fails_closed_when_default_is_missing():
    db = _session()
    user = models.User(
        username="unscoped-ba", full_name="Unscoped BA", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="BUSINESS_ANALYST")],
    )
    db.add(user); db.commit()
    token = create_access_token({"sub": user.username, "roles": user.roles})

    with pytest.raises(HTTPException, match="No active workspace access") as raised:
        _resolve_current_user(_request("/api/dashboard/summary"), token, db)
    assert raised.value.status_code == 403

    # Self-service identity remains available so the browser can show the
    # dedicated access screen and still let the person log out.
    resolved = _resolve_current_user(_request("/api/auth/me"), token, db)
    assert getattr(resolved, "active_qa_workspace_id", None) is None


def test_auth_me_recovers_stale_workspace_after_first_login_approval():
    db = _session()
    stale = models.QAWorkspace(
        workspace_key="DEFAULT", name="Default Workspace", is_active=True, is_default=True,
    )
    assigned = models.QAWorkspace(
        workspace_key="APP", name="Approved Workspace", is_active=True,
    )
    user = models.User(
        username="approved-user", full_name="Approved User", hashed_password="x", is_active=True,
        preferred_qa_workspace=assigned,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([stale, assigned, user]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=assigned.id, user_id=user.id, role="WORKSPACE_MEMBER", is_active=True,
    )); db.commit()
    token = create_access_token({"sub": user.username, "roles": user.roles})

    try:
        resolved = _resolve_current_user(_request("/api/auth/me", stale.id), token, db)
        assert resolved.active_workspace_id == assigned.id
        assert schemas.UserOut.model_validate(resolved).active_workspace_id == assigned.id

        with pytest.raises(HTTPException, match="selected workspace") as raised:
            _resolve_current_user(_request("/api/dashboard/summary", stale.id), token, db)
        assert raised.value.status_code == 403
    finally:
        set_current_workspace_id(None)
        set_current_workspace_scope_ids(set())


def test_department_seed_adds_missing_rows_when_some_already_exist():
    db = _session()
    db.add(models.Department(name="IT - Software", is_active=True)); db.commit()

    _seed_departments(db)

    names = {row.name for row in db.query(models.Department).all()}
    assert set(SEED_DEPARTMENTS) <= names
    assert db.query(models.Department).filter_by(name="IT - Software").count() == 1
    assert "COE - Quality Assurance" in names
    qa_departments = {
        department for *_, role, department in DEMO_USERS
        if role in {"QA_ENGINEER", "CHIEF_MANAGER_QA", "AGM_QA"}
    }
    assert qa_departments == {"COE - Quality Assurance"}


def test_seed_creates_fixed_default_workspace_with_only_admin_required():
    db = _session()
    legacy = models.QAWorkspace(
        workspace_key="LEGACY", name="Legacy Workspace", is_active=True, is_default=True,
    )
    administrator = models.User(
        username="seed-admin", full_name="Seed Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    requester = models.User(
        username="seed-requester", full_name="Seed Requester", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([legacy, administrator, requester]); db.commit()

    _seed_default_workspace(db)

    default = db.query(models.QAWorkspace).filter_by(workspace_key="DEFAULT").one()
    assert default.name == "Default Workspace"
    assert default.is_default is True
    assert legacy.is_default is False
    assert {member.user_id for member in default.members} == {administrator.id}

    ensure_default_workspace_membership(db, requester)
    db.commit(); db.refresh(requester)
    assert requester.preferred_qa_workspace_id == default.id
    assert active_workspace_ids(requester) == {default.id}


def test_empty_database_seed_creates_only_default_workspace():
    db = _session()
    administrator = models.User(
        username="fresh-admin", full_name="Fresh Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    db.add(administrator); db.commit()

    _seed_default_workspace(db)

    workspaces = db.query(models.QAWorkspace).all()
    assert [(row.workspace_key, row.name, row.is_default) for row in workspaces] == [
        ("DEFAULT", "Default Workspace", True),
    ]
    assert {member.user_id for member in workspaces[0].members} == {administrator.id}


def test_permission_profile_applies_only_inside_joined_workspace():
    db = _session()
    joined = models.QAWorkspace(workspace_key="JOINED", name="Joined", is_active=True)
    outside = models.QAWorkspace(workspace_key="OUTSIDE", name="Outside", is_active=True)
    user = models.User(
        username="lead", full_name="QA Lead", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_LEAD")],
    )
    db.add_all([joined, outside, user]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=joined.id, user_id=user.id, role="WORKSPACE_MEMBER", is_active=True,
    )); db.commit(); db.refresh(user)

    assert user.has_qa_workspace_role("QA_LEAD", workspace_id=joined.id)
    assert not user.has_qa_workspace_role("QA_LEAD", workspace_id=outside.id)
    assert not user.departments


def test_test_management_candidates_come_from_active_workspace_not_department():
    db = _session()
    selected = models.QAWorkspace(workspace_key="SELECTED", name="Selected", is_active=True)
    other = models.QAWorkspace(workspace_key="OTHER", name="Other", is_active=True)
    actor = models.User(
        username="actor", full_name="Actor", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_LEAD")],
    )
    in_workspace = models.User(
        username="inside", full_name="Inside", department="Retail", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_ENGINEER")],
    )
    outside = models.User(
        username="outside", full_name="Outside", department="Retail", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_ENGINEER")],
    )
    db.add_all([selected, other, actor, in_workspace, outside]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=selected.id, user_id=actor.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=selected.id, user_id=in_workspace.id, role="WORKSPACE_MEMBER", is_active=True),
        models.QAWorkspaceMember(workspace_id=other.id, user_id=outside.id, role="WORKSPACE_MEMBER", is_active=True),
    ])
    db.commit(); db.refresh(actor)
    actor.active_qa_workspace_id = selected.id

    candidates = list_eligible_test_management_users(db=db, current_user=actor)

    assert {user.username for user in candidates} == {"actor", "inside"}


def test_legacy_role_rows_serialize_as_one_workspace_membership():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="ONE", name="One", is_active=True)
    user = models.User(
        username="multi", full_name="Multi Role", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_ENGINEER"), models.UserRole(role="QA_LEAD")],
    )
    db.add_all([workspace, user]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="QA_ENGINEER", is_active=True),
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="QA_LEAD", is_active=True),
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="WORKSPACE_MEMBER", is_active=True),
    ]); db.commit(); db.refresh(user)

    assert len(user.workspace_access) == 1
    assert user.workspace_access[0].workspace_id == workspace.id
    assert user.workspace_access[0].role == "WORKSPACE_MEMBER"
    assert active_workspace_ids(user) == {workspace.id}


def test_removing_last_membership_assigns_the_default_workspace():
    db = _session()
    current = models.QAWorkspace(workspace_key="TEAM", name="Team", is_active=True)
    default = models.QAWorkspace(workspace_key="DEFAULT", name="Default", is_active=True, is_default=True)
    user = models.User(username="move", full_name="Move User", hashed_password="x", is_active=True)
    db.add_all([current, default, user]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=current.id, user_id=user.id, role="WORKSPACE_MEMBER", is_active=True,
    ))
    user.preferred_qa_workspace_id = current.id
    db.commit(); db.refresh(user)

    fallback_id = _ensure_workspace_fallback(db, user, current.id)
    user.preferred_qa_workspace_id = fallback_id
    db.query(models.QAWorkspaceMember).filter_by(workspace_id=current.id, user_id=user.id).delete()
    db.commit(); db.refresh(user)

    assert fallback_id == default.id
    assert user.preferred_qa_workspace_id == default.id
    assert active_workspace_ids(user) == {default.id}


def test_non_default_assignment_replaces_default_and_last_removal_restores_it():
    db = _session()
    default = models.QAWorkspace(
        workspace_key="DEFAULT", name="Default Workspace", is_active=True, is_default=True,
    )
    team = models.QAWorkspace(workspace_key="TEAM", name="Team", is_active=True)
    administrator = models.User(
        username="boundary-admin", full_name="Boundary Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    user = models.User(
        username="boundary-user", full_name="Boundary User", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([default, team, administrator, user]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=default.id, user_id=administrator.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=team.id, user_id=administrator.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=default.id, user_id=user.id, role="WORKSPACE_MEMBER"),
    ])
    user.preferred_qa_workspace_id = default.id
    db.commit()

    replace_members(
        team.id,
        schemas.QAWorkspaceMembersReplace(members=[
            schemas.QAWorkspaceMemberInput(user_id=administrator.id),
            schemas.QAWorkspaceMemberInput(user_id=user.id),
        ]),
        db=db,
        _=administrator,
    )
    db.refresh(user)
    assert active_workspace_ids(user) == {team.id}
    assert user.preferred_qa_workspace_id == team.id

    replace_members(
        team.id,
        schemas.QAWorkspaceMembersReplace(members=[
            schemas.QAWorkspaceMemberInput(user_id=administrator.id),
        ]),
        db=db,
        _=administrator,
    )
    db.refresh(user)
    assert active_workspace_ids(user) == {default.id}
    assert user.preferred_qa_workspace_id == default.id


def test_default_membership_cannot_be_removed_without_another_workspace():
    db = _session()
    default = models.QAWorkspace(
        workspace_key="DEFAULT", name="Default Workspace", is_active=True, is_default=True,
    )
    administrator = models.User(
        username="default-admin", full_name="Default Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    user = models.User(
        username="default-only", full_name="Default Only", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([default, administrator, user]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=default.id, user_id=administrator.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=default.id, user_id=user.id, role="WORKSPACE_MEMBER"),
    ]); db.commit()

    try:
        replace_members(
            default.id,
            schemas.QAWorkspaceMembersReplace(members=[
                schemas.QAWorkspaceMemberInput(user_id=administrator.id),
            ]),
            db=db,
            _=administrator,
        )
        assert False, "A DEFAULT-only user must retain fallback membership"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 409


def test_administrator_is_added_to_every_existing_workspace():
    db = _session()
    workspaces = [
        models.QAWorkspace(workspace_key="ONE", name="One", is_active=True, is_default=True),
        models.QAWorkspace(workspace_key="TWO", name="Two", is_active=True),
    ]
    administrator = models.User(
        username="system-admin", full_name="System Administrator",
        hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    db.add_all([*workspaces, administrator]); db.flush()

    ensure_administrator_workspace_memberships(db, user=administrator)
    db.commit(); db.refresh(administrator)

    assert active_workspace_ids(administrator) == {row.id for row in workspaces}
    assert administrator.preferred_qa_workspace_id == workspaces[0].id


def test_new_workspace_contains_every_system_administrator():
    db = _session()
    first = models.User(
        username="admin-one", full_name="Admin One", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    second = models.User(
        username="admin-two", full_name="Admin Two", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    db.add_all([first, second]); db.flush()

    workspace = create_workspace(
        schemas.QAWorkspaceCreate(workspace_key="NEW", name="New Workspace"),
        db=db,
        current_user=first,
    )

    assert {member.user_id for member in workspace.members if member.is_active} == {first.id, second.id}


def test_system_administrator_cannot_be_removed_from_workspace():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="SAFE", name="Safe", is_active=True)
    administrator = models.User(
        username="protected-admin", full_name="Protected Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    db.add_all([workspace, administrator]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=workspace.id, user_id=administrator.id, role="WORKSPACE_MEMBER",
    )); db.commit()

    try:
        replace_members(
            workspace.id,
            schemas.QAWorkspaceMembersReplace(members=[]),
            db=db,
            _=administrator,
        )
        assert False, "A System Administrator membership must be protected"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 409
    assert db.query(models.QAWorkspaceMember).filter_by(
        workspace_id=workspace.id, user_id=administrator.id, is_active=True,
    ).count() == 1


def test_secondary_records_keep_the_parent_workspace_boundary():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="SEC", name="Security QA", is_active=True)
    db.add(workspace); db.flush()
    parent = models.QARequest(request_id="TQA-REQ-TEST", application_name="APP", department="Security", qa_workspace_id=workspace.id)
    db.add(parent); db.flush()
    sast = models.SASTRequest(request_id="TQA-SAST-TEST", application_name="APP", qa_request_id=parent.id)
    db.add(sast); db.flush()
    suppression = models.SuppressionRequest(
        suppression_id="TQA-SUP-TEST", application_name="APP", scan_type="SAST", sast_request_id=sast.id,
        qa_workspace_id=workspace.id,
    )
    signoff = models.QASignOff(
        certificate_id="TQA-SIGN-TEST", application_name="APP", certificate_type="Release", testing_type="Functional",
        qa_workspace_id=workspace.id,
    )
    db.add_all([suppression, signoff]); db.commit()

    assert suppression.qa_workspace_id == workspace.id
    assert signoff.qa_workspace_id == workspace.id


def test_any_user_can_receive_explicit_department_coordinator_scope():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="OPS", name="Operations", is_active=True)
    department = models.Department(name="Operations", is_active=True)
    admin = models.User(
        username="admin-scope", full_name="Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    coordinator = models.User(
        username="ordinary-user", full_name="Ordinary User", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([workspace, department, admin, coordinator]); db.flush()

    assignment = add_department_coordinator(
        workspace.id,
        schemas.DepartmentCoordinatorCreate(user_id=coordinator.id, department_id=department.id),
        db=db,
        current_user=admin,
    )
    db.refresh(coordinator)
    coordinator.active_qa_workspace_id = workspace.id

    assert assignment.department_name == "Operations"
    assert coordinator.roles == ["REQUESTER"]
    assert active_workspace_ids(coordinator) == {workspace.id}
    assert auth_router._coordinator_department_names(db, coordinator) == ["Operations"]


def test_user_hidden_from_dropdowns_cannot_be_selected_as_department_coordinator():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="OPS", name="Operations", is_active=True)
    department = models.Department(name="Operations", is_active=True)
    admin = models.User(
        username="admin-scope", full_name="Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    hidden_user = models.User(
        username="hidden", full_name="Hidden User", hashed_password="x", is_active=True,
        show_in_user_dropdowns=False,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([workspace, department, admin, hidden_user]); db.flush()

    with pytest.raises(HTTPException, match="hidden from assignment dropdowns") as error:
        add_department_coordinator(
            workspace.id,
            schemas.DepartmentCoordinatorCreate(user_id=hidden_user.id, department_id=department.id),
            db=db,
            current_user=admin,
        )

    assert error.value.status_code == 400


def test_coordinator_assignment_preserves_existing_parent_workspace_access():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="PARENT", name="Parent", is_active=True)
    department = models.Department(name="Operations", is_active=True)
    admin = models.User(
        username="system-admin", full_name="System Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    coordinator = models.User(
        username="parent-admin", full_name="Parent Admin", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([workspace, department, admin, coordinator]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=workspace.id,
        user_id=coordinator.id,
        role="PARENT_WORKSPACE_ADMIN",
        is_active=True,
    )); db.commit()

    add_department_coordinator(
        workspace.id,
        schemas.DepartmentCoordinatorCreate(user_id=coordinator.id, department_id=department.id),
        db=db,
        current_user=admin,
    )

    access_roles = {
        membership.role
        for membership in db.query(models.QAWorkspaceMember).filter_by(
            workspace_id=workspace.id, user_id=coordinator.id, is_active=True,
        )
    }
    assert access_roles == {"PARENT_WORKSPACE_ADMIN"}


def test_department_coordinator_scope_is_limited_to_active_workspace_and_department():
    db = _session()
    first = models.QAWorkspace(workspace_key="FIRST", name="First", is_active=True)
    second = models.QAWorkspace(workspace_key="SECOND", name="Second", is_active=True)
    managed = models.Department(name="Managed", is_active=True)
    other = models.Department(name="Other", is_active=True)
    coordinator = models.User(username="coordinator", full_name="Coordinator", hashed_password="x", is_active=True)
    target = models.User(
        username="managed-target", full_name="Managed Target", hashed_password="x", is_active=True,
        department="Managed", department_assignments=[models.UserDepartment(department="Managed")],
    )
    outsider = models.User(
        username="other-target", full_name="Other Target", hashed_password="x", is_active=True,
        department="Other", department_assignments=[models.UserDepartment(department="Other")],
    )
    db.add_all([first, second, managed, other, coordinator, target, outsider]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=first.id, user_id=coordinator.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=first.id, user_id=target.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=first.id, user_id=outsider.id, role="WORKSPACE_MEMBER"),
        models.DepartmentCoordinatorAssignment(
            workspace_id=first.id, department_id=managed.id, user_id=coordinator.id,
        ),
    ]); db.commit(); db.refresh(coordinator)

    coordinator.active_qa_workspace_id = first.id
    auth_router._require_own_department_target(db, coordinator, target)
    try:
        auth_router._require_own_department_target(db, coordinator, outsider)
        assert False, "A coordinator must not manage a different department"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 403

    coordinator.active_qa_workspace_id = second.id
    assert auth_router._coordinator_department_names(db, coordinator) == []


def test_legacy_management_title_does_not_grant_coordinator_access_by_itself():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="LEGACY", name="Legacy", is_active=True)
    user = models.User(
        username="legacy-head", full_name="Legacy Head", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="DEPARTMENT_HEAD_CM")],
    )
    db.add_all([workspace, user]); db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=workspace.id, user_id=user.id, role="WORKSPACE_MEMBER",
    )); db.commit(); db.refresh(user)
    user.active_qa_workspace_id = workspace.id

    try:
        auth_router._require_department_coordinator(db, user)
        assert False, "A job-title role must not imply local-admin access"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 403


def test_coordinator_cannot_add_workspace_member_after_membership_boundary_split():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="LOCAL", name="Local", is_active=True)
    department = models.Department(name="Delivery", is_active=True)
    coordinator = models.User(username="local-admin", full_name="Local Admin", hashed_password="x", is_active=True)
    candidate = models.User(
        username="candidate", full_name="Candidate", hashed_password="x", is_active=True,
        department="Delivery",
        department_assignments=[models.UserDepartment(department="Delivery")],
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    db.add_all([workspace, department, coordinator, candidate]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=coordinator.id, role="WORKSPACE_MEMBER"),
        models.DepartmentCoordinatorAssignment(
            workspace_id=workspace.id, department_id=department.id, user_id=coordinator.id,
        ),
    ]); db.commit(); db.refresh(coordinator)
    coordinator.active_qa_workspace_id = workspace.id

    candidates = auth_router.list_local_admin_workspace_candidates(db=db, current_user=coordinator)
    assert candidates == []

    try:
        auth_router.add_local_admin_workspace_member(
            schemas.LocalAdminWorkspaceMemberCreate(
                user_id=candidate.id, roles=["QA_ENGINEER"],
            ),
            request=None,
            db=db,
            current_user=coordinator,
        )
        assert False, "Department Coordinator must not manage workspace membership"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 403
    db.refresh(candidate)
    assert active_workspace_ids(candidate) == set()
    assert set(candidate.roles) == {"REQUESTER"}


def test_coordinator_can_review_pending_department_user_and_approval_assigns_workspace():
    db = _session()
    default = models.QAWorkspace(
        workspace_key="DEFAULT", name="Default Workspace", is_active=True, is_default=True,
    )
    workspace = models.QAWorkspace(workspace_key="DELIVERY", name="Delivery", is_active=True)
    child_workspace = models.QAWorkspace(
        workspace_key="DELIVERY-APP", name="Delivery App", is_active=True,
        parent_workspace=workspace,
    )
    department = models.Department(name="Delivery Department", is_active=True)
    coordinator = models.User(username="delivery-coord", full_name="Delivery Coordinator", hashed_password="x", is_active=True)
    pending = models.User(
        username="new-user", full_name="New User", hashed_password="x", is_active=True,
        department="Delivery Department", needs_role_review=True,
        department_assignments=[models.UserDepartment(department="Delivery Department")],
    )
    db.add_all([default, workspace, child_workspace, department, coordinator, pending]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=coordinator.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=default.id, user_id=pending.id, role="WORKSPACE_MEMBER"),
        models.DepartmentCoordinatorAssignment(
            workspace_id=workspace.id, department_id=department.id, user_id=coordinator.id,
        ),
    ]); db.commit(); db.refresh(coordinator)
    assert child_workspace.id in selectable_workspace_ids(db, coordinator)
    assert active_workspace_scope_ids(db, coordinator, workspace.id) == {
        workspace.id, child_workspace.id,
    }
    assert active_workspace_scope_ids(db, coordinator, child_workspace.id) == {
        child_workspace.id,
    }
    coordinator.active_qa_workspace_id = child_workspace.id

    visible = auth_router.list_local_admin_users(db=db, current_user=coordinator)
    assert [row.id for row in visible] == [pending.id]
    approval_workspaces = auth_router.list_local_admin_approval_workspaces(
        db=db, current_user=coordinator,
    )
    assert {row["id"] for row in approval_workspaces} == {workspace.id, child_workspace.id}

    with pytest.raises(HTTPException, match="Select a destination workspace"):
        auth_router.update_local_admin_user(
            pending.id,
            schemas.LocalAdminUserUpdate(roles=["REQUESTER"]),
            request=None,
            db=db,
            current_user=coordinator,
        )
    db.refresh(pending)
    assert pending.needs_role_review is True
    assert set(pending.roles) == set()

    with patch.object(auth_router, "write_audit"):
        auth_router.update_local_admin_user(
            pending.id,
            schemas.LocalAdminUserUpdate(roles=["REQUESTER"], workspace_id=child_workspace.id),
            request=None,
            db=db,
            current_user=coordinator,
        )
    db.refresh(pending)
    assert pending.needs_role_review is False
    assert set(pending.roles) == {"REQUESTER"}
    assert active_workspace_ids(pending) == {child_workspace.id}
    assert pending.preferred_qa_workspace_id == child_workspace.id


def test_department_coordinator_cannot_assign_legacy_units():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="DBD", name="DBD", is_active=True)
    department = models.Department(name="DBD IT", is_active=True)
    zenlyfe = models.DepartmentUnit(name="ZenLyfe", department=department, is_active=True)
    coordinator = models.User(username="coord-all", full_name="Coordinator", hashed_password="x", is_active=True)
    target = models.User(
        username="unit-target", full_name="Unit Target", hashed_password="x", is_active=True,
        department="DBD IT", department_assignments=[models.UserDepartment(department="DBD IT")],
    )
    db.add_all([workspace, department, zenlyfe, coordinator, target]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=coordinator.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=target.id, role="WORKSPACE_MEMBER"),
        models.DepartmentCoordinatorAssignment(
            workspace_id=workspace.id, department_id=department.id, user_id=coordinator.id,
        ),
    ]); db.commit(); db.refresh(coordinator)
    coordinator.active_qa_workspace_id = workspace.id

    with patch.object(auth_router, "write_audit"):
        try:
            auth_router.update_local_admin_user(
                target.id,
                schemas.LocalAdminUserUpdate(department_unit_ids=[zenlyfe.id]),
                request=None, db=db, current_user=coordinator,
            )
        except Exception as exc:
            assert "department_unit_ids" in str(exc)
        else:
            raise AssertionError("Legacy team assignment must use child workspace membership")


def test_legacy_team_updates_are_rejected_for_all_coordinators():
    db = _session()
    workspace = models.QAWorkspace(workspace_key="DBD", name="DBD", is_active=True)
    department = models.Department(name="DBD IT", is_active=True)
    zenlyfe = models.DepartmentUnit(name="ZenLyfe", department=department, is_active=True)
    cbs = models.DepartmentUnit(name="CBS", department=department, is_active=True)
    coordinator = models.User(username="coord-team", full_name="Coordinator", hashed_password="x", is_active=True)
    target = models.User(
        username="scoped-target", full_name="Scoped Target", hashed_password="x", is_active=True,
        department="DBD IT", department_assignments=[models.UserDepartment(department="DBD IT")],
        department_unit_assignments=[models.UserDepartmentUnit(unit=zenlyfe)],
    )
    db.add_all([workspace, department, zenlyfe, cbs, coordinator, target]); db.flush()
    db.add_all([
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=coordinator.id, role="WORKSPACE_MEMBER"),
        models.QAWorkspaceMember(workspace_id=workspace.id, user_id=target.id, role="WORKSPACE_MEMBER"),
        models.DepartmentCoordinatorAssignment(
            workspace_id=workspace.id, department_id=department.id,
            department_unit_id=zenlyfe.id, user_id=coordinator.id,
        ),
    ]); db.commit(); db.refresh(coordinator)
    coordinator.active_qa_workspace_id = workspace.id

    for requested in ([], [cbs.id]):
        try:
            auth_router.update_local_admin_user(
                target.id,
                schemas.LocalAdminUserUpdate(department_unit_ids=requested),
                request=None, db=db, current_user=coordinator,
            )
            assert False, "Legacy team updates must use child workspace membership"
        except Exception as exc:
            assert "department_unit_ids" in str(exc)
        db.rollback()
