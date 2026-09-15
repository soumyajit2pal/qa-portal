"""Make Workspace the global tenant boundary for every active user.

Revision ID: 5c1e8a2d7f90
Revises: 34a9c1e7b520

The existing QA-prefixed tables and columns are intentionally retained so
the rollout does not rename populated Oracle objects. Their meaning is now
global Workspace scope.
"""

from alembic import op


revision = "5c1e8a2d7f90"
down_revision = "34a9c1e7b520"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Every existing workspace participant receives the neutral membership
    # row in addition to any QA capability held in that workspace.
    op.execute("""
      INSERT INTO qap_qa_workspace_members (workspace_id,user_id,role,is_active,created_at)
      SELECT DISTINCT m.workspace_id,m.user_id,'WORKSPACE_MEMBER',1,SYSTIMESTAMP
      FROM qap_qa_workspace_members m
      WHERE m.is_active=1 AND NOT EXISTS (
        SELECT 1 FROM qap_qa_workspace_members x
        WHERE x.workspace_id=m.workspace_id AND x.user_id=m.user_id
          AND x.role='WORKSPACE_MEMBER'
      )
    """)
    # Active users without any workspace are placed in the organisation
    # default (or the first active workspace when legacy data has no default).
    op.execute("""
      INSERT INTO qap_qa_workspace_members (workspace_id,user_id,role,is_active,created_at)
      SELECT COALESCE(
               (SELECT MIN(id) FROM qap_qa_workspaces WHERE is_active=1 AND is_default=1),
               (SELECT MIN(id) FROM qap_qa_workspaces WHERE is_active=1)
             ), u.id, 'WORKSPACE_MEMBER', 1, SYSTIMESTAMP
      FROM qap_users u
      WHERE u.is_active=1
        AND EXISTS (SELECT 1 FROM qap_qa_workspaces WHERE is_active=1)
        AND NOT EXISTS (
          SELECT 1 FROM qap_qa_workspace_members m
          WHERE m.user_id=u.id AND m.is_active=1
        )
    """)
    op.execute("""
      UPDATE qap_users u SET preferred_qa_workspace_id=(
        SELECT MIN(m.workspace_id) FROM qap_qa_workspace_members m
        WHERE m.user_id=u.id AND m.is_active=1
      )
      WHERE u.is_active=1 AND u.preferred_qa_workspace_id IS NULL
    """)
    op.execute("""DELETE FROM qap_qa_workspace_members WHERE role='WORKSPACE_VIEWER'""")


def downgrade() -> None:
    op.execute("""UPDATE qap_qa_workspace_members SET role='WORKSPACE_VIEWER' WHERE role='WORKSPACE_MEMBER'""")
