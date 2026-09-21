"""Dashboard-compatible breach notifications; one notice per unchanged breach.

Calendar-day ageing is identical to the dashboard: 16+ elapsed days since
last update. SMTP enablement controls this worker too. No business data is
modified; only an audit marker and durable outbox messages are committed.
"""
from . import models as m
from . import email_notifications as mail
from .workspace_service import selectable_workspace_ids
from .reassignment import department_head_user_ids

ENTITIES = {
    'QA_REQUEST': m.QARequest, 'FUNCTIONAL_REQUEST': m.FunctionalRequest, 'SAST': m.SASTRequest,
    'DAST': m.DASTRequest, 'PERFORMANCE': m.PerformanceRequest,
    'SUPPRESSION': m.SuppressionRequest, 'SIGNOFF': m.QASignOff,
    'DEFECT': m.Defect, 'TEST_CASE': m.TestCase, 'TEST_PROJECT': m.TestProject,
    'TEST_CYCLE': m.TestCycle, 'TEST_EXECUTION': m.TestExecution,
}


def queue_record_breach(db, entity_type, target, now=None):
    if not mail._enabled():
        return 0
    now = m.as_aware(now or m.now())
    updated = getattr(target, 'updated_at', None) or getattr(target, 'created_at', None)
    if not updated or (now - m.as_aware(updated)).days <= 15:
        return 0
    probe = m.ApprovalAction(entity_type=entity_type, entity_id=target.id, decision='Pending')
    route = mail._notification_route(db, probe, target)
    if not route or not route.action_required or not route.recipient_ids:
        return 0
    # The caller holds the target row lock, serializing worker instances.
    marker = f'SLA16:{target.status}:{m.as_aware(updated).isoformat()}'
    prior = db.query(m.ApprovalAction).filter_by(entity_type=entity_type, entity_id=target.id,
        decision='SLA breach notification').all()
    if any(a.comments == marker for a in prior):
        return 0
    recipients = set(route.recipient_ids)
    departments = set()
    for uid in recipients:
        user = db.get(m.User, uid)
        departments.update(user.departments if user else [])
    workspace = mail._target_workspace_id(target)
    for department in departments:
        for uid in department_head_user_ids(db, department):
            user = db.get(m.User, uid)
            if user and (not workspace or workspace in selectable_workspace_ids(db, user)):
                recipients.add(uid)
    action = m.ApprovalAction(entity_type=entity_type, entity_id=target.id,
        step_name='SLA monitoring', decision='SLA breach notification',
        actor_id=None, actor_role='SYSTEM', comments=marker)
    action._email_notifications_queued = True
    reference = mail._portal_reference(probe, target)
    url = mail.os.getenv('PORTAL_BASE_URL', '').rstrip('/') + mail._portal_link(probe, reference)
    count = 0
    for uid in sorted(recipients):
        user = db.get(m.User, uid)
        if not user or not user.is_active or not user.email:
            continue
        count += mail._queue_email_notification(db, action, user.email,
            subject=f'SLA breached: {reference}'[:255],
            body=f'{reference} has been pending for {(now - m.as_aware(updated)).days} days.\n'
                 f'Current stage: {target.status}\nResponsible: {route.recipient_label}\n'
                 f'Please review with the responsible assignee and department head.\n{url}',
            html_body=None, category='sla_breach')
    if count:
        db.add(action)
    return count


def queue_breaches():
    if not mail._enabled():
        return 0
    total = 0
    for kind, model in ENTITIES.items():
        # Keyset pages avoid loading an unbounded deployment into memory.
        last_id = 0
        while True:
            with mail.SessionLocal() as db:
                ids = [r[0] for r in db.query(model.id).filter(model.id > last_id)
                       .order_by(model.id).limit(100).all()]
            if not ids:
                break
            for ident in ids:
                try:
                    with mail.SessionLocal() as db:
                        target = db.query(model).filter(model.id == ident).with_for_update().one_or_none()
                        if target is not None:
                            total += queue_record_breach(db, kind, target)
                        db.commit()
                except Exception:
                    mail.logger.exception('SLA notification evaluation failed entity=%s id=%s', kind, ident)
            last_id = ids[-1]
    return total
