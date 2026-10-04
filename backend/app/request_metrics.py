"""Bounded process-level HTTP timings for operations diagnostics.

Only registered route templates are labels; IDs, query values and arbitrary
incoming paths never enter the metric keyspace.
"""
from __future__ import annotations

from collections import Counter
import json
import math
import threading

_BUCKETS_SECONDS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, math.inf)
_lock = threading.Lock()
_histograms: dict[tuple[str, str], dict] = {}


def record_request(request, duration_ms: float, status: int) -> None:
    route = getattr(request.scope.get("route"), "path", None)
    if not route or not route.startswith("/api") or route == "/api/health" or route.startswith("/api/operations"):
        return
    key = (request.method, route)
    seconds = max(0, duration_ms / 1000)
    with _lock:
        if key not in _histograms and len(_histograms) >= 1000:
            return
        histogram = _histograms.setdefault(key, {"count": 0, "sum": 0.0,
                     "buckets": [0] * len(_BUCKETS_SECONDS), "statuses": Counter()})
        histogram["count"] += 1
        histogram["sum"] += seconds
        histogram["statuses"][f"{status // 100}xx"] += 1
        for index, boundary in enumerate(_BUCKETS_SECONDS):
            if seconds <= boundary:
                histogram["buckets"][index] += 1


def snapshot() -> list[dict]:
    with _lock:
        result = []
        for (method, route), histogram in sorted(_histograms.items()):
            target = math.ceil(histogram["count"] * .95)
            boundary = next(boundary for boundary, count in zip(_BUCKETS_SECONDS, histogram["buckets"]) if count >= target)
            result.append({"method": method, "route": route, "count": histogram["count"],
                           "total_seconds": histogram["sum"], "statuses": dict(histogram["statuses"]),
                           "p95_upper_bound_ms": boundary * 1000 if math.isfinite(boundary) else None,
                           "buckets": list(zip(_BUCKETS_SECONDS, histogram["buckets"]))})
        return result


def prometheus(process_id: int) -> str:
    rows = []
    for histogram in snapshot():
        labels = f'process="{process_id}",method={json.dumps(histogram["method"])},route={json.dumps(histogram["route"])}'
        for boundary, count in histogram["buckets"]:
            upper = "+Inf" if math.isinf(boundary) else str(boundary)
            rows.append(f'qualityops_api_duration_seconds_bucket{{{labels},le="{upper}"}} {count}')
        rows.append(f'qualityops_api_duration_seconds_count{{{labels}}} {histogram["count"]}')
        rows.append(f'qualityops_api_duration_seconds_sum{{{labels}}} {histogram["total_seconds"]}')
        for status, count in histogram["statuses"].items():
            rows.append(f'qualityops_api_responses_total{{{labels},status_class="{status}"}} {count}')
    return "\n".join(rows) + "\n" if rows else ""
