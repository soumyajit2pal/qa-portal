"""Persistent, versioned planned-downtime notice configuration.

The portal currently supports one current/upcoming notice.  It lives in the
existing ``qap_system_settings`` table so deployments do not need a schema
migration, while an explicit revision and row lock prevent two browser tabs
from silently overwriting each other.
"""
from __future__ import annotations

import datetime
import json
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models


SETTING_KEY = "maintenance_window.v1"
SCHEMA_VERSION = 1
NOTIFICATION_WINDOW = datetime.timedelta(hours=48)
IST = ZoneInfo("Asia/Kolkata")


class MaintenanceWindowError(RuntimeError):
    """Base class for stable, router-safe maintenance-setting failures."""


class InvalidMaintenanceWindow(MaintenanceWindowError):
    pass


class MaintenanceWindowNotConfigured(MaintenanceWindowError):
    pass


class MaintenanceWindowRevisionConflict(MaintenanceWindowError):
    def __init__(self, expected: int, actual: int):
        super().__init__(
            f"Maintenance window changed (expected revision {expected}, current revision {actual}). "
            "Refresh and try again."
        )
        self.expected = expected
        self.actual = actual


class CorruptMaintenanceWindow(MaintenanceWindowError):
    pass


@dataclass(frozen=True)
class MutationResult:
    before: dict[str, Any] | None
    after: dict[str, Any]
    action: str


def _to_ist(value: datetime.datetime) -> datetime.datetime:
    if value is None or value.tzinfo is None or value.utcoffset() is None:
        raise InvalidMaintenanceWindow("Maintenance timestamps must include a UTC offset")
    # ``as_aware`` is a no-op for valid aware inputs and documents the same
    # Oracle-safe comparison convention used throughout the application.
    return models.as_aware(value).astimezone(IST)


def _now_ist(now: datetime.datetime | None = None) -> datetime.datetime:
    return _to_ist(now or models.now())


