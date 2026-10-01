"""Add immutable Test Cycle re-execution lineage.

Revision ID: e7b1c4d9a630
Revises: d6a9e3f1c427
"""

from alembic import context, op
import sqlalchemy as sa


revision = "e7b1c4d9a630"
down_revision = "d6a9e3f1c427"
branch_labels = None
depends_on = None


_SIGNOFF_INDEX = "uq_qap_signoff_active_req"
_NEW_ACTIVE_STATUS_SQL = (
    "'DRAFT','SUBMITTED','SM_APPROVAL_PENDING','RETURNED_BY_SM',"
    "'DEPT_HEAD_QA_APPROVAL_PENDING','RETURNED_BY_DEPT_HEAD_COE',"
    "'RETURNED_BY_REQUESTER','ISSUED_UNDER_REVIEW'"
)
_OLD_ACTIVE_STATUS_SQL = (
    "'DRAFT','SUBMITTED','SM_APPROVAL_PENDING','RETURNED_BY_SM',"
    "'DEPT_HEAD_QA_APPROVAL_PENDING','RETURNED_BY_DEPT_HEAD_COE','RETURNED_BY_REQUESTER'"
)

_DRAFT_BUCKET_REPAIR_SQL = """
    UPDATE qap_functional_requests
    SET status = 'QA_COMPLETED'
    WHERE qap_functional_requests.status = 'QA_SIGNOFF_PENDING'
      AND EXISTS (
          SELECT 1
          FROM qap_signoffs certificate
          WHERE certificate.id = qap_functional_requests.signoff_id
            AND certificate.testing_request_id = qap_functional_requests.request_id
            AND certificate.status IN (
                'DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPT_HEAD_COE',
                'RETURNED_BY_REQUESTER', 'SM_REJECTED',
                'DEPT_HEAD_COE_REJECTED'
            )
      )
"""

_ISSUED_BUCKET_REPAIR_SQL = """
    UPDATE qap_functional_requests
    SET status = 'REQUESTER_VERIFICATION'
    WHERE qap_functional_requests.status IN (
        'QA_SIGNOFF_PENDING', 'QA_SIGNED_OFF'
    )
      AND EXISTS (
          SELECT 1
          FROM qap_signoffs certificate
          WHERE certificate.id = qap_functional_requests.signoff_id
            AND certificate.testing_request_id = qap_functional_requests.request_id
            AND certificate.status = 'ISSUED'
      )
"""

_HELD_BUCKET_REPAIR_SQL = """
    UPDATE qap_functional_requests
    SET status = 'QA_CHANGE_REVIEW'
    WHERE qap_functional_requests.status IN (
        'QA_SIGNOFF_PENDING', 'QA_SIGNED_OFF', 'REQUESTER_VERIFICATION'
    )
      AND EXISTS (
          SELECT 1
          FROM qap_signoffs certificate
          WHERE certificate.id = qap_functional_requests.signoff_id
            AND certificate.testing_request_id = qap_functional_requests.request_id
            AND certificate.status = 'ISSUED_UNDER_REVIEW'
      )
"""


def _replace_active_signoff_index(active_status_sql: str) -> None:
    # Oracle DDL auto-commits. The existence check makes an interrupted
    # migration restartable after the old index has already been dropped.
    if context.is_offline_mode():
        op.drop_index(_SIGNOFF_INDEX, table_name="qap_signoffs")
    else:
        indexes = {
            (item.get("name") or "").lower()
            for item in sa.inspect(op.get_bind()).get_indexes("qap_signoffs")
        }
        if _SIGNOFF_INDEX in indexes:
            op.drop_index(_SIGNOFF_INDEX, table_name="qap_signoffs")
    op.create_index(
        _SIGNOFF_INDEX,
        "qap_signoffs",
        [sa.text(
            "CASE WHEN status IN (" + active_status_sql
            + ") THEN testing_request_id END"
        )],
        unique=True,
    )


