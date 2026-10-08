"""Add workspace-selected defect CC followers without modifying existing defects."""
from alembic import context, op
import sqlalchemy as sa

revision = 'c1f7a9b4d203'
down_revision = 'b9e5d7f3a102'
branch_labels = None
depends_on = None


def upgrade():
    existing = not context.is_offline_mode() and sa.inspect(op.get_bind()).has_table('qap_defect_cc_users')
    if not existing:
        op.create_table(
            'qap_defect_cc_users',
            sa.Column('defect_id', sa.Integer(), sa.ForeignKey('qap_defects.id', ondelete='CASCADE'), primary_key=True),
            sa.Column('user_id', sa.Integer(), sa.ForeignKey('qap_users.id'), primary_key=True),
            sa.Column('added_by_id', sa.Integer(), sa.ForeignKey('qap_users.id'), nullable=True),
            sa.Column('added_at', sa.DateTime(), nullable=False),
        )
    indexes = sa.inspect(op.get_bind()).get_indexes('qap_defect_cc_users') if existing else []
    if not any(index['name'].lower() == 'ix_qap_defect_cc_users_user_id' for index in indexes):
        op.create_index('ix_qap_defect_cc_users_user_id', 'qap_defect_cc_users', ['user_id'])


def downgrade():
    raise RuntimeError('Defect CC records are retained audit evidence; preserve them during rollback')
