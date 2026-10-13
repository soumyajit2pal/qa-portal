"""Keep an application module snapshot on each defect."""
from alembic import op
import sqlalchemy as sa
from app.migration_helpers import ensure_column

revision = "e8b3d7c2a610"
down_revision = "d7c2a9e4b610"
branch_labels = None
depends_on = None


def upgrade():
    ensure_column("qap_defects", sa.Column("module_name", sa.String(150), nullable=True))
    # Only a linked request is an authoritative source for historical rows.
    # Never reinterpret the defect's free-text module_feature as its module.
    op.execute(sa.text("""
        UPDATE qap_defects SET module_name = (
            SELECT r.module_name FROM qap_requests r
            WHERE r.id = qap_defects.qa_request_id
              AND UPPER(r.application_name) = UPPER(qap_defects.application_name)
              AND (qap_defects.qa_workspace_id IS NULL
                   OR r.qa_workspace_id = qap_defects.qa_workspace_id)
        )
        WHERE module_name IS NULL AND EXISTS (
            SELECT 1 FROM qap_requests r
            WHERE r.id = qap_defects.qa_request_id AND r.module_name IS NOT NULL
              AND UPPER(r.application_name) = UPPER(qap_defects.application_name)
              AND (qap_defects.qa_workspace_id IS NULL
                   OR r.qa_workspace_id = qap_defects.qa_workspace_id)
        )
    """))


def downgrade():
    op.drop_column("qap_defects", "module_name")
