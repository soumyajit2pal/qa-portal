"""System-wide requester application creation policy; disabled by default."""
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import models, schemas

SETTING_KEY = "application_creation.v1"
DISABLED_MESSAGE = (
    "New application creation is disabled. Select an application from the existing list "
    "or contact an administrator to add a new application."
)


def _setting(db: Session, *, lock=False):
    query = db.query(models.SystemSetting).filter_by(key=SETTING_KEY).populate_existing()
    # A unique-key query avoids Oracle's FETCH FIRST ... FOR UPDATE restriction.
    return (query.with_for_update() if lock else query).one_or_none()


def _view(row):
    if row is None:
        return schemas.ApplicationCreationPolicyOut(enabled=False, revision=0)
    try:
        raw = json.loads(row.value)
        if not isinstance(raw, dict) or raw.get("schema_version") != 1:
            raise ValueError("Unsupported policy format")
        return schemas.ApplicationCreationPolicyOut.model_validate({
            "enabled": raw.get("enabled"), "revision": raw.get("revision"),
        })
    except (ValueError, TypeError) as exc:
        raise HTTPException(503, {"code":"APPLICATION_CREATION_UNAVAILABLE",
            "message":"New application creation is unavailable. Select an existing application or contact an administrator."}) from exc


def load(db: Session):
    return _view(_setting(db))


def update(db: Session, payload: schemas.ApplicationCreationPolicyUpdate):
    row = _setting(db, lock=True)
    before = _view(row)
    if payload.expected_revision != before.revision:
        raise HTTPException(409, "Application creation policy changed. Refresh and try again.")
    after = schemas.ApplicationCreationPolicyOut(enabled=payload.enabled, revision=before.revision + 1)
    serialized = json.dumps({"schema_version":1, **after.model_dump()}, sort_keys=True)
    if row is None:
        db.add(models.SystemSetting(key=SETTING_KEY, value=serialized))
    else:
        row.value = serialized
    db.flush()
    return before, after


def require_enabled(db: Session):
    if not load(db).enabled:
        raise HTTPException(403, {"code":"APPLICATION_CREATION_DISABLED", "message":DISABLED_MESSAGE})
