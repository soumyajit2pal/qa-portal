"""Add updated Bank certificate remarks and optional manual observations."""
from alembic import op
import sqlalchemy as sa
revision = 'd8b104f2e735'
down_revision = 'c7a93e2b1048'
branch_labels = None
depends_on = None
FIELDS = ('known_limitations', 'business_acceptance_status', 'security_testing_status', 'deployment_recommendation', 'conditional_observations')
def upgrade():
    for name in FIELDS:
        op.add_column('qap_signoffs', sa.Column(name, sa.Text(), nullable=True))
def downgrade():
    for name in reversed(FIELDS):
        op.drop_column('qap_signoffs', name)
