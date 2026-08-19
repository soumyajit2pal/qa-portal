"""fix Oracle NULL-handling bug in department/user unique constraints

Revision ID: 9b1f4d7c2a63
Revises: e2a7c19d4f3b
Create Date: 2026-08-19

Reported directly (live Oracle traceback): granting a SECOND department-only
access grant to the same Test Cycle Folder raised
"ORA-00001: unique constraint (QA_PORTAL.UQ_QAP_TCFA_FOLDER_USER) violated
... row with column values (FOLDER_ID:1, USER_ID:NULL) already exists".

Root cause: qap_test_cycle_folder_access.__table_args__ (see models.py) has
UniqueConstraint('folder_id', 'department') and UniqueConstraint('folder_id',
'user_id') to stop the same department (or user) being granted twice on one
folder. Exactly one of department/user_id is populated per row (department
grants have user_id NULL; user grants have department NULL -- enforced at
the application layer, see routers/test_execution.py). This is a genuine
Postgres-vs-Oracle NULL-handling difference this app's "Oracle-only
production" note exists precisely to catch: Postgres treats every NULL in a
composite unique index as distinct from every other NULL, so any number of
rows can share (folder_id=1, user_id=NULL). Oracle only skips creating an
index entry when EVERY indexed column is NULL -- since folder_id is NEVER
null, Oracle DOES enforce uniqueness across (folder_id, NULL), so a second
department-only grant (folder_id=1, user_id=NULL) collides with the first
one's identical (folder_id=1, user_id=NULL) on the uq_qap_tcfa_folder_user
constraint, and symmetrically a second user-only grant would collide on
uq_qap_tcfa_folder_department (folder_id=1, department=NULL). In effect,
under Oracle, at most ONE department grant and ONE user grant could ever
exist per folder, total -- exactly what the reported traceback shows.

Same bug, same shape, already live in production: qap_test_project_view_grants
(models.TestProjectViewGrant, same "exactly one of department/user_id"
design, same two UniqueConstraints, present since the initial schema
baseline -- 1745115668f0). Fixed here too rather than leaving an identical
ORA-00001 waiting for whoever first grants a second department or second
user to the same Test Project.

Fix: replace both plain composite UniqueConstraints on each table with a
function-based unique index whose first expression is NULL whenever the
row isn't actually of that grant type (CASE WHEN department IS NOT NULL
THEN folder_id END). When department IS NULL, BOTH indexed expressions
become NULL, so -- matching Oracle's own "skip the index entry when every
column is NULL" rule -- the row is excluded from that index's uniqueness
check entirely, exactly reproducing Postgres' one-NULL-per-column-is-always-
distinct behaviour for this specific "ignore rows where this grant type
isn't in use" case, without changing the application-layer "exactly one of
department/user_id" rule those routers already enforce.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '9b1f4d7c2a63'
down_revision: Union[str, None] = 'e2a7c19d4f3b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint('uq_qap_tcfa_folder_department', 'qap_test_cycle_folder_access', type_='unique')
    op.drop_constraint('uq_qap_tcfa_folder_user', 'qap_test_cycle_folder_access', type_='unique')
    op.execute(
        "CREATE UNIQUE INDEX uq_qap_tcfa_folder_department ON qap_test_cycle_folder_access "
        "((CASE WHEN department IS NOT NULL THEN folder_id END), department)"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_qap_tcfa_folder_user ON qap_test_cycle_folder_access "
        "((CASE WHEN user_id IS NOT NULL THEN folder_id END), user_id)"
    )

    op.drop_constraint('uq_qap_tpvg_project_department', 'qap_test_project_view_grants', type_='unique')
    op.drop_constraint('uq_qap_tpvg_project_user', 'qap_test_project_view_grants', type_='unique')
    op.execute(
        "CREATE UNIQUE INDEX uq_qap_tpvg_project_department ON qap_test_project_view_grants "
        "((CASE WHEN department IS NOT NULL THEN project_id END), department)"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_qap_tpvg_project_user ON qap_test_project_view_grants "
        "((CASE WHEN user_id IS NOT NULL THEN project_id END), user_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX uq_qap_tpvg_project_user")
    op.execute("DROP INDEX uq_qap_tpvg_project_department")
    op.create_unique_constraint('uq_qap_tpvg_project_user', 'qap_test_project_view_grants', ['project_id', 'user_id'])
    op.create_unique_constraint('uq_qap_tpvg_project_department', 'qap_test_project_view_grants', ['project_id', 'department'])

    op.execute("DROP INDEX uq_qap_tcfa_folder_user")
    op.execute("DROP INDEX uq_qap_tcfa_folder_department")
    op.create_unique_constraint('uq_qap_tcfa_folder_user', 'qap_test_cycle_folder_access', ['folder_id', 'user_id'])
    op.create_unique_constraint('uq_qap_tcfa_folder_department', 'qap_test_cycle_folder_access', ['folder_id', 'department'])
