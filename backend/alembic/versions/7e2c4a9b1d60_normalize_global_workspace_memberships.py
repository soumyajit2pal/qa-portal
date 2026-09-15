"""Normalize global workspace membership to one row per user and workspace.

Revision ID: 7e2c4a9b1d60
Revises: 5c1e8a2d7f90
"""

from alembic import op


revision = "7e2c4a9b1d60"
down_revision = "5c1e8a2d7f90"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Preserve every legacy workspace capability in the global permission
    # profile before removing the duplicated role-specific membership rows.
    op.execute("""
      INSERT INTO qap_user_roles (user_id, role)
      SELECT DISTINCT m.user_id, m.role
      FROM qap_qa_workspace_members m
      WHERE m.role IN ('QA_ENGINEER','QA_LEAD','SECURITY_ANALYST','CHIEF_MANAGER_QA','AGM_QA')
        AND NOT EXISTS (
          SELECT 1 FROM qap_user_roles r
          WHERE r.user_id=m.user_id AND r.role=m.role
        )
    """)
    op.execute("""
      DELETE FROM qap_qa_workspace_members
      WHERE role <> 'WORKSPACE_MEMBER'
    """)


def downgrade() -> None:
    # Permission profiles retain the promoted capabilities. Reconstructing
    # obsolete role-per-workspace rows would reintroduce duplicate access.
    pass
