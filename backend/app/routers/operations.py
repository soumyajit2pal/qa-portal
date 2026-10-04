"""Administrator-only Redis diagnostics and scrapeable capacity metrics."""
from __future__ import annotations

import os
import re
import time

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse

from .. import cache, redis_runtime, request_metrics
from ..config import settings
from ..constants import Role
from ..deps import require_roles

router = APIRouter(prefix="/api/operations", tags=["operations"])

_INFO_FIELDS = (
    "redis_version", "uptime_in_seconds", "connected_clients", "blocked_clients", "maxclients",
    "used_memory", "used_memory_rss", "used_memory_peak", "used_memory_dataset", "maxmemory",
    "maxmemory_policy", "mem_fragmentation_ratio", "mem_not_counted_for_evict",
    "instantaneous_ops_per_sec", "total_commands_processed", "total_connections_received",
    "rejected_connections", "keyspace_hits", "keyspace_misses", "evicted_keys", "expired_keys",
    "used_cpu_sys", "used_cpu_user", "aof_enabled", "aof_last_write_status", "aof_last_bgrewrite_status",
)


def _server_info(client) -> dict:
    started = time.perf_counter()
    raw = client.info()
    result = {key: raw[key] for key in _INFO_FIELDS if key in raw}
    result["info_latency_ms"] = round((time.perf_counter() - started) * 1000, 3)
    hits = int(raw.get("keyspace_hits", 0))
    misses = int(raw.get("keyspace_misses", 0))
    result["server_keyspace_hit_ratio"] = hits / (hits + misses) if hits + misses else None
    result["keys"] = sum(value.get("keys", 0) for key, value in raw.items()
                         if re.fullmatch(r"db\d+", key) and isinstance(value, dict))
    return result


def redis_snapshot() -> dict:
    """INFO is read on demand in a sync route thread, never in liveness probes.

Server keyspace counters include generation/lock reads. Application cache
hit counters below describe actual response reuse and belong to this PID.
No keys, Redis URLs, queued payloads or credentials are returned.
"""
    ok, info = cache._call("info", _server_info) if cache.CACHE_ENABLED and cache.REDIS_URL else (False, None)
    cache_result = {"client": cache.health_snapshot(), "server": info if ok else None}
    control_result = {"client": redis_runtime.health_snapshot(), "server": None,
                      "status": "unconfigured" if not settings.redis_coordination_url else "unreachable"}
    if settings.redis_coordination_url:
        try:
            control_result["server"] = _server_info(redis_runtime.get_client())
            control_result["status"] = "connected"
            redis_runtime._success()
        except Exception:
            redis_runtime._failure()
        control_result["client"] = redis_runtime.health_snapshot()
    queue = {"backend": settings.job_queue_backend}
    if settings.job_queue_backend == "redis" and control_result["status"] == "connected":
        from . import jobs
        try:
            queue.update(jobs.queue_snapshot())
        except Exception:
            queue["status"] = "unavailable"
    return {"process_id": os.getpid(), "cache_counters_scope": "process",
            "cache": cache_result, "coordination": control_result, "jobs": queue,
            "notification_worker_mode": settings.notification_worker_mode,
            "login_rate_limit_backend": settings.login_rate_limit_backend,
            "api_latency": [{key: value for key, value in row.items() if key != "buckets"}
                            for row in request_metrics.snapshot()]}


@router.get("/redis")
def get_redis_diagnostics(current_user=Depends(require_roles(Role.ADMIN))):
    return redis_snapshot()


def prometheus_metrics(snapshot: dict) -> str:
    rows = ["# Cache counters describe one API process; Redis INFO describes each complete server."]
    for store in ("cache", "coordination"):
        details = snapshot[store]
        live = details.get("server") is not None
        rows.append(f'qualityops_redis_up{{store="{store}"}} {int(live)}')
        for name, value in (details.get("server") or {}).items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                safe = re.sub(r"[^a-zA-Z0-9_]", "_", name)
                rows.append(f'qualityops_redis_{safe}{{store="{store}"}} {value}')
    pid = snapshot["process_id"]
    for name, value in snapshot["cache"]["client"].get("counters", {}).items():
        safe = re.sub(r"[^a-zA-Z0-9_]", "_", name)
        rows.append(f'qualityops_cache_{safe}_total{{process="{pid}"}} {value}')
    for name, values in snapshot["cache"]["client"].get("operations", {}).items():
        safe = re.sub(r"[^a-zA-Z0-9_]", "_", name)
        rows.append(f'qualityops_cache_operation_seconds_sum{{process="{pid}",operation="{safe}"}} {values["total_ms"] / 1000}')
        rows.append(f'qualityops_cache_operation_seconds_count{{process="{pid}",operation="{safe}"}} {values["count"]}')
    for name, value in snapshot.get("jobs", {}).items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            safe = re.sub(r"[^a-zA-Z0-9_]", "_", name)
            rows.append(f"qualityops_jobs_{safe} {value}")
    return "\n".join(rows) + "\n" + request_metrics.prometheus(pid)


@router.get("/redis/metrics", response_class=PlainTextResponse)
def get_redis_metrics(current_user=Depends(require_roles(Role.ADMIN))):
    return PlainTextResponse(prometheus_metrics(redis_snapshot()),
                             media_type="text/plain; version=0.0.4; charset=utf-8")
