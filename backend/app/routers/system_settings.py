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
