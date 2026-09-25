import os
import datetime
import uuid
import hmac
import ssl
import re

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


_LDAP_PUBLIC_ERRORS = {
    "LDAP_UNAVAILABLE": {
        "status": 503,
        "cause": "LDAP service unavailable",
        "message": "QualityOps could not complete authentication with LDAP / Active Directory.",
        "guidance": "Wait a moment and try again. If the problem continues, share the technical reference with the portal administrator.",
        "retryable": True,
    },
    "LDAP_NOT_CONFIGURED": {
        "status": 503,
        "cause": "LDAP configuration is incomplete",
        "message": "QualityOps cannot start LDAP authentication because the directory connection is not configured correctly.",
        "guidance": "Contact the portal administrator to verify the LDAP server, secure transport, and bind/search configuration.",
        "retryable": False,
    },
    "LDAP_TLS_CERTIFICATE_ERROR": {
        "status": 503,
        "cause": "LDAP TLS certificate validation failed",
        "message": "QualityOps reached the LDAP endpoint but could not establish a trusted secure connection.",
        "guidance": "Confirm that you are on the required network or VPN, then contact the portal administrator to verify the LDAP certificate chain and configured CA certificate.",
        "retryable": False,
    },
    "LDAP_CONNECTION_TIMEOUT": {
        "status": 503,
        "cause": "LDAP connection timed out",
        "message": "The LDAP server did not respond before the authentication timeout.",
        "guidance": "Check your network or VPN connection and try again. If it continues, contact the portal administrator.",
        "retryable": True,
    },
    "LDAP_SERVER_UNREACHABLE": {
        "status": 503,
        "cause": "LDAP server is unreachable",
        "message": "QualityOps could not reach the LDAP / Active Directory server.",
        "guidance": "Check your network or VPN connection and try again. If it continues, contact the portal administrator.",
        "retryable": True,
    },
    "LDAP_SERVICE_BIND_FAILED": {
        "status": 503,
        "cause": "LDAP service-account bind was rejected",
        "message": "QualityOps reached LDAP, but the directory rejected the portal service account used to locate users.",
        "guidance": "The portal administrator must verify the LDAP bind account, password, and directory permissions.",
        "retryable": False,
    },
    "LDAP_SEARCH_FAILED": {
        "status": 503,
        "cause": "LDAP directory search failed",
        "message": "QualityOps connected to LDAP but could not search the configured user directory.",
        "guidance": "The portal administrator must verify the base DN, user search filter, attributes, and service-account permissions.",
        "retryable": False,
    },
    "LDAP_PROTOCOL_ERROR": {
        "status": 503,
        "cause": "LDAP returned an unexpected directory error",
        "message": "The LDAP server returned a response that QualityOps could not complete safely.",
        "guidance": "Try again once. If the problem continues, share the technical reference with the portal administrator.",
        "retryable": False,
    },
    "LDAP_ACCOUNT_LOCKED": {
        "status": 401,
        "cause": "LDAP account is locked",
        "message": "Your LDAP / Active Directory account is locked.",
        "guidance": "Unlock the account through the approved corporate process or contact the Service Desk, then try again.",
        "retryable": False,
    },
    "LDAP_ACCOUNT_DISABLED": {
        "status": 401,
        "cause": "LDAP account is disabled",
        "message": "Your LDAP / Active Directory account is disabled.",
        "guidance": "Contact the Service Desk or directory administrator to reactivate the account.",
        "retryable": False,
    },
    "LDAP_ACCOUNT_EXPIRED": {
        "status": 401,
        "cause": "LDAP account has expired",
        "message": "Your LDAP / Active Directory account has expired.",
        "guidance": "Contact the Service Desk or directory administrator to renew the account.",
        "retryable": False,
    },
    "LDAP_PASSWORD_EXPIRED": {
        "status": 401,
        "cause": "LDAP password has expired",
        "message": "Your LDAP / Active Directory password has expired.",
        "guidance": "Change the password through the approved corporate password-reset process, then sign in again.",
        "retryable": False,
    },
    "LDAP_PASSWORD_RESET_REQUIRED": {
        "status": 401,
        "cause": "LDAP password change is required",
        "message": "LDAP / Active Directory requires you to change your password before signing in.",
        "guidance": "Complete the corporate password-change process, then sign in again with the new password.",
        "retryable": False,
    },
    "LDAP_SIGNIN_RESTRICTED": {
        "status": 401,
        "cause": "LDAP sign-in is restricted",
        "message": "LDAP / Active Directory does not permit this account to sign in from the current time or workstation.",
        "guidance": "Use an approved workstation and sign-in window, or contact the Service Desk for the account restriction details.",
        "retryable": False,
    },
}


