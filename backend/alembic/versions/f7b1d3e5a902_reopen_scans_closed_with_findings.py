"""reopen security scans closed with current findings

Revision ID: f7b1d3e5a902
Revises: c4e8a1f6d2b7
Create Date: 2026-08-20

Approved suppressions previously allowed SAST/DAST requests to reach
Security Complete and Closed while the latest Fortify snapshot was still
non-zero. The workflow now requires a zero-result rescan, so repair those
already-invalid terminal states and return them to Rescan.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "f7b1d3e5a902"
down_revision: Union[str, None] = "c4e8a1f6d2b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _reopen(request_table: str, request_type: str) -> None:
    op.execute(
        f"""
        UPDATE {request_table}
           SET status = 'RESCAN'
         WHERE status IN ('SECURITY_COMPLETE', 'REPORT_READY', 'CLOSED')
           AND EXISTS (
               SELECT 1
                 FROM qap_security_scan_results scan
                WHERE scan.request_type = '{request_type}'
                  AND scan.request_id = {request_table}.id
                  AND scan.total_count > 0
                  AND NOT EXISTS (
                      SELECT 1
                        FROM qap_security_scan_results newer
                       WHERE newer.request_type = scan.request_type
                         AND newer.request_id = scan.request_id
                         AND (newer.imported_at > scan.imported_at
                              OR (newer.imported_at = scan.imported_at AND newer.id > scan.id))
                  )
           )
        """
    )


def upgrade() -> None:
    _reopen("qap_sast_requests", "SAST")
    _reopen("qap_dast_requests", "DAST")


def downgrade() -> None:
    # This is a corrective data migration. Re-closing requests that still
    # contain findings would recreate the invalid workflow state.
    pass
