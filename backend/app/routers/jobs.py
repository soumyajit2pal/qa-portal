"""Filesystem-backed background jobs for long-running monolithic tasks.

Status lives under the configured shared upload root, so every API worker
can poll/download a job created by another worker. FastAPI executes the
callable after the HTTP response has been sent. This removes request
timeouts without introducing a second database schema; production should
place the upload root on durable shared storage.
"""
import json
import os
import threading
import uuid
from typing import Any, Callable, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse

from .. import models
from ..deps import get_current_user
from ..storage_config import get_upload_root


router = APIRouter(prefix="/api/jobs", tags=["background-jobs"])
_write_lock = threading.Lock()


def _job_dir(job_id: str) -> str:
    path = os.path.join(get_upload_root(), ".jobs", job_id)
    os.makedirs(path, exist_ok=True)
    return path


def _status_path(job_id: str) -> str:
    return os.path.join(_job_dir(job_id), "status.json")


def _read(job_id: str) -> Optional[dict]:
    try:
        with open(_status_path(job_id), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, ValueError, OSError):
        return None


def _write(job_id: str, data: dict) -> None:
    path = _status_path(job_id)
    temporary = f"{path}.tmp-{uuid.uuid4().hex}"
    with _write_lock:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(data, handle, default=str, ensure_ascii=False)
        os.replace(temporary, path)


def update(job_id: str, **changes: Any) -> None:
    current = _read(job_id) or {}
    current.update(changes)
    current["updated_at"] = models.now().isoformat()
    _write(job_id, current)


def artifact_path(job_id: str, filename: str) -> str:
    safe_name = os.path.basename(filename)
    return os.path.join(_job_dir(job_id), safe_name)


async def save_streaming_response(job_id: str, response, filename: str) -> dict:
    """Persist a StreamingResponse produced by an existing export builder."""
    safe_name = os.path.basename(filename)
    path = artifact_path(job_id, safe_name)
    with open(path, "wb") as output:
        async for chunk in response.body_iterator:
            output.write(chunk if isinstance(chunk, bytes) else chunk.encode())
    update(job_id, progress=95, artifact_name=safe_name)
    return {"filename": safe_name}


def _run(job_id: str, action: Callable[[str], Optional[dict]]) -> None:
    update(job_id, status="RUNNING", progress=5, started_at=models.now().isoformat())
    try:
        result = action(job_id) or {}
        update(
            job_id,
            status="COMPLETED",
            progress=100,
            result=result,
            finished_at=models.now().isoformat(),
        )
    except Exception as exc:
        update(
            job_id,
            status="FAILED",
            error=str(getattr(exc, "detail", None) or exc),
            finished_at=models.now().isoformat(),
        )


def enqueue(background_tasks: BackgroundTasks, job_type: str, user_id: int,
            action: Callable[[str], Optional[dict]]) -> dict:
    job_id = uuid.uuid4().hex
    now = models.now().isoformat()
    _write(job_id, {
        "id": job_id,
        "job_type": job_type,
        "status": "QUEUED",
        "progress": 0,
        "created_by_id": user_id,
        "created_at": now,
        "updated_at": now,
        "result": None,
        "error": None,
        "artifact_name": None,
    })
    background_tasks.add_task(_run, job_id, action)
    return _read(job_id) or {"id": job_id, "status": "QUEUED"}


def _authorized_job(job_id: str, current_user: models.User) -> dict:
    job = _read(job_id)
    if not job:
        raise HTTPException(404, "Background job not found")
    if job.get("created_by_id") != current_user.id and not current_user.has_role("ADMIN"):
        raise HTTPException(403, "You can only view your own background jobs")
    return job


@router.get("/{job_id}")
def get_job(job_id: str, current_user: models.User = Depends(get_current_user)):
    return _authorized_job(job_id, current_user)


@router.get("/{job_id}/download")
def download_job_artifact(job_id: str, current_user: models.User = Depends(get_current_user)):
    job = _authorized_job(job_id, current_user)
    if job.get("status") != "COMPLETED" or not job.get("artifact_name"):
        raise HTTPException(409, "The export is not ready for download")
    path = artifact_path(job_id, job["artifact_name"])
    if not os.path.isfile(path):
        raise HTTPException(404, "The generated export file is missing")
    return FileResponse(path, filename=job["artifact_name"])
