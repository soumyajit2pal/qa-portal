"""Durable, workspace-scoped admin recovery plans and receipts."""
import sqlalchemy as sa
from app.migration_helpers import ensure_table, ensure_index

revision = 'a41d9e7c2b60'
down_revision = 'f81b2c6d9a30'
branch_labels = None
depends_on = None


def upgrade():
    meta = sa.MetaData()
    for name in ('qap_qa_workspaces', 'qap_users'):
        sa.Table(name, meta, sa.Column('id', sa.Integer(), primary_key=True))
    table = sa.Table('qap_admin_recoveries', meta,
        sa.Column('id', sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column('recovery_key', sa.String(40), nullable=False, unique=True),
        sa.Column('qa_workspace_id', sa.Integer(), sa.ForeignKey('qap_qa_workspaces.id'), nullable=False),
        sa.Column('actor_id', sa.Integer(), sa.ForeignKey('qap_users.id'), nullable=False),
        sa.Column('kind', sa.String(20), nullable=False),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('reason', sa.String(2000), nullable=False),
        sa.Column('payload_json', sa.Text(), nullable=False),
        sa.Column('preview_json', sa.Text(), nullable=False),
        sa.Column('state_hash', sa.String(64), nullable=False),
        sa.Column('after_hash', sa.String(64)),
        sa.Column('changes_json', sa.Text()),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('applied_at', sa.DateTime()),
        sa.Column('reversed_at', sa.DateTime()))
    ensure_table(table)
    ensure_index('ix_qap_recovery_workspace', table.name, ['qa_workspace_id'])


def downgrade():
    # Recovery records and reversal provenance survive application rollback.
    pass
