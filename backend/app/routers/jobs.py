"""Shared Redis-stream jobs; local mode is an explicit development fallback."""
import contextvars
import errno
import json
import logging
import os
import queue
import re
import threading
import uuid
from typing import Any, Optional
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from .. import models
from ..deps import get_current_user
from ..storage_config import get_upload_root
from ..storage_lock import exclusive_file_lock

router = APIRouter(prefix="/api/jobs", tags=["background-jobs"])
logger = logging.getLogger(__name__)
_write_lock = threading.Lock()
_worker_start_lock = threading.Lock()
_job_queue: queue.Queue[tuple[str, dict]] = queue.Queue()
_workers_started = False
_job_leases = {}
_execution_owner = contextvars.ContextVar("background_job_owner", default=None)


def _fsync_directory(path: str) -> None:
    """Persist directory entries after creating/renaming durable job files."""
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        try:
            os.fsync(descriptor)
        except OSError as exc:
            if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EBADF}:
                raise
    finally:
        os.close(descriptor)


class LeaseLost(RuntimeError):
    pass


def queue_backend() -> str:
    from ..config import settings
    backend = os.getenv("JOB_QUEUE_BACKEND", getattr(settings, "job_queue_backend", "local")).strip().lower()
    if backend not in {"redis", "local"}:
        raise RuntimeError("JOB_QUEUE_BACKEND must be redis or local")
    return backend


def _job_worker_count() -> int:
    try:
        return max(1, min(int(os.getenv("BACKGROUND_JOB_WORKERS", "2")), 16))
    except ValueError:
        return 2


def _job_dir(job_id: str, *, create=True) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(404, "Background job not found")
    path = os.path.join(get_upload_root(), ".jobs", job_id)
    if create:
        new_directory = not os.path.isdir(path)
        os.makedirs(path, exist_ok=True)
        if new_directory:
            _fsync_directory(os.path.dirname(path))
            _fsync_directory(get_upload_root())
    return path


def _status_path(job_id: str) -> str:
    return os.path.join(_job_dir(job_id), "status.json")


