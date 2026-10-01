import os
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from .. import models, schemas, certificate_summary, certificate_revisions
from ..database import get_db
from ..pagination import Page, PageParams, apply_search, apply_status_filter, apply_sort, paginate, to_page_response
from ..deps import (get_workflow_user as get_current_user, require_workflow_roles as require_roles,
                    dashboard_department_scope, active_qa_workspace_scope_ids,
                    require_entity_workspace_visibility)
from ..constants import Role, SIGNOFF_EDITABLE_STATUSES, QAStatus, format_role_labels, validate_environment_promotion
from ..pdf_export import (
    DIGITAL_SIGNATURE_METHOD,
    QA_CLEARANCE_SIGNED_TYPE,
    RichTextValue,
    build_request_detail_pdf,
    parse_electronic_signature,
    qa_clearance_export_status,
)
from .. import documents as doc_store

router = APIRouter(prefix="/api/signoffs", tags=["signoff"])

# ---------------------------------------------------------------------------
# Module 8: QA Clearance Certificate lifecycle -- Draft (QA Engineer fills
# in the certificate) -> QA Lead Approval -> Executive  Approval -> Issued.
# The linked application may belong to any department. The selected workspace
# and QA permission profile govern this workflow.
# ---------------------------------------------------------------------------


def _log(db: Session, entity_id: int, step: str, user: models.User, decision: str, comments: Optional[str] = None):
    db.add(models.ApprovalAction(
        entity_type="SIGNOFF", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require_workspace_approver(obj: models.QASignOff, user: models.User, *, executive: bool = False):
    """Use the certificate workspace, not an obsolete QA department guard."""
    roles = (Role.CHIEF_MANAGER_QA, Role.AGM_QA) if executive else (
        Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)
    if not obj.qa_workspace_id or not user.has_qa_workspace_role(*roles, workspace_id=obj.qa_workspace_id):
        raise HTTPException(403, 'An authorized QA approver in the certificate workspace is required')


def _require(obj, expected_statuses, action: str):
    from ..workspace_service import current_workspace_scope_ids
    selected = current_workspace_scope_ids()
    if selected and obj.qa_workspace_id not in selected:
        raise HTTPException(404, "Clearance certificate not found in the active workspace")
    if isinstance(expected_statuses, str):
        expected_statuses = [expected_statuses]
    if obj.status not in expected_statuses:
        raise HTTPException(400, f"'{action}' requires status in {expected_statuses} (currently '{obj.status}')")


def _source_assigned_tester_ids(source: "models.FunctionalRequest | None") -> set[int]:
    if source is None:
        return set()
    return {
        int(value)
        for value in (source.assigned_tester_ids or "").split(",")
        if value.strip().isdigit()
    }


def _revision_actor_allowed(
    obj: "models.QASignOff",
    source: "models.FunctionalRequest | None",
    user: models.User,
) -> bool:
    """One actor rule shared by the detail capability and revision command."""
    assigned_testers = _source_assigned_tester_ids(source)
    has_active_qa_access = bool(
        user.is_active
        and user.has_qa_workspace_role(
            Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
            workspace_id=obj.qa_workspace_id,
            allow_admin=False,
        )
    )
    is_workspace_qa_lead = bool(
        user.is_active
        and user.has_qa_workspace_role(
            Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
            workspace_id=obj.qa_workspace_id,
            allow_admin=False,
        )
    )
    return bool(
        is_workspace_qa_lead
        or (
            has_active_qa_access
            and (
                user.id in assigned_testers
                or (not assigned_testers and obj.requester_id == user.id)
            )
        )
    )


def _clearance_creation_actor_allowed(
    source: "models.FunctionalRequest",
    user: models.User,
) -> bool:
    """Authorize a new certificate from live request assignment/workspace data."""
    workspace_id = source.qa_request.qa_workspace_id if source.qa_request else None
    if not user.is_active or workspace_id is None:
        return False
    if user.has_qa_workspace_role(
        Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
        workspace_id=workspace_id,
        allow_admin=False,
    ):
        return True
    return bool(
        user.id in _source_assigned_tester_ids(source)
        and user.has_qa_workspace_role(
            Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
            workspace_id=workspace_id,
            allow_admin=False,
        )
    )


def _workspace_qa_lead_actor(obj: "models.QASignOff", user: models.User) -> bool:
    return bool(
        user.is_active
        and obj.qa_workspace_id is not None
        and user.has_qa_workspace_role(
            Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
            workspace_id=obj.qa_workspace_id,
            allow_admin=False,
        )
    )


def _certificate_owner_is_eligible(
    db: Session,
    obj: "models.QASignOff",
    source: "models.FunctionalRequest | None",
    *,
    lock: bool = False,
) -> bool:
    """Whether the current Draft author can still continue this certificate."""
    if obj.requester_id is None or source is None:
        return False
    owner_query = db.query(models.User).filter(models.User.id == obj.requester_id).populate_existing()
    if lock:
        owner_query = owner_query.with_for_update()
    owner = owner_query.one_or_none()
    if owner is None or not owner.is_active or obj.qa_workspace_id is None:
        return False

    role_query = db.query(models.UserRole).filter(
        models.UserRole.user_id == owner.id,
    ).order_by(models.UserRole.id).populate_existing()
    membership_query = db.query(models.QAWorkspaceMember).filter(
        models.QAWorkspaceMember.user_id == owner.id,
        models.QAWorkspaceMember.workspace_id == obj.qa_workspace_id,
    ).order_by(models.QAWorkspaceMember.id).populate_existing()
    workspace_query = db.query(models.QAWorkspace).filter(
        models.QAWorkspace.id == obj.qa_workspace_id,
    ).populate_existing()
    if lock:
        # The Functional source and certificate are already locked. Lock the
        # mutable owner eligibility rows only afterward, in stable order, so a
        # stale preview cannot authorize takeover after the owner is restored.
        role_query = role_query.with_for_update()
        membership_query = membership_query.with_for_update()
        workspace_query = workspace_query.with_for_update()
    role_codes = {row.role for row in role_query.all()}
    memberships = [row for row in membership_query.all() if row.is_active]
    workspace = workspace_query.one_or_none()
    if not workspace or not workspace.is_active or not memberships:
        return False
    # Neutral WORKSPACE_MEMBER rows combine with the global permission profile;
    # legacy membership rows that still carry a QA role remain supported.
    role_codes.update(row.role for row in memberships)
    is_lead = bool({Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA} & role_codes)
    has_qa_role = bool({
        Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    } & role_codes)
    is_assigned_tester = (
        owner.id in _source_assigned_tester_ids(source)
        and has_qa_role
    )
    return bool(is_lead or is_assigned_tester)


def _qa_lead_takeover_allowed(
    db: Session,
    obj: "models.QASignOff",
    source: "models.FunctionalRequest | None",
    user: models.User,
) -> bool:
    return bool(
        obj.status in SIGNOFF_EDITABLE_STATUSES
        and source is not None
        and source.signoff_id == obj.id
        and source.request_id == obj.testing_request_id
        and _workspace_qa_lead_actor(obj, user)
        and not _certificate_owner_is_eligible(db, obj, source)
    )


def _get_or_404(db: Session, signoff_id: int) -> "models.QASignOff":
    obj = db.get(models.QASignOff, signoff_id)
    if not obj:
        raise HTTPException(404, "Clearance certificate not found")
    from ..workspace_service import current_workspace_scope_ids
    selected = current_workspace_scope_ids()
    if selected and obj.qa_workspace_id not in selected:
        raise HTTPException(404, "Clearance certificate not found")
    return obj


def _get_visible_or_404(db: Session, signoff_id: int, user: models.User) -> "models.QASignOff":
    """Resolve a certificate while enforcing request-department privacy."""
    obj = _get_or_404(db, signoff_id)
    require_entity_workspace_visibility(db, user, "SIGNOFF", obj.id)
    scope = dashboard_department_scope(user)
    if scope is not None and obj.request_department not in scope:
        # Deliberately 404 instead of 403 so another department cannot use
        # sequential IDs to discover whether a private certificate exists.
        raise HTTPException(404, "Clearance certificate not found")
    # UI hint only; the mutating endpoint re-evaluates the same helper after
    # row-locking both the Functional source and certificate.
    obj.revision_actor_allowed = _revision_actor_allowed(
        obj, obj.source_functional_request, user,
    )
    obj.can_create_revision = bool(
        obj.revision_actor_allowed
        and certificate_revisions.revision_workflow_available(
            db, obj, obj.source_functional_request,
        )
    )
    obj.can_take_over = _qa_lead_takeover_allowed(
        db, obj, obj.source_functional_request, user,
    )
    return obj


def _lock_signoff_source_first(
    db: Session,
    signoff_id: int,
    *,
    visible_to: models.User | None = None,
) -> tuple["models.QASignOff", "models.FunctionalRequest | None"]:
    """Lock a mutable certificate in the global parent-before-child order.

    Functional clearance endpoints lock FunctionalRequest then QASignOff.
    Sign-off endpoints must use the same order or two workers can deadlock on
    Oracle while one submits/returns a Draft and another handles a request
    action. The unlocked read is used only to discover the immutable business
    request key; every value used by the transition is reloaded after both
    locks are acquired.
    """
    preview = (
        _get_visible_or_404(db, signoff_id, visible_to)
        if visible_to is not None
        else _get_or_404(db, signoff_id)
    )
    request_key = preview.testing_request_id
    source = None
    if request_key:
        source = (
            db.query(models.FunctionalRequest)
            .filter(models.FunctionalRequest.request_id == request_key)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
    obj = (
        db.query(models.QASignOff)
        .filter(models.QASignOff.id == signoff_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if obj is None:
        raise HTTPException(404, "Clearance certificate not found")
    if obj.testing_request_id != request_key:
        raise HTTPException(
            409,
            "The certificate source changed concurrently; refresh before continuing",
        )
    # Repeat visibility against the locked identity. The source lock also
    # stabilizes the request department used by the visibility decision.
    if visible_to is not None:
        _get_visible_or_404(db, signoff_id, visible_to)
    else:
        _get_or_404(db, signoff_id)
    return obj, source


def _sync_linked_functional_request(db: Session, obj: "models.QASignOff", current_user: models.User):
    """A certificate reaching ISSUED after Executive  final approval
    previously never moved the linked Functional Testing Request off
    "QA Clearance Pending" -- that hop only ever happened via a separate,
    manual "Confirm Sign-off" button (routers/functional.py::confirm_signoff)
    that a QA Lead had to remember to click themselves, and which didn't even
    check that the certificate was actually Issued before letting them.
    Since the certificate's own QA Engineer -> QA Lead ->  approval
    chain already fully covers "is this sign-off actually approved", that
    separate manual step is redundant and easy to forget -- so this now
    syncs automatically the moment the certificate is Issued, and the
    Functional Testing Request's own "Confirm Sign-off" button has been
    removed from the frontend (see Functional.tsx). Mirrors confirm_signoff's
    own two-step log (QA Clearance "Signed Off", then Requester Verification
    "Pending") so the History tab reads identically either way."""
    if obj.certificate_type not in {
        "Full Clearance", "Conditional Clearance", "Clearance Denied",
    }:
        return
    linked = (db.query(models.FunctionalRequest)
              .filter_by(signoff_id=obj.id, status=QAStatus.QA_SIGNOFF_PENDING).all())
    for fr in linked:
        workspace_id = fr.qa_request.qa_workspace_id if fr.qa_request else None
        if (
            obj.status != "ISSUED"
            or fr.request_id != obj.testing_request_id
            or workspace_id is None
            or workspace_id != obj.qa_workspace_id
        ):
            raise HTTPException(
                409,
                "The issued clearance certificate does not belong to the linked Functional Request and QA workspace",
            )
        if obj.certificate_type == "Clearance Denied":
            previous = fr.status
            fr.status = QAStatus.REQUESTER_VERIFICATION
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST", entity_id=fr.id,
                step_name="QA Clearance Decision",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision="Clearance Denied",
                comments=(
                    f"Certificate {obj.certificate_id} issued the QA denial decision; "
                    "this is not a positive clearance."
                ),
                previous_state=previous,
                new_state=QAStatus.REQUESTER_VERIFICATION,
            ))
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST", entity_id=fr.id,
                step_name="Requester Verification",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision="Denial Acknowledgement Pending",
                comments="Sent to the requester to acknowledge or return the denial decision for changes.",
            ))
            continue
        fr.status = QAStatus.QA_SIGNED_OFF
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=fr.id, step_name="QA Clearance",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Cleared",
            comments=f"Certificate {obj.certificate_id} issued by Executive",
        ))
        fr.status = QAStatus.REQUESTER_VERIFICATION
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=fr.id, step_name="Requester Verification",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Pending",
            comments="Sent for requester verification",
        ))


