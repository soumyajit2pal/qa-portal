"""Persist revisioned certificate evidence snapshots."""
from alembic import op
import sqlalchemy as sa
revision = 'c7a93e2b1048'
down_revision = 'b9e4f6012a38'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('qap_signoffs', sa.Column('certificate_data_json', sa.Text(), nullable=True))

def downgrade():
    op.drop_column('qap_signoffs', 'certificate_data_json')
