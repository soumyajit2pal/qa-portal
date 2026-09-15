"""Optional QA request link with independent defect ownership.

Revision ID: b9e4f6012a38
Revises: a8d3e5f70912
"""
from alembic import op
import sqlalchemy as sa
revision = 'b9e4f6012a38'
down_revision = 'a8d3e5f70912'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('qap_defects', sa.Column('qa_workspace_id', sa.Integer(), nullable=True))
    op.add_column('qap_defects', sa.Column('department', sa.String(150), nullable=True))
    op.create_foreign_key('fk_defect_workspace', 'qap_defects', 'qap_qa_workspaces', ['qa_workspace_id'], ['id'])
    op.create_index('ix_qap_defects_qa_workspace_id', 'qap_defects', ['qa_workspace_id'])
    op.create_index('ix_qap_defects_department', 'qap_defects', ['department'])
    op.execute('''UPDATE qap_defects d SET (qa_workspace_id, department) =
        (SELECT r.qa_workspace_id, r.department FROM qap_requests r WHERE r.id = d.qa_request_id)
        WHERE d.qa_request_id IS NOT NULL''')
    op.alter_column('qap_defects', 'qa_request_id', existing_type=sa.Integer(), nullable=True)


def downgrade():
    raise RuntimeError('Link standalone defects and preserve ownership before downgrading this migration.')
