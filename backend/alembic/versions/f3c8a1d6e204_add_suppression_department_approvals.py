"""add parallel suppression department approvals

Revision ID: f3c8a1d6e204
Revises: d2f4a6c8e105
Create Date: 2026-09-24
"""

from alembic import op
import sqlalchemy as sa


revision = "f3c8a1d6e204"
down_revision = "d2f4a6c8e105"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "qap_suppression_dept_approvals",
        sa.Column("id", sa.Integer(), sa.Identity(start=1, increment=1), nullable=False),
        sa.Column("suppression_request_id", sa.Integer(), nullable=False),
        sa.Column("department_id", sa.Integer(), nullable=False),
        sa.Column("decision", sa.String(length=16), server_default="Pending", nullable=False),
        sa.Column("approver_id", sa.Integer(), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["suppression_request_id"], ["qap_suppression_requests.id"]),
        sa.ForeignKeyConstraint(["department_id"], ["qap_departments.id"]),
        sa.ForeignKeyConstraint(["approver_id"], ["qap_users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("suppression_request_id", "department_id", name="uq_qap_sup_dept_approval"),
    )
    op.create_index("ix_qap_sda_request", "qap_suppression_dept_approvals", ["suppression_request_id"])
    op.create_index("ix_qap_sda_dept", "qap_suppression_dept_approvals", ["department_id"])

    # Existing requests retain their original single-department behaviour.
    #
    # Department names are legacy free text.  Match them case-insensitively
    # after trimming surrounding whitespace, but only when that normalized
    # value identifies exactly one department-master row.  Ambiguous or truly
    # unmatched values cannot be given a valid department FK safely and are
    # deliberately left for manual data cleanup.
    #
    # The aggregate Department Head fields may contain a decision from an
    # earlier approval round.  The workflow status is authoritative: a request
    # currently awaiting Department Head approval must start with a Pending row
    # and no stale approver/timestamp, regardless of the aggregate columns.
    op.execute("""
      INSERT INTO qap_suppression_dept_approvals
        (suppression_request_id, department_id, decision, approver_id, decided_at)
      SELECT s.id, d.department_id,
             CASE
               WHEN UPPER(TRIM(s.status)) = 'DEPARTMENT_HEAD_APPROVAL_PENDING'
                 THEN 'Pending'
               WHEN UPPER(TRIM(s.dept_head_decision)) = 'APPROVED'
                 THEN 'Approved'
               WHEN UPPER(TRIM(s.dept_head_decision)) = 'RETURNED'
                 THEN 'Returned'
               WHEN UPPER(TRIM(s.dept_head_decision)) = 'REJECTED'
                 THEN 'Rejected'
               ELSE 'Pending'
             END,
             CASE
               WHEN UPPER(TRIM(s.status)) = 'DEPARTMENT_HEAD_APPROVAL_PENDING'
                 THEN NULL
               WHEN UPPER(TRIM(s.dept_head_decision)) IN ('APPROVED', 'RETURNED', 'REJECTED')
                 THEN s.dept_head_id
               ELSE NULL
             END,
             CASE
               WHEN UPPER(TRIM(s.status)) = 'DEPARTMENT_HEAD_APPROVAL_PENDING'
                 THEN NULL
               WHEN UPPER(TRIM(s.dept_head_decision)) IN ('APPROVED', 'RETURNED', 'REJECTED')
                 THEN s.dept_head_decided_at
               ELSE NULL
             END
        FROM qap_suppression_requests s
        JOIN (
          SELECT UPPER(TRIM(name)) AS normalized_name,
                 MIN(id) AS department_id
            FROM qap_departments
           WHERE name IS NOT NULL
           GROUP BY UPPER(TRIM(name))
          HAVING COUNT(*) = 1
        ) d ON d.normalized_name = UPPER(TRIM(s.department))
    """)

    # Keep the legacy aggregate fields consistent with the new per-department
    # rows. A request that is currently awaiting Department Head approval has
    # no completed aggregate decision, even if an earlier approval round left
    # stale values behind.
    op.execute("""
      UPDATE qap_suppression_requests
         SET dept_head_decision = NULL,
             dept_head_id = NULL,
             dept_head_decided_at = NULL
       WHERE UPPER(TRIM(status)) = 'DEPARTMENT_HEAD_APPROVAL_PENDING'
    """)


def downgrade() -> None:
    # The legacy suppression table can represent only one aggregate
    # Department Head decision. Dropping this table when a request has more
    # than one required department would silently discard both routing and
    # audit state, so fail closed and require that data to be consolidated or
    # archived explicitly before downgrading.
    unsafe_requests = op.get_bind().execute(sa.text("""
      SELECT COUNT(*)
        FROM (
          SELECT suppression_request_id
            FROM qap_suppression_dept_approvals
           GROUP BY suppression_request_id
          HAVING COUNT(*) > 1
        ) multi_department_requests
    """)).scalar()
    if int(unsafe_requests or 0):
        raise RuntimeError(
            "Cannot downgrade f3c8a1d6e204: multi-department suppression "
            "approval state cannot be represented by the legacy schema."
        )
    op.drop_index("ix_qap_sda_dept", table_name="qap_suppression_dept_approvals")
    op.drop_index("ix_qap_sda_request", table_name="qap_suppression_dept_approvals")
    op.drop_table("qap_suppression_dept_approvals")
