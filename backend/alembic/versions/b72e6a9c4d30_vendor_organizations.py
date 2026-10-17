"""Vendor identity metadata; Standard accounts and business records untouched."""
import sqlalchemy as sa
from app.migration_helpers import ensure_table, ensure_column, ensure_foreign_key

revision = 'b72e6a9c4d30'
down_revision = 'a41d9e7c2b60'
branch_labels = None
depends_on = None


def upgrade():
    metadata = sa.MetaData()
    sa.Table('qap_users', metadata, sa.Column('id', sa.Integer(), primary_key=True))
    table = sa.Table('qap_vendor_organizations', metadata,
        sa.Column('id', sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column('name', sa.String(150), nullable=False),
        sa.Column('normalized_name', sa.String(300), nullable=False, unique=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('1')),
        sa.Column('revision', sa.Integer(), nullable=False, server_default=sa.text('1')),
        sa.Column('created_by_id', sa.Integer(), sa.ForeignKey('qap_users.id')),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False))
    ensure_table(table)
    ensure_column('qap_users', sa.Column('vendor_organization_id', sa.Integer(), nullable=True))
    ensure_column('qap_users', sa.Column('vendor_profile_exempt', sa.Boolean(), nullable=False, server_default=sa.text('0')))
    ensure_foreign_key('fk_qap_user_vendor_org', 'qap_users', table.name, ['vendor_organization_id'], ['id'])


def downgrade():
    # Keep organization assignments and their audit trail on application rollback.
    pass
