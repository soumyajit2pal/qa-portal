"""Runtime upload-root configuration shared by every document endpoint.

Reported: "upload storage not working, though updating the path, its
reverting old one" + "while trying to download documents getting file is
missing on disk".

Root cause: `_active_root`/`_legacy_roots` used to be plain module-level
globals, set once at process/import time (`configure_upload_storage(...)` at
the bottom of this file, and again at app startup from `load_storage_
settings`) and refreshed ONLY when a `PATCH /api/system-settings/storage`
happened to be handled by that exact process. `qap_system_settings` (the DB
row) was always correctly written -- `db.commit()` in `system_settings.py`
never had a bug -- but in any deployment running more than one backend
process (multiple uvicorn workers, multiple replicas/containers behind a
load balancer, or simply a process restart between an admin's save and a
later request landing on a different process), every OTHER process kept
serving its own stale in-memory copy indefinitely. That produces exactly the
two reported symptoms as one shared bug:
  - Symptom 1: an admin's save commits fine, but the next GET (or the same
    admin reloading the page) can land on a different process that never
    saw the PATCH and still reports the old path -- looks like it "reverted"
    even though nothing was ever lost.
  - Symptom 2: a file uploaded via the process that picked up the NEW path
    is later looked up for download by a different process still using the
    OLD active root/legacy-roots list -- resolve_upload_path() searches
    roots that don't include where the file actually landed and reports
    "file is missing on disk" even though it exists on shared storage.

Fix: the DB is now consulted on every read, not just at startup/on-PATCH,
bounded by a short TTL cache (a couple of seconds) so a tight loop over many
documents (e.g. qa_requests.py's _finalize_child_requests, which resolves a
whole request's worth of evidence paths in one pass) doesn't turn into one
DB round-trip per file. This guarantees every process converges on the same
value within a couple of seconds of any save, instead of never.
"""
import json
import os
import tempfile
import time
from typing import Iterable
from .database import SessionLocal
from . import models

DEFAULT_UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
UPLOAD_PATH_KEY = "upload_path"
LEGACY_PATHS_KEY = "upload_legacy_paths"

# See this module's own docstring -- short enough that a save is visible
# everywhere within a couple of seconds, long enough that resolving many
# files in one request doesn't re-query per file.
_CACHE_TTL_SECONDS = 2.0

_active_root = os.path.abspath(DEFAULT_UPLOAD_ROOT)
_legacy_roots: list[str] = []
_cached_at = 0.0


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


def _refresh_from_db() -> None:
    """Re-reads the DB-authoritative value into this process's short-lived
    cache. Deferred imports avoid any import-time cycle with database.py/
    models.py (storage_config is imported very early, by documents.py).
    Never raises -- a transient DB hiccup should not break every file
    operation in the app; this process just keeps using whatever it last
    successfully read (or the built-in default, on the very first call)
    until the next refresh succeeds."""
    global _active_root, _legacy_roots, _cached_at
    db = SessionLocal()
    try:
        path_row = db.query(models.SystemSetting).filter_by(key=UPLOAD_PATH_KEY).first()
        legacy_row = db.query(models.SystemSetting).filter_by(key=LEGACY_PATHS_KEY).first()
        active = os.path.abspath(path_row.value) if path_row and path_row.value else DEFAULT_UPLOAD_ROOT
        try:
            legacy = json.loads(legacy_row.value) if legacy_row and legacy_row.value else []
        except (TypeError, ValueError):
            legacy = []
        _active_root = active
        _legacy_roots = [os.path.abspath(root) for root in legacy if root and os.path.abspath(root) != active]
    except Exception:
        pass
    finally:
        _cached_at = time.monotonic()
        db.close()


def _ensure_fresh() -> None:
    if time.monotonic() - _cached_at >= _CACHE_TTL_SECONDS:
        _refresh_from_db()


def configure_upload_storage(active_root: str, legacy_roots: Iterable[str] = ()) -> None:
    """Validates the given path (creates it, checks it's writable) and
    immediately updates this process's cache -- called at startup
    (load_storage_settings) and right after a successful PATCH, so the
    process that actually handled the save reflects it instantly rather
    than waiting out the TTL. Every other process picks it up within
    _CACHE_TTL_SECONDS regardless, via _ensure_fresh() above."""
    global _active_root, _legacy_roots, _cached_at
    _active_root = validate_upload_root(active_root)
    _legacy_roots = [os.path.abspath(root) for root in legacy_roots if root and os.path.abspath(root) != _active_root]
    _cached_at = time.monotonic()


def get_upload_root() -> str:
    _ensure_fresh()
    return _active_root


def get_legacy_roots() -> list[str]:
    _ensure_fresh()
    return list(_legacy_roots)


def resolve_upload_path(relative_path: str) -> str:
    _ensure_fresh()
    for root in [_active_root, *_legacy_roots]:
        candidate = os.path.join(root, relative_path)
        if os.path.exists(candidate):
            return candidate
    return os.path.join(_active_root, relative_path)


configure_upload_storage(DEFAULT_UPLOAD_ROOT)
