"""add HTML body to workflow email outbox

Revision ID: f4a7c2d9e8b1
Revises: d5e6f7a8b9c0
Create Date: 2026-08-27
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f4a7c2d9e8b1"
down_revision: Union[str, None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("qap_email_notifications", sa.Column("html_body", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("qap_email_notifications", "html_body")