def _atomic_json(path: str, data: dict) -> None:
    temporary = f"{path}.tmp-{uuid.uuid4().hex}"
    try:
        with _write_lock:
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(data, handle, default=str, ensure_ascii=False, allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            _fsync_directory(os.path.dirname(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_file(job_id: str) -> Optional[dict]:
    try:
        with open(os.path.join(_job_dir(job_id, create=False), "status.json"), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, ValueError, OSError):
        return None


def _coordination():
    from .. import redis_runtime
    return redis_runtime


def redis_keys(job_id: str | None = None):
    prefix = _coordination().coordination_key("jobs")
    return {
        "stream": f"{prefix}:queue", "group": "background-workers",
        "status": f"{prefix}:status:{job_id}", "spec": f"{prefix}:spec:{job_id}",
        "lease": f"{prefix}:lease:{job_id}", "entry": f"{prefix}:entry:{job_id}",
        "workers": f"{prefix}:workers", "metrics": f"{prefix}:metrics",
    }


def _queue_error(exc, job_id=None):
    detail = {"message": "The background job queue is unavailable. Please retry when the queue recovers."}
    if job_id:
        detail.update(message=f"Submission of background job {job_id} could not be confirmed. Check this job before submitting it again.", job_id=job_id)
    return HTTPException(503, detail, headers={"Retry-After": "5"})


def _read(job_id: str) -> Optional[dict]:
    _job_dir(job_id, create=False)
    if queue_backend() == "redis":
        try:
            value = _coordination().get_client().get(redis_keys(job_id)["status"])
            if value:
                return json.loads(value)
        except Exception as exc:
            fallback = _read_file(job_id)
            if fallback and fallback.get("status") in {"COMPLETED", "FAILED"}:
                return fallback
            raise _queue_error(exc) from exc
    return _read_file(job_id)


def _write(job_id: str, data: dict) -> None:
    if queue_backend() == "redis" and data.get("queue_backend") == "redis":
        try:
            _coordination().get_client().set(redis_keys(job_id)["status"], json.dumps(data, default=str, ensure_ascii=False))
        except Exception as exc:
            raise _queue_error(exc) from exc
    _atomic_json(_status_path(job_id), data)


_UPDATE_SCRIPT = """
if ARGV[2] ~= '' and redis.call('GET', KEYS[2]) ~= ARGV[2] then return false end
local previous = redis.call('GET', KEYS[1])
if not previous then return false end
local state = cjson.decode(previous)
local changes = cjson.decode(ARGV[1])
if changes.attempts and changes.attempts > (state.attempts or 0) and changes.attempts > 1 then
  redis.call('HINCRBY', KEYS[3], 'retries', 1)
end
if changes.status and changes.status ~= state.status then
  if changes.status == 'COMPLETED' then redis.call('HINCRBY', KEYS[3], 'completed', 1) end
  if changes.status == 'FAILED' then redis.call('HINCRBY', KEYS[3], 'failed', 1) end
end
for key,value in pairs(changes) do state[key] = value end
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded)
return encoded
"""


def update(job_id: str, **changes: Any) -> None:
    changes["updated_at"] = models.now().isoformat()
    if queue_backend() == "redis":
        owner = _execution_owner.get()
        if not owner or owner[0] != job_id:
            raise LeaseLost("Redis task progress can only be updated by its owning worker")
        token = owner[1]
        keys = redis_keys(job_id)
        try:
            value = _coordination().get_client().eval(
                _UPDATE_SCRIPT, 3, keys["status"], keys["lease"], keys["metrics"], json.dumps(changes, default=str), token,
            )
        except Exception as exc:
            raise _queue_error(exc) from exc
        if not value:
            raise LeaseLost("The background job lease is no longer owned")
        current = json.loads(value)
        _atomic_json(_status_path(job_id), current)
    else:
        current = _read_file(job_id) or {}
        current.update(changes)
        _atomic_json(_status_path(job_id), current)


def artifact_path(job_id: str, filename: str) -> str:
    safe_name = os.path.basename(filename)
    if safe_name in {"", ".", ".."}:
        raise ValueError("Invalid job artifact filename")
    return os.path.join(_job_dir(job_id), safe_name)


async def save_streaming_response(job_id: str, response, filename: str) -> dict:
    safe_name = os.path.basename(filename)
    path = artifact_path(job_id, safe_name)
    temporary = f"{path}.tmp-{uuid.uuid4().hex}"
    try:
        with open(temporary, "wb") as output:
            async for chunk in response.body_iterator:
                output.write(chunk if isinstance(chunk, bytes) else chunk.encode())
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(os.path.dirname(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    update(job_id, progress=95, artifact_name=safe_name)
    return {"filename": safe_name}


def commit_or_flush(db) -> None:
    """Worker business writes and their receipt share one transaction."""
    if db.info.get("durable_job_id"):
        db.flush()
    else:
        db.commit()


def _run(job_id: str, spec: dict, ensure_owned=lambda: None) -> None:
    from ..job_tasks import execute_task
    ensure_owned()
    current = _read(job_id) or {}
    attempts = int(current.get("attempts", 0)) + 1
    update(job_id, status="RUNNING", progress=5, attempts=attempts, error=None, started_at=models.now().isoformat())
    try:
        result = execute_task(job_id, spec, ensure_owned) or {}
        ensure_owned()
        changes = {"status": "COMPLETED", "progress": 100, "result": result,
                   "finished_at": models.now().isoformat(), "error": None}
        if spec["task_type"] in {"TEST_REPOSITORY_EXPORT", "TEST_CYCLE_EXPORT"}:
            changes["artifact_name"] = result.get("filename")
        update(job_id, **changes)
    except LeaseLost:
        raise
    except Exception as exc:
        from sqlalchemy.exc import OperationalError, TimeoutError as DBTimeout
        transient = isinstance(exc, (OperationalError, DBTimeout, OSError)) or (isinstance(exc, HTTPException) and exc.status_code == 503)
        max_attempts = max(1, int(os.getenv("BACKGROUND_JOB_MAX_ATTEMPTS", "3")))
        if transient and attempts < max_attempts:
            ensure_owned()
            update(job_id, status="QUEUED", error="Temporary service failure; the worker will retry this job.")
            raise
        ensure_owned()
        update(job_id, status="FAILED", error=str(getattr(exc, "detail", None) or exc), finished_at=models.now().isoformat())


def _job_worker() -> None:
    while True:
        job_id, spec = _job_queue.get()
        try:
            _run(job_id, spec)
        except Exception:
            logger.exception("Local worker could not persist job %s", job_id)
        finally:
            lease = _job_leases.pop(job_id, None)
            if lease is not None:
                lease.__exit__(None, None, None)
            _job_queue.task_done()


def _ensure_job_workers() -> None:
    global _workers_started
    with _worker_start_lock:
        if _workers_started:
            return
        for number in range(_job_worker_count()):
            threading.Thread(target=_job_worker, name=f"qa-portal-local-job-{number + 1}", daemon=True).start()
        _workers_started = True


_ENQUEUE_SCRIPT = """
local previous = redis.call('GET', KEYS[1])
if previous then
  local state = cjson.decode(previous)
  if state.status == 'COMPLETED' or state.status == 'FAILED' then return false end
  if redis.call('EXISTS', KEYS[5]) == 1 then return false end
end
if not previous then redis.call('SET', KEYS[1], ARGV[1]) end
if redis.call('EXISTS', KEYS[2]) == 0 then redis.call('SET', KEYS[2], ARGV[2]) end
local entry = redis.call('GET', KEYS[4])
if entry and #redis.call('XRANGE', KEYS[3], entry, entry, 'COUNT', 1) > 0 then return entry end
entry = redis.call('XADD', KEYS[3], '*', 'job_id', ARGV[3])
redis.call('SET', KEYS[4], entry)
return entry
"""


def publish_redis(job_id: str, spec: dict, state: dict) -> None:
    keys = redis_keys(job_id)
    try:
        client = _coordination().get_client()
        client.eval(_ENQUEUE_SCRIPT, 5, keys["status"], keys["spec"], keys["stream"], keys["entry"], keys["lease"],
            json.dumps(state, default=str, ensure_ascii=False), json.dumps(spec, ensure_ascii=False), job_id)
        # Repair a stale file mirror left by a post-Redis-write process exit.
        current = client.get(keys["status"])
        if current and json.loads(current).get("status") in {"COMPLETED", "FAILED"}:
            _atomic_json(_status_path(job_id), json.loads(current))
    except Exception as exc:
        raise _queue_error(exc, job_id) from exc


def enqueue(background_tasks: BackgroundTasks, job_type: str, user_id: int,
            spec: dict, *, input_bytes: bytes | None = None) -> dict:
    from ..job_tasks import validate_spec
    spec = validate_spec(spec)
    if spec["task_type"] != job_type or spec["user_id"] != user_id:
        raise ValueError("Background task identity does not match its queue envelope")
    backend = queue_backend()
    if backend == "redis":
        try:
            _coordination().get_client().ping()
        except Exception as exc:
            raise _queue_error(exc) from exc
    job_id, now = uuid.uuid4().hex, models.now().isoformat()
    state = {"id": job_id, "job_type": job_type, "status": "QUEUED", "progress": 0,
             "created_by_id": user_id, "workspace_id": spec["workspace_id"], "queue_backend": backend,
             "created_at": now, "updated_at": now, "result": None, "error": None,
             "artifact_name": None, "attempts": 0, "task_version": 1}
    if input_bytes is not None:
        path = artifact_path(job_id, "input.xlsx")
        with open(path, "wb") as handle:
            handle.write(input_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        _fsync_directory(os.path.dirname(path))
    _atomic_json(os.path.join(_job_dir(job_id), "task.json"), spec)
    _atomic_json(_status_path(job_id), state)
    del background_tasks
    if backend == "redis":
        publish_redis(job_id, spec, state)
    else:
        lease = exclusive_file_lock(os.path.join(_job_dir(job_id), "worker.lock"))
        if not lease.__enter__():
            raise RuntimeError("Could not acquire new local job lease")
        _job_leases[job_id] = lease
        try:
            _ensure_job_workers()
            _job_queue.put((job_id, spec))
        except Exception:
            _job_leases.pop(job_id, None)
            lease.__exit__(None, None, None)
            raise
    return state


def recover_manifests() -> None:
    """Recover new JSON tasks; never replay pre-upgrade captured callables."""
    from ..job_tasks import validate_spec
    root = os.path.join(get_upload_root(), ".jobs")
    if not os.path.isdir(root):
        return
    for directory in os.scandir(root):
        job_id = directory.name
        if not re.fullmatch(r"[0-9a-f]{32}", job_id):
            continue
        state = _read_file(job_id)
        if not state or state.get("status") not in {"QUEUED", "RUNNING"}:
            continue
        task_path = os.path.join(root, job_id, "task.json")
        if not os.path.isfile(task_path):
            _check_legacy_job(job_id, state)
            continue
        # Respect local workers during a rolling deployment.
        with exclusive_file_lock(os.path.join(root, job_id, "worker.lock")) as acquired:
            if not acquired:
                continue
            state = _read_file(job_id) or state
            if state.get("status") not in {"QUEUED", "RUNNING"}:
                continue
            with open(task_path, "r", encoding="utf-8") as handle:
                spec = validate_spec(json.load(handle))
            state.update(queue_backend="redis", status="QUEUED")
            publish_redis(job_id, spec, state)


def _check_legacy_job(job_id: str, job: dict) -> dict:
    with exclusive_file_lock(os.path.join(_job_dir(job_id), "worker.lock")) as acquired:
        if acquired:
            job = _read_file(job_id) or job
            if job.get("status") in {"QUEUED", "RUNNING"}:
                job.update(status="FAILED", finished_at=models.now().isoformat(), updated_at=models.now().isoformat(),
                           error="The old local worker was interrupted. Review the result before submitting this legacy job again.")
                _atomic_json(_status_path(job_id), job)
    return job


def queue_snapshot() -> dict:
    """Bounded operational counters without enumerating user/task payloads."""
    if queue_backend() == "local":
        return {"backend": "local", "queue_length": _job_queue.qsize(), "workers": _job_worker_count()}
    keys = redis_keys()
    import time
    try:
        client = _coordination().get_client()
        workers = client.zrangebyscore(keys["workers"], time.time() - 30, "+inf")
        try:
            pending = client.xpending(keys["stream"], keys["group"])["pending"]
        except Exception as exc:
            if "NOGROUP" not in str(exc):
                raise
            pending = 0
        from ..job_worker import global_concurrency
        slots = [_coordination().coordination_key(f"jobs:slot:{number}") for number in range(global_concurrency())]
        metrics = client.hgetall(keys["metrics"])
        return {"backend": "redis", "queue_length": client.xlen(keys["stream"]), "pending": pending,
                "active_slots": sum(value is not None for value in client.mget(slots)),
                "concurrency_limit": len(slots), "healthy_workers": len(workers),
                "retries": int(metrics.get("retries", 0)), "completed": int(metrics.get("completed", 0)),
                "failed": int(metrics.get("failed", 0))}
    except Exception as exc:
        raise _queue_error(exc) from exc


def _authorized_job(job_id: str, current_user: models.User) -> dict:
    job = _read(job_id)
    if not job:
        raise HTTPException(404, "Background job not found")
    if job.get("created_by_id") != current_user.id and not current_user.has_role("ADMIN"):
        raise HTTPException(403, "You can only view your own background jobs")
    if job.get("status") in {"QUEUED", "RUNNING"} and job.get("queue_backend") != "redis":
        job = _check_legacy_job(job_id, job)
    return job


@router.get("/{job_id}")
def get_job(job_id: str, current_user: models.User = Depends(get_current_user)):
    return _authorized_job(job_id, current_user)


def _authorize_export_artifact(job_id: str, job: dict, current_user: models.User) -> None:
    from ..job_tasks import EXPORT_TASKS, authorize_export_download, validate_spec
    task_path = os.path.join(_job_dir(job_id, create=False), "task.json")
    try:
        with open(task_path, "r", encoding="utf-8") as handle:
            spec = validate_spec(json.load(handle))
    except FileNotFoundError:
        # Pre-upgrade local exports have no serializable task metadata.
        if job.get("task_version") == 1 and job.get("job_type") in EXPORT_TASKS:
            raise HTTPException(503, "The export authorization metadata is unavailable")
        return
    except (OSError, ValueError) as exc:
        raise HTTPException(503, "The export authorization metadata is unavailable") from exc
    if spec["user_id"] != job.get("created_by_id") or spec["task_type"] != job.get("job_type"):
        raise HTTPException(403, "The export metadata does not match this job")
    if spec["task_type"] in EXPORT_TASKS:
        authorize_export_download(spec, current_user.id)


@router.get("/{job_id}/download")
def download_job_artifact(job_id: str, current_user: models.User = Depends(get_current_user)):
    job = _authorized_job(job_id, current_user)
    if job.get("status") != "COMPLETED" or not job.get("artifact_name"):
        raise HTTPException(409, "The export is not ready for download")
    _authorize_export_artifact(job_id, job, current_user)
    path = artifact_path(job_id, job["artifact_name"])
    if not os.path.isfile(path):
        raise HTTPException(404, "The generated export file is missing")
    return FileResponse(path, filename=job["artifact_name"])
