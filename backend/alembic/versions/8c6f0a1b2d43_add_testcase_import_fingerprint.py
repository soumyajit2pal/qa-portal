"""add project-scoped testcase import fingerprint

Revision ID: 8c6f0a1b2d43
Revises: 7b5e9d3f2a01
Create Date: 2026-09-06
"""

from typing import Sequence, Union

from alembic import context, op
import sqlalchemy as sa


revision: str = "8c6f0a1b2d43"
down_revision: Union[str, Sequence[str], None] = "7b5e9d3f2a01"
branch_labels = None
depends_on = None


_TABLE = "qap_test_cases"
_COLUMN = "import_fingerprint"
_CONSTRAINT = "uq_qap_tc_project_import_fp"
_CONSTRAINT_COLUMNS = {"project_id", _COLUMN}
_CLEAR_DUPLICATE_FINGERPRINTS_SQL = sa.text(
    """
    UPDATE qap_test_cases
       SET import_fingerprint = NULL
     WHERE id IN (
           SELECT duplicate_id
             FROM (
                   SELECT id AS duplicate_id,
                          ROW_NUMBER() OVER (
                              PARTITION BY project_id, import_fingerprint
                              ORDER BY id
                          ) AS duplicate_rank
                     FROM qap_test_cases
                    WHERE import_fingerprint IS NOT NULL
                  )
            WHERE duplicate_rank > 1
       )
    """
)


def _normalized(value: object) -> str:
    return str(value or "").casefold()


def _has_column(inspector: sa.Inspector) -> bool:
    return any(
        _normalized(column.get("name")) == _COLUMN
        for column in inspector.get_columns(_TABLE)
    )


def _has_import_fingerprint_uniqueness(inspector: sa.Inspector) -> bool:
    """Accept a matching constraint or unique index already present in Oracle."""
    unique_objects = list(inspector.get_unique_constraints(_TABLE))
    unique_objects.extend(
        index for index in inspector.get_indexes(_TABLE) if index.get("unique")
    )
    return any(
        {_normalized(column) for column in item.get("column_names") or []}
        == _CONSTRAINT_COLUMNS
        for item in unique_objects
    )


def _has_named_constraint(inspector: sa.Inspector) -> bool:
    return any(
        _normalized(item.get("name")) == _CONSTRAINT
        for item in inspector.get_unique_constraints(_TABLE)
    )


def _clear_duplicate_import_fingerprints(connection: sa.Connection) -> None:
    """Keep the earliest testcase canonical without deleting historical rows.

    Oracle permits multiple NULL values under a composite unique constraint.
    The application still derives fingerprints for legacy NULL rows when it
    checks an import, so clearing this technical cache value does not let an
    existing duplicate be uploaded again.
    """
    connection.execute(_CLEAR_DUPLICATE_FINGERPRINTS_SQL)


def upgrade() -> None:
    # Some existing schemas received this additive column before Alembic was
    # stamped at this revision. Reconcile each object independently so a retry
    # completes the migration instead of failing with Oracle ORA-01430.
    if context.is_offline_mode():
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(length=64), nullable=True))
        op.execute(_CLEAR_DUPLICATE_FINGERPRINTS_SQL)
        op.create_unique_constraint(_CONSTRAINT, _TABLE, ["project_id", _COLUMN])
        return

    inspector = sa.inspect(op.get_bind())
    if not _has_column(inspector):
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(length=64), nullable=True))

    # Re-inspect after the DDL because SQLAlchemy inspectors cache reflection.
    inspector = sa.inspect(op.get_bind())
    if not _has_import_fingerprint_uniqueness(inspector):
        _clear_duplicate_import_fingerprints(op.get_bind())
        op.create_unique_constraint(_CONSTRAINT, _TABLE, ["project_id", _COLUMN])


def downgrade() -> None:
    if context.is_offline_mode():
        op.drop_constraint(_CONSTRAINT, _TABLE, type_="unique")
        op.drop_column(_TABLE, _COLUMN)
        return

    inspector = sa.inspect(op.get_bind())
    if _has_named_constraint(inspector):
        op.drop_constraint(_CONSTRAINT, _TABLE, type_="unique")

    inspector = sa.inspect(op.get_bind())
    if _has_column(inspector):
        op.drop_column(_TABLE, _COLUMN)
