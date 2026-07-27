import datetime
import os
from typing import List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, require_same_department
from ..constants import Role, AUTOMATION_EDITABLE_STATUSES
from ..pdf_export import build_request_detail_pdf
from .. import documents as doc_store

router = APIRouter(prefix="/api/automation-requests", tags=["automation"])

# These identify *which* request this actually is -- changing them once the
# request exists is an Admin-only action (see update_automation below; same
# restriction/reasoning as update_sast in routers/sast_dast.py). A submitted
# value equal to the current one is let through for anyone -- that's not
# actually a change, just the form resubmitting a field it also displays.
_ADMIN_ONLY_FIELDS = {"application_name", "project_name", "cr_number"}

# ---------------------------------------------------------------------------
# Automation Testing lifecycle -- auto-created from a QA Request when
# "Automation Testing" is one of its request types (see routers/qa_requests.py
# ::_sync_linked_child_requests), same pattern as SAST/DAST/Performance.
#
#   Draft -> Submit -> SM Approval -> Department Head Approval -> Feasibility
#   Assessment -> Planning -> Engineer Assignment -> Script Development ->
#   Review -> Execution -> CI/CD Integration (optional -- can be skipped) ->
#   Sign-off -> Requester Verification -> Closed.
# ---------------------------------------------------------------------------


def _log(db, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type="AUTOMATION", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected, action: str):
    if isinstance(expected, str):
        expected = [expected]
    if obj.status not in expected:
        raise HTTPException(400, f"'{action}' requires status in {expected} (currently '{obj.status}')")


def _get_or_404(db: Session, req_id: int):
    obj = db.query(models.AutomationRequest).get(req_id)
    if not obj:
        raise HTTPException(404, "Automation request not found")
    return obj


@router.get("", response_model=List[schemas.AutomationOut])
def list_automation(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.AutomationRequest).order_by(models.AutomationRequest.created_at.desc()).all()


# Standalone creation is DISABLED -- Automation requests can only originate
# from a QA Request that includes "Automation Testing" in its request types.
@router.post("", response_model=schemas.AutomationOut)
def create_automation(payload: schemas.AutomationCreate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    raise HTTPException(
        400,
        "Standalone Automation Testing requests can no longer be raised directly -- include "
        "'Automation Testing' in a QA Request's request types instead.",
    )


@router.put("/{req_id}", response_model=schemas.AutomationOut)
def update_automation(req_id: int, payload: schemas.AutomationUpdate, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.QA_LEAD, Role.QA_ENGINEER, Role.ADMIN):
        raise HTTPException(403, "Only the requester, QA, or an admin can edit this request")
    if obj.status not in AUTOMATION_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    data = payload.model_dump(exclude_unset=True)
    if not current_user.has_role(Role.ADMIN):
        for f in _ADMIN_ONLY_FIELDS:
            if f in data and data[f] != getattr(obj, f):
                raise HTTPException(403, f"Only an Administrator can change {f.replace('_', ' ').title()}")
    checked_items = data.pop("checked_items", None)
    for k, v in data.items():
        setattr(obj, k, v)
    if checked_items is not None:
        # Lets the requester update their readiness-checklist self-declaration
        # from this same "Edit Details" modal while the request is still
        # editable-by-requester -- see schemas.AutomationUpdate.checked_items.
        checked_set = set(checked_items)
        for item in obj.checklist_items:
            item.requester_checked = item.item in checked_set
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/submit", response_model=schemas.AutomationOut)
def submit_automation(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "DRAFT", "Submit")
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "SM Approval", current_user, "Pending", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/resubmit", response_model=schemas.AutomationOut)
def resubmit_automation(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_QA_LEAD"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", None)
    elif obj.status == "RETURNED_BY_DEPARTMENT_HEAD":
        # A genuine direct return from Department Head Approval itself.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", None)
    elif obj.status == "RETURNED_BY_QA_LEAD" and obj.needs_dept_head_reapproval:
        # Feasibility Assessment failure flagged that the fix needs a fresh
        # Department Head approval before Feasibility Assessment resumes.
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted",
             "Returned request re-submitted (Department Head re-approval required)")
    else:
        obj.status = "FEASIBILITY_ASSESSMENT"
        obj.needs_dept_head_reapproval = False
        _log(db, obj.id, "Feasibility Assessment", current_user, "Resubmitted", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/sm-decision", response_model=schemas.AutomationOut)
def sm_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.SM))):
    obj = _get_or_404(db, req_id)
    require_same_department(current_user, obj.department)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    if payload.decision == "Approved":
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "SM_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/department-head-decision", response_model=schemas.AutomationOut)
def department_head_decision(req_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD))):
    obj = _get_or_404(db, req_id)
    require_same_department(current_user, obj.department)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    if payload.decision == "Approved":
        obj.status = "FEASIBILITY_ASSESSMENT"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
    elif payload.decision == "Rejected":
        obj.status = "DEPARTMENT_HEAD_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Department Head Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/feasibility-decision", response_model=schemas.AutomationOut)
