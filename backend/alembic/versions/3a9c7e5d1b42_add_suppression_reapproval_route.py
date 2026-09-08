"""separate suppression return actor from reapproval routing

Revision ID: 3a9c7e5d1b42
Revises: 8c6f0a1b2d43
Create Date: 2026-09-08
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "3a9c7e5d1b42"
down_revision: Union[str, Sequence[str], None] = "8c6f0a1b2d43"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "qap_suppression_requests",
        sa.Column(
            "needs_dept_head_reapproval",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    # Repair rows created by the old overloaded status logic. A genuine
    # Department Head return has no Security Team Returned decision, while a
    # Security Team return requiring reapproval does.
    op.execute(
        """
        UPDATE qap_suppression_requests
           SET status = 'RETURNED_BY_SECURITY_TEAM',
               needs_dept_head_reapproval = 1
         WHERE status = 'RETURNED_BY_DEPARTMENT_HEAD'
           AND UPPER(COALESCE(security_decision, '')) = 'RETURNED'
        """
    )


def downgrade() -> None:
    # Preserve the former resubmission route before removing the dedicated
    # flag. Direct Security Team returns remain RETURNED_BY_SECURITY_TEAM.
    op.execute(
        """
        UPDATE qap_suppression_requests
           SET status = 'RETURNED_BY_DEPARTMENT_HEAD'
         WHERE status = 'RETURNED_BY_SECURITY_TEAM'
           AND needs_dept_head_reapproval = 1
        """
    )
    op.drop_column("qap_suppression_requests", "needs_dept_head_reapproval")
