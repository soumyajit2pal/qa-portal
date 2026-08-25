"""add dashboard recent activity index

Revision ID: b72c1d9e4a6f
Revises: a31e7d92c4f0
Create Date: 2026-08-24
"""
from typing import Sequence, Union

from alembic import op


revision: str = "b72c1d9e4a6f"
down_revision: Union[str, None] = "a31e7d92c4f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_qap_appract_created_id", "qap_approval_actions", ["created_at", "id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_qap_appract_created_id", table_name="qap_approval_actions")
