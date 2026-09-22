from unittest.mock import Mock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import email_notifications, models, pagination, schemas
from app.constants import Role
from app.routers import test_execution, test_repository
from app.workspace_service import (
    current_workspace_id, current_workspace_scope_ids,
    set_current_workspace_id, set_current_workspace_scope_ids,
    workspace_context,
)


def _session():
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def _page_params():
    return pagination.PageParams(
        page=1, page_size=5, search=None, status=None, department=None,
        raised_from=None, raised_to=None, sort_by=None, sort_order="desc",
    )


def _workspace_user(db: Session, workspace: models.QAWorkspace, username: str, role: str) -> models.User:
    user = models.User(
        username=username,
        full_name=username,
        hashed_password="x",
        is_active=True,
        show_in_user_dropdowns=True,
        role_assignments=[models.UserRole(role=role)],
    )
    db.add(user)
    db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=workspace.id,
        user_id=user.id,
        role="WORKSPACE_MEMBER",
        is_active=True,
    ))
    db.flush()
    user.active_qa_workspace_id = workspace.id
    return user


@pytest.mark.parametrize("operation", [
    lambda project_id, db, user: test_repository.list_folders(project_id, db=db, current_user=user),
    lambda project_id, db, user: test_repository.list_test_cases(
        project_id, folder_id=None, priority=None, tag=None, cursor_mode=False, cursor=None,
        params=_page_params(), db=db, current_user=user,
    ),
    lambda project_id, db, user: test_repository.get_test_case_summary(
        project_id, folder_id=None, db=db, current_user=user,
    ),
    lambda project_id, db, user: test_repository.list_recycle_bin(
        project_id, params=_page_params(), db=db, current_user=user,
    ),
    lambda project_id, db, user: test_repository.export_test_repository(
        project_id, db=db, current_user=user,
    ),
    lambda project_id, db, user: test_repository.queue_test_repository_export(
        project_id, BackgroundTasks(), db=db, current_user=user,
    ),
])
def test_unrelated_workspace_cannot_read_or_export_repository(operation):
    db = _session()
    try:
        owner_workspace = models.QAWorkspace(workspace_key="OWNER", name="Owner")
        other_workspace = models.QAWorkspace(workspace_key="OTHER", name="Other")
        db.add_all([owner_workspace, other_workspace])
        db.flush()
        owner = _workspace_user(db, owner_workspace, "owner", Role.QA_ENGINEER)
        outsider = _workspace_user(db, other_workspace, "outsider", Role.QA_ENGINEER)
        project = models.TestProject(
            project_key="TQA-PRJ-PRIVATE",
            name="Private project",
            department="QA",
            qa_workspace_id=owner_workspace.id,
            owner_id=owner.id,
        )
        db.add(project)
        db.commit()
        set_current_workspace_id(other_workspace.id)
        set_current_workspace_scope_ids({other_workspace.id})

        with pytest.raises(HTTPException) as error:
            operation(project.id, db, outsider)
        assert error.value.status_code == 404
    finally:
        set_current_workspace_id(None)
        set_current_workspace_scope_ids(set())
        db.close()


def test_unrelated_workspace_cannot_clone_repository_content_into_its_own_project():
    db = _session()
    try:
        owner_workspace = models.QAWorkspace(workspace_key="OWNER", name="Owner")
        other_workspace = models.QAWorkspace(workspace_key="OTHER", name="Other")
        db.add_all([owner_workspace, other_workspace])
        db.flush()
        owner = _workspace_user(db, owner_workspace, "owner", Role.QA_ENGINEER)
        outsider = _workspace_user(db, other_workspace, "outsider", Role.QA_ENGINEER)
        source_project = models.TestProject(
            project_key="TQA-PRJ-SOURCE", name="Source", qa_workspace_id=owner_workspace.id,
            owner_id=owner.id,
        )
        target_project = models.TestProject(
            project_key="TQA-PRJ-TARGET", name="Target", qa_workspace_id=other_workspace.id,
            owner_id=outsider.id,
        )
        db.add_all([source_project, target_project])
        db.flush()
        source_case = models.TestCase(
            test_case_key="TQA-TC-SECRET", project_id=source_project.id,
            origin_workspace_id=owner_workspace.id, status="Draft",
            test_scenario="Confidential source scenario", created_by_id=owner.id,
        )
        db.add(source_case)
        db.commit()

        with workspace_context(other_workspace.id, {other_workspace.id}):
            with pytest.raises(HTTPException) as error:
                test_repository.clone_test_case(
                    source_case.id,
                    schemas.TestCaseCloneIn(project_id=target_project.id),
                    db=db,
                    current_user=outsider,
                )

        assert error.value.status_code == 404
    finally:
        db.close()


