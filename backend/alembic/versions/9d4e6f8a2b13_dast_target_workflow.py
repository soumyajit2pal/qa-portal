"""Track independent DAST target remediation and validated scan coverage."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column, ensure_foreign_key

revision = "9d4e6f8a2b13"
down_revision = "8c3d5e7f9a12"
branch_labels = None
depends_on = None


def upgrade():
    for column in (
        sa.Column("commit_id", sa.String(500), nullable=True),
        sa.Column("scan_state", sa.String(32), nullable=True),
        sa.Column("latest_scan_id", sa.Integer(), nullable=True),
        sa.Column("validation_scan_id", sa.Integer(), nullable=True),
        sa.Column("fix_submitted_at", sa.DateTime(), nullable=True),
        sa.Column("fix_submitted_by_id", sa.Integer(), nullable=True),
    ):
        ensure_column("qap_dast_targets", column)
    ensure_foreign_key("fk_qap_dast_latest_scan", "qap_dast_targets", "qap_security_scan_results", ["latest_scan_id"], ["id"])
    ensure_foreign_key("fk_qap_dast_valid_scan", "qap_dast_targets", "qap_security_scan_results", ["validation_scan_id"], ["id"])
    ensure_foreign_key("fk_qap_dast_fix_user", "qap_dast_targets", "qap_users", ["fix_submitted_by_id"], ["id"])


def downgrade():
    # Preserve immutable workflow and remediation audit evidence on rollback.
    pass
