"""One daily email per approver, using the portal's actionable approval queue.

User row locks serialize daily receipts across API and notification workers.
The existing ApprovalAction/outbox transaction is the durable receipt, so no
schema migration or Redis availability is required for duplicate prevention.
"""
import logging
import threading
from html import escape

from . import email_notifications as mail, models
from .config import settings
from .constants import Role
from .time_format import as_ist
from .workflow_authority import workflow_context
from .workspace_service import inherited_workspace_access_mode, selectable_workspace_ids, workspace_context

logger = logging.getLogger('qa_portal.approval_reminders')
ENTITY_TYPE = 'APPROVAL_REMINDER'
DECISION = 'Daily approval reminder'
DISPLAY_LIMIT = 50
_scan_lock = threading.Lock()
_last_completed_day = None


def _eligible(user):
    return bool(user and user.is_active and (user.email or '').strip()
                and not user.needs_role_review and not user.needs_department_selection
                and not user.needs_email_confirmation
                and not {Role.VIEW_ONLY, Role.SCALE_6_PLUS}.intersection(user.roles))


def actionable_approvals(db, user):
    """Combine workspaces without duplicating parent/child scope records."""
    from .routers.pending_approvals import _actionable_items, _pending_sort_key
    if not _eligible(user):
        return []
    old_workspace = getattr(user, 'active_qa_workspace_id', None)
    old_scope = getattr(user, 'active_workspace_scope_ids', ())
    items = {}
    try:
        for workspace_id in sorted(selectable_workspace_ids(db, user)):
            if inherited_workspace_access_mode(db, user, workspace_id) == 'PARENT_VIEWER':
                continue
            workspace = db.get(models.QAWorkspace, workspace_id)
            if not workspace or not workspace.is_active:
                continue
            user.active_qa_workspace_id = workspace_id
            user.active_workspace_scope_ids = (workspace_id,)
            # Each accessible workspace is visited separately. Workflow mode
            # removes ADMIN's implicit operational role bypass, as in the API.
            with workspace_context(workspace_id, {workspace_id}), workflow_context(user):
                for item in _actionable_items(db, user):
                    key = (item['entity_type'], item['entity_id'], item['category'])
                    items[key] = {**item, 'workspace_name': workspace.name}
    finally:
        user.active_qa_workspace_id = old_workspace
        user.active_workspace_scope_ids = old_scope
    return sorted(items.values(), key=_pending_sort_key)


def _message(user, items, day):
    base_url = mail.os.getenv('PORTAL_BASE_URL', '').rstrip('/')
    shown = items[:DISPLAY_LIMIT]
    remaining = len(items) - len(shown)
    lines, html_items = [], []
    for item in shown:
        url = base_url + item['path']
        stage = item['status_label']
        scope = ' · '.join(part for part in [item.get('workspace_name'), item.get('department')] if part)
        lines.append(f"{item['display_id']} — {item['title']}\nStage: {stage}\n{scope}\n{url}")
        html_items.append(
            f'<li style="margin:10px 0"><a href="{escape(url, quote=True)}">{escape(item["display_id"])}</a>'
            f' — {escape(item["title"])}<br>Stage: {escape(stage)}<br>{escape(scope)}</li>')
    if remaining:
        lines.append(f'{remaining} more approvals are available in Pending Approvals.')
        html_items.append(f'<li>{remaining} more approvals are available in Pending Approvals.</li>')
    queue_url = base_url + '/pending-approvals'
    instruction = f'{len(items)} approval(s) are awaiting your action. Please open Pending Approvals to review them.'
    body = f'Hello {user.full_name},\n\nDaily approval reminder — {day} (IST)\n{instruction}\n\n' + '\n\n'.join(lines) + f'\n\nPending Approvals: {queue_url}\n'
    html_body = mail._html_email(
        'Daily approval reminder', f'{day} · India Standard Time', instruction,
        status=None, panel_title=f'{len(items)} pending approval(s)',
        panel_html='<ul style="margin:8px 0 0;padding-left:20px">' + ''.join(html_items) + '</ul>',
        action_label='Open Pending Approvals', action_url=queue_url,
        footer='One daily reminder for approvals currently awaiting your action. No reminder is sent when your queue is empty.',
    )
    return f'[QualityOps] Daily reminder: {len(items)} pending approval(s)', body, html_body


