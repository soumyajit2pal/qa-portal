import json
import ipaddress
import os
import re
import uuid
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.orm import Session

from . import models


_REQUEST_ID_MAX_LENGTH = 64
_REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}\Z")


def normalize_request_id(header_value: str | None) -> str:
    """Return an untrusted correlation header in audit-column-safe form."""
    candidate = (header_value or "").strip()
    if (
        candidate
        and len(candidate) <= _REQUEST_ID_MAX_LENGTH
        and _REQUEST_ID_PATTERN.fullmatch(candidate)
    ):
        return candidate
    return str(uuid.uuid4())


def _bounded_text(value: Any, max_length: int) -> Optional[str]:
    """Coerce an audit value without exceeding its fixed-width DB column."""
    if value is None:
        return None
    return str(value)[:max_length]


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
    peer_value = request.client.host if request.client else None
    peer = _ip(peer_value)
    if not peer:
        # Uvicorn's trusted ProxyHeaders middleware deliberately replaces the
        # ASGI peer with ``None`` when every address in X-Forwarded-For is in
        # its trusted set. Nginx still supplies an overwritten X-Real-IP in
        # that case. A non-empty but malformed peer does *not* get this
        # fallback, so a direct client cannot make a forged header trusted.
        if peer_value:
            return None
        real_ip = _ip(request.headers.get("x-real-ip"))
        if real_ip:
            return str(real_ip)[:64]
        forwarded = request.headers.get("x-forwarded-for")
        chain = [_ip(value) for value in forwarded.split(",")] if forwarded else []
        first_valid = next((address for address in chain if address), None)
        return str(first_valid)[:64] if first_valid else None
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


def request_audit_target(request: Request, module: str) -> tuple[str, Optional[str], Optional[str]]:
    """Return useful resource metadata for the generic API audit event.

    Business handlers can still write a richer audit record with a display
    name. The middleware-level record has only the resolved route/path and
    path parameters, but that is enough to avoid an unexplained blank target.
    """
    target_type = module if module and module != "OTHER" else "API_RESOURCE"
    identifiers = [
        f"{key}={value}"
        for key, value in request.path_params.items()
        if key == "id" or key.endswith("_id")
    ]
    if identifiers:
        return target_type, ", ".join(identifiers)[:100], None
    return target_type, None, request.url.path[:255] or None


def user_snapshot(user: models.User) -> dict:
    """Safe access-management snapshot; deliberately excludes password data."""
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "email": user.email,
        "needs_email_confirmation": bool(user.needs_email_confirmation),
        "department": user.department,
        # 2026-08 "one user can be on multiple departments" CR: capture the
        # full multi-department set too, alongside the legacy single
        # `department` (kept above, still synced to the primary/first-
        # assigned department) so existing audit diffs/readers don't break.
        "departments": sorted(user.departments),
        "department_unit_ids": sorted(user.department_unit_ids),
        "roles": sorted(user.roles),
        "login_type": user.login_type,
        "is_active": bool(user.is_active),
        "needs_role_review": bool(user.needs_role_review),
        "admin_managed_only": bool(user.admin_managed_only),
        "show_in_user_dropdowns": bool(user.show_in_user_dropdowns),
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
    if request_id is not None:
        # Defense in depth for audit calls outside main's HTTP middleware.
        request_id = normalize_request_id(request_id)
    user_agent = None
    if request is not None:
        user_agent = (request.headers.get("user-agent") or "")[:500] or None
    # Everything below is inside the try, not just db.add/commit -- an
    # exception constructing AuditLog(...) (e.g. from an unsafe actor.*
    # read) must never escape uncaught here either, or this function breaks
    # its own "must never break the action" promise above.
    try:
        row = models.AuditLog(
            event_type=_bounded_text(event_type, 40),
            action=_bounded_text(action, 80),
            outcome=_bounded_text(outcome, 20),
            actor_id=actor.id if actor else actor_id,
            actor_username=_bounded_text(actor.username if actor else actor_username, 150),
            actor_name=_bounded_text(actor.full_name if actor else actor_name, 150),
            actor_roles=_bounded_text(actor.roles_csv if actor else actor_roles, 500),
            method=_bounded_text(method or (request.method if request else None), 10),
            path=_bounded_text(path or (request.url.path if request else None), 500),
            status_code=status_code,
            target_type=_bounded_text(target_type, 64),
            target_id=_bounded_text(target_id, 100),
            target_name=_bounded_text(target_name, 255),
            details=json.dumps(details, default=str, ensure_ascii=False) if details else None,
            ip_address=request_ip(request) if request else None,
            user_agent=user_agent,
            request_id=request_id,
        )
        db.add(row)
        db.commit()
    except Exception:
        db.rollback()
