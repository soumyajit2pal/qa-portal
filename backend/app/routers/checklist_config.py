from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import cache, models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role
from ..checklist_config import CHECKLIST_MODULES, DETAIL_COLUMN_LABELS, get_template_items, reseed_defaults

router = APIRouter(prefix="/api/checklist-config", tags=["checklist-config"])

# CAC-001..007 -- active checklist items are read on every QA Request wizard
# step (Functional/SAST/DAST/Performance self-declaration) and rendered on
# most readiness-checklist screens, but only change through deliberate Admin
# configuration. Keyed per-module (not one blanket key) so editing one
# module's items doesn't force a refetch of every other module's cache too.
_ACTIVE_ITEMS_CACHE_TTL = 300


def _active_items_cache_key(module: str) -> str:
    return f"refdata:checklist-items:active:v1:{module}"


def _invalidate_active_items_cache(module: str) -> None:
    cache.delete(_active_items_cache_key(module))


def _check_module(module: str) -> str:
    module = module.upper()
    if module not in CHECKLIST_MODULES:
        raise HTTPException(404, f"Unknown checklist module '{module}' -- must be one of {CHECKLIST_MODULES}")
    return module


@router.get("/modules")
def list_modules(current_user: models.User = Depends(get_current_user)):
    """Just the module keys + their "detail" column label -- lets the Admin
    page and the QA Request wizard build their tabs/labels without
    hardcoding either list a second time on the frontend."""
    return [{"module": m, "detail_label": DETAIL_COLUMN_LABELS[m]} for m in CHECKLIST_MODULES]


@router.get("/{module}", response_model=List[schemas.ChecklistTemplateItemOut])
def list_active_items(module: str, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    """Active items only, ordered -- this is what the QA Request wizard's
    Functional/SAST/DAST/Performance steps render as the self-declaration
    checklist while raising a new request, so it's open to any authenticated
    user (not Admin-only), same as e.g. GET /api/departments."""
    module = _check_module(module)
    cache_key = _active_items_cache_key(module)
    cached = cache.get_json(cache_key)
    if cached is not None:
        return cached
    rows = get_template_items(db, module, only_active=True)
    result = [schemas.ChecklistTemplateItemOut.model_validate(row).model_dump(mode="json") for row in rows]
    cache.set_json(cache_key, result, _ACTIVE_ITEMS_CACHE_TTL)
    return result


@router.get("/{module}/all", response_model=List[schemas.ChecklistTemplateItemOut])
def list_all_items(module: str, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Admin management view -- includes disabled items too, so they can be
    re-enabled instead of only ever being re-typed from scratch."""
    module = _check_module(module)
    return get_template_items(db, module, only_active=False)


@router.post("/{module}", response_model=schemas.ChecklistTemplateItemOut)
def create_item(module: str, payload: schemas.ChecklistTemplateItemCreate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    module = _check_module(module)
    item_text = payload.item.strip()
    if not item_text:
        raise HTTPException(400, "Checklist item text cannot be blank")
    # Bootstrap first, if this module has never been touched -- otherwise a
    # brand-new item added before anything else has ever read this module
    # would come out at sort_order 0/1/2..., landing ahead of (or interleaved
    # with) the shipped defaults instead of after them.
    get_template_items(db, module, only_active=False)
    sort_order = payload.sort_order
    if sort_order is None:
        max_order = db.query(models.ChecklistTemplateItem).filter_by(module=module).count()
        sort_order = max_order
    obj = models.ChecklistTemplateItem(
        module=module, item=item_text, detail=payload.detail, is_mandatory=payload.is_mandatory,
        sort_order=sort_order, active=True,
    )
    db.add(obj)
    db.commit()
    db.refresh(obj)
    _invalidate_active_items_cache(module)
    return obj


@router.patch("/{module}/{item_id}", response_model=schemas.ChecklistTemplateItemOut)
def update_item(module: str, item_id: int, payload: schemas.ChecklistTemplateItemUpdate,
                 db: Session = Depends(get_db), current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Renaming, retexting, toggling Mandatory/Active, or moving an item are
    all the same "edit this row" action -- exactly what "whatever I mention
    in that configuration will automatically behave like that" needs: flip
    is_mandatory here and the very next request raised for this module picks
    it up (see routers/qa_requests.py::_sync_linked_child_requests /
    submit_request), no further wiring required."""
    module = _check_module(module)
    obj = db.query(models.ChecklistTemplateItem).filter_by(id=item_id, module=module).first()
    if not obj:
        raise HTTPException(404, "Checklist item not found")
    data = payload.model_dump(exclude_unset=True)
    if "item" in data:
        item_text = (data["item"] or "").strip()
        if not item_text:
            raise HTTPException(400, "Checklist item text cannot be blank")
        obj.item = item_text
    if "detail" in data:
        obj.detail = data["detail"]
    if "is_mandatory" in data:
        obj.is_mandatory = data["is_mandatory"]
    if "sort_order" in data and data["sort_order"] is not None:
        obj.sort_order = data["sort_order"]
    if "active" in data and data["active"] is not None:
        obj.active = data["active"]
    db.commit()
    db.refresh(obj)
    _invalidate_active_items_cache(module)
    return obj


@router.delete("/{module}/{item_id}")
def delete_item(module: str, item_id: int, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Hard delete -- safe to do even though older, already-raised requests
    keep referencing this same item text, because their own checklist rows
    (models.ReadinessChecklistItem etc.) were copied at seed time and never
    reference this table by id; removing a template item here can never
    orphan or corrupt anything already in flight (see
    models.ChecklistTemplateItem's own docstring)."""
    module = _check_module(module)
    obj = db.query(models.ChecklistTemplateItem).filter_by(id=item_id, module=module).first()
    if not obj:
        raise HTTPException(404, "Checklist item not found")
    db.delete(obj)
    db.commit()
    _invalidate_active_items_cache(module)
    return {"ok": True}


@router.post("/{module}/restore-defaults", response_model=List[schemas.ChecklistTemplateItemOut])
def restore_defaults(module: str, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.ADMIN))):
    """Wipes every configured item for this module and reseeds from the
    shipped defaults (constants.DEFAULT_*_CHECKLIST_ITEMS) -- an escape hatch
    back to a known-good state if a module's configuration gets into a state
    nobody wants to untangle by hand. Never touches any already-raised
    request's own checklist rows (see the module docstring)."""
    module = _check_module(module)
    db.query(models.ChecklistTemplateItem).filter_by(module=module).delete()
    db.flush()
    reseed_defaults(db, module)
    db.commit()
    _invalidate_active_items_cache(module)
    return get_template_items(db, module, only_active=False)
