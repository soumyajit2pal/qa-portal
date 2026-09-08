"""Remove Assigned as a current defect lifecycle stage.

Revision ID: 6d2e8a4c1f90
Revises: 3a9c7e5d1b42
"""

from alembic import op


revision = "6d2e8a4c1f90"
down_revision = "3a9c7e5d1b42"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Assignment is now captured during Triage. Existing rows at the old
    # ownership-only stage continue from active investigation.
    op.execute("UPDATE qap_defects SET status = 'In Progress' WHERE status = 'Assigned'")


def downgrade() -> None:
    # The normalization cannot be reversed safely because pre-existing and
    # subsequently-created In Progress records are indistinguishable.
    pass
