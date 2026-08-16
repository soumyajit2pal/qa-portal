"""Scope delegation to the exact workflow request.

Revision ID: 20260815_0005
Revises: 20260815_0004
Create Date: 2026-08-15
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260815_0005"
down_revision: Union[str, None] = "20260815_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("qap_request_delegations", sa.Column("target_type", sa.String(length=24), nullable=True))
    op.add_column("qap_request_delegations", sa.Column("target_id", sa.Integer(), nullable=True))
    # Existing delegation history was gateway/Draft-scoped.
    op.execute(
        "UPDATE qap_request_delegations "
        "SET target_type = 'QA_REQUEST', target_id = qa_request_id "
        "WHERE target_type IS NULL OR target_id IS NULL"
    )
    op.alter_column("qap_request_delegations", "target_type", nullable=False)
    op.alter_column("qap_request_delegations", "target_id", nullable=False)
    op.create_check_constraint(
        "ck_qap_del_target_type",
        "qap_request_delegations",
        "target_type IN ('QA_REQUEST','FUNCTIONAL','SAST','DAST','PERFORMANCE')",
    )
    op.create_index(
        "ix_qap_del_target_status",
        "qap_request_delegations",
        ["target_type", "target_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_qap_del_target_status", table_name="qap_request_delegations")
    op.drop_constraint("ck_qap_del_target_type", "qap_request_delegations", type_="check")
    op.drop_column("qap_request_delegations", "target_id")
    op.drop_column("qap_request_delegations", "target_type")
