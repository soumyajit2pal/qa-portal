"""Allow reviewed repository additions without replacing existing identities."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column

revision = "b47e2a9c6d13"
down_revision = "a31d8e6c2f90"
branch_labels = None
depends_on = None


def upgrade():
    ensure_column("qap_security_obstacles", sa.Column("allow_scope_additions", sa.Boolean(), nullable=False, server_default=sa.false()))
    ensure_column("qap_security_obstacles", sa.Column("added_target_ids_json", sa.Text(), nullable=True))


def downgrade():
    # Keep permissions and repository provenance with their audit records.
    pass
