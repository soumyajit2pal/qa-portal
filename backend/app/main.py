import logging
import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text as sqlalchemy_text
from starlette.background import BackgroundTask, BackgroundTasks
from starlette.exceptions import HTTPException as StarletteHTTPException

from .logging_config import (
    bind_request_id,
    configure_logging,
    deep_logging_enabled,
    reset_request_id,
)
configure_logging()  # must run before `from .database import ...` below, since
                      # database.py itself logs its (masked) DATABASE_URL at
                      # import time -- configure_logging() is idempotent, so
                      # this and database.py's own call are both harmless.
logger = logging.getLogger("qa_portal.main")

from .database import SessionLocal, AuditSessionLocal
from . import cache, models  # noqa: F401  (models ensures models are registered before create_all)
from .auth import decode_access_token
from .audit_service import write_audit
from .documents import migrate_legacy_document_layout
from .routers import (
    auth, qa_requests, functional,
    sast_dast, suppression, performance,
    approvals, signoff, dashboard, reports, export, departments, applications,
    test_projects, test_repository, test_execution, test_reports, audit, checklist_config,
    pending_approvals, defects, jobs,
)

# Reported: "Custom Fields not working" traced back to an Oracle identifier-
# length violation in one table's DDL (see the ORACLE_MIGRATION log's own
# entry) -- the follow-up question was "why did that not show any error?".
# The honest answer: create_all() ran here, completely unguarded, before the
# FastAPI app even existed -- if the DDL for one table failed, the whole
# process would crash on startup with only a bare traceback to whatever
# terminal happened to be watching, and nothing else in this app (no log
# file existed until this fix) would ever record that it happened. Wrapping
# this in try/except doesn't change the outcome -- the app still can't run
# without its schema, so this still re-raises and still refuses to start --
# but now the specific failing table/constraint is captured to
# backend/logs/app.log first, so this exact "why is nothing working, no
# error anywhere" situation is diagnosable after the fact instead of only
# live in a terminal someone happened to be watching at that exact moment.
# try:
#     Base.metadata.create_all(bind=engine)
# except Exception:
#     logger.critical(
#         "Database schema creation (Base.metadata.create_all) failed -- the "
#         "application cannot start until this is resolved. Full traceback follows.",
#         exc_info=True,
#     )
#     raise
# logger.info("Database schema verified/created successfully.")

# INF-001 -- with multiple API worker processes, this module (everything
# above `app = FastAPI(...)` below) runs once per worker, not once per
# deployment: each worker is a separate `uvicorn`-forked process that
# imports app.main fresh. The sweeps and legacy-layout migration are one-time
# filesystem/data-maintenance side effects that
# should only happen once per deployment, not once per worker. Gated on
# cache.try_acquire_lock: with Redis configured, only the first worker to
# start does this work; without Redis it's permissive (see that function's
# docstring) and every worker does it, same as before this lock existed.
with SessionLocal() as migration_db:
    if cache.try_acquire_lock("startup-migrations-and-sweeps", ttl_seconds=600):
        migrated_uploads = migrate_legacy_document_layout(migration_db)
        if migrated_uploads:
            logger.info("Migrated %d upload(s) to request-first folders", migrated_uploads)
        backfilled_departments = departments.backfill_user_department_assignments(migration_db)
        if backfilled_departments:
            logger.info("Backfilled department_assignments for %d existing user(s)", backfilled_departments)
    else:
        logger.info("Skipping legacy-layout migration/overdue sweeps -- another worker already holds the startup lock.")

