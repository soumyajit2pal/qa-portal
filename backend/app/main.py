import logging
import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text as sqlalchemy_text
from sqlalchemy.exc import DBAPIError, TimeoutError as SQLAlchemyTimeoutError
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

from .database import SessionLocal, AuditSessionLocal, main_pool_metrics
from . import cache, models, email_notifications  # noqa: F401  (models ensures models are registered before create_all)
from .auth import decode_access_token
from .constants import is_document_portal_only
from .audit_service import write_audit
from .documents import migrate_legacy_document_layout
from .resilience import CircuitOpenError, database_circuit, is_transient_database_error, snapshot as resilience_snapshot
from .routers import (
    auth, qa_requests, functional,
    sast_dast, suppression, performance,
    approvals, signoff, dashboard, reports, export, departments, applications,
    test_projects, test_repository, test_execution, test_reports, audit, checklist_config,
    pending_approvals, defects, jobs,
)


# Production Compose runs file traffic in app.document_portal_main so large
# transfers never share the core workflow workers. Traditional local/QA
# startup (`uvicorn app.main:app`) has no second ASGI process, however, so it
# embeds the same router by default. Set DOCUMENT_PORTAL_EMBEDDED=false only
# when nginx routes Document Portal traffic to the dedicated service.
DOCUMENT_PORTAL_EMBEDDED = os.getenv("DOCUMENT_PORTAL_EMBEDDED", "true").strip().lower() in {"1", "true", "yes", "on"}
if DOCUMENT_PORTAL_EMBEDDED:
    from .routers import document_portal

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

# Workflow emails are queued transactionally for every approval action. SMTP
# delivery remains disabled until deployment sets SMTP_ENABLED=true.
email_notifications.install_outbox_listener()
smtp_ready, smtp_reason = email_notifications.smtp_readiness()
if smtp_ready:
    logger.info("SMTP delivery is enabled; durable outbox polling started.")
    # Resume any notifications delayed by a temporary SMTP outage. The
    # outbox's atomic claim makes this safe with many workers.
    email_notifications.start_outbox_poller()
else:
    logger.info("SMTP delivery is disabled or incomplete: %s", smtp_reason)

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
    ("/api/document-portal", "DOCUMENT_PORTAL"),
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


def _log_file_operation(request, response) -> None:
    """Record completed file operations without ever inspecting file bodies.

    Request uploads, evidence attachments, import spreadsheets and generated
    downloads live in several independent routers.  This single successful
    response boundary gives operations one dependable trail for all of them.
    Document Portal has richer item-level logging in its own router, so it is
    intentionally excluded here to avoid duplicate records.
    """
    if response.status_code >= 400:
        return
    path = request.url.path
    if path.startswith("/api/document-portal"):
        return
    method = request.method.upper()
    snapshot = getattr(getattr(request, "state", None), "current_user_snapshot", None) or {}
    username = snapshot.get("username") or "unknown"
    lower_path = path.lower()
    if method == "GET" and ("/download" in lower_path or lower_path.startswith("/api/export")):
        logger.info("File download requested user=%s path=%s status=%s", username, path, response.status_code)
    elif method in {"POST", "PUT", "PATCH"} and any(
        marker in lower_path for marker in ("/documents", "/attachments", "/images", "/import", "/bulk-seed")
    ):
        logger.info("File upload or import completed user=%s method=%s path=%s status=%s", username, method, path, response.status_code)


_DOCUMENT_PORTAL_ALLOWED_API_PATHS = {
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
    "/api/auth/me/email",
    "/api/health",
}


def _ldap_email_completion_required(user: models.User) -> bool:
    """Whether an approved LDAP account must supply its notification email.

    Department choice and role review must finish first.  This avoids
    presenting two blocking onboarding actions at once and ensures that a
    person whose access is still pending cannot infer that their request has
    been approved merely because the email form appeared.
    """
    return bool(
        user.login_type == "LDAP"
        and not user.needs_department_selection
        and not user.needs_role_review
        and user.roles
        and not (user.email or "").strip()
    )


