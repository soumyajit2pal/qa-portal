"""Add an administrator-managed storage cap for each Document Portal workspace."""
from alembic import op
import sqlalchemy as sa

revision = 'a41c0d9e2b75'
down_revision = 'e0c217a93b64'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('qap_qa_workspaces', sa.Column(
        'document_portal_quota_bytes', sa.BigInteger(), nullable=True,
    ))


def downgrade():
    op.drop_column('qap_qa_workspaces', 'document_portal_quota_bytes')
