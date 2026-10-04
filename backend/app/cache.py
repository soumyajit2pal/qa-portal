"""Optional shared Redis cache with generation fencing and bounded fills.

Workflow authority stays in Oracle. Redis failures bypass caching, and a
reader can only publish while its generation and owned fill lease still
match, so committed invalidation cannot be undone by an older reader.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import logging
import threading
import time
import uuid
from typing import Any, Callable, Optional
from fastapi.encoders import jsonable_encoder

from .config import settings
from .resilience import CircuitOpenError, redis_circuit

try:
    from redis.backoff import NoBackoff
    from redis.retry import Retry
except ImportError:
    NoBackoff = Retry = None

logger = logging.getLogger("qa_portal.cache")
REDIS_URL = settings.redis_url
CACHE_ENABLED = settings.cache_enabled
KEY_PREFIX = f"qualityops:{settings.app_env}:cache:"
DASHBOARD_FAMILY = "dashboard"
DEPARTMENTS_FAMILY = "refdata:departments"
APPLICATIONS_FAMILY = "refdata:application-names"
CHECKLIST_FAMILY = "refdata:checklist-items"
REQUEST_TYPES_FAMILY = "refdata:request-types"

_client = None
_client_lock = threading.Lock()
_next_init_at = 0.0
INIT_RETRY_SECONDS = float(getattr(settings, "cache_init_retry_seconds", 15))
_warned_unavailable = False
_metrics_lock = threading.Lock()
_counters = Counter()
_operation_counts = Counter()
_operation_time_ms = Counter()
_last_success_at = None
_last_failure_at = None
_connected = False
_dirty_families = set()
_dirty_lock = threading.Lock()

# Compare and publish in one Redis operation. A lost lease or changed
# generation never permits writing an obsolete value or releasing a new
# owner's lock. Cache data expires; generations use random tokens and do not.
_PUBLISH_SCRIPT = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('DEL', KEYS[2])
return 1
"""
_RELEASE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def _setting(name, default):
    return getattr(settings, name, default)


def _count(name, amount=1):
    with _metrics_lock:
        _counters[name] += amount


def _record(operation, started, successful, *, error=False):
    global _connected, _last_success_at, _last_failure_at
    elapsed = max(0, (time.perf_counter() - started) * 1000)
    with _metrics_lock:
        _operation_counts[operation] += 1
        _operation_time_ms[operation] += elapsed
        if successful:
            _connected = True
            _last_success_at = datetime.now(timezone.utc).isoformat()
        elif error:
            _connected = False
            _last_failure_at = datetime.now(timezone.utc).isoformat()
            _counters["errors"] += 1
    if successful:
        redis_circuit.record_success()
    elif error:
        redis_circuit.record_failure()


def _cache_circuit_allows() -> bool:
    try:
        redis_circuit.check()
        return True
    except CircuitOpenError:
        _count("circuit_bypasses")
        return False


def _cache_failure(operation: str, exc: Exception, started=None) -> None:
    _record(operation, started if started is not None else time.perf_counter(), False, error=True)
    # Exceptions may contain server connection details; keep logs useful
    # without exposing a configured URL, credentials or cached payloads.
    logger.warning("Redis %s failed; bypassing cache (%s).", operation, type(exc).__name__)