@app.middleware("http")
async def pending_access_approval_api_guard(request, call_next):
    """Do not expose portal data while a newly provisioned LDAP account waits.

    Department selection identifies the correct Coordinator; it must not be
    treated as approval to use the portal. This check uses the live database
    role assignments so it releases immediately after approval.
    """
    path = request.url.path
    if not path.startswith("/api") or path in _DOCUMENT_PORTAL_ALLOWED_API_PATHS:
        return await call_next(request)

    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        return await call_next(request)
    try:
        claims = decode_access_token(auth_header.split(" ", 1)[1])
        username = claims.get("sub")
    except Exception:
        return await call_next(request)
    if not username:
        return await call_next(request)

    # Do not forward the request from inside this context manager.  Doing so
    # used to retain one Oracle connection for the *entire* downstream API
    # request. Together with the email guard below, one dashboard request
    # consumed three pool connections (two guards plus its route session).
    # Under concurrent dashboard loads that exhausted the pool even though
    # every route's own get_db dependency correctly closes its session.
    with SessionLocal() as db:
        user = db.query(models.User).filter(models.User.username == username).first()
        # While the department picker is open, /api/departments must remain
        # available. Once it has been saved, an LDAP account with zero roles
        # is deliberately limited to /me and logout until approval.
        allow_request = (
            not user
            or not user.is_active
            or user.needs_department_selection
            or not user.needs_role_review
            or user.roles
        )
        if not allow_request:
            request.state.current_user_snapshot = {
                "id": user.id,
                "username": user.username,
                "full_name": user.full_name,
                "roles_csv": user.roles_csv,
            }
    if allow_request:
        return await call_next(request)
    return JSONResponse(
        status_code=403,
        content={
            "detail": "Your access request is pending Administrator or Department Coordinator approval.",
            "status_code": 403,
        },
    )


@app.middleware("http")
async def ldap_email_completion_api_guard(request, call_next):
    """Require a notification address before exposing approved LDAP access.

    The mandatory browser modal gives users a clear recovery path, and this
    companion guard closes the direct-URL/API bypass path while their account
    still has no mail address for workflow notifications.
    """
    path = request.url.path
    if not path.startswith("/api") or path in _DOCUMENT_PORTAL_ALLOWED_API_PATHS:
        return await call_next(request)

    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        return await call_next(request)
    try:
        claims = decode_access_token(auth_header.split(" ", 1)[1])
        username = claims.get("sub")
    except Exception:
        return await call_next(request)
    if not username:
        return await call_next(request)

    # Same lifetime rule as the pending-access guard above: this read is only
    # a gate decision, so its database connection must be returned before the
    # actual endpoint begins its own work.
    with SessionLocal() as db:
        user = db.query(models.User).filter(models.User.username == username).first()
        allow_request = not user or not user.is_active or not _ldap_email_completion_required(user)
        if not allow_request:
            request.state.current_user_snapshot = {
                "id": user.id,
                "username": user.username,
                "full_name": user.full_name,
                "roles_csv": user.roles_csv,
            }
    if allow_request:
        return await call_next(request)
    return JSONResponse(
        status_code=403,
        content={
            "detail": "Add your notification email address before using QA Portal.",
            "status_code": 403,
        },
    )


