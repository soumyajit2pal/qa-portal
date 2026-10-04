"""Invalidate cache generations only for committed database changes.

ORM and bulk writes share this path, including background workers. HTTP
requests collect a batch and await Redis in a thread before returning;
Oracle rollback never invalidates cached values. No Redis I/O runs inside
the asynchronous request middleware or an asynchronous commit callback.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import logging
import threading
import time

from sqlalchemy import event
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from . import cache

logger = logging.getLogger(__name__)
_installed = False
_install_lock = threading.Lock()
_SESSION_KEY = "qualityops_cache_invalidations"

_DASHBOARD_TABLES = {
    "qap_requests", "qap_functional_requests", "qap_sast_requests", "qap_dast_requests",
    "qap_performance_requests", "qap_sast_components", "qap_dast_targets",
    "qap_sast_findings", "qap_dast_findings", "qap_security_scan_results",
    "qap_suppression_requests", "qap_suppression_items", "qap_suppression_dept_approvals",
    "qap_approval_actions", "qap_assignment_history", "qap_request_delegations", "qap_signoffs",
    "qap_test_projects", "qap_test_project_members", "qap_test_project_view_grants",
    "qap_test_cases", "qap_test_case_versions", "qap_test_cycles", "qap_test_cycle_child_links",
    "qap_test_cycle_folders", "qap_test_cycle_folder_access", "qap_test_executions",
    "qap_test_execution_runs", "qap_test_run_defects", "qap_defects", "qap_defect_case_links",
    "qap_defect_execution_links", "qap_application_master", "qap_departments",
    "qap_department_units", "qap_users", "qap_user_roles", "qap_user_departments",
    "qap_user_department_units",
    "qap_qa_workspaces", "qap_qa_workspace_members", "qap_qa_workspace_coverage",
    "qap_department_coordinators",
}


def families_for_table(table_name: str | None) -> set[str]:
    families = {cache.DASHBOARD_FAMILY} if table_name in _DASHBOARD_TABLES else set()
    if table_name in {"qap_departments", "qap_department_units"}:
        families.update((cache.DEPARTMENTS_FAMILY, cache.APPLICATIONS_FAMILY, cache.CHECKLIST_FAMILY))
    if table_name == "qap_application_master":
        families.add(cache.APPLICATIONS_FAMILY)
    if table_name == "qap_checklist_template_items":
        families.add(cache.CHECKLIST_FAMILY)
    if table_name == "qap_request_type_config":
        families.add(cache.REQUEST_TYPES_FAMILY)
    return families


class InvalidationBatch:
    def __init__(self):
        self._lock = threading.Lock()
        self._closed = False
        self._families: set[str] = set()

    def add(self, families: set[str]) -> bool:
        with self._lock:
            if self._closed:
                return False
            self._families.update(families)
            return True

    def close(self) -> tuple[str, ...]:
        with self._lock:
            self._closed = True
            families = tuple(sorted(self._families))
            self._families.clear()
            return families


_request_batch: ContextVar[InvalidationBatch | None] = ContextVar("cache_invalidation_batch", default=None)


def begin_request():
    return _request_batch.set(InvalidationBatch())


def end_request(token) -> tuple[str, ...]:
    batch = _request_batch.get()
    _request_batch.reset(token)
    return batch.close() if batch is not None else ()


async def committed_cache_invalidation(request, call_next):
    token = begin_request()
    started = time.perf_counter()
    response = None
    try:
        response = await call_next(request)
        return response
    finally:
        families = end_request(token)
        if families:
            try:
                await run_in_threadpool(cache.invalidate, *families)
            except Exception:
                logger.exception("Committed cache invalidation could not be completed")
        elapsed_ms = (time.perf_counter() - started) * 1000
        if response is not None:
            response.headers["Server-Timing"] = f'app;dur={elapsed_ms:.2f}'
        if request is not None:
            from .request_metrics import record_request
            record_request(request, elapsed_ms, response.status_code if response is not None else 500)
        if families and elapsed_ms >= 2000:
            logger.warning("Slow API request including committed cache invalidation method=%s path=%s duration_ms=%.2f",
                           request.method, request.url.path, elapsed_ms)


def _invalidate_committed(families: set[str]) -> None:
    if not families:
        return
    batch = _request_batch.get()
    if batch is not None and batch.add(families):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        cache.invalidate(*sorted(families))
    else:
        # Async non-HTTP/background callers cannot await a synchronous ORM
        # event. Redis remains an optimization; dispatch to the normal pool.
        loop.run_in_executor(None, cache.invalidate, *sorted(families))


def _before_flush(session: Session, flush_context, instances) -> None:
    families = session.info.setdefault(_SESSION_KEY, set())
    for obj in session.new.union(session.dirty).union(session.deleted):
        if obj in session.dirty and not session.is_modified(obj, include_collections=True):
            continue
        families.update(families_for_table(getattr(obj, "__tablename__", None)))


def _bulk_write(state) -> None:
    if not (state.is_update or state.is_delete or state.is_insert):
        return
    table = getattr(state.statement, "table", None)
    families = families_for_table(getattr(table, "name", None))
    if families:
        state.session.info.setdefault(_SESSION_KEY, set()).update(families)


def _after_commit(session: Session) -> None:
    if session.in_nested_transaction():
        return
    families = session.info.pop(_SESSION_KEY, set())
    try:
        _invalidate_committed(families)
    except Exception:
        # Oracle's transaction is already committed. A failed optional cache
        # must never replace a successful workflow response with an error.
        logger.exception("Committed cache invalidation could not be dispatched")


def _after_soft_rollback(session: Session, previous_transaction) -> None:
    if previous_transaction.parent is None:
        session.info.pop(_SESSION_KEY, None)


def install() -> None:
    global _installed
    with _install_lock:
        if _installed:
            return
        event.listen(Session, "before_flush", _before_flush)
        event.listen(Session, "do_orm_execute", _bulk_write)
        event.listen(Session, "after_commit", _after_commit)
        event.listen(Session, "after_soft_rollback", _after_soft_rollback)
        _installed = True
