"""Retest observations and per-defect evidence, separate from final approval."""
import sqlalchemy as sa
from app.migration_helpers import ensure_table, ensure_index

revision = 'e7a91c4d8b20'
down_revision = 'd69a4c8e2f10'
branch_labels = None
depends_on = None


def upgrade():
    meta = sa.MetaData()
    for name in ('qap_test_execution_runs','qap_test_case_versions','qap_defects','qap_test_run_defects'):
        sa.Table(name,meta,sa.Column('id',sa.Integer(),primary_key=True))
    retests=sa.Table('qap_test_retests',meta,
        sa.Column('run_id',sa.Integer(),sa.ForeignKey('qap_test_execution_runs.id'),primary_key=True),
        sa.Column('observed_result',sa.String(20),nullable=False),
        sa.Column('environment',sa.String(40),nullable=False),
        sa.Column('tested_build',sa.String(150),nullable=False),
        sa.Column('pinned_version_id',sa.Integer(),sa.ForeignKey('qap_test_case_versions.id'),nullable=False),
        sa.Column('final_run_id',sa.Integer(),sa.ForeignKey('qap_test_execution_runs.id'),nullable=True,unique=True))
    ensure_table(retests)
    outcomes=sa.Table('qap_retest_outcomes',meta,
        sa.Column('id',sa.Integer(),sa.Identity(),primary_key=True),
        sa.Column('run_id',sa.Integer(),sa.ForeignKey('qap_test_retests.run_id'),nullable=False),
        sa.Column('defect_id',sa.Integer(),sa.ForeignKey('qap_defects.id'),nullable=True),
        sa.Column('external_link_id',sa.Integer(),sa.ForeignKey('qap_test_run_defects.id'),nullable=True),
        sa.Column('defect_key',sa.String(100),nullable=False),
        sa.Column('defect_status',sa.String(40)),
        sa.Column('outcome',sa.String(20),nullable=False),sa.Column('notes',sa.Text()),
        sa.Column('evidence_reference',sa.String(2000)),sa.Column('evidence_documents_json',sa.Text()),
        sa.Column('defect_revision',sa.Integer()),sa.Column('fix_iteration',sa.Integer()),
        sa.UniqueConstraint('run_id','defect_id',name='uq_qap_retest_defect'),
        sa.UniqueConstraint('run_id','external_link_id',name='uq_qap_retest_external'),
        sa.CheckConstraint('(defect_id IS NOT NULL AND external_link_id IS NULL) OR (defect_id IS NULL AND external_link_id IS NOT NULL)',name='ck_qap_retest_one_target'))
    ensure_table(outcomes)
    ensure_index('ix_qap_retest_outcomes_run_id',outcomes.name,['run_id'])


def downgrade():
    # Observed results and evidence remain available after an application rollback.
    pass
