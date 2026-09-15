"""Add explicit department coordinator scopes.

Revision ID: 8f3d5b0c2e71
Revises: 7e2c4a9b1d60
"""

import sqlalchemy as sa
from alembic import op


revision = "8f3d5b0c2e71"
down_revision = "7e2c4a9b1d60"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "qap_department_coordinators",
        sa.Column("id", sa.Integer(), sa.Identity(start=1, increment=1), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("department_id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("SYSTIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["qap_users.id"]),
        sa.ForeignKeyConstraint(["created_by_id"], ["qap_users.id"]),
        sa.ForeignKeyConstraint(["department_id"], ["qap_departments.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["qap_qa_workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "department_id", "workspace_id", name="uq_qap_dept_coord_scope"),
    )
    op.create_index("ix_qap_dc_user", "qap_department_coordinators", ["user_id"])
    op.create_index("ix_qap_dc_dept", "qap_department_coordinators", ["department_id"])
    op.create_index("ix_qap_dc_ws", "qap_department_coordinators", ["workspace_id"])

    # Preserve existing local-admin access during rollout. The legacy CM/AGM
    # titles are converted once into explicit scopes for every department and
    # active workspace already assigned to that user.
    op.execute("""
      INSERT INTO qap_department_coordinators
        (user_id, department_id, workspace_id, is_active, created_at)
      SELECT DISTINCT u.id, d.id, m.workspace_id, 1, SYSTIMESTAMP
      FROM qap_users u
      JOIN qap_user_roles r ON r.user_id = u.id
      JOIN qap_user_departments ud ON ud.user_id = u.id
      JOIN qap_departments d ON d.name = ud.department
      JOIN qap_qa_workspace_members m ON m.user_id = u.id AND m.is_active = 1
      JOIN qap_qa_workspaces w ON w.id = m.workspace_id AND w.is_active = 1
      WHERE u.is_active = 1
        AND r.role IN ('DEPARTMENT_HEAD_CM','DEPARTMENT_HEAD_AGM','CHIEF_MANAGER_QA','AGM_QA')
    """)


def downgrade() -> None:
    op.drop_index("ix_qap_dc_ws", table_name="qap_department_coordinators")
    op.drop_index("ix_qap_dc_dept", table_name="qap_department_coordinators")
    op.drop_index("ix_qap_dc_user", table_name="qap_department_coordinators")
    op.drop_table("qap_department_coordinators")