_AUTHENTICATION_REJECTED_DETAIL = {
    "code": "AUTHENTICATION_REJECTED",
    "cause": "Credentials or directory account status rejected sign-in",
    "message": "The username or password is incorrect, or the directory account cannot currently sign in.",
    "guidance": (
        "Verify your username and password. If they are correct, use the approved "
        "password-reset or account-unlock process, or contact the Service Desk."
    ),
    "retryable": False,
}


def authentication_rejected_detail() -> dict:
    """Return the one public 401 response used for every login rejection.

    Directory account-policy responses can identify whether a username exists.
    Operators still receive the exact categorized reason in logs/audit records,
    while browsers get useful recovery guidance without an enumeration oracle.
    """
    return dict(_AUTHENTICATION_REJECTED_DETAIL)


class LDAPAuthError(Exception):
    """Categorized LDAP failure with separate public and diagnostic details.

    Browser responses receive only the stable code/cause/message/guidance
    below. The original diagnostic stays server-side so hostnames, DNs,
    certificate paths, and other directory internals are not exposed.
    Plain invalid credentials still return ``None``/``False`` to preserve the
    non-enumerating username-or-password response.
    """

    def __init__(
        self,
        diagnostic: str,
        *,
        code: str = "LDAP_UNAVAILABLE",
        cause_type: str | None = None,
        operation: str | None = None,
    ):
        definition = _LDAP_PUBLIC_ERRORS.get(code, _LDAP_PUBLIC_ERRORS["LDAP_UNAVAILABLE"])
        self.code = code if code in _LDAP_PUBLIC_ERRORS else "LDAP_UNAVAILABLE"
        self.status_code = int(definition["status"])
        self.cause = str(definition["cause"])
        self.public_message = str(definition["message"])
        self.guidance = str(definition["guidance"])
        self.retryable = bool(definition["retryable"])
        self.diagnostic = str(diagnostic or cause_type or self.code)
        self.cause_type = cause_type or type(self).__name__
        self.operation = operation
        super().__init__(self.diagnostic)

    def public_detail(self) -> dict:
        if self.status_code == 401:
            return authentication_rejected_detail()
        return {
            "code": self.code,
            "cause": self.cause,
            "message": self.public_message,
            "guidance": self.guidance,
            "retryable": self.retryable,
        }

    def audit_detail(self) -> dict:
        """Return useful, bounded diagnostics without directory secrets.

        ldap3 error text may contain server names, bind DNs, certificate paths,
        or referral URLs. Extract only stable protocol fields and AD's numeric
        account-policy subcode for logs/audits; never persist the raw message.
        """
        result_match = re.search(r"\bresult=([0-9]+)\b", self.diagnostic, re.IGNORECASE)
        description_match = re.search(
            r"\bdescription=([A-Za-z][A-Za-z0-9 _-]{0,63})",
            self.diagnostic,
            re.IGNORECASE,
        )
        subcode_match = re.search(r"\bdata\s+([0-9a-f]+)\b", self.diagnostic, re.IGNORECASE)
        detail = {
            "ldap_error_code": self.code,
            "operation": self.operation or "unknown",
            "error_type": re.sub(r"[^A-Za-z0-9_.-]", "", self.cause_type)[:80] or "LDAPError",
            "retryable": self.retryable,
        }
        if result_match:
            detail["ldap_result_code"] = int(result_match.group(1))
        if description_match:
            detail["ldap_result_description"] = description_match.group(1).strip()
        if subcode_match:
            detail["directory_subcode"] = subcode_match.group(1).lower()
        return detail


_AD_ACCOUNT_FAILURE_CODES = {
    "530": "LDAP_SIGNIN_RESTRICTED",       # not permitted to log on at this time
    "531": "LDAP_SIGNIN_RESTRICTED",       # not permitted from this workstation
    "532": "LDAP_PASSWORD_EXPIRED",
    "533": "LDAP_ACCOUNT_DISABLED",
    "701": "LDAP_ACCOUNT_EXPIRED",
    "773": "LDAP_PASSWORD_RESET_REQUIRED",
    "775": "LDAP_ACCOUNT_LOCKED",
}


