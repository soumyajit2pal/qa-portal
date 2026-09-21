from unittest.mock import patch
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.exc import OperationalError
from starlette.requests import Request
from app.models import LoginFailure
from app import login_rate_limit as limits


def request(host='10.0.0.1'):
    return Request({'type': 'http', 'client': (host, 123), 'headers': []})


def proxy_request(real_ip=None):
    headers = [] if real_ip is None else [(b'x-real-ip', real_ip.encode())]
    return Request({'type': 'http', 'client': (None, 0), 'headers': headers})


@pytest.fixture
def store(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'limits.db'))
    LoginFailure.__table__.create(engine)
    factory = sessionmaker(bind=engine)
    with patch.object(limits, '_session', side_effect=factory):
        yield factory
    engine.dispose()


def fail_five(username='user', host='10.0.0.1'):
    for _ in range(5):
        limits.record(request(host), username)


def test_wait_time_and_expiry(store):
    with patch.object(limits.time, 'time', return_value=1000):
        fail_five()
    with patch.object(limits.time, 'time', return_value=1060.2):
        with pytest.raises(HTTPException) as exc:
            limits.enforce(request(), ' USER ')
        assert exc.value.status_code == 429
        assert exc.value.headers['Retry-After'] == '840'
        assert '14 minute(s) 0 second(s)' in exc.value.detail
    with patch.object(limits.time, 'time', return_value=1900):
        limits.enforce(request(), 'user')


def test_unlock_all_ips_persists_and_preserves_other_users(store):
    fail_five()
    fail_five(host='10.0.0.2')
    fail_five(username='other')
    with store() as db:
        assert limits.unlock(db, 'USER') == 10
        db.commit()
    limits.enforce(request(), 'user')
    limits.enforce(request('10.0.0.2'), 'user')
    with pytest.raises(HTTPException):
        limits.enforce(request(), 'other')
    # Clearing is temporary recovery, not a permanent rate-limit exemption.
    fail_five()
    with pytest.raises(HTTPException):
        limits.enforce(request(), 'user')


def test_success_clears_only_current_ip(store):
    fail_five()
    fail_five(host='10.0.0.2')
    limits.clear(request(), 'user')
    limits.enforce(request(), 'user')
    with pytest.raises(HTTPException):
        limits.enforce(request('10.0.0.2'), 'user')


def test_proxy_client_without_host_records_failure_instead_of_returning_503(store):
    """Uvicorn may expose client=(None, 0) behind a trusted reverse proxy."""
    proxied = proxy_request('10.20.30.40')
    limits.record(proxied, 'user')

    with store() as db:
        row = db.query(LoginFailure).one()
        assert row.host == '10.20.30.40'

    limits.clear(proxied, 'user')


def test_proxy_client_without_any_valid_address_uses_non_null_bucket(store):
    proxied = proxy_request()
    limits.record(proxied, 'user')

    with store() as db:
        row = db.query(LoginFailure).one()
        assert row.host == 'unknown'


def test_wait_for_fifth_newest_failure_when_concurrent_attempts_exceed_limit(store):
    with patch.object(limits.time, 'time', return_value=1000):
        limits.record(request(), 'user')
    with patch.object(limits.time, 'time', return_value=1100):
        fail_five()
    with patch.object(limits.time, 'time', return_value=1900):
        with pytest.raises(HTTPException) as exc:
            limits.enforce(request(), 'user')
        assert exc.value.headers['Retry-After'] == '100'


@pytest.mark.parametrize('operation', [limits.enforce, limits.record, limits.clear])
def test_database_outage_fails_closed(operation):
    with patch.object(limits, '_session', side_effect=OperationalError('', {}, Exception())):
        with pytest.raises(HTTPException) as exc:
            operation(request(), 'user')
    assert exc.value.status_code == 503


@pytest.mark.parametrize('role,expected', [('ADMIN', 200), ('REQUESTER', 403)])
def test_unlock_endpoint_requires_admin_and_audits(role, expected):
    from unittest.mock import MagicMock
    from fastapi import FastAPI
    import asyncio
    from app.routers import auth
    from app.deps import get_current_user
    from app.database import get_db
    from app.models import User, UserRole
    actor = User(id=1, username='admin', full_name='Admin', is_active=True,
                 role_assignments=[UserRole(role=role)])
    target = User(id=2, username='user', full_name='User', is_active=False)
    db = MagicMock()
    db.get.return_value = target
    app = FastAPI()
    app.include_router(auth.router)
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = lambda: db
    with patch.object(auth, '_unlock_login_failures', return_value=5) as unlock, \
         patch.object(auth, 'write_audit') as audit:
        messages = []
        async def receive():
            return {'type': 'http.request', 'body': b'', 'more_body': False}
        async def send(message):
            messages.append(message)
        asyncio.run(app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                         'method': 'POST', 'scheme': 'http', 'path': '/api/auth/users/2/unlock-login',
                         'query_string': b'', 'headers': [], 'server': ('test', 80),
                         'client': ('test', 123)}, receive, send))
    assert next(m['status'] for m in messages if m['type'] == 'http.response.start') == expected
    if expected == 200:
        unlock.assert_called_once_with(db, 'user')
        db.commit.assert_called_once()
        assert audit.call_args.kwargs['action'] == 'LOGIN_UNLOCK'
        assert target.is_active is False
    else:
        unlock.assert_not_called()
        audit.assert_not_called()