def _get_client():
    """Resolve backoff and no-I/O exits before reserving a circuit probe."""
    global _client, _warned_unavailable, _next_init_at
    if not CACHE_ENABLED or not REDIS_URL:
        return None
    if _client is not None:
        return _client if _cache_circuit_allows() else None
    with _client_lock:
        if _client is not None:
            return _client if _cache_circuit_allows() else None
        if time.monotonic() < _next_init_at:
            return None
        try:
            import redis
        except ImportError:
            _next_init_at = time.monotonic() + INIT_RETRY_SECONDS
            if not _warned_unavailable:
                logger.warning("Redis package is unavailable; caching is bypassed.")
                _warned_unavailable = True
            return None
        if not _cache_circuit_allows():
            return None
        _next_init_at = time.monotonic() + INIT_RETRY_SECONDS
        started = time.perf_counter()
        try:
            # Explicitly disable automatic Redis command retries: optional
            # caching must have a small, predictable request latency budget.
            options = dict(
                socket_connect_timeout=float(_setting("cache_socket_connect_timeout_seconds", .25)),
                socket_timeout=float(_setting("cache_socket_timeout_seconds", .25)),
                max_connections=int(_setting("cache_max_connections", 32)),
                health_check_interval=30,
                decode_responses=True,
                retry_on_timeout=False,
            )
            if Retry is not None:
                options["retry"] = Retry(NoBackoff(), int(_setting("cache_retry_attempts", 0)))
            client = redis.Redis.from_url(REDIS_URL, **options)
            if not client.ping():
                raise ConnectionError("Redis initialization ping returned false")
        except Exception as exc:
            _cache_failure("connect", exc, started)
            return None
        _record("connect", started, True)
        _client = client
        _warned_unavailable = False
        return client


def _masked(url: str) -> str:
    if "@" not in url:
        return url
    scheme_and_creds, _, rest = url.rpartition("@")
    scheme = scheme_and_creds.split("://", 1)[0] if "://" in scheme_and_creds else ""
    return f"{scheme}://***@{rest}" if scheme else f"***@{rest}"


def _key(key: str) -> str:
    return f"{KEY_PREFIX}{key}"


def _call(operation, action):
    client = _get_client()
    if client is None:
        _count("bypasses")
        return False, None
    started = time.perf_counter()
    try:
        value = action(client)
    except Exception as exc:
        _cache_failure(operation, exc, started)
        return False, None
    _record(operation, started, True)
    return True, value


def available() -> bool:
    """Report the outcome of recent I/O rather than allocated-client state."""
    with _metrics_lock:
        return bool(CACHE_ENABLED and REDIS_URL and _connected)


def health_snapshot() -> dict:
    with _metrics_lock:
        state = "disabled" if not CACHE_ENABLED or not REDIS_URL else (
            "connected" if _connected else "unreachable" if _last_failure_at else "not_connected")
        operations = {
            name: {"count": count, "total_ms": round(_operation_time_ms[name], 3),
                   "average_ms": round(_operation_time_ms[name] / count, 3)}
            for name, count in _operation_counts.items()
        }
        result = {
            "enabled": bool(CACHE_ENABLED), "configured": bool(REDIS_URL),
            "status": state, "last_success_at": _last_success_at, "last_failure_at": _last_failure_at,
            "counters": dict(_counters), "operations": operations,
        }
    snap = redis_circuit.snapshot()
    result["circuit"] = {"state": snap.state, "consecutive_failures": snap.consecutive_failures,
                         "retry_after_seconds": snap.retry_after_seconds}
    return result


def ping() -> bool:
    ok, value = _call("ping", lambda client: client.ping())
    return bool(ok and value)


def _decode(raw):
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        _count("invalid_values")
        return None


def get_json(key: str) -> Optional[Any]:
    ok, raw = _call("get", lambda client: client.get(_key(key)))
    value = _decode(raw) if ok else None
    _count("hits" if value is not None else "misses")
    return value


def set_json(key: str, value: Any, ttl_seconds: int) -> bool:
    try:
        encoded = json.dumps(jsonable_encoder(value), ensure_ascii=False)
        ttl = max(1, int(ttl_seconds))
    except (TypeError, ValueError, OverflowError):
        _count("serialization_errors")
        return False
    ok, _ = _call("set", lambda client: client.set(_key(key), encoded, ex=ttl))
    return ok


def delete(*keys: str) -> int:
    if not keys:
        return 0
    ok, deleted = _call("delete", lambda client: client.delete(*(_key(key) for key in keys)))
    return int(deleted or 0) if ok else 0


def try_acquire_lock(key: str, ttl_seconds: int = 300) -> bool:
    ok, acquired = _call("lock", lambda client: client.set(_key(key), "1", nx=True, ex=max(1, ttl_seconds)))
    return bool(ok and acquired)


