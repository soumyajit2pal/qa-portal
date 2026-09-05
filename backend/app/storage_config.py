"""Deployment-controlled upload storage shared by every document endpoint.

The upload root is fixed for the lifetime of the process. In Docker it is
supplied by ``UPLOAD_STORAGE_ROOT`` and backed by the volume or bind mount
declared in Compose. It is not configurable through the UI or database.
"""
import os
import tempfile

from .config import settings


# Containers set this to their durable volume mount. Local development keeps
# the historical app/uploads directory unless the environment overrides it.
DEFAULT_UPLOAD_ROOT = os.path.abspath(os.getenv(
    "UPLOAD_STORAGE_ROOT",
    settings.upload_storage_root or os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads"),
))


def validate_upload_root(path: str) -> str:
    """Create the configured directory and fail fast when it is not writable."""
    normalized = os.path.abspath(os.path.expanduser((path or "").strip()))
    if not path or not os.path.isabs(os.path.expanduser(path.strip())):
        raise ValueError("UPLOAD_STORAGE_ROOT must be an absolute server filesystem path")
    os.makedirs(normalized, exist_ok=True)
    try:
        with tempfile.NamedTemporaryFile(prefix=".qa-storage-test-", dir=normalized, delete=True):
            pass
    except OSError as exc:
        raise ValueError(f"UPLOAD_STORAGE_ROOT is not writable: {exc}") from exc
    return normalized


_UPLOAD_ROOT = validate_upload_root(DEFAULT_UPLOAD_ROOT)


def get_upload_root() -> str:
    return _UPLOAD_ROOT


def resolve_upload_path(relative_path: str) -> str:
    candidate = os.path.abspath(os.path.join(_UPLOAD_ROOT, relative_path or ""))
    if os.path.commonpath((_UPLOAD_ROOT, candidate)) != _UPLOAD_ROOT:
        raise ValueError("Stored upload path escapes UPLOAD_STORAGE_ROOT")
    return candidate
