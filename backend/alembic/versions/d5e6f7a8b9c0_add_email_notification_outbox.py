"""add durable workflow email notification outbox

Revision ID: d5e6f7a8b9c0
Revises: b72c1d9e4a6f
Create Date: 2026-08-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d5e6f7a8b9c0"
down_revision: Union[str, None] = "b72c1d9e4a6f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "qap_email_notifications",
        sa.Column("id", sa.Integer(), sa.Identity(always=False, start=1, increment=1), nullable=False),
        sa.Column("approval_action_id", sa.Integer(), nullable=False),
        sa.Column("recipient_email", sa.String(length=320), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["approval_action_id"], ["qap_approval_actions.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("approval_action_id", "recipient_email", name="uq_qap_email_action_recipient"),
    )
    op.create_index("ix_qap_email_outbox", "qap_email_notifications", ["status", "next_attempt_at", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_qap_email_outbox", table_name="qap_email_notifications")
    op.drop_table("qap_email_notifications")