def feasibility_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                          current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """QA Lead assesses feasibility right after Department Head approval.
    Passed requires the "Ready for Automation" readiness checklist (see
    constants.DEFAULT_AUTOMATION_CHECKLIST_ITEMS) to be fully complete --
    every mandatory item ticked -- same gating pattern as Functional's
    Readiness Verification and Performance's Readiness decision. A
    discrepancy here (Failed) returns the request to the requester -- the QA
    Lead chooses, via require_dept_head_reapproval, whether the fix needs a
    fresh Department Head approval or can come straight back to Feasibility
    Assessment once addressed (the default)."""
    obj = _get_or_404(db, req_id)
    _require(obj, "FEASIBILITY_ASSESSMENT", "Feasibility decision")
    if payload.decision == "Passed":
        pending = [c.item for c in obj.checklist_items if c.is_mandatory and not c.is_complete]
        if pending:
            raise HTTPException(400, f"Automation readiness checklist incomplete: {', '.join(pending)}")
        obj.status = "PLANNING"
    elif payload.decision == "Failed":
        # Status is always RETURNED_BY_QA_LEAD -- the QA Lead is who actually
        # returned it -- never RETURNED_BY_DEPARTMENT_HEAD; the re-approval
        # choice is tracked separately (see models.AutomationRequest.
        # needs_dept_head_reapproval).
        obj.status = "RETURNED_BY_QA_LEAD"
        obj.needs_dept_head_reapproval = payload.require_dept_head_reapproval
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Feasibility Assessment", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


# ---- "Ready for Automation" Readiness Checklist ----
# Distinct from Functional's ReadinessChecklistItem and Performance's
# PerformanceChecklistItem -- own dedicated table (see
# models.AutomationChecklistItem), seeded at raise-time (see
# routers/qa_requests.py::_sync_linked_child_requests). Like Performance's
# checklist (and unlike Functional's, which is verified solely by the QA
# Lead), the requester can also tick items here (requester_checked, set at
# raise-time from the wizard) but final is_complete verification is done by
# QA, gating feasibility_decision's Passed outcome above.
@router.get("/{req_id}/checklist", response_model=List[schemas.AutomationChecklistItemOut])
def get_checklist(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.AutomationChecklistItem).filter_by(automation_request_id=req_id).all()


@router.put("/{req_id}/checklist/{item_id}", response_model=schemas.AutomationChecklistItemOut)
def update_checklist_item(req_id: int, item_id: int, payload: schemas.AutomationChecklistItemUpdate,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(
                               Role.QA_LEAD, Role.QA_ENGINEER, Role.BUSINESS_ANALYST))):
    item = db.query(models.AutomationChecklistItem).filter_by(id=item_id, automation_request_id=req_id).first()
    if not item:
        raise HTTPException(404, "Checklist item not found")
    parent = _get_or_404(db, req_id)
    if parent.status != "FEASIBILITY_ASSESSMENT":
        raise HTTPException(
            400,
            "Automation readiness checklist items can only be verified while the request is in "
            "Feasibility Assessment (i.e. by QA after Department Head approval) -- not while still "
            "in Draft or any other stage.",
        )
    item.is_complete = payload.is_complete
    if payload.is_complete:
        item.approved_by_id = current_user.id
        import datetime
        item.approved_at = datetime.datetime.utcnow()
    else:
        item.approved_by_id = None
        item.approved_at = None
    db.commit()
    db.refresh(item)
    return item


