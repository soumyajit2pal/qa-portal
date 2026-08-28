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
_EMAIL_TEMPLATE_MARKER = "qa-portal-email-template:v1"


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


def _html_email(title: str, subtitle: str, instruction: str, *,
                status: str | None, panel_title: str, panel_html: str,
                action_label: str, action_url: str,
                footer: str | None = None) -> str:
    """Render the one approved QA Portal mail design.

    This is deliberately the exact Test Case digest structure: teal header,
    title, instruction, status line, one pale detail panel and one teal
    action button.  Every notification calls this renderer; no email type is
    allowed to introduce a separate table/card/layout. ``panel_html`` is
    built from escaped values at each call site.
    """
    footer = footer or "This is an automated QA Portal workflow notification."
    status_html = ""
    if status:
        status_html = (
            '<p style="margin:0 0 10px;color:#627981;font-size:13px">Current status</p>'
            f'<p style="margin:0 0 18px;font-weight:600">{escape(status)}</p>'
        )
    return f"""<!doctype html><!-- {_EMAIL_TEMPLATE_MARKER} --><html><body style=\"margin:0;background:#f3f7f8;font-family:Arial,sans-serif;color:#19333b\">
<div style=\"max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #dce7e9;border-radius:12px;overflow:hidden\">
  <div style=\"padding:20px 28px;background:#0d6678;color:#ffffff\"><strong style=\"font-size:18px;letter-spacing:.3px\">QA Portal</strong><div style=\"margin-top:5px;font-size:12px;opacity:.88\">{escape(subtitle)}</div></div>
  <div style=\"padding:26px 28px\"><h1 style=\"margin:0 0 10px;font-size:22px;color:#173d49\">{escape(title)}</h1>
    <p style=\"margin:0 0 18px;font-size:15px;line-height:1.55\">{escape(instruction)}</p>
    {status_html}
    <div style=\"margin:18px 0;padding:12px 14px;background:#f5f8f9;border-left:3px solid #0d6678;font-size:13px;line-height:1.5\"><strong>{escape(panel_title)}</strong>{panel_html}</div>
    <a href=\"{escape(action_url, quote=True)}\" style=\"display:inline-block;padding:12px 18px;background:#0d6678;color:#ffffff;text-decoration:none;border-radius:7px;font-weight:bold\">{escape(action_label)}</a>
  </div>
  <div style=\"padding:14px 28px;background:#f7fafb;color:#71858c;font-size:11px\">{escape(footer)}</div>
</div></body></html>"""


def _legacy_html_email(notification: models.EmailNotification) -> str:
    """Bring pre-template outbox rows into the approved layout at send time.

    Queue records survive deployments.  Some rows already in Oracle can have
    no HTML body or an older visual design; retaining that stored HTML would
    make the notification system look inconsistent after the shared template
    is introduced.  Plain text remains the source of truth for those rows
    and is presented in the same single-panel QA Portal design.
    """
    body = (notification.body or "No additional details were recorded.").strip()
    action_url = ""
    detail_lines = []
    for line in body.splitlines():
        label, separator, value = line.partition(":")
        if separator and label.strip().lower() in {"open item", "open test repository", "review access"}:
            action_url = value.strip()
            continue
        detail_lines.append(line)
    portal_url = os.getenv("PORTAL_BASE_URL", "").rstrip("/")
    if action_url.startswith("/") and portal_url:
        action_url = f"{portal_url}{action_url}"
    if not action_url:
        action_url = portal_url or "/"
    detail_html = escape("\n".join(detail_lines)).replace("\n", "<br>")
    return _html_email(
        "QA Portal notification", "Workflow update",
        "Open the portal to review this notification and take any required action.",
        status=None, panel_title="Notification details",
        panel_html=f"<p style=\"margin:8px 0 0\">{detail_html}</p>",
        action_label="Open in QA Portal", action_url=action_url,
    )


def _recipient_key(action: models.ApprovalAction, recipient_email: str) -> tuple[str, str]:
    """Return a transaction-local key for the outbox's unique pair.

    An ``ApprovalAction`` normally has no database identity while the
    before-commit listener is assembling its notifications.  The Python
    object identity is therefore the only stable key until the action has
    been flushed.  Once it has an ID, use that ID so an existing persisted
    outbox row is also recognised.
    """
    action_key = f"id:{action.id}" if action.id is not None else f"pending:{id(action)}"
    return action_key, recipient_email.strip()


