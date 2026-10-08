"""Retain structured additional-testing requirements from approval returns."""
from alembic import op, context
import sqlalchemy as sa

revision = "a8d4c6e2f901"
down_revision = "f6a2d9c4b801"
branch_labels = None
depends_on = None


def upgrade():
    # Restartable online: Oracle DDL commits independently of Alembic's transaction.
    existing = not context.is_offline_mode() and sa.inspect(op.get_bind()).has_table("qap_scope_requirements")
    if not existing:
        _create_table()
    indexes = sa.inspect(op.get_bind()).get_indexes("qap_scope_requirements") if existing else []
    if not any(index["name"].lower() == "ix_qap_scope_parent" for index in indexes):
        op.create_index("ix_qap_scope_parent", "qap_scope_requirements", ["qa_request_id"])


def _create_table():
    op.create_table(
        "qap_scope_requirements",
        sa.Column("id", sa.Integer(), sa.Identity(start=1, increment=1), primary_key=True),
        sa.Column("qa_request_id", sa.Integer(), sa.ForeignKey("qap_requests.id"), nullable=False),
        sa.Column("entity_type", sa.String(32), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("required_types", sa.String(255), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("qap_users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade():
    raise RuntimeError("Testing scope requirements are approval evidence; retain this table during rollback")