def delete_prefix(prefix: str) -> int:
    """Legacy cleanup uses bounded batches rather than one round trip per key."""
    def remove(client):
        deleted, batch = 0, []
        for found in client.scan_iter(match=f"{_key(prefix)}*", count=200):
            batch.append(found)
            if len(batch) == 200:
                deleted += client.delete(*batch)
                batch.clear()
        if batch:
            deleted += client.delete(*batch)
        return deleted
    ok, deleted = _call("scan_delete", remove)
    return int(deleted or 0) if ok else 0


def invalidate(*families: str) -> bool:
    """Fence every pre-commit reader out of the next generation atomically."""
    unique = tuple(dict.fromkeys(families))
    if not unique:
        return True
    versions = {_key(f"generation:{family}"): uuid.uuid4().hex for family in unique}
    ok, _ = _call("invalidate", lambda client: client.mset(versions))
    with _dirty_lock:
        if ok:
            _dirty_families.difference_update(unique)
        else:
            _dirty_families.update(unique)
    _count("invalidations" if ok else "invalidation_failures", len(unique))
    return ok


def _generation(family):
    with _dirty_lock:
        dirty = family in _dirty_families
    if dirty and not invalidate(family):
        return None
    generation_key = _key(f"generation:{family}")
    def resolve(client):
        value = client.get(generation_key)
        if value is not None:
            return str(value)
        client.set(generation_key, uuid.uuid4().hex, nx=True)
        return client.get(generation_key)
    ok, value = _call("generation", resolve)
    return str(value) if ok and value is not None else None


def cached_json(family: str, key: str, loader: Callable[[], Any], ttl_seconds: int) -> Any:
    """Coordinated read-through cache; unavailable or busy falls back to DB.

    Cache hits are isolated by family generation and caller-provided scope.
    A busy reader waits briefly for the leader, then computes without
    publishing. Values produced after lease expiry or invalidation cannot
    repopulate the active generation.
    """
    generation = _generation(family)
    if generation is None:
        return loader()
    digest = hashlib.sha256(key.encode()).hexdigest()
    value_key = _key(f"data:{family}:{generation}:{digest}")
    lock_key = _key(f"fill:{family}:{generation}:{digest}")
    generation_key = _key(f"generation:{family}")
    ok, raw = _call("get", lambda client: client.get(value_key))
    value = _decode(raw) if ok else None
    if value is not None:
        _count("hits")
        return value
    _count("misses")
    if not ok:
        return loader()
    token = uuid.uuid4().hex
    ok, acquired = _call("fill_lock", lambda client: client.set(lock_key, token, nx=True,
        ex=max(1, int(_setting("cache_fill_lock_ttl_seconds", 15)))))
    if not ok:
        return loader()
    if not acquired:
        _count("fill_waits")
        deadline = time.monotonic() + float(_setting("cache_fill_wait_seconds", .15))
        while time.monotonic() < deadline:
            time.sleep(min(.02, max(0, deadline - time.monotonic())))
            ok, raw = _call("get", lambda client: client.get(value_key))
            value = _decode(raw) if ok else None
            if value is not None:
                # A commit during the wait can make this old key obsolete.
                if _generation(family) == generation:
                    _count("coalesced_hits")
                    return value
                break
            if not ok:
                break
        _count("fill_timeouts")
        return loader()
    _count("fill_leaders")
    try:
        # Recheck once after acquiring: a fast prior leader could have filled
        # and released between our initial GET and lock acquisition.
        ok, raw = _call("get", lambda client: client.get(value_key))
        value = _decode(raw) if ok else None
        if value is not None:
            return value
        value = loader()
        try:
            encoded = json.dumps(jsonable_encoder(value), ensure_ascii=False)
            ttl = max(1, int(ttl_seconds))
        except (TypeError, ValueError, OverflowError):
            _count("serialization_errors")
            return value
        ok, published = _call("publish", lambda client: client.eval(_PUBLISH_SCRIPT, 3,
            generation_key, lock_key, value_key, generation, token, encoded, ttl))
        if ok and not published:
            _count("fenced_fills")
        return value
    finally:
        _call("release_lock", lambda client: client.eval(_RELEASE_SCRIPT, 1, lock_key, token))
