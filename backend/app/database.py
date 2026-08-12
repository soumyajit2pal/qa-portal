"""
Database configuration -- Oracle only.

Set the DATABASE_URL environment variable to an Oracle connection string using
SQLAlchemy's oracledb dialect (thin mode, no Oracle Instant Client required):

    DATABASE_URL=oracle+oracledb://QA_PORTAL:password@dbhost:1521/?service_name=ORCLPDB1

For local development against Oracle Database Free / XE running in Docker, see
the "Local Oracle for development" section in the README, e.g.:

    DATABASE_URL=oracle+oracledb://qa_portal:qa_portal_pwd@localhost:1521/?service_name=FREEPDB1

The app refuses to start without DATABASE_URL set -- there is no SQLite or
other fallback.
"""
import logging
import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base

from .logging_config import configure_logging, mask_database_url

load_dotenv()  # loads backend/.env if present; real env vars still take precedence
configure_logging()  # first import in the chain (main.py imports this module
                      # before anything else that might log) -- see
                      # logging_config.py's own docstring for why this exists.
logger = logging.getLogger("qa_portal")

DATABASE_URL = os.getenv("DATABASE_URL")
# Was a bare print() of the RAW connection string (username:password@host) --
# harmless when it only ever went to an ephemeral terminal, but now that
# logger output is persisted to a rotating file on disk, the password must
# be masked before it's ever written out. See mask_database_url's own
# docstring.
logger.info("Using DATABASE_URL: %s", mask_database_url(DATABASE_URL) if DATABASE_URL else DATABASE_URL)

if not DATABASE_URL:
    logger.critical("Startup aborted: DATABASE_URL is not set.")
    raise RuntimeError(
        "DATABASE_URL is not set. This application requires an Oracle connection "
        "string, e.g.:\n"
        "  export DATABASE_URL='oracle+oracledb://QA_PORTAL:password@dbhost:1521/?service_name=ORCLPDB1'\n"
        "See README.md for local Oracle setup (Docker) and production notes."
    )

if not DATABASE_URL.startswith("oracle"):
    logger.critical("Startup aborted: DATABASE_URL scheme is not Oracle (got %s://...).", DATABASE_URL.split(':')[0])
    raise RuntimeError(
        f"DATABASE_URL must be an Oracle connection string (oracle+oracledb://...). "
        f"Got: {DATABASE_URL.split(':')[0]}://..."
    )

def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("Ignoring invalid %s=%r (not an int); using default %s", name, raw, default)
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# Pool sizing suitable for a departmental Oracle-backed web app; defaults below
# match the previous hardcoded values, but every knob is now overridable via
# environment variable (DBP-001..006) so it can be tuned per-deployment (e.g.
# scaled down per-worker once running with multiple API workers, see
# INF-001) without a code change:
#   DB_POOL_SIZE      -- baseline pooled connections per engine (per worker
#                         process -- each worker gets its own pool). Default 10.
#   DB_MAX_OVERFLOW   -- extra connections allowed beyond pool_size under
#                         burst load, closed once idle. Default 20.
#   DB_POOL_TIMEOUT   -- seconds to wait for a pooled connection before
#                         raising, rather than hanging indefinitely. Default 30.
#   DB_POOL_RECYCLE   -- seconds before a pooled connection is transparently
#                         recycled, avoiding stale/dropped Oracle sessions
#                         (e.g. behind a firewall idle-connection reaper).
#                         Default 1800 (30 min).
#   DB_POOL_PRE_PING  -- validate a connection with a lightweight ping before
#                         handing it out, so a dead connection is replaced
#                         instead of surfacing as a query error. Default true.
POOL_SIZE = _env_int("DB_POOL_SIZE", 10)
MAX_OVERFLOW = _env_int("DB_MAX_OVERFLOW", 20)
POOL_TIMEOUT = _env_int("DB_POOL_TIMEOUT", 30)
POOL_RECYCLE = _env_int("DB_POOL_RECYCLE", 1800)
POOL_PRE_PING = _env_bool("DB_POOL_PRE_PING", True)