def _is_notification_already_queued(
    db: SASession, action: models.ApprovalAction, recipient_email: str, category: str,
) -> bool:
    """Protect the outbox's one-action/one-recipient invariant before flush.

    The unique constraint remains the final database safeguard.  This helper
    handles the expected duplicate paths *before* SQLAlchemy flushes: a
    repeated listener evaluation, duplicate users with the same mailbox, or
    an action which already has a durable outbox row after an earlier retry.
    It deliberately uses ``no_autoflush`` for the durable-row check, so the
    check itself cannot cause a pending duplicate to turn into a 500.
    """
    recipient_email = recipient_email.strip()
    key = _recipient_key(action, recipient_email)
    reserved = db.info.setdefault("email_notification_recipient_keys", set())
    if key in reserved:
        logger.info(
            "SMTP notification queue skipped category=%s recipient=%s approval_action_id=%s reason=duplicate_recipient",
            category, recipient_email, action.id,
        )
        return True

    # Include flushed rows remembered by the listener as well as current
    # pending rows.  The relationship comparison covers new parent actions;
    # the FK comparison covers already-flushed parent actions.
    candidates = list(db.info.get("email_notification_outbox", [])) + list(db.new)
    for notification in candidates:
        if not isinstance(notification, models.EmailNotification):
            continue
        same_parent = notification.approval_action is action
        if action.id is not None and notification.approval_action_id == action.id:
            same_parent = True
        if same_parent and (notification.recipient_email or "").strip() == recipient_email:
            reserved.add(key)
            logger.info(
                "SMTP notification queue skipped category=%s recipient=%s approval_action_id=%s reason=duplicate_recipient",
                category, recipient_email, action.id,
            )
            return True

    # A completed/retried request can encounter an action which already has
    # its notification stored.  Never enqueue that exact action-recipient
    # pair a second time.  This is also important after a rolling deployment
    # where an in-flight request may be evaluated by two application workers.
    if action.id is not None:
        with db.no_autoflush:
            existing = db.query(models.EmailNotification.id).filter(
                models.EmailNotification.approval_action_id == action.id,
                models.EmailNotification.recipient_email == recipient_email,
            ).first()
        if existing:
            reserved.add(key)
            logger.info(
                "SMTP notification queue skipped category=%s recipient=%s approval_action_id=%s reason=already_persisted",
                category, recipient_email, action.id,
            )
            return True

    reserved.add(key)
    return False


def _queue_email_notification(
    db: SASession, action: models.ApprovalAction, recipient_email: str, *,
    subject: str, body: str, html_body: str | None, category: str,
) -> bool:
    """Add an idempotent durable outbox row and report whether it was added."""
    recipient_email = recipient_email.strip()
    if not recipient_email or _is_notification_already_queued(db, action, recipient_email, category):
        return False
    db.add(models.EmailNotification(
        approval_action=action,
        recipient_email=recipient_email,
        subject=subject,
        body=body,
        html_body=html_body,
    ))
    return True


