"""finalise document-only access baseline

Revision ID: 1d0a8e2b4c61
Revises: f4a7c2d9e8b1
Create Date: 2026-08-28
"""

from alembic import op


revision = "1d0a8e2b4c61"
down_revision = "f4a7c2d9e8b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The temporary Department QA capability is retired.  Remove any old
    # assignment while preserving all request and audit history.  The
    # intervening Bank/TCS provider-routing revisions were deliberately
    # squashed out: none of their tables or columns exist in the final schema.
    op.execute("DELETE FROM qap_user_roles WHERE role = 'DEPARTMENT_QA'")

    # Compatibility backfill for populated installations only. On an empty
    # schema, seed.py owns organisation data and creates this department.
    # Idempotent where an Administrator already added it manually.
    op.execute("""
        MERGE INTO qap_departments target
        USING (
          SELECT 'Other' AS name FROM dual
          WHERE EXISTS (SELECT 1 FROM qap_users)
        ) source
        ON (target.name = source.name)
        WHEN NOT MATCHED THEN
          INSERT (name, is_active) VALUES (source.name, 1)
    """)


def downgrade() -> None:
    # Preserve a department once it may have real user mappings. Removing it
    # on downgrade would leave those accounts with invalid department access.
    pass
