import asyncio
import base64
import json
from unittest.mock import patch
import pytest
from fastapi import HTTPException
from starlette.requests import Request
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.login_encryption import public_login_key, decrypt_envelope, encrypted_login_credentials, EncryptedLogin, _load_key
from app.config import settings
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.exc import OperationalError
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from app.models import UsedLoginChallenge
from app.login_encryption import decrypt_admin_password
from app import schemas
from pydantic import ValidationError


@pytest.fixture(autouse=True)
def challenge_store(tmp_path):
    # File-backed test database gives each worker its own real transaction.
    engine = create_engine('sqlite:///' + str(tmp_path / 'challenges.db'))
    UsedLoginChallenge.__table__.create(engine)
    factory = sessionmaker(bind=engine)
    with patch('app.login_encryption._challenge_session', side_effect=factory):
        yield factory
    engine.dispose()

@pytest.fixture
def public_key(tmp_path):
    with patch.object(settings, 'app_env', 'dev'), patch.object(settings, 'login_encryption_private_key_file', str(tmp_path / 'private.pem')):
        yield public_login_key()
    _load_key.cache_clear()


def envelope(public, username='requester', password='valid-password'):
    public_rsa = serialization.load_der_public_key(base64.b64decode(public['public_key']))
    key = AESGCM.generate_key(256); iv = b'123456789012'
    cipher = AESGCM(key).encrypt(iv, json.dumps({'username': username, 'password': password}).encode(), public['challenge'].encode())
    wrap = public_rsa.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    encode = lambda b: base64.b64encode(b).decode()
    return EncryptedLogin(key_id=public['key_id'], challenge=public['challenge'], wrapped_key=encode(wrap), iv=encode(iv), ciphertext=encode(cipher))


def test_roundtrip_and_no_readable_credentials(public_key):
    value = envelope(public_key)
    encoded = value.model_dump_json()
    assert 'requester' not in encoded and 'valid-password' not in encoded
    result = decrypt_envelope(value)
    assert result.username == 'requester' and result.password == 'valid-password'

@pytest.mark.parametrize('field', ['wrapped_key', 'iv', 'ciphertext', 'key_id', 'challenge'])
def test_tampering_rejected_without_exposing_credentials(public_key, field):
    value = envelope(public_key)
    original = getattr(value, field)
    setattr(value, field, ('B' if original[0] == 'A' else 'A') + original[1:])
    with pytest.raises(HTTPException) as exc:
        decrypt_envelope(value)
    assert exc.value.status_code == 400
    assert 'valid-password' not in exc.value.detail


def test_expired_challenge_rejected(public_key):
    value = envelope(public_key)
    with patch('app.login_encryption.decode_access_token', side_effect=ValueError('Expired')):
        with pytest.raises(HTTPException) as exc: decrypt_envelope(value)
    assert exc.value.status_code == 400


def test_plaintext_form_rejected():
    req = Request({'type': 'http', 'method': 'POST', 'path': '/api/auth/login',
                   'headers': [(b'content-type', b'application/x-www-form-urlencoded')]})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(encrypted_login_credentials(req))
    assert exc.value.status_code == 415


def test_plaintext_json_rejected_without_echo():
    async def receive():
        return {'type': 'http.request', 'body': b'{"username":"admin","password":"secret-password"}'}
    req = Request({'type': 'http', 'method': 'POST', 'path': '/api/auth/login',
                   'headers': [(b'content-type', b'application/json')]}, receive)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(encrypted_login_credentials(req))
    assert exc.value.status_code == 400 and 'secret-password' not in exc.value.detail


def test_deployment_requires_configured_key():
    with patch.object(settings, 'app_env', 'prod'), patch.object(settings, 'login_encryption_private_key_file', None):
        with pytest.raises(HTTPException) as exc: public_login_key()
    assert exc.value.status_code == 503


def test_replay_rejected_across_sessions(public_key):
    value = envelope(public_key)
    decrypt_envelope(value)
    with pytest.raises(HTTPException) as exc:
        decrypt_envelope(value)
    assert exc.value.status_code == 400


def test_same_challenge_with_new_ciphertext_rejected(public_key):
    decrypt_envelope(envelope(public_key))
    with pytest.raises(HTTPException) as exc:
        decrypt_envelope(envelope(public_key, password='different-password'))
    assert exc.value.status_code == 400
    # A fresh challenge permits a new attempt, even with the same credentials.
    assert decrypt_envelope(envelope(public_login_key())).username == 'requester'


