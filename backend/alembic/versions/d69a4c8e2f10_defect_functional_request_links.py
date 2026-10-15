"""Audited direct Functional Request traceability, preserving existing links."""
import sqlalchemy as sa
from app.migration_helpers import ensure_table, ensure_index

revision = 'd69a4c8e2f10'
down_revision = 'c58f3b7a2d91'
branch_labels = None
depends_on = None


def upgrade():
    metadata = sa.MetaData()
    for name in ('qap_defects', 'qap_functional_requests', 'qap_users'):
        sa.Table(name, metadata, sa.Column('id', sa.Integer(), primary_key=True))
    table = sa.Table('qap_defect_func_links', metadata,
        sa.Column('defect_id', sa.Integer(), sa.ForeignKey('qap_defects.id', name='fk_qap_def_func_def'), primary_key=True),
        sa.Column('functional_request_id', sa.Integer(), sa.ForeignKey('qap_functional_requests.id', name='fk_qap_def_func_req'), primary_key=True),
        sa.Column('linked_by_id', sa.Integer(), sa.ForeignKey('qap_users.id', name='fk_qap_def_func_user'), nullable=False),
        sa.Column('linked_at', sa.DateTime(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('linked_workflow_revision', sa.Integer(), nullable=False),
    )
    ensure_table(table)
    ensure_index('ix_qap_def_func_req', table.name, ['functional_request_id'])


def downgrade():
    # Keep audited traceability when rolling application code back.
    pass
