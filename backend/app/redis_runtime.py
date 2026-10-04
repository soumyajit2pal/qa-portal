"""Required Redis coordination, isolated from the optional read cache.

Queues, admission limits and scheduler leases must never silently succeed
when their Redis commands fail. Callers retain Oracle transactions as the
source of truth and translate coordination outages into explicit retryable
responses. No cached business data or credentials are stored here.
"""
from __future__ import annotations

import threading
import time
import uuid

from .config import settings


class RedisUnavailable(RuntimeError):
    """A required coordination operation could not be completed."""


_client = None
_client_lock = threading.Lock()
_state_lock = threading.Lock()
_last_success_at = None
_last_failure_at = None
_failures = 0
_RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end"
_RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"


def coordination_key(value: str) -> str:
    prefix = f"qualityops:{settings.app_env}:control:"
    return value if value.startswith(prefix) else prefix + value


def _success() -> None:
    global _last_success_at
    with _state_lock:
        _last_success_at = time.time()


def _failure() -> None:
    global _last_failure_at, _failures
    with _state_lock:
        _last_failure_at = time.time()
        _failures += 1


def get_client():
    """Return the bounded per-process coordination pool, or fail explicitly.

Command callers must also handle Redis errors: an initialized pool does not
guarantee that a later operation can reach the server.
"""
    global _client
    if not settings.redis_coordination_url:
        raise RedisUnavailable("Shared worker coordination is not configured")
    if _client is not None:
        return _client
    with _client_lock:
        if _client is not None:
            return _client
        candidate = None
        try:
            import redis
            from redis.backoff import NoBackoff
            from redis.retry import Retry

            candidate = redis.Redis.from_url(
                settings.redis_coordination_url,
                decode_responses=True,
                max_connections=settings.redis_coordination_max_connections,
                socket_connect_timeout=settings.redis_coordination_connect_timeout_seconds,
                socket_timeout=settings.redis_coordination_socket_timeout_seconds,
                socket_keepalive=True,
                health_check_interval=30,
                retry=Retry(NoBackoff(), 0),
            )
            candidate.ping()
        except Exception as exc:
            if candidate is not None:
                candidate.close()
            _failure()
            raise RedisUnavailable("Shared worker coordination is temporarily unavailable") from exc
        _client = candidate
        _success()
        return _client


def acquire_lease(key: str, ttl_seconds: int) -> str | None:
    token = uuid.uuid4().hex
    try:
        acquired = get_client().set(coordination_key(key), token, nx=True, ex=max(1, int(ttl_seconds)))
        _success()
        return token if acquired else None
    except Exception as exc:
        _failure()
        raise RedisUnavailable("Shared worker lease is temporarily unavailable") from exc


def renew_lease(key: str, token: str, ttl_seconds: int) -> bool:
    try:
        renewed = bool(get_client().eval(_RENEW, 1, coordination_key(key), token, max(1, int(ttl_seconds)) * 1000))
        _success()
        return renewed
    except Exception as exc:
        _failure()
        raise RedisUnavailable("Shared worker lease could not be renewed") from exc


def release_lease(key: str, token: str) -> bool:
    try:
        released = bool(get_client().eval(_RELEASE, 1, coordination_key(key), token))
        _success()
        return released
    except Exception as exc:
        _failure()
        raise RedisUnavailable("Shared worker lease could not be released") from exc


def health_snapshot() -> dict:
    with _state_lock:
        return {
            "configured": bool(settings.redis_coordination_url),
            "last_success_at": _last_success_at,
            "last_failure_at": _last_failure_at,
            "failures": _failures,
            "max_connections_per_process": settings.redis_coordination_max_connections,
        }
