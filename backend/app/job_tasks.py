"""Versioned, JSON-only task dispatch for the dedicated background worker.

No Python callable or pickled request/session is stored in the queue. Every
delivery opens a fresh session and reconstructs authorization and workspace
scope. A transaction receipt makes a repeated delivery return the original
result, including when Oracle committed just before the worker disappeared.
"""
import asyncio
import hashlib
import json
import os
from contextlib import contextmanager

from fastapi import HTTPException, UploadFile
from sqlalchemy.exc import IntegrityError

from . import models, schemas
from .database import SessionLocal
from .workspace_service import active_workspace_scope_ids, workspace_context
from .workflow_authority import workflow_context


TASK_ARGUMENTS = {
    "TEST_REPOSITORY_EXPORT": {"project_id", "folder_id", "filename"},
    "TEST_CYCLE_EXPORT": {"cycle_id", "filename"},
    "TESTCASE_XLSX_IMPORT": {"project_id", "folder_id", "filename", "input_sha256"},
    "ADD_TESTCASES_TO_CYCLE": {"cycle_id", "test_case_ids", "assigned_to_id", "reason"},
}
EXPORT_TASKS = {"TEST_REPOSITORY_EXPORT", "TEST_CYCLE_EXPORT"}


def _positive_id(value, *, optional=False):
    return (optional and value is None) or (type(value) is int and value > 0)


def validate_spec(spec: dict) -> dict:
    if not isinstance(spec, dict) or set(spec) != {"version", "task_type", "user_id", "workspace_id", "args"}:
        raise ValueError("Invalid background task envelope")
    if spec["version"] != 1 or spec["task_type"] not in TASK_ARGUMENTS:
        raise ValueError("Unsupported background task version or type")
    if not _positive_id(spec["user_id"]) or not _positive_id(spec["workspace_id"], optional=spec["task_type"] in EXPORT_TASKS):
        raise ValueError("Background jobs require an active user and workspace")
    args = spec["args"]
    if not isinstance(args, dict) or set(args) != TASK_ARGUMENTS[spec["task_type"]]:
        raise ValueError("Invalid background task arguments")
    for key in ("project_id", "cycle_id", "folder_id", "assigned_to_id"):
        if key in args and not _positive_id(args[key], optional=key in {"folder_id", "assigned_to_id"}):
            raise ValueError(f"Invalid task {key}")
    if "filename" in args and (
        not isinstance(args["filename"], str) or not args["filename"]
        or os.path.basename(args["filename"]) != args["filename"]
        or args["filename"] in {".", ".."}
    ):
        raise ValueError("Invalid background task filename")
    if "test_case_ids" in args and (
        not isinstance(args["test_case_ids"], list) or not args["test_case_ids"]
        or not all(_positive_id(value) for value in args["test_case_ids"])
        or len(set(args["test_case_ids"])) != len(args["test_case_ids"])
    ):
        raise ValueError("Select each valid testcase once")
    if "reason" in args and args["reason"] is not None and not isinstance(args["reason"], str):
        raise ValueError("Invalid scope expansion reason")
    if "input_sha256" in args and (
        not isinstance(args["input_sha256"], str) or len(args["input_sha256"]) != 64
        or any(char not in "0123456789abcdef" for char in args["input_sha256"])
    ):
        raise ValueError("Invalid uploaded workbook fingerprint")
    # Copy through JSON so no captured ORM object/bytes/callable can escape.
    return json.loads(json.dumps(spec, ensure_ascii=False, allow_nan=False))


def make_spec(task_type: str, user_id: int, workspace_id: int | None, **args) -> dict:
    try:
        return validate_spec({"version": 1, "task_type": task_type, "user_id": user_id,
                              "workspace_id": workspace_id, "args": args})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def spec_hash(spec: dict) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


@contextmanager
def authorized_context(db, spec):
    user = db.get(models.User, spec["user_id"])
    if not user or not user.is_active:
        raise HTTPException(403, "The user who started this job no longer exists or is inactive")
    workspace_id = spec["workspace_id"]
    user.active_qa_workspace_id = workspace_id
    scope_ids = active_workspace_scope_ids(db, user, workspace_id) if workspace_id is not None else set()
    if workspace_id is not None and workspace_id not in scope_ids:
        raise HTTPException(403, "The workspace used to start this job is no longer available")
    user.active_workspace_scope_ids = tuple(sorted(scope_ids))
    with workspace_context(workspace_id, scope_ids), workflow_context(user):
        from .project_workspace_ownership import bind_actor
        bind_actor(db, user)
        db.info["workflow_actor"] = user
        yield user


def _require_roles(user, roles):
    if not user.has_role("ADMIN") and not any(user.has_role(role) for role in roles):
        raise HTTPException(403, "You no longer have the role required for this background job")


