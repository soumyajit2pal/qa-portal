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


def _log_application_name_decision(db: Session, obj: "models.ApplicationMaster", tier_label: str,
                                    decision: str, current_user: models.User, comments: str) -> None:
    """Reported directly: an Application Name Approve/Reject was never
    showing up on any request's own Activity tab -- only a REJECT happened
    to leave a trace, and only indirectly, via _auto_reject_linked_requests
    below force-rejecting whatever child request was still sitting at its
    own SM Approval (a "SM Approval / Rejected" entry, which reads as the
    request being rejected, not as the application name being rejected).
    Approvals left no trace anywhere. Fixed by logging this decision
    directly, against every request it's actually relevant to: every QA
    Request gateway that resolved to this exact ApplicationMaster row (a
    name can be reused as "Other" across more than one separately-raised QA
    Request, same set this function's callers already walk for the reject
    cascade), plus every one of that gateway's own linked Functional/SAST/
    DAST/Performance requests -- since the App Owner/SM banner and the
    pending/rejected badge are shown on every one of those screens (see
    ApplicationNameBanner and the Overview tab badges), so this decision
    should be visible in every one of those screens' own Activity tab too,
    not just the one screen the actual decision was made from."""
    step_name = f"Application Name ({tier_label})"
    for gw in db.query(models.QARequest).filter(models.QARequest.application_master_id == obj.id).all():
        db.add(models.ApprovalAction(
            entity_type="QA_REQUEST", entity_id=gw.id, step_name=step_name,
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision=decision, comments=comments,
        ))
        groups = [
            (gw.linked_functional_requests, "FUNCTIONAL_REQUEST"),
            (gw.linked_sast_requests, "SAST"),
            (gw.linked_dast_requests, "DAST"),
            (gw.linked_performance_requests, "PERFORMANCE"),
        ]
        for children, entity_type in groups:
            for child in children:
                db.add(models.ApprovalAction(
                    entity_type=entity_type, entity_id=child.id, step_name=step_name,
                    actor_id=current_user.id, actor_role=current_user.roles_csv,
                    decision=decision, comments=comments,
                ))


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


@router.get("/pending-app-owner", response_model=List[schemas.ApplicationMasterOut])
def list_pending_app_owner_names(db: Session = Depends(get_db),
                                  current_user: models.User = Depends(require_roles(Role.APPLICATION_OWNER, Role.ADMIN))):
    """Application Owner/Admin section listing every name still awaiting the
    FIRST tier of the two-tier approval chain -- mirrors
    list_pending_application_names below exactly, one tier earlier. An
    Application Owner's day-to-day path to this is normally the inline
    banner on their own module's detail view for the specific request that
    introduced the name (see application_master_status on FunctionalOut/
    SASTOut/DASTOut/PerformanceOut), not this list. ADMIN sees every
    department's pending names; an Application Owner only sees their own
    department's."""
    q = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.status == "PENDING_APP_OWNER")
    if not current_user.has_role(Role.ADMIN):
        q = q.filter(models.ApplicationMaster.department == current_user.department)
    return q.order_by(models.ApplicationMaster.created_at).all()


@router.get("/pending", response_model=List[schemas.ApplicationMasterOut])
def list_pending_application_names(db: Session = Depends(get_db),
                                    current_user: models.User = Depends(require_roles(Role.SM, Role.ADMIN))):
    """SM/Admin section listing every name that has cleared Application Owner
    and is now awaiting SM, the second and final tier -- mainly useful for an
    Admin housekeeping view; an SM's day-to-day path to this is normally the
    inline banner on their own SM Approval screen for the specific request
    that introduced the name (see application_master_status on
    FunctionalOut/SASTOut/DASTOut/PerformanceOut), not this list. ADMIN sees
    every department's pending names; an SM only sees their own department's
    (same require_same_department scoping as the decision endpoint below,
    applied here as a filter instead of a hard error)."""
    q = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.status == "PENDING_SM")
    if not current_user.has_role(Role.ADMIN):
        q = q.filter(models.ApplicationMaster.department == current_user.department)
    return q.order_by(models.ApplicationMaster.created_at).all()


@router.post("/{app_id}/app-owner-decision", response_model=schemas.ApplicationMasterOut)
def decide_app_owner_name(app_id: int, payload: schemas.ApplicationMasterDecision, db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(Role.APPLICATION_OWNER))):
    """First tier of the two-tier Application Name approval chain. Approving
    moves the name on to PENDING_SM -- it does NOT approve the name outright;
    SM still has the final say, same as before this tier was inserted.
    Rejecting is terminal, same as an SM rejection: it also force-rejects any
    linked request still sitting at its own SM Approval checkpoint (see
    _auto_reject_linked_requests above), and -- since a Reject here IS the
    final decision on this name -- also populates the SM-tier decided_by_id/
    decided_at/comments fields (not just this tier's own app_owner_* fields),
    so anything reading those as "the decision that made this terminal"
    keeps working regardless of which tier actually made the call. Same
    same-department scoping as every other approval checkpoint in the app."""
    obj = db.query(models.ApplicationMaster).get(app_id)
    if not obj:
        raise HTTPException(404, "Application name not found")
    require_same_department(current_user, obj.department)
    if obj.status != "PENDING_APP_OWNER":
        raise HTTPException(
            400,
            f"This application name is not awaiting Application Owner decision -- "
            f"its current status is '{obj.status}'.",
        )
    if payload.decision not in ("Approved", "Rejected"):
        raise HTTPException(400, "decision must be one of: Approved, Rejected")
    now = datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata"))
    obj.app_owner_decided_by_id = current_user.id
    obj.app_owner_decided_at = now
    obj.app_owner_comments = payload.comments
    if payload.decision == "Approved":
        obj.status = "PENDING_SM"
    else:
        obj.status = "REJECTED"
        # Reject at this tier IS the final decision -- mirror it into the
        # SM-tier fields too, same reasoning as the docstring above.
        obj.decided_by_id = current_user.id
        obj.decided_at = now
        obj.comments = payload.comments
        reason = f"Application Name '{obj.name}' was rejected by Application Owner"
        if payload.comments:
            reason += f": {payload.comments}"
        for gw in db.query(models.QARequest).filter(models.QARequest.application_master_id == obj.id).all():
            _auto_reject_linked_requests(db, gw, current_user, reason)
    _log_application_name_decision(db, obj, "Application Owner", payload.decision, current_user, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{app_id}/decision", response_model=schemas.ApplicationMasterOut)
def decide_application_name(app_id: int, payload: schemas.ApplicationMasterDecision, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.SM))):
    """Second and final tier. Approve/reject a name that's already cleared
    Application Owner and is now PENDING_SM. Approving never changes the
    linked request's own status -- an approved name simply becomes a
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
    if obj.status == "PENDING_APP_OWNER":
        raise HTTPException(
            400,
            "This application name is still awaiting Application Owner approval -- "
            "it hasn't reached SM review yet.",
        )
    if obj.status != "PENDING_SM":
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
    _log_application_name_decision(db, obj, "SM", payload.decision, current_user, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj
