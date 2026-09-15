"""Record the creating workspace for shared project content."""
from alembic import op
import sqlalchemy as sa
revision = 'e0c217a93b64'
down_revision = 'd8b104f2e735'
branch_labels = None
depends_on = None
TABLES = ('qap_test_cases', 'qap_test_cycles', 'qap_test_folders', 'qap_test_cycle_folders')
def upgrade():
    for table in TABLES:
        op.add_column(table, sa.Column('origin_workspace_id', sa.Integer(), nullable=True))
        op.execute(sa.text(f'UPDATE {table} SET origin_workspace_id = (SELECT qa_workspace_id FROM qap_test_projects WHERE qap_test_projects.id = {table}.project_id)'))
        op.create_foreign_key(f'fk_{table}_origin_ws', table, 'qap_qa_workspaces', ['origin_workspace_id'], ['id'])
        op.create_index(f'ix_{table}_origin_ws', table, ['origin_workspace_id'])
def downgrade():
    for table in reversed(TABLES):
        op.drop_index(f'ix_{table}_origin_ws', table_name=table)
        op.drop_constraint(f'fk_{table}_origin_ws', table, type_='foreignkey')
        op.drop_column(table, 'origin_workspace_id')