app = FastAPI(
    title="QualityOps API",
    description="Backend for the Bank of Maharashtra QualityOps Enterprise "
                "Quality Operations Platform.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Reported: "why did [the Custom Fields DDL bug] not show any error?"
    -- before this handler existed, an unhandled exception anywhere in a
    route (a 500 that isn't a deliberate HTTPException) fell through to
    Starlette's own default handling: a bare "Internal Server Error" plain-
    text response to the client, and -- critically -- nothing durable
    server-side beyond whatever printed to the terminal at that moment (the
    application_audit_middleware below does record the outcome/error TYPE to
    the qap_audit_log table, but never the actual message or traceback,
    which is what's needed to diagnose a bug, not just notice one happened).

    This restores the same audit-log behavior (application_audit_middleware
    still sees a normal 500 response come back through call_next, so its own
    post-response logging path still runs unchanged) while ALSO writing a
    full traceback to backend/logs/app.log, correlated by the same
    X-Request-ID this app already generates for every request -- so a report
    like "it didn't show any error" can actually be traced afterward instead
    of only being catchable by someone staring at a live terminal at the
    exact moment it happened. The client still gets a clean, generic JSON
    message (never a raw traceback -- that would leak internals) plus the
    same request id, so a user reporting an issue can hand over one string
    that ties their bug report straight to the matching log entry."""
    request_id = getattr(request.state, "audit_request_id", None) or str(uuid.uuid4())
    logger.error(
        "Unhandled exception on %s %s (request_id=%s)",
        request.method, request.url.path, request_id,
        exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An unexpected server error occurred. Please try again, and share this "
                      f"reference if you contact support: {request_id}",
            "request_id": request_id,
        },
    )


def _request_id_for(request: Request) -> str:
    """The same correlation id application_audit_middleware attaches to this
    request (set before call_next, so it's already present by the time an
    exception handler runs -- see that middleware's docstring), or a fresh
    one for requests outside its scope (e.g. non-/api paths)."""
    return getattr(request.state, "audit_request_id", None) or str(uuid.uuid4())


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Section 8 (API Standards) -- every error response, not just unhandled
    500s, now carries the same request_id/status_code envelope so a client
    can always correlate a failure with a specific backend log entry. `detail`
    is kept as the top-level key (unchanged) since the frontend's error
    parsing (api.ts::formatBackendReason) and every existing router's
    `raise HTTPException(detail=...)` call already depend on it."""
    request_id = _request_id_for(request)
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "request_id": request_id, "status_code": exc.status_code},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Same envelope as http_exception_handler, for FastAPI's own 422 request
    validation errors (bad query params, malformed body, etc.) which
    otherwise bypass http_exception_handler entirely."""
    request_id = _request_id_for(request)
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "request_id": request_id, "status_code": 422},
    )


# AUD-001 -- module classification. Ordered longest/most-specific prefix
# first since matching is a simple startswith scan; a couple of modules
# share a router file (test-management) but keep their own path prefixes, so
# this still resolves to the right module rather than one bucket for all of
# them. Purely additive metadata (see `details` below) -- does NOT change
# `event_type`, which stays exactly {ACCESS, DATA_CHANGE, ACCESS_MANAGEMENT}
# (AuditLog.tsx's EVENT_TYPES filter dropdown is hardcoded to that set).
_MODULE_PATH_PREFIXES = [
    ("/api/auth/users", "USER_MANAGEMENT"),
    ("/api/auth/local-admin", "USER_MANAGEMENT"),
    ("/api/auth", "AUTH"),
    ("/api/qa-requests", "QA_REQUEST"),
    ("/api/functional-requests", "FUNCTIONAL_REQUEST"),
    ("/api/sast-requests", "SAST_REQUEST"),
    ("/api/dast-requests", "DAST_REQUEST"),
    ("/api/suppressions", "SUPPRESSION"),
    ("/api/performance-requests", "PERFORMANCE_REQUEST"),
    ("/api/approvals", "APPROVAL"),
    ("/api/signoffs", "SIGNOFF"),
    ("/api/dashboard", "DASHBOARD"),
    ("/api/reports", "REPORT"),
    ("/api/export", "EXPORT"),
    ("/api/departments", "DEPARTMENT"),
    ("/api/application-names", "APPLICATION"),
    ("/api/test-projects", "TEST_PROJECT"),
    ("/api/test-repository", "TEST_REPOSITORY"),
    ("/api/test-execution", "TEST_EXECUTION"),
    ("/api/test-reports", "TEST_REPORT"),
    ("/api/defects", "DEFECT"),
    ("/api/audit", "AUDIT"),
    ("/api/checklist-config", "CHECKLIST_CONFIG"),
    ("/api/pending-approvals", "PENDING_APPROVAL"),
    ("/api/system-settings", "SYSTEM_SETTING"),
]


def _classify_module(path: str) -> str:
    for prefix, module in _MODULE_PATH_PREFIXES:
        if path.startswith(prefix):
            return module
    return "OTHER"


# DSH-007 -- every one of these modules feeds routers/dashboard.py::
# dashboard_summary's counts (QA_REQUEST for target_release_date/
# department, the other four for child-request/active-request/lifecycle
# counts). Rather than threading a cache.delete_prefix() call through the
# ~30 individual create/transition/update endpoints across
# qa_requests.py/functional.py/sast_dast.py/performance.py (high blast
# radius, easy to miss one, and every one of them would need the exact same
# call), this single choke point already sees every mutating request to
# these modules via the module classification AUD-001/005 already computes
# -- one successful POST/PUT/PATCH/DELETE against any of them invalidates
# every cached dashboard summary (all department-scope/date-range variants
# at once, via the shared key prefix) rather than trying to work out which
# one variant it could have affected.
_DASHBOARD_SUMMARY_INVALIDATING_MODULES = {
    "QA_REQUEST", "FUNCTIONAL_REQUEST", "SAST_REQUEST", "DAST_REQUEST", "PERFORMANCE_REQUEST",
}


def _write_request_audit(request, request_id, status_code, duration_ms, error_name=None):
    """Persist an API audit entry after the response has been sent.

    2026-08 -- uses AuditSessionLocal (its own, deliberately smaller
    connection pool -- see database.py's own comment) rather than the main
    request-handling SessionLocal. This runs as a BackgroundTask on every
    single /api request, so under concurrent load it was competing with
    real user requests for the same DB_POOL_SIZE + DB_MAX_OVERFLOW budget;
    reported directly as a contributing factor to "API calls too slow."
    Giving it a separate pool means an audit-write backlog can no longer
    starve normal request handling of connections, and vice versa.
    """
    db = AuditSessionLocal()
    try:
        # AUD-008 -- get_current_user (deps.py) already decoded the JWT and
        # loaded the User row once per request; reuse that instead of doing
        # both again here. Reused via the plain-value SNAPSHOT
        # (request.state.current_user_snapshot), never the live ORM object
        # (request.state.current_user) -- that object belongs to the
        # request's own DB session, which is already closed by the time this
        # runs as a BackgroundTask, and touching any of its attributes here
        # can raise DetachedInstanceError (reported directly, twice -- see
        # deps.py::get_current_user's own comment for the full story). The
        # snapshot sidesteps this entirely: it was captured while that
        # session was still open, so nothing here ever reads off the
        # detached object. Only requests that never reached/passed that
        # dependency (login, invalid/missing/expired token, public routes)
        # fall through to the original decode-and-query path below, which
        # queries fresh in THIS function's own `db` session and is safe to
        # read directly.
        snapshot = getattr(getattr(request, "state", None), "current_user_snapshot", None)
        actor = None
        actor_id = actor_name = actor_roles = None
        actor_username = snapshot["username"] if snapshot else None
        if snapshot:
            actor_id = snapshot["id"]
            actor_name = snapshot["full_name"]
            actor_roles = snapshot["roles_csv"]
        else:
            auth_header = request.headers.get("authorization", "")
            if auth_header.lower().startswith("bearer "):
                try:
                    claims = decode_access_token(auth_header.split(" ", 1)[1])
                    actor_username = claims.get("sub")
                    if actor_username:
                        actor = db.query(models.User).filter(models.User.username == actor_username).first()
                except Exception:
                    pass
        method = request.method.upper()
        mutation = method in {"POST", "PUT", "PATCH", "DELETE"}
        access_management = mutation and (
            request.url.path.startswith("/api/auth/users")
            or request.url.path.startswith("/api/auth/local-admin")
            or request.url.path == "/api/auth/me"
        )
        # AUD-005 -- structured event content: module/method/path alongside
        # the existing duration_ms/error_type, so a reviewer working from
        # AuditLog.tsx's "Event details" JSON panel doesn't have to
        # cross-reference `path` on the row itself to know what was hit.
        write_audit(
            db,
            event_type="ACCESS_MANAGEMENT" if access_management else ("DATA_CHANGE" if mutation else "ACCESS"),
            action="ACCESS_CHANGE_REQUEST" if access_management else {"POST": "API_CREATE", "PUT": "API_REPLACE", "PATCH": "API_UPDATE", "DELETE": "API_DELETE"}.get(method, "API_READ"),
            outcome="SUCCESS" if status_code < 400 else "FAILED",
            # `actor` is only ever set on the fresh-query fallback path above
            # (safe, same-session); the common snapshot path passes plain
            # values instead -- see write_audit's own docstring for why.
            actor=actor,
            actor_username=actor_username,
            actor_id=actor_id,
            actor_name=actor_name,
            actor_roles=actor_roles,
            request=request,
            status_code=status_code,
            details={
                "module": _classify_module(request.url.path),
                "method": method,
                "path": request.url.path,
                "duration_ms": duration_ms,
                **({"error_type": error_name} if error_name else {}),
            },
            request_id=request_id,
        )
    finally:
        db.close()


@app.middleware("http")
async def application_audit_middleware(request, call_next):
    """Capture every API access without holding up successful responses."""
    if not request.url.path.startswith("/api") or request.url.path == "/api/health":
        return await call_next(request)

    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.audit_request_id = request_id
    request_log_token = bind_request_id(request_id)
    started = time.perf_counter()
    skip_audit = request.url.path in {"/api/auth/login", "/api/auth/logout"}
    if deep_logging_enabled():
        logger.debug("API request started method=%s path=%s", request.method, request.url.path)
    try:
        response = await call_next(request)
    except Exception as exc:
        if not skip_audit:
            _write_request_audit(
                request, request_id, 500,
                round((time.perf_counter() - started) * 1000, 2),
                type(exc).__name__,
            )
        logger.error(
            "API request failed method=%s path=%s duration_ms=%s error=%s",
            request.method,
            request.url.path,
            round((time.perf_counter() - started) * 1000, 2),
            type(exc).__name__,
        )
        reset_request_id(request_log_token)
        raise

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    # DSH-007 -- see _DASHBOARD_SUMMARY_INVALIDATING_MODULES' own comment.
    # cache.delete_prefix() is a best-effort SCAN+DEL that never raises
    # (see cache.py's own docstring), so this is safe to run inline on the
    # request path rather than needing its own BackgroundTask.
    if (
        request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
        and response.status_code < 400
        and _classify_module(request.url.path) in _DASHBOARD_SUMMARY_INVALIDATING_MODULES
    ):
        cache.delete_prefix("dashboard:summary:")
    # X-Audit-Request-ID is the original/established header name (kept for
    # any existing caller depending on it); X-Request-ID is added alongside
    # it as the conventional/standard header name (Section 8) so this also
    # matches what a client would send as X-Request-ID on the way in.
    response.headers["X-Audit-Request-ID"] = request_id
    response.headers["X-Request-ID"] = request_id
    response.headers["Server-Timing"] = f'app;dur={duration_ms}'
    if not skip_audit:
        audit_task = BackgroundTask(
            _write_request_audit, request, request_id, response.status_code, duration_ms
        )
        response.background = BackgroundTasks(
            [task for task in (response.background, audit_task) if task is not None]
        )
    if deep_logging_enabled():
        logger.debug(
            "API request completed method=%s path=%s status=%s duration_ms=%s",
            request.method, request.url.path, response.status_code, duration_ms,
        )
    else:
        try:
            slow_request_ms = max(1, int(os.getenv("SLOW_REQUEST_MS", "2000")))
        except ValueError:
            slow_request_ms = 2000
        if duration_ms >= slow_request_ms:
            logger.warning(
                "Slow API request method=%s path=%s status=%s duration_ms=%s threshold_ms=%s",
                request.method, request.url.path, response.status_code, duration_ms, slow_request_ms,
            )
    reset_request_id(request_log_token)
    return response

app.include_router(auth.router)
app.include_router(qa_requests.router)
app.include_router(functional.router)
app.include_router(sast_dast.router)
app.include_router(suppression.router)
app.include_router(performance.router)
app.include_router(approvals.router)
app.include_router(signoff.router)
app.include_router(dashboard.router)
app.include_router(reports.router)
app.include_router(export.router)
app.include_router(departments.router)
app.include_router(applications.router)
app.include_router(test_projects.router)
app.include_router(test_repository.router)
app.include_router(test_execution.router)
app.include_router(test_reports.router)
app.include_router(defects.router)
app.include_router(audit.router)
app.include_router(checklist_config.router)
app.include_router(pending_approvals.router)
app.include_router(jobs.router)


@app.get("/api/health")
def health():
    """INF-003 -- extended beyond a bare liveness check so a load balancer
    or ops dashboard can distinguish "process is up" from "dependencies are
    reachable". `database` is checked live (a load balancer deciding whether
    to route traffic here needs to know NOW, not whether it worked at
    startup); `cache` reports the last-known Redis connection state rather
    than forcing a new connection on every health check poll, since Redis
    being down should degrade caching, not this endpoint's latency/cost."""
    try:
        with SessionLocal() as db:
            db.execute(sqlalchemy_text("SELECT 1 FROM DUAL"))
        db_ok = True
    except Exception:
        db_ok = False
    cache_status = "connected" if cache.available() else ("disabled" if not cache.REDIS_URL else "unreachable")
    return {
        "status": "ok" if db_ok else "degraded",
        "database": "ok" if db_ok else "unreachable",
        "cache": cache_status,
    }