# ---- Walkthrough sessions ----
# Own dedicated table (AutomationWalkthrough), mirroring Functional's
# WalkthroughSession -- see routers/functional.py for the same pattern.
@router.get("/{req_id}/walkthroughs", response_model=List[schemas.WalkthroughOut])
def list_walkthroughs(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.AutomationWalkthrough).filter_by(automation_request_id=req_id).all()


@router.post("/{req_id}/walkthroughs", response_model=schemas.WalkthroughOut)
def add_walkthrough(req_id: int, payload: schemas.WalkthroughCreate, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(
                         Role.BUSINESS_ANALYST, Role.REQUESTER, Role.QA_ENGINEER, Role.QA_LEAD))):
    if not db.query(models.AutomationRequest).get(req_id):
        raise HTTPException(404, "Automation request not found")
    obj = models.AutomationWalkthrough(automation_request_id=req_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/walkthroughs/{wt_id}/acknowledge", response_model=schemas.WalkthroughOut)
def acknowledge_walkthrough(req_id: int, wt_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD))):
    obj = db.query(models.AutomationWalkthrough).filter_by(id=wt_id, automation_request_id=req_id).first()
    if not obj:
        raise HTTPException(404, "Walkthrough session not found")
    import datetime
    obj.qa_acknowledged_by_id = current_user.id
    obj.qa_acknowledged_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def request_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="AUTOMATION", entity_id=req_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{req_id}/export")
