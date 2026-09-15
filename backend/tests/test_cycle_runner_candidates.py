import datetime
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app import models as m
from app.routers.test_projects import list_eligible_test_management_users
from app.routers.test_execution import _runner_or_404


def test_shared_cycle_candidates_match_assignment_validation():
    engine = create_engine('sqlite:///:memory:')
    m.Base.metadata.create_all(engine)
    with Session(engine) as db:
        a = m.QAWorkspace(workspace_key='OWNER', name='Owner')
        b = m.QAWorkspace(workspace_key='COE', name='COE')
        db.add_all([a, b]); db.flush()
        users = []
        for name, workspace, roles, department in [
            ('qa1', b, ['QA_ENGINEER'], 'QA'), ('qa2', b, ['QA_ENGINEER'], 'QA'),
            ('other', a, ['QA_ENGINEER'], 'IT'),
            ('admin-other', b, ['ADMIN', 'QA_ENGINEER'], 'IT'),
            ('admin-own', b, ['ADMIN', 'QA_ENGINEER'], 'QA'),
        ]:
            user = m.User(username=name, full_name=name, hashed_password='x', department=department,
                          is_active=True, role_assignments=[m.UserRole(role=r) for r in roles])
            db.add(user); db.flush()
            db.add(m.QAWorkspaceMember(workspace_id=workspace.id, user_id=user.id, role='WORKSPACE_MEMBER', is_active=True))
            users.append(user)
        project = m.TestProject(project_key='P', name='P', department='QA', qa_workspace_id=a.id)
        db.add(project); db.flush()
        db.add(m.TestProjectViewGrant(project_id=project.id, workspace_id=b.id))
        cycle = m.TestCycle(project=project, cycle_key='CY', name='Cycle', origin_workspace_id=b.id,
                            start_date=datetime.date.today(), end_date=datetime.date.today())
        db.add(cycle); db.commit()
        from app.deps import resolve_entity_workspace_id
        from app.email_notifications import _target_workspace_id
        from app.routers.defects import _creation_context, _require_execution_link_access
        from app.workspace_service import set_current_workspace_id, set_current_workspace_scope_ids
        from types import SimpleNamespace
        case = m.TestCase(project=project, test_case_key='TC', origin_workspace_id=b.id)
        execution = m.TestExecution(cycle=cycle, test_case=case)
        db.add_all([case, execution, m.Department(name='QA', is_active=True)]); db.commit()
        assert resolve_entity_workspace_id(db, 'TEST_CASE', case.id) == b.id
        assert resolve_entity_workspace_id(db, 'TEST_CYCLE', cycle.id) == b.id
        assert resolve_entity_workspace_id(db, 'TEST_EXECUTION', execution.id) == b.id
        assert _target_workspace_id(case) == _target_workspace_id(cycle) == _target_workspace_id(execution) == b.id
        users[0].active_qa_workspace_id = b.id
        set_current_workspace_id(b.id); set_current_workspace_scope_ids({b.id})
        try:
            assert _creation_context(db, users[0], SimpleNamespace(department='QA', application_name='APP'), cycle=cycle) == (b.id, 'QA', 'APP')
            _require_execution_link_access(db, cycle, users[0])
        finally:
            set_current_workspace_id(None); set_current_workspace_scope_ids(set())
        candidates = list_eligible_test_management_users(project_id=project.id, cycle_id=cycle.id, db=db, current_user=users[0])
        assert {u.username for u in candidates} == {'qa1', 'qa2', 'admin-own'}
        for candidate in candidates:
            assert _runner_or_404(db, candidate.id, workspace_id=b.id, project=project) is candidate
        for candidate in users[2:4]:
            with pytest.raises(HTTPException):
                _runner_or_404(db, candidate.id, workspace_id=b.id, project=project)
        with pytest.raises(HTTPException):
            list_eligible_test_management_users(project_id=-1, cycle_id=cycle.id, db=db, current_user=users[0])
