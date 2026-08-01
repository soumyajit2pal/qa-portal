import datetime
import json
import os
import shutil
import uuid
from typing import Optional, List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from .. import documents as doc_store
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import (
    Role, DEFAULT_CHECKLIST_ITEMS, DEFAULT_PERFORMANCE_CHECKLIST_ITEMS,
    DEFAULT_SAST_CHECKLIST_ITEMS, DEFAULT_DAST_CHECKLIST_ITEMS,
    FUNCTIONAL_BUCKET_TYPES, GatewayStatus, GATEWAY_EDITABLE_STATUSES, GATEWAY_CANCELLABLE_STATUSES,
    validate_environment_promotion, validate_target_release_date,
)
from ..pdf_export import build_request_detail_pdf

router = APIRouter(prefix="/api/qa-requests", tags=["qa-requests"])

# All uploaded documents live under backend/app/uploads/<request_id>/<filename>,
# e.g. app/uploads/TQA-REQ-20260721-A1B2C3/BRD_v2.pdf
UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)


def _log(db: Session, entity_id: int, step: str, user: models.User, decision: str, comments: Optional[str]):
    db.add(models.ApprovalAction(
        entity_type="QA_REQUEST", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _raise_child_to_sm(db: Session, child, entity_type: str, qa_request: "models.QARequest", current_user: models.User):
    """Every linked child request (Functional/SAST/DAST/Performance) now
    skips the old own-module Draft -> Submit stopover entirely: raising the
    QA Request itself immediately logs the same "Submitted" -> "SM Approval
    Pending" pair each child's own submit_request endpoint used to log once
    someone got around to clicking Submit on that module's own page (see
    routers/functional.py::submit_request / routers/sast_dast.py::_submit /
    routers/performance.py::submit_request for the original two-step this
    mirrors). If the Application Name was already rejected by the time this
    child is created (e.g. a sibling request's own screen rejected it first),
    the child is born already SM_REJECTED instead of SM_APPROVAL_PENDING --
    same auto-reject-on-arrival guard those endpoints applied at their own
    Submit."""
    db.add(models.ApprovalAction(
        entity_type=entity_type, entity_id=child.id, step_name="Requester",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Submitted", comments=None,
    ))
    if qa_request.application_master_status == "REJECTED":
        child.status = "SM_REJECTED"
        db.add(models.ApprovalAction(
            entity_type=entity_type, entity_id=child.id, step_name="SM Approval",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Rejected", comments="Auto-rejected: this request's Application Name was rejected by SM",
        ))
    else:
        child.status = "SM_APPROVAL_PENDING"
        db.add(models.ApprovalAction(
            entity_type=entity_type, entity_id=child.id, step_name="SM Approval",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Pending", comments="Awaiting SM decision",
        ))


_DRAFT_EVIDENCE_DEFINITIONS = {
    "functional": DEFAULT_CHECKLIST_ITEMS,
    "sast": DEFAULT_SAST_CHECKLIST_ITEMS,
    "dast": DEFAULT_DAST_CHECKLIST_ITEMS,
    "performance": DEFAULT_PERFORMANCE_CHECKLIST_ITEMS,
}
_DRAFT_EVIDENCE_PREFIXES = {
    "functional": "DRAFT_FUNCTIONAL",
    "sast": "DRAFT_SAST",
    "dast": "DRAFT_DAST",
    "performance": "DRAFT_PERF",
}


def _draft_evidence_module(kind: str, item_index: int) -> str:
    """Stable storage key for evidence selected before child checklist rows
    exist. The index refers to the corresponding fixed checklist definition;
    the document is re-keyed to the real child item during submit."""
    definitions = _DRAFT_EVIDENCE_DEFINITIONS.get(kind)
    if definitions is None:
        raise HTTPException(404, "Unknown readiness checklist")
    if item_index < 0 or item_index >= len(definitions):
        raise HTTPException(404, "Checklist item not found")
    return f"{_DRAFT_EVIDENCE_PREFIXES[kind]}_{item_index:02d}"


def _promote_draft_checklist_evidence(db: Session, qa_request: "models.QARequest") -> None:
    """Moves Draft-wizard evidence onto the actual checklist rows created by
    _sync_linked_child_requests. Only database keys change; stored_path keeps
    pointing at the same physical file, so promotion is atomic with submit."""
    db.flush()
    destinations = [
        ("functional", "FUNCTIONAL_ITEM", models.ReadinessChecklistItem,
         "functional_request_id", models.FunctionalRequest),
        ("sast", "SAST_ITEM", models.SASTChecklistItem,
         "sast_request_id", models.SASTRequest),
        ("dast", "DAST_ITEM", models.DASTChecklistItem,
         "dast_request_id", models.DASTRequest),
        ("performance", "PERFORMANCE_ITEM", models.PerformanceChecklistItem,
         "performance_request_id", models.PerformanceRequest),
    ]
    for kind, destination_module, item_model, parent_fk, parent_model in destinations:
        parent = db.query(parent_model).filter_by(qa_request_id=qa_request.id).first()
        if not parent:
            continue
        checklist_by_name = {
            row.item: row for row in db.query(item_model).filter(
                getattr(item_model, parent_fk) == parent.id).all()
        }
        for index, definition in enumerate(_DRAFT_EVIDENCE_DEFINITIONS[kind]):
            item = checklist_by_name.get(definition[0])
            if not item:
                continue
            staged = db.query(models.RequestDocument).filter_by(
                module=_draft_evidence_module(kind, index), request_id=qa_request.id).all()
            for document in staged:
                document.module = destination_module
                document.request_id = item.id


def _resolve_application_name(db: Session, name: Optional[str], department: Optional[str],
                               requester_id: int, qa_request_id: Optional[int] = None):
    """Called on every create/edit of a QA Request -- uppercases the given
    Application Name (minimises case-sensitivity duplicates, e.g. "sbi" vs
    "SBI") and resolves it against models.ApplicationMaster:
      - an existing APPROVED or still-PENDING row for that exact name is
        just reused as-is;
      - a REJECTED row is flipped back to PENDING and re-attributed to this
        requester/department/request, treating this as a fresh proposal
        (whatever earlier issue got it rejected may no longer apply);
      - otherwise a brand-new PENDING row is created.
    This never blocks the caller -- see the class docstring on
    models.ApplicationMaster for why Draft save and Submit/Raise both
    proceed regardless of the name's current approval status (approving/
    rejecting a name is handled independently by an SM, see
    routers/applications.py). Returns (uppercased_name, application_master_id).

    Note: if a requester changes their mind mid-Draft and swaps one brand-new
    (still-PENDING) name for a different brand-new name, the first name's
    ApplicationMaster row is simply left behind, still PENDING and still
    linked via qa_request_id to this same request even though the request no
    longer uses that name -- a minor, rare bit of queue clutter for an SM to
    reject/ignore, not worth extra bookkeeping to prevent."""
    name_upper = (name or "").strip().upper()
    existing = db.query(models.ApplicationMaster).filter(models.ApplicationMaster.name == name_upper).first()
    if existing:
        if existing.status == "REJECTED":
            existing.status = "PENDING"
            existing.requested_by_id = requester_id
            existing.department = department
            existing.qa_request_id = qa_request_id
            existing.decided_by_id = None
            existing.decided_at = None
            existing.comments = None
        return name_upper, existing.id
    new_entry = models.ApplicationMaster(
        name=name_upper, status="PENDING", department=department,
        requested_by_id=requester_id, qa_request_id=qa_request_id,
    )
    db.add(new_entry)
    db.flush()  # need new_entry.id to link it below
    return name_upper, new_entry.id


def _stash_draft_details(checked_items: Optional[set], sast_components: list, dast_components: list,
                          performance_details: dict,
                          performance_checked_items: Optional[set] = None,
                          classification_details: Optional[dict] = None,
                          sast_checked_items: Optional[set] = None,
                          dast_checked_items: Optional[set] = None) -> str:
    """Serializes everything a Draft's wizard steps collected for its
    not-yet-created child request(s) -- see QARequest.draft_child_details.
    Only meaningful while the gateway is still DRAFT; consumed (and read
    back via _unstash_draft_details) once by submit_request. sast_components/
    dast_components are each a list of dicts (one per repository/target row --
    see schemas.SASTComponentIn/DASTTargetIn), not joined strings -- same
    structure that ends up in models.SASTComponent/DASTTarget rows once the
    child request is actually created. performance_checked_items/
    sast_checked_items/dast_checked_items all mirror checked_items
    (Functional's readiness checklist self-declaration) but for Performance's/
    SAST's/DAST's own DEFAULT_PERFORMANCE_CHECKLIST_ITEMS/
    DEFAULT_SAST_CHECKLIST_ITEMS/DEFAULT_DAST_CHECKLIST_ITEMS.
    classification_details is a single merged dict carrying every
    per-request-type Priority/Risk field (functional_priority,
    sast_risk_category, etc. -- see schemas.QARequestCreate) -- one dict
    rather than yet more discrete tuple members, since none of the keys
    collide across modules."""
    return json.dumps({
        "checked_items": sorted(checked_items) if checked_items else [],
        "sast_components": sast_components or [],
        "dast_components": dast_components or [],
        "performance": performance_details or {},
        "performance_checked_items": sorted(performance_checked_items) if performance_checked_items else [],
        "classification": classification_details or {},
        "sast_checked_items": sorted(sast_checked_items) if sast_checked_items else [],
        "dast_checked_items": sorted(dast_checked_items) if dast_checked_items else [],
    })


def _unstash_draft_details(raw: Optional[str]):
    if not raw:
        return set(), [], [], {}, set(), {}, set(), set()
    data = json.loads(raw)
    return (
        set(data.get("checked_items") or []),
        data.get("sast_components") or [],
        data.get("dast_components") or [],
        data.get("performance") or {},
        set(data.get("performance_checked_items") or []),
        data.get("classification") or {},
        set(data.get("sast_checked_items") or []),
        set(data.get("dast_checked_items") or []),
    )


@router.get("", response_model=List[schemas.QARequestOut])
def list_requests(status_filter: Optional[str] = None, department: Optional[str] = None,
                   application_name: Optional[str] = None, search: Optional[str] = None,
                   db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    q = db.query(models.QARequest)
    if status_filter:
        q = q.filter(models.QARequest.status == status_filter)
    if department:
        q = q.filter(models.QARequest.department == department)
    if application_name:
        q = q.filter(models.QARequest.application_name.ilike(f"%{application_name}%"))
    if search:
        # Broad "requests or IDs" search (topbar search box and the
        # QA Requests list's own search field) -- matches Request ID,
        # Application Name, or Epic Number, not just application name.
        like = f"%{search}%"
        q = q.filter(or_(
            models.QARequest.request_id.ilike(like),
            models.QARequest.application_name.ilike(like),
            models.QARequest.epic_number.ilike(like),
        ))
    return q.order_by(models.QARequest.created_at.desc()).all()


@router.get("/{req_id}", response_model=schemas.QARequestOut)
def get_request(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    return obj


def _sync_linked_child_requests(db: Session, qa_request: "models.QARequest", request_types: list,
                                 current_user: models.User,
                                 checked_items: Optional[set] = None,
                                 sast_components: Optional[list] = None, dast_components: Optional[list] = None,
                                 performance_details: Optional[dict] = None,
                                 performance_checked_items: Optional[set] = None,
                                 classification: Optional[dict] = None,
                                 sast_checked_items: Optional[set] = None,
                                 dast_checked_items: Optional[set] = None):
    """Auto-creates a linked Functional/SAST/DAST/Performance request when
    the QA Request's request_types include the matching type(s), so each
    still gets its own trackable unique ID (via the normal
    TQA-FUNC-.../SAST-.../DAST-.../PERF-... generator) while staying linked
    back to the originating gateway QA Request. Only creates what's missing
    -- calling this again after request_types changes won't duplicate an
    existing link. Standalone requests raised directly via their own modules
    are untouched by this and simply keep qa_request_id = None.

    Every child created here is immediately routed straight to its own SM
    Approval Pending (or SM Rejected, if the Application Name was already
    rejected) via _raise_child_to_sm -- there is no separate per-module Draft
    -> Submit stopover anymore; raising the gateway QA Request is the one
    and only "submit" action for every linked child.

    The QA Request itself is a pure intake/gateway record with no workflow of
    its own ("QA request form will be the gateway only" per request) --
    Functional Testing/Sanity Testing/Regression Testing/UAT Support (any of
    these) are combined into a single FunctionalRequest carrying the full
    SM -> Department Head -> ... -> Closed lifecycle that used to live
    directly on QARequest; see models.FunctionalRequest and
    routers/functional.py."""
    classification = classification or {}
    existing_types = set()
    if any(True for _ in qa_request.linked_functional_requests):
        existing_types.add("FUNCTIONAL")
    if any(True for _ in qa_request.linked_sast_requests):
        existing_types.add("SAST")
    if any(True for _ in qa_request.linked_dast_requests):
        existing_types.add("DAST")
    if any(True for _ in qa_request.linked_performance_requests):
        existing_types.add("Performance Testing")

    wants_functional = any(t in request_types for t in FUNCTIONAL_BUCKET_TYPES)
    if wants_functional and "FUNCTIONAL" not in existing_types:
        functional = models.FunctionalRequest(
            requester_id=qa_request.requester_id,
            qa_request_id=qa_request.id,
            priority=classification.get("functional_priority"),
            risk_rating=classification.get("functional_risk_rating"),
        )
        db.add(functional)
        db.flush()  # need functional.id before the checklist items below can reference it
        checked_set = checked_items or set()
        for item, owner, is_mandatory in DEFAULT_CHECKLIST_ITEMS:
            # `requester_checked` is the requester's own self-declaration made
            # at raise-time -- it is reference/pre-fill only. It does NOT set
            # `is_complete`; the QA Lead must still independently verify every
            # item during Readiness Verification. None of these items are
            # mandatory (see constants.DEFAULT_CHECKLIST_ITEMS).
            db.add(models.ReadinessChecklistItem(
                functional_request_id=functional.id, item=item, owner=owner,
                is_mandatory=is_mandatory,
                requester_checked=item in checked_set,
            ))
        _raise_child_to_sm(db, functional, "FUNCTIONAL_REQUEST", qa_request, current_user)

    if "SAST" in request_types and "SAST" not in existing_types:
        sast = models.SASTRequest(
            application_name=qa_request.application_name,
            epic_number=qa_request.epic_number,
            cr_number=qa_request.cr_number,
            risk_category=classification.get("sast_risk_category"),
            priority=classification.get("sast_priority"),
            # Optional -- collected alongside Repository Details on the QA
            # Request wizard's SAST step now, instead of being left entirely
            # blank at intake with no way to fill it in until the SAST
            # request's own Edit Details (which used to wrongly mark it
            # mandatory there despite it never being collected up front).
            hash_value=classification.get("sast_hash_value"),
            requester_id=qa_request.requester_id,
            qa_request_id=qa_request.id,
        )
        db.add(sast)
        db.flush()  # need sast.id before the component rows below can reference it
        # Filled in directly on the QA Request form (shown only while "SAST"
        # is ticked) instead of being left as placeholders for the requester
        # to fill in later on the SAST module page -- one row per repository
        # (see models.SASTComponent).
        for c in (sast_components or []):
            db.add(models.SASTComponent(
                sast_request_id=sast.id,
                repository_url=c.get("repository_url"),
                git_branch=c.get("git_branch"),
                commit_id=c.get("commit_id"),
                technology_stack=c.get("technology_stack"),
                build_number=c.get("build_number"),
            ))
        # "Security Readiness" pre-scan checklist (see
        # constants.DEFAULT_SAST_CHECKLIST_ITEMS). requester_checked is the
        # requester's own self-declaration made at raise-time on the QA
        # Request wizard's SAST step -- same pattern as Functional's
        # checklist; can also still be revisited afterward from
        # the SAST request's own Edit Details modal (see update_sast's
        # checked_items). Mandatory items here block Submit itself, not just
        # Security Readiness -- see routers/sast_dast.py::_require_checklist_ready.
        sast_checked_set = sast_checked_items or set()
        for item, owner, is_mandatory in DEFAULT_SAST_CHECKLIST_ITEMS:
            db.add(models.SASTChecklistItem(
                sast_request_id=sast.id, item=item, owner=owner, is_mandatory=is_mandatory,
                requester_checked=item in sast_checked_set,
            ))
        _raise_child_to_sm(db, sast, "SAST", qa_request, current_user)
    if "DAST" in request_types and "DAST" not in existing_types:
        dast = models.DASTRequest(
            risk_category=classification.get("dast_risk_category"),
            priority=classification.get("dast_priority"),
            requester_id=qa_request.requester_id,
            qa_request_id=qa_request.id,
        )
        db.add(dast)
        db.flush()  # need dast.id before the target rows below can reference it
        # Filled in directly on the QA Request form (shown only while "DAST"
        # is ticked) -- one row per target URL (see models.DASTTarget). Falls
        # back to a single placeholder target only if none were added at all,
        # so this request always has at least one row to edit. No
        # target_release here -- Target Release Date is already collected
        # once, on the QA Request itself (see DASTRequest.target_release_date).
        targets = dast_components or [{}]
        for t in targets:
            db.add(models.DASTTarget(
                dast_request_id=dast.id,
                application_url=t.get("application_url") or f"To be confirmed — linked from {qa_request.request_id}",
                environment=t.get("environment") or qa_request.environment,
                authentication_required=t.get("authentication_required") or "No",
                test_credentials=t.get("test_credentials"),
            ))
        # Same "Security Readiness" checklist pattern as SAST above (own item
        # list, constants.DEFAULT_DAST_CHECKLIST_ITEMS, own self-declaration
        # set from the QA Request wizard's DAST step) -- see the comment
        # there for the full reasoning.
        dast_checked_set = dast_checked_items or set()
        for item, owner, is_mandatory in DEFAULT_DAST_CHECKLIST_ITEMS:
            db.add(models.DASTChecklistItem(
                dast_request_id=dast.id, item=item, owner=owner, is_mandatory=is_mandatory,
                requester_checked=item in dast_checked_set,
            ))
        _raise_child_to_sm(db, dast, "DAST", qa_request, current_user)
    if "Performance Testing" in request_types and "Performance Testing" not in existing_types:
        pd = performance_details or {}
        performance = models.PerformanceRequest(
            application_name=qa_request.application_name,
            epic_number=qa_request.epic_number,
            cr_number=qa_request.cr_number,
            environment=qa_request.environment,
            # performance_risk_category/performance_priority land in `pd`
            # naturally via the "performance_" prefix sweep in create_request/
            # edit_request (same sweep that already catches
            # performance_request_type below) -- no separate classification
            # dict needed here, unlike Functional/SAST/DAST.
            risk_category=pd.get("performance_risk_category"),
            priority=pd.get("performance_priority"),
            requester_id=qa_request.requester_id,
            qa_request_id=qa_request.id,
            # request_type (Load/Stress/Spike Testing) is Performance-specific
            # and has no gateway equivalent, so it's still collected on the QA
            # Request wizard's Performance step. change_type/vendor_si_partner/
            # technology_stack/release_version/build_number/
            # target_promotion_environment are NOT re-collected there anymore
            # -- they're delegated straight from the gateway's own
            # "Application & Change Details" fields (same values the requester
            # already typed once), matching how application_name/epic_number/
            # environment above are delegated too (risk_category/priority are
            # NOT delegated -- collected on this request type's own step, see
            # above). hash_value has no gateway equivalent either, so it's
            # simply left blank at intake and can be filled in later on this
            # request's own page.
            request_type=pd.get("performance_request_type"),
            change_type=qa_request.change_type,
            vendor_si_partner=qa_request.vendor_si_partner,
            technology_stack=qa_request.technology_stack,
            release_version=qa_request.release_version,
            build_number=qa_request.build_number,
            hash_value=None,
            target_promotion_environment=qa_request.target_promotion_environment,
        )
        db.add(performance)
        db.flush()  # need performance.id before the checklist items below can reference it
        # "L1: Pre-Testing Readiness Checklist" (Annexure VIII) -- 19 fixed
        # items, none mandatory (see constants.DEFAULT_PERFORMANCE_CHECKLIST_ITEMS).
        # requester_checked is the requester's own self-declaration made at
        # raise-time (see the QA Request wizard's Performance step) -- same
        # pattern as Functional's checklist; it does NOT set
        # is_complete, which QA still independently verifies (see
        # routers/performance.py::update_checklist_item).
        performance_checked_set = performance_checked_items or set()
        for item, data_required in DEFAULT_PERFORMANCE_CHECKLIST_ITEMS:
            db.add(models.PerformanceChecklistItem(
                performance_request_id=performance.id, item=item, data_required=data_required,
                is_mandatory=False,
                requester_checked=item in performance_checked_set,
            ))
        _raise_child_to_sm(db, performance, "PERFORMANCE", qa_request, current_user)


@router.post("", response_model=schemas.QARequestOut)
def create_request(payload: schemas.QARequestCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST))):
    """Creates the gateway request in Draft ONLY -- no linked child request
    (Functional/SAST/DAST/Performance) is created yet, even if
    SAST/DAST/etc. detail fields were filled in on the wizard. Those details
    are stashed on draft_child_details instead, and only turned into real,
    ID-bearing child requests once POST /{id}/submit actually raises this
    gateway record -- see _sync_linked_child_requests / submit_request."""
    data = payload.model_dump()
    # Department is always sourced from the requester's own user profile, not
    # from client input -- ignore whatever the payload sent.
    data["department"] = current_user.department
    request_types = data.pop("request_types", [])
    checked_items = set(data.pop("checked_items", []) or [])
    # SAST/DAST/Performance detail fields aren't columns on QARequest itself
    # -- they're stashed (see draft_child_details) until submit time, when
    # they seed whichever child request actually gets created. sast_components/
    # dast_components are each a list of per-row dicts (repository/target),
    # not joined strings -- see schemas.SASTComponentIn/DASTTargetIn.
    sast_components = data.pop("sast_components", []) or []
    dast_components = data.pop("dast_components", []) or []
    # Popped explicitly before the generic "sast_"/"dast_" prefix sweeps
    # below (part of classification_details), since their own names also
    # start with "sast_"/"dast_" and would otherwise get swept in there
    # instead of being kept as their own self-declaration sets (same pattern
    # as performance_checked_items).
    sast_checked_items = set(data.pop("sast_checked_items", []) or [])
    dast_checked_items = set(data.pop("dast_checked_items", []) or [])
    # Popped explicitly before the generic "performance_" prefix sweep below,
    # since its own name also starts with "performance_" and would otherwise
    # get swept into performance_details instead of being kept as its own
    # self-declaration set.
    performance_checked_items = set(data.pop("performance_checked_items", []) or [])
    performance_details = {k: data.pop(k) for k in list(data) if k.startswith("performance_")}
    # Per-request-type Priority/Risk fields (see schemas.QARequestCreate) --
    # merged into one dict since none of the keys collide across modules.
    # sast_components/dast_components and sast_checked_items/dast_checked_items
    # are already popped above, so these sweeps only catch each module's own
    # priority/risk_category fields, not those.
    # performance_priority/performance_risk_category were already swept into performance_details
    # above (its "performance_" sweep runs before this) -- read back out of
    # `pd` in _sync_linked_child_requests instead of duplicated here.
    classification_details = {
        **{k: data.pop(k) for k in list(data) if k.startswith("functional_")},
        **{k: data.pop(k) for k in list(data) if k.startswith("sast_")},
        **{k: data.pop(k) for k in list(data) if k.startswith("dast_")},
    }
    # Popped explicitly -- upper-cased right away so the constructor below
    # always gets a valid, non-null value (application_name is NOT NULL on
    # qap_requests -- passing it through as None until _resolve_application_name
    # ran post-flush caused exactly that ORA-01400 on every create). The
    # Application Name Master link (application_master_id) is still only
    # resolved after flush, once this row has an id to link back to.
    application_name_in = data.pop("application_name")
    name_upper = (application_name_in or "").strip().upper()
    # Target Promotion Environment must sit strictly later than Deployment
    # Environment in the SIT -> UAT -> Pre-Production -> Production pipeline
    # -- reported directly (e.g. Deployment=UAT must force
    # Target=Pre-Production/Production). DetailsStep.tsx already filters the
    # Target dropdown's options down to this same rule client-side, but that
    # alone doesn't stop a stale/tampered request, so it's enforced here too.
    try:
        validate_environment_promotion(data.get("environment"), data.get("target_promotion_environment"))
        validate_target_release_date(data.get("target_release_date"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    obj = models.QARequest(
        **data, application_name=name_upper, request_types=",".join(request_types), requester_id=current_user.id,
        status=GatewayStatus.DRAFT,
        draft_child_details=_stash_draft_details(
            checked_items, sast_components, dast_components, performance_details,
            performance_checked_items, classification_details,
            sast_checked_items=sast_checked_items, dast_checked_items=dast_checked_items,
        ),
    )
    db.add(obj)
    db.flush()
    _, obj.application_master_id = _resolve_application_name(
        db, name_upper, data["department"], current_user.id, qa_request_id=obj.id,
    )
    _log(db, obj.id, "Requester", current_user, "Drafted", "QA Request created as draft")
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{req_id}", response_model=schemas.QARequestOut)
def edit_request(req_id: int, payload: schemas.QARequestUpdate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can edit this request")
    if obj.status not in GATEWAY_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    # GATEWAY_EDITABLE_STATUSES is Draft-only, so no linked child request
    # exists yet at this point (see submit_request) -- editing here just
    # means updating the still-Draft gateway fields and its stashed
    # draft_child_details, never touching/creating any child request.
    data = payload.model_dump(exclude_unset=True)
    # Department tracks the requester's own profile, not something edited per-request.
    data.pop("department", None)
    request_types = data.pop("request_types", None)
    checked_items = data.pop("checked_items", None)
    # SAST/DAST/Performance detail fields aren't columns on QARequest itself
    # -- merge them into the stashed draft_child_details below instead of
    # seeding any child request directly (there isn't one yet). sast_components/
    # dast_components, when sent at all, replace the previously-stashed list
    # wholesale (same "+"-driven repeatable-list semantics as SASTUpdate/
    # DASTUpdate once the real child request exists) rather than being
    # merged field-by-field.
    sast_components = data.pop("sast_components", None)
    dast_components = data.pop("dast_components", None)
    # Popped explicitly before the generic "sast_"/"dast_" prefix sweeps
    # below -- see the matching comment in create_request.
    sast_checked_items = data.pop("sast_checked_items", None)
    dast_checked_items = data.pop("dast_checked_items", None)
    # Popped explicitly before the generic "performance_" prefix sweep below --
    # see the matching comment in create_request.
    performance_checked_items = data.pop("performance_checked_items", None)
    performance_details = {k: data.pop(k) for k in list(data) if k.startswith("performance_")}
    # Same merged classification dict as create_request -- popped before the
    # setattr loop below since none of these are columns on QARequest itself.
    classification_details = {
        **{k: data.pop(k) for k in list(data) if k.startswith("functional_")},
        **{k: data.pop(k) for k in list(data) if k.startswith("sast_")},
        **{k: data.pop(k) for k in list(data) if k.startswith("dast_")},
    }
    # Popped explicitly -- only re-resolved against the Application Name
    # Master (see _resolve_application_name) if the requester actually sent
    # a value; exclude_unset=True above means it's simply absent otherwise,
    # in which case obj.application_name/application_master_id are left
    # untouched entirely (re-resolving an unchanged, already-APPROVED name
    # would be a harmless no-op anyway, but there's no reason to bother).
    application_name_in = data.pop("application_name", None)
    # Same Deployment/Target Promotion Environment ordering rule as
    # create_request -- resolved against whichever of the two fields wasn't
    # part of this particular (partial, exclude_unset=True) edit, since
    # re-saving just one of them still needs to be checked against the
    # other's already-saved value, not treated as if it were blank.
    final_environment = data.get("environment", obj.environment)
    final_target = data.get("target_promotion_environment", obj.target_promotion_environment)
    try:
        validate_environment_promotion(final_environment, final_target)
        validate_target_release_date(data.get("target_release_date", obj.target_release_date))
    except ValueError as e:
        raise HTTPException(400, str(e))
    for k, v in data.items():
        setattr(obj, k, v)

    if application_name_in is not None:
        obj.application_name, obj.application_master_id = _resolve_application_name(
            db, application_name_in, obj.department, current_user.id, qa_request_id=obj.id,
        )

    if request_types is not None:
        obj.request_types = ",".join(request_types)

    # Merge whatever changed on top of what was already stashed, rather than
    # overwriting wholesale -- e.g. re-saving the SAST step alone shouldn't
    # blank out Performance details already captured on an earlier save.
    prev_checked, prev_sast, prev_dast, prev_perf, prev_performance_checked, prev_classification, prev_sast_checked, prev_dast_checked = _unstash_draft_details(obj.draft_child_details)
    merged_checked = set(checked_items) if checked_items is not None else prev_checked
    merged_sast = sast_components if sast_components is not None else prev_sast
    merged_dast = dast_components if dast_components is not None else prev_dast
    merged_perf = {**prev_perf, **performance_details} if performance_details else prev_perf
    merged_performance_checked = set(performance_checked_items) if performance_checked_items is not None else prev_performance_checked
    merged_classification = {**prev_classification, **classification_details} if classification_details else prev_classification
    merged_sast_checked = set(sast_checked_items) if sast_checked_items is not None else prev_sast_checked
    merged_dast_checked = set(dast_checked_items) if dast_checked_items is not None else prev_dast_checked
    obj.draft_child_details = _stash_draft_details(
        merged_checked, merged_sast, merged_dast, merged_perf,
        merged_performance_checked, merged_classification,
        sast_checked_items=merged_sast_checked, dast_checked_items=merged_dast_checked,
    )

    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/cancel", response_model=schemas.QARequestOut)
def cancel_request(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can cancel this request")
    # The gateway can only be cancelled while still in Draft (i.e. before it's
    # ever been raised) -- once raised, its linked child request(s) have their
    # own independent workflows and are each cancelled/rejected on their own.
    if obj.status not in GATEWAY_CANCELLABLE_STATUSES:
        raise HTTPException(
            400,
            f"Request is already '{obj.status}' and can no longer be cancelled -- only a still-Draft "
            "(not yet raised) request can be cancelled here.",
        )
    obj.status = GatewayStatus.CANCELLED
    _log(db, obj.id, "Requester", current_user, "Cancelled", None)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{req_id}/submit", response_model=schemas.QARequestOut)
def submit_request(req_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.REQUESTER, Role.BUSINESS_ANALYST))):
    """Raises the request: creates whichever linked child request(s) the
    selected request_types call for -- this is the only place they're ever
    created (see create_request/edit_request, which merely stash their
    detail fields on draft_child_details while still Draft) -- then moves
    the gateway straight to Raised -- there is no approval step on the
    gateway itself. Every linked child is created already routed straight to
    its own SM Approval Pending (or SM Rejected) via _sync_linked_child_requests
    / _raise_child_to_sm -- there is no separate per-module Draft -> Submit
    stopover anymore; raising the gateway is the one and only "submit" action
    for every linked child."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    if obj.status != GatewayStatus.DRAFT:
        raise HTTPException(400, f"'Submit' requires status 'DRAFT' (currently '{obj.status}')")
    request_types = obj.request_types.split(",") if obj.request_types else []
    # This is the one and only point where linked child request(s) actually
    # get created -- everything collected on the wizard's SAST/DAST/
    # Performance steps (and the readiness-checklist self-declaration ticks)
    # was just sitting in draft_child_details until now (see create_request/
    # edit_request). "Linked Requests" is correctly empty right up until
    # this call.
    checked_items, sast_components, dast_components, performance_details, performance_checked_items, classification_details, sast_checked_items, dast_checked_items = _unstash_draft_details(obj.draft_child_details)
    # Every linked child now lands straight at SM_APPROVAL_PENDING with no
    # separate per-module Submit click of its own (see _raise_child_to_sm),
    # so the mandatory Security Readiness checklist gate that used to only
    # fire on SAST/DAST's own subsequent submit (routers/sast_dast.py::
    # _require_checklist_ready) has to be enforced here instead, before that
    # child is ever created -- otherwise a requester could raise the gateway
    # with a mandatory item still unchecked and the linked SAST/DAST request
    # would be born already sitting at SM Approval despite that. Scoped to
    # SAST/DAST only -- Functional/Performance have no such gate by design.

    pending_checklist_items = []
    print(request_types)
    if "Functional Testing" in request_types:
        print("here")
        functional_checked_set = set(checked_items)
        print("fun", functional_checked_set)
        pending_checklist_items += [
            item for item, owner, is_mandatory in DEFAULT_CHECKLIST_ITEMS
            if is_mandatory and item not in functional_checked_set
        ]
        print("Pend",pending_checklist_items)

    pending_checklist_items = []
    if "SAST" in request_types:
        sast_checked_set = set(sast_checked_items)
        pending_checklist_items += [
            item for item, owner, is_mandatory in DEFAULT_SAST_CHECKLIST_ITEMS
            if is_mandatory and item not in sast_checked_set
        ]
    if "DAST" in request_types:
        dast_checked_set = set(dast_checked_items)
        pending_checklist_items += [
            item for item, owner, is_mandatory in DEFAULT_DAST_CHECKLIST_ITEMS
            if is_mandatory and item not in dast_checked_set
        ]
    if pending_checklist_items:
        raise HTTPException(
            400,
            "Cannot raise -- the following mandatory Security Readiness checklist "
            "item(s) must be self-declared ready first (Edit Request): "
            + "; ".join(pending_checklist_items),
        )
    _sync_linked_child_requests(db, obj, request_types, current_user, checked_items, sast_components, dast_components,
                                 performance_details,
                                 performance_checked_items=performance_checked_items,
                                 classification=classification_details,
                                 sast_checked_items=sast_checked_items,
                                 dast_checked_items=dast_checked_items)
    _promote_draft_checklist_evidence(db, obj)
    obj.draft_child_details = None  # consumed -- no longer needed once raised
    obj.status = GatewayStatus.SUBMITTED
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    obj.status = GatewayStatus.RAISED
    _log(db, obj.id, "Requester", current_user, "Raised",
         "Linked request(s) raised with their own independent ID(s); workflow now handled on each separately")
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def request_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="QA_REQUEST", entity_id=req_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{req_id}/export")
def export_request(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this gateway record, plus the full Gateway Actions
    approval history (who submitted/raised/cancelled it and when), as one
    downloadable PDF -- the offline/printable record of the intake request
    itself. Each linked child request (Functional QA/SAST/DAST/
    Performance) has its own, separate export covering its own full
    workflow -- this one only covers the gateway's own short Draft ->
    Submitted -> Raised lifecycle."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")

    linked = []
    linked += [f"Functional QA {f.request_id}" for f in obj.linked_functional_requests]
    linked += [f"SAST {s.request_id}" for s in obj.linked_sast_requests]
    linked += [f"DAST {d.request_id}" for d in obj.linked_dast_requests]
    linked += [f"Performance {p.request_id}" for p in obj.linked_performance_requests]

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Requester", obj.requester.full_name if obj.requester else None),
            ("Department", obj.department),
            ("Linked Requests", ", ".join(linked) if linked else None),
        ]),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Application Owner", obj.application_owner),
            ("Epic Number", obj.epic_number),
            ("Change Request ID(s)", obj.cr_number),
            ("Change Type", obj.change_type),
            ("Vendor / SI Partner", obj.vendor_si_partner),
            ("Technology Stack", obj.technology_stack),
        ]),
        ("Environment & Release", [
            ("Deployment Environment", obj.environment),
            ("Target Promotion Environment", obj.target_promotion_environment),
            ("Release Version / Hash Value", obj.release_version),
            ("Build Number / Hash Value", obj.build_number),
            ("Target Release Date", obj.target_release_date),
        ]),
        ("Request Details", [
            ("Request Type(s)", obj.request_types),
            ("Other Request Type", obj.request_type_other),
            ("Remarks", obj.remarks),
            ("Raised On", obj.created_at),
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="QA_REQUEST", entity_id=req_id)
                     .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in history_rows:
        actor = db.query(models.User).get(h.actor_id) if h.actor_id else None
        history.append((h.step_name or "—", h.decision or "—", actor.full_name if actor else "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.request_id} — {obj.application_name}",
        subtitle="QA Request (Gateway) — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=datetime.datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M IST"),

    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.request_id}.pdf"'},
    )


# ---- Supporting documents (Module 1, field 4.1.2 -- multiple files per request) ----

# Evidence selected beside readiness items while the gateway is still a
# Draft. Child checklist IDs do not exist yet; these files are staged by the
# fixed checklist index, then promoted by submit_request above.
def _draft_request_for_evidence(db: Session, req_id: int, current_user: models.User,
                                require_editable: bool = False):
    req = db.query(models.QARequest).get(req_id)
    if not req:
        raise HTTPException(404, "QA Request not found")
    if require_editable:
        if req.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
            raise HTTPException(403, "Only the requester or an admin can attach checklist evidence")
        if req.status != GatewayStatus.DRAFT:
            raise HTTPException(400, "Checklist evidence can only be changed while the QA Request is in Draft")
    return req


@router.get("/{req_id}/checklist-evidence/{kind}/{item_index}/documents", response_model=List[schemas.RequestDocumentOut])
def list_draft_checklist_evidence(req_id: int, kind: str, item_index: int,
                                  db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    _draft_request_for_evidence(db, req_id, current_user)
    return doc_store.list_documents(db, _draft_evidence_module(kind, item_index), req_id)


@router.post("/{req_id}/checklist-evidence/{kind}/{item_index}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_draft_checklist_evidence(req_id: int, kind: str, item_index: int,
                                    files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                    current_user: models.User = Depends(get_current_user)):
    req = _draft_request_for_evidence(db, req_id, current_user, require_editable=True)
    module = _draft_evidence_module(kind, item_index)
    return doc_store.save_documents(db, module, req_id,
                                    f"{req.request_id}/{kind}-{item_index}", files, current_user.id)


@router.get("/{req_id}/checklist-evidence/{kind}/{item_index}/documents/{doc_id}/download")
def download_draft_checklist_evidence(req_id: int, kind: str, item_index: int, doc_id: int,
                                      db: Session = Depends(get_db),
                                      current_user: models.User = Depends(get_current_user)):
    _draft_request_for_evidence(db, req_id, current_user)
    doc = doc_store.get_document_or_404(
        db, _draft_evidence_module(kind, item_index), req_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name,
                        media_type=doc.content_type or "application/octet-stream")


@router.delete("/{req_id}/checklist-evidence/{kind}/{item_index}/documents/{doc_id}")
def delete_draft_checklist_evidence(req_id: int, kind: str, item_index: int, doc_id: int,
                                    db: Session = Depends(get_db),
                                    current_user: models.User = Depends(get_current_user)):
    _draft_request_for_evidence(db, req_id, current_user, require_editable=True)
    doc = doc_store.get_document_or_404(
        db, _draft_evidence_module(kind, item_index), req_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user):
        raise HTTPException(403, "Only whoever uploaded this evidence, or an admin, can delete it")
    doc_store.delete_document(db, doc)
    return {"ok": True}


@router.get("/{req_id}/documents", response_model=List[schemas.QARequestDocumentOut])
def list_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return (db.query(models.QARequestDocument)
            .filter_by(qa_request_id=req_id)
            .order_by(models.QARequestDocument.uploaded_at).all())


@router.post("/{req_id}/documents", response_model=List[schemas.QARequestDocumentOut])
def upload_documents(req_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    """Accepts one or more files (multipart/form-data, field name 'files') and
    stores them under UPLOAD_ROOT/<request_id>/, named to avoid collisions.

    Reported bug: this previously only checked that the caller held ANY of
    Requester/Business Analyst/QA Engineer/QA Lead -- meaning any user with
    one of those roles could upload to *any* QA Request, not just their own.
    The gateway QA Request has no approval workflow of its own (see
    models.QARequest's docstring -- it's a pure intake/gateway record, Draft/
    Submitted/Raised/Cancelled only, with every actual decision happening on
    its linked child requests instead), so there's no "current stage owner"
    to widen this to the way the linked Functional/SAST/DAST/Performance
    requests' own upload endpoints do -- just the request's own requester
    (or an admin)."""
    req = db.query(models.QARequest).get(req_id)
    if not req:
        raise HTTPException(404, "QA Request not found")
    if req.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only this request's own requester or an admin can upload documents")

    request_dir = os.path.join(UPLOAD_ROOT, req.request_id)
    os.makedirs(request_dir, exist_ok=True)

    created = []
    for f in files:
        original_name = os.path.basename(f.filename or "unnamed_file")
        dest_path = os.path.join(request_dir, original_name)
        if os.path.exists(dest_path):
            stem, ext = os.path.splitext(original_name)
            original_name = f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
            dest_path = os.path.join(request_dir, original_name)

        with open(dest_path, "wb") as out:
            shutil.copyfileobj(f.file, out)

        doc = models.QARequestDocument(
            qa_request_id=req.id,
            file_name=f.filename or original_name,
            stored_path=os.path.join(req.request_id, original_name),
            content_type=f.content_type,
            file_size=os.path.getsize(dest_path),
            uploaded_by_id=current_user.id,
        )
        db.add(doc)
        created.append(doc)

    db.commit()
    for d in created:
        db.refresh(d)
    return created


@router.get("/{req_id}/documents/{doc_id}/download")
def download_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    doc = db.query(models.QARequestDocument).filter_by(id=doc_id, qa_request_id=req_id).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    full_path = os.path.join(UPLOAD_ROOT, doc.stored_path)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name,
                         media_type=doc.content_type or "application/octet-stream")


@router.delete("/{req_id}/documents/{doc_id}")
def delete_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    # Own document table/UPLOAD_ROOT layout (UPLOAD_ROOT/<request_id>/<filename>,
    # not documents.py's UPLOAD_ROOT/<module>/<folder>/<filename>), so this
    # can't call doc_store.delete_document() -- only reuses doc_store's
    # can_delete_document() for the permission check, which is duck-typed
    # (just needs .uploaded_by_id) and applies here unchanged.
    doc = db.query(models.QARequestDocument).filter_by(id=doc_id, qa_request_id=req_id).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    if not doc_store.can_delete_document(doc, current_user):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it")
    full_path = os.path.join(UPLOAD_ROOT, doc.stored_path)
    if os.path.exists(full_path):
        os.remove(full_path)
    db.delete(doc)
    db.commit()
    return {"ok": True}
