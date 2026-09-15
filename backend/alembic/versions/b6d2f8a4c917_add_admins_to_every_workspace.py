"""Add every System Administrator to every workspace.

Revision ID: b6d2f8a4c917
Revises: 9c4e6a1b2d73
"""

from alembic import op


revision = "b6d2f8a4c917"
down_revision = "9c4e6a1b2d73"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE qap_qa_workspace_members
        SET is_active = 1
        WHERE role = 'WORKSPACE_MEMBER'
          AND EXISTS (
            SELECT 1 FROM qap_user_roles role_row
            WHERE role_row.user_id = qap_qa_workspace_members.user_id
              AND role_row.role = 'ADMIN'
          )
        """
    )
    op.execute(
        """
        INSERT INTO qap_qa_workspace_members
          (workspace_id, user_id, role, is_active, created_at)
        SELECT workspace.id, role_row.user_id, 'WORKSPACE_MEMBER', 1, CURRENT_TIMESTAMP
        FROM qap_qa_workspaces workspace
        CROSS JOIN qap_user_roles role_row
        WHERE role_row.role = 'ADMIN'
          AND NOT EXISTS (
            SELECT 1 FROM qap_qa_workspace_members membership
            WHERE membership.workspace_id = workspace.id
              AND membership.user_id = role_row.user_id
              AND membership.role = 'WORKSPACE_MEMBER'
          )
        """
    )


def downgrade() -> None:
    # This is a data invariant. Existing membership rows cannot be reliably
    # distinguished from rows administrators already held before migration.
    pass