@pytest.mark.parametrize("export_kind", ["repository", "cycle"])
@pytest.mark.parametrize("revoke_before_worker", [False, True], ids=["parent_scope", "revoked"])
def test_queued_exports_rebuild_and_revalidate_workspace_scope(export_kind, revoke_before_worker):
    """Worker threads get no request ContextVars, so rebuild scope from fresh DB state."""
    db = _session()
    try:
        parent = models.QAWorkspace(workspace_key="PARENT", name="Parent")
        db.add(parent)
        db.flush()
        child = models.QAWorkspace(
            workspace_key="CHILD", name="Child", parent_workspace_id=parent.id,
        )
        user = models.User(
            username="parent.viewer", full_name="Parent Viewer", hashed_password="x",
            is_active=True, role_assignments=[models.UserRole(role=Role.QA_ENGINEER)],
        )
        db.add_all([child, user])
        db.flush()
        membership = models.QAWorkspaceMember(
            workspace_id=parent.id, user_id=user.id,
            role="PARENT_WORKSPACE_VIEWER", is_active=True,
        )
        project = models.TestProject(
            project_key="TQA-PRJ-CHILD", name="Child Project",
            qa_workspace_id=child.id, owner_id=user.id,
        )
        db.add_all([membership, project])
        db.flush()
        cycle = models.TestCycle(
            project_id=project.id, cycle_key="TQA-CYC-CHILD", name="Child Cycle",
        )
        db.add(cycle)
        db.commit()
        user.active_qa_workspace_id = parent.id

        module = test_repository if export_kind == "repository" else test_execution
        captured = {}

        def capture_enqueue(_background_tasks, _job_type, _user_id, action):
            captured["action"] = action
            return {"id": "captured-job", "status": "QUEUED"}

        seen = {}

        def build_export(record_id, worker_db, worker_user):
            seen["workspace_id"] = current_workspace_id()
            seen["scope_ids"] = set(current_workspace_scope_ids())
            if export_kind == "repository":
                test_repository.require_project_visibility(worker_db, record_id, worker_user)
            else:
                worker_cycle = worker_db.get(models.TestCycle, record_id)
                test_execution._require_cycle_visibility(worker_db, worker_cycle, worker_user)
            return Mock()

        async def save_response(_job_id, _response, filename):
            return {"filename": filename}

        target_id = project.id if export_kind == "repository" else cycle.id
        queue_export = (
            test_repository.queue_test_repository_export
            if export_kind == "repository"
            else test_execution.queue_test_cycle_export
        )
        with patch.object(module.jobs, "enqueue", side_effect=capture_enqueue), \
                workspace_context(parent.id, {parent.id, child.id}):
            queue_export(target_id, BackgroundTasks(), db=db, current_user=user)

        if revoke_before_worker:
            membership.is_active = False
            db.commit()

        with patch.object(module, "SessionLocal", side_effect=lambda: Session(db.get_bind())), \
                patch.object(module, f"export_test_{'repository' if export_kind == 'repository' else 'cycle'}", side_effect=build_export) as export_mock, \
                patch.object(module.jobs, "update"), \
                patch.object(module.jobs, "save_streaming_response", new=save_response):
            if revoke_before_worker:
                with pytest.raises(HTTPException) as error:
                    captured["action"]("captured-job")
                assert error.value.status_code == 403
                export_mock.assert_not_called()
            else:
                result = captured["action"]("captured-job")
                assert result["filename"].endswith(".xlsx")
                export_mock.assert_called_once()
                assert seen == {
                    "workspace_id": parent.id,
                    "scope_ids": {parent.id, child.id},
                }
    finally:
        db.close()


