"""Centralized, environment-controlled logging for the backend.

``DEEP_LOGGING=false`` is the production default: application INFO events,
warnings, errors, Uvicorn access records and full unhandled-exception
tracebacks are retained without logging every database/request detail.

``DEEP_LOGGING=true`` is a temporary diagnostic mode: application DEBUG
events, correlated API request timings, SQL text (with bind values hidden)
and SQLAlchemy pool activity are added.  Request bodies, authorization
headers, cookies and SQL bind values are deliberately never logged.
"""
from __future__ import annotations

import contextvars
import logging
import logging.handlers
import os
from pathlib import Path

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
# main.py configures logging before database.py is imported, so logging must
# load the backend .env itself or DEEP_LOGGING in that file would be ignored.
load_dotenv(BACKEND_DIR / ".env")

_configured_log_dir = Path(os.getenv("LOG_DIR", str(BACKEND_DIR / "logs")))
LOG_DIR = str(_configured_log_dir if _configured_log_dir.is_absolute() else BACKEND_DIR / _configured_log_dir)
LOG_FILE = os.path.join(LOG_DIR, os.getenv("LOG_FILE_NAME", "app.log"))

_configured = False
_request_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "qa_portal_request_id", default="-"
)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def deep_logging_enabled() -> bool:
    return _env_bool("DEEP_LOGGING", False)


def bind_request_id(request_id: str):
    """Bind a request id to all log records in the current request context."""
    return _request_id.set(request_id)


def reset_request_id(token) -> None:
    _request_id.reset(token)


class _RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id.get()
        return True


def _add_handler_once(target: logging.Logger, handler: logging.Handler) -> None:
    if handler not in target.handlers:
        target.addHandler(handler)


def configure_logging() -> logging.Logger:
    """Configure the shared logger once per worker process."""
    global _configured
    logger = logging.getLogger("qa_portal")
    if _configured:
        return logger

    os.makedirs(LOG_DIR, exist_ok=True)
    deep = deep_logging_enabled()
    application_level = logging.DEBUG if deep else logging.INFO

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-8s [%(name)s] "
        "[pid=%(process)d request_id=%(request_id)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    context_filter = _RequestContextFilter()

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_FILE,
        maxBytes=max(1, _env_int("LOG_MAX_BYTES", 10 * 1024 * 1024)),
        backupCount=max(1, _env_int("LOG_BACKUP_COUNT", 5)),
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(context_filter)
    file_handler.setLevel(application_level)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    console_handler.addFilter(context_filter)
    console_handler.setLevel(application_level)

    logger.setLevel(application_level)
    _add_handler_once(logger, file_handler)
    _add_handler_once(logger, console_handler)
    logger.propagate = False

    # Uvicorn retains its own console handlers. Add only the rotating file
    # destination here to avoid duplicate console lines.
    for name in ("uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.setLevel(logging.DEBUG if deep else logging.INFO)
        _add_handler_once(uvicorn_logger, file_handler)

    # SQL and pool diagnostics are intentionally opt-in. Engine creation uses
    # hide_parameters=True as a second safety boundary, so even deep mode logs
    # SQL structure but never passwords, comments, tokens, or other bind data.
    for name in ("sqlalchemy.engine", "sqlalchemy.pool"):
        sql_logger = logging.getLogger(name)
        sql_logger.setLevel(
            (logging.DEBUG if name == "sqlalchemy.pool" else logging.INFO)
            if deep else logging.WARNING
        )
        _add_handler_once(sql_logger, file_handler)
        _add_handler_once(sql_logger, console_handler)
        sql_logger.propagate = False

    _configured = True
    logger.info(
        "Logging configured -- mode=%s level=%s file=%s",
        "DEEP" if deep else "BASIC",
        logging.getLevelName(application_level),
        LOG_FILE,
    )
    if deep:
        logger.warning(
            "Deep logging is enabled; use it temporarily for diagnosis and disable it after collection."
        )
    return logger


def mask_database_url(url: str) -> str:
    """Mask the password embedded in a database connection string."""
    if "://" not in url or "@" not in url:
        return url
    scheme, rest = url.split("://", 1)
    creds, host_part = rest.split("@", 1)
    if ":" in creds:
        user, _password = creds.split(":", 1)
        creds = f"{user}:***"
    return f"{scheme}://{creds}@{host_part}"
