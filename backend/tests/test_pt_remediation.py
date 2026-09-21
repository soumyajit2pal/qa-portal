import base64
import json
from unittest.mock import patch
from pathlib import Path
import pytest
from fastapi import HTTPException
import asyncio
from starlette.responses import JSONResponse
import jwt
from jwt import PyJWTError as JWTError
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.requests import Request
from app import models, schemas
from app.auth import create_access_token, decode_access_token, SECRET_KEY, ALGORITHM
from app.deps import _resolve_current_user, require_roles
from app.transport_security import enforce_https
from app.config import settings

def request(path='/api/auth/me'):
    return Request({'type': 'http', 'method': 'GET', 'path': path, 'query_string': b'', 'headers': [],
                    'scheme': 'https', 'server': ('test', 443), 'client': ('test', 1)})

@pytest.mark.parametrize('field', ['username', 'full_name', 'id', 'hashed_password', 'role_assignments', 'unknown'])
def test_user_update_rejects_protected_fields(field):
    with pytest.raises(ValidationError):
        schemas.UserUpdate.model_validate({field: 'attacker', 'email': 'notify@example.test'})

def test_allowed_update_fields():
    assert schemas.UserUpdate(email='notify@example.test', roles=['REQUESTER']).roles == ['REQUESTER']

def test_tampered_token_signature():
    token = create_access_token({'sub': 'requester', 'roles': ['REQUESTER']})
    header, body, signature = token.split('.')
    payload = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
    payload.update(sub='admin', roles=['ADMIN'])
    altered = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
    with pytest.raises(JWTError):
        decode_access_token('.'.join([header, altered, signature]))

@pytest.mark.parametrize('claim', ['sub', 'exp', 'iat', 'iss', 'aud', 'jti'])
def test_required_claims(claim):
    claims = decode_access_token(create_access_token({'sub': 'requester'})); claims.pop(claim)
    with pytest.raises(JWTError):
        decode_access_token(jwt.encode(claims, SECRET_KEY, algorithm=ALGORITHM))

def test_session_identity_uses_live_database_roles():
    engine = create_engine('sqlite://'); models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        workspace = models.QAWorkspace(workspace_key='DEFAULT', name='Default', is_active=True, is_default=True)
        user = models.User(username='requester', full_name='Requester', hashed_password='x', is_active=True,
                           role_assignments=[models.UserRole(role='REQUESTER')])
        db.add_all([workspace, user]); db.commit()
        resolved = _resolve_current_user(request(), user.id, db)
        assert resolved.username == 'requester' and resolved.roles == ['REQUESTER']
        with pytest.raises(HTTPException) as exc:
            require_roles('ADMIN')(request('/api/auth/users'), resolved)
        assert exc.value.status_code == 403
        user.is_active = False; db.commit()
        with pytest.raises(HTTPException) as exc:
            _resolve_current_user(request(), user.id, db)
        assert exc.value.status_code == 401
    engine.dispose()

def test_http_and_spoofed_proxy_header_rejected():
    async def next_handler(req):
        return JSONResponse({'ok': True})
    with patch.object(settings, 'app_env', 'prod'):
        req = request()
        req.scope['scheme'] = 'http'
        req.scope['headers'] = [(b'x-forwarded-proto', b'https')]
        assert asyncio.run(enforce_https(req, next_handler)).status_code == 426
        assert asyncio.run(enforce_https(request(), next_handler)).status_code == 200
        req = request('/api/health'); req.scope['scheme'] = 'http'
        assert asyncio.run(enforce_https(req, next_handler)).status_code == 200


def test_nginx_csp_and_tls():
    root = Path(__file__).resolve().parents[2]
    for name in ['nginx.conf', 'nginx.conf.template']:
        config = (root / 'frontend' / name).read_text()
        assert "script-src 'self'; script-src-attr 'none'" in config
        assert "style-src-elem 'self'" in config
        assert 'TLSv1.2 TLSv1.3' in config
        assert "location ~ ^/api/test-execution/executions/[0-9]+/rich-result$" in config
        assert 'proxy_request_buffering off' in config


def test_https_forwarding_is_accepted_only_from_configured_proxy_peer():
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
    results = []
    async def downstream(scope, receive, send):
        async def next_handler(req): return JSONResponse({'ok': True})
        results.append((await enforce_https(Request(scope), next_handler)).status_code)
    middleware = ProxyHeadersMiddleware(downstream, trusted_hosts='127.0.0.1')
    async def receive(): return {'type': 'http.request', 'body': b''}
    async def send(message): pass
    with patch.object(settings, 'app_env', 'uat'):
        for peer in ['127.0.0.1', '203.0.113.10']:
            scope = dict(request().scope)
            scope.update(scheme='http', client=(peer, 1234),
                         headers=[(b'x-forwarded-proto', b'https')])
            asyncio.run(middleware(scope, receive, send))
    assert results == [200, 426]
