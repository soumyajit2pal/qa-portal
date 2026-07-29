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
import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

load_dotenv()  # loads backend/.env if present; real env vars still take precedence

DATABASE_URL = os.getenv("DATABASE_URL")
print(f"Using DATABASE_URL: {DATABASE_URL}")

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. This application requires an Oracle connection "
        "string, e.g.:\n"
        "  export DATABASE_URL='oracle+oracledb://QA_PORTAL:password@dbhost:1521/?service_name=ORCLPDB1'\n"
        "See README.md for local Oracle setup (Docker) and production notes."
    )

if not DATABASE_URL.startswith("oracle"):
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
