"""Opaque browser sessions, cookie policy, revocation and CSRF validation."""
from __future__ import annotations

import datetime
import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from . import models
from .config import settings

SECURE_SESSION_COOKIE = "__Host-QAP-Session"
DEV_SESSION_COOKIE = "QAP-Session"
SECURE_CSRF_COOKIE = "__Host-QAP-CSRF"
DEV_CSRF_COOKIE = "QAP-CSRF"
CSRF_HEADER = "X-CSRF-Token"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _now() -> datetime.datetime:
    # Oracle DATE/TIMESTAMP round-trips without timezone information. Store
    # UTC wall time consistently so comparisons never mix aware/naive values.
    return datetime.datetime.now(datetime.UTC).replace(tzinfo=None)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def _user_agent_hash(request: Request) -> str | None:
    value = request.headers.get("user-agent", "").strip()
    return hashlib.sha256(value.encode("utf-8")).hexdigest() if value else None


def cookie_names() -> tuple[str, str]:
    if settings.secure_session_cookie:
        return SECURE_SESSION_COOKIE, SECURE_CSRF_COOKIE
    return DEV_SESSION_COOKIE, DEV_CSRF_COOKIE


def create_session(db: Session, user_id: int, request: Request) -> tuple[str, str]:
    session_secret = secrets.token_urlsafe(32)
    csrf_secret = secrets.token_urlsafe(32)
    now = _now()
    # Keep the server-side store bounded without retaining expired/revoked
    # secrets indefinitely. Login is infrequent enough for this indexed
    # cleanup to be cheaper than a separate scheduled job.
    db.query(models.AuthSession).filter(
        (models.AuthSession.expires_at <= now)
        | (models.AuthSession.revoked_at.is_not(None))
    ).delete(synchronize_session=False)
    db.add(models.AuthSession(
        token_hash=_hash(session_secret),
        user_id=user_id,
        csrf_hash=_hash(csrf_secret),
        created_at=now,
        last_seen_at=now,
        expires_at=now + datetime.timedelta(minutes=settings.session_max_minutes),
        user_agent_hash=_user_agent_hash(request),
    ))
    db.commit()
    return session_secret, csrf_secret


def set_session_cookies(response: Response, session_secret: str, csrf_secret: str) -> None:
    session_name, csrf_name = cookie_names()
    common = dict(path="/", secure=settings.secure_session_cookie, samesite="lax")
    # Deliberately omit Max-Age/Expires: these are browser-session cookies.
    response.set_cookie(session_name, session_secret, httponly=True, **common)
    response.set_cookie(csrf_name, csrf_secret, httponly=False, **common)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def clear_session_cookies(response: Response) -> None:
    # Clear both names so changing environment/profile cannot strand a cookie.
    for name in (SECURE_SESSION_COOKIE, DEV_SESSION_COOKIE, SECURE_CSRF_COOKIE, DEV_CSRF_COOKIE):
        response.delete_cookie(
            name, path="/", secure=name.startswith("__Host-"), samesite="lax",
            httponly=name.endswith("Session"),
        )
    response.headers["Cache-Control"] = "no-store"


def _credentials_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Your session has expired or is no longer valid. Sign in again.",
    )


def reject_cross_site_request(request: Request) -> None:
    """Reject browser-identified cross-site mutations as defense in depth."""
    if (
        request.method.upper() not in SAFE_METHODS
        and request.headers.get("sec-fetch-site", "").strip().lower() == "cross-site"
    ):
        raise HTTPException(status_code=403, detail="Cross-site request blocked")


def resolve_session(
    request: Request,
    db: Session,
    *,
    enforce_csrf: bool = True,
    touch: bool = True,
) -> models.AuthSession:
    session_name, csrf_name = cookie_names()
    secret = request.cookies.get(session_name)
    if not secret:
        raise _credentials_error()
    row = db.get(models.AuthSession, _hash(secret))
    now = _now()
    if row is None or row.revoked_at is not None or row.expires_at <= now:
        raise _credentials_error()
    if row.last_seen_at + datetime.timedelta(minutes=settings.session_idle_minutes) <= now:
        row.revoked_at = now
        db.commit()
        raise _credentials_error()

    if enforce_csrf and request.method.upper() not in SAFE_METHODS:
        reject_cross_site_request(request)
        header = request.headers.get(CSRF_HEADER, "")
        cookie = request.cookies.get(csrf_name, "")
        if not header or not cookie or not hmac.compare_digest(header, cookie) or not hmac.compare_digest(_hash(header), row.csrf_hash):
            raise HTTPException(status_code=403, detail="CSRF validation failed. Refresh the page and try again.")

    # Avoid a write on every request while retaining a precise idle timeout.
    if touch and row.last_seen_at + datetime.timedelta(seconds=60) <= now:
        row.last_seen_at = now
        db.commit()
    request.state.auth_session_hash = row.token_hash
    return row


def revoke_session(db: Session, token_hash: str | None) -> None:
    if not token_hash:
        return
    row = db.get(models.AuthSession, token_hash)
    if row is not None and row.revoked_at is None:
        row.revoked_at = _now()
        db.commit()


def revoke_presented_session(db: Session, request: Request) -> None:
    """Revoke the session cookie being replaced by a successful login."""
    session_name, _ = cookie_names()
    secret = request.cookies.get(session_name)
    if secret:
        revoke_session(db, _hash(secret))


def revoke_user_sessions(db: Session, user_id: int, *, except_hash: str | None = None) -> int:
    query = db.query(models.AuthSession).filter(
        models.AuthSession.user_id == user_id,
        models.AuthSession.revoked_at.is_(None),
    )
    if except_hash:
        query = query.filter(models.AuthSession.token_hash != except_hash)
    count = query.update({models.AuthSession.revoked_at: _now()}, synchronize_session=False)
    db.commit()
    return count
