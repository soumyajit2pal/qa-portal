import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..constants import Role
from ..database import get_db
from ..deps import require_roles


router = APIRouter(prefix="/api/audit", tags=["audit"])
AUDIT_ROLES = (
    Role.ADMIN,
    Role.DEPARTMENT_HEAD_COE_CM,
    Role.DEPARTMENT_HEAD_COE_AGM,
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


@router.get("", response_model=schemas.AuditLogPage)
def list_audit_logs(
    event_type: Optional[str] = None,
    outcome: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=10, le=200),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*AUDIT_ROLES)),
):
    try:
        query = _filtered_query(db, event_type, outcome, search, date_from, date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date filter. Use ISO date/time format.")
    total = query.count()
    rows = (
        query.order_by(models.AuditLog.created_at.desc(), models.AuditLog.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    failed = query.filter(models.AuditLog.outcome == "FAILED").count()
    authentication = query.filter(models.AuditLog.event_type == "AUTHENTICATION").count()
    access_management = query.filter(models.AuditLog.event_type == "ACCESS_MANAGEMENT").count()
    return {
        "rows": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
        "summary": {
            "total": total,
            "failed": failed,
            "authentication": authentication,
            "access_management": access_management,
        },
    }


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
