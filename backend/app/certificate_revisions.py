"""Immutable revision workflow for issued or rejected QA clearance certificates."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import certificate_summary, models
from .constants import ACTIVE_SIGNOFF_STATUSES, QAStatus


_COPIED_FIELDS = (
    "certificate_type",
    "testing_type",
    "testing_request_id",
    "change_request_ids",
    "application_name",
    "application_owner",
    "department",
    "qa_workspace_id",
    "vendor_si_partner",
    "technology_stack",
    "risk_tier",
    "release_version",
    "build_number",
    "environment_tested",
    "target_promotion_environment",
    "validity_from",
    "validity_to",
    "known_limitations",
    "business_acceptance_status",
    "security_testing_status",
    "conditional_observations",
    "conditional_mitigation",
    "conditional_owner",
    "conditional_target_date",
    "exit_criteria_notes",
    "open_defect_summary",
    "residual_risk_notes",
)

_REVISION_SOURCE_STATUSES = {
    QAStatus.QA_SIGNED_OFF,
    QAStatus.QA_SIGNOFF_PENDING,
    QAStatus.REQUESTER_VERIFICATION,
    QAStatus.CLOSED,
}

_REVISIONABLE_CERTIFICATE_STATUSES = {
    "ISSUED",
    "SM_REJECTED",
    "DEPT_HEAD_COE_REJECTED",
}


def active_certificate(db: Session, testing_request_id: str, *, exclude_id: int | None = None):
    query = db.query(models.QASignOff).filter(
        models.QASignOff.testing_request_id == testing_request_id,
        models.QASignOff.status.in_(ACTIVE_SIGNOFF_STATUSES),
    )
    if exclude_id is not None:
        query = query.filter(models.QASignOff.id != exclude_id)
    return query.order_by(models.QASignOff.id).first()


def create_certificate_revision(
    db: Session,
    original: models.QASignOff,
    actor: models.User,
    reason: str,
) -> models.QASignOff:
    """Create one Draft successor without mutating terminal evidence or approvals.

    The caller owns the transaction. An issued predecessor is moved to
    SUPERSEDED before insertion; a rejected predecessor remains in its exact
    rejection status. In both cases the predecessor is row-locked and linked
    to exactly one successor, while the database's conditional unique index
    guarantees one active certificate even across concurrent workers.
    """
    normalized_reason = (reason or "").strip()
    if len(normalized_reason) < 3:
        raise HTTPException(400, "A revision reason of at least 3 characters is required")
    if len(normalized_reason) > 2000:
        raise HTTPException(400, "Revision reason cannot exceed 2,000 characters")

    db.refresh(original, with_for_update=True)
    original_status = original.status
    if original_status not in _REVISIONABLE_CERTIFICATE_STATUSES:
        if original.status == "SUPERSEDED" and original.superseded_by:
            raise HTTPException(
                409,
                f"This certificate was already superseded by {original.superseded_by.certificate_id}",
            )
        raise HTTPException(409, "Only an issued or rejected certificate can be revised")
    if original.superseded_by_id is not None:
        raise HTTPException(409, "This certificate already has a successor")

    existing_successor = db.query(models.QASignOff).filter_by(supersedes_id=original.id).first()
    if existing_successor:
        raise HTTPException(
            409,
            f"This certificate was already revised by {existing_successor.certificate_id}",
        )
    competing = active_certificate(db, original.testing_request_id, exclude_id=original.id)
    if competing:
        raise HTTPException(
            409,
            f"{competing.certificate_id} is already the active certificate for "
            f"{original.testing_request_id}; continue that certificate instead",
        )

    source = (
        db.query(models.FunctionalRequest)
        .filter(models.FunctionalRequest.request_id == original.testing_request_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if not source or source.signoff_id != original.id:
        raise HTTPException(
            409,
            "Only the terminal certificate currently linked to its Functional Request can be revised",
        )
    if source.status not in _REVISION_SOURCE_STATUSES:
        raise HTTPException(
            409,
            f"The linked Functional Request cannot enter clearance revision from status '{source.status}'",
        )

    # Release an issued predecessor's active-key value first. Rejected
    # predecessors are already terminal and deliberately retain their exact
    # decision. If any later step fails, the transaction rollback restores
    # every lineage field and status.
    if original_status == "ISSUED":
        original.status = "SUPERSEDED"
    original.superseded_at = models.now()
    db.flush()

    source.status = QAStatus.QA_SIGNOFF_PENDING
    successor = models.QASignOff(
        **{field: getattr(original, field) for field in _COPIED_FIELDS},
        status="DRAFT",
        requester_id=original.requester_id,
        revision_number=(original.revision_number or 1) + 1,
        revision_reason=normalized_reason,
        supersedes_id=original.id,
    )
    db.add(successor)
    db.flush()

    original.superseded_by_id = successor.id
    source.signoff_id = successor.id
    certificate_summary.refresh(db, successor)

    predecessor_decision = "Superseded" if original_status == "ISSUED" else "Revision created"
    predecessor_comment = (
        f"Superseded by {successor.certificate_id}. Reason: {normalized_reason}"
        if original_status == "ISSUED"
        else f"Terminal rejection retained; continued by {successor.certificate_id}. Reason: {normalized_reason}"
    )
    db.add(models.ApprovalAction(
        entity_type="SIGNOFF",
        entity_id=original.id,
        step_name="Certificate revision",
        actor_id=actor.id,
        actor_role=actor.roles_csv,
        decision=predecessor_decision,
        comments=predecessor_comment,
    ))
    db.add(models.ApprovalAction(
        entity_type="SIGNOFF",
        entity_id=successor.id,
        step_name="Certificate revision",
        actor_id=actor.id,
        actor_role=actor.roles_csv,
        decision="Drafted",
        comments=f"Revision {successor.revision_number} of {original.certificate_id}. Reason: {normalized_reason}",
    ))
    db.add(models.ApprovalAction(
        entity_type="FUNCTIONAL_REQUEST",
        entity_id=source.id,
        step_name="QA Clearance",
        actor_id=actor.id,
        actor_role=actor.roles_csv,
        decision="Revision required",
        comments=(
            f"Certificate {original.certificate_id} continued by revision {successor.certificate_id}; "
            "fresh QA Lead and Executive approval required. "
            f"Reason: {normalized_reason}"
        ),
    ))
    return successor