def queue_access_review_notifications(db: SASession, user: models.User) -> int:
    """Queue one access-review email for each active Administrator.

    Account-access review is a real approval event but not a business-request
    workflow, so it deliberately uses its own `USER_ACCESS` action rather
    than pretending it belongs to a QA request.  The action also keeps the
    email outbox's mandatory foreign key and duplicate protection intact.
    Like workflow mail, this queues only when SMTP is enabled, preventing a
    surprise backlog from being sent weeks after a relay is configured.
    """
    if not _enabled():
        logger.info("SMTP access-review notification skipped user=%s reason=smtp_disabled", user.username)
        return 0
    admins = (
        db.query(models.User)
        .join(models.UserRole)
        .filter(
            models.User.is_active == True,  # noqa: E712
            models.UserRole.role == Role.ADMIN,
        )
        .all()
    )
    recipients = [admin for admin in admins if (admin.email or "").strip()]
    if not recipients:
        logger.warning("SMTP access-review notification skipped user=%s reason=no_active_admin_recipient", user.username)
        return 0

    department = user.primary_department or user.department or "Other"
    portal_url = os.getenv("PORTAL_BASE_URL", "").rstrip("/")
    path = "/admin"
    url = f"{portal_url}{path}" if portal_url else path
    subject = f"Access review required: {user.full_name} ({user.username})"
    body = (
        "QA PORTAL ACCESS REVIEW REQUIRED\n\n"
        "A newly provisioned LDAP account requires access review.\n\n"
        f"User: {user.full_name}\nUsername: {user.username}\n"
        f"Department: {department}\n"
        f"Current role(s): {', '.join(user.roles) or 'No portal role assigned'}\n\n"
        f"Review access: {url}\n"
    )
    html_body = _html_email(
        "New LDAP access request", "Access review required",
        "Review this account and assign the appropriate portal role.",
        status="Access review pending", panel_title="Access request",
        panel_html=(
            f"<ul style=\"margin:8px 0 0;padding-left:20px\"><li>User: {escape(user.full_name)}</li>"
            f"<li>Username: {escape(user.username)}</li><li>Department: {escape(department)}</li>"
            f"<li>Current role(s): {escape(', '.join(user.roles) or 'No portal role assigned')}</li></ul>"
        ),
        action_label="Review in QA Portal", action_url=url,
        footer="This is an automated QA Portal access-management notification.",
    )
    action = models.ApprovalAction(
        entity_type="USER_ACCESS",
        entity_id=user.id,
        step_name="Access review",
        actor_id=user.id,
        actor_role=user.roles_csv,
        decision="Access review requested",
        comments=f"New LDAP account mapped to {department}.",
    )
    db.add(action)
    queued_count = 0
    for admin in recipients:
        email = admin.email.strip()
        if _queue_email_notification(
            db, action, email, subject=subject, body=body, html_body=html_body,
            category="access_review",
        ):
            queued_count += 1
            logger.info("SMTP notification queued category=access_review recipient=%s user=%s", email, user.username)
    return queued_count


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
    if status in {
        "QA_LEAD_ASSIGNED", "READINESS_VERIFICATION", "QA_ACTIVITY_INITIATED",
        "PLANNING", "QA_COMPLETED", "QA_SIGNOFF_PENDING", "ENGINEER_ASSIGNED",
        "READINESS", "FEASIBILITY", "RESULT_ANALYSIS", "REPORT", "SIGNOFF_PENDING",
    }:
        return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if status in {"SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS"}:
        return {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA}
    if status in {
        "TESTER_ASSIGNED", "TEST_DESIGN", "EXECUTION_IN_PROGRESS", "RETESTING",
    }:
        return {Role.QA_ENGINEER}
    if status in {
        "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION",
        "ASSIGNED_TO_LEAD", "RESCAN", "SECURITY_COMPLETE", "REPORT_READY",
        "SECURITY_TEAM_VERIFICATION",
    }:
        return {Role.SECURITY_ANALYST}
    if status in {"ENVIRONMENT_SETUP", "SCRIPT_DEVELOPMENT", "BASELINE", "LOAD_TEST_EXECUTION"}:
        return {Role.QA_ENGINEER}
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


def _user_ids(value) -> set[int]:
    """Return a safe, de-duplicated set from a persisted assignee field.

    Functional and Performance keep their tester assignment as a compact
    comma-separated value for compatibility with the existing schema.  Do
    not let a malformed legacy value prevent the rest of the group from being
    notified; only valid positive integer IDs are meaningful here.
    """
    if value is None:
        return set()
    if isinstance(value, str):
        values = value.split(",")
    elif isinstance(value, (tuple, list, set)):
        values = value
    else:
        values = [value]
    ids = set()
    for item in values:
        try:
            user_id = int(item)
        except (TypeError, ValueError):
            continue
        if user_id > 0:
            ids.add(user_id)
    return ids


