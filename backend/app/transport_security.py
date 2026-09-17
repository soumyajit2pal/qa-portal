"""Reject cleartext application traffic in deployed environments.

The ASGI scheme is set by TLS or Uvicorn's trusted-proxy handling. Never
trust a raw X-Forwarded-Proto header here: clients can forge it.
"""
from fastapi import Request
from fastapi.responses import JSONResponse
from .config import settings


def insecure_deployment_request(request: Request) -> bool:
    return (settings.app_env in {"uat", "prod", "production"}
            and request.url.path != "/api/health"
            and request.url.scheme != "https")


async def enforce_https(request: Request, call_next):
    if insecure_deployment_request(request):
        return JSONResponse(status_code=426,
                            content={"detail": "HTTPS is required. Use the secure portal URL."},
                            headers={"Cache-Control": "no-store"})
    return await call_next(request)
