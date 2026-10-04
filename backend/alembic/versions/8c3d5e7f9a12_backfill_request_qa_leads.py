"""Recover missing request QA Leads from unambiguous readiness history.

Revision ID: 8c3d5e7f9a12
Revises: 7b8c2d4e6f10

Existing assignments and approval evidence are preserved. Legacy SAST_DAST
events are excluded because SAST and DAST can share the same numeric ID.
"""
from alembic import op


revision = "8c3d5e7f9a12"
down_revision = "7b8c2d4e6f10"
branch_labels = None
depends_on = None


def _backfill(table: str, column: str, entity_type: str, steps: tuple[str, ...]):
    step_names = ", ".join(f"'{step}'" for step in steps)
    # Choose the most recent readiness action by timestamp, then ID. A new
    # Department Head approval clears the assignment and starts a new round,
    # so an older round must never repopulate it.
    candidate = f"""
        SELECT MAX(action.actor_id)
          FROM qap_approval_actions action
         WHERE action.entity_type = '{entity_type}'
           AND action.entity_id = {table}.id
           AND action.step_name IN ({step_names})
           AND action.decision IN ('Started', 'Passed', 'Failed')
           AND action.actor_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM qap_users actor WHERE actor.id = action.actor_id)
           AND NOT EXISTS (
               SELECT 1 FROM qap_approval_actions newer
                WHERE newer.entity_type = action.entity_type
                  AND newer.entity_id = action.entity_id
                  AND (
                      (newer.step_name IN ({step_names})
                       AND newer.decision IN ('Started', 'Passed', 'Failed'))
                      OR (newer.step_name = 'Department Head Approval'
                          AND newer.decision = 'Approved')
                  )
                  AND (newer.created_at > action.created_at
                       OR (newer.created_at = action.created_at AND newer.id > action.id))
           )
    """
    op.execute(f"""
        UPDATE {table}
           SET {column} = ({candidate})
         WHERE {column} IS NULL
           AND ({candidate}) IS NOT NULL
    """)


def upgrade():
    _backfill("qap_functional_requests", "qa_lead_id", "FUNCTIONAL_REQUEST",
              ("QA Readiness", "Readiness Verification"))
    _backfill("qap_sast_requests", "security_lead_id", "SAST", ("Security Readiness",))
    _backfill("qap_dast_requests", "security_lead_id", "DAST", ("Security Readiness",))
    _backfill("qap_performance_requests", "engineer_id", "PERFORMANCE", ("Readiness",))


def downgrade():
    # Reverting code must not erase the recovered identity or its evidence.
    pass
