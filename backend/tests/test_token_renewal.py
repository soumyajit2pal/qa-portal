import datetime
from unittest.mock import patch

import pytest
from jwt import PyJWTError as JWTError
from fastapi import Response

from app.auth import create_access_token, decode_access_token, renew_access_token
from app.config import settings
from app.routers.auth import renew
from types import SimpleNamespace


def test_renewal_preserves_absolute_deadline_and_refreshes_roles():
    token = create_access_token({'sub': 'tester', 'roles': ['OLD']})
    first = decode_access_token(token)
    renewed = decode_access_token(renew_access_token(token, 'tester', ['NEW']))
    assert renewed['session_exp'] == first['session_exp']
    assert renewed['jti'] != first['jti']
    assert renewed['roles'] == ['NEW']
    assert renewed['exp'] <= renewed['session_exp']


def test_expired_access_token_cannot_renew():
    token = create_access_token({'sub': 'tester'}, expires_minutes=-1)
    with pytest.raises(JWTError):
        renew_access_token(token, 'tester', [])


def test_absolute_deadline_cannot_be_extended():
    past = int(datetime.datetime.now(datetime.UTC).timestamp()) - 1
    token = create_access_token({'sub': 'tester', 'session_exp': past})
    with pytest.raises(JWTError):
        renew_access_token(token, 'tester', [])


def test_identity_cannot_be_changed_and_tampering_rejected():
    token = create_access_token({'sub': 'tester'})
    with pytest.raises(JWTError):
        renew_access_token(token, 'other', [])
    parts = token.split('.')
    parts[1] = parts[1][:-2] + 'xx'
    with pytest.raises(JWTError):
        renew_access_token('.'.join(parts), 'tester', [])


def test_legacy_token_deadline_uses_original_issued_time():
    now = int(datetime.datetime.now(datetime.UTC).timestamp())
    with patch('app.auth.decode_access_token', return_value={'sub': 'tester', 'iat': now - 300}):
        token = renew_access_token('legacy', 'tester', [])
    result = decode_access_token(token)
    assert result['session_exp'] == now - 300 + settings.session_max_minutes * 60


def test_renewal_response_is_not_cacheable():
    token = create_access_token({'sub': 'tester'})
    response = Response()
    result = renew(response, token, SimpleNamespace(username='tester', roles=[], full_name='Tester'))
    assert response.headers['cache-control'] == 'no-store'
    assert result.model_dump() == {'authenticated': True}
