"""Retain stable application identities in application-name approval history."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column, ensure_foreign_key, ensure_index

revision = "f4a1c9d8e730"
down_revision = "c1f7a9b4d203"
branch_labels = None
depends_on = None


def upgrade():
    ensure_column("qap_approval_actions", sa.Column("application_master_id", sa.Integer(), nullable=True))
    ensure_foreign_key("fk_qap_appract_application", "qap_approval_actions", "qap_application_master",
                       ["application_master_id"], ["id"])
    ensure_index("ix_qap_appract_application", "qap_approval_actions", ["application_master_id"])


def downgrade():
    # Keep immutable approval-history identities if application code is rolled back.
    pass
