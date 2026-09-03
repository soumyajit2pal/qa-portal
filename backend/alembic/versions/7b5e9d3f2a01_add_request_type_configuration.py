"""add Admin-managed QA request type availability

Revision ID: 7b5e9d3f2a01
Revises: 6a4d8c2e1f90
Create Date: 2026-09-03
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7b5e9d3f2a01"
down_revision: Union[str, Sequence[str], None] = "6a4d8c2e1f90"
branch_labels = None
depends_on = None


REQUEST_TYPES = (
    "Functional Testing", "Sanity Testing", "Regression Testing", "UAT Support",
    "Performance Testing", "SAST", "DAST",
)


def upgrade() -> None:
    op.create_table(
        "qap_request_type_config",
        sa.Column("id", sa.Integer(), sa.Identity(start=1, increment=1), nullable=False),
        sa.Column("request_type", sa.String(length=80), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_type", name="uq_qap_request_type_config"),
    )
    table = sa.table(
        "qap_request_type_config",
        sa.column("request_type", sa.String),
        sa.column("sort_order", sa.Integer),
        sa.column("is_active", sa.Boolean),
    )
    op.bulk_insert(table, [
        {"request_type": request_type, "sort_order": index, "is_active": True}
        for index, request_type in enumerate(REQUEST_TYPES)
    ])


def downgrade() -> None:
    op.drop_table("qap_request_type_config")
