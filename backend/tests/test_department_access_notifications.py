import os
from unittest.mock import patch, MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models, email_notifications


@pytest.fixture
def access_db():
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine, tables=[
        cls.__table__ for cls in (
            models.User, models.UserRole, models.UserDepartment, models.Department,
            models.QAWorkspace, models.DepartmentCoordinatorAssignment,
            models.ApprovalAction, models.EmailNotification,
        )
    ])
    with sessionmaker(bind=engine)() as db:
        yield db
    engine.dispose()


def test_department_coordinators_receive_one_email_across_workspaces(access_db):
    db = access_db
    user = models.User(id=1, username='new.user', full_name='New User', login_type='LDAP',
                       department='Technology', needs_department_selection=False, needs_role_review=True)
    department = models.Department(id=1, name='Technology', is_active=True)
    other = models.Department(id=2, name='Finance', is_active=True)
    parent = models.QAWorkspace(id=1, workspace_key='PARENT', name='Parent', is_active=True)
    child = models.QAWorkspace(id=2, workspace_key='CHILD', name='Child', is_active=True, parent_workspace=parent)
    inactive_workspace = models.QAWorkspace(id=3, workspace_key='INACTIVE', name='Inactive', is_active=False)
    db.add_all([user, department, other, parent, child, inactive_workspace])
    for index, (dept, workspace, active_assignment, active_user, email) in enumerate([
        (department, parent, True, True, 'coordinator@example.com'),
        (department, child, True, True, 'COORDINATOR@example.com'),
        (department, child, True, True, 'child@example.com'),
        (other, parent, True, True, 'other@example.com'),
        (department, parent, False, True, 'removed@example.com'),
        (department, parent, True, False, 'inactive@example.com'),
        (department, inactive_workspace, True, True, 'inactiveworkspace@example.com'),
        (department, parent, True, True, None),
    ], start=2):
        coordinator = models.User(id=index, username=f'coordinator{index}', full_name='Coordinator',
                                  login_type='STANDARD', email=email, is_active=active_user)
        db.add(models.DepartmentCoordinatorAssignment(user=coordinator, department=dept,
                                                      workspace=workspace, is_active=active_assignment))
    db.flush()
    with patch.dict(os.environ, {'SMTP_ENABLED': 'true', 'PORTAL_BASE_URL': 'https://portal.example.com'}):
        assert email_notifications.queue_department_access_review_notifications(db, user) == 2
    db.commit()
    messages = db.query(models.EmailNotification).all()
    assert {m.recipient_email for m in messages} == {'coordinator@example.com', 'child@example.com'}
    for message in messages:
        assert 'New User (new.user) needs approval' in message.body
        for content in (message.body, message.html_body):
            assert 'provide the necessary access in the respective workspace' in content
            assert 'Parent' not in content
            assert 'Child' not in content
            assert 'Your coordinator workspace(s)' not in content
        assert 'https://portal.example.com/department-admin' in message.body
        assert message.approval_action.entity_id == user.id
        assert message.approval_action.entity_type == 'USER_ACCESS'


@pytest.mark.parametrize('smtp, selecting, pending', [
    ('false', False, True), ('true', True, True), ('true', False, False),
])
def test_notification_waits_for_department_and_pending_review(smtp, selecting, pending):
    db = MagicMock()
    user = models.User(needs_department_selection=selecting, needs_role_review=pending)
    with patch.dict(os.environ, {'SMTP_ENABLED': smtp}):
        assert email_notifications.queue_department_access_review_notifications(db, user) == 0
    db.query.assert_not_called()
    db.add.assert_not_called()


def test_department_selection_queues_review_before_commit_and_cannot_repeat():
    from fastapi import HTTPException
    from app import schemas
    from app.routers import auth

    db = MagicMock()
    user = models.User(id=1, username='new.user', full_name='New User', login_type='LDAP',
                       needs_department_selection=True, needs_role_review=True)
    events = []
    db.commit.side_effect = lambda: events.append('commit')

    def queued(session, account):
        assert session is db and account is user
        assert not account.needs_department_selection
        events.append('queue')
        return 1

    with (patch.object(auth, '_validate_department'),
          patch.object(auth, '_set_user_departments'),
          patch.object(auth, '_set_user_department_units'),
          patch.object(auth, 'user_snapshot', return_value={}),
          patch.object(auth, 'write_audit'),
          patch.object(email_notifications, 'queue_department_access_review_notifications', side_effect=queued) as notify):
        payload = schemas.DepartmentSelection(department='Technology')
        auth.update_me(payload, MagicMock(), db, user)
        assert events == ['queue', 'commit']
        with pytest.raises(HTTPException) as error:
            auth.update_me(payload, MagicMock(), db, user)
        assert error.value.status_code == 403
        notify.assert_called_once()