def _sync_linked_functional_clearance_queue(
    db: Session,
    obj: "models.QASignOff",
    current_user: models.User,
    target_status: str,
    decision: str,
    comments: str,
) -> None:
    """Keep the Functional bucket aligned with the certificate's real owner.

    A Draft/returned certificate belongs to its QA author (QA_COMPLETED),
    while a submitted certificate belongs to the QA approval chain
    (QA_SIGNOFF_PENDING). Locking the source row in the same transaction as
    the certificate transition prevents a transient or permanently stale
    bucket assignment.
    """
    sources = (
        db.query(models.FunctionalRequest)
        .filter(models.FunctionalRequest.signoff_id == obj.id)
        .populate_existing()
        .with_for_update()
        .all()
    )
    for source in sources:
        if source.request_id != obj.testing_request_id:
            raise HTTPException(
                409,
                "The clearance certificate is linked to a mismatched Functional Request",
            )
        if source.status == target_status:
            continue
        previous = source.status
        source.status = target_status
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST",
            entity_id=source.id,
            step_name="QA Clearance",
            actor_id=current_user.id,
            actor_role=current_user.roles_csv,
            decision=decision,
            comments=f"{comments} Functional status: {previous} -> {target_status}.",
        ))


def _validate_rich_text_before_progress(obj: models.QASignOff) -> None:
    """Block workflow advancement for legacy records saved before the API
    enforced the editor's 10,000-character contract. Return/reject decisions
    remain available so an approver can send an invalid record back; callers
    invoke this only for submit/resubmit/approve paths.
    """
    fields = (
        ("Testing Scope Completed", obj.exit_criteria_notes),
        ("Open Risks (if any)", obj.open_defect_summary),
        ("Remarks", obj.residual_risk_notes),
        ("Known Limitations", obj.known_limitations),
        ("Business Acceptance Status", obj.business_acceptance_status),
        ("Security Testing Status", obj.security_testing_status),
        ("Conditional Clearance Observations", obj.conditional_observations),
        ("Conditional Clearance Mitigation", obj.conditional_mitigation),
    )
    oversized = [
        f"{label} ({len(value):,}/{schemas.RICH_TEXT_MAX_LENGTH:,})"
        for label, value in fields
        if value is not None and len(value) > schemas.RICH_TEXT_MAX_LENGTH
    ]
    if oversized:
        raise HTTPException(
            400,
            "Cannot continue the QA Clearance workflow because rich-text content exceeds the limit: "
            + "; ".join(oversized)
            + ". Edit the certificate and reduce each field to 10,000 characters or fewer.",
        )