logger.info(
    "DB pool config: pool_size=%s max_overflow=%s pool_timeout=%s pool_recycle=%s pool_pre_ping=%s",
    POOL_SIZE, MAX_OVERFLOW, POOL_TIMEOUT, POOL_RECYCLE, POOL_PRE_PING,
)

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=POOL_PRE_PING,
    pool_size=POOL_SIZE,
    max_overflow=MAX_OVERFLOW,
    pool_timeout=POOL_TIMEOUT,
    pool_recycle=POOL_RECYCLE,
)
# Section 8 (API Standards) -- query timeout. A single runaway query (bad
# plan, missing index, table lock) shouldn't be able to hold a pooled
# connection (and the request thread waiting on it) indefinitely; python-
# oracledb (thin mode, which this app uses exclusively -- see module
# docstring) exposes this as a per-connection `call_timeout` in
# milliseconds, applied here to every connection as it's created rather than
# per-query, so it's one setting instead of threading a timeout through
# every router. 0 (default) leaves it disabled, matching prior behavior,
# since an overly aggressive default could abort legitimate slow reports.
QUERY_TIMEOUT_MS = _env_int("DB_QUERY_TIMEOUT_MS", 0)
if QUERY_TIMEOUT_MS > 0:
    logger.info("DB query timeout: call_timeout=%sms", QUERY_TIMEOUT_MS)

    @event.listens_for(engine, "connect")
    def _set_call_timeout(dbapi_connection, connection_record):  # noqa: ARG001
        try:
            dbapi_connection.call_timeout = QUERY_TIMEOUT_MS
        except AttributeError:
            # Defensive only -- python-oracledb has supported call_timeout
            # since well before this app's minimum supported version.
            logger.warning("DB driver does not support call_timeout; DB_QUERY_TIMEOUT_MS ignored.")

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# 2026-08 -- dedicated pool for audit writes (see main.py's
# application_audit_middleware / _write_request_audit). Previously, every
# single /api request's background audit write pulled a connection from the
# SAME pool as normal request handling (`engine`/`SessionLocal` above),
# competing with real user requests for a share of DB_POOL_SIZE +
# DB_MAX_OVERFLOW under concurrent load -- reported directly as a
# contributing factor to "API calls too slow" alongside a NameError crash
# report. Audit writes are small, frequent, single-row inserts that don't
# need to compete for that same budget, so they get their own separate
# (deliberately smaller) engine/pool instead -- sized independently via
# AUDIT_DB_POOL_SIZE/AUDIT_DB_MAX_OVERFLOW so it can be tuned without
# affecting the main pool. Defaults are intentionally small: an audit write
# holds its connection only briefly (one INSERT + commit), so a handful of
# connections comfortably keeps up even under load; if this pool itself
# starts timing out, that's now a distinct, separately diagnosable signal
# from the main pool's own timeout errors instead of the two being
# indistinguishable. Same DATABASE_URL/DB_POOL_TIMEOUT/DB_POOL_RECYCLE as
# the main engine -- only the pool size/overflow differ.
AUDIT_POOL_SIZE = _env_int("AUDIT_DB_POOL_SIZE", 3)
AUDIT_MAX_OVERFLOW = _env_int("AUDIT_DB_MAX_OVERFLOW", 5)

logger.info(
    "Audit DB pool config: pool_size=%s max_overflow=%s (separate from main pool above)",
    AUDIT_POOL_SIZE, AUDIT_MAX_OVERFLOW,
)

audit_engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=POOL_PRE_PING,
    pool_size=AUDIT_POOL_SIZE,
    max_overflow=AUDIT_MAX_OVERFLOW,
    pool_timeout=POOL_TIMEOUT,
    pool_recycle=POOL_RECYCLE,
)
if QUERY_TIMEOUT_MS > 0:
    @event.listens_for(audit_engine, "connect")
    def _set_audit_call_timeout(dbapi_connection, connection_record):  # noqa: ARG001
        try:
            dbapi_connection.call_timeout = QUERY_TIMEOUT_MS
        except AttributeError:
            pass  # already logged once against the main engine above

AuditSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=audit_engine)
