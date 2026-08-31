"""Dedicated runtime for the high-volume Document Portal service.

The main QualityOps API intentionally does not import this application.  It
is deployed as a separate container and nginx sends only
``/api/document-portal`` traffic here.  Both services read the same Oracle
identity/role mappings and JWT secret, so users retain one login and one
portal URL while large file uploads cannot consume the core workflow API's
workers, memory, or upload-temporary storage.
"""
import logging
import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, TimeoutError as SQLAlchemyTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .database import main_pool_metrics
from .logging_config import bind_request_id, configure_logging, reset_request_id
from .resilience import CircuitOpenError, database_circuit, is_transient_database_error, snapshot as resilience_snapshot

configure_logging()
logger = logging.getLogger("qa_portal.document_portal_service")

# Importing models registers the complete ORM metadata used by the shared
# auth dependencies.  This service performs no startup migrations, cache
# sweep, dashboard work, or SMTP polling; those remain owned by core API.
from . import models  # noqa: F401
from .routers import document_portal

app = FastAPI(
    title="QualityOps Document Portal API",
    description="Isolated authenticated file repository service for QualityOps.",
    version="1.0.0",
)


@app.middleware("http")
async def document_portal_request_observability(request: Request, call_next):
    """Give the isolated service the same request correlation as core API."""
    if request.url.path == "/api/health":
        return await call_next(request)
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    token = bind_request_id(request_id)
    started = time.perf_counter()
    try:
        database_circuit.check()
        response = await call_next(request)
        if response.status_code < 500:
            database_circuit.record_success()
    except CircuitOpenError as exc:
        logger.warning(
            "Document Portal database request rejected reason=circuit_open method=%s path=%s retry_after=%ss pool=%s",
            request.method, request.url.path, exc.retry_after_seconds, main_pool_metrics(),
        )
        return JSONResponse(
            status_code=503,
            content={"detail": "The Document Portal database is temporarily busy. Please retry in a moment.", "request_id": request_id},
            headers={"Retry-After": str(exc.retry_after_seconds), "X-Request-ID": request_id},
        )
    except SQLAlchemyTimeoutError:
        database_circuit.record_failure()
        logger.error(
            "Document Portal database pool exhausted method=%s path=%s pool=%s",
            request.method, request.url.path, main_pool_metrics(), exc_info=True,
        )
        return JSONResponse(
            status_code=503,
            content={"detail": "The Document Portal database is temporarily busy. Please retry in a moment.", "request_id": request_id},
            headers={"Retry-After": "2", "X-Request-ID": request_id},
        )
    except DBAPIError as exc:
        if not is_transient_database_error(exc):
            raise
        database_circuit.record_failure()
        retry_after = database_circuit.snapshot().retry_after_seconds or 2
        logger.error(
            "Document Portal transient database failure method=%s path=%s pool=%s",
            request.method, request.url.path, main_pool_metrics(), exc_info=True,
        )
        return JSONResponse(
            status_code=503,
            content={"detail": "The Document Portal database is temporarily unavailable. Please retry in a moment.", "request_id": request_id},
            headers={"Retry-After": str(retry_after), "X-Request-ID": request_id},
        )
    else:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-ID"] = request_id
        response.headers["Server-Timing"] = f"app;dur={duration_ms}"
        try:
            slow_request_ms = max(1, int(os.getenv("SLOW_REQUEST_MS", "2000")))
        except ValueError:
            slow_request_ms = 2000
        if response.status_code >= 500 or duration_ms >= slow_request_ms:
            logger.warning(
                "Document Portal request completed method=%s path=%s status=%s duration_ms=%s pool=%s",
                request.method, request.url.path, response.status_code, duration_ms, main_pool_metrics(),
            )
        return response
    finally:
        reset_request_id(token)


@app.exception_handler(SQLAlchemyTimeoutError)
async def database_pool_timeout_handler(request: Request, exc: SQLAlchemyTimeoutError):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    logger.error(
        "Document Portal database pool exhausted method=%s path=%s pool=%s",
        request.method, request.url.path, main_pool_metrics(), exc_info=True,
    )
    database_circuit.record_failure()
    return JSONResponse(
        status_code=503,
        content={
            "detail": "The Document Portal database is temporarily busy. Please retry in a moment.",
            "request_id": request_id,
        },
        headers={"Retry-After": "2", "X-Request-ID": request_id},
    )


@app.exception_handler(StarletteHTTPException)
async def document_portal_http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Keep 404/403 responses traceable when the proxy reaches this service."""
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    if exc.status_code == 404:
        logger.warning(
            "Document Portal route not found method=%s path=%s request_id=%s",
            request.method, request.url.path, request_id,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "request_id": request_id, "status_code": exc.status_code},
        headers={"X-Request-ID": request_id, **(exc.headers or {})},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    logger.error(
        "Document Portal request failed method=%s path=%s request_id=%s",
        request.method,
        request.url.path,
        request_id,
        exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "The Document Portal could not complete this request. Please try again, and share this reference if you contact support: " + request_id,
            "request_id": request_id,
        },
    )


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "document-portal", "circuits": resilience_snapshot()}


app.include_router(document_portal.router)
