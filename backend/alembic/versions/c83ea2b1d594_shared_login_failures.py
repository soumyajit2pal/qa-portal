"""Share failed-login counters and administrator unlocks across workers."""
from alembic import op
import sqlalchemy as sa

revision = 'c83ea2b1d594'
down_revision = 'b72d91a0c483'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('qap_login_failures',
        sa.Column('id', sa.String(32), primary_key=True),
        sa.Column('username', sa.String(256), nullable=False),
        sa.Column('host', sa.String(255), nullable=False),
        sa.Column('attempted_at', sa.Float(), nullable=False))
    op.create_index('ix_qap_login_failure_lookup', 'qap_login_failures', ['username', 'host', 'attempted_at'])
    op.create_index('ix_qap_login_failure_time', 'qap_login_failures', ['attempted_at'])


def downgrade():
    op.drop_table('qap_login_failures')
