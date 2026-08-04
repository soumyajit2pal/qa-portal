"""Admin-configurable readiness checklist support.

Every Functional/SAST/DAST/Performance request's own readiness checklist
used to be seeded straight from a hardcoded python list (constants.
DEFAULT_CHECKLIST_ITEMS / DEFAULT_SAST_CHECKLIST_ITEMS /
DEFAULT_DAST_CHECKLIST_ITEMS / DEFAULT_PERFORMANCE_CHECKLIST_ITEMS) -- so
adding an item, renaming one, or changing whether it's mandatory meant
editing this codebase and redeploying.

Reported directly: "I want to make configurable readiness checklist, what
ever I will mentioned on that configuration that will automatically behave
like that configuration, for example if I make any checklist mandatory in
that configuration file, that will be mandatory." This module is the shared
read path both routers/qa_requests.py (seeding a brand-new request's
checklist) and routers/checklist_config.py (the Admin CRUD API/page) use
against the single live source of truth: models.ChecklistTemplateItem.

The old constants.DEFAULT_*_CHECKLIST_ITEMS lists are kept (see constants.py)
purely as this table's shipped defaults -- _default_items_for below reads
them once, only to bootstrap a module's rows the very first time they're
read with none present yet (see get_template_items), and again if an Admin
ever asks to "Restore Defaults". Nothing else in the app reads those
constants lists directly any more.
"""
from typing import List, Tuple

from sqlalchemy.orm import Session

from . import models
from .constants import (
    DEFAULT_CHECKLIST_ITEMS, DEFAULT_SAST_CHECKLIST_ITEMS,
    DEFAULT_DAST_CHECKLIST_ITEMS, DEFAULT_PERFORMANCE_CHECKLIST_ITEMS,
)

CHECKLIST_MODULES = ["FUNCTIONAL", "SAST", "DAST", "PERFORMANCE"]

# Human-readable label for whatever the "detail" column means on each
# module's own checklist -- "Owner" everywhere except Performance, which
# (per Annexure VIII) calls it "Data Required from Department". Exported so
# the Admin API can hand this straight to the frontend instead of it keeping
# its own separate copy of the same per-module labeling.
DETAIL_COLUMN_LABELS = {
    "FUNCTIONAL": "Owner",
    "SAST": "Owner",
    "DAST": "Owner",
    "PERFORMANCE": "Data Required from Department",
}


def _validate_module(module: str) -> None:
    if module not in CHECKLIST_MODULES:
        raise ValueError(f"Unknown checklist module '{module}' -- must be one of {CHECKLIST_MODULES}")


_DEFAULTS_BY_MODULE = {
    "FUNCTIONAL": DEFAULT_CHECKLIST_ITEMS,
    "SAST": DEFAULT_SAST_CHECKLIST_ITEMS,
    "DAST": DEFAULT_DAST_CHECKLIST_ITEMS,
    "PERFORMANCE": DEFAULT_PERFORMANCE_CHECKLIST_ITEMS,
}


def _default_items_for(module: str) -> List[Tuple[str, str, bool]]:
    """Every module's constants.py default list is the same (item, detail,
    is_mandatory) 3-tuple shape now (Performance's own list gained its
    mandatory column alongside this feature -- it never had a working
    mandatory gate before, see routers/qa_requests.py's submit_request).
    Just a straight passthrough/type-normalization -- kept as its own
    function so callers don't need to know constants.py's per-module list
    names."""
    _validate_module(module)
    return [(item, detail, is_mandatory) for item, detail, is_mandatory in _DEFAULTS_BY_MODULE[module]]


def _seed_defaults(db: Session, module: str) -> None:
    for i, (item, detail, is_mandatory) in enumerate(_default_items_for(module)):
        db.add(models.ChecklistTemplateItem(
            module=module, item=item, detail=detail, is_mandatory=is_mandatory,
            sort_order=i, active=True,
        ))
    db.flush()


def reseed_defaults(db: Session, module: str) -> None:
    """Public entry point for routers/checklist_config.py's "Restore
    Defaults" admin action -- caller is expected to have already deleted
    this module's existing rows and to db.commit() afterward."""
    _validate_module(module)
    _seed_defaults(db, module)


def get_template_items(db: Session, module: str, only_active: bool = True) -> List["models.ChecklistTemplateItem"]:
    """This module's configured checklist items, ordered by sort_order --
    lazily bootstrapping the table from this module's shipped defaults
    (constants.DEFAULT_*_CHECKLIST_ITEMS) the first time it's ever read with
    zero rows, so a brand-new Oracle deployment needs no separate manual
    data-migration step beyond creating the table itself (same lazy-init
    pattern already used elsewhere in this app -- see
    routers/test_execution.py::_migrate_legacy_result_if_needed).

    Called both by routers/qa_requests.py (seeding a brand-new request's own
    checklist rows -- only_active=True, an inactive/disabled template item
    should never be seeded onto a new request) and by routers/
    checklist_config.py's Admin read endpoints (only_active=False when the
    Admin needs to see -- and re-enable -- disabled items too)."""
    _validate_module(module)
    if db.query(models.ChecklistTemplateItem).filter_by(module=module).count() == 0:
        _seed_defaults(db, module)
    q = db.query(models.ChecklistTemplateItem).filter_by(module=module)
    if only_active:
        q = q.filter_by(active=True)
    return q.order_by(models.ChecklistTemplateItem.sort_order, models.ChecklistTemplateItem.id).all()
