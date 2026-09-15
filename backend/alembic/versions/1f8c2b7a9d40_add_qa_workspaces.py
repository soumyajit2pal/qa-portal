"""Add QA Workspaces, scoped membership, coverage, and persisted routing.

Revision ID: 1f8c2b7a9d40
Revises: 6d2e8a4c1f90
"""

import sqlalchemy as sa
from alembic import op


revision = "1f8c2b7a9d40"
down_revision = "6d2e8a4c1f90"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "qap_qa_workspaces",
        sa.Column("id", sa.Integer(), sa.Identity(start=1), primary_key=True),
        sa.Column("workspace_key", sa.String(40), nullable=False),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("1"), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_by_id", sa.Integer()),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.ForeignKeyConstraint(["created_by_id"], ["qap_users.id"], name="fk_qap_qaws_created_by"),
        sa.UniqueConstraint("workspace_key", name="uq_qap_qaws_key"),
        sa.UniqueConstraint("name", name="uq_qap_qaws_name"),
    )
    op.create_table(
        "qap_qa_workspace_members",
        sa.Column("id", sa.Integer(), sa.Identity(start=1), primary_key=True),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(40), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime()),
        sa.ForeignKeyConstraint(["workspace_id"], ["qap_qa_workspaces.id"], name="fk_qap_qawm_workspace"),
        sa.ForeignKeyConstraint(["user_id"], ["qap_users.id"], name="fk_qap_qawm_user"),
        sa.UniqueConstraint("workspace_id", "user_id", "role", name="uq_qap_qawm_ws_user_role"),
    )
    op.create_index("ix_qap_qawm_ws", "qap_qa_workspace_members", ["workspace_id"])
    op.create_index("ix_qap_qawm_user", "qap_qa_workspace_members", ["user_id"])
    op.create_table(
        "qap_qa_workspace_coverage",
        sa.Column("id", sa.Integer(), sa.Identity(start=1), primary_key=True),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("department_id", sa.Integer()),
        sa.Column("application_master_id", sa.Integer()),
        sa.Column("request_type", sa.String(80)),
        sa.Column("priority", sa.Integer(), server_default=sa.text("100"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime()),
        sa.ForeignKeyConstraint(["workspace_id"], ["qap_qa_workspaces.id"], name="fk_qap_qawc_workspace"),
        sa.ForeignKeyConstraint(["department_id"], ["qap_departments.id"], name="fk_qap_qawc_department"),
        sa.ForeignKeyConstraint(["application_master_id"], ["qap_application_master.id"], name="fk_qap_qawc_application"),
    )
    op.create_index("ix_qap_qawc_ws", "qap_qa_workspace_coverage", ["workspace_id"])
    op.create_index("ix_qap_qawc_dept", "qap_qa_workspace_coverage", ["department_id"])
    op.create_index("ix_qap_qawc_app", "qap_qa_workspace_coverage", ["application_master_id"])

    op.add_column("qap_users", sa.Column("preferred_qa_workspace_id", sa.Integer()))
    op.create_foreign_key("fk_qap_user_pref_qaws", "qap_users", "qap_qa_workspaces",
                          ["preferred_qa_workspace_id"], ["id"])
    op.add_column("qap_requests", sa.Column("qa_workspace_id", sa.Integer()))
    op.add_column("qap_requests", sa.Column("workspace_routing_status", sa.String(24),
                                             server_default="PENDING", nullable=False))
    op.create_foreign_key("fk_qap_req_qaws", "qap_requests", "qap_qa_workspaces", ["qa_workspace_id"], ["id"])
    op.create_index("ix_qap_req_qaws", "qap_requests", ["qa_workspace_id"])
    op.add_column("qap_test_projects", sa.Column("qa_workspace_id", sa.Integer()))
    op.create_foreign_key("fk_qap_proj_qaws", "qap_test_projects", "qap_qa_workspaces", ["qa_workspace_id"], ["id"])
    op.create_index("ix_qap_proj_qaws", "qap_test_projects", ["qa_workspace_id"])

    # COE-QA was a compatibility container for installations that already
    # contained users and business records when workspace scoping arrived.
    # A genuinely empty schema must not receive organisation-specific data;
    # seed.py creates the neutral DEFAULT workspace after migrations finish.
    op.execute("""
      INSERT INTO qap_qa_workspaces
        (workspace_key,name,description,is_active,is_default,created_at,updated_at)
      SELECT 'COE-QA','COE Quality Assurance','Migrated default QA workspace',1,1,SYSTIMESTAMP,SYSTIMESTAMP
      FROM dual
      WHERE EXISTS (SELECT 1 FROM qap_users)
        AND NOT EXISTS (SELECT 1 FROM qap_qa_workspaces WHERE workspace_key='COE-QA')
    """)
    op.execute("""
      INSERT INTO qap_qa_workspace_members (workspace_id,user_id,role,is_active,created_at)
      SELECT workspace.id,user_role.user_id,user_role.role,1,SYSTIMESTAMP
      FROM qap_qa_workspaces workspace
      JOIN qap_user_roles user_role ON user_role.role IN
        ('QA_ENGINEER','QA_LEAD','SECURITY_ANALYST','CHIEF_MANAGER_QA','AGM_QA')
      JOIN qap_users app_user ON app_user.id=user_role.user_id AND app_user.is_active=1
      WHERE workspace.workspace_key='COE-QA'
        AND (app_user.department='COE - Quality Assurance' OR EXISTS
          (SELECT 1 FROM qap_user_departments user_dept WHERE user_dept.user_id=app_user.id
           AND user_dept.department='COE - Quality Assurance'))
    """)
    op.execute("""
      INSERT INTO qap_qa_workspace_coverage (workspace_id,department_id,priority,is_active,created_at)
      SELECT workspace.id,department.id,100,1,SYSTIMESTAMP
      FROM qap_qa_workspaces workspace JOIN qap_departments department
        ON department.name='COE - Quality Assurance'
      WHERE workspace.workspace_key='COE-QA'
    """)
    op.execute("""UPDATE qap_requests SET qa_workspace_id=(SELECT id FROM qap_qa_workspaces
      WHERE workspace_key='COE-QA'), workspace_routing_status='MIGRATED' WHERE qa_workspace_id IS NULL""")
    op.execute("""UPDATE qap_test_projects SET qa_workspace_id=(SELECT id FROM qap_qa_workspaces
      WHERE workspace_key='COE-QA') WHERE qa_workspace_id IS NULL""")


def downgrade() -> None:
    op.drop_index("ix_qap_proj_qaws", table_name="qap_test_projects")
    op.drop_constraint("fk_qap_proj_qaws", "qap_test_projects", type_="foreignkey")
    op.drop_column("qap_test_projects", "qa_workspace_id")
    op.drop_index("ix_qap_req_qaws", table_name="qap_requests")
    op.drop_constraint("fk_qap_req_qaws", "qap_requests", type_="foreignkey")
    op.drop_column("qap_requests", "workspace_routing_status")
    op.drop_column("qap_requests", "qa_workspace_id")
    op.drop_constraint("fk_qap_user_pref_qaws", "qap_users", type_="foreignkey")
    op.drop_column("qap_users", "preferred_qa_workspace_id")
    op.drop_table("qap_qa_workspace_coverage")
    op.drop_table("qap_qa_workspace_members")
    op.drop_table("qap_qa_workspaces")
