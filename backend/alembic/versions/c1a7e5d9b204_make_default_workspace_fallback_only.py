"""Make the Default Workspace a fallback for normal users.

Revision ID: c1a7e5d9b204
Revises: b6d2f8a4c917
"""

from alembic import op


revision = "c1a7e5d9b204"
down_revision = "b6d2f8a4c917"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE qap_users target_user
        SET preferred_qa_workspace_id = (
          SELECT MIN(assigned_member.workspace_id)
          FROM qap_qa_workspace_members assigned_member
          JOIN qap_qa_workspaces assigned_workspace
            ON assigned_workspace.id = assigned_member.workspace_id
          WHERE assigned_member.user_id = target_user.id
            AND assigned_member.is_active = 1
            AND assigned_workspace.is_active = 1
            AND assigned_workspace.is_default = 0
        )
        WHERE preferred_qa_workspace_id IN (
          SELECT id FROM qap_qa_workspaces WHERE is_default = 1
        )
          AND NOT EXISTS (
            SELECT 1 FROM qap_user_roles administrator_role
            WHERE administrator_role.user_id = target_user.id
              AND administrator_role.role = 'ADMIN'
          )
          AND EXISTS (
            SELECT 1
            FROM qap_qa_workspace_members assigned_member
            JOIN qap_qa_workspaces assigned_workspace
              ON assigned_workspace.id = assigned_member.workspace_id
            WHERE assigned_member.user_id = target_user.id
              AND assigned_member.is_active = 1
              AND assigned_workspace.is_active = 1
              AND assigned_workspace.is_default = 0
          )
        """
    )
    op.execute(
        """
        DELETE FROM qap_qa_workspace_members
        WHERE id IN (
          SELECT default_member.id
          FROM qap_qa_workspace_members default_member
          JOIN qap_qa_workspaces default_workspace
            ON default_workspace.id = default_member.workspace_id
          WHERE default_workspace.is_default = 1
            AND default_member.role = 'WORKSPACE_MEMBER'
            AND NOT EXISTS (
              SELECT 1 FROM qap_user_roles administrator_role
              WHERE administrator_role.user_id = default_member.user_id
                AND administrator_role.role = 'ADMIN'
            )
            AND EXISTS (
              SELECT 1
              FROM qap_qa_workspace_members assigned_member
              JOIN qap_qa_workspaces assigned_workspace
                ON assigned_workspace.id = assigned_member.workspace_id
              WHERE assigned_member.user_id = default_member.user_id
                AND assigned_member.is_active = 1
                AND assigned_workspace.is_active = 1
                AND assigned_workspace.is_default = 0
            )
        )
        """
    )


def downgrade() -> None:
    # Removed fallback memberships are restored automatically if a user later
    # loses their final non-default workspace, so no blanket rollback is safe.
    pass
