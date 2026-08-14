"""Shared SQLAlchemy declarative metadata.

This module deliberately has no engine or environment-variable side effects.
Application startup and Alembic can therefore import the model metadata
without creating the web application's normal and audit connection pools.
"""

from sqlalchemy.orm import declarative_base


Base = declarative_base()
