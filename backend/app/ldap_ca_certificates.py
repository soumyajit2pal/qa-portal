"""Validation and normalization for administrator-uploaded LDAP CA bundles.

The browser sends certificate bytes as strict base64.  This module deliberately
does not use the supplied filename or content type to decide what the file is:
only successfully parsed X.509 certificates are accepted.
"""
from __future__ import annotations

import base64
import binascii
import datetime
import hashlib
import re
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from .time_format import IST


MAX_CERTIFICATE_BYTES = 1024 * 1024
MAX_CERTIFICATES = 20
MAX_BASE64_LENGTH = 4 * ((MAX_CERTIFICATE_BYTES + 2) // 3)

_PRIVATE_KEY_MARKER = re.compile(
    br"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----",
    re.IGNORECASE,
)
_PEM_CERTIFICATE = re.compile(
    br"-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+?"
    br"-----END CERTIFICATE-----",
)


class CertificateValidationError(ValueError):
    """A stable, user-correctable validation error for an uploaded CA file."""


def decode_certificate_data(value: str) -> bytes:
    """Decode a strict base64 payload without permitting an oversized upload."""
    if not value:
        raise CertificateValidationError("Choose a CA certificate file to upload.")
    if len(value) > MAX_BASE64_LENGTH:
        raise CertificateValidationError("The CA certificate file must be 1 MiB or smaller.")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CertificateValidationError("The CA certificate data is not valid base64.") from exc
    if not decoded:
        raise CertificateValidationError("The CA certificate file is empty.")
    if len(decoded) > MAX_CERTIFICATE_BYTES:
        raise CertificateValidationError("The CA certificate file must be 1 MiB or smaller.")
    return decoded


def _parse_certificates(data: bytes) -> list[x509.Certificate]:
    if _PRIVATE_KEY_MARKER.search(data):
        raise CertificateValidationError("Private keys are not allowed in a CA certificate upload.")

    if b"-----BEGIN" in data or b"-----END" in data:
        blocks = list(_PEM_CERTIFICATE.finditer(data))
        if not blocks:
            raise CertificateValidationError("The uploaded PEM does not contain an X.509 certificate.")
        # Reject unknown PEM objects and non-whitespace text rather than
        # silently discarding material the administrator believed was used.
        remainder = _PEM_CERTIFICATE.sub(b"", data)
        if remainder.strip():
            raise CertificateValidationError(
                "The PEM file may contain only X.509 CA certificate blocks."
            )
        certificates: list[x509.Certificate] = []
        for block in blocks:
            try:
                certificates.append(x509.load_pem_x509_certificate(block.group(0)))
            except ValueError as exc:
                raise CertificateValidationError("The uploaded PEM certificate is malformed.") from exc
        return certificates

    try:
        return [x509.load_der_x509_certificate(data)]
    except ValueError as exc:
        raise CertificateValidationError(
            "Upload a PEM certificate bundle or a DER-encoded X.509 certificate."
        ) from exc


def _certificate_time(certificate: x509.Certificate, field: str) -> datetime.datetime:
    aware_field = f"{field}_utc"
    value = getattr(certificate, aware_field, None)
    if value is None:
        value = getattr(certificate, field).replace(tzinfo=datetime.UTC)
    return value.astimezone(datetime.UTC)


def _validate_ca_certificate(certificate: x509.Certificate, now: datetime.datetime) -> None:
    try:
        extensions = certificate.extensions
    except (x509.DuplicateExtension, ValueError) as exc:
        # cryptography defers decoding some extension structures until this
        # property is accessed. Treat duplicate or otherwise malformed
        # extensions as an administrator-correctable upload error instead of
        # allowing an unexpected 500 response from the settings endpoints.
        raise CertificateValidationError(
            "The uploaded X.509 certificate extensions are invalid."
        ) from exc

    try:
        constraints = extensions.get_extension_for_class(
            x509.BasicConstraints
        ).value
    except x509.ExtensionNotFound as exc:
        raise CertificateValidationError(
            "Every uploaded certificate must include CA=true Basic Constraints."
        ) from exc
    if not constraints.ca:
        raise CertificateValidationError(
            "Every uploaded certificate must be a CA certificate (Basic Constraints CA=true)."
        )

    try:
        key_usage = extensions.get_extension_for_class(x509.KeyUsage).value
    except x509.ExtensionNotFound:
        key_usage = None
    if key_usage is not None and not key_usage.key_cert_sign:
        raise CertificateValidationError(
            "Every uploaded CA certificate with Key Usage must permit certificate signing."
        )

    not_before = _certificate_time(certificate, "not_valid_before")
    not_after = _certificate_time(certificate, "not_valid_after")
    if now < not_before:
        raise CertificateValidationError("The uploaded CA certificate is not valid yet.")
    if now > not_after:
        raise CertificateValidationError("The uploaded CA certificate has expired.")


def normalize_certificate_bundle(
    data: bytes,
    *,
    now: datetime.datetime | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Return canonical PEM plus non-sensitive metadata for a valid CA bundle."""
    if not data:
        raise CertificateValidationError("The CA certificate file is empty.")
    if len(data) > MAX_CERTIFICATE_BYTES:
        raise CertificateValidationError("The CA certificate file must be 1 MiB or smaller.")
    certificates = _parse_certificates(data)
    if len(certificates) > MAX_CERTIFICATES:
        raise CertificateValidationError(
            f"A CA certificate bundle may contain at most {MAX_CERTIFICATES} certificates."
        )
    validation_time = now or datetime.datetime.now(datetime.UTC)
    if validation_time.tzinfo is None:
        validation_time = validation_time.replace(tzinfo=datetime.UTC)
    else:
        validation_time = validation_time.astimezone(datetime.UTC)

    fingerprints: set[str] = set()
    normalized_parts: list[str] = []
    metadata: list[dict[str, Any]] = []
    for certificate in certificates:
        _validate_ca_certificate(certificate, validation_time)
        fingerprint = certificate.fingerprint(hashes.SHA256()).hex().upper()
        if fingerprint in fingerprints:
            raise CertificateValidationError(
                "The CA certificate bundle contains a duplicate certificate."
            )
        fingerprints.add(fingerprint)
        normalized_parts.append(
            certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")
        )
        metadata.append({
            "fingerprint_sha256": fingerprint,
            "subject": certificate.subject.rfc4514_string(),
            "issuer": certificate.issuer.rfc4514_string(),
            "not_valid_before": _certificate_time(
                certificate, "not_valid_before"
            ).astimezone(IST).isoformat(),
            "not_valid_after": _certificate_time(
                certificate, "not_valid_after"
            ).astimezone(IST).isoformat(),
        })
    return "".join(normalized_parts), metadata


def normalize_base64_certificate_bundle(value: str) -> tuple[str, list[dict[str, Any]]]:
    return normalize_certificate_bundle(decode_certificate_data(value))


def safe_certificate_name(value: str | None) -> str:
    """Keep a display-only basename, never a browser-supplied local path."""
    candidate = (value or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    candidate = "".join(character for character in candidate if character.isprintable())
    return candidate[:255] or "uploaded-ca.pem"


def certificate_metadata_fingerprint(metadata: list[dict[str, Any]]) -> str:
    """A compact deterministic bundle fingerprint for logs and comparisons."""
    joined = "\n".join(item.get("fingerprint_sha256", "") for item in metadata)
    return hashlib.sha256(joined.encode("ascii")).hexdigest().upper() if joined else ""
