"""Preserve post-readiness requester returns and internal holds."""
import sqlalchemy as sa
from app.migration_helpers import ensure_table, ensure_index

revision = "a31d8e6c2f90"
down_revision = "e8b3d7c2a610"
branch_labels = None
depends_on = None


def upgrade():
    metadata = sa.MetaData()
    for name in ("qap_sast_requests", "qap_dast_requests", "qap_users"):
        sa.Table(name, metadata, sa.Column("id", sa.Integer, primary_key=True))
    table = sa.Table("qap_security_obstacles", metadata,
        sa.Column("id", sa.Integer, sa.Identity(start=1), primary_key=True),
        sa.Column("sast_request_id", sa.Integer, sa.ForeignKey("qap_sast_requests.id", name="fk_qap_obstacle_sast")),
        sa.Column("dast_request_id", sa.Integer, sa.ForeignKey("qap_dast_requests.id", name="fk_qap_obstacle_dast")),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("category", sa.String(100), nullable=False),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("requested_correction", sa.Text, nullable=False),
        sa.Column("target_ids_json", sa.Text, nullable=False),
        sa.Column("changed_fields_json", sa.Text, nullable=False),
        sa.Column("resume_stage", sa.String(32), nullable=False),
        *(sa.Column(field, sa.Integer, sa.ForeignKey("qap_users.id", name=f"fk_qap_obs_{label}"), nullable=field != "opened_by_id")
          for field, label in (("owner_id", "owner"), ("opened_by_id", "opener"), ("submitted_by_id", "submitter"), ("reviewed_by_id", "reviewer"))),
        sa.Column("readiness_required", sa.Boolean, nullable=False),
        sa.Column("reapproval_required", sa.Boolean, nullable=False),
        sa.Column("resolution", sa.Text),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("submitted_at", sa.DateTime),
        sa.Column("reviewed_at", sa.DateTime),
        sa.CheckConstraint("(sast_request_id IS NOT NULL AND dast_request_id IS NULL) OR (dast_request_id IS NOT NULL AND sast_request_id IS NULL)", name="ck_qap_obstacle_request"),
    )
    ensure_table(table)
    ensure_index("ix_qap_obstacle_sast", table.name, ["sast_request_id", "status"])
    ensure_index("ix_qap_obstacle_dast", table.name, ["dast_request_id", "status"])


def downgrade():
    # Retain corrections and review history on application rollback.
    pass