def _assigned_user_route(target) -> NotificationRoute | None:
    """Return the named current owner when the workflow has one.

    A role group owns an item only while no person has been selected.  Once a
    QA Lead assigns an analyst/tester (or a reviewer/defect assignee is
    explicitly recorded), sending the next action-required email to the
    whole group is both noisy and ambiguous.  This resolver is intentionally
    stage-aware: a historical assignment does not override a later stage
    that is back with the requester or QA Lead group.
    """
    status = str(getattr(target, "status", "") or "").upper()

    if isinstance(target, models.FunctionalRequest) and status in {
        "TESTER_ASSIGNED", "TEST_DESIGN", "EXECUTION_IN_PROGRESS", "RETESTING",
    }:
        recipients = _user_ids(target.assigned_tester_ids)
        if recipients:
            return NotificationRoute(
                recipients, "Assigned QA Tester", True,
                "You have been assigned QA work on this request. Open the record to continue the workflow.",
            )

    if isinstance(target, models.PerformanceRequest) and status in {
        "ENVIRONMENT_SETUP", "SCRIPT_DEVELOPMENT", "BASELINE",
        "LOAD_TEST_EXECUTION",
    }:
        recipients = _user_ids(target.assigned_tester_ids)
        if recipients:
            return NotificationRoute(
                recipients, "Assigned QA Tester", True,
                "You have been assigned performance-testing work. Open the record to continue the workflow.",
            )

    if isinstance(target, (models.SASTRequest, models.DASTRequest)) and status in {
        "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION",
        "ASSIGNED_TO_LEAD", "RESCAN", "SECURITY_COMPLETE", "REPORT_READY",
    }:
        recipients = _user_ids(target.security_analyst_id)
        if recipients:
            return NotificationRoute(
                recipients, "Assigned Security Analyst", True,
                "You have been assigned security-testing work. Open the record to continue the workflow.",
            )

    if isinstance(target, models.TestCase):
        draft = target.current_draft_version
        if draft and status == "IN REVIEW":
            recipients = _user_ids(draft.assigned_reviewer_id)
            if recipients:
                return NotificationRoute(
                    recipients, "Assigned QA Reviewer", True,
                    "You have been assigned this test case for review.",
                )
        if draft and status == "REVIEW COMPLETED":
            recipients = _user_ids(draft.assigned_qa_lead_id)
            if recipients:
                return NotificationRoute(
                    recipients, "Assigned QA Lead", True,
                    "You have been assigned this test case for final QA approval.",
                )

    if isinstance(target, models.Defect) and status in {
        "ASSIGNED", "IN PROGRESS", "RESOLVED", "REOPENED", "DEFERRED",
    }:
        recipients = _user_ids(target.assignee_id)
        if recipients:
            return NotificationRoute(
                recipients, "Assigned Defect Owner", True,
                "You have been assigned this defect. Open the record to continue the workflow.",
            )
    if isinstance(target, models.Defect) and status == "RETEST":
        recipients = _user_ids(target.retest_tester_id)
        if recipients:
            return NotificationRoute(
                recipients, "Assigned QA Tester", True,
                "This defect is ready for your retest decision.",
            )
    return None


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
        "close", "cancel", "change", "request", "assign",
    ))


def _notification_route(db: SASession, action: models.ApprovalAction, target) -> NotificationRoute | None:
    """Route each workflow transition to its *next* responsible party.

    This deliberately does not copy every stakeholder on every message.
    For example, after a requester raises a request only the SM receives the
    action-required mail; after the SM approves it only the Department Head
    receives the next one. Returned work goes to the requester. This mirrors
    the Pending Approvals queue and prevents duplicate/noisy notifications.
    """
    reference = _portal_reference(action, target)
    if not target:
        logger.warning(
            "SMTP workflow notification skipped reference=%s entity_type=%s entity_id=%s reason=target_not_found",
            reference, action.entity_type, action.entity_id,
        )
        return None
    if not _is_workflow_transition(action):
        logger.info(
            "SMTP workflow notification skipped reference=%s status=%s decision=%s reason=non_workflow_action",
            reference, getattr(target, "status", None), action.decision or "",
        )
        return None

    assigned_route = _assigned_user_route(target)
    if assigned_route:
        logger.info(
            "SMTP workflow route evaluated reference=%s status=%s owner=individual eligible_recipient_count=%s",
            reference, getattr(target, "status", None), len(assigned_route.recipient_ids),
        )
        return assigned_route

    roles = _next_approver_roles(target)
    if roles:
        department = QA_DEPARTMENT if isinstance(target, models.TestCase) else _department(target)
        # The assigned group is the notification owner.  Department scope is
        # still enforced by the action endpoints themselves, but must not
        # suppress a group notification merely because a member's primary
        # department differs from the request.  That was the reason an
        # otherwise active SM group could receive no email at all.
        recipients = _role_user_ids(db, roles, None)
        logger.info(
            "SMTP workflow route evaluated reference=%s status=%s owner=group roles=%s request_department=%s eligible_recipient_count=%s",
            reference, getattr(target, "status", None), ",".join(sorted(roles)), department or "<any>", len(recipients),
        )
        if recipients:
            label = _role_label(roles)
            return NotificationRoute(
                recipients, label, True,
                f"Your {label} review is required before this workflow can continue.",
            )
        logger.warning(
            "SMTP workflow notification skipped reference=%s status=%s reason=no_active_recipient_for_role roles=%s department=%s",
            reference, getattr(target, "status", None), ",".join(sorted(roles)), department or "<any>",
        )

    status = str(getattr(target, "status", "") or "").upper()
    requester_ids = _requester_user_ids(target)
    if not requester_ids:
        logger.info(
            "SMTP workflow notification skipped reference=%s status=%s reason=no_recipient_route",
            reference, status,
        )
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


