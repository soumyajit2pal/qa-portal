"""Shared Application Name Master (models.ApplicationMaster) resolve/cleanup
helpers -- originally lived only in routers/qa_requests.py (the QA Request
gateway is the primary place a brand-new Application Name gets proposed),
but is imported here by every router that lets a name be entered or edited
against the same canonical registry (routers/functional.py,
routers/sast_dast.py, routers/performance.py too -- see each of their own
Admin-only Application Name edit handling), so the exact same case/
whitespace-insensitive normalize-and-reuse-or-create logic governs every
entry point instead of letting any one of them bypass the registry and
silently create a near-duplicate. Reported directly: "Duplicate Application
Name Validation Across All Request Actions" -- names differing only by
spacing or capitalization (e.g. "Quality Hub" / "quality hub" / "QUALITY
HUB") must always resolve to the same ApplicationMaster row, no matter which
screen the name was entered from.

Moved out of routers/qa_requests.py into this standalone module (rather than
having functional.py/sast_dast.py/performance.py import straight from
qa_requests.py) specifically to respect this app's one deliberate,
documented exception aside: "no router imports from another router anywhere
else in this app" (see routers/applications.py's own import of
_finalize_child_requests from qa_requests.py for that one exception) -- a
plain, non-router helper module is the correct home for logic every module
router legitimately needs, same pattern as documents.py."""
import json
from typing import Optional
from sqlalchemy.orm import Session

from . import models


def resolve_application_name(db: Session, name: Optional[str], department: Optional[str],
                              requester_id: int, qa_request_id: Optional[int] = None):
    """Called on every create/edit of an Application Name anywhere in the
    app -- uppercases the given name (minimises case-sensitivity duplicates,
    e.g. "sbi" vs "SBI") and resolves it against models.ApplicationMaster:
      - an existing APPROVED, still-PENDING_APP_OWNER, or still-PENDING_SM
        row for that exact name is just reused as-is;
      - a REJECTED row is reused without changing its decision. The gateway
        can be saved as a draft, but submission requires the explicit
        application-name reconsideration action and a reason. This applies
        equally to the original request and a different request;
      - otherwise a brand-new PENDING_APP_OWNER row is created.
    Returns (uppercased_name, application_master_id). Otherwise never blocks
    the caller: drafts can reference a name at any approval status. Submission
    separately enforces reconsideration for rejected names and Application
    Owner review for pending names. Deliberately does
    NOT block simply because a name "already exists or is pending" -- reusing
    an already-known application across more than one request is the whole
    point of this shared registry, not a bug. Resolving or saving a name
    never reopens a completed rejection.

    Note: if a requester changes their mind mid-Draft and swaps one brand-new
    (still-pending) name for a different brand-new name, the first name's
    ApplicationMaster row is simply left behind, still pending and still
    linked via qa_request_id to this same request even though the request no
    longer uses that name -- a minor, rare bit of queue clutter for an
    Application Owner to reject/ignore, not worth extra bookkeeping to
    prevent (cleanup_orphaned_application_master below handles the one case
    that WAS worth fixing -- a genuinely abandoned, still-pending row left
    behind after an actual edit, not this rarer swap-before-ever-saving
    case)."""
    name_upper = (name or "").strip().upper()
    existing = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.name == name_upper).first()
    if existing:
        return name_upper, existing.id
    new_entry = models.ApplicationMaster(
        name=name_upper, status="PENDING_APP_OWNER", department=department,
        requested_by_id=requester_id, qa_request_id=qa_request_id,
    )
    db.add(new_entry)
    db.flush()  # need new_entry.id to link it below
    return name_upper, new_entry.id


def reopen_rejected_application_name(db: Session, application, gateway, user, reason: str) -> None:
    """Start a new review round under the caller's application/gateway locks.

    Existing decision log rows stay immutable. A legacy rejection or a
    rejection originating on another gateway is also retained on this
    gateway before the master's current-round fields are reset.
    """
    rejected_at = application.app_owner_decided_at or application.decided_at
    rejected_by = application.app_owner_decided_by_id or application.decided_by_id
    comments = application.app_owner_comments or application.comments
    prior = db.query(models.ApprovalAction).filter(
        models.ApprovalAction.entity_type == "QA_REQUEST",
        models.ApprovalAction.entity_id == gateway.id,
        models.ApprovalAction.step_name.in_([
            "Application Name (Application Owner)", "Application Name (SM)",
            "Previous Application Name Rejection",
        ]),
        models.ApprovalAction.actor_id == rejected_by,
        models.ApprovalAction.decision.in_(["Rejected", "Recorded"]),
    )
    if rejected_at:
        prior = prior.filter(models.ApprovalAction.created_at >= rejected_at)
    # Remarks are Oracle CLOBs: compare the small scoped history in Python,
    # since Oracle cannot use a plain '=' comparison against a CLOB.
    if not any(action.comments == comments for action in prior.all()):
        db.add(models.ApprovalAction(
            entity_type="QA_REQUEST", entity_id=gateway.id,
            application_master_id=application.id,
            step_name="Previous Application Name Rejection", decision="Recorded",
            actor_id=rejected_by,
            actor_role="APPLICATION_OWNER" if application.app_owner_decided_by_id else "SM",
            # A copied stamp references its original signed decision; it
            # must not be interpreted as a new signature on this snapshot.
            created_at=rejected_at or models.now(),
            comments=comments.replace("[Electronic signature |", "[Historical electronic signature |") if comments else comments,
            previous_state="REJECTED", new_state="REJECTED",
        ))

    application.status = "PENDING_APP_OWNER"
    application.requested_by = user
    application.department = gateway.department
    application.qa_request = gateway
    application.app_owner_decided_by_id = None
    application.app_owner_decided_at = None
    application.app_owner_comments = None
    application.decided_by_id = None
    application.decided_at = None
    application.comments = None
    details = gateway._draft_details()
    details["application_name_reconsideration_reason"] = reason
    gateway.draft_child_details = json.dumps(details)
    db.add(models.ApprovalAction(
        entity_type="QA_REQUEST", entity_id=gateway.id,
        application_master_id=application.id,
        step_name="Application Name Reconsideration", decision="Resubmitted",
        actor_id=user.id, actor_role=user.roles_csv, comments=reason,
        previous_state="REJECTED", new_state="PENDING_APP_OWNER",
    ))


def cleanup_orphaned_application_master(db: Session, old_master_id: Optional[int], qa_request_id: int) -> None:
    """Called right after a caller resolves an Application Name to a
    genuinely DIFFERENT ApplicationMaster row -- reported directly: "the
    original application name should not remain as a separate pending
    approval entry" / "only the latest application name should be displayed
    for approval." Previously the name this request used to point at was
    just left behind still PENDING_APP_OWNER/PENDING_SM -- Pending Approvals
    would then show both the old, abandoned name AND the new one for what
    looks like the same request. If nothing else still resolves to that old
    row and it was never actually decided (still pending either tier), it's
    deleted outright here -- there's no audit trail pointing at the
    ApplicationMaster row itself (ApprovalAction entries key off the QA
    Request/child request's own id, not this one), and no other request
    needs it. A row that's already APPROVED or REJECTED (a real decision was
    made) is left untouched regardless -- only un-decided, abandoned rows are
    cleaned up.

    Checks BOTH of qap_application_master's real child tables (confirmed via
    every ForeignKey("qap_application_master.id") in models.py) before
    deleting -- models.QARequest.application_master_id (the usual case) and
    models.TestProject.application_master_id (one TestProject maps to one
    Application) -- deleting a row still referenced by either raises Oracle's
    own ORA-02292 (child record found)."""
    if not old_master_id:
        return
    old = db.get(models.ApplicationMaster, old_master_id)
    if not old or old.status not in ("PENDING_APP_OWNER", "PENDING_SM"):
        return
    # A pending reconsideration can already have completed decisions behind
    # it. Retain that master and its immutable approval-history references.
    if db.query(models.ApprovalAction.id).filter_by(application_master_id=old_master_id).first():
        return
    still_used_by_request = (
        db.query(models.QARequest.id)
        .filter(models.QARequest.application_master_id == old_master_id,
                models.QARequest.id != qa_request_id)
        .first()
    )
    if still_used_by_request:
        return
    still_used_by_project = (
        db.query(models.TestProject.id)
        .filter(models.TestProject.application_master_id == old_master_id)
        .first()
    )
    if still_used_by_project:
        return
    db.delete(old)
