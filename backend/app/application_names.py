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
from typing import Optional
from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import models


def resolve_application_name(db: Session, name: Optional[str], department: Optional[str],
                              requester_id: int, qa_request_id: Optional[int] = None):
    """Called on every create/edit of an Application Name anywhere in the
    app -- uppercases the given name (minimises case-sensitivity duplicates,
    e.g. "sbi" vs "SBI") and resolves it against models.ApplicationMaster:
      - an existing APPROVED, still-PENDING_APP_OWNER, or still-PENDING_SM
        row for that exact name is just reused as-is;
      - a REJECTED row belonging to a DIFFERENT QA Request (or no QA Request
        at all) is flipped back to PENDING_APP_OWNER and re-attributed to
        this requester/department/request, treating this as a fresh proposal
        that re-enters approval from the start (whatever earlier issue got
        it rejected may not apply to this unrelated request, so it gets
        another look);
      - a REJECTED row still attributed to THIS SAME qa_request_id is
        rejected outright (raises 400) instead -- see the caller's own
        qa_request_id, which for the gateway is its own id, and for a
        Functional/SAST/DAST/Performance child request editing its OWN
        application_name is that child's linked qa_request_id (the gateway
        it was raised from), not the child's own id -- comparing against the
        gateway's id either way is what tells apart "this same
        request/gateway is trying to sneak its own rejected name back in"
        from "a different, unrelated request wants to try this same name",
        which is still allowed exactly as before;
      - otherwise a brand-new PENDING_APP_OWNER row is created.
    Returns (uppercased_name, application_master_id). Otherwise never blocks
    the caller -- see the class docstring on models.ApplicationMaster for why
    Draft save and Submit/Raise both proceed regardless of the name's current
    approval status (approving/rejecting a name is handled independently by
    an Application Owner, see routers/applications.py). Deliberately does
    NOT block simply because a name "already exists or is pending" -- reusing
    an already-known application across more than one request is the whole
    point of this shared registry, not a bug; only the two REJECTED cases
    above are ever blocked/reset.

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
        if existing.status == "REJECTED":
            if qa_request_id is not None and existing.qa_request_id == qa_request_id:
                raise HTTPException(
                    400,
                    "This application name was previously rejected by the Application Owner. "
                    "Please enter a corrected application name before resubmitting the request.",
                )
            existing.status = "PENDING_APP_OWNER"
            existing.requested_by_id = requester_id
            existing.department = department
            existing.qa_request_id = qa_request_id
            existing.app_owner_decided_by_id = None
            existing.app_owner_decided_at = None
            existing.app_owner_comments = None
            existing.decided_by_id = None
            existing.decided_at = None
            existing.comments = None
        return name_upper, existing.id
    new_entry = models.ApplicationMaster(
        name=name_upper, status="PENDING_APP_OWNER", department=department,
        requested_by_id=requester_id, qa_request_id=qa_request_id,
    )
    db.add(new_entry)
    db.flush()  # need new_entry.id to link it below
    return name_upper, new_entry.id


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
    old = db.query(models.ApplicationMaster).get(old_master_id)
    if not old or old.status not in ("PENDING_APP_OWNER", "PENDING_SM"):
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
