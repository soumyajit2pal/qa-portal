"""2026-08 "Test Approval Workflow" refactor, section 10
(Test_Approval_Workflow_Requirements.docx) -- in-app notifications. No
email/SMTP infrastructure exists anywhere in this app (confirmed by a
repo-wide search before building this), so every event in the spec's
notification table is delivered as an in-app Notification row instead of an
email -- see models.Notification's own docstring for the reasoning.

Two things live in this module:
1. `fire()` -- a plain helper other routers call inline (not an HTTP
   endpoint) to create one Notification row per recipient, alongside
   whatever workflow action just happened. Callers add it to the SAME
   db session/transaction as the action itself (no separate commit here),
   matching this app's existing `_case_workflow_action`-style convention
   for ApprovalAction rows.
2. `sweep_overdue_approvals()` -- the reminder/escalation mechanism. This
   app has no background job scheduler (no Celery/cron, request-driven
   FastAPI only), so there is no true "check every N minutes" timer here.
   Instead this is called once at backend startup (main.py, same place/
   pattern as migrate_test_management_versioning) and is idempotent/cheap
   to call again -- each TestCaseVersion tracks its own
   reminder_sent_at/escalated_at so a re-run never double-fires for the
   same wait. This means the reminder/escalation clock effectively
   advances on every backend restart rather than continuously in real
   time -- an honest limitation of not having scheduler infrastructure to
   build on, flagged here and in the changelog rather than silently
   pretended away.
"""
import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, can_review_repository
from ..constants import Role, TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

REMINDER_DAYS_KEY = "test_approval_reminder_business_days"
ESCALATION_DAYS_KEY = "test_approval_escalation_business_days"
DEFAULT_REMINDER_DAYS = 2
DEFAULT_ESCALATION_DAYS = 5


def fire(db: Session, recipient_ids: List[Optional[int]], event_type: str, entity_type: str,
         entity_id: int, entity_key: Optional[str], message: str,
         actor_id: Optional[int] = None) -> None:
    """Creates one Notification per (deduplicated, non-null) recipient.
    Deliberately silent/no-op if recipient_ids ends up empty (e.g. a project
    with no default Reviewer/QA Lead configured yet and no per-item
    reassignment either) -- a missing notification target is a configuration
    gap for the project Owner to fill in, not something that should ever
    block the underlying workflow action itself."""
    seen = set()
    for recipient_id in recipient_ids:
        if not recipient_id or recipient_id in seen:
            continue
        seen.add(recipient_id)
        db.add(models.Notification(
            recipient_id=recipient_id, event_type=event_type, entity_type=entity_type,
            entity_id=entity_id, entity_key=entity_key, message=message, created_by_id=actor_id,
        ))


def _setting_int(db: Session, key: str, default: int) -> int:
    row = db.query(models.SystemSetting).filter_by(key=key).first()
    if not row:
        return default
    try:
        return int(row.value)
    except (TypeError, ValueError):
        return default


def _business_days_between(start: datetime.datetime, end: datetime.datetime) -> int:
    """Whole weekdays elapsed between two timestamps, Mon-Fri counted,
    Sat/Sun skipped -- no bank-holiday calendar exists anywhere in this app,
    so public holidays are not excluded. Flagged here rather than silently
    over-claiming holiday-awareness the spec's "business days" wording
    didn't actually require this app to already have."""
    if not start or not end:
        return 0
    # models.as_aware() -- see its own docstring; `start` (submitted_at/
    # reviewed_at, read back from the database) comes back naive on Oracle
    # while `end` (models.now(), passed in by sweep_overdue_approvals below)
    # is aware -- comparing them directly raised "can't compare offset-naive
    # and offset-aware datetimes" the first time a version had actually been
    # sitting in review long enough to trigger this on a real backend
    # startup sweep.
    start = models.as_aware(start)
    end = models.as_aware(end)
    if end <= start:
        return 0
    days = 0
    cursor = start.date()
    end_date = end.date()
    while cursor < end_date:
        cursor += datetime.timedelta(days=1)
        if cursor.weekday() < 5:  # Mon=0 .. Fri=4
            days += 1
    return days