class SignOffPage(Page[schemas.SignOffListOut]):
    departments: list[str]
    status_counts: dict[str, int]


@router.get("", response_model=SignOffPage)
def list_signoffs(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user),
                  params: PageParams = Depends()):
    # The module is visible to every authenticated account, but business
    # users may only see certificates originating from their own department.
    # QA delivery/executive roles and read-only administrative visibility are
    # intentionally unscoped by dashboard_department_scope because their
    # responsibilities span departments. Filter on the linked request's
    # department, not QASignOff.department (the latter is retained only as source-department metadata and would make business privacy filtering meaningless).
    # Perf tuning (2026-08, reported directly: "some of the apis are taking
    # lot of timing") -- SignOffOut.request_department reads
    # source_functional_request (a viewonly relationship matched on business
    # ID, not a normal FK), previously lazy-loaded once per row. joinedload
    # here turns that into a single extra LEFT JOIN for the whole page
    # instead of one query per certificate. Nested .qa_request load added
    # alongside it so the new SignOffOut.change_description (two-hop via
    # models.QASignOff.change_description) doesn't reintroduce the same
    # N+1 this comment was written to fix.
    q = db.query(models.QASignOff).select_from(models.QASignOff).options(
        joinedload(models.QASignOff.qa_workspace),
        joinedload(models.QASignOff.source_functional_request)
        .joinedload(models.FunctionalRequest.qa_request)
    )
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = (q.join(
                models.FunctionalRequest,
                models.FunctionalRequest.request_id == models.QASignOff.testing_request_id,
            )
            .join(models.QARequest, models.QARequest.id == models.FunctionalRequest.qa_request_id)
            .filter(models.QARequest.department.in_(scope)))
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if workspace_ids:
        q = q.filter(models.QASignOff.qa_workspace_id.in_(workspace_ids))
    # Join once for display-field filtering; scope remains applied before counts.
    if scope is None:
        q = (q.outerjoin(models.FunctionalRequest, models.FunctionalRequest.request_id == models.QASignOff.testing_request_id)
                 .outerjoin(models.QARequest, models.QARequest.id == models.FunctionalRequest.qa_request_id))
    departments = [row[0] for row in q.with_entities(models.QARequest.department).distinct().all() if row[0]]
    if params.department:
        q = q.filter(models.QARequest.department == params.department)
    q = apply_search(q, params, models.QASignOff.certificate_id, models.QASignOff.application_name,
                     models.QASignOff.testing_request_id)
    q = apply_status_filter(q, params, models.QASignOff.status)
    status_counts = dict(q.with_entities(models.QASignOff.status, func.count(models.QASignOff.id))
                        .group_by(models.QASignOff.status).all())
    q = apply_sort(q, params, sortable={"certificate_id": models.QASignOff.certificate_id,
                                      "application_name": models.QASignOff.application_name,
                                      "status": models.QASignOff.status},
                   default_column=models.QASignOff.created_at, id_column=models.QASignOff.id)
    return {**to_page_response(paginate(q, params), params),
            "departments": sorted(departments), "status_counts": status_counts}


@router.get("/{signoff_id}", response_model=schemas.SignOffOut)
def get_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_visible_or_404(db, signoff_id, current_user)


