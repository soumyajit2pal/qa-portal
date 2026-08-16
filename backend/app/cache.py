"""
Redis-backed cache -- CAC-001..007 (reference-data caching) and DSH-005..007
(dashboard summary caching).

Why Redis instead of the in-process cache originally planned: once the API
runs as multiple worker processes (INF-001, 4 workers), an in-process cache
is 4 separate caches that can't see each other's writes/invalidations --
worker 2 could keep serving a stale dashboard summary for its full TTL after
worker 1 already invalidated its own copy on a write. Redis gives every
worker the same cache and the same invalidation, which is the whole point of
caching data that changes.

This module is designed to degrade to a harmless no-op cache, never to break
a request, in any of these cases:
  - the `redis` package isn't installed at all (ImportError on first use)
  - REDIS_URL isn't set (caching simply stays off)
  - Redis is unreachable / times out / errors for any other reason

That matters a lot in this codebase: there is no live Redis available in
every environment this app runs in (e.g. this sandbox, or a fresh dev
checkout before infra is provisioned), and cache reads/writes should always
be treated as a possibly-absent optimization, not a dependency the request
can fail on. Every public function below returns a safe default (None /
False / 0) instead of raising when the cache is unavailable for any reason.

Usage:
    from . import cache
    value = cache.get_json("dashboard:summary:v1")
    if value is None:
        value = _compute_expensive_thing()
        cache.set_json("dashboard:summary:v1", value, ttl_seconds=60)
    ...
    cache.delete_prefix("refdata:departments:")  # on a write that invalidates it
"""
import json
import logging
import os
import threading
from typing import Any, Optional

logger = logging.getLogger("qa_portal.cache")

REDIS_URL = os.getenv("REDIS_URL")
# Escape hatch to force caching off even with REDIS_URL set (e.g. to isolate
# a cache-related bug in production without touching the connection string).
CACHE_ENABLED = os.getenv("CACHE_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")

# Every key this app writes is namespaced under this prefix, so a shared
# Redis instance (e.g. one Redis used by more than one app) can never collide
# with, or be accidentally flushed alongside, someone else's keys.
KEY_PREFIX = "qa_portal:"

_client = None
_client_lock = threading.Lock()
_init_attempted = False
_warned_unavailable = False


def _get_client():
    """Lazily builds (once) and returns the redis client, or None if caching
    is disabled/unconfigured/unavailable. Safe to call from any request --
    never raises."""
    global _client, _init_attempted, _warned_unavailable
    if _client is not None:
        return _client
    if not CACHE_ENABLED or not REDIS_URL:
        return None
    with _client_lock:
        if _client is not None or _init_attempted:
            return _client
        _init_attempted = True
        try:
            import redis  # local import -- optional dependency, see module docstring
        except ImportError:
            if not _warned_unavailable:
                logger.warning(
                    "REDIS_URL is set but the 'redis' package is not installed; "
                    "caching is disabled. Run `pip install -r requirements.txt`."
                )
                _warned_unavailable = True
            return None
        try:
            client = redis.Redis.from_url(
                REDIS_URL,
                socket_connect_timeout=2,
                socket_timeout=2,
                decode_responses=True,
            )
            client.ping()
        except Exception:
            if not _warned_unavailable:
                logger.warning("Redis at %s is unreachable; caching is disabled.", _masked(REDIS_URL), exc_info=True)
                _warned_unavailable = True
            return None
        logger.info("Connected to Redis for caching.")
        _client = client
        return _client


def _masked(url: str) -> str:
    # Same spirit as database.py's mask_database_url -- don't let a
    # redis://user:password@host URL's credentials reach the log file.
    if "@" not in url:
        return url
    scheme_and_creds, _, rest = url.rpartition("@")
    scheme = scheme_and_creds.split("://", 1)[0] if "://" in scheme_and_creds else ""
    return f"{scheme}://***@{rest}" if scheme else f"***@{rest}"


def _key(key: str) -> str:
    return f"{KEY_PREFIX}{key}"


def available() -> bool:
    """True if a live, pingable Redis connection is currently in hand.
    Useful for /api/health (INF-003) to report cache status without forcing
    a new connection attempt on every health check."""
    return _client is not None


def ping() -> bool:
    """Actively checks connectivity (may attempt to (re)connect). Distinct
    from `available()`, which only reports the last-known state."""
    client = _get_client()
    if client is None:
        return False
    try:
        return bool(client.ping())
    except Exception:
        return False


def get_json(key: str) -> Optional[Any]:
    client = _get_client()
    if client is None:
        return None
    try:
        raw = client.get(_key(key))
    except Exception:
        logger.warning("Redis GET failed for key=%s; treating as cache miss.", key, exc_info=True)
        return None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("Redis GET returned non-JSON value for key=%s; treating as cache miss.", key)
        return None


def set_json(key: str, value: Any, ttl_seconds: int) -> bool:
    client = _get_client()
    if client is None:
        return False
    try:
        client.set(_key(key), json.dumps(value, default=str, ensure_ascii=False), ex=max(1, ttl_seconds))
        return True
    except Exception:
        logger.warning("Redis SET failed for key=%s; continuing without caching this value.", key, exc_info=True)
        return False


def delete(*keys: str) -> int:
    """Deletes one or more exact keys. Missing keys are silently ignored
    (matches Redis DEL semantics)."""
    if not keys:
        return 0
    client = _get_client()
    if client is None:
        return 0
    try:
        return client.delete(*(_key(k) for k in keys))
    except Exception:
        logger.warning("Redis DEL failed for keys=%s.", keys, exc_info=True)
        return 0


def try_acquire_lock(key: str, ttl_seconds: int = 300) -> bool:
    """Best-effort distributed lock (`SET key 1 NX EX ttl`) -- INF-001 runs
    multiple API worker *processes*, so any one-time startup side effect
    (see main.py's startup migration block) would otherwise run
    once per worker instead of once per deployment. Returns True if the
    caller now holds the lock (i.e. should proceed with the guarded work).

    Deliberately PERMISSIVE when Redis is unavailable (package missing,
    unset, unreachable): returns True unconditionally rather than blocking
    startup on a cache that may not be provisioned. That matches this app's
    behavior before this lock existed (every worker just did the work), so
    running without Redis is not made any worse -- it just loses the
    "exactly once" guarantee, same as always. Provision Redis to get that
    guarantee under multiple workers (see INF-001)."""
    client = _get_client()
    if client is None:
        return True
    try:
        return bool(client.set(_key(key), "1", nx=True, ex=max(1, ttl_seconds)))
    except Exception:
        logger.warning("Redis lock acquisition failed for key=%s; proceeding as if acquired.", key, exc_info=True)
        return True


def delete_prefix(prefix: str) -> int:
    """Deletes every key under this app's namespace starting with `prefix`
    (e.g. "refdata:departments:" to invalidate every cached page/variant of
    that reference data at once). Uses SCAN rather than KEYS -- KEYS blocks
    the whole Redis instance while it walks the entire keyspace, which is
    exactly the kind of latency spike a cache is supposed to avoid causing."""
    client = _get_client()
    if client is None:
        return 0
    pattern = f"{_key(prefix)}*"
    deleted = 0
    try:
        for found_key in client.scan_iter(match=pattern, count=200):
            deleted += client.delete(found_key)
    except Exception:
        logger.warning("Redis SCAN/DEL failed for prefix=%s.", prefix, exc_info=True)
    return deleted
