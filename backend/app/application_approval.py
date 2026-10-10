"""Workspace authority for new application-name decisions and their queues."""
from sqlalchemy import and_, false, or_, select

from . import models
from .constants import GatewayStatus, Role
from .deps import active_qa_workspace_scope_ids
from .workspace_service import inherited_workspace_access_mode, selectable_workspace_ids


def can_review_application_in_workspace(db, user, workspace_id):
    """An explicit Application Owner role and operational workspace access."""
    roles = set(user.roles)
    return bool(
        user.is_active
        and Role.APPLICATION_OWNER in roles
        and not roles.intersection({Role.VIEW_ONLY, Role.SCALE_6_PLUS})
        and workspace_id in selectable_workspace_ids(db, user)
        and inherited_workspace_access_mode(db, user, workspace_id) != "PARENT_VIEWER"
    )


def application_owner_workspace_ids(db, user):
    selected = getattr(user, "active_qa_workspace_id", None)
    if selected is not None and inherited_workspace_access_mode(db, user, selected) == "PARENT_VIEWER":
        return ()
    return tuple(
        workspace_id for workspace_id in active_qa_workspace_scope_ids(user)
        if can_review_application_in_workspace(db, user, workspace_id)
    )


def application_review_gateway_condition():
    """A reconsideration round is reviewed through newly submitted gateways.

    Raised gateways from an earlier rejected round must not grant authority
    in their old workspace. Keep legacy first-round raised gateways usable.
    """
    reconsidered = select(models.ApprovalAction.id).where(
        models.ApprovalAction.entity_type == "QA_REQUEST",
        models.ApprovalAction.entity_id == models.ApplicationMaster.qa_request_id,
        models.ApprovalAction.application_master_id == models.ApplicationMaster.id,
        models.ApprovalAction.step_name == "Application Name Reconsideration",
        models.ApprovalAction.decision == "Resubmitted",
    ).correlate(models.ApplicationMaster).exists()
    return and_(
        models.QARequest.status.notin_([GatewayStatus.DRAFT, GatewayStatus.CANCELLED]),
        or_(models.QARequest.status == GatewayStatus.SUBMITTED,
            ~models.QARequest.application_master.has(reconsidered)),
    )


def pending_application_owner_condition(db, user):
    """One predicate shared by the master list, pending feed and its count."""
    workspace_ids = application_owner_workspace_ids(db, user)
    if not workspace_ids:
        return false()
    active_gateway = select(models.QARequest.id).where(
        models.QARequest.application_master_id == models.ApplicationMaster.id,
        application_review_gateway_condition(),
        models.QARequest.qa_workspace_id.in_(workspace_ids),
    ).exists()
    return and_(
        models.ApplicationMaster.status == "PENDING_APP_OWNER",
        or_(models.ApplicationMaster.requested_by_id.is_(None),
            models.ApplicationMaster.requested_by_id != user.id),
        active_gateway,
    )


def pending_application_gateway_condition(db, user):
    """Allow owners to open only gateways whose names need their review."""
    workspace_ids = application_owner_workspace_ids(db, user)
    if not workspace_ids:
        return false()
    return and_(
        models.QARequest.qa_workspace_id.in_(workspace_ids),
        application_review_gateway_condition(),
        models.QARequest.application_master.has(and_(
            models.ApplicationMaster.status == "PENDING_APP_OWNER",
            or_(models.ApplicationMaster.requested_by_id.is_(None),
                models.ApplicationMaster.requested_by_id != user.id),
        )),
    )


def can_review_application_gateway(db, user, gateway):
    if gateway.status in {GatewayStatus.DRAFT, GatewayStatus.CANCELLED}:
        return False
    application = gateway.application_master
    if not application or application.status != "PENDING_APP_OWNER" or application.requested_by_id == user.id:
        return False
    if gateway.status != GatewayStatus.SUBMITTED:
        reconsidered = db.query(models.ApprovalAction.id).filter_by(
            entity_type="QA_REQUEST", entity_id=application.qa_request_id,
            application_master_id=application.id,
            step_name="Application Name Reconsideration", decision="Resubmitted",
        ).first()
        if reconsidered:
            return False
    return bool(
        gateway.qa_workspace_id in application_owner_workspace_ids(db, user)
    )
