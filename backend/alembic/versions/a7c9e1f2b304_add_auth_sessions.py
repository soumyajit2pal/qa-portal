"""Add server-managed browser sessions for cookie authentication."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7c9e1f2b304"
down_revision: Union[str, Sequence[str], None] = ("c83ea2b1d594", "d63b9f2a8e41")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "qap_auth_sessions",
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("csrf_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("user_agent_hash", sa.String(64), nullable=True),
        sa.PrimaryKeyConstraint("token_hash", name="pk_qap_auth_sessions"),
        sa.ForeignKeyConstraint(["user_id"], ["qap_users.id"], name="fk_qap_auth_sessions_user", ondelete="CASCADE"),
    )
    op.create_index("ix_qap_auth_session_user", "qap_auth_sessions", ["user_id"])
    op.create_index("ix_qap_auth_session_exp", "qap_auth_sessions", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_qap_auth_session_exp", table_name="qap_auth_sessions")
    op.drop_index("ix_qap_auth_session_user", table_name="qap_auth_sessions")
    op.drop_table("qap_auth_sessions")
