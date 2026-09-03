"""scope checklist mandatory rules by department

Revision ID: 6a4d8c2e1f90
Revises: e6f8a1b2c3d4
Create Date: 2026-09-03
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "6a4d8c2e1f90"
down_revision: Union[str, Sequence[str], None] = "e6f8a1b2c3d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing mandatory rows keep their global meaning via NULL. The first
    # explicit Admin selection stores a JSON array (including [] for
    # optional everywhere), so no risky data backfill is required.
    op.add_column(
        "qap_checklist_template_items",
        sa.Column("mandatory_departments", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("qap_checklist_template_items", "mandatory_departments")
