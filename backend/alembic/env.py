"""Alembic environment for the QualityOps Oracle schema."""

from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import settings  # noqa: E402

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

database_url = (settings.database_url or "").strip()
if not database_url:
    raise RuntimeError(
        "DATABASE_URL is required for Alembic. Set the same "
        "oracle+oracledb:// URL used by the application."
    )
if not database_url.startswith("oracle+oracledb://"):
    raise RuntimeError("Alembic supports only an oracle+oracledb:// DATABASE_URL.")

# Importing models registers every mapped table on the side-effect-free Base.
from app.db_base import Base  # noqa: E402
from app import models  # noqa: E402,F401

target_metadata = Base.metadata
VERSION_TABLE = "qap_alembic_version"


def include_object(obj, name, type_, reflected, compare_to):  # noqa: ARG001
    """Do not propose dropping non-QualityOps objects in a shared schema."""
    if type_ == "table" and reflected:
        return name == VERSION_TABLE or name.startswith("qap_")
    return True


def configure_context(**kwargs):
    context.configure(
        target_metadata=target_metadata,
        version_table=VERSION_TABLE,
        include_object=include_object,
        compare_type=True,
        # Oracle default reflection can normalize expressions differently;
        # defaults must be reviewed and migrated explicitly when they change.
        compare_server_default=False,
        include_schemas=False,
        **kwargs,
    )


def run_migrations_offline() -> None:
    configure_context(
        url=database_url,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(database_url, poolclass=pool.NullPool)
    try:
        with connectable.connect() as connection:
            configure_context(connection=connection)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
