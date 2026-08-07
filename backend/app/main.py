import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.background import BackgroundTask, BackgroundTasks

from .logging_config import configure_logging
configure_logging()  # must run before `from .database import ...` below, since
                      # database.py itself logs its (masked) DATABASE_URL at
                      # import time -- configure_logging() is idempotent, so
                      # this and database.py's own call are both harmless.
logger = logging.getLogger("qa_portal")

from .database import Base, engine, SessionLocal
from . import models  # noqa: F401  (ensures models are registered before create_all)
from .auth import decode_access_token
from .audit_service import write_audit
from .documents import migrate_legacy_document_layout
from .routers import (
    auth, qa_requests, functional,
    sast_dast, suppression, performance,
    approvals, signoff, dashboard, reports, export, departments, applications,
    test_projects, test_repository, test_execution, audit, checklist_config,
    pending_approvals, system_settings,
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
try:
    Base.metadata.create_all(bind=engine)
except Exception:
    logger.critical(
        "Database schema creation (Base.metadata.create_all) failed -- the "
        "application cannot start until this is resolved. Full traceback follows.",
        exc_info=True,
    )
    raise
logger.info("Database schema verified/created successfully.")

# Normalize older module-first evidence folders once at startup. The
# migration is idempotent and only moves files tracked in RequestDocument.
with SessionLocal() as migration_db:
    system_settings.load_storage_settings(migration_db)
    migrated_uploads = migrate_legacy_document_layout(migration_db)
    if migrated_uploads:
        logger.info("Migrated %d upload(s) to request-first folders", migrated_uploads)

app = FastAPI(
    title="Centralized QA Portal API",
    description="Backend for the Bank of Maharashtra Centralized QA Portal "
                 "(Change Request: Centralized QA Portal Creation, FY 2026-27).",
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


def _write_request_audit(request, request_id, status_code, duration_ms, error_name=None):
    """Persist an API audit entry after the response has been sent."""
    db = SessionLocal()
    try:
        actor = None
        actor_username = None
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
        write_audit(
            db,
            event_type="ACCESS_MANAGEMENT" if access_management else ("DATA_CHANGE" if mutation else "ACCESS"),
            action="ACCESS_CHANGE_REQUEST" if access_management else {"POST": "API_CREATE", "PUT": "API_REPLACE", "PATCH": "API_UPDATE", "DELETE": "API_DELETE"}.get(method, "API_READ"),
            outcome="SUCCESS" if status_code < 400 else "FAILED",
            actor=actor,
            actor_username=actor_username,
            request=request,
            status_code=status_code,
            details={"duration_ms": duration_ms, **({"error_type": error_name} if error_name else {})},
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
    started = time.perf_counter()
    skip_audit = request.url.path in {"/api/auth/login", "/api/auth/logout"}
    try:
        response = await call_next(request)
    except Exception as exc:
        if not skip_audit:
            _write_request_audit(
                request, request_id, 500,
                round((time.perf_counter() - started) * 1000, 2),
                type(exc).__name__,
            )
        raise

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    response.headers["X-Audit-Request-ID"] = request_id
    response.headers["Server-Timing"] = f'app;dur={duration_ms}'
    if not skip_audit:
        audit_task = BackgroundTask(
            _write_request_audit, request, request_id, response.status_code, duration_ms
        )
        response.background = BackgroundTasks(
            [task for task in (response.background, audit_task) if task is not None]
        )
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
app.include_router(audit.router)
app.include_router(checklist_config.router)
app.include_router(pending_approvals.router)
app.include_router(system_settings.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
