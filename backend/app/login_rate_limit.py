"""Shared failed-login window and administrator recovery."""
import math
import time
import uuid
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from .models import LoginFailure

WINDOW_SECONDS = 15 * 60
MAX_FAILURES = 5


def _session():
    from .database import SessionLocal
    return SessionLocal()


def _attempts(db, username, host=None):
    query = db.query(LoginFailure).filter(LoginFailure.username == username.strip().lower())
    if host is not None:
        query = query.filter(LoginFailure.host == host)
    return query


def _host(request):
    return request.client.host if request.client else 'unknown'


def enforce(request, username):
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
        minutes, remainder = divmod(seconds, 60)
        wait = f'{minutes} minute(s) {remainder} second(s)' if minutes else f'{remainder} second(s)'
        raise HTTPException(429,
            f'Too many failed sign-in attempts. Try again in {wait}, or contact an Administrator to unlock sign-in.',
            headers={'Retry-After': str(seconds)})


def record(request, username):
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
    try:
        with _session() as db:
            _attempts(db, username, _host(request)).delete()
            db.commit()
    except SQLAlchemyError as exc:
        raise HTTPException(503, 'Sign-in is temporarily unavailable. Please try again.') from exc


def unlock(db, username):
    """Caller commits the deletion and records an administrator audit entry."""
    return _attempts(db, username).delete(synchronize_session=False)