def _queue_for_action(db: SASession, action: models.ApprovalAction) -> int:
    # Before SMTP is deliberately enabled, do not accumulate weeks of stale
    # workflow mail that would surprise users on the first activation.
    if not _enabled():
        logger.info(
            "SMTP workflow notification skipped entity_type=%s entity_id=%s reason=smtp_disabled",
            action.entity_type, action.entity_id,
        )
        return 0
    if getattr(action, "_email_notifications_queued", False):
        logger.info(
            "SMTP workflow notification skipped entity_type=%s entity_id=%s reason=already_evaluated",
            action.entity_type, action.entity_id,
        )
        return 0
    action._email_notifications_queued = True
    target = _target(action, db)
    logger.info(
        "SMTP workflow action evaluating entity_type=%s entity_id=%s step=%s decision=%s target_status=%s",
        action.entity_type, action.entity_id, action.step_name or "<none>", action.decision or "<none>",
        getattr(target, "status", None) if target else "<target_not_found>",
    )
    route = _notification_route(db, action, target)
    if not route:
        return 0
    reference = _portal_reference(action, target)
    recipient_ids = route.recipient_ids - {action.actor_id}
    if not recipient_ids:
        logger.info(
            "SMTP workflow notification skipped reference=%s reason=actor_is_only_recipient actor_id=%s",
            reference, action.actor_id,
        )
        return 0
    users = db.query(models.User).filter(models.User.id.in_(recipient_ids), models.User.is_active == True).all()  # noqa: E712
    portal_url = os.getenv("PORTAL_BASE_URL", "").rstrip("/")
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
    html_body = _html_email(
        reference, 'Action required' if route.action_required else 'Workflow update', route.instruction,
        status=status, panel_title="Workflow details",
        panel_html=(
            f"<ul style=\"margin:8px 0 0;padding-left:20px\"><li>Type: {escape(type_label)}</li>"
            f"<li>Latest action: {escape(action.step_name or 'Workflow')} — {escape(action.decision or 'Updated')}</li>"
            f"<li>Comments: {escape(action.comments or 'No comments provided.').replace(chr(10), '<br>')}</li></ul>"
        ),
        action_label="Open in QA Portal", action_url=url,
    )
    queued_count = 0
    deliverable_recipient_count = 0
    missing_email_users = []
    for user in users:
        email = (user.email or "").strip()
        if email:
            deliverable_recipient_count += 1
            if _queue_email_notification(
                db, action, email, subject=subject, body=body, html_body=html_body,
                category="workflow",
            ):
                queued_count += 1
                logger.info("SMTP notification queued category=workflow recipient=%s reference=%s action=%s", email, reference, action.decision or "Updated")
        else:
            missing_email_users.append(user.username)
    if missing_email_users:
        logger.warning(
            "SMTP workflow notification recipient skipped reference=%s reason=missing_email users=%s",
            reference, ",".join(missing_email_users),
        )
    if not queued_count:
        if deliverable_recipient_count:
            logger.info(
                "SMTP workflow notification not queued reference=%s reason=all_deliverable_recipients_already_queued resolved_recipient_count=%s",
                reference, len(recipient_ids),
            )
        else:
            logger.warning(
                "SMTP workflow notification not queued reference=%s reason=no_deliverable_recipient resolved_recipient_count=%s",
                reference, len(recipient_ids),
            )
    return queued_count


