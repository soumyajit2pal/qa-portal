"""add unified dashboard request-feed indexes

Revision ID: c7d9e2f4a6b8
Revises: 1d0a8e2b4c61, a8c9d1e2f3b4
Create Date: 2026-08-29

Merge the current migration heads and add the access paths used by the
server-side Dashboard Requests feed.  They are additive, Oracle-safe indexes
whose names are all within Oracle's 30-byte identifier limit.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "c7d9e2f4a6b8"
down_revision: Union[str, Sequence[str], None] = ("1d0a8e2b4c61", "a8c9d1e2f3b4")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_INDEXES = (
    ("ix_qap_req_user_created", "qap_requests", ["requester_id", "created_at", "id"]),
    ("ix_qap_req_dept_created", "qap_requests", ["department", "created_at", "id"]),
    ("ix_qap_req_created_id", "qap_requests", ["created_at", "id"]),
    ("ix_qap_func_user_created", "qap_functional_requests", ["requester_id", "created_at", "id"]),
    ("ix_qap_sast_user_created", "qap_sast_requests", ["requester_id", "created_at", "id"]),
    ("ix_qap_dast_user_created", "qap_dast_requests", ["requester_id", "created_at", "id"]),
    ("ix_qap_perf_user_created", "qap_performance_requests", ["requester_id", "created_at", "id"]),
    ("ix_qap_func_created_id", "qap_functional_requests", ["created_at", "id"]),
    ("ix_qap_sast_created_id", "qap_sast_requests", ["created_at", "id"]),
    ("ix_qap_dast_created_id", "qap_dast_requests", ["created_at", "id"]),
    ("ix_qap_perf_created_id", "qap_performance_requests", ["created_at", "id"]),
)


def upgrade() -> None:
    for name, table, columns in _INDEXES:
        op.create_index(name, table, columns, unique=False)


def downgrade() -> None:
    for name, table, _columns in reversed(_INDEXES):
        op.drop_index(name, table_name=table)
