"""add defect execution links (additional, non-destructive links)

Revision ID: c4e8a1f6d2b7
Revises: 9b1f4d7c2a63
Create Date: 2026-08-19

Reported directly: the "Link existing defect" picker (TestExecution.tsx)
only ever offered defects with no primary execution yet (queue=unlinked),
because routers/defects.py's link-execution endpoint rejected linking a
defect that already had a DIFFERENT primary execution ("This defect is
already linked to another primary execution"). Request: "instead of [only
unlinked], show linked defect as well" -- so the SAME already-governed
defect can be traced to a second Failed/Blocked execution too (e.g. the
same underlying bug also failed a different test case), without moving or
overwriting its original primary link.

Adds qap_defect_execution_links, mirroring the existing
qap_defect_case_links (DefectTestCaseLink) "primary field + separate
many-to-many table for extra links" pattern exactly -- Defect.execution_id/
cycle_id/primary_test_case_id remain the one primary link (unchanged
workflow/assignment/closure semantics); this new table holds every
additional one. See ORACLE_MIGRATION_2026-07.md section 156.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4e8a1f6d2b7'
down_revision: Union[str, None] = '9b1f4d7c2a63'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'qap_defect_execution_links',
        sa.Column('id', sa.Integer(), sa.Identity(always=False, start=1, increment=1), nullable=False),
        sa.Column('defect_id', sa.Integer(), nullable=False),
        sa.Column('execution_id', sa.Integer(), nullable=False),
        sa.Column('linked_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['defect_id'], ['qap_defects.id'], ),
        sa.ForeignKeyConstraint(['execution_id'], ['qap_test_executions.id'], ),
        sa.ForeignKeyConstraint(['linked_by_id'], ['qap_users.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('defect_id', 'execution_id', name='uq_qap_def_exec'),
    )
    op.create_index(op.f('ix_qap_defect_execution_links_defect_id'), 'qap_defect_execution_links', ['defect_id'], unique=False)
    op.create_index(op.f('ix_qap_defect_execution_links_execution_id'), 'qap_defect_execution_links', ['execution_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_qap_defect_execution_links_execution_id'), table_name='qap_defect_execution_links')
    op.drop_index(op.f('ix_qap_defect_execution_links_defect_id'), table_name='qap_defect_execution_links')
    op.drop_table('qap_defect_execution_links')
