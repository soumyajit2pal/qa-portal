import time
import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine, SessionLocal
from . import models  # noqa: F401  (ensures models are registered before create_all)
from .auth import decode_access_token
from .audit_service import write_audit
from .routers import (
    auth, qa_requests, functional,
    sast_dast, suppression, performance,
    approvals, signoff, dashboard, reports, export, departments, applications,
    test_projects, test_repository, test_execution, audit, checklist_config,
)

Base.metadata.create_all(bind=engine)

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


@app.middleware("http")
async def application_audit_middleware(request, call_next):
    """Capture every API access centrally without retaining bodies or credentials."""
    if not request.url.path.startswith("/api") or request.url.path == "/api/health":
        return await call_next(request)

    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.audit_request_id = request_id
    started = time.perf_counter()
    status_code = 500
    response = None
    error_name = None
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["X-Audit-Request-ID"] = request_id
        return response
    except Exception as exc:
        error_name = type(exc).__name__
        raise
    finally:
        # Login/logout are logged explicitly with meaningful outcomes. Avoid a
        # second, generic API row for those two authentication events.
        if request.url.path not in {"/api/auth/login", "/api/auth/logout"}:
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
                    details={
                        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                        **({"error_type": error_name} if error_name else {}),
                    },
                    request_id=request_id,
                )
            finally:
                db.close()

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


@app.get("/api/health")
def health():
    return {"status": "ok"}
