import asyncio

import pytest
from starlette.requests import Request
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.config import settings
from app.transport_security import insecure_deployment_request


@pytest.mark.parametrize('peer, forwarded, trusted, expected', [
    ('10.88.0.12', 'https', '127.0.0.1', 426),
    ('10.88.0.12', 'https', '10.88.0.12', 200),
    ('10.88.0.13', 'https', '10.88.0.12', 426),
    ('10.88.0.12', 'http', '10.88.0.12', 426),
])
def test_https_guard_uses_uvicorn_trusted_proxy_scheme(monkeypatch, peer, forwarded, trusted, expected):
    monkeypatch.setattr(settings, 'app_env', 'uat')
    statuses = []

    async def endpoint(scope, receive, send):
        statuses.append(426 if insecure_deployment_request(Request(scope)) else 200)

    scope = {'type': 'http', 'http_version': '1.1', 'method': 'GET',
             'path': '/api/auth/login-key', 'root_path': '', 'query_string': b'',
             'scheme': 'http', 'server': ('backend', 8000), 'client': (peer, 12345),
             'headers': [(b'host', b'backend'), (b'x-forwarded-proto', forwarded.encode())]}
    asyncio.run(ProxyHeadersMiddleware(endpoint, trusted_hosts=trusted)(scope, None, None))
    assert statuses == [expected]
