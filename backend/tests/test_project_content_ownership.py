import datetime
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app import models as m
from app.project_workspace_ownership import bind_actor, assert_owned, workspace_can_contribute


@pytest.fixture
def setup():
    engine = create_engine('sqlite:///:memory:')
    m.Base.metadata.create_all(engine)
    with Session(engine) as db:
        a = m.QAWorkspace(id=1, workspace_key='A', name='A')
        b = m.QAWorkspace(id=2, workspace_key='B', name='B')
        project = m.TestProject(id=1, project_key='P', name='P', qa_workspace_id=1)
        share = m.TestProjectViewGrant(id=1, project_id=1, workspace_id=2)
        case = m.TestCase(id=1, project_id=1, test_case_key='C1', origin_workspace_id=1)
        cycle = m.TestCycle(id=1, project_id=1, cycle_key='CY1', name='Cycle A', origin_workspace_id=1,
                            start_date=datetime.date.today(), end_date=datetime.date.today())
        db.add_all([a, b, project, share, case, cycle]); db.commit()
        user = SimpleNamespace(id=2, active_qa_workspace_id=2)
        bind_actor(db, user)
        yield db, user


def test_shared_workspace_creates_and_edits_own_cases_and_cycles(setup):
    db, user = setup
    case = m.TestCase(id=2, project_id=1, test_case_key='C2', origin_workspace_id=1)
    cycle = m.TestCycle(id=2, project_id=1, cycle_key='CY2', name='Cycle B',
                       start_date=datetime.date.today(), end_date=datetime.date.today())
    db.add_all([case, cycle]); db.commit()
    assert case.origin_workspace_id == cycle.origin_workspace_id == 2
    assert case.workspace_writable
    case.test_scenario = 'B changes its own testcase'; cycle.name = 'Updated B cycle'
    db.commit()
    # A's testcase can be reused in B's cycle without changing its ownership.
    execution = m.TestExecution(id=1, cycle_id=2, test_case_id=1, status='Pass')
    db.add(execution); db.commit()
    assert db.get(m.TestCase, 1).origin_workspace_id == 1
    assert not db.get(m.TestCase, 1).workspace_writable


@pytest.mark.parametrize('model,field', [(m.TestCase, 'test_scenario'), (m.TestCycle, 'name')])
def test_foreign_content_is_read_only_even_for_same_project(setup, model, field):
    db, user = setup
    obj = db.get(model, 1)
    setattr(obj, field, 'Forbidden')
    with pytest.raises(HTTPException) as error: db.flush()
    assert error.value.status_code == 403
    db.rollback()


def test_execution_and_evidence_in_foreign_cycle_are_protected(setup):
    db, user = setup
    db.add(m.TestExecution(id=1, cycle_id=1, test_case_id=1))
    with pytest.raises(HTTPException): db.flush()
    db.rollback()


def test_origin_cannot_be_transferred_and_share_revocation_blocks_writes(setup):
    db, user = setup
    case = m.TestCase(id=2, project_id=1, test_case_key='C2')
    db.add(case); db.commit()
    case.origin_workspace_id = 1
    with pytest.raises(HTTPException): db.flush()
    db.rollback()
    db.delete(db.get(m.TestProjectViewGrant, 1)); db.commit()
    assert not workspace_can_contribute(db, 1, user)
    case.test_scenario = 'No longer shared'
    with pytest.raises(HTTPException): db.flush()
    db.rollback()


def test_owner_workspace_cannot_edit_recipient_content(setup):
    db, user = setup
    case = m.TestCase(id=2, project_id=1, test_case_key='C2')
    db.add(case); db.commit()
    user.active_qa_workspace_id = 1
    with pytest.raises(HTTPException): assert_owned(db, case, user)


def test_department_or_user_share_does_not_grant_creation(setup):
    db, user = setup
    share = db.get(m.TestProjectViewGrant, 1)
    share.workspace_id = None; share.user_id = 2
    db.commit()
    db.add(m.TestCase(id=2, project_id=1, test_case_key='C2'))
    with pytest.raises(HTTPException): db.flush()
    db.rollback()


def test_mixed_workspace_bulk_changes_do_not_partially_save(setup):
    db, user = setup
    own = m.TestCase(id=2, project_id=1, test_case_key='C2')
    db.add(own); db.commit()
    own.test_scenario = 'Should roll back'
    foreign = db.get(m.TestCase, 1)
    foreign.test_scenario = 'Forbidden'
    with pytest.raises(HTTPException): db.flush()
    db.rollback()
    assert db.get(m.TestCase, 2).test_scenario != 'Should roll back'


def test_foreign_version_update_is_protected(setup):
    db, user = setup
    db.info.pop('project_workspace_actor')
    version = m.TestCaseVersion(id=1, test_case_id=1, version_major=1, version_minor=0, status='Draft')
    db.add(version); db.commit()
    bind_actor(db, user)
    version.status = 'Approved'
    with pytest.raises(HTTPException): db.flush()
    db.rollback()


def test_view_only_cannot_create_even_with_workspace_share(setup):
    db, user = setup
    user.roles = ['VIEW_ONLY']
    db.add(m.TestCase(id=2, project_id=1, test_case_key='C2'))
    with pytest.raises(HTTPException): db.flush()
    db.rollback()


@pytest.mark.parametrize('path,params', [
    ('/api/test-repository/test-cases/1', {'case_id': 1}),
    ('/api/test-execution/cycles/1', {'cycle_id': 1}),
    ('/api/approvals/TEST_CASE/1/rich-comments', {'entity_type': 'TEST_CASE', 'entity_id': 1}),
])
def test_foreign_mutations_are_rejected_before_side_effects(setup, path, params):
    from app.project_workspace_ownership import guard_request
    db, user = setup
    request = SimpleNamespace(method='POST', url=SimpleNamespace(path=path), path_params=params)
    with pytest.raises(HTTPException) as error: guard_request(db, user, request)
    assert error.value.status_code == 403
