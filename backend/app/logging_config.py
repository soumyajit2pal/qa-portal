"""Centralized logging setup for the backend.

The app previously had no durable record of startup failures. Every
informational message anywhere in the backend was a bare `print()`
(database.py's "Using DATABASE_URL: ..." line, main.py's "Migrated N
upload(s)..." line) -- console-only, gone the moment the terminal is closed
or the process is run under a supervisor that doesn't capture stdout. There
was no log file, no global exception handler logging full tracebacks, and a
startup-time crash in Base.metadata.create_all() would only ever be visible
to whoever happened to be staring at the terminal at that exact moment.

configure_logging() below sets up both a rotating file handler (so a crash
last night is still readable this morning) and a console handler (so local
`uvicorn --reload` development still shows everything live, unchanged from
before). Call this once, as the very first thing main.py does -- before any
other import that might log anything (e.g. database.py's DATABASE_URL line),
so nothing is missed.
"""
import logging
import logging.handlers
import os

LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
LOG_FILE = os.path.join(LOG_DIR, "app.log")

_configured = False


def configure_logging() -> logging.Logger:
    """Idempotent -- safe to call more than once (e.g. under --reload, which
    re-executes main.py's module body on every code change)."""
    global _configured
    logger = logging.getLogger("qa_portal")
    if _configured:
        return logger

    os.makedirs(LOG_DIR, exist_ok=True)
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 10 MB per file, keep the last 5 -- plenty for a departmental app, and
    # bounded so a crash-looping process can never fill the disk.
    file_handler = logging.handlers.RotatingFileHandler(
        LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    logger.setLevel(level)
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    logger.propagate = False

    # uvicorn's own loggers (uvicorn.error, uvicorn.access) already print to
    # console by default -- also route them into the same log file, so
    # startup crashes uvicorn itself reports (e.g. "address already in use",
    # or a worker that failed to boot) land in one place instead of only
    # ever being visible in whatever terminal launched the process.
    for uv_logger_name in ("uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(uv_logger_name)
        uv_logger.addHandler(file_handler)

    _configured = True
    logger.info("Logging configured -- level=%s, file=%s", level_name, LOG_FILE)
    return logger


def mask_database_url(url: str) -> str:
    """Never write a raw DB connection string (which embeds the password) to
    a log file that -- unlike an ephemeral terminal -- persists on disk and
    may be more widely readable/backed-up. Masks the password only; scheme,
    username, host, port, and service name are left visible since they're
    needed to diagnose connection issues."""
    if "://" not in url or "@" not in url:
        return url
    scheme, rest = url.split("://", 1)
    creds, host_part = rest.split("@", 1)
    if ":" in creds:
        user, _password = creds.split(":", 1)
        creds = f"{user}:***"
    return f"{scheme}://{creds}@{host_part}"
