import datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response

from app import models
from app.auth import LDAPAuthError, hash_password
from app.config import settings
from app.routers import auth as auth_router
from app.session_security import (
    CSRF_HEADER,
    cookie_names,
    create_session,
    resolve_session,
    revoke_session,
    set_session_cookies,
)


def _request(method="GET", cookies="", csrf="", fetch_site="same-origin"):
    headers = []
    if cookies:
        headers.append((b"cookie", cookies.encode()))
    if csrf:
        headers.append((CSRF_HEADER.lower().encode(), csrf.encode()))
    if fetch_site:
        headers.append((b"sec-fetch-site", fetch_site.encode()))
    return Request({"type": "http", "method": method, "path": "/api/test", "headers": headers})


@pytest.fixture
def session_db():
    engine = create_engine("sqlite://")
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = models.User(username="session-user", full_name="Session User", is_active=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        yield db, user
    engine.dispose()


def _issued_session(db, user):
    secret, csrf = create_session(db, user.id, _request())
    response = Response()
    set_session_cookies(response, secret, csrf)
    cookie_header = "; ".join(value.split(";", 1)[0] for value in response.headers.getlist("set-cookie"))
    return secret, csrf, response, cookie_header


def test_session_cookie_is_host_only_secure_and_non_persistent_in_uat(session_db):
    db, user = session_db
    _, _, response, _ = _issued_session(db, user)
    session_name, csrf_name = cookie_names()
    headers = response.headers.getlist("set-cookie")
    session_header = next(value for value in headers if value.startswith(f"{session_name}="))
    csrf_header = next(value for value in headers if value.startswith(f"{csrf_name}="))
    assert "HttpOnly" in session_header
    assert "SameSite=lax" in session_header
    assert "Max-Age" not in session_header and "expires=" not in session_header.lower()
    if settings.secure_session_cookie:
        assert session_name.startswith("__Host-") and "Secure" in session_header
        assert csrf_name.startswith("__Host-") and "Secure" in csrf_header


def test_csrf_cross_site_and_revocation_are_enforced(session_db):
    db, user = session_db
    _, csrf, _, cookies = _issued_session(db, user)
    row = resolve_session(_request("POST", cookies, csrf), db)
    assert row.user_id == user.id

    with pytest.raises(HTTPException) as invalid_csrf:
        resolve_session(_request("POST", cookies, "wrong"), db)
    assert invalid_csrf.value.status_code == 403

    with pytest.raises(HTTPException) as cross_site:
        resolve_session(_request("POST", cookies, csrf, "cross-site"), db)
    assert cross_site.value.status_code == 403

    revoke_session(db, row.token_hash)
    with pytest.raises(HTTPException) as revoked:
        resolve_session(_request("GET", cookies), db)
    assert revoked.value.status_code == 401


def test_idle_and_absolute_expiry_fail_closed(session_db):
    db, user = session_db
    _, _, _, cookies = _issued_session(db, user)
    row = db.query(models.AuthSession).one()
    now = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
    row.last_seen_at = now - datetime.timedelta(minutes=settings.session_idle_minutes + 1)
    db.commit()
    with pytest.raises(HTTPException) as idle:
        resolve_session(_request("GET", cookies), db)
    assert idle.value.status_code == 401

    _, _, _, cookies = _issued_session(db, user)
    row = db.query(models.AuthSession).one()
    row.expires_at = now - datetime.timedelta(seconds=1)
    db.commit()
    with pytest.raises(HTTPException) as absolute:
        resolve_session(_request("GET", cookies), db)
    assert absolute.value.status_code == 401


def test_login_returns_no_javascript_credential_and_logout_revokes_server_session(session_db):
    db, user = session_db
    user.login_type = "STANDARD"
    user.hashed_password = hash_password("valid-password")
    db.commit()
    login_response = Response()
    with patch.object(auth_router, "_enforce_login_rate_limit"), \
         patch.object(auth_router, "_clear_login_failures"), \
         patch.object(auth_router, "write_audit"):
        result = auth_router.login(
            _request("POST"), login_response,
            SimpleNamespace(username=user.username, password="valid-password"), db,
        )
    assert result.model_dump() == {
        "roles": [], "full_name": user.full_name, "username": user.username,
    }
    assert db.query(models.AuthSession).filter_by(user_id=user.id, revoked_at=None).count() == 1

    cookies = "; ".join(value.split(";", 1)[0] for value in login_response.headers.getlist("set-cookie"))
    _, csrf_name = cookie_names()
    csrf = next(part.split("=", 1)[1] for part in cookies.split("; ") if part.startswith(f"{csrf_name}="))
    logout_response = Response()
    with patch.object(auth_router, "write_audit"):
        assert auth_router.logout(_request("POST", cookies, csrf), logout_response, db) == {"status": "ok"}
    assert db.query(models.AuthSession).filter_by(user_id=user.id, revoked_at=None).count() == 0
    assert any("Max-Age=0" in value for value in logout_response.headers.getlist("set-cookie"))


def test_disabled_login_is_generic_and_rate_limited(session_db):
    db, user = session_db
    user.is_active = False
    db.commit()
    with patch.object(auth_router, "_enforce_login_rate_limit"), \
         patch.object(auth_router, "_record_login_failure") as record, \
         patch.object(auth_router, "write_audit"):
        with pytest.raises(HTTPException) as exc:
            auth_router.login(
                _request("POST"), Response(),
                SimpleNamespace(username=user.username, password="anything"), db,
            )
    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid username or password"
    record.assert_called_once()


def test_unknown_user_ldap_outage_is_not_an_enumeration_oracle(session_db):
    db, _ = session_db
    with patch.object(auth_router, "_enforce_login_rate_limit"), \
         patch.object(auth_router, "ldap_authenticate_with_profile", side_effect=LDAPAuthError("offline")), \
         patch.object(auth_router, "write_audit"):
        with pytest.raises(HTTPException) as exc:
            auth_router.login(
                _request("POST"), Response(),
                SimpleNamespace(username="unknown-user", password="anything"), db,
            )
    assert exc.value.status_code == 503
    assert "unavailable" in exc.value.detail.lower()