def sweep_overdue_approvals(db: Session) -> int:
    """Section 10 "Reminder and escalation intervals... configurable by an
    Administrator. Default: one reminder after two business days and
    escalation after five business days." Walks every TestCaseVersion
    currently sitting at an in-flight review checkpoint -- both the OLD "Test
    Approval Workflow" (In Review / Review Completed) and the 2026-08
    "Simplified Test Management" NEW workflow (Recommendation Pending / QA
    Lead Approval Pending) that superseded it for every fresh submission
    (see ORACLE_MIGRATION_2026-07.md sections 60-62) -- fires a Reminder or
    Escalation notification to whoever it's currently assigned to once the
    relevant threshold is crossed, and stamps reminder_sent_at/escalated_at
    so it's never sent twice for the same wait. The NEW-path pair was missed
    when section 60 introduced it, which silently stopped reminders/
    escalations from ever firing for it since virtually all live submissions
    route to the NEW path now -- added here to close that gap. Returns how
    many notifications were created (logged by the caller, main.py, same
    convention as every other startup migration step)."""
    reminder_days = _setting_int(db, REMINDER_DAYS_KEY, DEFAULT_REMINDER_DAYS)
    escalation_days = _setting_int(db, ESCALATION_DAYS_KEY, DEFAULT_ESCALATION_DAYS)
    now = models.now()
    created = 0
    pending = (
        db.query(models.TestCaseVersion)
        .filter(models.TestCaseVersion.status.in_((
            "In Review", "Review Completed", "Recommendation Pending", "QA Lead Approval Pending",
        )))
        .all()
    )
    stage1_statuses = ("In Review", "Recommendation Pending")
    for draft in pending:
        case = draft.test_case
        if not case:
            continue
        stage_started = draft.submitted_at if draft.status in stage1_statuses else draft.reviewed_at
        if not stage_started:
            continue
        candidates = db.query(models.User).filter(
            # Oracle Boolean columns are NUMBER(1); use `= 1`, not `IS 1`.
            models.User.is_active == 1,
            models.User.department_assignments.any(
                models.UserDepartment.department.in_(TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS)
            ),
        ).all()
        if draft.status == "In Review":
            recipient_ids = [u.id for u in candidates if u.id != draft.author_id
                             and Role.QA_LEAD in set(u.roles)]
        elif draft.status == "Review Completed":
            recipient_ids = [u.id for u in candidates if u.id != draft.author_id
                             and set(u.roles).intersection({Role.CHIEF_MANAGER_QA, Role.AGM_QA})]
        elif draft.status == "Recommendation Pending":
            # NEW-path Stage 1 -- QA Group. GOV-002: also excludes whoever
            # submitted this draft, not just its original author (section 62).
            recipient_ids = [u.id for u in candidates if u.id != draft.author_id
                             and u.id != draft.submitted_by_id and Role.QA_ENGINEER in set(u.roles)]
        else:
            # NEW-path Stage 2 ("QA Lead Approval Pending") -- QA Lead Group.
            # GOV-002: also excludes the submitter and the Stage 1 reviewer.
            recipient_ids = [u.id for u in candidates if u.id != draft.author_id
                             and u.id not in (draft.submitted_by_id, draft.reviewed_by_id)
                             and set(u.roles).intersection({Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA})]
        if not recipient_ids:
            continue
        elapsed_bd = _business_days_between(stage_started, now)
        stage_label = {
            "In Review": "Reviewer recommendation",
            "Review Completed": "QA Lead final approval",
            "Recommendation Pending": "QA Group recommendation",
            "QA Lead Approval Pending": "QA Lead Group final approval",
        }[draft.status]
        if elapsed_bd >= escalation_days and not draft.escalated_at:
            fire(db, recipient_ids, "Escalated", "TEST_CASE", case.id, case.test_case_key,
                 f"Escalation: {case.test_case_key} has been awaiting {stage_label} for "
                 f"{elapsed_bd} business day(s).")
            draft.escalated_at = now
            created += len(recipient_ids)
        elif elapsed_bd >= reminder_days and not draft.reminder_sent_at:
            fire(db, recipient_ids, "Reminder", "TEST_CASE", case.id, case.test_case_key,
                 f"Reminder: {case.test_case_key} is awaiting {stage_label} "
                 f"({elapsed_bd} business day(s) so far).")
            draft.reminder_sent_at = now
            created += len(recipient_ids)
    if created:
        db.commit()
    return created


def sweep_overdue_defects(db: Session) -> int:
    """Create one in-app overdue alert when a governed defect passes its target date."""
    today = models.now().date()
    pending = (
        db.query(models.Defect)
        .filter(
            models.Defect.expected_resolution_date.isnot(None),
            models.Defect.expected_resolution_date < today,
            ~models.Defect.status.in_(("Closed", "Rejected", "Duplicate", "Not a Defect")),
        )
        .all()
    )
    created = 0
    for defect in pending:
        already_sent = db.query(models.Notification.id).filter_by(
            event_type="Defect Overdue", entity_type="DEFECT", entity_id=defect.id,
        ).first()
        if already_sent:
            continue
        recipient_ids = [defect.assignee_id, defect.reporter_id]
        if defect.cycle and defect.cycle.project:
            recipient_ids.extend([defect.cycle.owner_id, defect.cycle.project.default_qa_lead_id])
        fire(
            db, recipient_ids, "Defect Overdue", "DEFECT", defect.id, defect.defect_key,
            f"{defect.defect_key} passed its expected resolution date "
            f"({defect.expected_resolution_date.isoformat()}) and remains {defect.status}.",
        )
        created += 1
    if created:
        db.commit()
    return created


@router.get("", response_model=List[schemas.NotificationOut])
def list_notifications(unread_only: bool = False, limit: int = 50,
                       db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    q = db.query(models.Notification).filter(models.Notification.recipient_id == current_user.id)
    if unread_only:
        q = q.filter(models.Notification.read_at.is_(None))
    limit = max(1, min(limit, 200))
    return q.order_by(models.Notification.created_at.desc()).limit(limit).all()


@router.get("/unread-count")
def unread_count(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    count = (
        db.query(models.Notification)
        .filter(models.Notification.recipient_id == current_user.id, models.Notification.read_at.is_(None))
        .count()
    )
    return {"unread_count": count}


@router.post("/{notification_id}/read", response_model=schemas.NotificationOut)
def mark_read(notification_id: int, db: Session = Depends(get_db),
              current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.Notification).get(notification_id)
    if not obj or obj.recipient_id != current_user.id:
        from fastapi import HTTPException
        raise HTTPException(404, "Notification not found")
    if not obj.read_at:
        obj.read_at = models.now()
        db.commit()
        db.refresh(obj)
    return obj


@router.post("/read-all")
def mark_all_read(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    now = models.now()
    updated = (
        db.query(models.Notification)
        .filter(models.Notification.recipient_id == current_user.id, models.Notification.read_at.is_(None))
        .update({"read_at": now}, synchronize_session=False)
    )
    db.commit()
    return {"marked_read": updated}
