from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import cache, models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/departments", tags=["departments"])

# CAC-001..007 -- reference data: near-static, read on almost every page load
# (every department picker in the app), written to only rarely (Admin
# creating/renaming/toggling a department). Cache key is versioned (`v1`) so
# a future schema/shape change to DepartmentOut can invalidate every
# deployment's existing cache just by bumping it, without needing an
# explicit flush step.
_DEPARTMENTS_CACHE_KEY = "refdata:departments:active:v1"
_DEPARTMENTS_CACHE_TTL = 300


def _invalidate_departments_cache() -> None:
    cache.delete(_DEPARTMENTS_CACHE_KEY)


@router.get("", response_model=List[schemas.DepartmentOut])
def list_departments(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Active departments only -- used by every department picker in the app
    (Admin > Create User / assign department, etc). Replaces the old hardcoded
    constants.DEPARTMENTS list."""
    cached = cache.get_json(_DEPARTMENTS_CACHE_KEY)
    if cached is not None:
        return cached
    rows = db.query(models.Department).filter(models.Department.is_active == True).order_by(models.Department.name).all()  # noqa: E712
    result = [schemas.DepartmentOut.model_validate(row).model_dump(mode="json") for row in rows]
    cache.set_json(_DEPARTMENTS_CACHE_KEY, result, _DEPARTMENTS_CACHE_TTL)
    return result


@router.get("/all", response_model=List[schemas.DepartmentOut])
def list_all_departments(db: Session = Depends(get_db), current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin section: full list including deactivated departments, for management."""
    return db.query(models.Department).order_by(models.Department.name).all()


@router.post("", response_model=schemas.DepartmentOut)
def create_department(payload: schemas.DepartmentCreate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.ADMIN))):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Department name cannot be blank")
    if db.query(models.Department).filter(models.Department.name == name).first():
        raise HTTPException(400, f"Department '{name}' already exists")
    obj = models.Department(name=name, is_active=True)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    _invalidate_departments_cache()
    return obj


@router.patch("/{dept_id}", response_model=schemas.DepartmentOut)
def update_department(dept_id: int, payload: schemas.DepartmentUpdate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Rename a department and/or activate/deactivate it. Deactivating (rather
    than deleting) keeps existing users/requests that already reference the
    name intact -- it just stops showing up as a pickable option going
    forward."""
    obj = db.query(models.Department).get(dept_id)
    if not obj:
        raise HTTPException(404, "Department not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        new_name = data["name"].strip()
        existing = db.query(models.Department).filter(models.Department.name == new_name).first()
        if existing and existing.id != dept_id:
            raise HTTPException(400, f"Department '{new_name}' already exists")
        obj.name = new_name
    if "is_active" in data:
        obj.is_active = data["is_active"]
    db.commit()
    db.refresh(obj)
    _invalidate_departments_cache()
    return obj
