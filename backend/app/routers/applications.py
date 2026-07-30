import datetime
from typing import List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import Role

router = APIRouter(prefix="/api/application-names", tags=["application-names"])


def _auto_reject_linked_requests(db: Session, qa_request, current_user: models.User, comments: str):
    """Called when an Application Name is Rejected. Rejecting the name means
    the request(s) that introduced/use it can't legitimately proceed under
    it -- so every linked child request (Functional/SAST/DAST/
    Performance) still sitting at its own SM Approval checkpoint is force-
    rejected here too, rather than leaving the SM able to separately approve
    that request and send it on to Department Head with a name that was just
    rejected. Requests that have already moved past SM Approval (or haven't
    reached it yet) are left untouched -- this only closes the specific race
    the SM Approval screen otherwise allows (decide the name, then still
    freely decide the request itself)."""
    if not qa_request:
        return
    groups = [
        (qa_request.linked_functional_requests, "FUNCTIONAL_REQUEST"),
        (qa_request.linked_sast_requests, "SAST"),
        (qa_request.linked_dast_requests, "DAST"),
        (qa_request.linked_performance_requests, "PERFORMANCE"),
    ]
    for children, entity_type in groups:
        for child in children:
            if child.status == "SM_APPROVAL_PENDING":
                child.status = "SM_REJECTED"
                db.add(models.ApprovalAction(
                    entity_type=entity_type, entity_id=child.id, step_name="SM Approval",
                    actor_id=current_user.id, actor_role=current_user.roles_csv,
                    decision="Rejected", comments=comments,
                ))


@router.get("", response_model=List[schemas.ApplicationMasterOut])
def list_application_names(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Approved names only -- this is what feeds the QA Request wizard's
    Application Name dropdown (see frontend QARequests/steps/DetailsStep.tsx).
    Anyone logged in can see the full approved list; there's nothing
    sensitive about a standardised application name."""
    return (db.query(models.ApplicationMaster)
            .filter(models.ApplicationMaster.status == "APPROVED")
            .order_by(models.ApplicationMaster.name).all())


@router.get("/pending", response_model=List[schemas.ApplicationMasterOut])
def list_pending_application_names(db: Session = Depends(get_db),
                                    current_user: models.User = Depends(require_roles(Role.SM, Role.ADMIN))):
    """SM/Admin section listing every name still awaiting a decision --
    mainly useful for an Admin housekeeping view; an SM's day-to-day path to
    this is normally the inline banner on their own SM Approval screen for
    the specific request that introduced the name (see application_master_status
    on FunctionalOut/SASTOut/DASTOut/PerformanceOut), not this
    list. ADMIN sees every department's pending names; an SM only sees their
    own department's (same require_same_department scoping as the decision
    endpoint below, applied here as a filter instead of a hard error)."""
    q = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.status == "PENDING")
    if not current_user.has_role(Role.ADMIN):
        q = q.filter(models.ApplicationMaster.department == current_user.department)
    return q.order_by(models.ApplicationMaster.created_at).all()


@router.post("/{app_id}/decision", response_model=schemas.ApplicationMasterOut)
def decide_application_name(app_id: int, payload: schemas.ApplicationMasterDecision, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.SM))):
    """Approve or reject a PENDING Application Name. Approving never changes
    the linked request's own status -- an approved name simply becomes a
    standard dropdown option going forward. Rejecting is different: it also
    force-rejects any linked request still sitting at its own SM Approval
    checkpoint (see _auto_reject_linked_requests above) -- a request can't be
    allowed to proceed to Department Head under an application name the SM
    just rejected. Same same-department scoping as every other SM approval
    checkpoint in the app."""
    obj = db.query(models.ApplicationMaster).get(app_id)
    if not obj:
        raise HTTPException(404, "Application name not found")
    require_same_department(current_user, obj.department)
    if obj.status != "PENDING":
        raise HTTPException(400, f"This application name has already been '{obj.status}'")
    if payload.decision not in ("Approved", "Rejected"):
        raise HTTPException(400, "decision must be one of: Approved, Rejected")
    obj.status = "APPROVED" if payload.decision == "Approved" else "REJECTED"
    obj.decided_by_id = current_user.id
    obj.decided_at = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    obj.comments = payload.comments
    if obj.status == "REJECTED":
        reason = f"Application Name '{obj.name}' was rejected by SM"
        if payload.comments:
            reason += f": {payload.comments}"
        # Walk every QA Request gateway that resolved to this exact
        # ApplicationMaster row -- not just obj.qa_request (the one gateway
        # that happened to introduce it first via _resolve_application_name).
        # A requester can reuse the same "Other" name across more than one
        # separately-raised QA Request; every one of them shares this same
        # application_master_id and needs its own linked requests rejected.
        for gw in db.query(models.QARequest).filter(models.QARequest.application_master_id == obj.id).all():
            _auto_reject_linked_requests(db, gw, current_user, reason)
    db.commit()
    db.refresh(obj)
    return obj
