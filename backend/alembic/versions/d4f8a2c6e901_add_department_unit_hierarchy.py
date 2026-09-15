"""Add hierarchical department units and unit-aware scopes.

Revision ID: d4f8a2c6e901
Revises: c1a7e5d9b204
"""

import sqlalchemy as sa
from alembic import op


revision = "d4f8a2c6e901"
down_revision = "c1a7e5d9b204"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "qap_department_units",
        sa.Column("id", sa.Integer(), sa.Identity(start=1, increment=1), nullable=False),
        sa.Column("department_id", sa.Integer(), nullable=False),
        sa.Column("parent_unit_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("SYSTIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["department_id"], ["qap_departments.id"]),
        sa.ForeignKeyConstraint(["parent_unit_id"], ["qap_department_units.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("department_id", "name", name="uq_qap_dept_unit_name"),
    )
    op.create_index("ix_qap_du_dept", "qap_department_units", ["department_id"])
    op.create_index("ix_qap_du_parent", "qap_department_units", ["parent_unit_id"])

    op.create_table(
        "qap_user_department_units",
        sa.Column("id", sa.Integer(), sa.Identity(start=1, increment=1), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("unit_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("SYSTIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["qap_users.id"]),
        sa.ForeignKeyConstraint(["unit_id"], ["qap_department_units.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "unit_id", name="uq_qap_user_dept_unit"),
    )
    op.create_index("ix_qap_udu_user", "qap_user_department_units", ["user_id"])
    op.create_index("ix_qap_udu_unit", "qap_user_department_units", ["unit_id"])

    op.add_column("qap_requests", sa.Column("department_unit_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_qap_req_dept_unit", "qap_requests", "qap_department_units", ["department_unit_id"], ["id"])
    op.create_index("ix_qap_req_dept_unit", "qap_requests", ["department_unit_id"])
    op.add_column("qap_test_projects", sa.Column("department_unit_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_qap_proj_dept_unit", "qap_test_projects", "qap_department_units", ["department_unit_id"], ["id"])
    op.create_index("ix_qap_proj_dept_unit", "qap_test_projects", ["department_unit_id"])
    op.add_column("qap_qa_workspace_coverage", sa.Column("department_unit_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_qap_qawc_dept_unit", "qap_qa_workspace_coverage", "qap_department_units", ["department_unit_id"], ["id"])
    op.create_index("ix_qap_qawc_dept_unit", "qap_qa_workspace_coverage", ["department_unit_id"])
    op.add_column("qap_department_coordinators", sa.Column("department_unit_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_qap_dc_dept_unit", "qap_department_coordinators", "qap_department_units", ["department_unit_id"], ["id"])
    op.create_index("ix_qap_dc_dept_unit", "qap_department_coordinators", ["department_unit_id"])
    op.drop_constraint("uq_qap_dept_coord_scope", "qap_department_coordinators", type_="unique")
    op.create_unique_constraint(
        "uq_qap_dept_coord_scope", "qap_department_coordinators",
        ["user_id", "department_id", "workspace_id", "department_unit_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_qap_dept_coord_scope", "qap_department_coordinators", type_="unique")
    op.create_unique_constraint(
        "uq_qap_dept_coord_scope", "qap_department_coordinators",
        ["user_id", "department_id", "workspace_id"],
    )
    op.drop_index("ix_qap_dc_dept_unit", table_name="qap_department_coordinators")
    op.drop_constraint("fk_qap_dc_dept_unit", "qap_department_coordinators", type_="foreignkey")
    op.drop_column("qap_department_coordinators", "department_unit_id")
    op.drop_index("ix_qap_qawc_dept_unit", table_name="qap_qa_workspace_coverage")
    op.drop_constraint("fk_qap_qawc_dept_unit", "qap_qa_workspace_coverage", type_="foreignkey")
    op.drop_column("qap_qa_workspace_coverage", "department_unit_id")
    op.drop_index("ix_qap_proj_dept_unit", table_name="qap_test_projects")
    op.drop_constraint("fk_qap_proj_dept_unit", "qap_test_projects", type_="foreignkey")
    op.drop_column("qap_test_projects", "department_unit_id")
    op.drop_index("ix_qap_req_dept_unit", table_name="qap_requests")
    op.drop_constraint("fk_qap_req_dept_unit", "qap_requests", type_="foreignkey")
    op.drop_column("qap_requests", "department_unit_id")
    op.drop_index("ix_qap_udu_unit", table_name="qap_user_department_units")
    op.drop_index("ix_qap_udu_user", table_name="qap_user_department_units")
    op.drop_table("qap_user_department_units")
    op.drop_index("ix_qap_du_parent", table_name="qap_department_units")
    op.drop_index("ix_qap_du_dept", table_name="qap_department_units")
    op.drop_table("qap_department_units")
