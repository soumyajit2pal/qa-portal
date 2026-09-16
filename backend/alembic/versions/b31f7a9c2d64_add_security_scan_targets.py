"""Store the SAST repositories or DAST URLs covered by each scan snapshot."""

from alembic import op
import sqlalchemy as sa

revision = "b31f7a9c2d64"
down_revision = "a41c0d9e2b75"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("qap_security_scan_results", sa.Column("targets_json", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("qap_security_scan_results", "targets_json")
