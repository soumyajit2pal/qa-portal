from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from app import models
from app.routers import auth


@pytest.mark.parametrize('case, allowed', [
    ('member', True), ('pending', True), ('disabled', True),
    ('other_department', False), ('other_workspace', False),
    ('not_coordinator', False), ('inactive_assignment', False),
    ('admin', False), ('protected', False), ('confidential', False), ('self', False),
])
def test_coordinator_recovery_scope(case, allowed):
    workspace = models.QAWorkspace(id=10, name='QA', workspace_key='QA', is_active=True)
    department = models.Department(id=20, name='Technology', is_active=True)
    actor = models.User(id=1, username='coordinator', full_name='Coordinator', is_active=True)
    actor.active_qa_workspace_id = 10
    if case != 'not_coordinator':
        actor.department_coordinator_assignments = [models.DepartmentCoordinatorAssignment(
            workspace_id=10, workspace=workspace, department_id=20, department=department,
            is_active=case != 'inactive_assignment',
        )]
    target = models.User(id=2, username='target', full_name='Target',
                        department='Finance' if case == 'other_department' else 'Technology',
                        needs_role_review=case == 'pending', is_active=case != 'disabled',
                        admin_managed_only=case == 'protected')
    if case in ('admin', 'confidential'):
        target.role_assignments = [models.UserRole(role='ADMIN' if case == 'admin' else 'SCALE_6_PLUS')]
    if case not in ('pending', 'other_workspace'):
        target.qa_workspace_memberships = [models.QAWorkspaceMember(
            workspace_id=10, workspace=workspace, role='WORKSPACE_MEMBER', is_active=True,
        )]
    if case == 'self':
        target = actor
    db = MagicMock()
    db.get.side_effect = lambda model, identity: workspace if model is models.QAWorkspace else target
    request = Request({'type': 'http', 'headers': []})
    with patch.object(auth, '_unlock_login_failures', return_value=5) as unlock, patch.object(auth, 'write_audit') as audit:
        if allowed:
            result = auth.unlock_local_admin_login(target.id, request, db, actor)
            assert 'Sign-in attempts cleared' in result['message']
            unlock.assert_called_once_with(db, target.username)
            db.commit.assert_called_once()
            assert audit.call_args.kwargs['actor'] is actor
            assert audit.call_args.kwargs['action'] == 'LOGIN_UNLOCK'
            assert target.is_active == (case != 'disabled')
            assert target.needs_role_review == (case == 'pending')
        else:
            with pytest.raises(HTTPException) as error:
                auth.unlock_local_admin_login(target.id, request, db, actor)
            assert error.value.status_code == 403
            unlock.assert_not_called()
            db.commit.assert_not_called()
            audit.assert_not_called()


def test_missing_recovery_target_is_not_found():
    db = MagicMock()
    db.get.return_value = None
    with pytest.raises(HTTPException) as error:
        auth.unlock_local_admin_login(404, MagicMock(), db, models.User(id=1))
    assert error.value.status_code == 404
