"""Add original approval-signature integrity seals; leave legacy evidence unsealed."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column, ensure_unique_constraint

revision = "6f2a9c8d1b40"
down_revision = "e7b1c4d9a630"
branch_labels = None
depends_on = None


def upgrade():
    ensure_column("qap_approval_actions", sa.Column("signature_id", sa.String(80), nullable=True))
    ensure_column("qap_approval_actions", sa.Column("signature_seal", sa.String(64), nullable=True))
    ensure_column("qap_approval_actions", sa.Column("signature_key_id", sa.String(16), nullable=True))
    ensure_unique_constraint("uq_qap_approval_sig_id", "qap_approval_actions", ["signature_id"])


def downgrade():
    # Preserve audit integrity evidence on rollback.
    pass
