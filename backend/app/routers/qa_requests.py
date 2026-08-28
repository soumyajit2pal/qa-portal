import json
import os
import shutil
import uuid
from typing import Optional, List, Dict

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas, pagination
from .. import documents as doc_store
from .. import application_names as app_names
from ..database import get_db
from ..deps import get_current_user, require_roles, dashboard_department_scope
from ..constants import (
    Role,
    REQUEST_TYPES, FUNCTIONAL_BUCKET_TYPES, QAStatus, GatewayStatus,
    GATEWAY_EDITABLE_STATUSES, GATEWAY_CANCELLABLE_STATUSES,
    POST_SIT_ENVIRONMENTS,
    validate_environment_promotion, validate_target_release_date,
)
# Every Functional/SAST/DAST/Performance checklist is Admin-configurable now
# (see checklist_config.py) -- nothing in this file reads the old hardcoded
# constants.DEFAULT_*_CHECKLIST_ITEMS lists directly any more.
from ..checklist_config import get_template_items
from ..pdf_export import build_request_detail_pdf

router = APIRouter(prefix="/api/qa-requests", tags=["qa-requests"])


def _log(db: Session, entity_id: int, step: str, user: models.User, decision: str, comments: Optional[str]):
    db.add(models.ApprovalAction(
        entity_type="QA_REQUEST", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _storage_key(req: "models.QARequest") -> str:
    """Folder-name prefix used under UPLOAD_ROOT/ for this gateway's
    uploads. request_id isn't assigned until the gateway is actually raised
    (see its column comment on models.QARequest), but documents -- both
    checklist evidence and general supporting documents -- can be attached
    while still Draft, so this can't simply wait for it. Falls back to a
    stable DRAFT-<id> key (the numeric PK is always present) in that case.
    When a business request_id is assigned, _promote_draft_upload_folder
    moves this folder and updates every tracked stored_path."""
    return req.request_id or f"DRAFT-{req.id}"


def _promote_draft_upload_folder(db: Session, req: "models.QARequest") -> None:
    """Move all tracked uploads from DRAFT-<pk> into the real request folder.

    This is idempotent and moves rather than copies, so a raised request has
    exactly one top-level upload folder. Both gateway supporting documents
    and staged checklist evidence are updated together.
    """
    if not req.request_id:
        return
    upload_root = doc_store.get_upload_root()
    draft_key = f"DRAFT-{req.id}"
    prefix = draft_key + os.sep

    gateway_documents = db.query(models.QARequestDocument).filter_by(qa_request_id=req.id).all()
    evidence_documents = (db.query(models.RequestDocument)
                          .filter(models.RequestDocument.stored_path.like(f"{draft_key}/%"))).all()
    for document in [*gateway_documents, *evidence_documents]:
        normalized = os.path.normpath(document.stored_path)
        if not normalized.startswith(prefix):
            continue
        suffix = normalized[len(prefix):]
        source = doc_store.resolve_upload_path(normalized)
        destination = os.path.join(upload_root, req.request_id, suffix)
        if os.path.isfile(source):
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            if os.path.exists(destination):
                stem, ext = os.path.splitext(destination)
                destination = f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
            shutil.move(source, destination)
        document.stored_path = os.path.relpath(destination, upload_root)

    draft_root = os.path.join(upload_root, draft_key)
    if os.path.isdir(draft_root):
        for root, _, files in os.walk(draft_root, topdown=False):
            if ".DS_Store" in files:
                try:
                    os.remove(os.path.join(root, ".DS_Store"))
                except OSError:
                    pass
            try:
                os.rmdir(root)
            except OSError:
                # Preserve any untracked file instead of deleting it.
                pass


_GATEWAY_PRIVATE_STATUSES = (GatewayStatus.DRAFT, GatewayStatus.CANCELLED)
_BUG_FIX_SOURCE_STATUSES = (
    QAStatus.QA_COMPLETED,
    QAStatus.QA_SIGNOFF_PENDING,
    QAStatus.QA_SIGNED_OFF,
    QAStatus.REQUESTER_VERIFICATION,
    QAStatus.CLOSED,
)

def _can_view_gateway(obj: "models.QARequest", user: models.User) -> bool:
    """Reported bug (follow-up to the Draft-only version of this check):
    Cancelled was still treated as department-wide visible, but
    GATEWAY_CANCELLABLE_STATUSES only ever allows cancelling FROM Draft --
    there is no path from Raised to Cancelled -- so a Cancelled gateway is,
    by construction, always a Draft that was abandoned before ever being
    raised. It never got a request_id, never spun off any linked child
    request, and nobody else was ever supposed to see it; reaching Cancelled
    doesn't change that. Treat Draft and Cancelled identically: visible only
    to the requester (or an Admin, for support). Only once a gateway is
    genuinely Raised does it follow the same department-wide visibility as
    every other request type in this app."""
    if obj.status not in _GATEWAY_PRIVATE_STATUSES:
        return True
    delegation = obj.active_delegation
    return (obj.requester_id == user.id or user.has_role(Role.ADMIN)
            or bool(delegation and delegation.assigned_to_id == user.id))


def _is_active_delegate(obj: "models.QARequest", user: models.User) -> bool:
    delegation = obj.active_delegation
    return bool(delegation and delegation.assigned_to_id == user.id)


def _can_edit_draft(obj: "models.QARequest", user: models.User) -> bool:
    if obj.status != GatewayStatus.DRAFT:
        return False
    if user.has_role(Role.ADMIN):
        return True
    delegation = obj.active_delegation
    if delegation:
        return delegation.assigned_to_id == user.id
    return obj.requester_id == user.id


def _validate_request_types(request_types: list[str]) -> None:
    unknown = sorted({value for value in request_types if value not in REQUEST_TYPES})
    if unknown:
        raise HTTPException(400, f"Unsupported Request Type(s): {', '.join(unknown)}")


def _validated_bug_fix_source(db: Session, source_request_id: Optional[str], change_type: Optional[str],
                              application_name: Optional[str], department: Optional[str]) -> Optional[str]:
    """Normalize and validate the optional Bug Fix traceability reference.

    Only a raised gateway for the same application/department whose linked
    Functional Testing workflow reached CLOSED is eligible. Changing away
    from Bug Fix clears any stale reference automatically.
    """
    if change_type != "Bug Fix":
        return None
    source = (source_request_id or "").strip().upper()
    if not source:
        return None
    match = (db.query(models.QARequest.id)
             .join(models.FunctionalRequest,
                   models.FunctionalRequest.qa_request_id == models.QARequest.id)
             .filter(
                 models.QARequest.request_id == source,
                 models.QARequest.department == department,
                 func.upper(models.QARequest.application_name) == (application_name or "").strip().upper(),
                 models.FunctionalRequest.status.in_(_BUG_FIX_SOURCE_STATUSES),
             ).first())
    if not match:
        raise HTTPException(
            400,
            "Previous Completed Request ID must reference a Functional Testing request where testing is completed "
            "for the same application and department.",
        )
    return source


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



# Maps the lowercase "kind" used throughout the Draft-evidence endpoints
# (chosen back when this was written to match the wizard step names) onto
# checklist_config.py's own uppercase module keys.
_DRAFT_EVIDENCE_MODULE_KEY = {
    "functional": "FUNCTIONAL", "sast": "SAST", "dast": "DAST", "performance": "PERFORMANCE",
}
_DRAFT_EVIDENCE_PREFIXES = {
    "functional": "DRAFT_FUNCTIONAL",
    "sast": "DRAFT_SAST",
    "dast": "DRAFT_DAST",
    "performance": "DRAFT_PERF",
}


def _draft_evidence_module(db: Session, kind: str, item_index: int) -> str:
    """Stable storage key for evidence selected before child checklist rows
    exist. The index refers to the position of that module's currently
    configured checklist (see checklist_config.get_template_items) at the
    moment the wizard rendered it; the document is re-keyed to the real
    child item during submit (see _promote_draft_checklist_evidence)."""
    module = _DRAFT_EVIDENCE_MODULE_KEY.get(kind)
    if module is None:
        raise HTTPException(404, "Unknown readiness checklist")
    definitions = get_template_items(db, module, only_active=True)
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
        definitions = get_template_items(db, _DRAFT_EVIDENCE_MODULE_KEY[kind], only_active=True)
        for index, definition in enumerate(definitions):
            item = checklist_by_name.get(definition.item)
            if not item:
                continue
            staged = db.query(models.RequestDocument).filter_by(
                module=_draft_evidence_module(db, kind, index), request_id=qa_request.id).all()
            for document in staged:
                document.module = destination_module
                document.request_id = item.id


def _finalize_child_requests(db: Session, obj: "models.QARequest", requester: models.User) -> None:
    """The actual "create linked children and move the gateway to Raised"
    step -- factored out of submit_request so it can be called from two
    places: immediately, inline, when the request's Application Name is
    already usable (APPROVED, or an existing PENDING_SM/REJECTED name --
    none of those block raising, only a brand-new PENDING_APP_OWNER name
    does, see the branch in submit_request below); or later, once an
    Application Owner approves a brand-new name, from
    routers/applications.py::decide_app_owner_name. `requester` is always
    the ORIGINAL requester who raised the gateway (obj.requester), not
    whoever happens to be calling this -- when this runs from the deferred
    path it's an Application Owner making the API call, but the "Requester
    -- Submitted" audit entries logged by _raise_child_to_sm for each child
    must still be attributed to the person who actually requested the work,
    not the approver who happened to unblock it."""
    _promote_draft_upload_folder(db, obj)
    request_types = obj.request_types.split(",") if obj.request_types else []
    (checked_items, sast_components, dast_components, performance_details, performance_checked_items,
     classification_details, sast_checked_items, dast_checked_items) = _unstash_draft_details(obj.draft_child_details)
    _sync_linked_child_requests(db, obj, request_types, requester, checked_items, sast_components, dast_components,
                                 performance_details,
                                 performance_checked_items=performance_checked_items,
                                 classification=classification_details,
                                 sast_checked_items=sast_checked_items,
                                 dast_checked_items=dast_checked_items)
    _promote_draft_checklist_evidence(db, obj)
    obj.draft_child_details = None  # consumed -- no longer needed once raised
    obj.status = GatewayStatus.RAISED
    _log(db, obj.id, "Requester", requester, "Submitted & Raised",
         "Linked request(s) raised with their own independent ID(s); workflow now handled on each separately")


# _resolve_application_name/_cleanup_orphaned_application_master used to
# live here -- moved to app/application_names.py (see that module's own
# docstring) so functional.py/sast_dast.py/performance.py can share the
# exact same normalize-and-reuse-or-create logic for their own Admin-only
# Application Name edits, instead of each bypassing the registry with a bare
# setattr. Aliased back to their original names here purely so every
# existing call site below reads unchanged.
_resolve_application_name = app_names.resolve_application_name
_cleanup_orphaned_application_master = app_names.cleanup_orphaned_application_master


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
    SAST's/DAST's own checklist (see checklist_config.py -- all four
    modules' checklists are Admin-configurable now).
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


@router.get("", response_model=pagination.Page[schemas.QARequestListOut])
def list_requests(params: pagination.PageParams = Depends(),
                   application_name: Optional[str] = None,
                   cr_number: Optional[str] = None,
                   requester_id: Optional[int] = None,
                   assigned_to_me: bool = False,
                   db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """SRS 7.2 (PAG-001..009) -- server-side paginated, database-filtered
    list. `application_name` stays as its own module-specific param (an
    exact "starts narrowing this one field" filter some callers rely on,
    e.g. NewRequestModal's own duplicate-application lookups) alongside the
    PAG-001 standard `search`/`status`/`department` params carried on
    `params`. `requester_id` is likewise module-specific (this table's
    `requester_id` is a real column, not something PAG-001's generic filters
    cover) -- added so Dashboard.tsx's "My Requests" tab can ask the
    database for "requests I raised" directly instead of fetching a
    department-wide page and filtering client-side, which silently dropped
    a user's own older requests once their department's total volume for a
    request type crossed the page_size=100 ceiling (reported directly)."""
    # Perf tuning (2026-08, reported directly: "some of the apis are taking
    # lot of timing") -- QARequestListOut.linked_functional_requests/
    # linked_sast_requests/linked_dast_requests/linked_performance_requests
    # are one-to-many relationships that were previously lazy-loaded, so
    # serializing a page of N requests issued 1 (base query) + up to 4N
    # extra SELECTs, one per relationship per row. selectinload replaces
    # that with exactly 4 extra queries total (one per relationship, each
    # doing a single `WHERE qa_request_id IN (...)`), regardless of page
    # size -- this endpoint is the busiest list in the app, so it's the
    # highest-impact fix in this pass.
    q = db.query(models.QARequest).options(
        selectinload(models.QARequest.linked_functional_requests),
        selectinload(models.QARequest.linked_sast_requests),
        selectinload(models.QARequest.linked_dast_requests),
        selectinload(models.QARequest.linked_performance_requests),
        selectinload(models.QARequest.active_delegation).selectinload(models.QARequestDelegation.assigned_by),
        selectinload(models.QARequest.active_delegation).selectinload(models.QARequestDelegation.assigned_to),
        selectinload(models.QARequest.active_delegation).selectinload(models.QARequestDelegation.closed_by),
    )
    delegated_to_user = models.QARequest.delegations.any(and_(
        models.QARequestDelegation.status == "ACTIVE",
        models.QARequestDelegation.target_type == "QA_REQUEST",
        models.QARequestDelegation.assigned_to_id == current_user.id,
    ))
    q = pagination.apply_status_filter(q, params, models.QARequest.status)
    q = pagination.apply_department_filter(q, params, models.QARequest.department)
    if application_name:
        q = q.filter(models.QARequest.application_name.ilike(f"%{application_name}%"))
    if requester_id is not None:
        q = q.filter(models.QARequest.requester_id == requester_id)
    # Reported directly: "In dashboard, every-where show data from which
    # department user belong to only" -- then, immediately after, extended to
    # "QA Requests, Functional Requests, SAST, DAST, Suppression, Performance
    # everywhere ... it also be by department only." Applied unconditionally
    # now (was briefly opt-in via a dashboard_scope flag while this was
    # believed to be Dashboard-only) -- every list of these request types,
    # wherever it's shown, is scoped the same way. See
    # dashboard_department_scope's own docstring in deps.py for exactly which
    # roles this does and doesn't apply to (the QA/Security/Executive-COE
    # roles stay unrestricted; every other role, Admin and Department Head
    # included, is confined to their own department). Applied before
    # pagination.paginate() below so PAG-009's "the total count shall
    # include only records the current user is authorized to access" holds.
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.filter(or_(models.QARequest.department.in_(scope), delegated_to_user))
    if assigned_to_me:
        q = q.filter(delegated_to_user)
    # Broad "requests or IDs" search (topbar search box and the QA Requests
    # list's own search field) -- matches Request ID, Application Name, or
    # The consolidated CR/EPIC identifier is stored in cr_number.
    q = pagination.apply_search(q, params, models.QARequest.request_id, models.QARequest.application_name, models.QARequest.cr_number)
    # Exact CR/EPIC number lookup -- reported directly: "in global search if
    # any one wants to search by cr number as well, can we get all requests
    # details based on that cr?" The `search` param above already ilike-
    # matches cr_number as a substring alongside request_id/application_name,
    # which is fine for the free-text QA Requests search box but too loose
    # for "give me every request raised under this exact CR" -- e.g. typing
    # CR-102 would also match CR-1023/CR-1024 via substring search. This
    # dedicated param does an exact (case-insensitive) match instead; the
    # topbar global search uses it whenever the typed term matches the
    # CR-<digits>/EPIC-<digits> pattern (see Layout.tsx's submitSearch).
    if cr_number:
        q = q.filter(func.upper(models.QARequest.cr_number) == cr_number.strip().upper())
    if not current_user.has_role(Role.ADMIN):
        # Draft and Cancelled gateways are both scratch work that was never
        # actually raised (Cancelled is only ever reached FROM Draft -- see
        # _can_view_gateway) -- only their own requester sees them in the
        # list; everyone else's are filtered out entirely (not just blanked/
        # masked).
        q = q.filter(or_(
            models.QARequest.status.notin_(_GATEWAY_PRIVATE_STATUSES),
            models.QARequest.requester_id == current_user.id,
            delegated_to_user,
        ))
    q = pagination.apply_sort(q, params, sortable={
        "created_at": models.QARequest.created_at,
        "updated_at": models.QARequest.updated_at,
        "application_name": models.QARequest.application_name,
        "status": models.QARequest.status,
        "target_release_date": models.QARequest.target_release_date,
    }, default_column=models.QARequest.created_at, id_column=models.QARequest.id)
    result = pagination.paginate(q, params)
    # Sign-offs aren't reachable via a normal relationship -- QASignOff has
    # no FK to QARequest, it's matched by business ID string against
    # FunctionalRequest.request_id (see models.QASignOff.testing_request_id /
    # source_functional_request), so they can't be selectinload()'d above
    # like the other 4 linked-request types. Batched here in one extra query
    # instead of one per row: collect every linked Functional request_id
    # already loaded on this page, then a single `testing_request_id IN
    # (...)` query finds every sign-off for the whole page at once. Added so
    # a CR-number lookup (see cr_number param above) returns every request
    # tied to that CR, including its Sign-off, not just the 4 relationship-
    # backed types.
    func_ids_by_qa_id: Dict[int, List[str]] = {
        row.id: [f.request_id for f in row.linked_functional_requests] for row in result.items
    }
    all_func_ids = [fid for ids in func_ids_by_qa_id.values() for fid in ids]
    signoffs_by_func_id: Dict[str, List[models.QASignOff]] = {}
    if all_func_ids:
        for so in db.query(models.QASignOff).filter(models.QASignOff.testing_request_id.in_(all_func_ids)).all():
            signoffs_by_func_id.setdefault(so.testing_request_id, []).append(so)
    for row in result.items:
        row.linked_signoffs = [so for fid in func_ids_by_qa_id[row.id] for so in signoffs_by_func_id.get(fid, [])]
    return pagination.to_page_response(result, params)


@router.get("/bug-fix-source-options")
def bug_fix_source_options(application_name: str = Query(..., min_length=1),
                           department: str = Query(..., min_length=1),
                           limit: int = Query(100, ge=1, le=200),
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(get_current_user)):
    """Recent completed Functional requests eligible as a Bug Fix source.

    This compact endpoint exists specifically for the shared searchable
    selector; it does not load documents, checklists, findings, or other
    child collections from the full QA Request detail payload.
    """
    q = (db.query(models.QARequest, models.FunctionalRequest)
         .join(models.FunctionalRequest,
               models.FunctionalRequest.qa_request_id == models.QARequest.id)
         .filter(
             models.QARequest.request_id.isnot(None),
             func.upper(models.QARequest.application_name) == application_name.strip().upper(),
             models.QARequest.department == department,
             models.FunctionalRequest.status.in_(_BUG_FIX_SOURCE_STATUSES),
         ))
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.filter(models.QARequest.department.in_(scope))
    rows = q.order_by(models.FunctionalRequest.updated_at.desc()).limit(limit).all()
    return [{
        "request_id": gateway.request_id,
        "functional_request_id": functional.request_id,
        "application_name": gateway.application_name,
        "cr_number": gateway.cr_number,
        "completed_at": functional.updated_at,
    } for gateway, functional in rows]


@router.get("/{req_id}", response_model=schemas.QARequestOut)
def get_request(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = (db.query(models.QARequest).options(
        selectinload(models.QARequest.active_delegation).selectinload(models.QARequestDelegation.assigned_by),
        selectinload(models.QARequest.active_delegation).selectinload(models.QARequestDelegation.assigned_to),
        selectinload(models.QARequest.active_delegation).selectinload(models.QARequestDelegation.closed_by),
    ).filter(models.QARequest.id == req_id).first())
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if not _can_view_gateway(obj, current_user):
        raise HTTPException(403, "This request was never raised (still Draft, or Cancelled before being raised) and is only visible to its requester")
    # Same batched-in-list_requests() reasoning applies here for a single
    # row -- QASignOff has no FK to QARequest, only a business-ID match
    # against a linked FunctionalRequest's own request_id.
    func_ids = [f.request_id for f in obj.linked_functional_requests]
    obj.linked_signoffs = (
        db.query(models.QASignOff).filter(models.QASignOff.testing_request_id.in_(func_ids)).all()
        if func_ids else []
    )
    return obj


@router.post("/{req_id}/delegations", response_model=schemas.QARequestOut)
def assign_for_input(req_id: int, payload: schemas.QARequestDelegationCreate,
                     db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Serialize assignment changes on the parent request so two near-simultaneous
    # clicks cannot both observe "no active delegation" and create duplicates.
    #
    # Reported directly (ORA-02014, live Oracle traceback): "cannot select
    # FOR UPDATE from view with DISTINCT, GROUP BY, etc." -- `.first()`
    # compiles to a `FETCH FIRST 1 ROWS ONLY` limit clause, and Oracle
    # rejects combining that with `FOR UPDATE` (the FETCH FIRST wrapping is
    # implemented as an inline view, which Oracle's FOR UPDATE restriction
    # then trips on -- a well-known Oracle/SQLAlchemy interaction, not
    # specific to this query). `.one_or_none()` fetches without any LIMIT/
    # FETCH FIRST clause instead -- identical result here since `id` is the
    # primary key (at most one row either way), but Oracle-safe. Mirrors the
    # already-correct pattern in test_repository.py's own with_for_update()
    # + one_or_none() usage.
    obj = (db.query(models.QARequest)
           .filter(models.QARequest.id == req_id)
           .with_for_update()
           .one_or_none())
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can delegate this request")
    if obj.status != GatewayStatus.DRAFT:
        raise HTTPException(400, "Only a Draft QA Request gateway can be delegated here")
    if obj.active_delegation:
        raise HTTPException(400, "This request already has an active delegation")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(400, "Assignment reason is required")
    if len(reason) > 1000:
        raise HTTPException(400, "Assignment reason cannot exceed 1,000 characters")
    assignee = db.query(models.User).filter(
        models.User.id == payload.assigned_to_id,
        models.User.is_active == True,  # noqa: E712
    ).first()
    if not assignee:
        raise HTTPException(400, "Select an active user")
    if assignee.id == obj.requester_id:
        raise HTTPException(400, "The requester already owns this request; select another user")
    delegation = models.QARequestDelegation(
        qa_request_id=obj.id,
        target_type="QA_REQUEST",
        target_id=obj.id,
        assigned_by_id=current_user.id,
        assigned_to_id=assignee.id,
        assignment_reason=reason,
        status="ACTIVE",
    )
    db.add(delegation)
    obj.updated_at = models.now()
    _log(db, obj.id, "Delegation", current_user, "Assigned for Input",
         f"Assigned to {assignee.full_name}. Reason: {reason}")
    db.commit()
    return get_request(req_id, db, current_user)


@router.post("/{req_id}/delegations/return", response_model=schemas.QARequestOut)
def return_delegated_request(req_id: int, payload: schemas.QARequestDelegationClose,
                             db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # See assign_for_input's matching comment above (ORA-02014) -- same fix.
    obj = (db.query(models.QARequest)
           .filter(models.QARequest.id == req_id)
           .with_for_update()
           .one_or_none())
    if not obj:
        raise HTTPException(404, "QA Request not found")
    delegation = obj.active_delegation
    if not delegation or delegation.assigned_to_id != current_user.id:
        raise HTTPException(403, "Only the currently assigned user can return this request")
    comments = (payload.comments or "").strip()
    if not comments:
        raise HTTPException(400, "Return comments are required")
    if len(comments) > 1000:
        raise HTTPException(400, "Return comments cannot exceed 1,000 characters")
    delegation.status = "RETURNED"
    delegation.closed_by_id = current_user.id
    delegation.returned_at = models.now()
    delegation.return_comments = comments
    obj.updated_at = models.now()
    _log(db, obj.id, "Delegation", current_user, "Returned to Requester", comments)
    db.commit()
    # The assignee's private-Draft access intentionally ends at this commit,
    # so a normal get_request() would now reject them. Returning the already
    # authorized action target lets the UI acknowledge the handoff once and
    # then close the detail drawer.
    db.refresh(obj)
    return obj


@router.post("/{req_id}/delegations/recall", response_model=schemas.QARequestOut)
def recall_delegated_request(req_id: int, payload: schemas.QARequestDelegationClose,
                             db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # See assign_for_input's matching comment above (ORA-02014) -- same fix.
    obj = (db.query(models.QARequest)
           .filter(models.QARequest.id == req_id)
           .with_for_update()
           .one_or_none())
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can recall this delegation")
    delegation = obj.active_delegation
    if not delegation:
        raise HTTPException(400, "This request has no active delegation")
    comments = (payload.comments or "").strip()
    if not comments:
        raise HTTPException(400, "Recall reason is required")
    if len(comments) > 1000:
        raise HTTPException(400, "Recall reason cannot exceed 1,000 characters")
    delegation.status = "RECALLED"
    delegation.closed_by_id = current_user.id
    delegation.returned_at = models.now()
    delegation.return_comments = comments
    obj.updated_at = models.now()
    _log(db, obj.id, "Delegation", current_user, "Delegation Recalled", comments)
    db.commit()
    return get_request(req_id, db, current_user)


# Child-workflow delegation is deliberately separate from the gateway's
# Draft delegation above.  It targets the exact returned request, so an
# assignment on a Functional request cannot leak edit permission into a
# sibling SAST/DAST/Performance request sharing the same gateway.
_CHILD_DELEGATION_TARGETS = {
    "FUNCTIONAL": (
        models.FunctionalRequest,
        {QAStatus.DRAFT, QAStatus.RETURNED_BY_SM, QAStatus.SM_REJECTED,
         QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD},
        "FUNCTIONAL_REQUEST",
    ),
    "SAST": (
        models.SASTRequest,
        {"DRAFT", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD", "WAITING_FOR_FIX"},
        "SAST",
    ),
    "DAST": (
        models.DASTRequest,
        {"DRAFT", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD", "WAITING_FOR_FIX"},
        "DAST",
    ),
    "PERFORMANCE": (
        models.PerformanceRequest,
        {"DRAFT", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_ENGINEER"},
        "PERFORMANCE",
    ),
}


def _child_delegation_target(db: Session, qa_request_id: int, target_type: str,
                             target_id: int, *, lock: bool = False):
    normalized = target_type.strip().upper()
    config = _CHILD_DELEGATION_TARGETS.get(normalized)
    if not config:
        raise HTTPException(400, "Delegation target must be Functional, SAST, DAST, or Performance")
    model, requester_statuses, audit_entity_type = config
    query = db.query(model).filter(model.id == target_id, model.qa_request_id == qa_request_id)
    if lock:
        query = query.with_for_update()
    # ORA-02014 when lock=True -- see assign_for_input's comment in this same
    # file for the full explanation. .one_or_none() instead of .first() is
    # identical here (model.id is the primary key, so at most one row either
    # way) but avoids the FETCH FIRST clause Oracle rejects under FOR UPDATE.
    target = query.one_or_none()
    if not target:
        raise HTTPException(404, f"{normalized.title()} request not found under this QA Request")
    return normalized, target, requester_statuses, audit_entity_type


def _active_child_delegation(db: Session, target_type: str, target_id: int, *, lock: bool = False):
    query = db.query(models.QARequestDelegation).filter(
        models.QARequestDelegation.target_type == target_type,
        models.QARequestDelegation.target_id == target_id,
        models.QARequestDelegation.status == "ACTIVE",
    )
    if lock:
        query = query.with_for_update()
    # ORA-02014 when lock=True -- see assign_for_input's comment above for
    # the full explanation. .one_or_none() instead of .first() is identical
    # here (at most one ACTIVE delegation per target is a maintained
    # invariant -- see "This request already has an active delegation"
    # above) but avoids the FETCH FIRST clause Oracle rejects under FOR
    # UPDATE.
    return query.one_or_none()


def _log_child_delegation(db: Session, entity_type: str, entity_id: int,
                          user: models.User, decision: str, comments: str) -> None:
    db.add(models.ApprovalAction(
        entity_type=entity_type,
        entity_id=entity_id,
        step_name="Delegation",
        actor_id=user.id,
        actor_role=user.roles_csv,
        decision=decision,
        comments=comments,
    ))


@router.post("/{qa_request_id}/child-delegations/{target_type}/{target_id}",
             response_model=schemas.QARequestDelegationOut)
def assign_child_for_input(qa_request_id: int, target_type: str, target_id: int,
                           payload: schemas.QARequestDelegationCreate,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(get_current_user)):
    normalized, target, requester_statuses, audit_entity_type = _child_delegation_target(
        db, qa_request_id, target_type, target_id, lock=True,
    )
    if target.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can delegate this request")
    if target.status not in requester_statuses:
        raise HTTPException(400, "Delegation is available only while this request is with the requester for input or correction")
    if _active_child_delegation(db, normalized, target.id, lock=True):
        raise HTTPException(400, "This request already has an active delegation")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(400, "Assignment reason is required")
    if len(reason) > 1000:
        raise HTTPException(400, "Assignment reason cannot exceed 1,000 characters")
    assignee = db.query(models.User).filter(
        models.User.id == payload.assigned_to_id,
        models.User.is_active == True,  # noqa: E712
    ).first()
    if not assignee:
        raise HTTPException(400, "Select an active user")
    if assignee.id == target.requester_id:
        raise HTTPException(400, "The requester already owns this request; select another user")
    delegation = models.QARequestDelegation(
        qa_request_id=qa_request_id,
        target_type=normalized,
        target_id=target.id,
        assigned_by_id=current_user.id,
        assigned_to_id=assignee.id,
        assignment_reason=reason,
        status="ACTIVE",
    )
    db.add(delegation)
    target.updated_at = models.now()
    _log_child_delegation(
        db, audit_entity_type, target.id, current_user, "Assigned for Input",
        f"Assigned to {assignee.full_name}. Reason: {reason}",
    )
    db.commit()
    db.refresh(delegation)
    return delegation


@router.post("/{qa_request_id}/child-delegations/{target_type}/{target_id}/return",
             response_model=schemas.QARequestDelegationOut)
def return_child_delegation(qa_request_id: int, target_type: str, target_id: int,
                            payload: schemas.QARequestDelegationClose,
                            db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    normalized, target, _, audit_entity_type = _child_delegation_target(
        db, qa_request_id, target_type, target_id, lock=True,
    )
    delegation = _active_child_delegation(db, normalized, target.id, lock=True)
    if not delegation or delegation.assigned_to_id != current_user.id:
        raise HTTPException(403, "Only the currently assigned user can return this request")
    comments = (payload.comments or "").strip()
    if not comments:
        raise HTTPException(400, "Return comments are required")
    if len(comments) > 1000:
        raise HTTPException(400, "Return comments cannot exceed 1,000 characters")
    delegation.status = "RETURNED"
    delegation.closed_by_id = current_user.id
    delegation.returned_at = models.now()
    delegation.return_comments = comments
    target.updated_at = models.now()
    _log_child_delegation(db, audit_entity_type, target.id, current_user, "Returned to Requester", comments)
    db.commit()
    db.refresh(delegation)
    return delegation


@router.post("/{qa_request_id}/child-delegations/{target_type}/{target_id}/recall",
             response_model=schemas.QARequestDelegationOut)
def recall_child_delegation(qa_request_id: int, target_type: str, target_id: int,
                            payload: schemas.QARequestDelegationClose,
                            db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    normalized, target, _, audit_entity_type = _child_delegation_target(
        db, qa_request_id, target_type, target_id, lock=True,
    )
    if target.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can recall this delegation")
    delegation = _active_child_delegation(db, normalized, target.id, lock=True)
    if not delegation:
        raise HTTPException(400, "This request has no active delegation")
    comments = (payload.comments or "").strip()
    if not comments:
        raise HTTPException(400, "Recall reason is required")
    if len(comments) > 1000:
        raise HTTPException(400, "Recall reason cannot exceed 1,000 characters")
    delegation.status = "RECALLED"
    delegation.closed_by_id = current_user.id
    delegation.returned_at = models.now()
    delegation.return_comments = comments
    target.updated_at = models.now()
    _log_child_delegation(db, audit_entity_type, target.id, current_user, "Delegation Recalled", comments)
    db.commit()
    db.refresh(delegation)
    return delegation


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
    TQA-FUNC-.../TQA-SAST-.../TQA-DAST-.../TQA-PERF-... generator) while staying linked
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
        # Seeded from the Admin-configurable "FUNCTIONAL" checklist template
        # (see checklist_config.py) rather than a hardcoded list -- whatever
        # is currently configured as mandatory there is copied onto
        # is_mandatory below, and enforced at raise-time (see submit_request's
        # pending_checklist_items gate further down this file).
        # `requester_checked` is the requester's own self-declaration made
        # at raise-time -- it is reference/pre-fill only. It does NOT set
        # `is_complete`; the QA Lead must still independently verify every
        # item during Readiness Verification.
        for template in get_template_items(db, "FUNCTIONAL"):
            db.add(models.ReadinessChecklistItem(
                functional_request_id=functional.id, item=template.item, owner=template.detail,
                is_mandatory=template.is_mandatory,
                requester_checked=template.item in checked_set,
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
        # "Security Readiness" pre-scan checklist -- seeded from the
        # Admin-configurable "SAST" checklist template (see
        # checklist_config.py). requester_checked is the requester's own
        # self-declaration made at raise-time on the QA Request wizard's SAST
        # step -- same pattern as Functional's checklist; can also still be
        # revisited afterward from the SAST request's own Edit Details modal
        # (see update_sast's checked_items). Mandatory items here block
        # Submit itself, not just Security Readiness -- see
        # routers/sast_dast.py::_require_checklist_ready.
        sast_checked_set = sast_checked_items or set()
        for template in get_template_items(db, "SAST"):
            db.add(models.SASTChecklistItem(
                sast_request_id=sast.id, item=template.item, owner=template.detail,
                is_mandatory=template.is_mandatory,
                requester_checked=template.item in sast_checked_set,
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
        # Reported directly: DAST scans are never run against Dev or SIT --
        # DastStep.tsx's own Environment picker is restricted to
        # POST_SIT_ENVIRONMENTS (UAT/Pre-Production/Production) with no blank
        # option, so `t.get("environment")` is always one of those by the
        # time this runs; submit_request's own gate above rejects the raise
        # entirely if it somehow isn't. The "UAT" fallback below is a last
        # resort only (e.g. a still-blank legacy placeholder row), never the
        # gateway's own Deployment Environment (which can be SIT).
        targets = dast_components or [{}]
        for t in targets:
            db.add(models.DASTTarget(
                dast_request_id=dast.id,
                application_url=t.get("application_url") or f"To be confirmed — linked from {qa_request.request_id}",
                environment=t.get("environment") or "UAT",
                authentication_required=t.get("authentication_required") or "No",
                test_credentials=t.get("test_credentials"),
            ))
        # Same "Security Readiness" checklist pattern as SAST above -- own
        # Admin-configurable "DAST" template (see checklist_config.py), own
        # self-declaration set from the QA Request wizard's DAST step -- see
        # the comment there for the full reasoning.
        dast_checked_set = dast_checked_items or set()
        for template in get_template_items(db, "DAST"):
            db.add(models.DASTChecklistItem(
                dast_request_id=dast.id, item=template.item, owner=template.detail,
                is_mandatory=template.is_mandatory,
                requester_checked=template.item in dast_checked_set,
            ))
        _raise_child_to_sm(db, dast, "DAST", qa_request, current_user)
    if "Performance Testing" in request_types and "Performance Testing" not in existing_types:
        pd = performance_details or {}
        performance = models.PerformanceRequest(
            application_name=qa_request.application_name,
            epic_number=qa_request.epic_number,
            cr_number=qa_request.cr_number,
            # Reported directly: Performance testing is never run against Dev
            # or SIT, regardless of whatever Deployment Environment was picked
            # on the gateway (e.g. a change might deploy to SIT first, but the
            # actual load test only ever happens later, against UAT or
            # beyond) -- so unlike every other delegated field below, this is
            # its own explicit ask on the Performance wizard step
            # (PerformanceStep.tsx's Environment picker, restricted to
            # POST_SIT_ENVIRONMENTS with no blank option), not delegated from
            # qa_request.environment. submit_request's own gate above rejects
            # the raise entirely if this is somehow still missing/invalid by
            # the time this runs; the "UAT" fallback is a last resort only.
            environment=pd.get("performance_environment") or "UAT",
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
            # already typed once), matching how application_name/epic_number
            # above are delegated too (risk_category/priority are NOT
            # delegated -- collected on this request type's own step, see
            # above; environment isn't delegated either -- see above). hash_value
            # has no gateway equivalent either, so it's simply left blank at
            # intake and can be filled in later on this request's own page.
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
        # "L1: Pre-Testing Readiness Checklist" (Annexure VIII) -- seeded from
        # the Admin-configurable "PERFORMANCE" checklist template (see
        # checklist_config.py); an item is only mandatory if configured that
        # way (shipped default: none are -- see
        # checklist_config._default_items_for -- but an Admin can now flip
        # any of them on, and it's enforced at raise-time the same as
        # Functional/SAST/DAST, see submit_request's pending_checklist_items
        # gate further down this file; this used to be hardcoded to False
        # here regardless of anything else, which is why Performance never
        # had a working mandatory gate before). requester_checked is the
        # requester's own self-declaration made at raise-time (see the QA
        # Request wizard's Performance step) -- same pattern as Functional's
        # checklist; it does NOT set is_complete, which QA still
        # independently verifies (see routers/performance.py::
        # update_checklist_item).
        performance_checked_set = performance_checked_items or set()
        for template in get_template_items(db, "PERFORMANCE"):
            db.add(models.PerformanceChecklistItem(
                performance_request_id=performance.id, item=template.item, data_required=template.detail,
                is_mandatory=template.is_mandatory,
                requester_checked=template.item in performance_checked_set,
            ))
        _raise_child_to_sm(db, performance, "PERFORMANCE", qa_request, current_user)


def _resolve_requester_department(current_user: models.User, requested: Optional[str]) -> Optional[str]:
    """2026-08 "one user can be on multiple departments" CR, follow-up:
    department was previously locked server-side to the requester's own
    profile department, full stop -- now that a requester may have more than
    one, the frontend dropdown lets them pick which of THEIR OWN departments
    a request belongs to, defaulting to their primary (first-assigned) one.
    Still never trusts the client blindly: `requested` (if sent at all) must
    be one of `current_user.departments`, or this raises -- picking an
    arbitrary department outside the requester's own set stays impossible,
    exactly as before this change, just widened from "must equal the one
    department on file" to "must be one of the several on file."""
    if requested is None:
        return current_user.primary_department
    if not current_user.has_department(requested):
        raise HTTPException(
            400,
            f"'{requested}' is not one of your assigned departments "
            f"({', '.join(current_user.departments) or 'none'}).",
        )
    return requested


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
    # Department is restricted to the requester's OWN department(s) -- see
    # _resolve_requester_department's own docstring; defaults to their
    # primary (first-assigned) one when the client doesn't send a choice.
    data["department"] = _resolve_requester_department(current_user, payload.department)
    request_types = data.pop("request_types", [])
    _validate_request_types(request_types)
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
    data["bug_fix_source_request_id"] = _validated_bug_fix_source(
        db,
        data.get("bug_fix_source_request_id"),
        data.get("change_type"),
        name_upper,
        data.get("department"),
    )
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
    if not _can_edit_draft(obj, current_user):
        if obj.active_delegation and obj.requester_id == current_user.id:
            raise HTTPException(403, "This request is delegated and locked for editing until it is returned or recalled")
        raise HTTPException(403, "Only the requester, active delegate, or an admin can edit this Draft")
    if obj.status not in GATEWAY_EDITABLE_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    # GATEWAY_EDITABLE_STATUSES is Draft-only, so no linked child request
    # exists yet at this point (see submit_request) -- editing here just
    # means updating the still-Draft gateway fields and its stashed
    # draft_child_details, never touching/creating any child request.
    data = payload.model_dump(exclude_unset=True)
    # Department is restricted to the requester's OWN department(s) -- same
    # rule and helper as create_request; only actually re-validated/written
    # when the client sent a department at all (exclude_unset=True means a
    # plain re-save of an unrelated field leaves it untouched, same pattern
    # as application_name_in below).
    if "department" in data:
        if _is_active_delegate(obj, current_user) and not current_user.has_role(Role.ADMIN):
            if (data["department"] or "").strip() != (obj.department or "").strip():
                raise HTTPException(403, "A delegated user cannot change the request department")
            data["department"] = obj.department
        else:
            data["department"] = _resolve_requester_department(current_user, data["department"])
    request_types = data.pop("request_types", None)
    if request_types is not None:
        _validate_request_types(request_types)
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
    final_application_name = ((application_name_in or "").strip().upper()
                              if application_name_in is not None else obj.application_name)
    final_change_type = data.get("change_type", obj.change_type)
    final_bug_fix_source = data.get("bug_fix_source_request_id", obj.bug_fix_source_request_id)
    data["bug_fix_source_request_id"] = _validated_bug_fix_source(
        db,
        final_bug_fix_source,
        final_change_type,
        final_application_name,
        data.get("department", obj.department),
    )
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

    # Reported directly: merely opening a Draft (e.g. one an Application
    # Owner just rejected, which reverts the gateway to Draft -- see
    # decide_app_owner_name's Reject branch) and clicking Save WITHOUT
    # actually changing the Application Name field was silently re-flipping
    # a REJECTED name back to PENDING_APP_OWNER and sending it back for
    # approval -- because the wizard always resends the current
    # application_name value on every save (see NewRequestModal.tsx), not
    # just when the user actually edited that field, so `application_name_in
    # is not None` was true on every single save regardless. Only actually
    # re-resolving (and so only actually able to un-reject a REJECTED row)
    # when the incoming name is genuinely DIFFERENT from what's already
    # resolved fixes this: a plain re-save of an unrelated field no longer
    # sends the name back for approval -- only really changing it does.
    if application_name_in is not None:
        incoming_upper = (application_name_in or "").strip().upper()
        if incoming_upper != (obj.application_name or "").strip().upper():
            old_master_id = obj.application_master_id
            obj.application_name, obj.application_master_id = _resolve_application_name(
                db, application_name_in, obj.department, current_user.id, qa_request_id=obj.id,
            )
            _cleanup_orphaned_application_master(db, old_master_id, obj.id)

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
    if obj.active_delegation:
        raise HTTPException(400, "Recall the active delegation before cancelling this request")
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
    for every linked child.

    Exception (2026-08): if the request's Application Name is a brand-new
    "Other" entry still awaiting the FIRST tier of approval
    (application_master_status == PENDING_APP_OWNER), child creation and SM
    assignment is deferred entirely -- reported directly: "new name will go
    for Approval to Application Owner / once approved, then child request
    will be generated and will assign to SM." The gateway still moves off
    Draft (so it's no longer editable and gets its real request_id/becomes
    department-wide visible, same as any other raised request -- see
    _can_view_gateway) but stops at Submitted instead of Raised, and
    draft_child_details is deliberately left alone (not yet consumed).
    _finalize_child_requests (the actual child-creation step, shared by both
    paths) only runs once an Application Owner approves the name -- see
    routers/applications.py::decide_app_owner_name -- at which point the
    gateway moves on to Raised itself. If the Application Owner rejects the
    name instead, the gateway is reverted straight back to Draft (same
    file) rather than ever having spun up a single child.

    Reported directly (2026-08): a "sibling" gateway -- a separate QA
    Request that resolved to this exact same brand-new name (see
    _resolve_application_name's own docstring: any two requests typing the
    identical "Other" name share one ApplicationMaster row) but was still
    sitting in Draft when a DIFFERENT gateway's own Application Owner/SM
    rejected that name -- could still be raised clean, with its own linked
    children silently born straight at SM_REJECTED (see _raise_child_to_sm's
    own REJECTED branch) instead of the raise itself ever being stopped.
    application_master_status is a live delegated property (see
    models.QARequest), so this sibling's status already read REJECTED by
    the time Submit was clicked -- create_request/edit_request re-resolve
    the name (and silently un-reject it back to PENDING_APP_OWNER, see
    _resolve_application_name) only when the Application Name field is
    actually re-saved, which Submit alone never does. Blocked below instead
    of allowed through: a gateway can never raise while resolved to a
    REJECTED name, full stop."""
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if obj.requester_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    if obj.active_delegation:
        raise HTTPException(400, "The assigned user must return the request, or the requester must recall it, before submission")
    if obj.status != GatewayStatus.DRAFT:
        raise HTTPException(400, f"'Submit' requires status 'DRAFT' (currently '{obj.status}')")
    if obj.application_master_status == "REJECTED":
        # Wording note: since edit_request now only re-resolves (and so only
        # un-rejects) the Application Name when it's actually changed to
        # different text -- see edit_request's own comment, fixing "editing
        # and saving a Draft without touching the name field was silently
        # resubmitting a rejected name for approval" -- simply re-selecting
        # the exact same rejected name no longer clears this on its own; a
        # genuinely different Application Name is the only way through.
        raise HTTPException(
            400,
            f"Cannot raise -- the Application Name '{obj.application_name}' was rejected. Edit this request "
            "and choose a different Application Name before raising.",
        )
    request_types = obj.request_types.split(",") if obj.request_types else []
    _validate_request_types(request_types)
    obj.bug_fix_source_request_id = _validated_bug_fix_source(
        db,
        obj.bug_fix_source_request_id,
        obj.change_type,
        obj.application_name,
        obj.department,
    )
    # The one and only place request_id is ever assigned -- see its column
    # comment on models.QARequest. A Draft that gets cancelled instead of
    # raised never reaches this line, so it never burns a real ID.
    if not obj.request_id:
        obj.request_id = models.gen_id(models.BUSINESS_ID_PREFIXES["QA_REQUEST"], db)
    # This is the one and only point where linked child request(s) actually
    # get created -- everything collected on the wizard's SAST/DAST/
    # Performance steps (and the readiness-checklist self-declaration ticks)
    # was just sitting in draft_child_details until now (see create_request/
    # edit_request). "Linked Requests" is correctly empty right up until
    # this call.
    checked_items, sast_components, dast_components, performance_details, performance_checked_items, classification_details, sast_checked_items, dast_checked_items = _unstash_draft_details(obj.draft_child_details)
    # Every linked child now lands straight at SM_APPROVAL_PENDING with no
    # separate per-module Submit click of its own (see _raise_child_to_sm),
    # so each module's own mandatory-checklist gate that would otherwise only
    # fire on its own subsequent submit (e.g. routers/sast_dast.py::
    # _require_checklist_ready) has to be enforced here instead, before that
    # child is ever created -- otherwise a requester could raise the gateway
    # with a mandatory item still unchecked and the linked request would be
    # born already sitting at SM Approval despite that.
    #
    # Covers all four modules now (Functional/SAST/DAST/Performance) --
    # whatever is currently configured as mandatory for a module (see
    # checklist_config.py; Admin > Readiness Checklist Configuration) must be
    # self-declared before Raise, full stop. This used to only actually cover
    # Functional/SAST/DAST (Performance's checklist had no way to be
    # mandatory at all -- see _sync_linked_child_requests' own comment on
    # PerformanceChecklistItem above) -- reported directly: "if I make any
    # checklist mandatory in that configuration, that will be mandatory"
    # means every module has to honor it the same way, not just three of
    # four.
    pending_checklist_items = []
    if "Functional Testing" in request_types:
        functional_checked_set = set(checked_items)
        pending_checklist_items += [
            template.item for template in get_template_items(db, "FUNCTIONAL")
            if template.is_mandatory and template.item not in functional_checked_set
        ]
    if "SAST" in request_types:
        sast_checked_set = set(sast_checked_items)
        pending_checklist_items += [
            template.item for template in get_template_items(db, "SAST")
            if template.is_mandatory and template.item not in sast_checked_set
        ]
    if "DAST" in request_types:
        dast_checked_set = set(dast_checked_items)
        pending_checklist_items += [
            template.item for template in get_template_items(db, "DAST")
            if template.is_mandatory and template.item not in dast_checked_set
        ]
    if "Performance Testing" in request_types:
        performance_checked_set = set(performance_checked_items)
        pending_checklist_items += [
            template.item for template in get_template_items(db, "PERFORMANCE")
            if template.is_mandatory and template.item not in performance_checked_set
        ]
    if pending_checklist_items:
        raise HTTPException(
            400,
            "Cannot raise -- the following mandatory checklist item(s) must be "
            "self-declared ready first (Edit Request): "
            + "; ".join(pending_checklist_items),
        )

    # Reported directly: DAST scans and Performance tests are never run
    # against Dev or SIT -- DastStep.tsx/PerformanceStep.tsx's own Environment
    # pickers are already restricted to POST_SIT_ENVIRONMENTS client-side with
    # no blank option, so this should never actually trip in normal use;
    # enforced here too anyway (same belt-and-braces reasoning as every other
    # gate in this function) in case of a stale/tampered request.
    if "DAST" in request_types:
        bad_dast_envs = [
            c.get("environment") for c in (dast_components or [])
            if c.get("environment") not in POST_SIT_ENVIRONMENTS
        ]
        if bad_dast_envs:
            raise HTTPException(
                400,
                f"DAST target Environment must be one of {', '.join(POST_SIT_ENVIRONMENTS)} "
                "-- DAST is not performed in Dev or SIT.",
            )
    if "Performance Testing" in request_types:
        perf_env = (performance_details or {}).get("performance_environment")
        if perf_env not in POST_SIT_ENVIRONMENTS:
            raise HTTPException(
                400,
                f"Performance Testing Environment must be one of {', '.join(POST_SIT_ENVIRONMENTS)} "
                "-- Performance testing is not performed in Dev or SIT.",
            )

    # The real business ID now exists and validation has succeeded. Promote
    # all Draft uploads before either raising immediately or waiting at the
    # Application Owner checkpoint, preventing split DRAFT/TQA folders.
    _promote_draft_upload_folder(db, obj)

    if obj.application_master_status == "PENDING_APP_OWNER":
        # Brand-new "Other" name, still awaiting the first approval tier --
        # stop here. draft_child_details is intentionally left in place;
        # _finalize_child_requests (called from
        # routers/applications.py::decide_app_owner_name once the name is
        # approved) is what actually unstashes it and creates the children.
        obj.status = GatewayStatus.SUBMITTED
        _log(db, obj.id, "Requester", current_user, "Submitted",
             "Awaiting Application Owner approval of the new Application Name before "
             "linked request(s) are generated and assigned to SM")
        db.commit()
        db.refresh(obj)
        return obj

    _finalize_child_requests(db, obj, current_user)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{req_id}/history", response_model=List[schemas.ApprovalActionOut])
def request_history(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.QARequest).get(req_id)
    if not obj:
        raise HTTPException(404, "QA Request not found")
    if not _can_view_gateway(obj, current_user):
        raise HTTPException(403, "This request was never raised (still Draft, or Cancelled before being raised) and is only visible to its requester")
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
    if not _can_view_gateway(obj, current_user):
        raise HTTPException(403, "This request was never raised (still Draft, or Cancelled before being raised) and is only visible to its requester")

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
            ("CR Number/EPIC Number", obj.cr_number),
            ("Change Type", obj.change_type),
            ("Previous Completed Request ID", obj.bug_fix_source_request_id if obj.change_type == "Bug Fix" else None),
            ("Change Description", obj.change_description),
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
            ("Request Type(s)", ",".join(
                value for value in (obj.request_types or "").split(",") if value in REQUEST_TYPES
            )),
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

    # request_id isn't assigned until the gateway is actually raised (see its
    # column comment) -- a still-Draft export (only ever reachable by its own
    # requester/an admin, per _can_view_gateway above) has no business ID yet.
    display_id = obj.request_id or f"Draft #{obj.id}"
    buf = build_request_detail_pdf(
        title=f"{display_id} — {obj.application_name}",
        subtitle="QA Request (Gateway) — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=models.now().strftime("%Y-%m-%d %H:%M IST"),

    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{display_id}.pdf"'},
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
    if not _can_view_gateway(req, current_user):
        raise HTTPException(403, "This request was never raised (still Draft, or Cancelled before being raised) and is only visible to its requester")
    if require_editable:
        if not _can_edit_draft(req, current_user):
            raise HTTPException(403, "Only the current Draft editor can change checklist evidence")
    return req


@router.get("/{req_id}/checklist-evidence/documents", response_model=List[schemas.DraftChecklistEvidenceOut])
def list_all_draft_checklist_evidence(req_id: int, db: Session = Depends(get_db),
                                      current_user: models.User = Depends(get_current_user)):
    """Batched counterpart to list_draft_checklist_evidence below -- the QA
    Request wizard renders one ChecklistEvidencePicker per readiness
    checklist item (up to ~19 each, across up to 4 modules if Functional/
    SAST/DAST/Performance are all selected), and each one used to fire its
    own GET on mount -- reported directly as "multiple /documents api is
    calling on UI load". One query instead: every draft-evidence document
    for this request, across every kind/item, tagged with (kind, item_index)
    parsed back out of its own module key (see _draft_evidence_module/
    _DRAFT_EVIDENCE_PREFIXES) so the frontend can still regroup this one
    flat list into the same per-item buckets it always has."""
    _draft_request_for_evidence(db, req_id, current_user)
    prefix_to_kind = {prefix: kind for kind, prefix in _DRAFT_EVIDENCE_PREFIXES.items()}
    rows = (
        db.query(models.RequestDocument)
        .filter(
            models.RequestDocument.request_id == req_id,
            or_(*[models.RequestDocument.module.like(f"{prefix}_%") for prefix in prefix_to_kind]),
        )
        .order_by(models.RequestDocument.uploaded_at)
        .all()
    )
    out = []
    for doc in rows:
        # module looks like "DRAFT_FUNCTIONAL_03" or "DRAFT_PERF_11" -- split
        # off the final _NN and match the remainder against the known prefix
        # set (can't just rsplit blindly since prefixes themselves contain
        # underscores).
        prefix, _, idx_str = doc.module.rpartition("_")
        kind = prefix_to_kind.get(prefix)
        if kind is None or not idx_str.isdigit():
            continue  # not one of ours -- shouldn't happen given the filter above, just defensive
        out.append(schemas.DraftChecklistEvidenceOut(
            id=doc.id, file_name=doc.file_name, content_type=doc.content_type,
            file_size=doc.file_size, uploaded_by_id=doc.uploaded_by_id, uploaded_at=doc.uploaded_at,
            kind=kind, item_index=int(idx_str),
        ))
    return out


@router.get("/{req_id}/checklist-evidence/{kind}/{item_index}/documents", response_model=List[schemas.RequestDocumentOut])
def list_draft_checklist_evidence(req_id: int, kind: str, item_index: int,
                                  db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    _draft_request_for_evidence(db, req_id, current_user)
    return doc_store.list_documents(db, _draft_evidence_module(db, kind, item_index), req_id)


@router.post("/{req_id}/checklist-evidence/{kind}/{item_index}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_draft_checklist_evidence(req_id: int, kind: str, item_index: int,
                                    files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                    current_user: models.User = Depends(get_current_user)):
    req = _draft_request_for_evidence(db, req_id, current_user, require_editable=True)
    module = _draft_evidence_module(db, kind, item_index)
    return doc_store.save_documents(db, module, req_id,
                                    f"{_storage_key(req)}/{kind}-{item_index}", files, current_user.id)


@router.get("/{req_id}/checklist-evidence/{kind}/{item_index}/documents/{doc_id}/download")
def download_draft_checklist_evidence(req_id: int, kind: str, item_index: int, doc_id: int,
                                      db: Session = Depends(get_db),
                                      current_user: models.User = Depends(get_current_user)):
    _draft_request_for_evidence(db, req_id, current_user)
    doc = doc_store.get_document_or_404(
        db, _draft_evidence_module(db, kind, item_index), req_id, doc_id)
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
        db, _draft_evidence_module(db, kind, item_index), req_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user):
        raise HTTPException(403, "Only whoever uploaded this evidence, or an admin, can delete it")
    doc_store.delete_document(db, doc)
    return {"ok": True}


@router.get("/{req_id}/documents", response_model=List[schemas.QARequestDocumentOut])
def list_documents(req_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    req = db.query(models.QARequest).get(req_id)
    if not req:
        raise HTTPException(404, "QA Request not found")
    if not _can_view_gateway(req, current_user):
        raise HTTPException(403, "This request was never raised (still Draft, or Cancelled before being raised) and is only visible to its requester")
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
    can_upload = (current_user.has_role(Role.ADMIN)
                  or _is_active_delegate(req, current_user)
                  or (req.requester_id == current_user.id and not req.active_delegation))
    if not can_upload:
        raise HTTPException(403, "Only the requester, active delegate, or an admin can upload documents")
    # Reported bug: uploads were still accepted on a Cancelled gateway, which
    # has no further workflow at all -- there's nothing left to attach
    # evidence to. Raised (and Draft/Submitted) still allow it, matching
    # AddDocuments.tsx's own "adding more supporting documents after the
    # request has already been raised" purpose.
    if req.status == GatewayStatus.CANCELLED:
        raise HTTPException(400, "Documents cannot be uploaded to a cancelled request")

    storage_key = _storage_key(req)
    upload_root = doc_store.get_upload_root()
    request_dir = os.path.join(upload_root, storage_key)
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
            stored_path=os.path.join(storage_key, original_name),
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
    req = db.query(models.QARequest).get(req_id)
    if not req:
        raise HTTPException(404, "QA Request not found")
    if not _can_view_gateway(req, current_user):
        raise HTTPException(403, "This request was never raised (still Draft, or Cancelled before being raised) and is only visible to its requester")
    doc = db.query(models.QARequestDocument).filter_by(id=doc_id, qa_request_id=req_id).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    full_path = doc_store.resolve_upload_path(doc.stored_path)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name,
                         media_type=doc.content_type or "application/octet-stream")


@router.delete("/{req_id}/documents/{doc_id}")
def delete_document(req_id: int, doc_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    # Own document table/UPLOAD_ROOT layout (UPLOAD_ROOT/<request_id>/<filename>,
    # not documents.py's UPLOAD_ROOT/<folder>/<module>/<filename>), so this
    # can't call doc_store.delete_document() -- only reuses doc_store's
    # can_delete_document() for the permission check, which is duck-typed
    # (just needs .uploaded_by_id) and applies here unchanged.
    req = db.query(models.QARequest).get(req_id)
    if not req:
        raise HTTPException(404, "QA Request not found")
    if req.active_delegation and req.requester_id == current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "This request is delegated and read-only until it is returned or recalled")
    if not _can_view_gateway(req, current_user):
        raise HTTPException(403, "You do not have access to this request")
    doc = db.query(models.QARequestDocument).filter_by(id=doc_id, qa_request_id=req_id).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    if not doc_store.can_delete_document(doc, current_user):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it")
    full_path = doc_store.resolve_upload_path(doc.stored_path)
    if os.path.exists(full_path):
        os.remove(full_path)
    db.delete(doc)
    db.commit()
    return {"ok": True}