@pytest.mark.parametrize("operation", [
    lambda cycle_id, db, user: test_execution.list_executions(
        cycle_id, assignment=None, cursor_mode=False, cursor=None,
        params=_page_params(), db=db, current_user=user,
    ),
    lambda cycle_id, db, user: test_execution.get_execution_summary(
        cycle_id, db=db, current_user=user,
    ),
    lambda cycle_id, db, user: test_execution.export_test_cycle(
        cycle_id, db=db, current_user=user,
    ),
    lambda cycle_id, db, user: test_execution.queue_test_cycle_export(
        cycle_id, BackgroundTasks(), db=db, current_user=user,
    ),
])
def test_restricted_cycle_folder_denies_every_child_read_and_export(operation):
    db = _session()
    try:
        workspace = models.QAWorkspace(workspace_key="QA", name="QA")
        owner = models.User(username="owner", full_name="Owner", hashed_password="x", is_active=True)
        outsider = models.User(
            username="business.user", full_name="Business User", hashed_password="x", is_active=True,
            department_assignments=[models.UserDepartment(department="Finance")],
        )
        db.add_all([workspace, owner, outsider])
        db.flush()
        project = models.TestProject(
            project_key="TQA-PRJ-RESTRICTED", name="Restricted", department="Finance",
            qa_workspace_id=workspace.id, owner_id=owner.id,
        )
        folder = models.TestCycleFolder(project=project, name="Secret", created_by_id=owner.id)
        folder.access_grants.append(models.TestCycleFolderAccess(department="Legal", granted_by_id=owner.id))
        cycle = models.TestCycle(project=project, folder=folder, cycle_key="TQA-CYC-SECRET", name="Secret Cycle")
        db.add_all([project, folder, cycle])
        db.commit()

        with pytest.raises(HTTPException) as error:
            operation(cycle.id, db, outsider)
        assert error.value.status_code == 403
    finally:
        db.close()


def test_agm_qa_is_an_execution_role_and_valid_cycle_owner():
    db = _session()
    try:
        workspace = models.QAWorkspace(workspace_key="QA", name="QA")
        db.add(workspace)
        db.flush()
        agm = _workspace_user(db, workspace, "agm.qa", Role.AGM_QA)
        db.commit()

        assert Role.AGM_QA in test_execution._EXEC_ROLES
        assert test_execution._runner_or_404(
            db, agm.id, workspace_id=workspace.id, cycle_owner=True,
        ).id == agm.id
    finally:
        db.close()


def test_agm_qa_is_not_filtered_from_actionable_cycle_notifications():
    agm = models.User(
        id=81, username="agm.qa", full_name="AGM QA", hashed_password="x", is_active=True,
        role_assignments=[models.UserRole(role=Role.AGM_QA)],
    )
    db = Mock()
    db.get.return_value = agm
    target = models.TestCycle(id=9, project_id=3, cycle_key="TQA-CYC-9", name="Cycle")
    route = email_notifications.NotificationRoute({agm.id}, "Cycle owner", True, "Review the cycle")

    with patch.object(email_notifications, "_unfiltered_notification_route", return_value=route), \
            patch.object(email_notifications, "_target_workspace_id", return_value=None), \
            patch.object(email_notifications, "_department", return_value=None), \
            patch.object(email_notifications, "_next_approver_roles", return_value=set()):
        filtered = email_notifications._notification_route(db, Mock(), target)

    assert filtered.recipient_ids == {agm.id}
