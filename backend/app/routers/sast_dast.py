from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(tags=["sast-dast"])


def _log(db, entity_type, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type=entity_type, entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


# ---------------- Module 4: SAST ----------------
@router.get("/api/sast-requests", response_model=List[schemas.SASTOut])
def list_sast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.SASTRequest).order_by(models.SASTRequest.created_at.desc()).all()


# Standalone SAST request creation is DISABLED per request -- SAST requests
# must now originate from a QA Request (include "SAST" in its request types;
# see _sync_linked_security_requests in routers/qa_requests.py, which still
# creates the linked SASTRequest via direct ORM insert, bypassing this
# endpoint entirely, so that auto-linking keeps working). Once created, the
# requester (or a security analyst/admin) fills in the rest of the mandatory
# details -- repository URL, branch, commit ID, tech stack, build number --
# via PUT /api/sast-requests/{id} ("Edit Details" in the UI) while status is
# still "Requested".
@router.post("/api/sast-requests", response_model=schemas.SASTOut)
def create_sast(payload: schemas.SASTCreate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    raise HTTPException(
        400,
        "Standalone SAST requests can no longer be raised directly -- include SAST in a QA Request's "
        "request types instead, then fill in the remaining details on the auto-created SAST request.",
    )


@router.put("/api/sast-requests/{req_id}", response_model=schemas.SASTOut)
def update_sast(req_id: int, payload: schemas.SASTUpdate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    """Lets the requester (or a security analyst/admin) fill in or correct
    details -- most importantly for requests auto-created from a QA Request
    (which start with only application_name/project_name/cr_number/risk
    populated), so the requester can add the repository URL, build number,
    etc. before the security team picks it up."""
    obj = db.query(models.SASTRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "SAST request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN):
        raise HTTPException(403, "Only the requester, a security analyst, or an admin can edit this request")
    if obj.status != "Requested":
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/sast-requests/{req_id}/decision", response_model=schemas.SASTOut)
def sast_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST, Role.APPLICATION_OWNER))):
    """Requester -> Security Team -> Approver."""
    obj = db.query(models.SASTRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "SAST request not found")
    step = "Security Team" if current_user.has_role(Role.SECURITY_ANALYST) else "Approver"
    if payload.decision == "Approved":
        obj.status = "Allocated" if step == "Security Team" else "Scanning"
    elif payload.decision == "Rejected":
        obj.status = "Closed"
    _log(db, "SAST_DAST", obj.id, step, current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/sast-requests/{req_id}/findings", response_model=schemas.SASTFindingOut)
def add_sast_finding(req_id: int, payload: schemas.SASTFindingIn, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    if not db.query(models.SASTRequest).get(req_id):
        raise HTTPException(404, "SAST request not found")
    obj = models.SASTFinding(sast_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/sast-requests/{req_id}/close", response_model=schemas.SASTOut)
def close_sast(req_id: int, db: Session = Depends(get_db),
               current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = db.query(models.SASTRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "SAST request not found")
    obj.status = "Report Ready"
    db.commit()
    db.refresh(obj)
    return obj


# ---------------- Module 5: DAST ----------------
@router.get("/api/dast-requests", response_model=List[schemas.DASTOut])
def list_dast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.DASTRequest).order_by(models.DASTRequest.created_at.desc()).all()


# Standalone DAST request creation is DISABLED per request -- same reasoning
# as create_sast above: DAST requests must now originate from a QA Request
# (include "DAST" in its request types), with the requester filling in the
# real target URL / environment / credentials afterward via PUT
# /api/dast-requests/{id} ("Edit Details") while status is still "Requested".
@router.post("/api/dast-requests", response_model=schemas.DASTOut)
def create_dast(payload: schemas.DASTCreate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    raise HTTPException(
        400,
        "Standalone DAST requests can no longer be raised directly -- include DAST in a QA Request's "
        "request types instead, then fill in the remaining details on the auto-created DAST request.",
    )


@router.put("/api/dast-requests/{req_id}", response_model=schemas.DASTOut)
def update_dast(req_id: int, payload: schemas.DASTUpdate, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    """Lets the requester (or a security analyst/admin) fill in or correct
    details -- most importantly for requests auto-created from a QA Request,
    which start with a placeholder application_url (the QA Request form
    doesn't collect one) that the requester needs to replace with the real
    target URL before the security team picks it up."""
    obj = db.query(models.DASTRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "DAST request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.SECURITY_ANALYST, Role.ADMIN):
        raise HTTPException(403, "Only the requester, a security analyst, or an admin can edit this request")
    if obj.status != "Requested":
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/dast-requests/{req_id}/decision", response_model=schemas.DASTOut)
def dast_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST, Role.APPLICATION_OWNER))):
    obj = db.query(models.DASTRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "DAST request not found")
    step = "Security Team" if current_user.has_role(Role.SECURITY_ANALYST) else "Approver"
    if payload.decision == "Approved":
        obj.status = "Allocated" if step == "Security Team" else "Scanning"
    elif payload.decision == "Rejected":
        obj.status = "Closed"
    _log(db, "SAST_DAST", obj.id, step, current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/dast-requests/{req_id}/findings", response_model=schemas.DASTFindingOut)
def add_dast_finding(req_id: int, payload: schemas.SASTFindingIn, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    if not db.query(models.DASTRequest).get(req_id):
        raise HTTPException(404, "DAST request not found")
    obj = models.DASTFinding(dast_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/api/dast-requests/{req_id}/close", response_model=schemas.DASTOut)
def close_dast(req_id: int, db: Session = Depends(get_db),
               current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    obj = db.query(models.DASTRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "DAST request not found")
    obj.status = "Report Ready"
    db.commit()
    db.refresh(obj)
    return obj