def _ldap_result_diagnostic(result) -> str:
    if not isinstance(result, dict):
        return str(result or "LDAP operation failed without a result")
    return " | ".join(
        f"{key}={result.get(key)}"
        for key in ("result", "description", "message")
        if result.get(key) not in (None, "")
    ) or "LDAP operation failed without diagnostic details"


def _ldap_account_error(result) -> LDAPAuthError | None:
    """Translate AD/OpenLDAP account-policy diagnostics without exposing them.

    Active Directory returns account state as subcodes inside result 49's
    diagnostic message. Ordinary bad credentials (52e) and unknown users
    (525) intentionally remain indistinguishable and return ``None``.
    """
    diagnostic = _ldap_result_diagnostic(result)
    normalized = diagnostic.casefold()
    match = re.search(r"\bdata\s+([0-9a-f]+)\b", normalized)
    code = _AD_ACCOUNT_FAILURE_CODES.get(match.group(1) if match else "")
    if not code:
        text_codes = (
            ("password must be changed", "LDAP_PASSWORD_RESET_REQUIRED"),
            ("must change password", "LDAP_PASSWORD_RESET_REQUIRED"),
            ("password expired", "LDAP_PASSWORD_EXPIRED"),
            ("account locked", "LDAP_ACCOUNT_LOCKED"),
            ("account disabled", "LDAP_ACCOUNT_DISABLED"),
            ("account expired", "LDAP_ACCOUNT_EXPIRED"),
            ("workstation restriction", "LDAP_SIGNIN_RESTRICTED"),
            ("logon hours", "LDAP_SIGNIN_RESTRICTED"),
        )
        code = next((candidate for phrase, candidate in text_codes if phrase in normalized), None)
    return LDAPAuthError(diagnostic, code=code, cause_type="LDAPBindResult") if code else None


def _ldap_bind_error(result) -> LDAPAuthError | None:
    account_error = _ldap_account_error(result)
    if account_error:
        return account_error
    diagnostic = _ldap_result_diagnostic(result)
    normalized = diagnostic.casefold()
    result_code = result.get("result") if isinstance(result, dict) else None
    # Result 49 / invalidCredentials includes both a bad password and an
    # unknown username. Keep those cases deliberately indistinguishable.
    if result_code in {32, 49} or "invalidcredentials" in normalized or "invalid credentials" in normalized:
        return None
    return LDAPAuthError(diagnostic, code="LDAP_PROTOCOL_ERROR", cause_type="LDAPBindResult")


