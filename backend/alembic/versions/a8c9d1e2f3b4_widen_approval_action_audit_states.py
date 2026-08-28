"""widen approval action audit-state labels

Revision ID: a8c9d1e2f3b4
Revises: f4a7c2d9e8b1
Create Date: 2026-08-28

ApprovalAction.previous_state/new_state contain both short workflow statuses
and human-readable assignment labels. The latter can be a comma-separated
list of assignees, so the original VARCHAR2(30) rejects legitimate audit
history with ORA-12899.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a8c9d1e2f3b4"
down_revision: Union[str, None] = "f4a7c2d9e8b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Increasing VARCHAR2 length is an in-place, non-destructive Oracle DDL
    # change. No existing audit data is changed or removed.
    op.alter_column(
        "qap_approval_actions", "previous_state",
        existing_type=sa.String(length=30), type_=sa.String(length=1000),
        existing_nullable=True,
    )
    op.alter_column(
        "qap_approval_actions", "new_state",
        existing_type=sa.String(length=30), type_=sa.String(length=1000),
        existing_nullable=True,
    )


def downgrade() -> None:
    # A destructive narrowing could discard audit data and may fail when a
    # legitimate label is longer than 30 characters. Deliberately leave the
    # safer column width in place.
    pass
