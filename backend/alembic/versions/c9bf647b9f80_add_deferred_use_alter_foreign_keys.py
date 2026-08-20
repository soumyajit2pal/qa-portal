"""add deferred use_alter foreign keys missed by the initial baseline

Revision ID: c9bf647b9f80
Revises: 1745115668f0
Create Date: 2026-08-18

`alembic check` against the live database flagged three missing foreign
keys that models.py has always declared with `use_alter=True` (a deliberate
pattern for circular/forward-referencing FKs -- see the comments next to
each Column in models.py):

  - qap_application_master.qa_request_id -> qap_requests.id
    (fk_qap_app_master_qa_req)
  - qap_test_cases.current_approved_version_id -> qap_test_case_versions.id
    (fk_qap_tc_current_approved)
  - qap_test_cases.current_draft_version_id -> qap_test_case_versions.id
    (fk_qap_tc_current_draft)

Root cause: the initial baseline migration (1745115668f0) embedded these
three constraints directly inside their table's own `op.create_table(...)`
call, as ordinary `sa.ForeignKeyConstraint(..., use_alter=True)` constraint
objects. That doesn't actually apply them -- `use_alter=True` tells
SQLAlchemy's DDL compiler to deliberately SKIP emitting the constraint as
part of `CREATE TABLE` (the entire point of the flag, since each one
references a table that in two of these three cases -- qap_requests,
qap_test_case_versions -- is created LATER in that same migration, and
Oracle would reject an inline FK to a table that doesn't exist yet). A
`use_alter=True` constraint is only actually created if something issues a
separate, later `ALTER TABLE ... ADD CONSTRAINT` for it -- which the
baseline migration never did. So on any database built from that migration,
these three tables were created successfully, but the three FKs were
silently never applied, even though models.py has always declared them.

This migration adds the missing `ALTER TABLE ADD CONSTRAINT` step for all
three, explicitly, now that both sides of each circular pair already exist.
Safe to run against a database that already has revision 1745115668f0
applied (the exact situation `alembic check` was run against) -- it only
adds constraints that are confirmed missing, it doesn't touch or recreate
either table.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'c9bf647b9f80'
down_revision: Union[str, None] = '1745115668f0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_foreign_key(
        'fk_qap_app_master_qa_req', 'qap_application_master', 'qap_requests',
        ['qa_request_id'], ['id'],
    )
    op.create_foreign_key(
        'fk_qap_tc_current_approved', 'qap_test_cases', 'qap_test_case_versions',
        ['current_approved_version_id'], ['id'],
    )
    op.create_foreign_key(
        'fk_qap_tc_current_draft', 'qap_test_cases', 'qap_test_case_versions',
        ['current_draft_version_id'], ['id'],
    )


def downgrade() -> None:
    op.drop_constraint('fk_qap_tc_current_draft', 'qap_test_cases', type_='foreignkey')
    op.drop_constraint('fk_qap_tc_current_approved', 'qap_test_cases', type_='foreignkey')
    op.drop_constraint('fk_qap_app_master_qa_req', 'qap_application_master', type_='foreignkey')