def _ldap_exception_error(exc: BaseException, stage: str) -> LDAPAuthError | None:
    diagnostic = str(exc) or type(exc).__name__
    normalized = f"{type(exc).__name__} {diagnostic}".casefold()
    account_error = _ldap_account_error({"description": type(exc).__name__, "message": diagnostic})
    if stage == "user_bind" and account_error:
        return account_error
    if stage == "user_bind" and "invalid credential" in normalized:
        return None
    if "certificate" in normalized or "certverification" in normalized or "unknown ca" in normalized:
        code = "LDAP_TLS_CERTIFICATE_ERROR"
    elif "timed out" in normalized or "timeout" in normalized:
        code = "LDAP_CONNECTION_TIMEOUT"
    elif stage == "service_bind" and ("invalid credential" in normalized or "ldapbinderror" in normalized):
        code = "LDAP_SERVICE_BIND_FAILED"
    elif stage == "directory_search":
        code = "LDAP_SEARCH_FAILED"
    elif any(token in normalized for token in (
        "socket", "connection refused", "network is unreachable", "no route to host",
        "name or service not known", "getaddrinfo", "communication", "server down",
    )):
        code = "LDAP_SERVER_UNREACHABLE"
    elif "configuration" in normalized or "invalid server" in normalized or "invalid tls" in normalized:
        code = "LDAP_NOT_CONFIGURED"
    else:
        code = "LDAP_PROTOCOL_ERROR"
    return LDAPAuthError(diagnostic, code=code, cause_type=type(exc).__name__)


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
        raise LDAPAuthError(
            "LDAP_SERVER_URI is not configured on the server",
            code="LDAP_NOT_CONFIGURED",
            operation="configuration",
        )
    if settings.app_env in {"uat", "prod", "production"} and not LDAP_USE_SSL:
        raise LDAPAuthError(
            "LDAP_USE_SSL must be enabled outside development",
            code="LDAP_NOT_CONFIGURED",
            operation="configuration",
        )
    if LDAP_USE_SSL and LDAP_SERVER_URI.lower().startswith("ldap://"):
        raise LDAPAuthError(
            "Use an ldaps:// URI or hostname when LDAP_USE_SSL is enabled",
            code="LDAP_NOT_CONFIGURED",
            operation="configuration",
        )
    if not password:
        return None

    stage = "connect"
    try:
        tls = Tls(validate=ssl.CERT_REQUIRED, ca_certs_file=os.getenv("LDAP_CA_CERTS_FILE") or None)
        server = Server(LDAP_SERVER_URI, use_ssl=LDAP_USE_SSL, tls=tls, get_info=None)

        if LDAP_BIND_DN and LDAP_BASE_DN:
            # Strategy 1: service-account search (grabs profile attributes for
            # free), then bind as the resolved user DN to verify the password.
            stage = "service_bind"
            with Connection(server, user=LDAP_BIND_DN, password=LDAP_BIND_PASSWORD,
                             authentication=SIMPLE, auto_bind=True) as service_conn:
                search_filter = LDAP_USER_SEARCH_FILTER.format(username=escape_filter_chars(username))
                stage = "directory_search"
                searched = service_conn.search(
                    search_base=LDAP_BASE_DN,
                    search_filter=search_filter,
                    search_scope=SUBTREE,
                    attributes=_PROFILE_ATTRS,
                )
                if not searched:
                    diagnostic = _ldap_result_diagnostic(service_conn.result)
                    normalized = diagnostic.casefold()
                    result_code = service_conn.result.get("result") if isinstance(service_conn.result, dict) else None
                    if result_code in {3, 51, 52} or "timeout" in normalized or "unavailable" in normalized:
                        code = "LDAP_CONNECTION_TIMEOUT" if result_code == 3 or "timeout" in normalized else "LDAP_SERVER_UNREACHABLE"
                    else:
                        code = "LDAP_SEARCH_FAILED"
                    raise LDAPAuthError(diagnostic, code=code, cause_type="LDAPSearchResult")
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
            # Do not use Connection as a context manager for the user bind.
            # ldap3 auto-binds during __enter__; invalid credentials then raise
            # LDAPBindError before our explicit bind/result inspection and
            # were previously mislabeled as a 503 directory outage.
            stage = "user_bind"
            user_conn = Connection(server, user=user_dn, password=password, authentication=SIMPLE)
            try:
                if not user_conn.bind():
                    bind_error = _ldap_bind_error(user_conn.result)
                    if bind_error:
                        raise bind_error
                    return None
            finally:
                try:
                    user_conn.unbind()
                except Exception:
                    pass
            return profile

        elif LDAP_USER_DN_TEMPLATE:
            # Strategy 2: direct bind using a predictable DN template. No
            # service account, so profile attributes are only available if
            # the directory lets an authenticated user read their own entry.
            user_dn = LDAP_USER_DN_TEMPLATE.format(username=escape_rdn(username))
            stage = "user_bind"
            conn = Connection(server, user=user_dn, password=password, authentication=SIMPLE)
            try:
                if not conn.bind():
                    bind_error = _ldap_bind_error(conn.result)
                    if bind_error:
                        raise bind_error
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
            finally:
                try:
                    conn.unbind()
                except Exception:
                    pass

        else:
            raise LDAPAuthError(
                "LDAP is not fully configured: set either "
                "(LDAP_BIND_DN + LDAP_BIND_PASSWORD + LDAP_BASE_DN) for search-then-bind, "
                "or LDAP_USER_DN_TEMPLATE for direct bind.",
                code="LDAP_NOT_CONFIGURED",
                operation="configuration",
            )
    except LDAPAuthError as exc:
        if not exc.operation:
            exc.operation = stage
        raise
    except (LDAPException, ssl.SSLError, OSError, TimeoutError, ValueError, KeyError) as exc:
        classified = _ldap_exception_error(exc, stage)
        if classified is None:
            return None
        classified.operation = stage
        raise classified from exc


def ldap_authenticate(username: str, password: str) -> bool:
    """Simple pass/fail check used on every login for an existing LDAP account."""
    return _ldap_bind_and_fetch(username, password) is not None


def ldap_authenticate_with_profile(username: str, password: str):
    """Like ldap_authenticate, but also returns best-effort profile attributes
    (full_name/email/department). Used only for just-in-time provisioning of
    a brand-new local account on a first-ever LDAP login. Returns None on
    failed authentication."""
    return _ldap_bind_and_fetch(username, password)
