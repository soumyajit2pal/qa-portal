import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models, schemas
from app.constants import QAStatus
from app.routers.test_execution import (
    _runner_or_404,
    _validate_cycle_ready,
    create_cycle,
    list_functional_request_options,
    update_cycle,
)
from app.workspace_service import set_current_workspace_id


@pytest.fixture(autouse=True)
def _sqlite_business_id(monkeypatch):
    """The production ID allocator uses Oracle MERGE; keep route tests on SQLite."""
    monkeypatch.setattr(models, "_claim_business_seq", lambda _prefix, _connection: 1)


def _session():
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def _workspace_user_project(db: Session, *, workspace_key: str = "CORE"):
    workspace = models.QAWorkspace(
        workspace_key=workspace_key,
        name=f"{workspace_key} Workspace",
        is_active=True,
    )
    user = models.User(
        username=f"qa-{workspace_key.lower()}",
        full_name=f"QA {workspace_key}",
        hashed_password="x",
        is_active=True,
        role_assignments=[models.UserRole(role="QA_ENGINEER")],
    )
    application = models.ApplicationMaster(
        name=f"{workspace_key} APPLICATION",
        status="APPROVED",
    )
    db.add_all([workspace, user, application])
    db.flush()
    db.add(models.QAWorkspaceMember(
        workspace_id=workspace.id,
        user_id=user.id,
        role="WORKSPACE_MEMBER",
        is_active=True,
    ))
    project = models.TestProject(
        project_key=f"TQA-PRJ-{workspace_key}",
        name=f"{workspace_key} Project",
        application_master_id=application.id,
        qa_workspace_id=workspace.id,
        is_active=True,
        owner_id=user.id,
        created_by_id=user.id,
    )
    db.add(project)
    db.commit()
    db.refresh(user)
    user.active_qa_workspace_id = workspace.id
    return workspace, user, application, project


def _functional_request(
    db: Session,
    *,
    workspace: models.QAWorkspace,
    user: models.User,
    application: models.ApplicationMaster,
    suffix: str,
):
    request = models.QARequest(
        request_id=f"TQA-REQ-{suffix}",
        application_name=application.name,
        application_master_id=application.id,
        qa_workspace_id=workspace.id,
        requester_id=user.id,
        status="Raised",
    )
    child = models.FunctionalRequest(
        request_id=f"TQA-FUNC-{suffix}",
        status=QAStatus.TEST_DESIGN,
        qa_request=request,
    )
    db.add_all([request, child])
    db.commit()
    return child


def _cycle_payload(**changes):
    values = {
        "name": "Standalone Regression",
        "environment": "UAT",
        "build": "1.0",
        "start_date": datetime.date(2026, 9, 10),
        "end_date": datetime.date(2026, 9, 12),
    }
    values.update(changes)
    return schemas.TestCycleCreate(**values)


def test_create_cycle_without_request_persists_as_standalone():
    db = _session()
    _, user, _, project = _workspace_user_project(db)

    cycle = create_cycle(project.id, _cycle_payload(), db=db, current_user=user)

    assert cycle.child_request_link is None
    assert cycle.linked_request_id is None
    assert cycle.linked_request_type is None


def test_functional_request_options_only_return_same_application_and_workspace():
    db = _session()
    workspace, user, application, project = _workspace_user_project(db)
    matching = _functional_request(
        db, workspace=workspace, user=user, application=application, suffix="MATCH",
    )
    other_application = models.ApplicationMaster(name="OTHER APP", status="APPROVED")
    db.add(other_application)
    db.commit()
    _functional_request(
        db, workspace=workspace, user=user, application=other_application, suffix="OTHER-APP",
    )
    other_workspace = models.QAWorkspace(workspace_key="OTHER", name="Other", is_active=True)
    db.add(other_workspace)
    db.commit()
    _functional_request(
        db, workspace=other_workspace, user=user, application=application, suffix="OTHER-WS",
    )

    options = list_functional_request_options(project.id, db=db, current_user=user)

    assert [option.id for option in options] == [matching.id]


