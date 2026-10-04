"""Shared failed-login window and administrator recovery."""
import math
import hashlib
import json
import os
import time
import uuid
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from .models import LoginFailure
from .audit_service import request_ip
from .config import settings

WINDOW_SECONDS = 15 * 60
MAX_FAILURES = 5
RESERVATION_SECONDS = 300


# All keys share the normalized username's Redis Cluster hash tag. The user
# epoch invalidates every IP on an administrative unlock without key scans.
# The failures index is only for an accurate administrator audit count.
_REDIS_WINDOW_SCRIPT = r"""
local operation, now, token = ARGV[1], tonumber(ARGV[2]), ARGV[3]
local window, limit, reservation = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local ttl = window + reservation + 1
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - window)
if operation == 'unlock' then
    local count = redis.call('ZCARD', KEYS[3])
    for _, legacy_id in ipairs(cjson.decode(ARGV[8] or '[]')) do
        if not redis.call('ZSCORE', KEYS[3], legacy_id) then count = count + 1 end
    end
    redis.call('DEL', KEYS[3])
    redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], ttl)
    return {1, 0, count}
end
local epoch = redis.call('GET', KEYS[1]) or '0'
if epoch ~= '0' then redis.call('EXPIRE', KEYS[1], ttl) end
local raw = redis.call('GET', KEYS[2])
if not raw and epoch == '0' and operation ~= 'clear' and ARGV[8] == '' then
    -- Load the old Oracle window only for the first admission in this bucket.
    -- A second invocation will seed only if no other worker initialized it.
    return {2, 0, 0}
end
local bucket = raw and cjson.decode(raw) or {epoch=epoch, failures={}, pending={}}
if bucket.epoch ~= epoch then bucket = {epoch=epoch, failures={}, pending={}} end
if not raw and epoch == '0' and operation ~= 'clear' then
    bucket.failures = cjson.decode(ARGV[8])
    for _, failure in ipairs(bucket.failures) do redis.call('ZADD', KEYS[3], failure.at, failure.id) end
end
local current = {}
for _, failure in ipairs(bucket.failures) do
    if failure.at > now - window then table.insert(current, failure) end
end
bucket.failures = current
for pending_token, expires in pairs(bucket.pending) do
    if expires <= now then bucket.pending[pending_token] = nil end
end
local function save()
    redis.call('SET', KEYS[2], cjson.encode(bucket), 'EX', ttl)
    redis.call('EXPIRE', KEYS[3], ttl)
end
if operation == 'clear' then
    local count = #bucket.failures
    for _, failure in ipairs(bucket.failures) do redis.call('ZREM', KEYS[3], failure.id) end
    bucket.failures, bucket.pending = {}, {}
    save()
    return {1, 0, count}
elseif operation == 'failure' then
    -- A late completion must never reverse an administrator's unlock.
    if ARGV[7] ~= '' and ARGV[7] ~= epoch then return {1, 0, 0} end
    bucket.pending[token] = nil
    for _, failure in ipairs(bucket.failures) do
        if failure.id == token then return {1, 0, 0} end
    end
    table.insert(bucket.failures, {at=now, id=token})
    redis.call('ZADD', KEYS[3], now, token)
    save()
    return {1, 0, 1}
end
local expiries = {}
for _, failure in ipairs(bucket.failures) do table.insert(expiries, failure.at + window) end
for _, expires in pairs(bucket.pending) do table.insert(expiries, expires) end
if #expiries >= limit then
    table.sort(expiries)
    save()
    return {0, math.max(1, math.ceil(expiries[#expiries - limit + 1] - now)), #bucket.failures}
end
bucket.pending[token] = now + reservation
save()
return {1, 0, #bucket.failures, epoch}
"""


def _backend():
    backend = os.getenv('LOGIN_RATE_LIMIT_BACKEND', settings.login_rate_limit_backend).strip().lower()
    if backend not in {'database', 'redis'}:
        raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.')
    return backend


def _redis_operation(operation, username, host='', token='', epoch='', legacy_ids=None):
    from .redis_runtime import coordination_key, get_client
    identity = hashlib.sha256(username.strip().lower().encode()).hexdigest()
    address = hashlib.sha256(host.encode()).hexdigest()
    prefix = coordination_key(f'login:{{{identity}}}')
    try:
        client = get_client()
        def evaluate(seed):
            return client.eval(_REDIS_WINDOW_SCRIPT, 3,
                prefix + ':epoch', prefix + ':ip:' + address, prefix + ':failures',
                operation, time.time(), token, WINDOW_SECONDS, MAX_FAILURES, RESERVATION_SECONDS, epoch, seed)
        result = evaluate(json.dumps(legacy_ids or []) if operation == 'unlock' else '')
        if result[0] == 2:
            # No concurrent Redis writer is overwritten, and an administrative
            # unlock epoch prevents this old snapshot from being resurrected.
            with _session() as db:
                rows = _attempts(db, username, host).filter(
                    LoginFailure.attempted_at > time.time() - WINDOW_SECONDS
                ).order_by(LoginFailure.attempted_at.desc()).limit(MAX_FAILURES).all()
                seed = [{'id': 'oracle:' + row.id, 'at': row.attempted_at} for row in rows]
            result = evaluate(json.dumps(seed))
        return result
    except Exception as exc:
        # Falling back to an empty database window would bypass failures and
        # reservations already recorded by another Redis-backed worker.
        raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc


def _reject(seconds):
    minutes, remainder = divmod(seconds, 60)
    wait = f'{minutes} minute(s) {remainder} second(s)' if minutes else f'{remainder} second(s)'
    raise HTTPException(429,
        f'Too many failed sign-in attempts. Try again in {wait}, or contact an Administrator to unlock sign-in.',
        headers={'Retry-After': str(seconds)})


def _session():
    from .database import SessionLocal
    return SessionLocal()


def _attempts(db, username, host=None):
    query = db.query(LoginFailure).filter(LoginFailure.username == username.strip().lower())
    if host is not None:
        query = query.filter(LoginFailure.host == host)
    return query


def _host(request):
    # ProxyHeadersMiddleware can preserve a ``request.client`` object while
    # replacing its host with ``None`` when the complete forwarded chain is
    # trusted.  Returning that value used to make every failed login attempt
    # insert NULL into qap_login_failures.host.  The resulting integrity error
    # then replaced the intended 401 "Invalid username or password" response
    # with the rate limiter's generic 503 service-unavailable response.
    #
    # Reuse the application's trust-aware address resolver so forwarded
    # headers are accepted only at a trusted edge, and always retain a stable,
    # non-null bucket when no valid client address is available.
    return request_ip(request) or 'unknown'


def enforce(request, username):
    if _backend() == 'redis':
        token = uuid.uuid4().hex
        result = _redis_operation('admit', username, _host(request), token)
        if not result[0]:
            _reject(int(result[1]))
        epoch = result[3].decode() if isinstance(result[3], bytes) else str(result[3])
        request.state.login_rate_limit_reservation = (username.strip().lower(), _host(request), token, epoch)
        return
    now = time.time()
    try:
        with _session() as db:
            recent = _attempts(db, username, _host(request)).filter(
                LoginFailure.attempted_at > now - WINDOW_SECONDS
            ).order_by(LoginFailure.attempted_at.desc()).limit(MAX_FAILURES).all()
    except SQLAlchemyError as exc:
        raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc
    if len(recent) >= MAX_FAILURES:
        seconds = max(1, math.ceil(recent[-1].attempted_at + WINDOW_SECONDS - now))
        _reject(seconds)


def record(request, username):
    if _backend() == 'redis':
        reservation = getattr(request.state, 'login_rate_limit_reservation', None)
        host = _host(request)
        token, epoch = uuid.uuid4().hex, ''
        if reservation and reservation[:2] == (username.strip().lower(), host):
            token, epoch = reservation[2:]
        _redis_operation('failure', username, host, token, epoch)
        request.state.login_rate_limit_reservation = None
        return
    now = time.time()
    try:
        with _session() as db:
            db.query(LoginFailure).filter(LoginFailure.attempted_at <= now - WINDOW_SECONDS).delete()
            db.add(LoginFailure(id=uuid.uuid4().hex, username=username.strip().lower(),
                                host=_host(request), attempted_at=now))
            db.commit()
    except SQLAlchemyError as exc:
        raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc


def clear(request, username):
    if _backend() == 'redis':
        # Redis failures remain authoritative. Oracle rows only contain a
        # pre-switch window; deleting them prevents successful login from
        # reviving that window when a Redis bucket eventually expires.
        try:
            from .redis_runtime import get_client
            get_client()  # fail closed before touching the legacy window
            with _session() as db:
                _attempts(db, username, _host(request)).delete()
                db.commit()
        except Exception as exc:
            raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc
        _redis_operation('clear', username, _host(request))
        request.state.login_rate_limit_reservation = None
        return
    try:
        with _session() as db:
            _attempts(db, username, _host(request)).delete()
            db.commit()
    except SQLAlchemyError as exc:
        raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc


def unlock(db, username):
    """Caller commits the deletion and records an administrator audit entry."""
    if _backend() == 'redis':
        try:
            from .redis_runtime import get_client
            get_client()
            if db is None:
                with _session() as recovery_db:
                    ids = ['oracle:' + row.id for row in _attempts(recovery_db, username).all()]
                    count = int(_redis_operation('unlock', username, legacy_ids=ids)[2])
                    _attempts(recovery_db, username).delete(synchronize_session=False)
                    recovery_db.commit()
                    return count
            ids = ['oracle:' + row.id for row in _attempts(db, username).all()]
            count = int(_redis_operation('unlock', username, legacy_ids=ids)[2])
            _attempts(db, username).delete(synchronize_session=False)
            return count
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc
    return _attempts(db, username).delete(synchronize_session=False)
