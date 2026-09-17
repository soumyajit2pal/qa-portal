"""Additional application-layer protection for login request bodies.

TLS remains mandatory. The browser encrypts with AES-256-GCM and wraps its
random AES key using RSA-OAEP/SHA-256. Only the API holds the private key.
"""
import base64
import hashlib
import os
import tempfile
import time
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .auth import create_access_token, decode_access_token
from .config import settings


def _challenge_session():
    from .database import SessionLocal
    return SessionLocal()


def _consume_challenge(challenge):
    """Commit independently of authentication so failed logins also consume it.

    The shared database primary key arbitrates concurrent workers/replicas.
    Keep expired entries for an extra day to tolerate clock skew during cleanup.
    """
    from .models import UsedLoginChallenge
    jti, expires = challenge.get('jti'), challenge.get('exp')
    if not isinstance(jti, str) or not 1 <= len(jti) <= 64 or not isinstance(expires, int):
        raise HTTPException(400, 'Invalid or expired encrypted login. Please try signing in again.')
    try:
        with _challenge_session() as db:
            db.query(UsedLoginChallenge).filter(
                UsedLoginChallenge.expires_at < int(time.time()) - 86400
            ).delete(synchronize_session=False)
            db.add(UsedLoginChallenge(jti=jti, expires_at=expires))
            db.commit()
    except IntegrityError as exc:
        raise HTTPException(400, 'Invalid or expired encrypted login. Please try signing in again.') from exc
    except SQLAlchemyError as exc:
        # Never permit login when replay protection cannot be committed.
        raise HTTPException(503, 'Secure login is temporarily unavailable. Please try again.') from exc


class EncryptedLogin(BaseModel):
    model_config = ConfigDict(extra='forbid')
    key_id: str = Field(min_length=64, max_length=64)
    challenge: str = Field(min_length=1, max_length=2048)
    wrapped_key: str = Field(min_length=1, max_length=1024)
    iv: str = Field(min_length=1, max_length=32)
    ciphertext: str = Field(min_length=1, max_length=12000)


class Credentials(BaseModel):
    model_config = ConfigDict(extra='forbid')
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=4096)


def _key_path():
    configured = settings.login_encryption_private_key_file
    if configured:
        return Path(configured)
    if settings.app_env in {'uat', 'prod', 'production'}:
        raise HTTPException(503, 'Login encryption key is not configured.')
    return Path(__file__).resolve().parents[1] / '.secrets' / 'login-private.pem'


@lru_cache(maxsize=4)
def _load_key(filename: str, development: bool):
    path = Path(filename)
    if not path.exists() and development:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        generated = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        pem = generated.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                      serialization.NoEncryption())
        fd, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(pem)
            # Publish atomically without replacing another worker's key.
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temporary)
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 3072:
            raise ValueError('Invalid login encryption key')
        return key
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(503, 'Login encryption key is unavailable.') from exc


def _material():
    key = _load_key(str(_key_path()), settings.app_env not in {'uat', 'prod', 'production'})
    public = key.public_key().public_bytes(serialization.Encoding.DER,
                                           serialization.PublicFormat.SubjectPublicKeyInfo)
    return key, public, hashlib.sha256(public).hexdigest()


def public_login_key():
    _, public, key_id = _material()
    challenge = create_access_token({'sub': 'login-envelope', 'purpose': 'login-encryption', 'key_id': key_id},
                                    expires_minutes=2)
    return {'algorithm': 'RSA-OAEP-256+A256GCM', 'key_id': key_id,
            'public_key': base64.b64encode(public).decode('ascii'), 'challenge': challenge, 'expires_in': 120}


def decrypt_envelope(envelope: EncryptedLogin):
    key, _, key_id = _material()
    try:
        challenge = decode_access_token(envelope.challenge)
        if (envelope.key_id != key_id or challenge.get('key_id') != key_id
                or challenge.get('purpose') != 'login-encryption' or challenge.get('sub') != 'login-envelope'):
            raise ValueError('Invalid challenge')
        decode = lambda value: base64.b64decode(value, validate=True)
        wrapped, iv, ciphertext = decode(envelope.wrapped_key), decode(envelope.iv), decode(envelope.ciphertext)
        if len(iv) != 12 or len(wrapped) != key.key_size // 8:
            raise ValueError('Invalid envelope')
        aes_key = key.decrypt(wrapped, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
                                                   algorithm=hashes.SHA256(), label=None))
        if len(aes_key) != 32:
            raise ValueError('Invalid encryption key')
        plaintext = AESGCM(aes_key).decrypt(iv, ciphertext, envelope.challenge.encode('utf-8'))
        credentials = Credentials.model_validate_json(plaintext)
    except Exception as exc:
        # Do not expose crypto errors or decrypted credentials in responses.
        raise HTTPException(400, 'Invalid or expired encrypted login. Please try signing in again.') from exc
    _consume_challenge(challenge)
    return SimpleNamespace(username=credentials.username, password=credentials.password)


def decrypt_admin_password(envelope: EncryptedLogin | None, context: str) -> str:
    if envelope is None:
        raise HTTPException(400, 'An encrypted password is required.')
    credentials = decrypt_envelope(envelope)
    if credentials.username != context:
        raise HTTPException(400, 'Invalid encrypted password context.')
    password = credentials.password
    if len(password) < 12 or len(password.encode('utf-8')) > 72:
        raise HTTPException(400, 'Password must be at least 12 characters and no more than 72 UTF-8 bytes')
    return password


async def encrypted_login_credentials(request: Request):
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        raise HTTPException(415, 'An encrypted JSON login payload is required.')
    # Bound the stream before JSON decoding; do not echo validation inputs.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 20000:
            raise HTTPException(413, 'Login payload is too large.')
    try:
        envelope = EncryptedLogin.model_validate_json(body)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(400, 'An encrypted JSON login payload is required.') from exc
    return decrypt_envelope(envelope)
