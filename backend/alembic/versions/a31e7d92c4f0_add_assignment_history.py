"""add normalized assignment history

Revision ID: a31e7d92c4f0
Revises: f7b1d3e5a902
Create Date: 2026-08-22

Current assignment columns remain the operational source for authorization
and queue queries.  This additive table records each assignee tenure with
start/end timestamps, assigning/unassigning actors, assignment role, and
reasons so time-on-task and historical assignment reports no longer depend
on ApprovalAction display text.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a31e7d92c4f0"
down_revision: Union[str, None] = "f7b1d3e5a902"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "qap_assignment_history",
        sa.Column("id", sa.Integer(), sa.Identity(always=False, start=1, increment=1), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("assignment_role", sa.String(length=40), nullable=False),
        sa.Column("assignee_id", sa.Integer(), nullable=False),
        sa.Column("assigned_by_id", sa.Integer(), nullable=True),
        sa.Column("assigned_at", sa.DateTime(), nullable=False),
        sa.Column("assignment_reason", sa.Text(), nullable=True),
        sa.Column("unassigned_by_id", sa.Integer(), nullable=True),
        sa.Column("unassigned_at", sa.DateTime(), nullable=True),
        sa.Column("unassignment_reason", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "unassigned_at IS NULL OR unassigned_at >= assigned_at",
            name="ck_qap_asgh_time_order",
        ),
        sa.ForeignKeyConstraint(["assignee_id"], ["qap_users.id"]),
        sa.ForeignKeyConstraint(["assigned_by_id"], ["qap_users.id"]),
        sa.ForeignKeyConstraint(["unassigned_by_id"], ["qap_users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_qap_asgh_entity_active",
        "qap_assignment_history",
        ["entity_type", "entity_id", "assignment_role", "unassigned_at"],
        unique=False,
    )
    op.create_index(
        "ix_qap_asgh_user_time",
        "qap_assignment_history",
        ["assignee_id", "assigned_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_qap_asgh_user_time", table_name="qap_assignment_history")
    op.drop_index("ix_qap_asgh_entity_active", table_name="qap_assignment_history")
    op.drop_table("qap_assignment_history")
