"""Add one-level parent and child workspace hierarchy.

Revision ID: e9a4c2f7b801
Revises: d4f8a2c6e901
"""

import sqlalchemy as sa
from alembic import op


revision = "e9a4c2f7b801"
down_revision = "d4f8a2c6e901"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "qap_qa_workspaces",
        sa.Column("parent_workspace_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_qap_workspace_parent",
        "qap_qa_workspaces",
        "qap_qa_workspaces",
        ["parent_workspace_id"],
        ["id"],
    )
    op.create_index(
        "ix_qap_workspace_parent",
        "qap_qa_workspaces",
        ["parent_workspace_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_qap_workspace_parent", table_name="qap_qa_workspaces")
    op.drop_constraint(
        "fk_qap_workspace_parent",
        "qap_qa_workspaces",
        type_="foreignkey",
    )
    op.drop_column("qap_qa_workspaces", "parent_workspace_id")