@router.post("", response_model=schemas.SignOffOut)
def create_signoff(payload: schemas.SignOffCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """Raised by the QA Engineer who executed testing -- or, 2026-08 (reported
    directly: "'Request Sign Off' button is not enable[d] for QA lead ... if
    tester [is] no[t] available then at least [o]n behalf of QA he can raise
    the request"), by the QA Lead group on behalf of a request whose tester
    isn't available to raise it themselves. Starts as a Draft either way --
    no different downstream handling based on who created it."""
    data = payload.model_dump()
    # Serialize certificate creation per source request. The database's
    # function-based unique index remains the final concurrency backstop.
    source = (
        db.query(models.FunctionalRequest)
        .filter(models.FunctionalRequest.request_id == data.get("testing_request_id"))
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if not source or not source.qa_request:
        raise HTTPException(400, "Select a Functional Request in the active workspace")
    # Keep the source department for reporting. Approval ownership comes
    # from qa_workspace_id and must never be inferred from a department name.
    data["department"] = source.qa_request.department
    data["qa_workspace_id"] = source.qa_request.qa_workspace_id
    selected_workspaces = active_qa_workspace_scope_ids(current_user)
    if selected_workspaces and data["qa_workspace_id"] not in selected_workspaces:
        raise HTTPException(404, "Functional Request not found in the active workspace")
    if not _clearance_creation_actor_allowed(source, current_user):
        raise HTTPException(
            403,
            "Only the QA Lead group in this workspace or a currently assigned tester "
            "with active workspace access can create a certificate for this request",
        )
    existing_active = certificate_revisions.active_certificate(db, source.request_id)
    if existing_active:
        raise HTTPException(
            409,
            f"{existing_active.certificate_id} is already the active certificate for "
            f"{source.request_id}; open and continue that certificate instead",
        )
    if source.signoff_id is not None:
        linked = db.get(models.QASignOff, source.signoff_id)
        if linked and linked.status in (
            "ISSUED", "ISSUED_UNDER_REVIEW", "SM_REJECTED", "DEPT_HEAD_COE_REJECTED",
        ):
            raise HTTPException(
                409,
                f"{linked.certificate_id} is the terminal certificate for {source.request_id}; "
                "use Create Revised Certificate on that certificate",
            )
        if linked:
            raise HTTPException(
                409,
                f"{linked.certificate_id} is already linked to {source.request_id}; "
                "resolve that certificate instead of creating a parallel draft",
            )
    if source.status not in certificate_summary.CLEARANCE_SOURCE_STATUSES:
        raise HTTPException(
            409,
            "A QA Clearance or Clearance Denied Draft can be created only after QA is completed. "
            "If an issued certificate is under review, use its governed Resend, Revise, or Retest action.",
        )
    # Same Environment Tested/Target Promotion Environment ordering rule as
    # routers/qa_requests.py::create_request/edit_request and
    # routers/functional.py::update_functional -- reuses the same shared
    # validate_environment_promotion helper rather than a duplicate check.
    # The frontend's own two selects already only offer valid combinations,
    # this is the defense-in-depth backstop before a direct API call.
    try:
        validate_environment_promotion(data.get("environment_tested"), data.get("target_promotion_environment"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    obj = models.QASignOff(**data, status="DRAFT", requester_id=current_user.id)
    # Isolate the early INSERT in a savepoint. If evidence capture rejects
    # the request, only this new certificate is rolled back; other valid
    # changes already present in the request transaction are preserved.
    try:
        with db.begin_nested():
            db.add(obj)
            # Attach and flush before capture so QASignOff.live_testing_scope can
            # resolve its view-only Functional Request relationship. Capturing a
            # transient object freezes the fallback "Functional" scope even when
            # the parent request contains multiple testing types.
            db.flush()
            # Creation and Functional linking are one atomic operation. The
            # UI still calls request-signoff after POST /signoffs for
            # backward compatibility, but a lost second HTTP request can no
            # longer leave an orphan Draft that occupies the active unique
            # key while the Functional Request points at nothing.
            previous_source_status = source.status
            source.signoff_id = obj.id
            # Legacy/orphan QA_SIGNOFF_PENDING rows have no active
            # certificate owner. A newly created Draft belongs to its QA
            # author, so repair the bucket in this same atomic transaction.
            if source.status == QAStatus.QA_SIGNOFF_PENDING:
                source.status = QAStatus.QA_COMPLETED
            db.flush()
            certificate_summary.refresh(db, obj)
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST",
                entity_id=source.id,
                step_name="QA Completed",
                actor_id=current_user.id,
                actor_role=current_user.roles_csv,
                decision="Clearance Draft Linked",
                comments=(
                    f"Certificate {obj.certificate_id} created and linked atomically."
                    + (
                        " Legacy QA Sign-off Pending state was restored to QA Completed "
                        "because the Draft remains with its QA author."
                        if previous_source_status != source.status
                        else ""
                    )
                ),
                previous_state=(
                    previous_source_status
                    if previous_source_status != source.status
                    else None
                ),
                new_state=(
                    source.status
                    if previous_source_status != source.status
                    else None
                ),
            ))
    except IntegrityError as exc:
        raise HTTPException(
            409,
            f"Another active certificate already exists for {source.request_id}; refresh and continue it",
        ) from exc
    _log(db, obj.id, "Requester", current_user, "Drafted", "QA Clearance Certificate created as draft")
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{signoff_id}", response_model=schemas.SignOffOut)
def update_signoff(signoff_id: int, payload: schemas.SignOffUpdate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Two different actors, two different windows: the QA requester
    can edit while the certificate is DRAFT or sitting back with them after
    a QA Lead/Executive  return; a QA Lead can additionally edit it
    directly while it's sitting at their approval checkpoint rather than
    returning it first just to fix something minor. Executive 
    gets no edit window; their only actions are Approve/Return/Reject."""
    obj, _ = _lock_signoff_source_first(db, signoff_id)
    if obj.status not in [*SIGNOFF_EDITABLE_STATUSES, "SM_APPROVAL_PENDING"]:
        raise HTTPException(400, "Refresh and reopen this certificate for reapproval before editing")
    is_own = obj.requester_id == current_user.id
    # Executive roles can act at the QA-Lead checkpoint when they hold active
    # access to this certificate's workspace.
    is_qa_lead = current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)

    # Checked in this order deliberately: the QA-Lead-reviewing-right-now window
    # is checked first so a user who happens to be both the original
    # requester AND holds the QA Lead role isn't wrongly blocked by the
    # requester's own (narrower) editable-status gate below.
    if is_qa_lead and obj.status == "SM_APPROVAL_PENDING":
        _require_workspace_approver(obj, current_user)
    elif is_own:
        if obj.status not in SIGNOFF_EDITABLE_STATUSES:
            raise HTTPException(400, f"Certificate cannot be edited while in status '{obj.status}'")
    else:
        raise HTTPException(403, "Only the certificate owner, or a QA Lead during approval, can edit this certificate")

    data = payload.model_dump(exclude_unset=True)
    # Same shared-method ordering check as create_signoff -- only actually
    # re-validated when the client sent at least one of the two fields
    # (exclude_unset=True-aware, same pattern as qa_requests.py::edit_request),
    # falling back to obj's own current value for whichever field wasn't sent.
    if "environment_tested" in data or "target_promotion_environment" in data:
        final_environment_tested = data.get("environment_tested", obj.environment_tested)
        final_target = data.get("target_promotion_environment", obj.target_promotion_environment)
        try:
            validate_environment_promotion(final_environment_tested, final_target)
        except ValueError as e:
            raise HTTPException(400, str(e))
    for k, v in data.items():
        setattr(obj, k, v)
    # Archive the old approval ownership before clearing it.
    certificate_summary.refresh(db, obj)
    # Every content edit starts a fresh approval cycle; no executive-only shortcut.
    obj.status = 'DRAFT'
    obj.reviewed_by_id = None
    obj.approved_by_id = None
    obj.issued_by_id = None
    obj.signed_by_id = None
    _log(db, obj.id, 'Certificate revision', current_user, 'Approval reset', 'Certificate edited; full reapproval required')
    _sync_linked_functional_clearance_queue(
        db, obj, current_user, QAStatus.QA_COMPLETED,
        "Clearance Draft Reopened",
        f"Certificate {obj.certificate_id} was edited and returned to its QA author.",
    )
    db.commit()
    db.refresh(obj)
    return obj


@router.post('/{signoff_id}/refresh-summary', response_model=schemas.SignOffOut)
def refresh_certificate_summary(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj, _ = _lock_signoff_source_first(db, signoff_id, visible_to=current_user)
    if obj.requester_id != current_user.id:
        raise HTTPException(403, 'Only the current certificate owner can refresh and reopen it')
    if obj.status in ('ISSUED', 'ISSUED_UNDER_REVIEW', 'SM_REJECTED', 'DEPT_HEAD_COE_REJECTED', 'SUPERSEDED', 'VOIDED'):
        raise HTTPException(
            409,
            'Issued, rejected, and historical certificates are immutable. Use Create Revised Certificate on the current lineage head.',
        )
    snapshot = certificate_summary.refresh(db, obj)
    obj.status = 'DRAFT'
    obj.reviewed_by_id = None
    obj.approved_by_id = None
    obj.issued_by_id = None
    obj.signed_by_id = None
    _log(db, obj.id, 'Certificate revision', current_user, 'Approval reset',
         f"Summary revision {snapshot['revision']} captured; previous clearance and approvals invalidated. Full reapproval required.")
    _sync_linked_functional_clearance_queue(
        db, obj, current_user, QAStatus.QA_COMPLETED,
        "Clearance Draft Reopened",
        f"Certificate {obj.certificate_id} summary was refreshed; full reapproval is required.",
    )
    db.commit()
    db.refresh(obj)
    return obj


@router.post('/{signoff_id}/revisions', response_model=schemas.SignOffOut, status_code=201)
def create_signoff_revision(
    signoff_id: int,
    payload: schemas.SignOffRevisionCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Create one governed successor while preserving the terminal original."""
    obj, source = _lock_signoff_source_first(db, signoff_id, visible_to=current_user)
    if source is None:
        raise HTTPException(409, "The linked Functional Request no longer exists")
    if not _revision_actor_allowed(obj, source, current_user):
        raise HTTPException(
            403,
            "Only the QA Lead group in this workspace or a currently assigned tester can "
            "create the revision; the original requester is a fallback only when no tester is assigned",
        )
    if not certificate_revisions.revision_workflow_available(db, obj, source):
        raise HTTPException(
            409,
            "A revised certificate cannot be created from the current request, certificate, "
            "or lineage state. Finish any active Retest and refresh the current certificate first.",
        )
    try:
        successor = certificate_revisions.create_certificate_revision(
            db, obj, current_user, payload.reason,
            # The governed actor who creates the revision owns its Draft.
            # This also prevents governed recovery from handing the new work
            # back to an inactive or reassigned former author.
            successor_requester_id=current_user.id,
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            409,
            'A certificate revision was created concurrently; refresh before continuing',
        ) from exc
    db.refresh(successor)
    return successor


@router.post(
    "/{signoff_id}/qa-lead-group-takeover",
    response_model=schemas.SignOffOut,
)
def qa_lead_group_takeover(
    signoff_id: int,
    payload: schemas.SignOffOwnershipTakeoverIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(
        Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    )),
):
    """Recover an editable certificate whose QA author can no longer act.

    This is an ownership repair, not an approval bypass. Returned certificates
    are reset to Draft and all approvals are cleared; after the new owner
    submits, the existing maker-checker guard requires a different QA Lead to
    approve it.
    """
    obj, source = _lock_signoff_source_first(
        db, signoff_id, visible_to=current_user,
    )
    if not _workspace_qa_lead_actor(obj, current_user):
        raise HTTPException(
            403,
            "Certificate takeover is restricted to the QA Lead Group in this workspace",
        )
    if source is None or source.signoff_id != obj.id or source.request_id != obj.testing_request_id:
        raise HTTPException(
            409,
            "The certificate is not the current certificate linked to its Functional Request",
        )
    if obj.status not in SIGNOFF_EDITABLE_STATUSES:
        raise HTTPException(
            409,
            "Ownership can be taken over only while a certificate is Draft or returned to its QA author",
        )
    if _certificate_owner_is_eligible(db, obj, source, lock=True):
        raise HTTPException(
            409,
            "The current certificate owner is still active and eligible in this workspace. "
            "Reassign the Functional tester through the governed request workflow if ownership must change.",
        )

    previous_status = obj.status
    previous_owner_id = obj.requester_id
    previous_owner = db.get(models.User, previous_owner_id) if previous_owner_id else None
    previous_owner_label = (
        f"{previous_owner.full_name} (user #{previous_owner_id})"
        if previous_owner is not None
        else f"Unavailable user #{previous_owner_id}" if previous_owner_id else "Unassigned"
    )
    new_owner_label = f"{current_user.full_name} (user #{current_user.id})"

    obj.requester_id = current_user.id
    obj.status = "DRAFT"
    obj.reviewed_by_id = None
    obj.approved_by_id = None
    obj.issued_by_id = None
    obj.signed_by_id = None
    obj.can_take_over = False
    comments = (
        f"Certificate ownership transferred from {previous_owner_label} to {new_owner_label}. "
        f"Previous certificate status: {previous_status}; reset to Draft with all approvals cleared. "
        f"Reason: {payload.reason}. A different QA Lead must complete the approval after submission."
    )
    db.add_all([
        models.ApprovalAction(
            entity_type="SIGNOFF", entity_id=obj.id,
            step_name="Certificate Ownership",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="QA Lead Group Takeover", comments=comments,
            previous_state=previous_owner_label, new_state=new_owner_label,
        ),
        models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=source.id,
            step_name="QA Clearance Ownership",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Certificate Ownership Transferred", comments=comments,
            previous_state=previous_owner_label, new_state=new_owner_label,
        ),
    ])
    _sync_linked_functional_clearance_queue(
        db, obj, current_user, QAStatus.QA_COMPLETED,
        "Clearance Ownership Transferred",
        f"Certificate {obj.certificate_id} now belongs to {current_user.full_name} and requires full reapproval.",
    )
    db.commit()
    db.refresh(obj)
    obj.can_take_over = False
    return obj


@router.post("/{signoff_id}/submit", response_model=schemas.SignOffOut)
def submit_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj, _ = _lock_signoff_source_first(db, signoff_id)
    if obj.requester_id != current_user.id:
        raise HTTPException(403, "Only the current certificate owner can submit this certificate")
    _require(obj, "DRAFT", "Submit")
    _validate_rich_text_before_progress(obj)
    certificate_summary.validate(obj, db)
    obj.status = "SUBMITTED"
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "QA Lead Approval", current_user, "Pending", "Awaiting QA Lead decision")
    _sync_linked_functional_clearance_queue(
        db, obj, current_user, QAStatus.QA_SIGNOFF_PENDING,
        "QA Lead Approval Pending",
        f"Certificate {obj.certificate_id} was submitted for approval.",
    )
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/resubmit", response_model=schemas.SignOffOut)
def resubmit_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Re-submits a certificate returned by QA Lead or Executive. A rejection
    is terminal for that certificate and must continue through the governed
    revision endpoint, which preserves the rejection and creates a new Draft.
    A return from Executive
    goes straight back to their own queue (QA Lead already approved it
    once) -- the direct return goes back to Executive  rather than
    repeating QA Lead approval.

    RETURNED_BY_REQUESTER is retained for certificates created before the
    immutable-revision rollout. New Requester "Changes Required" decisions
    place the issued certificate under QA review; QA explicitly chooses
    whether to resend, revise, or retest. This branch only lets legacy rows
    complete their existing path."""
    obj, _ = _lock_signoff_source_first(db, signoff_id)
    if obj.requester_id != current_user.id:
        raise HTTPException(403, "Only the current certificate owner can resubmit this certificate")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPT_HEAD_COE", "RETURNED_BY_REQUESTER"], "Resubmit")
    _validate_rich_text_before_progress(obj)
    certificate_summary.validate(obj, db)
    if obj.status in ("RETURNED_BY_SM", "RETURNED_BY_REQUESTER"):
        reopening = obj.status == "RETURNED_BY_REQUESTER"
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "QA Lead Approval", current_user,
             "Reopened" if reopening else "Resubmitted",
             "Rejected certificate reopened and re-submitted" if reopening else "Returned certificate re-submitted")
    else:
        obj.status = "DEPT_HEAD_QA_APPROVAL_PENDING"
        _log(db, obj.id, "Executive Approval", current_user, "Resubmitted", "Returned certificate re-submitted")
    _sync_linked_functional_clearance_queue(
        db, obj, current_user, QAStatus.QA_SIGNOFF_PENDING,
        "Clearance Re-submitted",
        f"Certificate {obj.certificate_id} was re-submitted for approval.",
    )
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/qa-lead-decision", response_model=schemas.SignOffOut)
def qa_lead_decision(signoff_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                     current_user: models.User = Depends(
                         require_roles(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """QA Lead approval checkpoint before Executive  final approval."""
    obj, _ = _lock_signoff_source_first(db, signoff_id)
    _require_workspace_approver(obj, current_user)
    if obj.requester_id == current_user.id:
        raise HTTPException(403, "The certificate owner cannot approve their own certificate")
    _require(obj, "SM_APPROVAL_PENDING", "QA Lead decision")
    if payload.decision == "Approved":
        _validate_rich_text_before_progress(obj)
        certificate_summary.validate(obj, db)
        obj.status = "DEPT_HEAD_QA_APPROVAL_PENDING"
        obj.reviewed_by_id = current_user.id
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "SM_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "QA Lead Approval", current_user, payload.decision, payload.comments)
    if payload.decision in {"Returned", "Rejected"}:
        _sync_linked_functional_clearance_queue(
            db, obj, current_user, QAStatus.QA_COMPLETED,
            f"Clearance {payload.decision} by QA Lead",
            f"Certificate {obj.certificate_id} requires action by its QA author.",
        )
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{signoff_id}/executive-coe-decision", response_model=schemas.SignOffOut)
def executive_coe_decision(signoff_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(
                               Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    # 2026-08 -- this is now the "Executive Group" any-active-member
    # checkpoint: any active Chief Manager QA or AGM QA holds identical
    # authority here and either one's action completes this stage (reported
    # directly -- see constants.py::Role's own comment on the
    # CHIEF_MANAGER_QA/AGM_QA consolidation). Previously 3 roles
    # (CHEIF_MANAGER_COE/CHEIF_MANAGER_QA/AGM_COE) with the COE variants
    # retired; existing UserRole rows were migrated by the one-time
    # role-consolidation data-fix script.
    """Final workspace QA approval by Executive  (the QA Executive Group); approval issues the certificate."""
    obj, _ = _lock_signoff_source_first(db, signoff_id)
    _require_workspace_approver(obj, current_user, executive=True)
    if obj.requester_id == current_user.id:
        raise HTTPException(403, "The certificate owner cannot approve their own certificate")
    _require(obj, "DEPT_HEAD_QA_APPROVAL_PENDING", "Executive  decision")
    # Maker-checker separation across the two approval stages. A Chief
    # Manager/AGM may be eligible for both role groups, but once that person
    # records the QA Lead decision they cannot sign the final Executive
    # decision on the same certificate. System administration is not an
    # exception to this maker-checker separation.
    if obj.reviewed_by_id == current_user.id:
        raise HTTPException(
            403,
            "Final Executive approval must be completed by a different approver; "
            "your QA Lead approval is already recorded on this certificate.",
        )
    if payload.decision == "Approved":
        _validate_rich_text_before_progress(obj)
        certificate_summary.validate(obj, db)
        obj.status = "ISSUED"
        obj.approved_by_id = current_user.id
        _sync_linked_functional_request(db, obj, current_user)
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPT_HEAD_COE"
    elif payload.decision == "Rejected":
        obj.status = "DEPT_HEAD_COE_REJECTED"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "Executive Approval", current_user, payload.decision, payload.comments)
    if payload.decision in {"Returned", "Rejected"}:
        _sync_linked_functional_clearance_queue(
            db, obj, current_user, QAStatus.QA_COMPLETED,
            f"Clearance {payload.decision} by Executive",
            f"Certificate {obj.certificate_id} requires action by its QA author.",
        )
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{signoff_id}/history", response_model=List[schemas.ApprovalActionOut])
def signoff_history(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_visible_or_404(db, signoff_id, current_user)
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SIGNOFF", entity_id=signoff_id)
            .order_by(models.ApprovalAction.created_at).all())


def _certificate_lineage_export_fields(db: Session, obj: models.QASignOff) -> list[tuple[str, object]]:
    """Return only lineage rows that apply to this certificate.

    Resolve the business certificate number directly from the persisted
    foreign key rather than relying on relationship-loading state. A current
    lineage head has no successor, so it must not render a misleading blank
    "Superseded By" row. Conversely, a row already marked SUPERSEDED should
    never hide a corrupt/missing successor link behind an em dash.
    """
    fields: list[tuple[str, object]] = []

    def certificate_number(linked_id: int) -> str:
        linked = db.get(models.QASignOff, linked_id)
        return linked.certificate_id if linked else f"Lineage record unavailable (#{linked_id})"

    if obj.supersedes_id is not None:
        fields.append(("Supersedes", certificate_number(obj.supersedes_id)))
    if obj.superseded_by_id is not None:
        fields.append(("Superseded By", certificate_number(obj.superseded_by_id)))
    elif obj.status == "SUPERSEDED":
        fields.append(("Superseded By", "Lineage link unavailable — contact System Administrator"))
    if obj.revision_reason:
        fields.append(("Revision Reason", obj.revision_reason))
    return fields


@router.get("/{signoff_id}/export")
def export_signoff(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this QA Clearance Certificate, plus who requested,
    reviewed and approved it and when, as one downloadable PDF -- the
    offline/printable copy of the certificate itself."""
    obj = _get_visible_or_404(db, signoff_id, current_user)

    def uname(uid):
        if not uid:
            return None
        u = db.get(models.User, uid)
        return u.full_name if u else None

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="SIGNOFF", entity_id=signoff_id)
                     .order_by(models.ApprovalAction.created_at).all())
    # Keep only the latest recorded signature for each approval stage after a
    # return/resubmit cycle. These are the authoritative audit entries used by
    # both the UI and the exported certificate.
    signatures_by_stage: dict = {}
    for row in history_rows:
        if row.decision == 'Approval reset' or (row.step_name == 'Requester Verification' and row.decision == 'Changes Required'):
            signatures_by_stage.clear()
        signature = parse_electronic_signature(
            row.comments,
            stage=row.step_name or "Approval",
            signature_type=QA_CLEARANCE_SIGNED_TYPE,
        )
        if signature:
            signatures_by_stage[signature.stage] = signature
    signatures = list(signatures_by_stage.values())
    digitally_signed = bool(signatures) and obj.status in {
        "ISSUED", "ISSUED_UNDER_REVIEW", "SUPERSEDED",
    }

    status_fields = [
            ("Status", qa_clearance_export_status(obj.status)),
            ("Workflow Status", obj.status),
            ("Certificate Type", obj.certificate_type),
            ("Revision", obj.revision_number or 1),
            *_certificate_lineage_export_fields(db, obj),
            ("Testing Type", obj.certificate_testing_type),
            ("Certificate Date", obj.certificate_date),
            ("Clearance Signature Type", QA_CLEARANCE_SIGNED_TYPE if digitally_signed else "Not digitally signed"),
            ("Signature Method", DIGITAL_SIGNATURE_METHOD if digitally_signed else "—"),
    ]

    sections = [
        ("Status", status_fields),
        ("Application & Change", [
            ("Application Name", obj.application_name),
            ("Application Owner", obj.application_owner),
            ("Request Department", obj.request_department),
            ("Approving QA Team", obj.approving_qa_team or "Not configured"),
            ("Testing Request ID", obj.certificate_testing_request_id),
            ("Assigned Tester(s)", certificate_summary.assigned_testers_label(obj.certificate_summary)),
            ("CR Number/EPIC Number", obj.change_request_ids),
            ("Vendor / SI Partner", obj.vendor_si_partner),
            ("Technology Stack", obj.technology_stack),
        ]),
        ("Release & Environment", [
            ("Risk Tier", obj.risk_tier),
            ("Release Version", obj.release_version),
            ("Build Number", obj.build_number),
            ("Environment Tested", obj.environment_tested),
            ("Target Promotion Environment", obj.target_promotion_environment),
            ("Validity", f"{obj.validity_from or '—'} to {obj.validity_to or '—'}"),
        ]),
        ("Exit Criteria & Risk", [
            ("Testing Scope Completed", RichTextValue(obj.exit_criteria_notes or "")),
            ("Open Risks (if any)", RichTextValue(obj.open_defect_summary or "")),
            ("Known Limitations", RichTextValue(obj.known_limitations or "")),
            ("Business Acceptance Status", RichTextValue(obj.business_acceptance_status or "")),
            ("Security Testing Status", RichTextValue(obj.security_testing_status or "")),
            ("Remarks", RichTextValue(obj.residual_risk_notes or "")),
        ]),
        # Mandatory on a fully-Issued certificate -- one name per approval
        # stage of the QA Team -> QA Lead -> Executive  chain.
        ("Requested / Reviewed / Approved", [
            ("Requested By (QA Team)", uname(obj.requester_id)),
            ("Approved By (QA Lead)", uname(obj.reviewed_by_id)),
            ("Approved By (Executive)", uname(obj.approved_by_id)),
        ]),
    ]

    # Reported directly: "multiple signatures are coming, instead of this
    # what ever latest show and in download pdf as well" -- a certificate
    # signed more than once at the same checkpoint (e.g. re-signed by QA
    # Lead after a return/resubmit) previously listed every past signature
    # for that stage. history_rows is ordered oldest-first, so folding into
    # a dict keyed by stage and letting later rows overwrite earlier ones
    # keeps only the most recent signature per stage -- same fix as
    # SignOff.tsx's own `signatures` (the modal view this PDF mirrors).
    snapshot = obj.certificate_summary
    metadata = sections[0][1] + sections[1][1] + sections[2][1]
    remarks = sections[3][1]
    approval_fields = sections[4][1]
    sections = [('Section A – Certificate Metadata', metadata)]
    if snapshot:
        sections.append(('Evidence snapshot', [('Revision', snapshot['revision']), ('Captured at', snapshot['captured_at']), ('Population', snapshot['population_note'])]))
        sections.extend((title, [('Summary', RichTextValue(content))]) for title, content in certificate_summary.markdown_tables(snapshot))
        sections.append(('Section D – Security Testing Assessment', [('Summary', RichTextValue(certificate_summary.security_assessment_table(snapshot)))]))
    else:
        sections.append(('Sections B–D – Evidence snapshot', [('Availability', 'Legacy certificate: no frozen automatic summary. Refresh requires full reapproval.')]))
    sections.append(('Section E – QA Clearance Remarks', remarks))
    observations = snapshot.get('observations', []) if snapshot else []
    manual_observations = (snapshot.get('conditional_observations', '') if snapshot else obj.conditional_observations) or ''
    observation_fields = [('User-entered observations', RichTextValue(manual_observations))] if manual_observations.strip() else [
        (row['defect_key'], f"{row['functionality']}: {row['observation']} | Severity: {row['severity']} | Status: {row['status']} | Owner: {row['owner']} | Target date: {row['target_date']}") for row in observations
    ] or [('Observations', 'No open linked defect observations in the captured evidence.' if snapshot else 'No captured evidence available.')]
    if obj.certificate_type == 'Conditional Clearance':
        conditions = snapshot.get('certificate_fields', {}) if snapshot else {
            key: getattr(obj, key) for key in (*certificate_summary.CONDITIONAL_FIELDS, 'residual_risk_notes')
        }
        observation_fields.extend([
            ('Residual-risk remarks', RichTextValue(conditions.get('residual_risk_notes') or 'Not recorded')),
            ('Mitigation', RichTextValue(conditions.get('conditional_mitigation') or 'Not recorded')),
            ('Responsible owner', conditions.get('conditional_owner') or 'Not recorded'),
            ('Target date', conditions.get('conditional_target_date') or 'Not recorded'),
        ])
        sections.append(('Section F – Conditional Clearance Observations', observation_fields))
    sections.append(('Section G – Certificate Validity & Compliance Declaration', [('Declaration', 'This certificate applies to the tested environment. The recorded build/version/hash is retained as audit evidence and is not a matching gate. Code, configuration, infrastructure, dependency or requirement changes and production hotfixes require QA recertification. This certificate does not constitute Business Acceptance or Production readiness unless countersigned by the Application Owner.')]))
    sections.append(('Section H – Approval Matrix', approval_fields))
    if signatures:
        sections.append(("QA Clearance Digital Signatures", [
            (f"{signature.stage} — Digital Signature", signature)
            for signature in signatures
        ]))
    history = []
    reset_index = max((i for i, h in enumerate(history_rows) if h.decision == 'Approval reset'), default=-1)
    for h in history_rows[reset_index + 1:]:
        history.append((h.step_name or "—", h.decision or "—", uname(h.actor_id) or "—",
                         format_role_labels(h.actor_role) or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.certificate_id} — {obj.application_name}",
        subtitle="Bank of Maharashtra · Quality Assurance Certificate",
        sections=sections, history=history,
        history_title=None,
        generated_by=current_user.full_name,
        generated_at=models.now().strftime("%Y-%m-%d %H:%M IST"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.certificate_id}.pdf"'},
    )


