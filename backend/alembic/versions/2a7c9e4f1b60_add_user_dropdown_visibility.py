"""add explicit user dropdown visibility

Revision ID: 2a7c9e4f1b60
Revises: f2b6d8a4c901
Create Date: 2026-09-11
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2a7c9e4f1b60"
down_revision: Union[str, None] = "f2b6d8a4c901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "qap_users",
        sa.Column("show_in_user_dropdowns", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("qap_users", "show_in_user_dropdowns")
