import datetime
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app import models as m, email_notifications as mail
from app.sla_notifications import queue_record_breach

@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv('SMTP_ENABLED', 'true')
    monkeypatch.setattr(mail, 'deliver_pending_async', lambda: None)
    engine = create_engine('sqlite:///:memory:')
    m.Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()

def user(db, ident, role, department):
    u=m.User(id=ident, username=f'u{ident}', full_name=f'User {ident}', email=f'u{ident}@example.test',
        hashed_password='x', is_active=True, role_assignments=[m.UserRole(role=role)],
        department_assignments=[m.UserDepartment(department=department)])
    db.add(u); db.flush()
    return u

def test_smtp_uses_verified_context_for_both_tls_modes():
    for implicit in [True, False]:
        settings=dict(host='mail.example.test', port=465 if implicit else 587, timeout=2,
                      ssl=implicit, starttls=not implicit, username='', password='')
        with patch.object(mail.smtplib, 'SMTP_SSL' if implicit else 'SMTP') as smtp:
            mail._send_message(mail.EmailMessage(), settings)
            context = smtp.call_args.kwargs['context'] if implicit else smtp.return_value.__enter__.return_value.starttls.call_args.kwargs['context']
            assert context.check_hostname
            assert context.verify_mode == mail.ssl.CERT_REQUIRED

@pytest.mark.parametrize('stage,field', [('Ready for QA','retest_tester_id'), ('QA Testing','retest_tester_id'),
    ('Business Acceptance','business_owner_id'), ('Ready for Release','release_owner_id'),
    ('Production Verification','release_owner_id')])
def test_modern_defect_handoffs(stage,field):
    route=mail._defect_notification_route(None, SimpleNamespace(status=stage, **{field:42}))
    assert route.recipient_ids == {42}
    assert route.action_required

def test_new_defect_has_no_global_group_fallback():
    with patch.object(mail, '_role_user_ids') as global_lookup:
        assert mail._defect_notification_route(None, SimpleNamespace(status='New')) is None
        global_lookup.assert_not_called()

def test_cycle_creation_notifies_owner_and_uses_cycle_link(db):
    owner=user(db,1,'QA_ENGINEER','QA')
    cycle=m.TestCycle(id=1,cycle_key='CYCLE-1',name='Cycle',status='Draft',owner_id=owner.id)
    action=m.ApprovalAction(entity_type='TEST_CYCLE',entity_id=1,decision='Created')
    assert mail._notification_route(db,action,cycle).recipient_ids == {owner.id}
    assert mail._portal_link(action,'CYCLE-1') == '/test-execution?cycle=1'

def test_sla_boundary_recipients_dedup_and_new_update(db):
    runner=user(db,1,'QA_ENGINEER','QA')
    head=user(db,2,'DEPARTMENT_HEAD_CM','QA')
    user(db,3,'DEPARTMENT_HEAD_CM','Other')
    now=m.now()
    target=m.FunctionalRequest(id=1,request_id='FUNC-1',status='EXECUTION_IN_PROGRESS',
        assigned_tester_ids=str(runner.id),updated_at=now-datetime.timedelta(days=15),created_at=now)
    db.add(target); db.flush()
    assert queue_record_breach(db,'FUNCTIONAL_REQUEST',target,now)==0
    target.updated_at=now-datetime.timedelta(days=16); db.flush()
    assert queue_record_breach(db,'FUNCTIONAL_REQUEST',target,now)==2
    db.flush()
    assert {r.recipient_email for r in db.query(m.EmailNotification)} == {runner.email,head.email}
    assert queue_record_breach(db,'FUNCTIONAL_REQUEST',target,now)==0
    target.updated_at=now-datetime.timedelta(days=17); db.flush()
    assert queue_record_breach(db,'FUNCTIONAL_REQUEST',target,now)==2
    target.status='DONE'; db.flush()
    assert queue_record_breach(db,'FUNCTIONAL_REQUEST',target,now)==0

def test_scope_excludes_other_department_view_only_and_inactive(db):
    good=user(db,1,'SM','IT')
    wrong=user(db,2,'SM','Other')
    view=user(db,3,'SM','IT');view.role_assignments.append(m.UserRole(role='VIEW_ONLY'))
    inactive=user(db,4,'SM','IT');inactive.is_active=False
    db.flush()
    target=m.QARequest(id=1,department='IT',status='SM_APPROVAL_PENDING',requester_id=99)
    action=m.ApprovalAction(entity_type='QA_REQUEST',entity_id=1,decision='Pending')
    assert mail._notification_route(db,action,target).recipient_ids == {good.id}

def test_group_mail_excludes_wrong_workspace_and_parent_viewer(db, monkeypatch):
    from app import workspace_service
    good=user(db,1,'QA_ENGINEER','QA')
    outsider=user(db,2,'QA_ENGINEER','QA')
    viewer=user(db,3,'QA_ENGINEER','QA')
    administrator=user(db,4,'QA_ENGINEER','Other')
    administrator.role_assignments.append(m.UserRole(role='ADMIN'));db.flush()
    monkeypatch.setattr(mail,'_workspace_role_user_ids',lambda *args:{1,2,3,4})
    monkeypatch.setattr(workspace_service,'selectable_workspace_ids',lambda db,u:{10} if u.id!=2 else {20})
    monkeypatch.setattr(workspace_service,'inherited_workspace_access_mode',lambda db,u,w:'PARENT_VIEWER' if u.id==3 else None)
    target=m.Defect(id=1,status='New',department='QA',qa_workspace_id=10)
    action=m.ApprovalAction(entity_type='DEFECT',entity_id=1,decision='Created',new_state='New')
    assert mail._notification_route(db,action,target).recipient_ids == {good.id}

def test_sla_disabled_does_not_queue(db, monkeypatch):
    monkeypatch.setenv('SMTP_ENABLED','false')
    target=m.FunctionalRequest(id=1,status='EXECUTION_IN_PROGRESS',updated_at=m.now()-datetime.timedelta(days=30))
    assert queue_record_breach(db,'FUNCTIONAL_REQUEST',target)==0
    assert db.query(m.EmailNotification).count()==0

def test_closed_defect_sla_does_not_send(db):
    reporter=user(db,1,'QA_ENGINEER','QA')
    target=m.Defect(id=1,status='Closed',reporter_id=reporter.id,updated_at=m.now()-datetime.timedelta(days=30))
    assert queue_record_breach(db,'DEFECT',target)==0
    assert db.query(m.EmailNotification).count()==0