def _queue_test_case_digests(db: SASession, actions: list[models.ApprovalAction]) -> int:
    """Create one summary email per recipient/stage for a test-case batch.

    Test cases are routinely submitted, recommended, or approved in bulk.
    Sending a separate email for every row turns a useful notification into
    mailbox noise, so all records from the same transaction and workflow
    checkpoint are presented as one actionable summary instead.
    """
    if actions and not _enabled():
        logger.info("SMTP test-case digest skipped action_count=%s reason=smtp_disabled", len(actions))
        return 0
    groups: dict[tuple[int, str, bool, str], list[tuple[models.ApprovalAction, object, NotificationRoute]]] = {}
    for action in actions:
        if getattr(action, "_email_notifications_queued", False):
            continue
        action._email_notifications_queued = True
        target = _target(action, db)
        route = _notification_route(db, action, target)
        if not route:
            continue
        status = _status_label(getattr(target, "status", None))
        for recipient_id in route.recipient_ids - {action.actor_id}:
            key = (recipient_id, route.recipient_label, route.action_required, status)
            groups.setdefault(key, []).append((action, target, route))

    portal_url = os.getenv("PORTAL_BASE_URL", "").rstrip("/")
    queued_count = 0
    for (recipient_id, label, action_required, status), entries in groups.items():
        user = db.get(models.User, recipient_id)
        email = (user.email or "").strip() if user else ""
        if not email:
            logger.warning(
                "SMTP test-case digest recipient skipped recipient_id=%s reason=missing_or_inactive_email",
                recipient_id,
            )
            continue
        first_action, _, route = entries[0]
        references = list(dict.fromkeys(_portal_reference(action, target) for action, target, _ in entries))
        shown_references = references[:20]
        remaining = len(references) - len(shown_references)
        type_label = "Test Case" if len(references) == 1 else "Test Cases"
        subject = f"{'Action required' if action_required else 'Workflow update'}: {len(references)} {type_label} — {label}"
        url_path = _route(first_action)
        url = f"{portal_url}{url_path}" if portal_url else url_path
        item_lines = "\n".join(f"• {reference}" for reference in shown_references)
        if remaining:
            item_lines += f"\n• and {remaining} more"
        body = (
            f"QA PORTAL {'ACTION REQUIRED' if action_required else 'WORKFLOW UPDATE'}\n\n"
            f"{route.instruction}\n\n"
            f"{len(references)} {type_label.lower()} are now at: {status}\n\n"
            f"Items:\n{item_lines}\n\n"
            f"Open Test Repository: {url}\n"
        )
        html_items = "".join(f"<li style=\"margin:4px 0\">{escape(reference)}</li>" for reference in shown_references)
        if remaining:
            html_items += f"<li style=\"margin:4px 0\">and {remaining} more</li>"
        html_body = _html_email(
            f"{len(references)} {type_label}",
            f"{'Action required' if action_required else 'Workflow update'} · Test case summary",
            route.instruction, status=status, panel_title="Test cases",
            panel_html=f"<ul style=\"margin:8px 0 0;padding-left:20px\">{html_items}</ul>",
            action_label="Open Test Repository", action_url=url,
        )
        if _queue_email_notification(
            db, first_action, email, subject=subject, body=body, html_body=html_body,
            category="test_case_digest",
        ):
            queued_count += 1
            logger.info("SMTP notification queued category=test_case_digest recipient=%s count=%s", email, len(references))
    return queued_count


def _before_flush(session: SASession, flush_context, instances) -> None:
    """Remember workflow actions that an endpoint flushes before commit.

    Several creation flows need generated child IDs and call ``db.flush()``
    before their final ``db.commit()``. SQLAlchemy removes flushed audit and
    outbox rows from ``session.new``; retaining both collections keeps
    routing, delivery triggering, and recipient-count logs accurate for the
    entire transaction. This notably covers child SM Approval Pending rows
    created while raising a QA Request.
    """
    tracked = session.info.setdefault("email_notification_actions", [])
    known = {id(action) for action in tracked}
    for action in session.new:
        if isinstance(action, models.ApprovalAction) and id(action) not in known:
            tracked.append(action)
            known.add(id(action))
    tracked_outbox = session.info.setdefault("email_notification_outbox", [])
    known_outbox = {id(notification) for notification in tracked_outbox}
    for notification in session.new:
        if isinstance(notification, models.EmailNotification) and id(notification) not in known_outbox:
            tracked_outbox.append(notification)
            known_outbox.add(id(notification))