def test_concurrent_replay_has_exactly_one_winner(public_key):
    value = envelope(public_key)
    barrier = Barrier(4)
    def attempt(_):
        barrier.wait()
        try:
            decrypt_envelope(value)
            return 200
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sorted(pool.map(attempt, range(4))) == [200, 400, 400, 400]


def test_store_failure_fails_closed(public_key):
    with patch('app.login_encryption._challenge_session',
               side_effect=OperationalError('unavailable', {}, Exception())):
        with pytest.raises(HTTPException) as exc:
            decrypt_envelope(envelope(public_key))
    assert exc.value.status_code == 503


def test_tampered_envelope_does_not_consume_challenge(public_key):
    bad = envelope(public_key)
    bad.ciphertext = base64.b64encode(b'invalid').decode()
    with pytest.raises(HTTPException):
        decrypt_envelope(bad)
    assert decrypt_envelope(envelope(public_key)).username == 'requester'


@pytest.mark.parametrize('context', ['create-user:test1', 'reset-password:123'])
def test_admin_password_roundtrip_and_replay(public_key, context):
    value = envelope(public_key, username=context)
    assert decrypt_admin_password(value, context) == 'valid-password'
    with pytest.raises(HTTPException):
        decrypt_admin_password(value, context)


@pytest.mark.parametrize('context', ['create-user:other', 'reset-password:123'])
def test_admin_password_cannot_be_moved_to_another_action_or_user(public_key, context):
    with pytest.raises(HTTPException) as exc:
        decrypt_admin_password(envelope(public_key, username='create-user:test1'), context)
    assert exc.value.status_code == 400


@pytest.mark.parametrize('password', ['short', 'a' * 73, 'é' * 37])
def test_admin_password_policy_after_decryption(public_key, password):
    with pytest.raises(HTTPException) as exc:
        decrypt_admin_password(envelope(public_key, username='create-user:test1', password=password), 'create-user:test1')
    assert exc.value.status_code == 400
    assert password not in exc.value.detail


def test_admin_plaintext_passwords_rejected_and_ldap_needs_no_password():
    with pytest.raises(ValidationError):
        schemas.UserCreate(username='test1', full_name='Test', roles=['QA_ENGINEER'], password='valid-password')
    with pytest.raises(ValidationError):
        schemas.PasswordReset(new_password='valid-password')
    assert schemas.UserCreate(username='ldap1', full_name='LDAP', roles=['QA_ENGINEER'], login_type='LDAP').encrypted_password is None
    with pytest.raises(HTTPException) as exc:
        decrypt_admin_password(None, 'create-user:test1')
    assert exc.value.status_code == 400


def test_user_creation_and_reset_store_hashes(public_key):
    from app import models
    from app.auth import verify_password
    from app.routers import auth as auth_router
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    try:
        with sessionmaker(bind=engine)() as db, patch.object(auth_router, 'write_audit'), patch('app.workspace_service.ensure_default_workspace_membership'):
            admin = models.User(id=900, username='admin', full_name='Admin')
            user = auth_router.create_user(schemas.UserCreate(
                username='test1', full_name='Test', roles=['QA_ENGINEER'],
                encrypted_password=envelope(public_key, username='create-user:test1')),
                request=None, db=db, current_user=admin)
            assert user.hashed_password != 'valid-password'
            assert verify_password('valid-password', user.hashed_password)
            updated = auth_router.reset_password(user.id, schemas.PasswordReset(
                encrypted_password=envelope(public_login_key(), username=f'reset-password:{user.id}', password='changed-password')),
                request=None, db=db, current_user=admin)
            assert verify_password('changed-password', updated.hashed_password)
            assert not verify_password('valid-password', updated.hashed_password)
    finally:
        engine.dispose()


@pytest.mark.parametrize('path', ['/api/auth/users', '/api/auth/users/123/reset-password'])
def test_admin_validation_response_does_not_echo_rejected_password(path):
    from fastapi.exceptions import RequestValidationError
    # Importing the app normally runs deployment maintenance against its DB.
    # This response-only test must not touch the configured database or files.
    with patch('app.storage_lock.exclusive_file_lock') as lock:
        lock.return_value.__enter__.return_value = False
        from app.main import validation_exception_handler
    request = Request({'type': 'http', 'method': 'POST', 'path': path, 'headers': []})
    error = RequestValidationError([{'type': 'extra_forbidden', 'loc': ('body', 'password'),
                                    'msg': 'Extra inputs are not permitted', 'input': 'secret-password'}])
    response = asyncio.run(validation_exception_handler(request, error))
    assert response.status_code == 422
    assert b'secret-password' not in response.body
