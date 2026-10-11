"""Add optional QA request modules and the reusable scoped module catalogue."""
from alembic import op
import sqlalchemy as sa
from app.migration_helpers import ensure_column, ensure_index, ensure_table

revision = "d7c2a9e4b610"
down_revision = "f4a1c9d8e730"
branch_labels = None
depends_on = None


def upgrade():
    ensure_column("qap_requests", sa.Column("module_name", sa.String(150), nullable=True))
    metadata = sa.MetaData()
    sa.Table("qap_qa_workspaces", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("qap_application_master", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    table = sa.Table(
        "qap_application_modules", metadata,
        sa.Column("id", sa.Integer(), sa.Identity(start=1, increment=1), primary_key=True),
        sa.Column("qa_workspace_id", sa.Integer(), sa.ForeignKey("qap_qa_workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("application_master_id", sa.Integer(), sa.ForeignKey("qap_application_master.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("qa_workspace_id", "application_master_id", "name", name="uq_qap_app_module_scope"),
    )
    ensure_table(table)
    ensure_index("ix_qap_app_modules_app_id", "qap_application_modules", ["application_master_id"])


def downgrade():
    op.drop_table("qap_application_modules")
    op.drop_column("qap_requests", "module_name")