def _can_upload_documents(db: Session, obj: "models.QASignOff", user: models.User) -> bool:
    """Reported directly: "uploading document should be non editable if not
    assigned, or in other person's bucket. only the assigned person can
    update" -- the original requester used to always pass here regardless of
    status, so once the certificate moved on to QA Lead/Executive , the
    requester could still upload/remove documents alongside whoever it
    actually currently sat with. Reworked to be exclusive, matching
    update_signoff's own editable-status window above: the requester only
    while the certificate is genuinely in their own hands (Draft or
    Returned-by-* -- see SIGNOFF_EDITABLE_STATUSES), and exclusively
    whichever single actor the certificate's *current* status is actually
    sitting with otherwise -- QA Lead during QA Lead approval (legacy status
    SM_APPROVAL_PENDING) or Executive during final approval. System
    administration alone grants no certificate-workflow mutation authority."""
    status = obj.status
    if status in ("DRAFT", "SUBMITTED", "RETURNED_BY_SM", "RETURNED_BY_DEPT_HEAD_COE", "RETURNED_BY_REQUESTER"):
        return obj.requester_id == user.id
    if status == "SM_APPROVAL_PENDING":
        return user.has_qa_workspace_role(
            Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
            workspace_id=obj.qa_workspace_id,
        )
    if status == "DEPT_HEAD_QA_APPROVAL_PENDING":
        return obj.reviewed_by_id != user.id and user.has_role(
            Role.CHIEF_MANAGER_QA, Role.AGM_QA,
        ) and user.has_qa_workspace_role(
            Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
            workspace_id=obj.qa_workspace_id,
        )
    return False


