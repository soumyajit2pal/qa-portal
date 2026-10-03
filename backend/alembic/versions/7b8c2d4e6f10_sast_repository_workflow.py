"""Track independent repository remediation and validated scan coverage."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column, ensure_foreign_key

revision = "7b8c2d4e6f10"
down_revision = "6f2a9c8d1b40"
branch_labels = None
depends_on = None


def upgrade():
    for column in (
        sa.Column("scan_state", sa.String(32), nullable=True),
        sa.Column("latest_scan_id", sa.Integer(), nullable=True),
        sa.Column("validation_scan_id", sa.Integer(), nullable=True),
        sa.Column("fix_submitted_at", sa.DateTime(), nullable=True),
        sa.Column("fix_submitted_by_id", sa.Integer(), nullable=True),
    ):
        ensure_column("qap_sast_components", column)
    ensure_foreign_key("fk_qap_sast_latest_scan", "qap_sast_components", "qap_security_scan_results", ["latest_scan_id"], ["id"])
    ensure_foreign_key("fk_qap_sast_valid_scan", "qap_sast_components", "qap_security_scan_results", ["validation_scan_id"], ["id"])
    ensure_foreign_key("fk_qap_sast_fix_user", "qap_sast_components", "qap_users", ["fix_submitted_by_id"], ["id"])


def downgrade():
    # Keep repository coverage/validation audit evidence on rollback.
    pass
