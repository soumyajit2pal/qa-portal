import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas, pagination
from ..constants import Role
from ..database import get_db
from ..deps import require_roles


router = APIRouter(prefix="/api/audit", tags=["audit"])
AUDIT_ROLES = (
    Role.ADMIN,
    Role.CHEIF_MANAGER_COE,
    Role.CHEIF_MANAGER_QA,
    Role.AGM_COE,
)


def _filtered_query(
    db: Session,
    event_type: Optional[str],
    outcome: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
):
    query = db.query(models.AuditLog)
    if event_type:
        query = query.filter(models.AuditLog.event_type == event_type)
    if outcome:
        query = query.filter(models.AuditLog.outcome == outcome)
    if search:
        pattern = f"%{search.strip()}%"
        query = query.filter(or_(
            models.AuditLog.actor_username.ilike(pattern),
            models.AuditLog.actor_name.ilike(pattern),
            models.AuditLog.action.ilike(pattern),
            models.AuditLog.path.ilike(pattern),
            models.AuditLog.target_name.ilike(pattern),
            models.AuditLog.target_id.ilike(pattern),
        ))
    # ISO timestamps are parsed by Oracle via SQLAlchemy only when supplied as
    # datetime values. FastAPI validates them before they reach this helper.
    if date_from:
        import datetime
        query = query.filter(models.AuditLog.created_at >= datetime.datetime.fromisoformat(date_from))
    if date_to:
        import datetime
        query = query.filter(models.AuditLog.created_at <= datetime.datetime.fromisoformat(date_to))
    return query


@router.get("", response_model=pagination.Page[schemas.AuditLogOut])
def list_audit_logs(
    event_type: Optional[str] = None,
    outcome: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    params: pagination.PageParams = Depends(),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*AUDIT_ROLES)),
):
    """SRS 7.2 pagination rollout -- this endpoint already did real SQL
    `OFFSET`/`LIMIT` pagination before this change (unlike most of the
    endpoints elsewhere in this rollout, which started as unrestricted
    `.all()` fetches), just via its own hand-rolled `page`/`page_size`
    params (default 5, range 5-200) and a bespoke `{rows, total, page,
    page_size, summary}` envelope instead of the shared `pagination.py`
    contract every other list endpoint now follows. Migrated here purely
    for consistency -- standard `page_size` of 25/50/100, the same
    `Page[T]` envelope, and `AuditLog.tsx`'s own hand-rolled Previous/Next
    footer replaced with the shared `<Table server={{...}}>` pager used
    everywhere else. `search`/`event_type`/`outcome`/`date_from`/`date_to`
    stay outside `PageParams` (module-specific filters, not PAG-001's
    generic set); `event_type`+`outcome` in particular don't map onto
    `apply_status_filter`'s single-column IN-filter shape since they're two
    independent dimensions, not one. See `audit_summary` below for the
    failed/authentication/access_management counts this list can no longer
    compute from just the current page."""
    try:
        query = _filtered_query(db, event_type, outcome, search, date_from, date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date filter. Use ISO date/time format.")
    query = query.order_by(models.AuditLog.created_at.desc(), models.AuditLog.id.desc())
    result = pagination.paginate(query, params)
    return pagination.to_page_response(result, params)


@router.get("/summary", response_model=schemas.AuditSummary)
def audit_summary(
    event_type: Optional[str] = None,
    outcome: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*AUDIT_ROLES)),
):
    """Same filters as `list_audit_logs`, so the summary strip always
    reflects the currently active filter set (matching what the old
    single-response `{rows, total, summary}` shape did) -- three indexed
    `COUNT`s, never a full-row fetch."""
    try:
        query = _filtered_query(db, event_type, outcome, search, date_from, date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date filter. Use ISO date/time format.")
    total = query.count()
    failed = query.filter(models.AuditLog.outcome == "FAILED").count()
    authentication = query.filter(models.AuditLog.event_type == "AUTHENTICATION").count()
    access_management = query.filter(models.AuditLog.event_type == "ACCESS_MANAGEMENT").count()
    return {"total": total, "failed": failed, "authentication": authentication, "access_management": access_management}


@router.get("/export")
def export_audit_logs(
    event_type: Optional[str] = None,
    outcome: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*AUDIT_ROLES)),
):
    try:
        rows = _filtered_query(db, event_type, outcome, search, date_from, date_to).order_by(
            models.AuditLog.created_at.desc(), models.AuditLog.id.desc()
        ).all()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date filter. Use ISO date/time format.")
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow([
        "Timestamp", "Event Type", "Action", "Outcome", "Actor", "Username", "Roles",
        "Method", "Path", "HTTP Status", "Target Type", "Target ID", "Target Name",
        "IP Address", "Request ID", "Details",
    ])
    for row in rows:
        writer.writerow([
            row.created_at, row.event_type, row.action, row.outcome, row.actor_name,
            row.actor_username, row.actor_roles, row.method, row.path, row.status_code,
            row.target_type, row.target_id, row.target_name, row.ip_address,
            row.request_id, row.details,
        ])
    stream.seek(0)
    return StreamingResponse(
        iter([stream.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=qualityhub-audit-log.csv"},
    )


@router.get("/{audit_id}", response_model=schemas.AuditLogOut)
def get_audit_log(
    audit_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*AUDIT_ROLES)),
):
    row = db.query(models.AuditLog).filter(models.AuditLog.id == audit_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Audit event not found")
    return row
