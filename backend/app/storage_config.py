"""Runtime upload-root configuration shared by every document endpoint."""
import os
import tempfile
from typing import Iterable

DEFAULT_UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
_active_root = os.path.abspath(DEFAULT_UPLOAD_ROOT)
_legacy_roots: list[str] = []


def validate_upload_root(path: str) -> str:
    normalized = os.path.abspath(os.path.expanduser((path or "").strip()))
    if not path or not os.path.isabs(os.path.expanduser(path.strip())):
        raise ValueError("Upload path must be an absolute server filesystem path")
    os.makedirs(normalized, exist_ok=True)
    try:
        with tempfile.NamedTemporaryFile(prefix=".qa-storage-test-", dir=normalized, delete=True):
            pass
    except OSError as exc:
        raise ValueError(f"Upload path is not writable: {exc}") from exc
    return normalized


def configure_upload_storage(active_root: str, legacy_roots: Iterable[str] = ()) -> None:
    global _active_root, _legacy_roots
    _active_root = validate_upload_root(active_root)
    _legacy_roots = [os.path.abspath(root) for root in legacy_roots if root and os.path.abspath(root) != _active_root]


def get_upload_root() -> str:
    return _active_root


def get_legacy_roots() -> list[str]:
    return list(_legacy_roots)


def resolve_upload_path(relative_path: str) -> str:
    for root in [_active_root, *_legacy_roots]:
        candidate = os.path.join(root, relative_path)
        if os.path.exists(candidate):
            return candidate
    return os.path.join(_active_root, relative_path)


configure_upload_storage(DEFAULT_UPLOAD_ROOT)
