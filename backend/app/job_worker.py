"""Dedicated Redis background worker: python -m app.job_worker.

Streams retain unacknowledged deliveries across process restarts. Global
slot leases cap execution across every worker container; per-job leases
and Oracle transaction receipts protect crash/reclaim boundaries.
"""
import argparse
import json
import logging
import os
import signal
import socket
import threading
import time
import uuid

from . import redis_runtime
from .config import settings
from .routers import jobs

logger = logging.getLogger(__name__)


def _integer(name, default):
    return int(os.getenv(name, str(default)))


def global_concurrency():
    return max(1, _integer("BACKGROUND_JOB_GLOBAL_CONCURRENCY", settings.background_job_global_concurrency))


def lease_seconds():
    return max(1, _integer("BACKGROUND_JOB_LEASE_SECONDS", settings.background_job_lease_seconds))


def poll_seconds():
    return max(0.05, float(os.getenv("BACKGROUND_JOB_POLL_SECONDS", str(settings.background_job_poll_seconds))))


def heartbeat_key():
    return redis_runtime.coordination_key(f"jobs:worker:{socket.gethostname()}:heartbeat")


def report_health():
    now = time.time()
    client = redis_runtime.get_client()
    with client.pipeline(transaction=True) as pipe:
        pipe.set(heartbeat_key(), str(now), ex=30)
        pipe.zadd(jobs.redis_keys()["workers"], {socket.gethostname(): now})
        pipe.zremrangebyscore(jobs.redis_keys()["workers"], "-inf", now - 60)
        pipe.execute()


def healthcheck():
    try:
        return bool(redis_runtime.get_client().get(heartbeat_key()))
    except Exception:
        return False


def ensure_group():
    keys = jobs.redis_keys()
    try:
        redis_runtime.get_client().xgroup_create(keys["stream"], keys["group"], id="0", mkstream=True)
    except Exception as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def initialize_worker():
    from .logging_config import configure_logging
    from .email_notifications import install_outbox_listener
    configure_logging()
    install_outbox_listener()


_ACKNOWLEDGE = """
if redis.call('GET', KEYS[5]) ~= ARGV[3] then return false end
local state = redis.call('GET', KEYS[2])
if not state then return false end
local status = cjson.decode(state).status
if status ~= 'COMPLETED' and status ~= 'FAILED' then return false end
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[2])
if redis.call('GET', KEYS[4]) == ARGV[2] then redis.call('DEL', KEYS[4]) end
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
"""


class DeliveryLease:
    def __init__(self, job_id, token, slot_key, slot_token, entry_id, consumer, *, heartbeat=True):
        self.job_id, self.token = job_id, token
        self.slot_key, self.slot_token = slot_key, slot_token
        self.entry_id, self.consumer = entry_id, consumer
        self.stopped = threading.Event()
        self.lost = threading.Event()
        self.thread = None
        if heartbeat:
            self.thread = threading.Thread(target=self._heartbeat, name=f"job-lease-{job_id[:8]}", daemon=True)
            self.thread.start()

    def ensure_owned(self):
        if self.lost.is_set():
            raise jobs.LeaseLost("Background job ownership expired; another worker will recover it")
        try:
            if not redis_runtime.renew_lease(jobs.redis_keys(self.job_id)["lease"], self.token, lease_seconds()):
                raise jobs.LeaseLost("Background job ownership expired")
            if not redis_runtime.renew_lease(self.slot_key, self.slot_token, lease_seconds()):
                raise jobs.LeaseLost("The deployment job slot expired")
        except Exception as exc:
            self.lost.set()
            if isinstance(exc, jobs.LeaseLost):
                raise
            raise jobs.LeaseLost("Background job coordination is unavailable; work will be recovered") from exc

    def _heartbeat(self):
        while not self.stopped.wait(max(0.1, lease_seconds() / 3)):
            try:
                self.ensure_owned()
                keys = jobs.redis_keys()
                redis_runtime.get_client().xclaim(keys["stream"], keys["group"], self.consumer, 0, [self.entry_id], justid=True)
            except Exception:
                self.lost.set()
                return

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=2)
        for key, token in ((jobs.redis_keys(self.job_id)["lease"], self.token), (self.slot_key, self.slot_token)):
            try:
                redis_runtime.release_lease(key, token)
            except Exception:
                logger.warning("Job lease release unavailable; its TTL will release capacity")


