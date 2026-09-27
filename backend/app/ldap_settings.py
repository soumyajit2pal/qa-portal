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
from .ldap_ca_certificates import (
    CertificateValidationError,
    normalize_base64_certificate_bundle,
    safe_certificate_name,
)


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
_CERTIFICATE_DEFAULTS = {
    "ca_certificate_pem": "",
    "ca_certificate_name": "",
    "ca_certificate_metadata": [],
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


def _environment_result(environment: dict[str, Any]) -> dict[str, Any]:
    return {
        **environment,
        **_CERTIFICATE_DEFAULTS,
        "source": "environment",
        "configured": bool(environment.get("server_uri")),
    }


def load(db: Session | None, environment: dict[str, Any]) -> dict[str, Any]:
    """Return effective settings and their source, with decrypted password."""
    if db is None:
        return _environment_result(environment)
    row = db.query(models.SystemSetting).filter_by(key=SETTING_KEY).first()
    if row is None:
        return _environment_result(environment)
    try:
        stored = json.loads(row.value)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("The saved LDAP configuration is invalid.") from exc
    # A saved row is one complete, authoritative record. Never backfill a
    # missing/corrupt field from APP_ENV_FILE, which could unexpectedly
    # reactivate stale directory behavior after an administrator saved it.
    result = {field: stored.get(field, _DEFAULTS[field]) for field in _FIELDS}
    result["ca_certificate_pem"] = stored.get("ca_certificate_pem", "")
    result["ca_certificate_name"] = stored.get("ca_certificate_name", "")
    metadata = stored.get("ca_certificate_metadata", [])
    result["ca_certificate_metadata"] = metadata if isinstance(metadata, list) else []
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
    certificate_pem = config.get("ca_certificate_pem") or ""
    certificate_file = config.get("ca_cert_file") or ""
    metadata = config.get("ca_certificate_metadata") or []
    if certificate_pem:
        certificate_source = "uploaded"
        certificate_name = safe_certificate_name(config.get("ca_certificate_name"))
    elif certificate_file:
        certificate_source = "server_file"
        certificate_name = safe_certificate_name(certificate_file)
    else:
        certificate_source = "system_trust"
        certificate_name = ""
    return {
        **{field: config.get(field) for field in _FIELDS if field != "ca_cert_file"},
        "ca_certificate_source": certificate_source,
        "ca_certificate_name": certificate_name,
        "ca_certificate_count": len(metadata) if certificate_pem else 0,
        "ca_certificates": metadata if certificate_pem else [],
        "bind_password_configured": bool(
            config.get("bind_password_configured") or config.get("bind_password")
        ),
        "bind_password_unavailable": bool(config.get("bind_password_unavailable")),
        "source": config.get("source", "environment"),
        "configured": bool(config.get("configured")),
        "updated_at": config.get("updated_at"),
        "fallback_file": config.get("fallback_file", ""),
    }


def apply_certificate_action(values: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Resolve a keep/replace/remove request into the internal trust fields."""
    resolved = dict(values)
    action = resolved.pop("ca_certificate_action", "keep")
    certificate_data = resolved.pop("ca_certificate_data", None)
    certificate_name = resolved.pop("ca_certificate_name", None)

    # A path supplied by a browser is meaningless inside the backend
    # container. Preserve a pre-existing server-side path only for backwards
    # compatibility with environment/bootstrap and already-saved settings.
    resolved["ca_cert_file"] = current.get("ca_cert_file", "")
    resolved["ca_certificate_pem"] = current.get("ca_certificate_pem", "")
    resolved["ca_certificate_name"] = current.get("ca_certificate_name", "")
    resolved["ca_certificate_metadata"] = current.get("ca_certificate_metadata", [])

    if action == "replace":
        if not certificate_data:
            raise CertificateValidationError(
                "Choose a CA certificate file before replacing the current trust source."
            )
        normalized_pem, metadata = normalize_base64_certificate_bundle(certificate_data)
        resolved["ca_cert_file"] = ""
        resolved["ca_certificate_pem"] = normalized_pem
        resolved["ca_certificate_name"] = safe_certificate_name(certificate_name)
        resolved["ca_certificate_metadata"] = metadata
    elif action == "remove":
        # Removing the custom source is explicit: both uploaded bytes and an
        # inherited legacy file path are cleared so ldap3 uses system trust.
        resolved["ca_cert_file"] = ""
        resolved["ca_certificate_pem"] = ""
        resolved["ca_certificate_name"] = ""
        resolved["ca_certificate_metadata"] = []
    elif action != "keep":
        raise CertificateValidationError("Unknown CA certificate action.")
    return resolved


def save(db: Session, values: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    values = apply_certificate_action(values, current)
    bind_password = values.pop("bind_password", None)
    if bind_password is None or bind_password == "":
        bind_password = current.get("bind_password", "")
    payload = {field: values[field] for field in _FIELDS}
    payload["ca_certificate_pem"] = values["ca_certificate_pem"]
    payload["ca_certificate_name"] = values["ca_certificate_name"]
    payload["ca_certificate_metadata"] = values["ca_certificate_metadata"]
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
    public_certificate = public_view(config)
    return {
        **{
            field: config.get(field)
            for field in _FIELDS
            if field not in {"bind_dn", "ca_cert_file"}
        },
        "bind_dn_configured": bool(config.get("bind_dn")),
        "bind_password_configured": bool(
            config.get("bind_password_configured") or config.get("bind_password")
        ),
        "bind_password_unavailable": bool(config.get("bind_password_unavailable")),
        "source": config.get("source"),
        "ca_certificate_source": public_certificate["ca_certificate_source"],
        "ca_certificate_name": public_certificate["ca_certificate_name"],
        "ca_certificate_count": public_certificate["ca_certificate_count"],
        "ca_certificate_fingerprints": [
            item.get("fingerprint_sha256", "")
            for item in public_certificate["ca_certificates"]
        ],
    }