def authorize_operation(db, user, spec):
    """Recheck current record access even when a committed receipt is reused."""
    from .routers import test_execution, test_repository
    args, kind = spec["args"], spec["task_type"]
    if kind in {"TEST_REPOSITORY_EXPORT", "TESTCASE_XLSX_IMPORT"}:
        test_repository._get_project_or_404(db, args["project_id"])
        test_repository.require_project_visibility(db, args["project_id"], user)
        if kind == "TESTCASE_XLSX_IMPORT":
            _require_roles(user, test_repository._AUTHOR_ROLES)
            test_repository.require_can_author_repository(db, args["project_id"], user)
    else:
        cycle = test_execution._get_cycle_or_404(db, args["cycle_id"])
        test_execution._require_cycle_visibility(db, cycle, user)
        if kind == "ADD_TESTCASES_TO_CYCLE":
            _require_roles(user, test_execution._EXEC_ROLES)
            test_execution.require_can_execute_project(db, cycle.project_id, user)


def authorize_export_download(spec: dict, viewer_id: int) -> None:
    """Recheck the current downloader, including grants changed after export."""
    spec = validate_spec(spec)
    if spec["task_type"] not in EXPORT_TASKS:
        return
    with SessionLocal() as db:
        viewer = db.get(models.User, viewer_id)
        if not viewer or not viewer.is_active:
            raise HTTPException(403, "Your account is no longer active")
        viewer_spec = dict(spec, user_id=viewer_id)
        if viewer.has_role("ADMIN"):
            # Administrative project reads are global, independent of the
            # creator's workspace membership or the header's selection.
            viewer_spec["workspace_id"] = None
        with authorized_context(db, viewer_spec) as user:
            # The jobs download endpoint uses authenticated read authority;
            # workflow-only role filtering belongs to executing the task.
            with workflow_context(user, enabled=False):
                authorize_operation(db, user, viewer_spec)


def _dispatch(job_id, db, user, spec):
    from .routers import jobs, test_execution, test_repository
    args, kind = spec["args"], spec["task_type"]
    jobs.update(job_id, progress=15)
    if kind == "TEST_REPOSITORY_EXPORT":
        response = test_repository.export_test_repository(
            args["project_id"], db, user, **({"folder_id": args["folder_id"]} if args["folder_id"] is not None else {}),
        )
        return asyncio.run(jobs.save_streaming_response(job_id, response, args["filename"]))
    if kind == "TEST_CYCLE_EXPORT":
        response = test_execution.export_test_cycle(args["cycle_id"], db, user)
        return asyncio.run(jobs.save_streaming_response(job_id, response, args["filename"]))
    if kind == "TESTCASE_XLSX_IMPORT":
        path = jobs.artifact_path(job_id, "input.xlsx")
        with open(path, "rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
            if digest != args["input_sha256"]:
                raise HTTPException(400, "The queued workbook is missing or has changed")
            source.seek(0)
            upload = UploadFile(filename=args["filename"], file=source)
            result = asyncio.run(test_repository.import_test_cases(
                args["project_id"], upload, args["folder_id"], db, user,
            ))
            return result.model_dump(mode="json")
    rows = test_execution.add_test_cases_to_cycle(
        args["cycle_id"], schemas.TestExecutionAdd(test_case_ids=args["test_case_ids"],
        assigned_to_id=args["assigned_to_id"], reason=args["reason"]), db, user,
    )
    return {"created_count": len(rows), "skipped_count": len(args["test_case_ids"]) - len(rows)}


def _receipt_result(receipt, fingerprint):
    if receipt.task_hash != fingerprint or not receipt.completed_at or receipt.result_json is None:
        raise RuntimeError("The background task receipt does not match this delivery")
    return json.loads(receipt.result_json)


def execute_task(job_id: str, spec: dict, ensure_owned=lambda: None) -> dict:
    spec = validate_spec(spec)
    fingerprint = spec_hash(spec)
    with SessionLocal() as db:
        with authorized_context(db, spec) as user:
            authorize_operation(db, user, spec)
            existing = db.get(models.BackgroundJobReceipt, job_id)
            if existing:
                return _receipt_result(existing, fingerprint)
            receipt = models.BackgroundJobReceipt(
                job_id=job_id, task_type=spec["task_type"], task_hash=fingerprint,
                user_id=spec["user_id"], workspace_id=spec["workspace_id"],
            )
            db.add(receipt)
            try:
                # Hold this primary-key insertion until business writes and the
                # receipt commit together. A reclaimed delivery cannot execute
                # concurrently with a worker whose DB transaction is still alive.
                db.flush()
            except IntegrityError:
                db.rollback()
                existing = db.get(models.BackgroundJobReceipt, job_id)
                if existing:
                    return _receipt_result(existing, fingerprint)
                raise
            db.info["durable_job_id"] = job_id
            ensure_owned()
            result = _dispatch(job_id, db, user, spec)
            receipt.result_json = json.dumps(result, ensure_ascii=False, allow_nan=False)
            receipt.completed_at = models.now()
            ensure_owned()
            db.commit()
            return result