def _before_commit(session: SASession) -> None:
    if session.info.get("email_notification_listener"):
        return
    actions = list(session.info.get("email_notification_actions", []))
    known = {id(action) for action in actions}
    for item in session.new:
        if isinstance(item, models.ApprovalAction) and id(item) not in known:
            actions.append(item)
            known.add(id(item))
    if not actions:
        return
    session.info["email_notification_listener"] = True
    try:
        tracked_outbox = list(session.info.get("email_notification_outbox", []))
        known_outbox = {id(notification) for notification in tracked_outbox}
        for item in session.new:
            if isinstance(item, models.EmailNotification) and id(item) not in known_outbox:
                tracked_outbox.append(item)
                known_outbox.add(id(item))
        preexisting_outbox_count = len(tracked_outbox)
        # A single endpoint can log several history rows while moving one
        # record through intermediate states (e.g. Submitted then SM
        # Approval Pending). Route only the final row for that record, based
        # on its final status, so the next approver receives one precise
        # notification instead of duplicates.
        final_actions = {}
        for action in actions:
            final_actions[(action.entity_type, action.entity_id)] = action
        logger.info(
            "SMTP workflow evaluation started approval_action_count=%s final_action_count=%s smtp_enabled=%s actions=%s",
            len(actions), len(final_actions), _enabled(),
            "; ".join(
                f"{action.entity_type}:{action.entity_id}:{action.step_name or '-'}:{action.decision or '-'}"
                for action in final_actions.values()
            ),
        )
        test_case_actions = [action for action in final_actions.values() if action.entity_type == "TEST_CASE"]
        routed_outbox_count = _queue_test_case_digests(session, test_case_actions)
        for action in final_actions.values():
            if action.entity_type == "TEST_CASE":
                continue
            routed_outbox_count += _queue_for_action(session, action)
        # The after-commit hook must run only for the transaction that
        # actually created workflow messages. Delivery itself commits status
        # changes too, and must never recursively spawn more delivery threads.
        tracked_outbox = list(session.info.get("email_notification_outbox", []))
        known_outbox = {id(notification) for notification in tracked_outbox}
        for item in session.new:
            if isinstance(item, models.EmailNotification) and id(item) not in known_outbox:
                tracked_outbox.append(item)
                known_outbox.add(id(item))
        outbox_count = len(tracked_outbox)
        if outbox_count:
            session.info["email_notifications_created"] = True
            logger.info(
                "SMTP workflow evaluation completed routed_outbox_count=%s direct_outbox_count=%s total_outbox_count=%s",
                routed_outbox_count, preexisting_outbox_count, outbox_count,
            )
        else:
            logger.warning(
                "SMTP workflow evaluation completed routed_outbox_count=0 total_outbox_count=0 reason=no_notification_created",
            )
    finally:
        session.info.pop("email_notification_listener", None)


def _after_commit(session: SASession) -> None:
    session.info.pop("email_notification_actions", None)
    session.info.pop("email_notification_outbox", None)
    session.info.pop("email_notification_recipient_keys", None)
    if not session.info.pop("email_notifications_created", False):
        return
    if _enabled():
        logger.info("SMTP outbox delivery trigger scheduled after workflow evaluation")
        deliver_pending_async()
    else:
        logger.info("SMTP outbox delivery trigger skipped reason=smtp_disabled")


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
    session.info.pop("email_notification_actions", None)
    session.info.pop("email_notification_outbox", None)
    session.info.pop("email_notification_recipient_keys", None)
    session.info.pop("email_notifications_created", None)


def install_outbox_listener() -> None:
    global _listener_installed
    if _listener_installed:
        return
    event.listen(SASession, "before_flush", _before_flush)
    event.listen(SASession, "before_commit", _before_commit)
    event.listen(SASession, "after_commit", _after_commit)
    event.listen(SASession, "after_rollback", _after_rollback)
    _listener_installed = True


def _send(notification: models.EmailNotification) -> None:
    settings = _smtp_settings()
    logger.info("SMTP notification sending id=%s recipient=%s approval_action_id=%s subject=%s", notification.id, notification.recipient_email, notification.approval_action_id, notification.subject)
    message = EmailMessage()
    message["Subject"] = notification.subject
    message["From"] = f'{settings["from_name"]} <{settings["from_address"]}>'
    message["To"] = notification.recipient_email
    message.set_content(notification.body)
    html_body = notification.html_body
    if _EMAIL_TEMPLATE_MARKER not in (html_body or ""):
        html_body = _legacy_html_email(notification)
        # Persist the normalized template with the delivery outcome, so later
        # retry attempts do not need to render a legacy message again.
        notification.html_body = html_body
        logger.info(
            "SMTP notification template normalized id=%s recipient=%s approval_action_id=%s",
            notification.id, notification.recipient_email, notification.approval_action_id,
        )
    message.add_alternative(html_body, subtype="html")
    smtp_class = smtplib.SMTP_SSL if settings["ssl"] else smtplib.SMTP
    with smtp_class(settings["host"], settings["port"], timeout=settings["timeout"]) as client:
        if settings["starttls"]:
            client.starttls()
        if settings["username"]:
            client.login(settings["username"], settings["password"])
        client.send_message(message)


