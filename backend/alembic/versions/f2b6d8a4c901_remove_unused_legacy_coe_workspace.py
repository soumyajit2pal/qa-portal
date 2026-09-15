"""Remove the unused legacy COE workspace bootstrap row.

Revision ID: f2b6d8a4c901
Revises: e9a4c2f7b801

The original workspace migration created COE-QA to receive records while an
older populated installation moved to workspace scoping. Workspaces are now
organisation-defined and the seed owns the sole automatic workspace,
``DEFAULT``. Preserve any COE-QA row that has acquired data or access; delete
only the untouched migration-created placeholder.
"""

from alembic import op


revision = "f2b6d8a4c901"
down_revision = "e9a4c2f7b801"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM qap_qa_workspaces legacy_workspace
        WHERE legacy_workspace.workspace_key = 'COE-QA'
          AND legacy_workspace.name = 'COE Quality Assurance'
          -- ``description`` is a CLOB on Oracle. CLOB values cannot be used
          -- directly as equality comparison keys (ORA-22848).
          AND DBMS_LOB.COMPARE(
              legacy_workspace.description,
              TO_CLOB('Migrated default QA workspace')
          ) = 0
          AND NOT EXISTS (
              SELECT 1 FROM qap_qa_workspaces child_workspace
              WHERE child_workspace.parent_workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_users app_user
              WHERE app_user.preferred_qa_workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_qa_workspace_members membership
              WHERE membership.workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_qa_workspace_coverage coverage
              WHERE coverage.workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_department_coordinators coordinator
              WHERE coordinator.workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_requests request_record
              WHERE request_record.qa_workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_test_projects project_record
              WHERE project_record.qa_workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_suppression_requests suppression_record
              WHERE suppression_record.qa_workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_signoffs signoff_record
              WHERE signoff_record.qa_workspace_id = legacy_workspace.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM qap_test_project_view_grants project_grant
              WHERE project_grant.workspace_id = legacy_workspace.id
          )
        """
    )


def downgrade() -> None:
    # Do not recreate retired bootstrap data. A downgrade preserves whichever
    # workspaces the organisation currently owns.
    pass
