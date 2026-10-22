"""Observations have their own classification, number and disposition."""
import sqlalchemy as sa
from app.migration_helpers import ensure_column, ensure_index

revision = 'd94a8c1e6f52'
down_revision = 'c83f7b0d5e41'
branch_labels = None
depends_on = None


def upgrade():
    table = 'qap_defects'
    ensure_column(table, sa.Column('record_type', sa.String(20), nullable=False, server_default='Defect'))
    ensure_column(table, sa.Column('observation_key', sa.String(40), nullable=True))
    ensure_column(table, sa.Column('observation_category', sa.String(60), nullable=True))
    ensure_column(table, sa.Column('observation_outcome', sa.String(60), nullable=True))
    ensure_column(table, sa.Column('observation_converted_at', sa.DateTime(), nullable=True))
    ensure_index('ix_qap_defects_record_type', table, ['record_type'])
    ensure_index('ix_qap_defects_observation_key', table, ['observation_key'], unique=True)


def downgrade():
    # Retain observation identifiers and classification on application rollback.
    pass
