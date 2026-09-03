"""Shared read/validation support for Admin-managed QA request types."""

from sqlalchemy.orm import Session

from . import models
from .constants import REQUEST_TYPES


def get_request_type_configs(db: Session) -> list[models.RequestTypeConfig]:
    """Return all fixed request types, bootstrapping missing config rows."""
    rows = db.query(models.RequestTypeConfig).all()
    existing = {row.request_type for row in rows}
    for index, request_type in enumerate(REQUEST_TYPES):
        if request_type not in existing:
            db.add(models.RequestTypeConfig(
                request_type=request_type,
                sort_order=index,
                is_active=True,
            ))
    if len(existing) < len(REQUEST_TYPES):
        db.flush()
        rows = db.query(models.RequestTypeConfig).all()
    order = {request_type: index for index, request_type in enumerate(REQUEST_TYPES)}
    return sorted(rows, key=lambda row: (order.get(row.request_type, row.sort_order), row.id))


def inactive_request_types(db: Session, selected: list[str]) -> list[str]:
    active = {
        row.request_type for row in get_request_type_configs(db)
        if row.is_active
    }
    return sorted({request_type for request_type in selected if request_type in REQUEST_TYPES and request_type not in active})
