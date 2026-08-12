import json
import ipaddress
import os
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.orm import Session

from . import models


def _trusted_proxy_networks():
    """Networks allowed to assert forwarded client-address headers."""
    configured = os.getenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32,::1/128")
    networks = []
    for value in configured.split(","):
        try:
            networks.append(ipaddress.ip_network(value.strip(), strict=False))
        except ValueError:
            continue
    return tuple(networks)


TRUSTED_PROXY_NETWORKS = _trusted_proxy_networks()


def _ip(value: str | None):
    value = (value or "").strip().strip('"')
    if value.startswith("[") and "]" in value:
        value = value[1:value.index("]")]
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def _is_trusted_proxy(address) -> bool:
    return bool(address) and any(address in network for network in TRUSTED_PROXY_NETWORKS)


def request_ip(request: Request) -> Optional[str]:
    """Resolve the client at the trusted edge of the forwarding chain.

    Forwarding headers from an untrusted direct client are ignored. Starting
    at the immediate peer, trusted proxies are removed from the right side of
    X-Forwarded-For; the first untrusted address is recorded as the client.
    """
    peer = _ip(request.client.host if request.client else None)
    if not peer:
        return None
    if not _is_trusted_proxy(peer):
        return str(peer)[:64]

    forwarded = request.headers.get("x-forwarded-for")
    chain = [_ip(value) for value in forwarded.split(",")] if forwarded else []
    chain = [address for address in chain if address]
    if not chain:
        real_ip = _ip(request.headers.get("x-real-ip"))
        return str(real_ip or peer)[:64]

    chain.append(peer)
    for address in reversed(chain):
        if not _is_trusted_proxy(address):
            return str(address)[:64]
    return str(chain[0])[:64]


def user_snapshot(user: models.User) -> dict:
    """Safe access-management snapshot; deliberately excludes password data."""
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "email": user.email,
        "department": user.department,
        # 2026-08 "one user can be on multiple departments" CR: capture the
        # full multi-department set too, alongside the legacy single
        # `department` (kept above, still synced to the primary/first-
        # assigned department) so existing audit diffs/readers don't break.
        "departments": sorted(user.departments),
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
    actor_id: Optional[int] = None,
    actor_name: Optional[str] = None,
    actor_roles: Optional[str] = None,
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
    """Best-effort append. Audit storage must never expose credentials or break the action.

    `actor` is a live, in-session `User` ORM object -- the common case, used
    by every caller except main.py's `_write_request_audit`. Its
    id/username/full_name/roles are read directly here, which is only safe
    because `actor` was loaded in (or is otherwise attached to) THIS same
    `db` session.

    `actor_id`/`actor_name`/`actor_roles` (plus the pre-existing
    `actor_username`) exist for that one exceptional caller, which only has
    a plain-value snapshot of a user loaded in a *different*, already-closed
    session (see deps.py::get_current_user's own comment for exactly why
    touching such an object's attributes here is unsafe -- reported
    directly, twice, as DetachedInstanceError). `actor` wins over these when
    both are supplied.
    """
    if request_id is None and request is not None:
        request_id = getattr(request.state, "audit_request_id", None)
    user_agent = None
    if request is not None:
        user_agent = (request.headers.get("user-agent") or "")[:500] or None
    # Everything below is inside the try, not just db.add/commit -- an
    # exception constructing AuditLog(...) (e.g. from an unsafe actor.*
    # read) must never escape uncaught here either, or this function breaks
    # its own "must never break the action" promise above.
    try:
        row = models.AuditLog(
            event_type=event_type,
            action=action,
            outcome=outcome,
            actor_id=actor.id if actor else actor_id,
            actor_username=(actor.username if actor else actor_username),
            actor_name=(actor.full_name if actor else actor_name),
            actor_roles=(actor.roles_csv if actor else actor_roles),
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
        db.add(row)
        db.commit()
    except Exception:
        db.rollback()
