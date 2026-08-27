"""Transactional email notifications for workflow activity.

SMTP is deliberately disabled unless SMTP_ENABLED=true. Once enabled,
workflow events are placed in a durable outbox, so a transient SMTP outage
never loses a notification.
"""
import datetime
import logging
import os
import smtplib
import threading
import time
from dataclasses import dataclass
from email.message import EmailMessage
from html import escape
from urllib.parse import quote

from sqlalchemy import event, or_
from sqlalchemy.orm import Session as SASession, joinedload

from . import models
from .constants import QA_DEPARTMENT, Role
from .database import SessionLocal

logger = logging.getLogger("qa_portal.email")
_listener_installed = False
_poller_started = False
_MAX_ATTEMPTS = 5


@dataclass(frozen=True)
class NotificationRoute:
    recipient_ids: set[int]
    recipient_label: str
    action_required: bool
    instruction: str


def _enabled() -> bool:
    return os.getenv("SMTP_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _smtp_settings() -> dict:
    return {
        "host": os.getenv("SMTP_HOST", "").strip(),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "username": os.getenv("SMTP_USERNAME", "").strip(),
        "password": os.getenv("SMTP_PASSWORD", ""),
        "from_address": os.getenv("SMTP_FROM_ADDRESS", "").strip(),
        "from_name": os.getenv("SMTP_FROM_NAME", "QA Portal").strip() or "QA Portal",
        "starttls": os.getenv("SMTP_STARTTLS", "true").strip().lower() in {"1", "true", "yes", "on"},
        "ssl": os.getenv("SMTP_SSL", "false").strip().lower() in {"1", "true", "yes", "on"},
        "timeout": int(os.getenv("SMTP_TIMEOUT_SECONDS", "15")),
    }


def smtp_readiness() -> tuple[bool, str | None]:
    if not _enabled():
        return False, "SMTP_ENABLED is false"
    settings = _smtp_settings()
    if not settings["host"] or not settings["from_address"]:
        return False, "SMTP_HOST and SMTP_FROM_ADDRESS are required"
    if settings["ssl"] and settings["starttls"]:
        return False, "SMTP_SSL and SMTP_STARTTLS cannot both be enabled"
    return True, None


def _target(action: models.ApprovalAction, db: SASession):
    mapping = {
        "QA_REQUEST": models.QARequest, "FUNCTIONAL_REQUEST": models.FunctionalRequest,
        "SAST": models.SASTRequest, "DAST": models.DASTRequest,
        "PERFORMANCE": models.PerformanceRequest, "SUPPRESSION": models.SuppressionRequest,
        "SIGNOFF": models.QASignOff, "DEFECT": models.Defect,
        "TEST_PROJECT": models.TestProject, "TEST_CASE": models.TestCase,
    }
    model = mapping.get(action.entity_type)
    return db.get(model, action.entity_id) if model else None


def _department(target) -> str | None:
    if not target:
        return None
    direct = getattr(target, "department", None)
    if direct:
        return direct
    project = getattr(target, "project", None)
    if project and project.department:
        return project.department
    parent = getattr(target, "qa_request", None)
    return parent.department if parent else None


def _requester_user_ids(target) -> set[int]:
    """The person who must respond when work is returned or completed."""
    if not target:
        return set()
    ids = set()
    for field in (
        "requester_id", "created_by_id", "author_id", "submitted_by_id", "pending_requested_by_id",
    ):
        value = getattr(target, field, None)
        if value:
            ids.add(value)
    # A TestCase's requester is stored on its active draft version rather
    # than on the permanent testcase identity.
    draft = getattr(target, "current_draft_version", None)
    if draft:
        for field in ("author_id", "submitted_by_id"):
            value = getattr(draft, field, None)
            if value:
                ids.add(value)
    parent = getattr(target, "qa_request", None)
    if parent and parent.requester_id:
        ids.add(parent.requester_id)
    return ids


def _next_approver_roles(target) -> set[str]:
    status = str(getattr(target, "status", "") or "").upper()
    # Sign-off uses historical status names, but its first decision is a QA
    # Lead and its second is the QA Executive group—not the business SM/DH.
    if isinstance(target, models.QASignOff):
        if status == "SM_APPROVAL_PENDING":
            return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
        if status == "DEPT_HEAD_QA_APPROVAL_PENDING":
            return {Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if isinstance(target, models.TestCase):
        if status == "IN REVIEW":
            return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
        if status == "RECOMMENDATION PENDING":
            return {Role.QA_ENGINEER}
        if status in {"REVIEW COMPLETED", "QA LEAD APPROVAL PENDING"}:
            return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if isinstance(target, models.TestProject) and target.pending_is_active is not None:
        return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if isinstance(target, models.QARequest):
        application = getattr(target, "application_master", None)
        application_status = str(getattr(application, "status", "") or "").upper()
        if application_status == "PENDING_APP_OWNER":
            return {Role.APPLICATION_OWNER}
        if application_status == "PENDING_SM":
            return {Role.SM}
    if status == "SM_APPROVAL_PENDING":
        return {Role.SM}
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return {Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM}
    if status in {"QA_LEAD_ASSIGNED", "READINESS_VERIFICATION", "ENGINEER_ASSIGNED", "READINESS"}:
        return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if status in {"SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS"}:
        return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if status == "SECURITY_TEAM_VERIFICATION":
        return {Role.SECURITY_ANALYST}
    if status in {"QA_LEAD_APPROVAL_PENDING", "REVIEW_COMPLETED"}:
        return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    return set()


def _role_user_ids(db: SASession, roles: set[str], department: str | None) -> set[int]:
    if not roles:
        return set()
    users = db.query(models.User).join(models.UserRole).options(
        joinedload(models.User.department_assignments)
    ).filter(models.User.is_active == True, models.UserRole.role.in_(roles)).all()  # noqa: E712
    return {user.id for user in users if not department or user.has_department(department)}


def _role_label(roles: set[str]) -> str:
    labels = {
        Role.SM: "Service Manager",
        Role.DEPARTMENT_HEAD_CM: "Department Head",
        Role.DEPARTMENT_HEAD_AGM: "Department Head",
        Role.APPLICATION_OWNER: "Application Owner",
        Role.QA_LEAD: "QA Lead",
        Role.CHIEF_MANAGER_QA: "QA Lead Group",
        Role.AGM_QA: "QA Lead Group",
        Role.SECURITY_ANALYST: "Security Team",
        Role.QA_ENGINEER: "QA Team",
    }
    for role in roles:
        if role in labels:
            return labels[role]
    return "QA Portal user"


def _is_workflow_transition(action: models.ApprovalAction) -> bool:
    """Ignore audit-only actions such as document uploads while an item waits.

    Workflow routing is based on the target's final status at commit time.
    Without this guard, an evidence upload during SM approval would send a
    second, misleading SM reminder even though no workflow stage changed.
    """
    decision = (action.decision or "").strip().lower()
    return any(word in decision for word in (
        "submit", "pending", "resubmit", "reopen", "approv", "recommend",
        "return", "reject", "fail", "accept", "clear", "issue", "complete",
        "close", "cancel", "change", "request",
    ))


def _notification_route(db: SASession, action: models.ApprovalAction, target) -> NotificationRoute | None:
    """Route each workflow transition to its *next* responsible party.

    This deliberately does not copy every stakeholder on every message.
    For example, after a requester raises a request only the SM receives the
    action-required mail; after the SM approves it only the Department Head
    receives the next one. Returned work goes to the requester. This mirrors
    the Pending Approvals queue and prevents duplicate/noisy notifications.
    """
    if not target or not _is_workflow_transition(action):
        return None

    roles = _next_approver_roles(target)
    if roles:
        department = QA_DEPARTMENT if isinstance(target, models.TestCase) else _department(target)
        recipients = _role_user_ids(db, roles, department)
        if recipients:
            label = _role_label(roles)
            return NotificationRoute(
                recipients, label, True,
                f"Your {label} review is required before this workflow can continue.",
            )

    status = str(getattr(target, "status", "") or "").upper()
    requester_ids = _requester_user_ids(target)
    if not requester_ids:
        return None
    if status.startswith("RETURNED") or status in {"SM_REJECTED", "ASSIGNED_TO_REQUESTER", "WAITING_FOR_FIX", "REQUESTER_VERIFICATION"}:
        return NotificationRoute(
            requester_ids, "Requester", True,
            "This item needs your review or update before the workflow can continue.",
        )
    if status in {"REJECTED", "DEPARTMENT_HEAD_REJECTED", "DONE", "ISSUED", "CLOSED", "CANCELLED"}:
        return NotificationRoute(
            requester_ids, "Requester", False,
            "The workflow has reached an outcome. Open the record for the full details.",
        )
    return None


def _route(action: models.ApprovalAction) -> str:
    routes = {
        "QA_REQUEST": "/qa-requests", "FUNCTIONAL_REQUEST": "/functional-requests",
        "SAST": "/sast", "DAST": "/dast", "PERFORMANCE": "/performance",
        "SUPPRESSION": "/suppression", "SIGNOFF": "/signoff", "DEFECT": "/defects",
        "TEST_PROJECT": "/test-projects", "TEST_CASE": "/test-repository",
    }
    return routes.get(action.entity_type, "/approvals")


def _portal_reference(action: models.ApprovalAction, target) -> str:
    """Return the business ID users see in the portal, never a database key."""
    if target:
        for field in (
            "request_id", "suppression_id", "certificate_id", "defect_key",
            "project_key", "test_case_key",
        ):
            value = getattr(target, field, None)
            if value:
                return str(value)
    # This fallback is intentionally descriptive rather than presenting the
    # internal primary key as a user-facing record identifier.
    return action.entity_type.replace("_", " ").title()


def _portal_link(action: models.ApprovalAction, reference: str) -> str:
    """Link to the exact portal record, including when its list is paginated."""
    route = _route(action)
    if route == "/approvals":
        return route
    return f"{route}?open={quote(reference, safe='')}&openId={action.entity_id}"


def _status_label(value) -> str:
    """Make stored status codes readable without degrading acronyms (SM/QA)."""
    words = str(value or "—").replace("_", " ").split()
    acronyms = {"SM", "QA", "SAST", "DAST", "COE", "AGM"}
    return " ".join(word if word.upper() in acronyms else word.title() for word in words)


def _queue_for_action(db: SASession, action: models.ApprovalAction) -> None:
    # Before SMTP is deliberately enabled, do not accumulate weeks of stale
    # workflow mail that would surprise users on the first activation.
    if not _enabled():
        return
    if getattr(action, "_email_notifications_queued", False):
        return
    action._email_notifications_queued = True
    target = _target(action, db)
    route = _notification_route(db, action, target)
    if not route:
        return
    recipient_ids = route.recipient_ids - {action.actor_id}
    if not recipient_ids:
        return
    users = db.query(models.User).filter(models.User.id.in_(recipient_ids), models.User.is_active == True).all()  # noqa: E712
    portal_url = os.getenv("PORTAL_BASE_URL", "").rstrip("/")
    reference = _portal_reference(action, target)
    path = _portal_link(action, reference)
    url = f"{portal_url}{path}" if portal_url else path
    status = _status_label(getattr(target, "status", None))
    type_label = action.entity_type.replace("_", " ").title()
    subject = f"{'Action required' if route.action_required else 'Workflow update'}: {reference} — {route.recipient_label}"
    body = (
        f"QA PORTAL {'ACTION REQUIRED' if route.action_required else 'WORKFLOW UPDATE'}\n\n"
        f"{route.instruction}\n\n"
        f"Record: {reference}\nType: {type_label}\nCurrent status: {status}\n"
        f"Latest action: {action.step_name or 'Workflow'} — {action.decision or 'Updated'}\n"
        f"Comments: {action.comments or 'No comments provided.'}\n\n"
        f"Open item: {url}\n"
    )
    html_body = f"""<!doctype html><html><body style=\"margin:0;background:#f3f7f8;font-family:Arial,sans-serif;color:#19333b\">
<div style=\"max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #dce7e9;border-radius:12px;overflow:hidden\">
  <div style=\"padding:20px 28px;background:#0d6678;color:#ffffff\"><strong style=\"font-size:18px;letter-spacing:.3px\">QA Portal</strong><div style=\"margin-top:5px;font-size:12px;opacity:.88\">{'Action required' if route.action_required else 'Workflow update'}</div></div>
  <div style=\"padding:26px 28px\"><h1 style=\"margin:0 0 10px;font-size:22px;color:#173d49\">{escape(reference)}</h1>
    <p style=\"margin:0 0 20px;font-size:15px;line-height:1.55\">{escape(route.instruction)}</p>
    <table style=\"width:100%;border-collapse:collapse;font-size:14px\"><tr><td style=\"padding:9px 0;color:#627981;width:38%\">Type</td><td style=\"padding:9px 0;font-weight:600\">{escape(type_label)}</td></tr><tr><td style=\"padding:9px 0;color:#627981\">Current status</td><td style=\"padding:9px 0;font-weight:600\">{escape(status)}</td></tr><tr><td style=\"padding:9px 0;color:#627981\">Latest action</td><td style=\"padding:9px 0\">{escape(action.step_name or 'Workflow')} — {escape(action.decision or 'Updated')}</td></tr></table>
    <div style=\"margin:18px 0;padding:12px 14px;background:#f5f8f9;border-left:3px solid #0d6678;font-size:13px;line-height:1.5\"><strong>Comments</strong><br>{escape(action.comments or 'No comments provided.').replace(chr(10), '<br>')}</div>
    <a href=\"{escape(url, quote=True)}\" style=\"display:inline-block;padding:12px 18px;background:#0d6678;color:#ffffff;text-decoration:none;border-radius:7px;font-weight:bold\">Open in QA Portal</a>
  </div>
  <div style=\"padding:14px 28px;background:#f7fafb;color:#71858c;font-size:11px\">This is an automated QA Portal workflow notification.</div>
</div></body></html>"""
    for user in users:
        email = (user.email or "").strip()
        if email:
            db.add(models.EmailNotification(
                # `action` is new at before_commit time, so its Oracle
                # identity value is still None.  The relationship makes
                # SQLAlchemy insert the ApprovalAction first, then binds the
                # generated ID into this mandatory FK during the same flush.
                approval_action=action, recipient_email=email, subject=subject, body=body, html_body=html_body,
            ))


def _before_commit(session: SASession) -> None:
    if session.info.get("email_notification_listener"):
        return
    actions = [item for item in session.new if isinstance(item, models.ApprovalAction)]
    if not actions:
        return
    session.info["email_notification_listener"] = True
    try:
        # A single endpoint can log several history rows while moving one
        # record through intermediate states (e.g. Submitted then SM
        # Approval Pending). Route only the final row for that record, based
        # on its final status, so the next approver receives one precise
        # notification instead of duplicates.
        final_actions = {}
        for action in actions:
            final_actions[(action.entity_type, action.entity_id)] = action
        for action in final_actions.values():
            _queue_for_action(session, action)
        # The after-commit hook must run only for the transaction that
        # actually created workflow messages. Delivery itself commits status
        # changes too, and must never recursively spawn more delivery threads.
        session.info["email_notifications_created"] = True
    finally:
        session.info.pop("email_notification_listener", None)


def _after_commit(session: SASession) -> None:
    if session.info.pop("email_notifications_created", False) and _enabled():
        deliver_pending_async()


def deliver_pending_async() -> None:
    """Wake an outbox worker without delaying the completed API request."""
    threading.Thread(target=deliver_pending, name="email-outbox", daemon=True).start()


def start_outbox_poller() -> None:
    """Retry delayed outbox items even when no later workflow action occurs."""
    global _poller_started
    if _poller_started:
        return
    _poller_started = True

    def _poll() -> None:
        while _enabled():
            try:
                deliver_pending()
            except Exception:
                logger.exception("Email outbox retry poll failed")
            time.sleep(60)

    threading.Thread(target=_poll, name="email-outbox-poller", daemon=True).start()


def _after_rollback(session: SASession) -> None:
    session.info.pop("email_notifications_created", None)


def install_outbox_listener() -> None:
    global _listener_installed
    if _listener_installed:
        return
    event.listen(SASession, "before_commit", _before_commit)
    event.listen(SASession, "after_commit", _after_commit)
    event.listen(SASession, "after_rollback", _after_rollback)
    _listener_installed = True


def _send(notification: models.EmailNotification) -> None:
    settings = _smtp_settings()
    message = EmailMessage()
    message["Subject"] = notification.subject
    message["From"] = f'{settings["from_name"]} <{settings["from_address"]}>'
    message["To"] = notification.recipient_email
    message.set_content(notification.body)
    if notification.html_body:
        message.add_alternative(notification.html_body, subtype="html")
    smtp_class = smtplib.SMTP_SSL if settings["ssl"] else smtplib.SMTP
    with smtp_class(settings["host"], settings["port"], timeout=settings["timeout"]) as client:
        if settings["starttls"]:
            client.starttls()
        if settings["username"]:
            client.login(settings["username"], settings["password"])
        client.send_message(message)


def deliver_pending(limit: int = 20) -> int:
    ready, reason = smtp_readiness()
    if not ready:
        logger.debug("Email outbox delivery skipped: %s", reason)
        return 0
    now = models.now()
    db = SessionLocal()
    delivered = 0
    try:
        candidates = db.query(models.EmailNotification).filter(
            or_(
                models.EmailNotification.status == "PENDING",
                (models.EmailNotification.status == "RETRY") & (models.EmailNotification.next_attempt_at <= now),
                (models.EmailNotification.status == "SENDING") & (models.EmailNotification.last_attempt_at < now - datetime.timedelta(minutes=15)),
            )
        ).order_by(models.EmailNotification.created_at).limit(limit).all()
        for notification in candidates:
            # Claim atomically. Several Uvicorn workers can wake up for the
            # same outbox, but only one may hand this item to the SMTP relay.
            claim = db.query(models.EmailNotification).filter(
                models.EmailNotification.id == notification.id,
                models.EmailNotification.status == notification.status,
            )
            if notification.status == "RETRY":
                claim = claim.filter(models.EmailNotification.next_attempt_at <= now)
            elif notification.status == "SENDING":
                claim = claim.filter(models.EmailNotification.last_attempt_at < now - datetime.timedelta(minutes=15))
            claimed = claim.update({
                models.EmailNotification.status: "SENDING",
                models.EmailNotification.attempts: models.EmailNotification.attempts + 1,
                models.EmailNotification.last_attempt_at: now,
            }, synchronize_session=False)
            db.commit()
            if not claimed:
                continue
            db.expire_all()
            notification = db.get(models.EmailNotification, notification.id)
            try:
                _send(notification)
                notification.status = "SENT"; notification.sent_at = models.now(); notification.last_error = None
                delivered += 1
            except Exception as exc:
                notification.last_error = str(exc)[:2000]
                if notification.attempts >= _MAX_ATTEMPTS:
                    notification.status = "FAILED"
                else:
                    notification.status = "RETRY"
                    notification.next_attempt_at = models.now() + datetime.timedelta(minutes=2 ** notification.attempts)
                logger.warning("Email delivery failed for outbox item %s: %s", notification.id, exc)
            db.commit()
        return delivered
    finally:
        db.close()
