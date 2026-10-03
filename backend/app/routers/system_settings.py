"""Authenticated planned-downtime notice and System Admin management APIs."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import maintenance_window, models, schemas
from ..audit_service import write_audit
from ..constants import Role
from ..database import get_db
from ..deps import get_current_user, require_roles


router = APIRouter(prefix="/api/system-settings", tags=["system-settings"])
logger = logging.getLogger("qa_portal.system_settings")


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def _load_or_500(db: Session):
    try:
        return maintenance_window.load(db)
    except maintenance_window.CorruptMaintenanceWindow as exc:
        logger.exception("Saved maintenance-window configuration could not be loaded")
        raise HTTPException(500, "Saved maintenance-window configuration is invalid") from exc


@router.get(
    "/maintenance-window/current",
    response_model=schemas.MaintenanceWindowCurrentOut,
)
def get_current_maintenance_window(
    response: Response,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return only a notice that the server says is currently displayable."""
    _no_store(response)
    return maintenance_window.current_view(_load_or_500(db))


@router.get(
    "/maintenance-window",
    response_model=schemas.MaintenanceWindowAdminOut,
)
def get_maintenance_window(
    response: Response,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(Role.ADMIN)),
):
    _no_store(response)
    return maintenance_window.admin_view(_load_or_500(db))


def _commit_mutation(db: Session, operation):
    try:
        result = operation()
        db.commit()
        return result
    except maintenance_window.MaintenanceWindowRevisionConflict as exc:
        db.rollback()
        raise HTTPException(409, str(exc)) from exc
    except maintenance_window.MaintenanceWindowNotConfigured as exc:
        db.rollback()
        raise HTTPException(404, str(exc)) from exc
    except maintenance_window.InvalidMaintenanceWindow as exc:
        db.rollback()
        raise HTTPException(400, str(exc)) from exc
    except maintenance_window.CorruptMaintenanceWindow as exc:
        db.rollback()
        logger.exception("Saved maintenance-window configuration could not be changed")
        raise HTTPException(500, "Saved maintenance-window configuration is invalid") from exc
    except IntegrityError as exc:
        db.rollback()
        # This is the first-insert uniqueness race's last-resort boundary if
        # the winner is not yet readable on a particular database isolation
        # level. A retry after refresh resolves against its saved revision.
        raise HTTPException(
            409, "Maintenance window changed concurrently. Refresh and try again."
        ) from exc


def _audit_mutation(
    db: Session,
    *,
    result: maintenance_window.MutationResult,
    current_user: models.User,
    request: Request,
) -> None:
    write_audit(
        db,
        event_type="SYSTEM_CONFIGURATION",
        action=result.action,
        actor=current_user,
        request=request,
        status_code=200,
        target_type="SYSTEM_SETTING",
        target_id=maintenance_window.SETTING_KEY,
        target_name="Planned downtime",
        details={
            "before": maintenance_window.safe_audit_snapshot(result.before),
            "after": maintenance_window.safe_audit_snapshot(result.after),
        },
    )


@router.put(
    "/maintenance-window",
    response_model=schemas.MaintenanceWindowAdminOut,
)
def put_maintenance_window(
    payload: schemas.MaintenanceWindowUpdate,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(Role.ADMIN)),
):
    _no_store(response)
    result = _commit_mutation(
        db,
        lambda: maintenance_window.upsert(
            db,
            expected_revision=payload.expected_revision,
            title=payload.title,
            message=payload.message,
            starts_at=payload.starts_at,
            ends_at=payload.ends_at,
            actor=current_user,
        ),
    )
    _audit_mutation(db, result=result, current_user=current_user, request=request)
    return maintenance_window.admin_view(result.after)


@router.post(
    "/maintenance-window/cancel",
    response_model=schemas.MaintenanceWindowAdminOut,
)
def cancel_maintenance_window(
    payload: schemas.MaintenanceWindowCancel,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(Role.ADMIN)),
):
    _no_store(response)
    result = _commit_mutation(
        db,
        lambda: maintenance_window.cancel(
            db,
            expected_revision=payload.expected_revision,
            reason=payload.reason,
            actor=current_user,
        ),
    )
    _audit_mutation(db, result=result, current_user=current_user, request=request)
    return maintenance_window.admin_view(result.after)
