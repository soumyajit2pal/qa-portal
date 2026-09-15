"""Versioned workspace defect workflows; preserve legacy defects.

Revision ID: a8d3e5f70912
Revises: 2a7c9e4f1b60
"""
from alembic import op
import sqlalchemy as sa
revision = 'a8d3e5f70912'
down_revision = '2a7c9e4f1b60'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('qap_qa_workspaces', sa.Column('defect_workflow_json', sa.Text(), nullable=True))
    op.add_column('qap_qa_workspaces', sa.Column('defect_workflow_history_json', sa.Text(), nullable=True))
    op.add_column('qap_defects', sa.Column('workflow_json', sa.Text(), nullable=True))
    op.add_column('qap_defects', sa.Column('workflow_state_json', sa.Text(), nullable=True))
    op.add_column('qap_defects', sa.Column('workflow_revision', sa.Integer(), server_default='0', nullable=False))
    op.alter_column('qap_defects', 'status', existing_type=sa.String(20), type_=sa.String(40))


def downgrade():
    # Preserve modern lifecycle data: rollback requires an explicit data migration.
    raise RuntimeError('Export and migrate modern defects before removing workflow storage.')
