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
from sqlalchemy import create_engine
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

# Pool sizing suitable for a departmental Oracle-backed web app; tune for your
# deployment (concurrent user counts, DB session limits) per NFR 5.2.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
