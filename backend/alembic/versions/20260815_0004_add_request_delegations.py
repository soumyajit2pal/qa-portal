"""Add controlled QA Request delegation.

Revision ID: 20260815_0004
Revises: 3f07d8f00646
Create Date: 2026-08-15
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260815_0004"
down_revision: Union[str, None] = "3f07d8f00646"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "qap_request_delegations",
        sa.Column("id", sa.Integer(), sa.Identity(always=False, start=1, increment=1), nullable=False),
        sa.Column("qa_request_id", sa.Integer(), nullable=False),
        sa.Column("assigned_by_id", sa.Integer(), nullable=False),
        sa.Column("assigned_to_id", sa.Integer(), nullable=False),
        sa.Column("assignment_reason", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("assigned_at", sa.DateTime(), nullable=False),
        sa.Column("closed_by_id", sa.Integer(), nullable=True),
        sa.Column("returned_at", sa.DateTime(), nullable=True),
        sa.Column("return_comments", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["qa_request_id"], ["qap_requests.id"], name="fk_qap_del_request"),
        sa.ForeignKeyConstraint(["assigned_by_id"], ["qap_users.id"], name="fk_qap_del_assigned_by"),
        sa.ForeignKeyConstraint(["assigned_to_id"], ["qap_users.id"], name="fk_qap_del_assigned_to"),
        sa.ForeignKeyConstraint(["closed_by_id"], ["qap_users.id"], name="fk_qap_del_closed_by"),
        sa.CheckConstraint("status IN ('ACTIVE','RETURNED','RECALLED')", name="ck_qap_del_status"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_qap_del_req_status", "qap_request_delegations", ["qa_request_id", "status"])
    op.create_index("ix_qap_del_user_status", "qap_request_delegations", ["assigned_to_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_qap_del_user_status", table_name="qap_request_delegations")
    op.drop_index("ix_qap_del_req_status", table_name="qap_request_delegations")
    op.drop_table("qap_request_delegations")