def _candidate_notification_ids(now: datetime.datetime, limit: int) -> list[int]:
    """Read the batch once, then deliver every recipient in isolation."""
    db = SessionLocal()
    try:
        return [row.id for row in db.query(models.EmailNotification.id).filter(
            or_(
                models.EmailNotification.status == "PENDING",
                (models.EmailNotification.status == "RETRY") & (models.EmailNotification.next_attempt_at <= now),
                (models.EmailNotification.status == "SENDING") & (models.EmailNotification.last_attempt_at < now - datetime.timedelta(minutes=15)),
            )
        ).order_by(models.EmailNotification.created_at).limit(limit).all()]
    finally:
        db.close()


def _deliver_one(notification_id: int, now: datetime.datetime) -> bool:
    """Deliver one outbox row in its own database session/transaction.

    SMTP rejections and even an unexpected persistence error for one recipient
    must not prevent the rest of a notification batch from being delivered.
    """
    db = SessionLocal()
    try:
        notification = db.get(models.EmailNotification, notification_id)
        if not notification:
            return False
        original_status = notification.status
        if original_status not in {"PENDING", "RETRY", "SENDING"}:
            return False

        # Claim atomically. Several Uvicorn workers can wake up for the same
        # outbox row, but only one may hand this recipient to the SMTP relay.
        claim = db.query(models.EmailNotification).filter(
            models.EmailNotification.id == notification_id,
            models.EmailNotification.status == original_status,
        )
        if original_status == "RETRY":
            claim = claim.filter(models.EmailNotification.next_attempt_at <= now)
        elif original_status == "SENDING":
            claim = claim.filter(models.EmailNotification.last_attempt_at < now - datetime.timedelta(minutes=15))
        claimed = claim.update({
            models.EmailNotification.status: "SENDING",
            models.EmailNotification.attempts: models.EmailNotification.attempts + 1,
            models.EmailNotification.last_attempt_at: now,
        }, synchronize_session=False)
        db.commit()
        if not claimed:
            return False

        notification = db.get(models.EmailNotification, notification_id)
        try:
            _send(notification)
            notification.status = "SENT"
            notification.sent_at = models.now()
            notification.last_error = None
            db.commit()
            logger.info("SMTP notification sent id=%s recipient=%s approval_action_id=%s subject=%s", notification.id, notification.recipient_email, notification.approval_action_id, notification.subject)
            return True
        except Exception as exc:
            notification.last_error = str(exc)[:2000]
            if notification.attempts >= _MAX_ATTEMPTS:
                notification.status = "FAILED"
            else:
                notification.status = "RETRY"
                notification.next_attempt_at = models.now() + datetime.timedelta(minutes=2 ** notification.attempts)
            db.commit()
            logger.warning("SMTP notification failed id=%s recipient=%s approval_action_id=%s attempts=%s status=%s error=%s", notification_id, notification.recipient_email, notification.approval_action_id, notification.attempts, notification.status, exc)
            return False
    except Exception:
        db.rollback()
        logger.exception("Email delivery processing failed for outbox item %s", notification_id)
        return False
    finally:
        db.close()


def deliver_pending(limit: int = 20) -> int:
    ready, reason = smtp_readiness()
    if not ready:
        logger.warning("SMTP outbox delivery skipped reason=%s", reason)
        return 0
    now = models.now()
    # Do not let a bad mailbox, an SMTP refusal, or a transient DB error for
    # one recipient abort delivery for every other recipient in this batch.
    notification_ids = _candidate_notification_ids(now, limit)
    if not notification_ids:
        return 0
    logger.info("SMTP outbox delivery started batch_size=%s", len(notification_ids))
    delivered = sum(_deliver_one(notification_id, now) for notification_id in notification_ids)
    logger.info(
        "SMTP outbox delivery completed batch_size=%s delivered_count=%s unsuccessful_count=%s",
        len(notification_ids), delivered, len(notification_ids) - delivered,
    )
    return delivered
