import re
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

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


def _department_identity(value: str) -> str:
    """Match harmless punctuation/spacing variants of one department name."""
    return re.sub(r"[^a-z0-9]+", "", (value or "").strip().lower())


_SIMPLE_DEPARTMENT_COLUMNS = (
    (models.User, models.User.department),
    (models.ApplicationMaster, models.ApplicationMaster.department),
    (models.QARequest, models.QARequest.department),
    (models.SuppressionRequest, models.SuppressionRequest.department),
    (models.QASignOff, models.QASignOff.department),
    (models.TestProject, models.TestProject.department),
    (models.Defect, models.Defect.assigned_team),
)

_SCOPED_DEPARTMENT_COLUMNS = (
    (models.UserDepartment, models.UserDepartment.department, models.UserDepartment.user_id),
    (models.TestProjectViewGrant, models.TestProjectViewGrant.department, models.TestProjectViewGrant.project_id),
    (models.TestCycleFolderAccess, models.TestCycleFolderAccess.department, models.TestCycleFolderAccess.folder_id),
)


def _rename_department_references(db: Session, old_name: str, new_name: str) -> int:
    """Cascade a department rename through every live department reference.

    Department ownership predates the Department master and is intentionally
    stored as text in several tables. A master-only rename therefore breaks
    access matching. Association tables need duplicate-aware merging because
    a user/project/folder can already contain the new spelling.
    """
    if old_name == new_name:
        return 0
    changed = 0
    for model, column in _SIMPLE_DEPARTMENT_COLUMNS:
        changed += db.query(model).filter(column == old_name).update(
            {column: new_name}, synchronize_session=False,
        )
    for model, column, scope_column in _SCOPED_DEPARTMENT_COLUMNS:
        for row in db.query(model).filter(column == old_name).all():
            duplicate = db.query(model).filter(
                scope_column == getattr(row, scope_column.key),
                column == new_name,
                model.id != row.id,
            ).first()
            if duplicate:
                db.delete(row)
            else:
                setattr(row, column.key, new_name)
            changed += 1
    for item in db.query(models.ChecklistTemplateItem).filter(
        models.ChecklistTemplateItem.mandatory_departments_json.isnot(None),
    ).all():
        departments = item.mandatory_departments
        renamed = [new_name if value == old_name else value for value in departments]
        if renamed != departments:
            item.set_mandatory_departments(renamed)
            changed += 1
    return changed


def reconcile_department_references(db: Session) -> int:
    """Repair legacy spacing variants against the current Department master.

    This handles deployments where the master row was edited directly in the
    database before rename cascading existed. Only a unique normalized match
    is repaired; ambiguous names are deliberately left untouched.
    """
    canonical = {}
    ambiguous = set()
    for name, in db.query(models.Department.name).all():
        identity = _department_identity(name)
        if identity in canonical and canonical[identity] != name:
            ambiguous.add(identity)
        else:
            canonical[identity] = name
    for identity in ambiguous:
        canonical.pop(identity, None)

    values = set()
    for _, column in _SIMPLE_DEPARTMENT_COLUMNS:
        values.update(value for value, in db.query(column).filter(column.isnot(None)).distinct().all() if value)
    for _, column, _ in _SCOPED_DEPARTMENT_COLUMNS:
        values.update(value for value, in db.query(column).filter(column.isnot(None)).distinct().all() if value)
    for item in db.query(models.ChecklistTemplateItem).filter(
        models.ChecklistTemplateItem.mandatory_departments_json.isnot(None),
    ).all():
        values.update(item.mandatory_departments)

    changed = 0
    for old_name in sorted(values):
        new_name = canonical.get(_department_identity(old_name))
        if new_name and new_name != old_name:
            changed += _rename_department_references(db, old_name, new_name)
    if changed:
        db.commit()
        _invalidate_departments_cache()
    return changed


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
    try:
        db.commit()
    except IntegrityError:
        # Race-safe fallback for the same check-then-insert window as
        # test_execution.py's create_cycle_folder_access -- see that
        # function's own comment. Two admins (or one double-click)
        # creating the same department name near-simultaneously both pass
        # the pre-check above and both insert.
        db.rollback()
        raise HTTPException(400, f"Department '{name}' already exists")
    db.refresh(obj)
    _invalidate_departments_cache()
    return obj


def backfill_user_department_assignments(db: Session) -> int:
    """2026-08 "one user can be on multiple departments" CR -- one-time
    startup backfill (see main.py's startup-migrations block, same
    try_acquire_lock pattern as migrate_legacy_document_layout) so every
    pre-existing account gets a real UserDepartment row instead of relying
    forever on User.departments' own legacy-column fallback. Purely a
    convenience/consistency pass -- reads already work correctly without
    this (the fallback exists precisely so nothing breaks in the meantime)
    -- but Admin.tsx's new multi-select picker, and any future direct query
    against qap_user_departments, should see a real row for every account
    that has ever had a department, not just ones created/edited after this
    CR shipped."""
    candidates = (
        db.query(models.User)
        .filter(models.User.department.isnot(None), models.User.department != "")
        .filter(~models.User.department_assignments.any())
        .all()
    )
    count = 0
    for user in candidates:
        db.add(models.UserDepartment(user_id=user.id, department=user.department))
        count += 1
    if count:
        db.commit()
    return count


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
        old_name = obj.name
        _rename_department_references(db, old_name, new_name)
        obj.name = new_name
    if "is_active" in data:
        obj.is_active = data["is_active"]
    db.commit()
    db.refresh(obj)
    _invalidate_departments_cache()
    return obj
