"""add qap_requests.change_description

Revision ID: 4cfa97fbdd97
Revises: c9bf647b9f80
Create Date: 2026-08-18

Reported directly: a new mandatory "Change Description" field on the QA
Request wizard's "Application & Change Details" step, distinct from Change
Type's New/Enhancement/Bug Fix classification. Added nullable (like every
other UI-mandatory field on this table -- application_owner, cr_number,
technology_stack, ...; application_name is the one deliberate NOT NULL
exception) since actual enforcement lives at the wizard level
(validation.ts's REQUIRED_DETAIL_FIELDS + DetailsStep.tsx's `required`), not
the database -- so this is safe to run against a table that already has
existing rows, no backfill needed.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '4cfa97fbdd97'
down_revision: Union[str, None] = 'c9bf647b9f80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('qap_requests', sa.Column('change_description', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('qap_requests', 'change_description')
