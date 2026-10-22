"""Allow nested Test Cycle folders; existing folders remain top level."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column, ensure_foreign_key, ensure_index

revision = 'c83f7b0d5e41'
down_revision = 'b72e6a9c4d30'
branch_labels = None
depends_on = None


def upgrade():
    table = 'qap_test_cycle_folders'
    ensure_column(table, sa.Column('parent_id', sa.Integer(), nullable=True))
    ensure_foreign_key('fk_qap_cycle_folder_parent', table, table, ['parent_id'], ['id'])
    ensure_index('ix_qap_test_cycle_folders_parent_id', table, ['parent_id'])


def downgrade():
    # Retain the folder hierarchy on application rollback rather than
    # silently flattening existing organizational data.
    pass
