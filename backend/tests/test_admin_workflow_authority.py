import pytest
from types import SimpleNamespace
from fastapi import HTTPException
from starlette.requests import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app import models as m
from app.workflow_authority import configure_request, workflow_context
from app.deps import require_not_requester, require_roles
from app.routers.pending_approvals import count_pending_approvals, list_pending_approvals
from app import pagination


@pytest.fixture
def setup():
    engine = create_engine('sqlite:///:memory:')
    m.Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = m.User(username='admin-reviewer', full_name='Admin reviewer', hashed_password='x',
                      department='QA', is_active=True,
                      role_assignments=[m.UserRole(role='ADMIN')])
        db.add(user); db.commit()
        yield db, user


def request(path, method='POST'):
    return Request({'type': 'http', 'method': method, 'path': path, 'headers': [], 'query_string': b''})


def test_admin_configuration_still_has_admin_authority(setup):
    db, user = setup
    req = request('/api/auth/users/1')
    configure_request(db, user, req)
    assert require_roles('ADMIN')(req, user) is user
    assert user.roles == ['ADMIN']


@pytest.mark.parametrize('path', ['/api/test-repository/test-cases/1/review', '/api/functional-requests/1/sm-decision',
                                 '/api/signoffs/1/qa-lead-decision', '/api/defects/1/actions',
                                 '/api/application-names/1/app-owner-decision'])
def test_admin_alone_cannot_mutate_workflow(setup, path):
    db, user = setup
    with pytest.raises(HTTPException) as exc:
        configure_request(db, user, request(path), workflow=True)
    assert exc.value.status_code == 403


def test_admin_has_no_pending_items_without_workflow_role(setup):
    db, user = setup
    assert count_pending_approvals(db=db, current_user=user) == {'count': 0}
    assert list_pending_approvals(db=db, current_user=user, params=SimpleNamespace(page=1, page_size=25), category=None)['total'] == 0
    assert user.roles == ['ADMIN']  # Request policy does not modify assignments.


def test_admin_with_explicit_role_cannot_self_approve(setup):
    db, user = setup
    user.role_assignments.append(m.UserRole(role='QA_ENGINEER')); db.commit()
    req = request('/api/test-repository/test-cases/1/review')
    configure_request(db, user, req, workflow=True)
    assert user.has_role('QA_ENGINEER')
    assert not user.has_role('QA_LEAD')
    assert not user.has_role('ADMIN')
    assert 'ADMIN' in user.roles_csv  # Audit retains actual identity.
    with pytest.raises(HTTPException):
        require_not_requester(user, user.id)


@pytest.mark.parametrize('department,allowed', [('QA', True), ('Payments', False), (None, False)])
def test_admin_workflow_write_requires_own_department(setup, department, allowed):
    db, user = setup
    user.role_assignments.append(m.UserRole(role='QA_ENGINEER')); db.commit()
    project = m.TestProject(project_key='P', name='Project', department=department)
    db.add(project); db.commit()
    configure_request(db, user, request('/api/test-repository/test-cases'), workflow=True)
    case = m.TestCase(project=project, test_case_key='TC')
    db.add(case)
    if allowed:
        db.flush()
    else:
        with pytest.raises(HTTPException): db.flush()
    db.rollback()


def test_admin_queue_and_direct_access_match_department_and_self_approval_rules(setup):
    from app.workspace_service import set_current_workspace_id, set_current_workspace_scope_ids
    db, user = setup
    user.role_assignments.append(m.UserRole(role='QA_ENGINEER'))
    workspace = m.QAWorkspace(workspace_key='QA', name='QA', is_active=True)
    author = m.User(username='maker', full_name='Maker', hashed_password='x', is_active=True)
    db.add_all([workspace, author]); db.flush()
    db.add(m.QAWorkspaceMember(workspace_id=workspace.id, user_id=user.id,
                              role='WORKSPACE_MEMBER', is_active=True))
    cases = []
    for index, (department, maker) in enumerate([('QA', author), ('Payments', author), ('QA', user)]):
        project = m.TestProject(project_key=f'P{index}', name='Project', department=department,
                                qa_workspace_id=workspace.id, is_active=True)
        case = m.TestCase(project=project, test_case_key=f'TC{index}', origin_workspace_id=workspace.id)
        draft = m.TestCaseVersion(test_case=case, status='Recommendation Pending', author_id=maker.id,
                                  submitted_by_id=maker.id, version_major=1, version_minor=0)
        db.add_all([project, case, draft]); db.flush()
        case.current_draft_version_id = draft.id
        cases.append(case)
    db.commit()
    user.active_qa_workspace_id = workspace.id
    set_current_workspace_id(workspace.id); set_current_workspace_scope_ids({workspace.id})
    try:
        assert count_pending_approvals(db=db, current_user=user) == {'count': 1}
        page = list_pending_approvals(db=db, current_user=user, params=SimpleNamespace(page=1, page_size=25), category=None)
        assert [item['display_id'] for item in page['items']] == ['TC0']
        configure_request(db, user, request(f'/api/test-repository/test-cases/{cases[0].id}/review'), workflow=True)
        with pytest.raises(HTTPException) as error:
            configure_request(db, user, request(f'/api/test-repository/test-cases/{cases[1].id}/review'), workflow=True)
        assert error.value.status_code == 403
    finally:
        set_current_workspace_id(None); set_current_workspace_scope_ids(set())
