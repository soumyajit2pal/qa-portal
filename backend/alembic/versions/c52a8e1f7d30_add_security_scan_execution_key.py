"""Group independent target results created by one scan execution."""

from alembic import op
import sqlalchemy as sa

revision = "c52a8e1f7d30"
down_revision = "b31f7a9c2d64"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "qap_security_scan_results",
        sa.Column("execution_key", sa.String(length=36), nullable=True),
    )
    op.create_index(
        "ix_scan_result_execution",
        "qap_security_scan_results",
        ["execution_key"],
    )


def downgrade():
    op.drop_index("ix_scan_result_execution", table_name="qap_security_scan_results")
    op.drop_column("qap_security_scan_results", "execution_key")