def upgrade():
    inspector = None if context.is_offline_mode() else sa.inspect(op.get_bind())
    columns = ({column["name"].lower() for column in inspector.get_columns("qap_test_cycles")}
               if inspector else set())
    if "reexecution_of_cycle_id" not in columns:
        op.add_column(
            "qap_test_cycles",
            sa.Column("reexecution_of_cycle_id", sa.Integer(), nullable=True),
        )

    foreign_keys = {
        (constraint.get("name") or "").lower()
        for constraint in inspector.get_foreign_keys("qap_test_cycles")
    } if inspector else set()
    if "fk_qap_tc_reexec_parent" not in foreign_keys:
        op.create_foreign_key(
            "fk_qap_tc_reexec_parent",
            "qap_test_cycles",
            "qap_test_cycles",
            ["reexecution_of_cycle_id"],
            ["id"],
        )

    unique_constraints = {
        (constraint.get("name") or "").lower()
        for constraint in inspector.get_unique_constraints("qap_test_cycles")
    } if inspector else set()
    if "uq_qap_tc_reexec_parent" not in unique_constraints:
        op.create_unique_constraint(
            "uq_qap_tc_reexec_parent",
            "qap_test_cycles",
            ["reexecution_of_cycle_id"],
        )

    check_constraints = {
        (constraint.get("name") or "").lower()
        for constraint in inspector.get_check_constraints("qap_test_cycles")
    } if inspector else set()
    if "ck_qap_tc_no_self_reexec" not in check_constraints:
        op.create_check_constraint(
            "ck_qap_tc_no_self_reexec",
            "qap_test_cycles",
            "reexecution_of_cycle_id IS NULL OR reexecution_of_cycle_id <> id",
        )
    # Correct existing records that were left in the QA Lead bucket even
    # though their certificate had already returned to its QA author.
    op.execute(sa.text(_DRAFT_BUCKET_REPAIR_SQL))
    # Old releases could issue a certificate but leave the Functional Request
    # in the QA Lead bucket (or the now-retired QA_SIGNED_OFF intermediate
    # stage). The current workflow sends every issued decision—including
    # Clearance Denied—to requester verification/acknowledgement.
    op.execute(sa.text(_ISSUED_BUCKET_REPAIR_SQL))
    # A held issued certificate is immutable evidence under QA review, never
    # an approval-pending Draft. This repair is deliberately conditional and
    # therefore safe to execute again after an interrupted deployment.
    op.execute(sa.text(_HELD_BUCKET_REPAIR_SQL))
    _replace_active_signoff_index(_NEW_ACTIVE_STATUS_SQL)


def downgrade():
    # A database cannot restore the old active-key definition while a held
    # row coexists with a Draft. Normalize holds back to their signed state
    # before removing the application feature and rebuilding the old index.
    # Restore the old request-side stage first so pre-feature application
    # code does not encounter an unknown QA_CHANGE_REVIEW status.
    op.execute(sa.text("""
        UPDATE qap_functional_requests
        SET status = 'REQUESTER_VERIFICATION'
        WHERE status = 'QA_CHANGE_REVIEW'
          AND EXISTS (
              SELECT 1
              FROM qap_signoffs certificate
              WHERE certificate.id = qap_functional_requests.signoff_id
                AND certificate.status = 'ISSUED_UNDER_REVIEW'
          )
    """))
    op.execute(sa.text(
        "UPDATE qap_signoffs SET status = 'ISSUED' "
        "WHERE status = 'ISSUED_UNDER_REVIEW'"
    ))
    _replace_active_signoff_index(_OLD_ACTIVE_STATUS_SQL)
    op.drop_constraint("ck_qap_tc_no_self_reexec", "qap_test_cycles", type_="check")
    op.drop_constraint("uq_qap_tc_reexec_parent", "qap_test_cycles", type_="unique")
    op.drop_constraint("fk_qap_tc_reexec_parent", "qap_test_cycles", type_="foreignkey")
    op.drop_column("qap_test_cycles", "reexecution_of_cycle_id")
