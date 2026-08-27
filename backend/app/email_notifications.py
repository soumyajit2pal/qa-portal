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
from email.message import EmailMessage

from sqlalchemy import event, or_
from sqlalchemy.orm import Session as SASession, joinedload

from . import models
from .constants import QA_DEPARTMENT, Role
from .database import SessionLocal

logger = logging.getLogger("qa_portal.email")
_listener_installed = False
_poller_started = False
_MAX_ATTEMPTS = 5


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


def _target_user_ids(target) -> set[int]:
    if not target:
        return set()
    ids = set()
    for field in (
        "requester_id", "created_by_id", "owner_id", "qa_lead_id", "security_lead_id",
        "engineer_id", "reviewed_by_id", "approved_by_id", "sm_id", "dept_head_id",
        "security_id", "reporter_id", "assignee_id", "retest_tester_id",
        "default_reviewer_id", "default_qa_lead_id", "pending_requested_by_id",
    ):
        value = getattr(target, field, None)
        if value:
            ids.add(value)
    for raw in (getattr(target, "assigned_tester_ids", None) or "").split(","):
        try:
            ids.add(int(raw.strip()))
        except (TypeError, ValueError):
            pass
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
        if status in {"IN REVIEW", "RECOMMENDATION PENDING"}:
            return {Role.QA_ENGINEER}
        if status in {"REVIEW COMPLETED", "QA LEAD APPROVAL PENDING"}:
            return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if status == "SM_APPROVAL_PENDING":
        return {Role.SM}
    if status == "DEPARTMENT_HEAD_APPROVAL_PENDING":
        return {Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM}
    if status in {"QA_LEAD_ASSIGNED", "READINESS_VERIFICATION", "ENGINEER_ASSIGNED", "READINESS"}:
        return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if status in {"SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS", "SECURITY_TEAM_VERIFICATION"}:
        return {Role.SECURITY_ANALYST, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
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


def _route(action: models.ApprovalAction) -> str:
    routes = {
        "QA_REQUEST": "/qa-requests", "FUNCTIONAL_REQUEST": "/functional-requests",
        "SAST": "/sast", "DAST": "/dast", "PERFORMANCE": "/performance",
        "SUPPRESSION": "/suppression", "SIGNOFF": "/signoff", "DEFECT": "/defects",
        "TEST_PROJECT": "/test-projects", "TEST_CASE": "/test-repository",
    }
    return routes.get(action.entity_type, "/approvals")


def _queue_for_action(db: SASession, action: models.ApprovalAction) -> None:
    # Before SMTP is deliberately enabled, do not accumulate weeks of stale
    # workflow mail that would surprise users on the first activation.
    if not _enabled():
        return
    if getattr(action, "_email_notifications_queued", False):
        return
    action._email_notifications_queued = True
    target = _target(action, db)
    recipient_ids = _target_user_ids(target)
    approver_department = QA_DEPARTMENT if isinstance(target, models.TestCase) else _department(target)
    recipient_ids.update(_role_user_ids(db, _next_approver_roles(target), approver_department))
    recipient_ids.discard(action.actor_id)
    if not recipient_ids:
        return
    users = db.query(models.User).filter(models.User.id.in_(recipient_ids), models.User.is_active == True).all()  # noqa: E712
    portal_url = os.getenv("PORTAL_BASE_URL", "").rstrip("/")
    url = f"{portal_url}{_route(action)}" if portal_url else _route(action)
    subject = f"QA Portal: {action.step_name or 'Workflow'} — {action.decision or 'Updated'}"
    body = (
        f"A QA Portal workflow item has been updated.\n\n"
        f"Type: {action.entity_type.replace('_', ' ')}\nRecord: #{action.entity_id}\n"
        f"Step: {action.step_name or '—'}\nDecision: {action.decision or '—'}\n"
        f"Comments: {action.comments or '—'}\n\nOpen QA Portal: {url}\n"
    )
    for user in users:
        email = (user.email or "").strip()
        if email:
            db.add(models.EmailNotification(
                # `action` is new at before_commit time, so its Oracle
                # identity value is still None.  The relationship makes
                # SQLAlchemy insert the ApprovalAction first, then binds the
                # generated ID into this mandatory FK during the same flush.
                approval_action=action, recipient_email=email, subject=subject, body=body,
            ))


def _before_commit(session: SASession) -> None:
    if session.info.get("email_notification_listener"):
        return
    actions = [item for item in session.new if isinstance(item, models.ApprovalAction)]
    if not actions:
        return
    session.info["email_notification_listener"] = True
    try:
        for action in actions:
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
