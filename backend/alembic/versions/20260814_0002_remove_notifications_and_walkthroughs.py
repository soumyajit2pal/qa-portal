"""Remove retired notification and walkthrough features.

Revision ID: 20260814_0002
Revises: 20260814_0001
Create Date: 2026-08-14
"""

from typing import Sequence, Union

from alembic import op


revision: str = "20260814_0002"
down_revision: Union[str, None] = "20260814_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


RETIRED_TABLES = (
    "qap_notifications",
    "qap_walkthrough_sessions",
    "qap_sast_walkthroughs",
    "qap_dast_walkthroughs",
    "qap_performance_walkthroughs",
    "qap_suppression_walkthroughs",
)

RETIRED_TEST_CASE_VERSION_COLUMNS = (
    "reminder_sent_at",
    "escalated_at",
)


def _drop_table_if_exists(table_name: str) -> None:
    # Oracle has no DROP TABLE IF EXISTS. ORA-00942 is expected on a fresh
    # schema where the retired models were never created; every other error
    # must still fail the migration.
    op.execute(
        f"""
        BEGIN
          EXECUTE IMMEDIATE 'DROP TABLE {table_name} CASCADE CONSTRAINTS';
        EXCEPTION
          WHEN OTHERS THEN
            IF SQLCODE != -942 THEN RAISE; END IF;
        END;
        """
    )


def _drop_column_if_exists(table_name: str, column_name: str) -> None:
    # ORA-00942 means the table is absent and ORA-00904 means the retired
    # column is already absent. Both states satisfy this cleanup migration.
    op.execute(
        f"""
        BEGIN
          EXECUTE IMMEDIATE 'ALTER TABLE {table_name} DROP COLUMN {column_name}';
        EXCEPTION
          WHEN OTHERS THEN
            IF SQLCODE NOT IN (-942, -904) THEN RAISE; END IF;
        END;
        """
    )


def upgrade() -> None:
    for table_name in RETIRED_TABLES:
        _drop_table_if_exists(table_name)
    for column_name in RETIRED_TEST_CASE_VERSION_COLUMNS:
        _drop_column_if_exists("qap_test_case_versions", column_name)
    op.execute(
        """
        BEGIN
          DELETE FROM qap_system_settings
          WHERE key IN ('test_approval_reminder_days', 'test_approval_escalation_days');
        EXCEPTION
          WHEN OTHERS THEN
            IF SQLCODE != -942 THEN RAISE; END IF;
        END;
        """
    )


def downgrade() -> None:
    # Do not let Alembic move its revision marker backward while leaving the
    # retired schema absent. Restoring these data-bearing features requires
    # an explicit backup/recovery plan, not empty replacement tables.
    raise RuntimeError(
        "Revision 20260814_0002 is intentionally irreversible; restore the "
        "retired tables from backup if rollback is required."
    )
