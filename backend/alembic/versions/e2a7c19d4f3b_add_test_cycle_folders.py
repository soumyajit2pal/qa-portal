"""add test cycle folders + access grants

Revision ID: e2a7c19d4f3b
Revises: 4cfa97fbdd97
Create Date: 2026-08-18

Reported directly: "Create Test Cycle Folder, in which I can give access
department based or user level, same behaviour like project has. Under this
folder create test cycle." Adds a flat (non-nested) organizational folder
for a Project's Test Cycles (qap_test_cycle_folders), an optional
department-or-user access RESTRICTION on a folder (qap_test_cycle_folder_access
-- deliberately the opposite of qap_test_project_view_grants, which only
ever widens visibility, never restricts it -- see models.TestCycleFolder's
own docstring), and a nullable folder_id on qap_test_cycles (a cycle with no
folder is "Unfiled", same convention as TestCase.folder_id in the Test
Repository). See ORACLE_MIGRATION_2026-07.md section 147 for the full design
decision.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e2a7c19d4f3b'
down_revision: Union[str, None] = '4cfa97fbdd97'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'qap_test_cycle_folders',
        sa.Column('id', sa.Integer(), sa.Identity(always=False, start=1, increment=1), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['created_by_id'], ['qap_users.id'], ),
        sa.ForeignKeyConstraint(['project_id'], ['qap_test_projects.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_qap_test_cycle_folders_project_id'), 'qap_test_cycle_folders', ['project_id'], unique=False)

    op.create_table(
        'qap_test_cycle_folder_access',
        sa.Column('id', sa.Integer(), sa.Identity(always=False, start=1, increment=1), nullable=False),
        sa.Column('folder_id', sa.Integer(), nullable=False),
        sa.Column('department', sa.String(length=150), nullable=True),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('granted_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['folder_id'], ['qap_test_cycle_folders.id'], ),
        sa.ForeignKeyConstraint(['granted_by_id'], ['qap_users.id'], ),
        sa.ForeignKeyConstraint(['user_id'], ['qap_users.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('folder_id', 'department', name='uq_qap_tcfa_folder_department'),
        sa.UniqueConstraint('folder_id', 'user_id', name='uq_qap_tcfa_folder_user'),
    )
    op.create_index(op.f('ix_qap_test_cycle_folder_access_folder_id'), 'qap_test_cycle_folder_access', ['folder_id'], unique=False)
    op.create_index(op.f('ix_qap_test_cycle_folder_access_user_id'), 'qap_test_cycle_folder_access', ['user_id'], unique=False)

    op.add_column('qap_test_cycles', sa.Column('folder_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_qap_test_cycles_folder_id'), 'qap_test_cycles', ['folder_id'], unique=False)
    op.create_foreign_key(
        'fk_qap_test_cycles_folder_id', 'qap_test_cycles', 'qap_test_cycle_folders', ['folder_id'], ['id'],
    )


def downgrade() -> None:
    op.drop_constraint('fk_qap_test_cycles_folder_id', 'qap_test_cycles', type_='foreignkey')
    op.drop_index(op.f('ix_qap_test_cycles_folder_id'), table_name='qap_test_cycles')
    op.drop_column('qap_test_cycles', 'folder_id')

    op.drop_index(op.f('ix_qap_test_cycle_folder_access_user_id'), table_name='qap_test_cycle_folder_access')
    op.drop_index(op.f('ix_qap_test_cycle_folder_access_folder_id'), table_name='qap_test_cycle_folder_access')
    op.drop_table('qap_test_cycle_folder_access')

    op.drop_index(op.f('ix_qap_test_cycle_folders_project_id'), table_name='qap_test_cycle_folders')
    op.drop_table('qap_test_cycle_folders')