def _parse_stored_datetime(value: Any, field: str, *, required: bool = True) -> datetime.datetime | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise CorruptMaintenanceWindow(f"Saved maintenance field '{field}' is invalid")
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError as exc:
        raise CorruptMaintenanceWindow(f"Saved maintenance field '{field}' is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise CorruptMaintenanceWindow(f"Saved maintenance field '{field}' has no UTC offset")
    return parsed.astimezone(IST)


def _parse_record(value: str) -> dict[str, Any]:
    try:
        raw = json.loads(value)
    except (TypeError, ValueError) as exc:
        raise CorruptMaintenanceWindow("Saved maintenance configuration is not valid JSON") from exc
    if not isinstance(raw, dict) or raw.get("schema_version") != SCHEMA_VERSION:
        raise CorruptMaintenanceWindow("Saved maintenance configuration has an unsupported format")

    revision = raw.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise CorruptMaintenanceWindow("Saved maintenance revision is invalid")
    title = raw.get("title")
    message = raw.get("message")
    if not isinstance(title, str) or not title.strip():
        raise CorruptMaintenanceWindow("Saved maintenance title is invalid")
    if not isinstance(message, str) or not message.strip():
        raise CorruptMaintenanceWindow("Saved maintenance message is invalid")

    starts_at = _parse_stored_datetime(raw.get("starts_at"), "starts_at")
    ends_at = _parse_stored_datetime(raw.get("ends_at"), "ends_at")
    created_at = _parse_stored_datetime(raw.get("created_at"), "created_at")
    updated_at = _parse_stored_datetime(raw.get("updated_at"), "updated_at")
    cancelled_at = _parse_stored_datetime(raw.get("cancelled_at"), "cancelled_at", required=False)
    if ends_at <= starts_at:
        raise CorruptMaintenanceWindow("Saved maintenance end time is not after its start time")

    return {
        **raw,
        "revision": revision,
        "title": title.strip(),
        "message": message.strip(),
        "starts_at": starts_at,
        "ends_at": ends_at,
        "created_at": created_at,
        "updated_at": updated_at,
        "cancelled_at": cancelled_at,
    }


def _serialized_record(record: dict[str, Any]) -> str:
    payload = dict(record)
    for field in ("starts_at", "ends_at", "created_at", "updated_at", "cancelled_at"):
        value = payload.get(field)
        payload[field] = _to_ist(value).isoformat() if value is not None else None
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _query_setting(db: Session, *, for_update: bool = False):
    query = db.query(models.SystemSetting).filter(models.SystemSetting.key == SETTING_KEY)
    if for_update:
        query = query.with_for_update()
    # ``key`` is unique, so no row limiter is necessary. On Oracle,
    # Query.first() can compile as ``FETCH FIRST 1 ROWS ONLY FOR UPDATE`` and
    # fail with ORA-02014; one_or_none() emits the lockable unique-key select.
    return query.one_or_none()


def load(db: Session, *, for_update: bool = False) -> dict[str, Any] | None:
    row = _query_setting(db, for_update=for_update)
    return _parse_record(row.value) if row is not None else None


def _actor_values(actor: models.User) -> tuple[int | None, str | None]:
    actor_id = getattr(actor, "id", None)
    actor_name = (getattr(actor, "full_name", None) or getattr(actor, "username", None) or "").strip()
    return actor_id, actor_name or None


def _phase(record: dict[str, Any], now: datetime.datetime) -> str | None:
    if record.get("cancelled_at") is not None or now >= record["ends_at"]:
        return None
    return "UPCOMING" if now < record["starts_at"] else "IN_PROGRESS"


def _notice(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "revision": record["revision"],
        "title": record["title"],
        "message": record["message"],
        "starts_at": record["starts_at"],
        "ends_at": record["ends_at"],
        "display_from": record["starts_at"] - NOTIFICATION_WINDOW,
    }


def current_view(record: dict[str, Any] | None, *, now: datetime.datetime | None = None) -> dict[str, Any]:
    if record is None:
        return {"visible": False, "phase": None, "notice": None}
    current_time = _now_ist(now)
    phase = _phase(record, current_time)
    display_from = record["starts_at"] - NOTIFICATION_WINDOW
    if phase is None or current_time < display_from:
        # Ordinary users learn only about notices currently inside the
        # notification window; cancelled, ended and far-future plans remain
        # administrator-only configuration data.
        return {"visible": False, "phase": None, "notice": None}
    return {"visible": True, "phase": phase, "notice": _notice(record)}


def admin_view(record: dict[str, Any] | None, *, now: datetime.datetime | None = None) -> dict[str, Any]:
    if record is None:
        return {"configured": False, "window": None}
    current_time = _now_ist(now)
    return {
        "configured": True,
        "window": {
            **_notice(record),
            "phase": _phase(record, current_time),
            "cancelled_at": record.get("cancelled_at"),
            "cancel_reason": record.get("cancel_reason"),
            "created_at": record["created_at"],
            "created_by_id": record.get("created_by_id"),
            "created_by_name": record.get("created_by_name"),
            "updated_at": record["updated_at"],
            "updated_by_id": record.get("updated_by_id"),
            "updated_by_name": record.get("updated_by_name"),
            "cancelled_by_id": record.get("cancelled_by_id"),
            "cancelled_by_name": record.get("cancelled_by_name"),
        },
    }


def safe_audit_snapshot(record: dict[str, Any] | None) -> dict[str, Any] | None:
    if record is None:
        return None
    snapshot = {
        key: record.get(key)
        for key in (
            "revision", "title", "message", "starts_at", "ends_at",
            "created_at", "created_by_id", "created_by_name",
            "updated_at", "updated_by_id", "updated_by_name",
            "cancelled_at", "cancel_reason", "cancelled_by_id", "cancelled_by_name",
        )
    }
    return {
        key: _to_ist(value).isoformat() if isinstance(value, datetime.datetime) else value
        for key, value in snapshot.items()
    }


def upsert(
    db: Session,
    *,
    expected_revision: int,
    title: str,
    message: str,
    starts_at: datetime.datetime,
    ends_at: datetime.datetime,
    actor: models.User,
    now: datetime.datetime | None = None,
) -> MutationResult:
    current_time = _now_ist(now)
    normalized_start = _to_ist(starts_at)
    normalized_end = _to_ist(ends_at)
    if normalized_start <= current_time:
        raise InvalidMaintenanceWindow("Maintenance start time must be in the future")
    if normalized_end <= normalized_start:
        raise InvalidMaintenanceWindow("Maintenance end time must be after the start time")

    row = _query_setting(db, for_update=True)
    before = _parse_record(row.value) if row is not None else None
    actual_revision = before["revision"] if before is not None else 0
    if expected_revision != actual_revision:
        raise MaintenanceWindowRevisionConflict(expected_revision, actual_revision)

    actor_id, actor_name = _actor_values(actor)
    record = {
        "schema_version": SCHEMA_VERSION,
        "revision": actual_revision + 1,
        "title": title.strip(),
        "message": message.strip(),
        "starts_at": normalized_start,
        "ends_at": normalized_end,
        "created_at": before["created_at"] if before is not None else current_time,
        "created_by_id": before.get("created_by_id") if before is not None else actor_id,
        "created_by_name": before.get("created_by_name") if before is not None else actor_name,
        "updated_at": current_time,
        "updated_by_id": actor_id,
        "updated_by_name": actor_name,
        "cancelled_at": None,
        "cancel_reason": None,
        "cancelled_by_id": None,
        "cancelled_by_name": None,
    }
    serialized = _serialized_record(record)

    if row is None:
        row = models.SystemSetting(key=SETTING_KEY, value=serialized)
        try:
            # The unique key is the final guard for two first-ever requests
            # that both observed no row.  Keep the failure inside a savepoint
            # so the caller's request transaction remains usable.
            with db.begin_nested():
                db.add(row)
                db.flush()
        except IntegrityError:
            db.expire_all()
            winner = _query_setting(db, for_update=True)
            if winner is None:
                raise
            winner_record = _parse_record(winner.value)
            raise MaintenanceWindowRevisionConflict(
                expected_revision, winner_record["revision"]
            ) from None
    else:
        row.value = serialized
        db.flush()

    return MutationResult(
        before=before,
        after=record,
        action="MAINTENANCE_WINDOW_CREATED" if before is None else "MAINTENANCE_WINDOW_UPDATED",
    )


def cancel(
    db: Session,
    *,
    expected_revision: int,
    reason: str,
    actor: models.User,
    now: datetime.datetime | None = None,
) -> MutationResult:
    row = _query_setting(db, for_update=True)
    if row is None:
        raise MaintenanceWindowNotConfigured("No maintenance window is configured")
    before = _parse_record(row.value)
    if expected_revision != before["revision"]:
        raise MaintenanceWindowRevisionConflict(expected_revision, before["revision"])
    if before.get("cancelled_at") is not None:
        raise InvalidMaintenanceWindow("The maintenance window is already cancelled")

    current_time = _now_ist(now)
    actor_id, actor_name = _actor_values(actor)
    record = {
        **before,
        "revision": before["revision"] + 1,
        "updated_at": current_time,
        "updated_by_id": actor_id,
        "updated_by_name": actor_name,
        "cancelled_at": current_time,
        "cancel_reason": reason.strip(),
        "cancelled_by_id": actor_id,
        "cancelled_by_name": actor_name,
    }
    row.value = _serialized_record(record)
    db.flush()
    return MutationResult(
        before=before,
        after=record,
        action="MAINTENANCE_WINDOW_CANCELLED",
    )
