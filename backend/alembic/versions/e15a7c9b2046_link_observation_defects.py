"""Retain OBS and DEF as independently governed, uniquely linked records."""
import sqlalchemy as sa
from app.migration_helpers import ensure_table

revision = 'e15a7c9b2046'
down_revision = 'd94a8c1e6f52'
branch_labels = None
depends_on = None


def upgrade():
    metadata = sa.MetaData()
    sa.Table('qap_defects', metadata, sa.Column('id', sa.Integer, primary_key=True))
    sa.Table('qap_users', metadata, sa.Column('id', sa.Integer, primary_key=True))
    ensure_table(sa.Table('qap_observation_defect_links', metadata,
        sa.Column('observation_id', sa.Integer, sa.ForeignKey('qap_defects.id', name='fk_qap_obs_link_source'), primary_key=True),
        sa.Column('defect_id', sa.Integer, sa.ForeignKey('qap_defects.id', name='fk_qap_obs_link_target'), nullable=False),
        sa.Column('created_by_id', sa.Integer, sa.ForeignKey('qap_users.id', name='fk_qap_obs_link_actor'), nullable=False),
        sa.Column('created_at', sa.DateTime, nullable=False),
        sa.Column('reason', sa.Text, nullable=False),
        sa.Column('source_snapshot_json', sa.Text, nullable=False),
        sa.UniqueConstraint('defect_id', name='uq_qap_obs_link_target')))


def downgrade():
    # Preserve the source/target identity and audit evidence on rollback.
    pass
