"""Compatibility exports for legacy imports.

Authentication is implemented in ``app.auth`` so token and password policy
cannot diverge between two modules.
"""
from app.auth import (  # noqa: F401
    ACCESS_TOKEN_EXPIRE_MINUTES,
    ALGORITHM,
    SECRET_KEY,
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)
