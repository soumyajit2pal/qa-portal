"""Immutable QA clearance revisions and one-active-certificate guard.

Revision ID: b4e7c1d9a205
Revises: a6d9c2e4f801
"""

from alembic import context, op
import sqlalchemy as sa


revision = "b4e7c1d9a205"
down_revision = "a6d9c2e4f801"
branch_labels = None
depends_on = None


_ACTIVE_STATUS_SQL = (
    "'DRAFT','SUBMITTED','SM_APPROVAL_PENDING','RETURNED_BY_SM','SM_REJECTED',"
    "'DEPT_HEAD_QA_APPROVAL_PENDING','RETURNED_BY_DEPT_HEAD_COE','RETURNED_BY_REQUESTER'"
)


def upgrade():
    # Oracle DDL auto-commits. These existence checks make the revision safe
    # to resume if a later data statement fails after columns or constraints
    # were already created.
    inspector = None if context.is_offline_mode() else sa.inspect(op.get_bind())
    columns = ({column["name"].lower() for column in inspector.get_columns("qap_signoffs")}
               if inspector else set())
    if "supersedes_id" not in columns:
        op.add_column("qap_signoffs", sa.Column("supersedes_id", sa.Integer(), nullable=True))
    if "superseded_by_id" not in columns:
        op.add_column("qap_signoffs", sa.Column("superseded_by_id", sa.Integer(), nullable=True))
    if "revision_number" not in columns:
        op.add_column(
            "qap_signoffs",
            sa.Column("revision_number", sa.Integer(), server_default="1", nullable=False),
        )
    if "revision_reason" not in columns:
        op.add_column("qap_signoffs", sa.Column("revision_reason", sa.Text(), nullable=True))
    if "superseded_at" not in columns:
        op.add_column("qap_signoffs", sa.Column("superseded_at", sa.DateTime(), nullable=True))

    foreign_keys = {
        (constraint.get("name") or "").lower()
        for constraint in inspector.get_foreign_keys("qap_signoffs")
    } if inspector else set()
    if "fk_signoff_supersedes" not in foreign_keys:
        op.create_foreign_key(
            "fk_signoff_supersedes",
            "qap_signoffs",
            "qap_signoffs",
            ["supersedes_id"],
            ["id"],
        )
    if "fk_signoff_superseded_by" not in foreign_keys:
        op.create_foreign_key(
            "fk_signoff_superseded_by",
            "qap_signoffs",
            "qap_signoffs",
            ["superseded_by_id"],
            ["id"],
        )

    unique_constraints = {
        (constraint.get("name") or "").lower()
        for constraint in inspector.get_unique_constraints("qap_signoffs")
    } if inspector else set()
    if "uq_signoff_supersedes" not in unique_constraints:
        op.create_unique_constraint("uq_signoff_supersedes", "qap_signoffs", ["supersedes_id"])
    if "uq_signoff_superseded_by" not in unique_constraints:
        op.create_unique_constraint("uq_signoff_superseded_by", "qap_signoffs", ["superseded_by_id"])

    check_constraints = {
        (constraint.get("name") or "").lower()
        for constraint in inspector.get_check_constraints("qap_signoffs")
    } if inspector else set()
    if "ck_signoff_no_self_revision" not in check_constraints:
        op.create_check_constraint(
            "ck_signoff_no_self_revision",
            "qap_signoffs",
            "supersedes_id IS NULL OR supersedes_id <> id",
        )

    # Preserve every legacy row while retiring parallel active drafts before
    # the database guard is installed. Prefer the certificate already linked
    # to the Functional Request, then the furthest-progressed workflow row.
    op.execute(sa.text(f"""
        MERGE INTO qap_signoffs target
        USING (
            SELECT id
            FROM (
                SELECT s.id,
                       ROW_NUMBER() OVER (
                           PARTITION BY s.testing_request_id
                           ORDER BY
                               CASE WHEN linked.signoff_id IS NOT NULL THEN 0 ELSE 1 END,
                               CASE s.status
                                   WHEN 'DEPT_HEAD_QA_APPROVAL_PENDING' THEN 0
                                   WHEN 'SM_APPROVAL_PENDING' THEN 1
                                   WHEN 'RETURNED_BY_DEPT_HEAD_COE' THEN 2
                                   WHEN 'RETURNED_BY_SM' THEN 3
                                   WHEN 'RETURNED_BY_REQUESTER' THEN 4
                                   WHEN 'SM_REJECTED' THEN 5
                                   WHEN 'SUBMITTED' THEN 6
                                   WHEN 'DRAFT' THEN 7
                                   ELSE 8
                               END,
                               s.created_at DESC,
                               s.id DESC
                       ) AS active_rank
                FROM qap_signoffs s
                LEFT JOIN (
                    SELECT DISTINCT signoff_id
                    FROM qap_functional_requests
                    WHERE signoff_id IS NOT NULL
                ) linked ON linked.signoff_id = s.id
                WHERE s.testing_request_id IS NOT NULL
                  AND s.status IN ({_ACTIVE_STATUS_SQL})
            ) ranked
            WHERE active_rank > 1
        ) duplicate
        ON (target.id = duplicate.id)
        WHEN MATCHED THEN UPDATE SET
            target.status = 'VOIDED',
            target.superseded_at = CURRENT_TIMESTAMP,
            target.revision_reason = 'Legacy parallel certificate retired by one-active-certificate migration'
    """))

    indexes = {
        (index.get("name") or "").lower()
        for index in inspector.get_indexes("qap_signoffs")
    } if inspector else set()
    if "uq_qap_signoff_active_req" not in indexes:
        op.create_index(
            "uq_qap_signoff_active_req",
            "qap_signoffs",
            [sa.text(
                "CASE WHEN status IN ("
                + _ACTIVE_STATUS_SQL
                + ") THEN testing_request_id END"
            )],
            unique=True,
        )


def downgrade():
    op.drop_index("uq_qap_signoff_active_req", table_name="qap_signoffs")
    # Older application versions do not know SUPERSEDED. Issued predecessors
    # retain their issued meaning; retired legacy drafts become terminally
    # rejected rather than silently returning to an active queue.
    op.execute(sa.text("""
        UPDATE qap_signoffs
        SET status = CASE
            WHEN approved_by_id IS NOT NULL THEN 'ISSUED'
            ELSE 'DEPT_HEAD_COE_REJECTED'
        END
        WHERE status IN ('SUPERSEDED', 'VOIDED')
    """))
    op.drop_constraint("ck_signoff_no_self_revision", "qap_signoffs", type_="check")
    op.drop_constraint("uq_signoff_superseded_by", "qap_signoffs", type_="unique")
    op.drop_constraint("uq_signoff_supersedes", "qap_signoffs", type_="unique")
    op.drop_constraint("fk_signoff_superseded_by", "qap_signoffs", type_="foreignkey")
    op.drop_constraint("fk_signoff_supersedes", "qap_signoffs", type_="foreignkey")
    op.drop_column("qap_signoffs", "superseded_at")
    op.drop_column("qap_signoffs", "revision_reason")
    op.drop_column("qap_signoffs", "revision_number")
    op.drop_column("qap_signoffs", "superseded_by_id")
    op.drop_column("qap_signoffs", "supersedes_id")
