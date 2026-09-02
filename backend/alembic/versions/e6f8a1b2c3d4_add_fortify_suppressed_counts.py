"""add Fortify suppressed finding severity counts

Revision ID: e6f8a1b2c3d4
Revises: c7d9e2f4a6b8
Create Date: 2026-09-01

Each immutable SSC scan snapshot now records the suppressed-only Critical,
High, Medium, Low, and total counts returned for its primary Security Auditor
View. Existing snapshots are backfilled with zero because those imports did
not retrieve suppressed issues.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e6f8a1b2c3d4"
down_revision: Union[str, Sequence[str], None] = "c7d9e2f4a6b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS = (
    "suppressed_critical_count",
    "suppressed_high_count",
    "suppressed_medium_count",
    "suppressed_low_count",
    "suppressed_total_count",
)


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column(
            "qap_security_scan_results",
            sa.Column(name, sa.Integer(), nullable=False, server_default=sa.text("0")),
        )
        op.alter_column("qap_security_scan_results", name, server_default=None)


def downgrade() -> None:
    for name in reversed(_COLUMNS):
        op.drop_column("qap_security_scan_results", name)
