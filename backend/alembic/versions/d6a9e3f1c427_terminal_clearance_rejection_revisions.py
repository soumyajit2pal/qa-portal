"""Treat QA clearance rejection as terminal and revisionable.

Revision ID: d6a9e3f1c427
Revises: c5f8d2e0b316
"""

from alembic import context, op
import sqlalchemy as sa


revision = "d6a9e3f1c427"
down_revision = "c5f8d2e0b316"
branch_labels = None
depends_on = None


_INDEX_NAME = "uq_qap_signoff_active_req"
_NEW_ACTIVE_STATUS_SQL = (
    "'DRAFT','SUBMITTED','SM_APPROVAL_PENDING','RETURNED_BY_SM',"
    "'DEPT_HEAD_QA_APPROVAL_PENDING','RETURNED_BY_DEPT_HEAD_COE','RETURNED_BY_REQUESTER'"
)
_OLD_ACTIVE_STATUS_SQL = (
    "'DRAFT','SUBMITTED','SM_APPROVAL_PENDING','RETURNED_BY_SM','SM_REJECTED',"
    "'DEPT_HEAD_QA_APPROVAL_PENDING','RETURNED_BY_DEPT_HEAD_COE','RETURNED_BY_REQUESTER'"
)


def _replace_active_index(active_status_sql: str) -> None:
    # Oracle DDL auto-commits. If an interrupted run already dropped the old
    # index, the existence check lets the migration safely resume by creating
    # the replacement.
    if context.is_offline_mode():
        op.drop_index(_INDEX_NAME, table_name="qap_signoffs")
    else:
        indexes = {
            (item.get("name") or "").lower()
            for item in sa.inspect(op.get_bind()).get_indexes("qap_signoffs")
        }
        if _INDEX_NAME in indexes:
            op.drop_index(_INDEX_NAME, table_name="qap_signoffs")

    op.create_index(
        _INDEX_NAME,
        "qap_signoffs",
        [sa.text(
            "CASE WHEN status IN ("
            + active_status_sql
            + ") THEN testing_request_id END"
        )],
        unique=True,
    )


def upgrade():
    # SM_REJECTED now joins DEPT_HEAD_COE_REJECTED as a terminal outcome.
    # Excluding it from the active key permits a new Draft successor while
    # the rejected predecessor remains frozen and auditable.
    _replace_active_index(_NEW_ACTIVE_STATUS_SQL)


def downgrade():
    _replace_active_index(_OLD_ACTIVE_STATUS_SQL)
