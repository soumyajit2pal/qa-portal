"""Persistent, administrator-managed LDAP configuration.

The first saved row becomes authoritative. Values materialized from the file
selected by APP_ENV_FILE are only a bootstrap/recovery source while no row
exists. The bind password is encrypted before it reaches the database and is
never included in API responses.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.orm import Session

from . import models
from .config import settings


SETTING_KEY = "ldap_configuration"
_AAD = b"qualityops:ldap-configuration:v1"
_FIELDS = (
    "enabled", "server_uri", "use_ssl", "ca_cert_file", "base_dn",
    "user_search_filter", "bind_dn", "user_dn_template",
    "attr_full_name", "attr_email", "attr_department",
)
_DEFAULTS = {
    "enabled": False,
    "server_uri": "",
    "use_ssl": True,
    "ca_cert_file": "",
    "base_dn": "",
    "user_search_filter": "(sAMAccountName={username})",
    "bind_dn": "",
    "user_dn_template": "",
    "attr_full_name": "displayName",
    "attr_email": "mail",
    "attr_department": "department",
}


def _key() -> bytes:
    # SECRET_KEY is already a mandatory deployment secret. Domain separation
    # ensures this derived key is not reused by JWT signing or other features.
    return hashlib.sha256((settings.secret_key + ":ldap-settings:v1").encode("utf-8")).digest()


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    nonce = os.urandom(12)
    encrypted = AESGCM(_key()).encrypt(nonce, value.encode("utf-8"), _AAD)
    return base64.urlsafe_b64encode(nonce + encrypted).decode("ascii")


def decrypt_secret(value: str) -> str:
    if not value:
        return ""
    try:
        payload = base64.urlsafe_b64decode(value.encode("ascii"))
        return AESGCM(_key()).decrypt(payload[:12], payload[12:], _AAD).decode("utf-8")
    except Exception as exc:
        raise RuntimeError(
            "The saved LDAP bind password cannot be decrypted with the current deployment secret."
        ) from exc


def load(db: Session | None, environment: dict[str, Any]) -> dict[str, Any]:
    """Return effective settings and their source, with decrypted password."""
    if db is None:
        return {**environment, "source": "environment", "configured": bool(environment.get("server_uri"))}
    row = db.query(models.SystemSetting).filter_by(key=SETTING_KEY).first()
    if row is None:
        return {**environment, "source": "environment", "configured": bool(environment.get("server_uri"))}
    try:
        stored = json.loads(row.value)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("The saved LDAP configuration is invalid.") from exc
    # A saved row is one complete, authoritative record. Never backfill a
    # missing/corrupt field from APP_ENV_FILE, which could unexpectedly
    # reactivate stale directory behavior after an administrator saved it.
    result = {field: stored.get(field, _DEFAULTS[field]) for field in _FIELDS}
    encrypted_password = stored.get("bind_password_encrypted", "")
    try:
        result["bind_password"] = decrypt_secret(encrypted_password)
        result["bind_password_unavailable"] = False
    except RuntimeError:
        # A deployment-secret rotation must not make the Admin page unusable.
        # Authentication fails closed until an administrator enters and saves
        # the bind password again using the new deployment secret.
        result["bind_password"] = ""
        result["bind_password_unavailable"] = bool(encrypted_password)
    result["bind_password_configured"] = bool(encrypted_password)
    result["source"] = "database"
    result["configured"] = True
    result["updated_at"] = row.updated_at
    result["fallback_file"] = environment.get("fallback_file", "")
    return result


def public_view(config: dict[str, Any]) -> dict[str, Any]:
    return {
        **{field: config.get(field) for field in _FIELDS},
        "bind_password_configured": bool(
            config.get("bind_password_configured") or config.get("bind_password")
        ),
        "bind_password_unavailable": bool(config.get("bind_password_unavailable")),
        "source": config.get("source", "environment"),
        "configured": bool(config.get("configured")),
        "updated_at": config.get("updated_at"),
        "fallback_file": config.get("fallback_file", ""),
    }


def save(db: Session, values: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    bind_password = values.pop("bind_password", None)
    if bind_password is None or bind_password == "":
        bind_password = current.get("bind_password", "")
    payload = {field: values[field] for field in _FIELDS}
    payload["bind_password_encrypted"] = encrypt_secret(bind_password)
    serialized = json.dumps(payload, separators=(",", ":"))
    row = db.query(models.SystemSetting).filter_by(key=SETTING_KEY).first()
    if row is None:
        row = models.SystemSetting(key=SETTING_KEY, value=serialized)
        db.add(row)
    else:
        row.value = serialized
    db.flush()
    environment = {field: current.get(field) for field in _FIELDS}
    environment["fallback_file"] = current.get("fallback_file", "")
    return load(db, environment)


def safe_audit_snapshot(config: dict[str, Any]) -> dict[str, Any]:
    """Configuration snapshot suitable for logs/audits (no credentials)."""
    return {
        **{field: config.get(field) for field in _FIELDS if field != "bind_dn"},
        "bind_dn_configured": bool(config.get("bind_dn")),
        "bind_password_configured": bool(
            config.get("bind_password_configured") or config.get("bind_password")
        ),
        "bind_password_unavailable": bool(config.get("bind_password_unavailable")),
        "source": config.get("source"),
    }
