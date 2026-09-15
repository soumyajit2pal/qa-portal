from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models, schemas
from app.deps import (
    can_author_repository, can_execute_project, can_manage_project,
    can_review_repository, require_project_visibility, viewable_project_ids,
)
from app.routers.test_projects import create_project_view_grant


def _session():
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def test_workspace_grant_makes_cross_workspace_project_visible_without_moving_it():
    db = _session()
    owner_workspace = models.QAWorkspace(workspace_key="CORE", name="Core", is_active=True)
    recipient_workspace = models.QAWorkspace(workspace_key="DBD", name="DBD", is_active=True)
    owner = models.User(username="owner", full_name="Owner", hashed_password="x", is_active=True)
    viewer = models.User(
        username="viewer", full_name="Viewer", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role="QA_LEAD")],
    )
    db.add_all([owner_workspace, recipient_workspace, owner, viewer]); db.flush()
    project = models.TestProject(
        project_key="TQA-PRJ-SHARED", name="CBS BANCS", department="DBD IT",
        qa_workspace_id=owner_workspace.id, owner_id=owner.id,
    )
    db.add(project); db.flush()
    db.add_all([
        models.QAWorkspaceMember(
            workspace_id=owner_workspace.id, user_id=owner.id, role="WORKSPACE_MEMBER",
        ),
        models.QAWorkspaceMember(
            workspace_id=recipient_workspace.id, user_id=viewer.id, role="WORKSPACE_MEMBER",
        ),
        models.TestProjectViewGrant(
            project_id=project.id, workspace_id=recipient_workspace.id, granted_by_id=owner.id,
        ),
    ]); db.commit(); db.refresh(viewer)
    viewer.active_qa_workspace_id = recipient_workspace.id

    assert project.qa_workspace_id == owner_workspace.id
    assert viewable_project_ids(db, viewer) == [project.id]
    require_project_visibility(db, project.id, viewer)
    assert can_author_repository(db, project.id, viewer)
    assert can_review_repository(db, project.id, viewer)
    assert can_execute_project(db, project.id, viewer)
    assert not can_manage_project(project, viewer)


def test_project_owner_can_create_workspace_view_grant():
    db = _session()
    owner_workspace = models.QAWorkspace(workspace_key="OWNER", name="Owner Workspace", is_active=True)
    recipient_workspace = models.QAWorkspace(workspace_key="OTHER", name="Other Workspace", is_active=True)
    owner = models.User(username="project-owner", full_name="Project Owner", hashed_password="x", is_active=True)
    db.add_all([owner_workspace, recipient_workspace, owner]); db.flush()
    project = models.TestProject(
        project_key="TQA-PRJ-GRANT", name="Workspace Share", department="Technology",
        qa_workspace_id=owner_workspace.id, owner_id=owner.id,
    )
    db.add(project); db.commit()

    grant = create_project_view_grant(
        project.id,
        schemas.TestProjectViewGrantCreate(workspace_id=recipient_workspace.id),
        db=db,
        current_user=owner,
    )
    assert grant.workspace_id == recipient_workspace.id
    assert grant.workspace_name == "Other Workspace"
