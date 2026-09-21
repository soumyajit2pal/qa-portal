import os
import datetime
import uuid
import hmac
import ssl

import bcrypt
import jwt
from jwt import PyJWTError as JWTError
from ldap3 import Server, Connection, SIMPLE, SUBTREE, BASE, Tls
from ldap3.core.exceptions import LDAPException
from ldap3.utils.conv import escape_filter_chars
from ldap3.utils.dn import escape_rdn

from .config import settings


SECRET_KEY = settings.secret_key
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = settings.access_token_expire_minutes

# Hashing goes straight through the `bcrypt` package rather than passlib's
# CryptContext wrapper: passlib 1.7.4 (its last release) runs an internal
# self-test on import that hashes an over-length password to probe for a
# legacy bcrypt truncation bug. Modern bcrypt (>=4.1) raises ValueError for
# passwords over 72 bytes instead of silently truncating, which makes that
# self-test crash -- even though the actual application passwords are short.
# Calling bcrypt directly avoids that broken probe entirely.
BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    pw_bytes = password.encode("utf-8")
    if len(pw_bytes) > BCRYPT_MAX_BYTES:
        raise ValueError("Password must be 72 UTF-8 bytes or fewer")
    return bcrypt.hashpw(pw_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    pw_bytes = plain.encode("utf-8")
    if len(pw_bytes) > BCRYPT_MAX_BYTES:
        return False
    try:
        return bcrypt.checkpw(pw_bytes, hashed.encode("utf-8"))
    except (TypeError, ValueError):
        return False


def create_access_token(data: dict, expires_minutes: int = ACCESS_TOKEN_EXPIRE_MINUTES) -> str:
    to_encode = data.copy()
    issued_at = datetime.datetime.now(datetime.UTC)
    expire = issued_at + datetime.timedelta(minutes=expires_minutes)
    session_exp = to_encode.get("session_exp", int((issued_at + datetime.timedelta(minutes=settings.session_max_minutes)).timestamp()))
    expire = min(expire, datetime.datetime.fromtimestamp(session_exp, datetime.UTC))
    to_encode.update({
        "session_exp": session_exp,
        "exp": expire, "iat": issued_at, "jti": str(uuid.uuid4()),
        "iss": settings.jwt_issuer, "aud": settings.jwt_audience,
    })
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    payload = jwt.decode(
        token, SECRET_KEY, algorithms=[ALGORITHM],
        issuer=settings.jwt_issuer, audience=settings.jwt_audience,
        options={"require": ["exp", "iat", "sub", "jti", "iss", "aud"]},
    )
    if "session_exp" in payload and (
        not isinstance(payload["session_exp"], (int, float))
        or payload["session_exp"] <= datetime.datetime.now(datetime.UTC).timestamp()
    ):
        raise JWTError("Maximum session duration exceeded")
    return payload


def renew_access_token(token: str, username: str, roles: list[str]) -> str:
    """Renew a valid credential without resetting its original session deadline."""
    payload = decode_access_token(token)
    if payload.get("sub") != username or not isinstance(payload.get("iat"), (int, float)):
        raise JWTError("Invalid session identity")
    # Tokens issued before renewal was introduced get a deadline anchored to
    # their signed original issue time, never to the renewal request time.
    deadline = payload.get("session_exp", payload["iat"] + settings.session_max_minutes * 60)
    if deadline <= datetime.datetime.now(datetime.UTC).timestamp():
        raise JWTError("Maximum session duration exceeded")
    return create_access_token({"sub": username, "roles": roles, "session_exp": deadline})


# ---------------------------------------------------------------------------
# LDAP / Active Directory authentication (Admin section: Module 9 config)
# ---------------------------------------------------------------------------
# Users whose account has login_type == "LDAP" are never given a local
# password hash; instead their credentials are verified live against the
# bank's directory server every time they log in. All connection details are
# environment-driven so the same code works against on-prem AD or OpenLDAP
# without a code change -- only the .env needs updating per environment.
LDAP_SERVER_URI = os.getenv("LDAP_SERVER_URI", "").strip()
LDAP_USE_SSL = os.getenv("LDAP_USE_SSL", "true").strip().lower() in {"1", "true", "yes", "on"}
LDAP_BASE_DN = os.getenv("LDAP_BASE_DN", "").strip()
LDAP_USER_SEARCH_FILTER = os.getenv("LDAP_USER_SEARCH_FILTER", "(sAMAccountName={username})")
# Strategy 1 (recommended): a read-only service account searches for the
# user's DN, then a second connection binds as that DN with the supplied
# password. Works regardless of how deep/irregular the directory tree is.
LDAP_BIND_DN = os.getenv("LDAP_BIND_DN", "").strip()
LDAP_BIND_PASSWORD = os.getenv("LDAP_BIND_PASSWORD", "")
# Strategy 2 (simpler, no service account needed): build the user's DN
# directly from a fixed template, e.g. "uid={username},ou=people,dc=bank,dc=in".
LDAP_USER_DN_TEMPLATE = os.getenv("LDAP_USER_DN_TEMPLATE", "")

# Directory attribute names used to prefill a profile when a brand-new
# account is just-in-time provisioned on first LDAP login (best-effort only
# -- provisioning still succeeds if these can't be read, using the username
# as a fallback full name).
LDAP_ATTR_FULL_NAME = os.getenv("LDAP_ATTR_FULL_NAME", "displayName")
LDAP_ATTR_EMAIL = os.getenv("LDAP_ATTR_EMAIL", "mail")
LDAP_ATTR_DEPARTMENT = os.getenv("LDAP_ATTR_DEPARTMENT", "department")
_PROFILE_ATTRS = [LDAP_ATTR_FULL_NAME, LDAP_ATTR_EMAIL, LDAP_ATTR_DEPARTMENT, "cn"]


class LDAPAuthError(Exception):
    """Raised when LDAP authentication cannot even be attempted -- e.g. the
    server is unreachable or misconfigured -- as distinct from a plain
    invalid-username-or-password failure (which returns None/False, not an
    exception, so it maps to the same 401 a Standard login would give)."""


def _mock_ldap_profile(username: str, password: str):
    """Non-production LDAP substitute that exercises real onboarding.

    A matching username is treated exactly like a successful directory bind;
    the login router still performs just-in-time provisioning, department
    selection, role review, workspace placement and every normal access gate.
    """
    if not settings.ldap_mock_enabled:
        return None, False
    prefix = settings.ldap_mock_username_prefix.strip().casefold()
    if not username.casefold().startswith(prefix):
        return None, False
    valid = bool(password) and hmac.compare_digest(password, settings.ldap_mock_password)
    if not valid:
        return None, True
    suffix = username[len(prefix):].strip("-_. ")
    display_suffix = suffix.replace("-", " ").replace("_", " ").strip().title()
    return {
        "dn": f"mock:{username}",
        "full_name": f"Mock LDAP {display_suffix or username}",
        "email": f"{username}@mock-ldap.test",
        "department": None,
    }, True


def _first_attr(entry, name):
    try:
        val = entry[name].value
        return (val[0] if val else None) if isinstance(val, list) else val
    except Exception:
        return None


def _ldap_bind_and_fetch(username: str, password: str):
    """Attempts to bind as `username` with `password` against the configured
    directory. Returns None if the bind fails, otherwise a dict:
    {"dn": ..., "full_name": ..., "email": ..., "department": ...}
    -- profile fields are best-effort and may be None depending on what the
    directory exposes / which binding strategy is configured."""
    mock_profile, handled_by_mock = _mock_ldap_profile(username, password)
    if handled_by_mock:
        return mock_profile
    # In a mock-only UAT environment the configured mock namespace is the
    # complete directory. A typo outside that namespace is an ordinary
    # invalid identity, not an attempt to contact a real LDAP service that is
    # intentionally absent. Without this guard every such typo fell through
    # to the missing LDAP_SERVER_URI check and was incorrectly reported as a
    # temporary service outage. When a real server is configured, non-mock
    # usernames continue to fall through to that server as before.
    if settings.ldap_mock_enabled and not LDAP_SERVER_URI:
        return None
    if not LDAP_SERVER_URI:
        raise LDAPAuthError("LDAP_SERVER_URI is not configured on the server")
    if settings.app_env in {"uat", "prod", "production"} and not LDAP_USE_SSL:
        raise LDAPAuthError("LDAP_USE_SSL must be enabled outside development")
    if LDAP_USE_SSL and LDAP_SERVER_URI.lower().startswith("ldap://"):
        raise LDAPAuthError("Use an ldaps:// URI or hostname when LDAP_USE_SSL is enabled")
    if not password:
        return None

    try:
        tls = Tls(validate=ssl.CERT_REQUIRED, ca_certs_file=os.getenv("LDAP_CA_CERTS_FILE") or None)
        server = Server(LDAP_SERVER_URI, use_ssl=LDAP_USE_SSL, tls=tls, get_info=None)

        if LDAP_BIND_DN and LDAP_BASE_DN:
            # Strategy 1: service-account search (grabs profile attributes for
            # free), then bind as the resolved user DN to verify the password.
            with Connection(server, user=LDAP_BIND_DN, password=LDAP_BIND_PASSWORD,
                             authentication=SIMPLE, auto_bind=True) as service_conn:
                search_filter = LDAP_USER_SEARCH_FILTER.format(username=escape_filter_chars(username))
                service_conn.search(search_base=LDAP_BASE_DN, search_filter=search_filter,
                                     search_scope=SUBTREE, attributes=_PROFILE_ATTRS)
                if not service_conn.entries:
                    return None
                entry = service_conn.entries[0]
                user_dn = entry.entry_dn
                profile = {
                    "dn": user_dn,
                    "full_name": _first_attr(entry, LDAP_ATTR_FULL_NAME) or _first_attr(entry, "cn"),
                    "email": _first_attr(entry, LDAP_ATTR_EMAIL),
                    "department": _first_attr(entry, LDAP_ATTR_DEPARTMENT),
                }
            with Connection(server, user=user_dn, password=password, authentication=SIMPLE) as user_conn:
                if not user_conn.bind():
                    return None
            return profile

        elif LDAP_USER_DN_TEMPLATE:
            # Strategy 2: direct bind using a predictable DN template. No
            # service account, so profile attributes are only available if
            # the directory lets an authenticated user read their own entry.
            user_dn = LDAP_USER_DN_TEMPLATE.format(username=escape_rdn(username))
            with Connection(server, user=user_dn, password=password, authentication=SIMPLE) as conn:
                if not conn.bind():
                    return None
                profile = {"dn": user_dn, "full_name": None, "email": None, "department": None}
                try:
                    conn.search(search_base=user_dn, search_filter="(objectClass=*)",
                                search_scope=BASE, attributes=_PROFILE_ATTRS)
                    if conn.entries:
                        entry = conn.entries[0]
                        profile["full_name"] = _first_attr(entry, LDAP_ATTR_FULL_NAME) or _first_attr(entry, "cn")
                        profile["email"] = _first_attr(entry, LDAP_ATTR_EMAIL)
                        profile["department"] = _first_attr(entry, LDAP_ATTR_DEPARTMENT)
                except LDAPException:
                    pass  # profile enrichment is best-effort only
                return profile

        else:
            raise LDAPAuthError(
                "LDAP is not fully configured: set either "
                "(LDAP_BIND_DN + LDAP_BIND_PASSWORD + LDAP_BASE_DN) for search-then-bind, "
                "or LDAP_USER_DN_TEMPLATE for direct bind."
            )
    except LDAPException as e:
        raise LDAPAuthError(f"Could not reach or bind to the LDAP server: {e}")


def ldap_authenticate(username: str, password: str) -> bool:
    """Simple pass/fail check used on every login for an existing LDAP account."""
    return _ldap_bind_and_fetch(username, password) is not None


def ldap_authenticate_with_profile(username: str, password: str):
    """Like ldap_authenticate, but also returns best-effort profile attributes
    (full_name/email/department). Used only for just-in-time provisioning of
    a brand-new local account on a first-ever LDAP login. Returns None on
    failed authentication."""
    return _ldap_bind_and_fetch(username, password)