def export_automation(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this Automation Testing request (including the ones
    delegated from its parent QA Request gateway), its readiness checklist,
    and its full approval/workflow history -- who submitted, approved,
    returned, etc., and when -- as one downloadable PDF."""
    obj = _get_or_404(db, req_id)

    def uname(uid):
        if not uid:
            return None
        u = db.query(models.User).get(uid)
        return u.full_name if u else None

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Priority", obj.priority),
            ("Risk Category", obj.risk_category),
        ]),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Project", obj.project_name),
            ("CR Number", obj.cr_number),
            ("Department", obj.department),
            ("Application Owner", obj.application_owner),
        ]),
        ("Automation Details", [
            ("Framework", obj.framework),
            ("Repository URL", obj.repository_url),
            ("CI/CD Pipeline URL", obj.ci_cd_pipeline_url),
        ]),
        ("People", [
            ("Requester", uname(obj.requester_id)),
            ("Assigned Engineer", uname(obj.engineer_id)),
        ]),
        ("Readiness Checklist", [
            (c.item, f"Requester declared: {'Yes' if c.requester_checked else 'No'} | QA verified: {'Yes' if c.is_complete else 'No'}"
                      + ("" if c.is_mandatory else " (optional)"))
            for c in obj.checklist_items
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="AUTOMATION", entity_id=req_id)
                     .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in history_rows:
        history.append((h.step_name or "—", h.decision or "—", uname(h.actor_id) or "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="Automation Testing Request — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.request_id}.pdf"'},
    )


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_automation_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return doc_store.list_documents(db, "AUTOMATION", req_id)


@router.post("/{req_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_automation_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                 current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    return doc_store.save_documents(db, "AUTOMATION", req_id, obj.request_id, files, current_user.id)


@router.get("/{req_id}/documents/{doc_id}/download")
def download_automation_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    doc = doc_store.get_document_or_404(db, "AUTOMATION", req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.post("/{req_id}/assign-engineer", response_model=schemas.AutomationOut)
def assign_engineer(req_id: int, payload: schemas.AssignTesterIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """payload.tester_ids[0] is used as the single automation engineer id --
    reuses the existing AssignTesterIn shape rather than adding a new schema."""
    obj = _get_or_404(db, req_id)
    _require(obj, "PLANNING", "Assign engineer")
    if not payload.tester_ids:
        raise HTTPException(400, "An engineer must be selected")
    engineer_id = payload.tester_ids[0]
    engineer = db.query(models.User).get(engineer_id)
    if not engineer or not engineer.has_role(Role.QA_ENGINEER, Role.QA_LEAD):
        raise HTTPException(400, "engineer must reference an active QA Engineer/Lead user")
    obj.engineer_id = engineer_id
    obj.status = "ENGINEER_ASSIGNMENT"
    _log(db, obj.id, "Engineer Assignment", current_user, "Assigned", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/start-script-development", response_model=schemas.AutomationOut)
def start_script_development(req_id: int, db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, "ENGINEER_ASSIGNMENT", "Start script development")
    obj.status = "SCRIPT_DEVELOPMENT"
    _log(db, obj.id, "Script Development", current_user, "Started", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/submit-for-review", response_model=schemas.AutomationOut)
def submit_for_review(req_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, "SCRIPT_DEVELOPMENT", "Submit for review")
    obj.status = "REVIEW"
    _log(db, obj.id, "Review", current_user, "Submitted", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/review-decision", response_model=schemas.AutomationOut)
def review_decision(req_id: int, payload: schemas.ReadinessDecisionIn, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, "REVIEW", "Review decision")
    if payload.decision == "Passed":
        obj.status = "EXECUTION"
    elif payload.decision == "Failed":
        obj.status = "SCRIPT_DEVELOPMENT"
    else:
        raise HTTPException(400, "decision must be one of: Passed, Failed")
    _log(db, obj.id, "Review", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/complete-execution", response_model=schemas.AutomationOut)
def complete_execution(req_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, "EXECUTION", "Complete execution")
    obj.status = "CI_CD_INTEGRATION"
    _log(db, obj.id, "Execution", current_user, "Complete", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/skip-cicd", response_model=schemas.AutomationOut)
def skip_cicd(req_id: int, db: Session = Depends(get_db),
              current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """CI/CD Integration is optional -- skip straight to Sign-off Pending."""
    obj = _get_or_404(db, req_id)
    _require(obj, ["EXECUTION", "CI_CD_INTEGRATION"], "Skip CI/CD integration")
    obj.status = "SIGNOFF_PENDING"
    _log(db, obj.id, "CI/CD Integration", current_user, "Skipped", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/complete-cicd", response_model=schemas.AutomationOut)
def complete_cicd(req_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(Role.QA_LEAD, Role.QA_ENGINEER))):
    obj = _get_or_404(db, req_id)
    _require(obj, "CI_CD_INTEGRATION", "Complete CI/CD integration")
    obj.status = "SIGNOFF_PENDING"
    _log(db, obj.id, "CI/CD Integration", current_user, "Complete", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/sign-off", response_model=schemas.AutomationOut)
def sign_off(req_id: int, db: Session = Depends(get_db),
             current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = _get_or_404(db, req_id)
    _require(obj, "SIGNOFF_PENDING", "Sign off")
    _log(db, obj.id, "Sign-off", current_user, "Signed Off", None)
    obj.status = "REQUESTER_VERIFICATION"
    _log(db, obj.id, "Requester Verification", current_user, "Pending", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/requester-decision", response_model=schemas.AutomationOut)
def requester_decision(req_id: int, payload: schemas.RequesterDecisionIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = _get_or_404(db, req_id)
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can confirm this")
    _require(obj, "REQUESTER_VERIFICATION", "Requester decision")
    if payload.decision == "Accepted":
        obj.status = "CLOSED"
    elif payload.decision == "ChangesRequired":
        obj.status = "EXECUTION"
    else:
        raise HTTPException(400, "decision must be one of: Accepted, ChangesRequired")
    _log(db, obj.id, "Requester Verification", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj
