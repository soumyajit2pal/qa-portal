import json
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.orm import Session

from . import models


def request_ip(request: Request) -> Optional[str]:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()[:64]
    return request.client.host[:64] if request.client else None


def user_snapshot(user: models.User) -> dict:
    """Safe access-management snapshot; deliberately excludes password data."""
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "email": user.email,
        "department": user.department,
        "roles": sorted(user.roles),
        "login_type": user.login_type,
        "is_active": bool(user.is_active),
        "needs_role_review": bool(user.needs_role_review),
        "admin_managed_only": bool(user.admin_managed_only),
    }


def snapshot_changes(before: dict, after: dict) -> dict:
    return {
        key: {"before": before.get(key), "after": after.get(key)}
        for key in sorted(set(before) | set(after))
        if before.get(key) != after.get(key)
    }


def write_audit(
    db: Session,
    *,
    event_type: str,
    action: str,
    outcome: str = "SUCCESS",
    actor: Optional[models.User] = None,
    actor_username: Optional[str] = None,
    request: Optional[Request] = None,
    method: Optional[str] = None,
    path: Optional[str] = None,
    status_code: Optional[int] = None,
    target_type: Optional[str] = None,
    target_id: Optional[Any] = None,
    target_name: Optional[str] = None,
    details: Optional[dict] = None,
    request_id: Optional[str] = None,
) -> None:
    """Best-effort append. Audit storage must never expose credentials or break the action."""
    if request_id is None and request is not None:
        request_id = getattr(request.state, "audit_request_id", None)
    user_agent = None
    if request is not None:
        user_agent = (request.headers.get("user-agent") or "")[:500] or None
    row = models.AuditLog(
        event_type=event_type,
        action=action,
        outcome=outcome,
        actor_id=actor.id if actor else None,
        actor_username=(actor.username if actor else actor_username),
        actor_name=actor.full_name if actor else None,
        actor_roles=actor.roles_csv if actor else None,
        method=method or (request.method if request else None),
        path=path or (request.url.path if request else None),
        status_code=status_code,
        target_type=target_type,
        target_id=str(target_id) if target_id is not None else None,
        target_name=target_name,
        details=json.dumps(details, default=str, ensure_ascii=False) if details else None,
        ip_address=request_ip(request) if request else None,
        user_agent=user_agent,
        request_id=request_id,
    )
    try:
        db.add(row)
        db.commit()
    except Exception:
        db.rollback()
