"""Persist single-use login challenges across workers and restarts."""
from alembic import op
import sqlalchemy as sa

revision = 'b72d91a0c483'
down_revision = '1745115668f0'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('qap_used_login_challenges',
                    sa.Column('jti', sa.String(64), primary_key=True),
                    sa.Column('expires_at', sa.BigInteger(), nullable=False))
    op.create_index('ix_qap_login_challenge_exp',
                    'qap_used_login_challenges', ['expires_at'])


def downgrade():
    op.drop_table('qap_used_login_challenges')
