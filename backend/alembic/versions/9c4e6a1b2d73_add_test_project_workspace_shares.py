"""Add workspace recipients to Test Project view grants.

Revision ID: 9c4e6a1b2d73
Revises: 8f3d5b0c2e71
"""

import sqlalchemy as sa
from alembic import op


revision = "9c4e6a1b2d73"
down_revision = "8f3d5b0c2e71"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "qap_test_project_view_grants",
        sa.Column("workspace_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_qap_tpvg_workspace", "qap_test_project_view_grants",
        "qap_qa_workspaces", ["workspace_id"], ["id"],
    )
    op.create_index(
        "ix_qap_tpvg_workspace", "qap_test_project_view_grants", ["workspace_id"], unique=False,
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_qap_tpvg_project_ws ON qap_test_project_view_grants "
        "((CASE WHEN workspace_id IS NOT NULL THEN project_id END), workspace_id)"
    )


def downgrade() -> None:
    op.drop_index("uq_qap_tpvg_project_ws", table_name="qap_test_project_view_grants")
    op.drop_index("ix_qap_tpvg_workspace", table_name="qap_test_project_view_grants")
    op.drop_constraint("fk_qap_tpvg_workspace", "qap_test_project_view_grants", type_="foreignkey")
    op.drop_column("qap_test_project_view_grants", "workspace_id")
