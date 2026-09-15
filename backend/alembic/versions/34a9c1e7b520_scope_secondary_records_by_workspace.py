"""Persist workspace scope on suppression requests and QA clearances.

Revision ID: 34a9c1e7b520
Revises: 1f8c2b7a9d40
"""

import sqlalchemy as sa
from alembic import op


revision = "34a9c1e7b520"
down_revision = "1f8c2b7a9d40"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("qap_suppression_requests", sa.Column("qa_workspace_id", sa.Integer()))
    op.create_foreign_key("fk_qap_sup_qaws", "qap_suppression_requests", "qap_qa_workspaces",
                          ["qa_workspace_id"], ["id"])
    op.create_index("ix_qap_sup_qaws", "qap_suppression_requests", ["qa_workspace_id"])
    op.add_column("qap_signoffs", sa.Column("qa_workspace_id", sa.Integer()))
    op.create_foreign_key("fk_qap_sign_qaws", "qap_signoffs", "qap_qa_workspaces",
                          ["qa_workspace_id"], ["id"])
    op.create_index("ix_qap_sign_qaws", "qap_signoffs", ["qa_workspace_id"])
    op.execute("""UPDATE qap_suppression_requests SET qa_workspace_id=(SELECT id FROM qap_qa_workspaces
      WHERE workspace_key='COE-QA') WHERE qa_workspace_id IS NULL""")
    op.execute("""UPDATE qap_signoffs SET qa_workspace_id=(SELECT id FROM qap_qa_workspaces
      WHERE workspace_key='COE-QA') WHERE qa_workspace_id IS NULL""")


def downgrade() -> None:
    op.drop_index("ix_qap_sign_qaws", table_name="qap_signoffs")
    op.drop_constraint("fk_qap_sign_qaws", "qap_signoffs", type_="foreignkey")
    op.drop_column("qap_signoffs", "qa_workspace_id")
    op.drop_index("ix_qap_sup_qaws", table_name="qap_suppression_requests")
    op.drop_constraint("fk_qap_sup_qaws", "qap_suppression_requests", type_="foreignkey")
    op.drop_column("qap_suppression_requests", "qa_workspace_id")
