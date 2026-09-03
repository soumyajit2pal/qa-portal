from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import cache, models, schemas
from ..constants import Role
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..request_type_config import get_request_type_configs


router = APIRouter(prefix="/api/request-type-config", tags=["request-type-config"])
_CACHE_KEY = "refdata:request-types:v1"
_CACHE_TTL = 300


@router.get("", response_model=List[schemas.RequestTypeConfigOut])
def list_request_types(db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    cached = cache.get_json(_CACHE_KEY)
    if cached is not None:
        return cached
    rows = get_request_type_configs(db)
    db.commit()
    result = [schemas.RequestTypeConfigOut.model_validate(row).model_dump(mode="json") for row in rows]
    cache.set_json(_CACHE_KEY, result, _CACHE_TTL)
    return result


@router.patch("/{config_id}", response_model=schemas.RequestTypeConfigOut)
def update_request_type(config_id: int, payload: schemas.RequestTypeConfigUpdate,
                        db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.ADMIN))):
    get_request_type_configs(db)
    row = db.query(models.RequestTypeConfig).filter_by(id=config_id).first()
    if not row:
        raise HTTPException(404, "Request Type not found")
    row.is_active = payload.is_active
    db.commit()
    db.refresh(row)
    cache.delete(_CACHE_KEY)
    return row
