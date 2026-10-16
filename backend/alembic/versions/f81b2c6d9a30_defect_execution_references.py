"""Closed-defect execution references without mandatory attempt selection."""
import sqlalchemy as sa
from app.migration_helpers import ensure_table, ensure_index

revision = 'f81b2c6d9a30'
down_revision = 'e7a91c4d8b20'
branch_labels = None
depends_on = None


def upgrade():
    meta = sa.MetaData()
    for name in ('qap_defects', 'qap_test_executions', 'qap_test_execution_runs', 'qap_users'):
        sa.Table(name, meta, sa.Column('id', sa.Integer(), primary_key=True))
    table = sa.Table('qap_defect_exec_refs', meta,
        sa.Column('id', sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column('defect_id', sa.Integer(), sa.ForeignKey('qap_defects.id'), nullable=False),
        sa.Column('execution_id', sa.Integer(), sa.ForeignKey('qap_test_executions.id'), nullable=False),
        sa.Column('run_id', sa.Integer(), sa.ForeignKey('qap_test_execution_runs.id')),
        sa.Column('defect_key', sa.String(100), nullable=False),
        sa.Column('title', sa.String(255)),
        sa.Column('defect_status', sa.String(40), nullable=False),
        sa.Column('closed_at', sa.DateTime()),
        sa.Column('linked_workflow_revision', sa.Integer(), nullable=False),
        sa.Column('linked_by_id', sa.Integer(), sa.ForeignKey('qap_users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('notes', sa.Text()),
        sa.UniqueConstraint('defect_id', 'execution_id', name='uq_qap_def_exec_ref'))
    ensure_table(table)
    ensure_index('ix_qap_defect_exec_refs_defect_id', table.name, ['defect_id'])
    ensure_index('ix_qap_defect_exec_refs_execution_id', table.name, ['execution_id'])


def downgrade():
    # Preserve references and their audit provenance on application rollback.
    pass
