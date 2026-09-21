"""Enforce Test Project business-key uniqueness under concurrent writes.

Revision ID: d2f4a6c8e105
Revises: a7c9e1f2b304
Create Date: 2026-09-20

The API has long checked project-name uniqueness and one non-archived
project per Application before insert/update.  Those checks are useful for
friendly feedback but are not safe when two transactions pass them at the
same time.  Oracle function-based unique indexes close that race while
retaining archived project history.

This migration deliberately refuses to continue when legacy duplicates are
present.  It reports a bounded sample for manual review and never deletes,
renames, archives, or merges user data automatically.
"""

from typing import Sequence, Union

from alembic import context, op
import sqlalchemy as sa


revision: str = "d2f4a6c8e105"
down_revision: Union[str, Sequence[str], None] = "a7c9e1f2b304"
branch_labels = None
depends_on = None

_TABLE = "qap_test_projects"
_NAME_INDEX = "uq_qap_tproj_name_norm"
_APPLICATION_INDEX = "uq_qap_tproj_open_app"


def _duplicate_samples(bind) -> tuple[list, list]:
    projects = sa.table(
        _TABLE,
        sa.column("name"),
        sa.column("application_master_id"),
        sa.column("is_archived"),
    )
    normalized_name = sa.func.upper(sa.func.trim(projects.c.name))
    duplicate_count = sa.func.count()
    name_rows = bind.execute(
        sa.select(
            normalized_name.label("normalized_name"),
            duplicate_count.label("duplicate_count"),
        )
        .group_by(normalized_name)
        .having(duplicate_count > 1)
        .order_by(normalized_name)
        .limit(10)
    ).fetchall()
    application_rows = bind.execute(
        sa.select(
            projects.c.application_master_id,
            duplicate_count.label("duplicate_count"),
        )
        .where(
            projects.c.application_master_id.is_not(None),
            sa.func.coalesce(projects.c.is_archived, 0) == 0,
        )
        .group_by(projects.c.application_master_id)
        .having(duplicate_count > 1)
        .order_by(projects.c.application_master_id)
        .limit(10)
    ).fetchall()
    return name_rows, application_rows


def _existing_index_names(bind) -> set[str]:
    """Reflect expression indexes without relying on SQLite reflection."""
    dialect = bind.dialect.name
    if dialect == "sqlite":
        rows = bind.execute(
            sa.text(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'index' AND tbl_name = :table_name"
            ),
            {"table_name": _TABLE},
        )
        return {str(row[0] or "").lower() for row in rows}
    if dialect == "oracle":
        rows = bind.execute(
            sa.text(
                "SELECT index_name FROM user_indexes "
                "WHERE table_name = UPPER(:table_name)"
            ),
            {"table_name": _TABLE},
        )
        return {str(row[0] or "").lower() for row in rows}
    return {
        str(index.get("name") or "").lower()
        for index in sa.inspect(bind).get_indexes(_TABLE)
    }


def _create_name_index() -> None:
    op.create_index(
        _NAME_INDEX,
        _TABLE,
        [sa.text("UPPER(TRIM(name))")],
        unique=True,
    )


def _create_application_index() -> None:
    op.create_index(
        _APPLICATION_INDEX,
        _TABLE,
        [sa.text(
            "CASE WHEN COALESCE(is_archived, 0) = 0 "
            "THEN application_master_id END"
        )],
        unique=True,
    )


def upgrade() -> None:
    if context.is_offline_mode():
        _create_name_index()
        _create_application_index()
        return

    bind = op.get_bind()
    name_rows, application_rows = _duplicate_samples(bind)
    if name_rows or application_rows:
        details = []
        if name_rows:
            details.append(
                "normalized project names: "
                + ", ".join(f"{row[0]!r} ({row[1]} rows)" for row in name_rows)
            )
        if application_rows:
            details.append(
                "non-archived Application IDs: "
                + ", ".join(f"{row[0]} ({row[1]} rows)" for row in application_rows)
            )
        raise RuntimeError(
            "Cannot enforce Test Project uniqueness because existing duplicates "
            "require manual review; no data was changed. " + "; ".join(details)
        )

    existing = _existing_index_names(bind)
    if _NAME_INDEX not in existing:
        _create_name_index()
    if _APPLICATION_INDEX not in existing:
        _create_application_index()


def downgrade() -> None:
    if context.is_offline_mode():
        op.drop_index(_APPLICATION_INDEX, table_name=_TABLE)
        op.drop_index(_NAME_INDEX, table_name=_TABLE)
        return

    existing = _existing_index_names(op.get_bind())
    if _APPLICATION_INDEX in existing:
        op.drop_index(_APPLICATION_INDEX, table_name=_TABLE)
    if _NAME_INDEX in existing:
        op.drop_index(_NAME_INDEX, table_name=_TABLE)
