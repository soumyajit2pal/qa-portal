"""Record the existing create_all-managed Oracle schema as Alembic baseline.

Revision ID: 20260814_0001
Revises: None
Create Date: 2026-08-14

This marker intentionally contains no DDL. Before it is stamped, operators
must verify that the existing qap_* schema was created from the current model
metadata. All schema changes after this revision must use Alembic migrations.
"""

from typing import Sequence, Union


revision: str = "20260814_0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
