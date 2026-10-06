"""Capture the business defect reference on Bug Fix QA requests."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column

revision = "e3b8c5d1a902"
down_revision = "a47c2e9d6b10"
branch_labels = None
depends_on = None


def upgrade():
    ensure_column("qap_requests", sa.Column("business_defect_number", sa.String(64), nullable=True))


def downgrade():
    # Preserve business defect references when rolling back application code.
    pass