def queue_user_reminder(db, user_id, day):
    """Queue once under a user row lock; the caller commits the transaction."""
    user = db.query(models.User).filter(models.User.id == user_id).with_for_update().one_or_none()
    if not _eligible(user):
        return 0
    # Use VARCHAR step_name for the day key: Oracle CLOB comments cannot be
    # compared with a string using an ordinary equality predicate.
    step = f'Daily digest {day}'
    prior = db.query(models.ApprovalAction.id).filter_by(
        entity_type=ENTITY_TYPE, entity_id=user.id, step_name=step, decision=DECISION,
    ).first()
    if prior:
        return 0
    items = actionable_approvals(db, user)
    if not items:
        return 0
    subject, body, html_body = _message(user, items, day)
    action = models.ApprovalAction(entity_type=ENTITY_TYPE, entity_id=user.id,
                                  step_name=step, decision=DECISION, actor_role='SYSTEM',
                                  comments=f'{len(items)} pending approval(s) at daily reminder generation.')
    action._email_notifications_queued = True
    if not mail._queue_email_notification(db, action, user.email.strip(), subject=subject,
                                          body=body, html_body=html_body, category='daily_approval_reminder'):
        return 0
    db.add(action)
    return 1


def queue_due_reminders(now=None, continue_running=None):
    """Run today's pass at/after the configured IST time, with restart catch-up."""
    global _last_completed_day
    if not settings.approval_reminders_enabled or not mail.smtp_readiness()[0]:
        return 0
    now = as_ist(now or models.now())
    day = now.date().isoformat()
    if now.strftime('%H:%M') < settings.approval_reminder_time or _last_completed_day == day:
        return 0
    if not _scan_lock.acquire(blocking=False):
        return 0
    continue_running = continue_running or (lambda: True)
    total, last_id, complete = 0, 0, True
    try:
        if _last_completed_day == day:
            return 0
        while continue_running():
            with mail.SessionLocal() as db:
                ids = [row[0] for row in db.query(models.User.id).filter(
                    models.User.id > last_id, models.User.is_active == True,  # noqa: E712
                    models.User.email.is_not(None),
                ).order_by(models.User.id).limit(100).all()]
            if not ids:
                break
            for user_id in ids:
                if not continue_running():
                    return total
                try:
                    with mail.SessionLocal() as db:
                        queued = queue_user_reminder(db, user_id, day)
                        if not continue_running():
                            db.rollback()
                            return total
                        db.commit()
                        total += queued
                except Exception:
                    complete = False
                    logger.exception('Daily approval reminder failed user_id=%s; the next pass will retry', user_id)
            last_id = ids[-1]
        if complete and continue_running():
            _last_completed_day = day
        logger.info('Daily approval reminder pass day=%s queued=%s complete=%s', day, total, complete)
        return total
    finally:
        _scan_lock.release()


def refresh_before_delivery(db, notification):
    """Remove resolved approvals and suppress stale, empty or unauthorized mail."""
    action = notification.approval_action
    if not action or action.entity_type != ENTITY_TYPE:
        return True
    day = as_ist(models.now()).date().isoformat()
    if not settings.approval_reminders_enabled or action.step_name != f'Daily digest {day}':
        return False
    user = db.get(models.User, action.entity_id)
    if not _eligible(user) or user.email.strip() != notification.recipient_email:
        return False
    items = actionable_approvals(db, user)
    if not items:
        return False
    notification.subject, notification.body, notification.html_body = _message(user, items, day)
    return True
