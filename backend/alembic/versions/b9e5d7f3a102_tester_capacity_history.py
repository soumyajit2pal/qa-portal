"""Record transactional tester load history and establish an honest baseline."""
from alembic import context, op
import sqlalchemy as sa

revision = 'b9e5d7f3a102'
down_revision = 'a8d4c6e2f901'
branch_labels = None
depends_on = None


def upgrade():
    offline = context.is_offline_mode()
    existing = not offline and sa.inspect(op.get_bind()).has_table('qap_tester_capacity_events')
    if not existing:
        op.create_table(
            'qap_tester_capacity_events',
            sa.Column('id', sa.Integer(), sa.Identity(start=1, increment=1), primary_key=True),
            sa.Column('tracking_key', sa.String(32), unique=True, nullable=True),
            sa.Column('entity_type', sa.String(32), nullable=False),
            sa.Column('entity_id', sa.Integer(), nullable=False),
            sa.Column('qa_request_id', sa.Integer(), nullable=True),
            sa.Column('status', sa.String(40), nullable=True),
            sa.Column('assignee_ids', sa.String(1000), nullable=True),
            sa.Column('load_points', sa.Float(), nullable=False),
            sa.Column('capacity_points', sa.Float(), nullable=False),
            sa.Column('observed_at', sa.DateTime(), nullable=False),
        )
    indexes = sa.inspect(op.get_bind()).get_indexes('qap_tester_capacity_events') if existing else []
    for name, columns in [
        ('ix_qap_capacity_scope_time', ['qa_request_id', 'observed_at']),
        ('ix_qap_capacity_entity_time', ['entity_type', 'entity_id', 'observed_at', 'id']),
    ]:
        if not any(index['name'].lower() == name for index in indexes):
            op.create_index(name, 'qap_tester_capacity_events', columns)
    from app.tester_capacity_history import seed_tracking
    seed_tracking(op.get_bind(), check_existing=not offline)


def downgrade():
    raise RuntimeError('Tester workload history is retained reporting evidence; preserve it during rollback')
