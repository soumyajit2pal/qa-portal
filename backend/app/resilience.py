"""Small, dependency-free circuit breakers for optional/remote services.

Breakers are deliberately process-local.  They protect each Uvicorn worker
without making Redis or Oracle another dependency of the protection itself.
The load balancer and existing worker/pool isolation continue to distribute
traffic between healthy workers.
"""
from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable


def _positive_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


@dataclass(frozen=True)
class CircuitSnapshot:
    state: str
    consecutive_failures: int
    retry_after_seconds: int


class CircuitOpenError(RuntimeError):
    def __init__(self, name: str, retry_after_seconds: int):
        self.name = name
        self.retry_after_seconds = max(1, retry_after_seconds)
        super().__init__(f"{name} circuit is open; retry in {self.retry_after_seconds} seconds")


class CircuitBreaker:
    """Closed -> open after repeated failures -> one half-open probe.

    A successful probe immediately closes the breaker.  A failed probe opens
    it again for the full recovery period.  The single probe prevents a
    recovering dependency from receiving a thundering herd of requests.
    """

    def __init__(
        self,
        name: str,
        failure_threshold: int,
        recovery_seconds: int,
        *,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.name = name
        self.failure_threshold = max(1, failure_threshold)
        self.recovery_seconds = max(1, recovery_seconds)
        self._clock = clock
        self._lock = threading.Lock()
        self._state = "closed"
        self._consecutive_failures = 0
        self._opened_at = 0.0
        self._half_open_probe_in_flight = False

    def check(self) -> None:
        """Permit a call or raise before it touches the remote dependency."""
        now = self._clock()
        with self._lock:
            if self._state == "closed":
                return
            elapsed = now - self._opened_at
            if elapsed < self.recovery_seconds:
                raise CircuitOpenError(self.name, math.ceil(self.recovery_seconds - elapsed))
            if self._half_open_probe_in_flight:
                raise CircuitOpenError(self.name, 1)
            self._state = "half_open"
            self._half_open_probe_in_flight = True

    def record_success(self) -> None:
        with self._lock:
            self._state = "closed"
            self._consecutive_failures = 0
            self._half_open_probe_in_flight = False

    def record_failure(self) -> None:
        now = self._clock()
        with self._lock:
            self._half_open_probe_in_flight = False
            self._consecutive_failures += 1
            if self._state == "half_open" or self._consecutive_failures >= self.failure_threshold:
                self._state = "open"
                self._opened_at = now

    def snapshot(self) -> CircuitSnapshot:
        now = self._clock()
        with self._lock:
            retry_after = 0
            if self._state == "open":
                retry_after = max(0, math.ceil(self.recovery_seconds - (now - self._opened_at)))
            return CircuitSnapshot(self._state, self._consecutive_failures, retry_after)


def _configured_breaker(prefix: str, *, threshold: int, recovery_seconds: int) -> CircuitBreaker:
    return CircuitBreaker(
        prefix.lower(),
        _positive_int(f"{prefix}_CIRCUIT_FAILURE_THRESHOLD", threshold),
        _positive_int(f"{prefix}_CIRCUIT_RECOVERY_SECONDS", recovery_seconds),
    )


database_circuit = _configured_breaker("DATABASE", threshold=3, recovery_seconds=20)
smtp_circuit = _configured_breaker("SMTP", threshold=3, recovery_seconds=60)
redis_circuit = _configured_breaker("REDIS", threshold=3, recovery_seconds=15)
fortify_circuit = _configured_breaker("FORTIFY", threshold=3, recovery_seconds=60)


def snapshot() -> dict[str, dict[str, int | str]]:
    return {
        name: {
            "state": item.state,
            "consecutive_failures": item.consecutive_failures,
            "retry_after_seconds": item.retry_after_seconds,
        }
        for name, item in {
            "database": database_circuit.snapshot(),
            "smtp": smtp_circuit.snapshot(),
            "redis": redis_circuit.snapshot(),
            "fortify": fortify_circuit.snapshot(),
        }.items()
    }


def is_transient_database_error(exc: BaseException) -> bool:
    """Only trip for connection/capacity failures, never business SQL errors."""
    if getattr(exc, "connection_invalidated", False):
        return True
    detail = str(exc).upper()
    markers = (
        "TIMEOUT", "CONNECTION REFUSED", "CONNECTION RESET", "CONNECTION CLOSED",
        "ORA-00020", "ORA-01013", "ORA-01034", "ORA-01035", "ORA-03113",
        "ORA-03114", "ORA-12170", "ORA-12514", "ORA-12516", "ORA-12541",
        "ORA-12545", "DPY-4010", "DPY-4011", "DPY-6005",
    )
    return any(marker in detail for marker in markers)
