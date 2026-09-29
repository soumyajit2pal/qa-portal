"""Capture mitigation, owner and target date for conditional clearance."""
from alembic import op
import sqlalchemy as sa

revision = 'a6d9c2e4f801'
down_revision = 'f3c8a1d6e204'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('qap_signoffs', sa.Column('conditional_mitigation', sa.Text(), nullable=True))
    op.add_column('qap_signoffs', sa.Column('conditional_owner', sa.String(150), nullable=True))
    op.add_column('qap_signoffs', sa.Column('conditional_target_date', sa.Date(), nullable=True))


def downgrade():
    op.drop_column('qap_signoffs', 'conditional_target_date')
    op.drop_column('qap_signoffs', 'conditional_owner')
    op.drop_column('qap_signoffs', 'conditional_mitigation')