@app.middleware("http")
async def document_portal_only_api_guard(request, call_next):
    """Keep document-only accounts inside the Document Portal at API level.

    The frontend guard gives a clear page-level explanation, while this
    server-side guard prevents a direct URL or manually issued API request
    from exposing any other module's data. It confirms the role assignment
    in the database before blocking, so a user whose access has been
    expanded is not kept unnecessarily inside the Document Portal.
    """
    path = request.url.path
    if (
        not path.startswith("/api")
        or path.startswith("/api/document-portal")
        or path in _DOCUMENT_PORTAL_ALLOWED_API_PATHS
    ):
        return await call_next(request)

    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        return await call_next(request)
    try:
        claims = decode_access_token(auth_header.split(" ", 1)[1])
        username = claims.get("sub")
    except Exception:
        return await call_next(request)
    if not username or not is_document_portal_only(claims.get("roles")):
        return await call_next(request)

    # This guard applies to a narrow account type, but it follows the same
    # strict connection-lifetime rule as the two general guards above.
    with SessionLocal() as db:
        user = db.query(models.User).filter(models.User.username == username).first()
        allow_request = not user or not user.is_active or not is_document_portal_only(user.roles)
        if not allow_request:
            request.state.current_user_snapshot = {
                "id": user.id,
                "username": user.username,
                "full_name": user.full_name,
                "roles_csv": user.roles_csv,
            }
    if allow_request:
        return await call_next(request)
    return JSONResponse(
        status_code=403,
        content={
            "detail": "You only have access to Document Portal.",
            "status_code": 403,
        },
    )


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
        database_circuit.check()
        response = await call_next(request)
    except CircuitOpenError as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        logger.warning(
            "Database request rejected reason=circuit_open method=%s path=%s retry_after=%ss pool=%s",
            request.method, request.url.path, exc.retry_after_seconds, main_pool_metrics(),
        )
        reset_request_id(request_log_token)
        return JSONResponse(
            status_code=503,
            content={
                "detail": "The database is temporarily busy. Please retry in a moment.",
                "request_id": request_id,
            },
            headers={"Retry-After": str(exc.retry_after_seconds), "X-Audit-Request-ID": request_id, "X-Request-ID": request_id},
        )
    except SQLAlchemyTimeoutError:
        # A pool timeout is temporary capacity pressure, not an application
        # defect.  It must be visible to operations with the pool snapshot,
        # and clients receive a retryable 503 instead of an opaque 500.
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        pool = main_pool_metrics()
        logger.error(
            "Database pool exhausted method=%s path=%s duration_ms=%s pool=%s",
            request.method, request.url.path, duration_ms, pool,
        )
        database_circuit.record_failure()
        if not skip_audit:
            _write_request_audit(request, request_id, 503, duration_ms, "DatabasePoolTimeout")
        reset_request_id(request_log_token)
        return JSONResponse(
            status_code=503,
            content={
                "detail": "The database is temporarily busy. Please retry in a moment.",
                "request_id": request_id,
            },
            headers={"Retry-After": "2", "X-Audit-Request-ID": request_id, "X-Request-ID": request_id},
        )
    except DBAPIError as exc:
        if not is_transient_database_error(exc):
            if not skip_audit:
                _write_request_audit(
                    request, request_id, 500,
                    round((time.perf_counter() - started) * 1000, 2),
                    type(exc).__name__,
                )
            reset_request_id(request_log_token)
            raise
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        database_circuit.record_failure()
        retry_after = database_circuit.snapshot().retry_after_seconds or 2
        logger.error(
            "Transient database failure method=%s path=%s duration_ms=%s retry_after=%ss pool=%s",
            request.method, request.url.path, duration_ms, retry_after, main_pool_metrics(), exc_info=True,
        )
        reset_request_id(request_log_token)
        return JSONResponse(
            status_code=503,
            content={
                "detail": "The database is temporarily unavailable. Please retry in a moment.",
                "request_id": request_id,
            },
            headers={"Retry-After": str(retry_after), "X-Audit-Request-ID": request_id, "X-Request-ID": request_id},
        )
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
    if response.status_code < 500:
        database_circuit.record_success()
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
    _log_file_operation(request, response)
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
                "Slow API request method=%s path=%s status=%s duration_ms=%s threshold_ms=%s pool=%s",
                request.method, request.url.path, response.status_code, duration_ms, slow_request_ms,
                main_pool_metrics(),
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
if DOCUMENT_PORTAL_EMBEDDED:
    app.include_router(document_portal.router)
    logger.warning(
        "Document Portal is running in embedded mode. Use the dedicated document_portal service in production."
    )
else:
    # Production Compose routes this prefix to app.document_portal_main in its
    # own container. Keeping upload/download streams out of core workflow
    # workers protects approvals, dashboards and normal request actions.
    logger.info("Document Portal routes are delegated to the dedicated service.")


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
        "database_pool": main_pool_metrics(),
        "circuits": resilience_snapshot(),
    }
