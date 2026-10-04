"""Commit background task receipts with their business writes."""
from alembic import op
import sqlalchemy as sa

revision = "a47c2e9d6b10"
down_revision = "9d4e6f8a2b13"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "qap_background_job_receipts",
        sa.Column("job_id", sa.String(32), primary_key=True),
        sa.Column("task_type", sa.String(64), nullable=False),
        sa.Column("task_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=True),
        sa.Column("result_json", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )


def downgrade():
    op.drop_table("qap_background_job_receipts")
