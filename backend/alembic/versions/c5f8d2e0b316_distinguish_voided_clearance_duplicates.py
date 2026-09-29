"""Distinguish unissued legacy duplicates from signed superseded certificates.

Revision ID: c5f8d2e0b316
Revises: b4e7c1d9a205
"""

from alembic import op
import sqlalchemy as sa


revision = "c5f8d2e0b316"
down_revision = "b4e7c1d9a205"
branch_labels = None
depends_on = None


_LEGACY_REASON = "Legacy parallel certificate retired by one-active-certificate migration"


def upgrade():
    # b4 originally used SUPERSEDED for the preserved legacy orphan during
    # its first local application. Only issued predecessors may use that
    # status; the reason marker makes this correction exact and restart-safe.
    op.execute(
        sa.text("""
            UPDATE qap_signoffs
            SET status = 'VOIDED'
            WHERE status = 'SUPERSEDED'
              AND DBMS_LOB.SUBSTR(revision_reason, 4000, 1) = :reason
              AND approved_by_id IS NULL
        """).bindparams(reason=_LEGACY_REASON)
    )


def downgrade():
    op.execute(
        sa.text("""
            UPDATE qap_signoffs
            SET status = 'SUPERSEDED'
            WHERE status = 'VOIDED'
              AND DBMS_LOB.SUBSTR(revision_reason, 4000, 1) = :reason
        """).bindparams(reason=_LEGACY_REASON)
    )
