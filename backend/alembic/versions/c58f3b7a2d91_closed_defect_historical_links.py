"""Preserve Closed-defect references separately from active retest links."""
import sqlalchemy as sa
from alembic import op
from app.migration_helpers import ensure_column, ensure_foreign_key, ensure_index

revision = "c58f3b7a2d91"
down_revision = "b47e2a9c6d13"
branch_labels = None
depends_on = None


def upgrade():
    table = "qap_test_run_defects"
    ensure_column(table, sa.Column("is_historical", sa.Boolean(), nullable=False, server_default=sa.false()))
    ensure_column(table, sa.Column("governed_defect_id", sa.Integer(), nullable=True))
    ensure_column(table, sa.Column("linked_workflow_revision", sa.Integer(), nullable=True))
    from alembic import context
    if not context.is_offline_mode() and op.get_bind().dialect.name == "sqlite":
        if not any(key.get("name") == "fk_qap_run_hist_defect" for key in sa.inspect(op.get_bind()).get_foreign_keys(table)):
            with op.batch_alter_table(table) as batch:
                batch.create_foreign_key("fk_qap_run_hist_defect", "qap_defects", ["governed_defect_id"], ["id"])
    else:
        ensure_foreign_key("fk_qap_run_hist_defect", table, "qap_defects", ["governed_defect_id"], ["id"])
    ensure_index("ix_qap_run_governed_defect", table, ["governed_defect_id"])


def downgrade():
    # Retain historical references and their provenance on application rollback.
    pass