def test_runner_requires_explicit_qa_engineer_role_and_active_workspace_access():
    db = _session()
    workspace, engineer, _, _ = _workspace_user_project(db)
    qa_lead = models.User(
        username="qa-lead-only",
        full_name="QA Lead Only",
        hashed_password="x",
        is_active=True,
        role_assignments=[models.UserRole(role="QA_LEAD")],
    )
    administrator = models.User(
        username="admin-only",
        full_name="Admin Only",
        hashed_password="x",
        is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    other_workspace = models.QAWorkspace(
        workspace_key="RUNNER-OTHER",
        name="Runner Other Workspace",
        is_active=True,
    )
    other_engineer = models.User(
        username="qa-other",
        full_name="QA Other",
        hashed_password="x",
        is_active=True,
        role_assignments=[models.UserRole(role="QA_ENGINEER")],
    )
    db.add_all([qa_lead, administrator, other_workspace, other_engineer])
    db.flush()
    for user in (qa_lead, administrator):
        db.add(models.QAWorkspaceMember(
            workspace_id=workspace.id,
            user_id=user.id,
            role="WORKSPACE_MEMBER",
            is_active=True,
        ))
    db.add(models.QAWorkspaceMember(
        workspace_id=other_workspace.id,
        user_id=other_engineer.id,
        role="WORKSPACE_MEMBER",
        is_active=True,
    ))
    db.commit()

    set_current_workspace_id(workspace.id)
    try:
        assert _runner_or_404(db, engineer.id).id == engineer.id
        assert _runner_or_404(db, qa_lead.id, cycle_owner=True).id == qa_lead.id
        for invalid_owner in (administrator, other_engineer):
            with pytest.raises(HTTPException):
                _runner_or_404(db, invalid_owner.id, cycle_owner=True)

        for invalid_runner in (qa_lead, administrator):
            with pytest.raises(HTTPException) as raised:
                _runner_or_404(db, invalid_runner.id)
            assert raised.value.status_code == 400
            assert raised.value.detail == "Runner must have the QA Engineer (QA) role"

        with pytest.raises(HTTPException) as raised:
            _runner_or_404(db, other_engineer.id)
        assert raised.value.status_code == 400
        assert raised.value.detail == "Runner must have access to this Test Project's workspace"

        # A parent header may consolidate a child-owned project. The runner
        # is eligible when they can access the child's actual project scope,
        # even if they are not a member of the selected parent itself.
        assert _runner_or_404(
            db, other_engineer.id, workspace_id=other_workspace.id,
        ).id == other_engineer.id
    finally:
        set_current_workspace_id(None)


def test_standalone_cycle_can_become_ready_with_an_approved_testcase():
    db = _session()
    cycle = SimpleNamespace(
        child_request_link=None,
        project=SimpleNamespace(qa_workspace_id=1),
        executions=[SimpleNamespace(
            pinned_version=SimpleNamespace(status="Approved"),
            test_case=SimpleNamespace(test_case_key="TQA-TC-01"),
        )],
    )

    _validate_cycle_ready(
        db,
        cycle,
        datetime.date(2026, 9, 10),
        datetime.date(2026, 9, 12),
    )


def test_standalone_cycle_can_be_linked_later_and_unlinked_before_execution():
    db = _session()
    workspace, user, application, project = _workspace_user_project(db)
    request = _functional_request(
        db,
        workspace=workspace,
        user=user,
        application=application,
        suffix="101",
    )
    cycle = create_cycle(project.id, _cycle_payload(), db=db, current_user=user)

    linked = update_cycle(
        cycle.id,
        schemas.TestCycleUpdate(
            linked_request_type="Functional",
            linked_request_id=request.id,
        ),
        db=db,
        current_user=user,
    )
    assert linked.linked_request_id == request.id
    assert linked.linked_request_key == request.request_id

    unlinked = update_cycle(
        cycle.id,
        schemas.TestCycleUpdate(
            linked_request_type=None,
            linked_request_id=None,
        ),
        db=db,
        current_user=user,
    )
    assert unlinked.child_request_link is None
    assert unlinked.linked_request_id is None

    decisions = {
        row.decision
        for row in db.query(models.ApprovalAction).filter_by(
            entity_type="TEST_CYCLE",
            entity_id=cycle.id,
            step_name="Request Link",
        )
    }
    assert decisions == {"Request Linked", "Request Unlinked"}


def test_cycle_cannot_link_a_functional_request_from_another_workspace():
    db = _session()
    _, user, application, project = _workspace_user_project(db, workspace_key="CORE")
    other_workspace = models.QAWorkspace(
        workspace_key="OTHER",
        name="Other Workspace",
        is_active=True,
    )
    db.add(other_workspace)
    db.flush()
    request = _functional_request(
        db,
        workspace=other_workspace,
        user=user,
        application=application,
        suffix="202",
    )

    with pytest.raises(HTTPException) as raised:
        create_cycle(
            project.id,
            _cycle_payload(
                linked_request_type="Functional",
                linked_request_id=request.id,
            ),
            db=db,
            current_user=user,
        )

    assert raised.value.status_code == 400
    assert "same workspace" in raised.value.detail


def test_request_link_is_locked_after_functional_execution_starts():
    db = _session()
    workspace, user, application, project = _workspace_user_project(db)
    request = _functional_request(
        db,
        workspace=workspace,
        user=user,
        application=application,
        suffix="303",
    )
    cycle = create_cycle(
        project.id,
        _cycle_payload(
            linked_request_type="Functional",
            linked_request_id=request.id,
        ),
        db=db,
        current_user=user,
    )
    request.status = QAStatus.EXECUTION_IN_PROGRESS
    db.commit()

    with pytest.raises(HTTPException) as raised:
        update_cycle(
            cycle.id,
            schemas.TestCycleUpdate(
                linked_request_type=None,
                linked_request_id=None,
            ),
            db=db,
            current_user=user,
        )

    assert raised.value.status_code == 400
    assert "cannot be unlinked" in raised.value.detail


@pytest.mark.parametrize('result', ['Fail', 'Blocked', 'Not Executed'])
@pytest.mark.parametrize('role', ['QA_ENGINEER', 'QA_LEAD'])
def test_completion_rejects_two_unsuccessful_cases_in_full_cycle(result, role):
    with _session() as db:
        workspace, user, _, project = _workspace_user_project(db)
        if role != "QA_ENGINEER":
            user.role_assignments.append(models.UserRole(role=role))
        cycle = create_cycle(project.id, _cycle_payload(), db=db, current_user=user)
        cycle.status = 'In Progress'
        for index in range(26):
            case = models.TestCase(project_id=project.id, test_case_key=f'TC-{index}', origin_workspace_id=workspace.id)
            db.add(case); db.flush()
            db.add(models.TestExecution(cycle_id=cycle.id, test_case_id=case.id,
                                       status='Pass' if index < 24 else result))
        db.commit()
        audit_count = db.query(models.ApprovalAction).count()
        with pytest.raises(HTTPException) as error:
            update_cycle(cycle.id, schemas.TestCycleUpdate(status='Completed', remarks='Reviewed'), db, user)
        assert error.value.status_code == 400
        assert '2 testcase(s)' in error.value.detail
        assert 'TC-24' in error.value.detail and 'TC-25' in error.value.detail
        db.refresh(cycle)
        assert cycle.status == 'In Progress'
        assert db.query(models.ApprovalAction).count() == audit_count


@pytest.mark.parametrize('result', ['Pass', 'Retest Passed', 'NA'])
def test_completion_accepts_successful_or_not_applicable_results(result):
    with _session() as db:
        workspace, user, _, project = _workspace_user_project(db)
        cycle = create_cycle(project.id, _cycle_payload(), db=db, current_user=user)
        cycle.status = 'In Progress'
        case = models.TestCase(project_id=project.id, test_case_key='TC-success', origin_workspace_id=workspace.id)
        db.add(case); db.flush()
        db.add(models.TestExecution(cycle_id=cycle.id, test_case_id=case.id, status=result))
        db.commit()
        saved = update_cycle(cycle.id, schemas.TestCycleUpdate(status='Completed'), db, user)
        assert saved.status == 'Completed'


@pytest.mark.parametrize('request_status', [QAStatus.TEST_DESIGN, QAStatus.SM_APPROVAL_PENDING,
                                          QAStatus.WAITING_FOR_FIX, QAStatus.RETESTING,
                                          QAStatus.QA_COMPLETED])
def test_cycle_cannot_start_before_linked_request_execution(request_status):
    with _session() as db:
        workspace, user, application, project = _workspace_user_project(db)
        request = _functional_request(db, workspace=workspace, user=user, application=application, suffix='start')
        cycle = create_cycle(project.id, _cycle_payload(linked_request_type='Functional', linked_request_id=request.id), db, user)
        cycle.status = 'Ready'; request.status = request_status; db.commit()
        audit_count = db.query(models.ApprovalAction).count()
        with pytest.raises(HTTPException) as error:
            update_cycle(cycle.id, schemas.TestCycleUpdate(status='In Progress'), db, user)
        assert request.request_id in error.value.detail
        assert 'must be Execution In Progress' in error.value.detail
        assert cycle.status == 'Ready'
        assert db.query(models.ApprovalAction).count() == audit_count


@pytest.mark.parametrize('linked', [True, False])
def test_cycle_start_accepts_executing_request_or_standalone(linked):
    with _session() as db:
        workspace, user, application, project = _workspace_user_project(db)
        request = _functional_request(db, workspace=workspace, user=user, application=application, suffix='start-ok')
        payload = _cycle_payload(linked_request_type='Functional', linked_request_id=request.id) if linked else _cycle_payload()
        cycle = create_cycle(project.id, payload, db, user)
        cycle.status = 'Ready'; request.status = QAStatus.EXECUTION_IN_PROGRESS; db.commit()
        result = update_cycle(cycle.id, schemas.TestCycleUpdate(status='In Progress'), db, user)
        assert result.status == 'In Progress'
        assert request.status == QAStatus.EXECUTION_IN_PROGRESS


@pytest.mark.parametrize('existing_link', [True, False])
def test_combined_link_change_cannot_bypass_execution_start_gate(existing_link):
    with _session() as db:
        workspace, user, application, project = _workspace_user_project(db)
        request = _functional_request(db, workspace=workspace, user=user, application=application, suffix='link-start')
        payload = _cycle_payload(linked_request_type='Functional', linked_request_id=request.id) if existing_link else _cycle_payload()
        cycle = create_cycle(project.id, payload, db, user)
        cycle.status = 'Ready'; db.commit()
        change = schemas.TestCycleUpdate(status='In Progress', linked_request_type=None if existing_link else 'Functional',
                                         linked_request_id=None if existing_link else request.id)
        with pytest.raises(HTTPException) as error:
            update_cycle(cycle.id, change, db, user)
        assert 'must be Execution In Progress' in error.value.detail
        assert cycle.status == 'Ready'
        assert bool(cycle.child_request_link) == existing_link


def test_resume_still_restores_linked_request_from_waiting_for_fix():
    with _session() as db:
        workspace, user, application, project = _workspace_user_project(db)
        request = _functional_request(db, workspace=workspace, user=user, application=application, suffix='resume')
        cycle = create_cycle(project.id, _cycle_payload(linked_request_type='Functional', linked_request_id=request.id), db, user)
        cycle.status = 'Blocked'; request.status = QAStatus.WAITING_FOR_FIX; db.commit()
        result = update_cycle(cycle.id, schemas.TestCycleUpdate(status='In Progress'), db, user)
        assert result.status == 'In Progress'
        assert request.status == QAStatus.EXECUTION_IN_PROGRESS


@pytest.mark.parametrize("field", ["environment", "build"])
@pytest.mark.parametrize("value", [None, "", "   "])
def test_execution_start_requires_environment_and_build(field, value):
    with _session() as db:
        workspace, user, application, project = _workspace_user_project(db)
        cycle = create_cycle(project.id, _cycle_payload(), db, user)
        cycle.status = 'Ready'
        setattr(cycle, field, value)
        db.commit()
        audit_count = db.query(models.ApprovalAction).count()
        with pytest.raises(HTTPException) as error:
            update_cycle(cycle.id, schemas.TestCycleUpdate(status='In Progress'), db, user)
        assert error.value.status_code == 400
        assert 'Edit Cycle' in error.value.detail
        assert cycle.status == 'Ready'
        assert db.query(models.ApprovalAction).count() == audit_count


def test_in_progress_cycle_can_correct_missing_build_but_cannot_clear_it():
    with _session() as db:
        workspace, user, application, project = _workspace_user_project(db)
        cycle = create_cycle(project.id, _cycle_payload(), db, user)
        cycle.status = 'In Progress'
        cycle.build = None
        db.commit()
        update_cycle(cycle.id, schemas.TestCycleUpdate(build='NA'), db, user)
        assert cycle.build == 'NA'
        with pytest.raises(HTTPException) as error:
            update_cycle(cycle.id, schemas.TestCycleUpdate(build=''), db, user)
        assert error.value.status_code == 400
        assert cycle.build == 'NA'


def test_cycle_create_and_update_reject_owner_outside_workspace():
    with _session() as db:
        workspace, user, application, project = _workspace_user_project(db)
        outsider = models.User(username='outside-owner', full_name='Outside QA', hashed_password='x',
            is_active=True, role_assignments=[models.UserRole(role='QA_ENGINEER')])
        db.add(outsider); db.commit()
        with pytest.raises(HTTPException):
            create_cycle(project.id, _cycle_payload(owner_id=outsider.id), db, user)
        cycle = create_cycle(project.id, _cycle_payload(), db, user)
        with pytest.raises(HTTPException):
            update_cycle(cycle.id, schemas.TestCycleUpdate(owner_id=outsider.id), db, user)
        assert cycle.owner_id is None
