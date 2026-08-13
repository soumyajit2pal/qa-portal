import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..constants import Role
from ..database import get_db
from ..deps import require_roles
from ..storage_config import (
    DEFAULT_UPLOAD_ROOT, configure_upload_storage, get_upload_root, get_legacy_roots,
    validate_upload_root,
)

router = APIRouter(prefix="/api/system-settings", tags=["system-settings"])
UPLOAD_PATH_KEY = "upload_path"
LEGACY_PATHS_KEY = "upload_legacy_paths"


def _setting(db: Session, key: str):
    return db.query(models.SystemSetting).filter_by(key=key).first()


def _set(db: Session, key: str, value: str):
    row = _setting(db, key)
    if row:
        row.value = value
    else:
        db.add(models.SystemSetting(key=key, value=value))


def load_storage_settings(db: Session) -> None:
    path_row = _setting(db, UPLOAD_PATH_KEY)
    legacy_row = _setting(db, LEGACY_PATHS_KEY)
    try:
        legacy = json.loads(legacy_row.value) if legacy_row else []
    except (TypeError, ValueError):
        legacy = []
    configure_upload_storage(path_row.value if path_row else DEFAULT_UPLOAD_ROOT, legacy)


@router.get("/storage", response_model=schemas.StorageSettingsOut)
def get_storage_settings(db: Session = Depends(get_db), _=Depends(require_roles(Role.ADMIN))):
    return {"upload_path": get_upload_root(), "default_path": DEFAULT_UPLOAD_ROOT, "legacy_paths": get_legacy_roots()}


@router.patch("/storage", response_model=schemas.StorageSettingsOut)
def update_storage_settings(payload: schemas.StorageSettingsUpdate, db: Session = Depends(get_db),
                            _=Depends(require_roles(Role.ADMIN))):
    try:
        new_path = validate_upload_root(payload.upload_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    old_path = get_upload_root()
    legacy = get_legacy_roots()
    if old_path != new_path and old_path not in legacy:
        legacy.append(old_path)
    _set(db, UPLOAD_PATH_KEY, new_path)
    _set(db, LEGACY_PATHS_KEY, json.dumps(legacy))
    db.commit()
    configure_upload_storage(new_path, legacy)
    return {"upload_path": new_path, "default_path": DEFAULT_UPLOAD_ROOT, "legacy_paths": legacy}


# 2026-08 "Test Approval Workflow" refactor, section 10 -- "Reminder and
# escalation intervals shall be configurable by an Administrator." See
# routers/notifications.py::sweep_overdue_approvals for where these two
# values are actually consumed. Same _setting/_set key-value pattern as the
# storage settings above, own dedicated keys so they persist independently
# of everything else.
from .notifications import REMINDER_DAYS_KEY, ESCALATION_DAYS_KEY, DEFAULT_REMINDER_DAYS, DEFAULT_ESCALATION_DAYS  # noqa: E402


@router.get("/approval-notifications", response_model=schemas.ApprovalNotificationSettingsOut)
def get_approval_notification_settings(db: Session = Depends(get_db), _=Depends(require_roles(Role.ADMIN))):
    reminder_row = _setting(db, REMINDER_DAYS_KEY)
    escalation_row = _setting(db, ESCALATION_DAYS_KEY)
    return {
        "reminder_business_days": int(reminder_row.value) if reminder_row else DEFAULT_REMINDER_DAYS,
        "escalation_business_days": int(escalation_row.value) if escalation_row else DEFAULT_ESCALATION_DAYS,
    }


@router.patch("/approval-notifications", response_model=schemas.ApprovalNotificationSettingsOut)
def update_approval_notification_settings(payload: schemas.ApprovalNotificationSettingsUpdate,
                                          db: Session = Depends(get_db), _=Depends(require_roles(Role.ADMIN))):
    if payload.reminder_business_days < 1 or payload.escalation_business_days < 1:
        raise HTTPException(400, "Both thresholds must be at least 1 business day")
    if payload.escalation_business_days <= payload.reminder_business_days:
        raise HTTPException(400, "Escalation threshold must be greater than the reminder threshold")
    _set(db, REMINDER_DAYS_KEY, str(payload.reminder_business_days))
    _set(db, ESCALATION_DAYS_KEY, str(payload.escalation_business_days))
    db.commit()
    return {
        "reminder_business_days": payload.reminder_business_days,
        "escalation_business_days": payload.escalation_business_days,
    }
