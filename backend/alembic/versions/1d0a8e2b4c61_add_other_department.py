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

    # Idempotent for environments where an Administrator may already have
    # added this department manually. `Other` is a neutral organisational
    # home for document-only accounts; actual module access remains enforced
    # exclusively by the assigned Document Portal role(s).
    op.execute("""
        MERGE INTO qap_departments target
        USING (SELECT 'Other' AS name FROM dual) source
        ON (target.name = source.name)
        WHEN NOT MATCHED THEN
          INSERT (name, is_active) VALUES (source.name, 1)
    """)


def downgrade() -> None:
    # Preserve a department once it may have real user mappings. Removing it
    # on downgrade would leave those accounts with invalid department access.
    pass
