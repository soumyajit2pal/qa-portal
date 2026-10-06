"""One-time email confirmation for newly created LDAP accounts."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column

revision = "f6a2d9c4b801"
down_revision = "e3b8c5d1a902"
branch_labels = None
depends_on = None


def upgrade():
    # Keep existing accounts unchanged; the provisioning paths opt new LDAP
    # accounts in explicitly, including those with a directory mail attribute.
    ensure_column("qap_users", sa.Column("needs_email_confirmation", sa.Boolean(),
                                        nullable=False, server_default=sa.text("0")))


def downgrade():
    # Retain confirmation history for safe rollback/re-upgrade.
    pass
