"""Exclude NULL testcase fingerprints from Oracle uniqueness."""
from alembic import op
import sqlalchemy as sa
revision = "d63b9f2a8e41"
down_revision = "c52a8e1f7d30"
branch_labels = None
depends_on = None

def upgrade():
    bind = op.get_bind()
    for constraint in sa.inspect(bind).get_unique_constraints("qap_test_cases"):
        if str(constraint.get("name", "")).lower() == "uq_qap_tc_project_import_fp":
            op.drop_constraint(constraint["name"], "qap_test_cases", type_="unique")
    indexes = sa.inspect(bind).get_indexes("qap_test_cases")
    if not any(str(i.get("name", "")).lower() == "uq_qap_tc_import_nonnull" for i in indexes):
        op.create_index("uq_qap_tc_import_nonnull", "qap_test_cases", [
            sa.text("CASE WHEN import_fingerprint IS NOT NULL THEN project_id END"),
            sa.text("CASE WHEN import_fingerprint IS NOT NULL THEN import_fingerprint END"),
        ], unique=True)

def downgrade():
    # Retain the compatible safe index; restoring the old constraint can reject
    # valid manual/legacy rows on Oracle.
    pass