# ---- Supporting documents (multiple files, uploaded any time after the
# certificate has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_signoff_documents(signoff_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_visible_or_404(db, signoff_id, current_user)
    return doc_store.list_documents(db, "SIGNOFF", signoff_id)


@router.post("/{signoff_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_signoff_documents(signoff_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                              current_user: models.User = Depends(get_current_user)):
    obj, _ = _lock_signoff_source_first(db, signoff_id, visible_to=current_user)
    if not _can_upload_documents(db, obj, current_user):
        raise HTTPException(403, "Only the QA requester, QA Lead, or Executive  currently reviewing this certificate can upload documents")
    return doc_store.save_documents(db, "SIGNOFF", signoff_id, obj.certificate_id, files, current_user.id,
                                     log_entity_type="SIGNOFF", log_entity_id=obj.id, log_actor=current_user)


@router.get("/{signoff_id}/documents/{doc_id}/download")
def download_signoff_document(signoff_id: int, doc_id: int, db: Session = Depends(get_db),
                               current_user: models.User = Depends(get_current_user)):
    _get_visible_or_404(db, signoff_id, current_user)
    doc = doc_store.get_document_or_404(db, "SIGNOFF", signoff_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/{signoff_id}/documents/{doc_id}")
def delete_signoff_document(signoff_id: int, doc_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    obj, _ = _lock_signoff_source_first(db, signoff_id, visible_to=current_user)
    doc = doc_store.get_document_or_404(db, "SIGNOFF", signoff_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(db, obj, current_user)):
        raise HTTPException(403, "Only the current-stage actor who uploaded this document can delete it while it is still their stage")
    doc_store.delete_document(db, doc, log_entity_type="SIGNOFF", log_entity_id=signoff_id, log_actor=current_user)
    return {"ok": True}