class Worker:
    def __init__(self, consumer=None, *, heartbeat=True):
        self.consumer = consumer or f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.reclaim_cursor = "0-0"
        self.heartbeat = heartbeat
        self.next_reconcile = 0.0

    def maybe_reconcile(self):
        """Repair durable manifests while workers stay up through Redis restarts."""
        now = time.monotonic()
        if now < self.next_reconcile:
            return
        self.next_reconcile = now + 60
        key = redis_runtime.coordination_key("jobs:reconcile")
        token = redis_runtime.acquire_lease(key, 60)
        if not token:
            return
        try:
            jobs.recover_manifests()
        except Exception:
            self.next_reconcile = 0.0
            redis_runtime.release_lease(key, token)
            raise
        # Retain the short lease as a deployment-wide reconciliation cadence.

    def _slot(self):
        for number in range(global_concurrency()):
            key = redis_runtime.coordination_key(f"jobs:slot:{number}")
            token = redis_runtime.acquire_lease(key, lease_seconds())
            if token:
                return key, token
        return None

    def _delivery(self):
        keys, client = jobs.redis_keys(), redis_runtime.get_client()
        response = client.xautoclaim(keys["stream"], keys["group"], self.consumer,
            min_idle_time=lease_seconds() * 1000, start_id=self.reclaim_cursor, count=1)
        self.reclaim_cursor = response[0]
        if response[1]:
            return response[1][0]
        response = client.xreadgroup(keys["group"], self.consumer, {keys["stream"]: ">"}, count=1, block=200)
        return response[0][1][0] if response else None

    def run_once(self) -> bool:
        ensure_group()
        self.maybe_reconcile()
        slot = self._slot()
        if not slot:
            return False
        slot_key, slot_token = slot
        lease = None
        owner_context = None
        try:
            delivery = self._delivery()
            if not delivery:
                return False
            entry_id, fields = delivery
            job_id = fields.get("job_id")
            if not job_id:
                raise ValueError("Queued task is missing its identity")
            keys = jobs.redis_keys(job_id)
            job_token = redis_runtime.acquire_lease(keys["lease"], lease_seconds())
            if not job_token:
                return False
            lease = DeliveryLease(job_id, job_token, slot_key, slot_token, entry_id, self.consumer, heartbeat=self.heartbeat)
            owner_context = jobs._execution_owner.set((job_id, job_token))
            state = jobs._read(job_id)
            if not state:
                raise RuntimeError("Queued task status is missing")
            if state["status"] not in {"COMPLETED", "FAILED"}:
                encoded = redis_runtime.get_client().get(keys["spec"])
                if not encoded:
                    raise RuntimeError("Queued task specification is missing")
                jobs._run(job_id, json.loads(encoded), lease.ensure_owned)
            lease.ensure_owned()
            # A crash here leaves a pending completed delivery. The next
            # worker sees the terminal state and acknowledges without writes.
            state = jobs._read(job_id)
            jobs._atomic_json(jobs._status_path(job_id), state)
            retention = max(60, _integer("BACKGROUND_JOB_RETENTION_SECONDS", settings.background_job_retention_seconds))
            acknowledged = redis_runtime.get_client().eval(_ACKNOWLEDGE, 5,
                keys["stream"], keys["status"], keys["spec"], keys["entry"], keys["lease"],
                keys["group"], entry_id, job_token, retention)
            if not acknowledged:
                raise jobs.LeaseLost("Job ownership changed before its queue acknowledgement")
            return True
        finally:
            if owner_context is not None:
                jobs._execution_owner.reset(owner_context)
            if lease:
                lease.close()
            else:
                try:
                    redis_runtime.release_lease(slot_key, slot_token)
                except Exception:
                    logger.warning("Job slot release unavailable; its TTL will release capacity")

    def run(self, stop):
        while not stop.is_set():
            try:
                worked = self.run_once()
            except Exception:
                logger.exception("Background delivery interrupted; pending work remains recoverable")
                worked = False
            if not worked:
                stop.wait(poll_seconds())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        return 0 if healthcheck() else 1
    initialize_worker()
    if jobs.queue_backend() != "redis":
        raise RuntimeError("The dedicated job worker requires JOB_QUEUE_BACKEND=redis")
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    # Do not publish a healthy heartbeat until the queue is reachable and
    # durable task manifests have been reconciled. Transient outages retry.
    while not stop.is_set():
        try:
            ensure_group()
            jobs.recover_manifests()
            report_health()
            break
        except Exception:
            logger.exception("Background worker waiting for durable queue coordination")
            stop.wait(poll_seconds())
    threads = []
    for number in range(jobs._job_worker_count()):
        thread = threading.Thread(target=Worker().run, args=(stop,), name=f"background-worker-{number + 1}")
        thread.start()
        threads.append(thread)
    while any(thread.is_alive() for thread in threads):
        try:
            report_health()
        except Exception:
            logger.warning("Background worker heartbeat unavailable")
        # SIGTERM stops new claims; ongoing tasks keep their own leases and
        # complete. A forced process exit leaves pending deliveries to reclaim.
        for thread in threads:
            thread.join(timeout=1)
    try:
        redis_runtime.get_client().delete(heartbeat_key())
        redis_runtime.get_client().zrem(jobs.redis_keys()["workers"], socket.gethostname())
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
