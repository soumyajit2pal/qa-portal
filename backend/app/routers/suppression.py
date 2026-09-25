import os
from typing import List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload, joinedload

from .. import models, schemas
from ..database import get_db
from ..deps import (
    get_workflow_user as get_current_user, require_workflow_roles as require_roles, require_same_department, require_not_requester,
    dashboard_department_scope, require_department_visibility, active_qa_workspace_scope_ids,
    require_entity_workspace_visibility,
    department_unit_visibility_condition, require_department_unit_visibility, require_department_unit_action_scope,
)
from ..constants import Role, SAST_DAST_PRE_SCANNING_STATUSES, SAST_DAST_COMPLETED_STATUSES
from ..pdf_export import StructuredTableValue, build_request_detail_pdf
from .. import documents as doc_store
from ..workflow_authority import is_system_admin

router = APIRouter(prefix="/api/suppressions", tags=["suppression"])
_PRIVATE_STATUSES = ("Draft",)
_REQUESTER_EDIT_STATUSES = (
    "Draft", "RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_TEAM",
)
_DEPARTMENT_ROUTING_EDIT_STATUSES = ("Draft", "RETURNED_BY_SM")

# ---------------------------------------------------------------------------
# Suppression request lifecycle (Application Owner step removed entirely):
#
#   Requester raises the request with all details -> Draft -> submit ->
#   SM_APPROVAL_PENDING -> sm-decision (SM assigns to Department Head) ->
#   DEPARTMENT_HEAD_APPROVAL_PENDING -> department-head-decision ->
#   SECURITY_TEAM_VERIFICATION -> security-team-decision (Accept -> Done,
#   Reject -> Rejected). A SAST/DAST request can only be marked Report Ready
#   once every Suppression request raised against it is "Done" -- enforced in
#   routers/sast_dast.py's _mark_report_ready.
# ---------------------------------------------------------------------------


def _log(db, entity_id, step, user, decision, comments=None):
    db.add(models.ApprovalAction(
        entity_type="SUPPRESSION", entity_id=entity_id, step_name=step,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision, comments=comments,
    ))


def _require(obj, expected, action: str):
    from ..workspace_service import current_workspace_scope_ids
    selected = current_workspace_scope_ids()
    if selected and obj.qa_workspace_id not in selected:
        raise HTTPException(404, "Suppression request not found in the active workspace")
    if isinstance(expected, str):
        expected = [expected]
    if obj.status not in expected:
        raise HTTPException(400, f"'{action}' requires status in {expected} (currently '{obj.status}')")


def _request_department_unit_id(obj: "models.SuppressionRequest") -> int | None:
    linked = obj.sast_request or obj.dast_request
    return linked.qa_request.department_unit_id if linked and linked.qa_request else None


def _pending_department_approval(obj: "models.SuppressionRequest", user: models.User):
    if not user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
        return None
    rows = list(getattr(obj, "department_approvals", []))
    if not rows:
        # Upgrade repair path: a legacy row may not have been backfilled when
        # its free-text department did not match the master table exactly.
        # Keep its owning Department Head able to open it; the decision
        # endpoint will create and validate the missing approval row.
        return True if obj.status == "DEPARTMENT_HEAD_APPROVAL_PENDING" \
            and user.has_department(obj.department) else None
    # A Department Head invited from another department retains read access
    # after acting so they can verify the outcome and audit trail. Action
    # authorization remains Pending-only in _can_decide_department_approval.
    return next((row for row in rows if user.has_department(row.department_name)), None)


def _can_decide_department_approval(db: Session, obj: "models.SuppressionRequest",
                                    user: models.User, department_id: int | None = None):
    if not user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
        return None
    rows = [row for row in obj.department_approvals
            if row.decision == "Pending" and (department_id is None or row.department_id == department_id)]
    if not user.has_role(Role.ADMIN):
        rows = [row for row in rows if user.has_department(row.department_name)]
    row = rows[0] if rows else None
    if row and row.department_name == obj.department and not user.has_role(Role.ADMIN):
        require_department_unit_action_scope(
            db, user, obj.department, _request_department_unit_id(obj),
        )
    return row


def _non_admin_user_ids(*users: models.User | None) -> set[int]:
    return {
        user.id for user in users
        if user is not None and not is_system_admin(user)
    }


def _approval_maker_checker_exclusions(
    db: Session,
    obj: "models.SuppressionRequest",
    sm_actor: models.User | None = None,
) -> set[int]:
    """Users who cannot perform a Department Head decision on this request."""
    requester = db.get(models.User, obj.created_by_id) if obj.created_by_id else None
    # A previous SM who returned/rejected the request is not a checker in a
    # future approval round. Only the actor who actually approved the request
    # into the Department Head stage must be excluded.
    sm_user = sm_actor or (
        db.get(models.User, obj.sm_id)
        if obj.sm_id and obj.sm_decision == "Approved" else None
    )
    return _non_admin_user_ids(requester, sm_user)


def _additional_department_ids(_db: Session, obj: "models.SuppressionRequest") -> list[int]:
    return [
        row.department_id for row in obj.department_approvals
        if row.department_name != obj.department
    ]


def _owning_department_approval(
    obj: "models.SuppressionRequest",
) -> "models.SuppressionDepartmentApproval | None":
    """Return the requester department's approval row, when available.

    ``dept_head_id`` is a legacy aggregate field. In a multi-department
    approval round it can contain the Department Head who completed the last
    outstanding approval, which is not necessarily the requester's Department
    Head. Review/export surfaces that identify the owning Department Head must
    therefore use the owning department's dedicated approval row.
    """
    owning_department = (obj.department or "").strip().casefold()
    if not owning_department:
        return None
    return next(
        (
            approval for approval in getattr(obj, "department_approvals", [])
            if (approval.department_name or "").strip().casefold() == owning_department
        ),
        None,
    )


def _department_ids_with_eligible_heads(
    db: Session,
    departments: list[models.Department],
    qa_workspace_id: int | None,
    *,
    excluded_user_ids: set[int] | None = None,
) -> set[int]:
    """Return departments with an actionable Department Head in the workspace.

    This is the single eligibility rule used both by the option endpoints and
    by workflow validation. The option list is therefore only a convenience;
    every write/transition still re-runs this rule authoritatively.
    """
    if not departments:
        return set()
    heads = db.query(models.User).join(models.UserRole).options(
        selectinload(models.User.department_assignments),
        selectinload(models.User.role_assignments),
        selectinload(models.User.qa_workspace_memberships).selectinload(models.QAWorkspaceMember.workspace),
        selectinload(models.User.department_coordinator_assignments).selectinload(
            models.DepartmentCoordinatorAssignment.workspace,
        ),
        selectinload(models.User.department_coordinator_assignments).selectinload(
            models.DepartmentCoordinatorAssignment.department,
        ),
    ).filter(
        models.User.is_active == True,  # noqa: E712
        models.UserRole.role.in_([Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM]),
    ).all()
    if qa_workspace_id:
        from ..workspace_service import inherited_workspace_access_mode, selectable_workspace_ids
        heads = [
            head for head in heads
            if qa_workspace_id in selectable_workspace_ids(db, head)
            and inherited_workspace_access_mode(db, head, qa_workspace_id) != "PARENT_VIEWER"
        ]
    # A user can hold several roles at once. Organisation-wide VIEW_ONLY and
    # SCALE_6_PLUS are hard read-only profiles even if the same account also
    # has a Department Head role, so they must never count as an actionable
    # checker merely because they can see the workspace.
    heads = [
        head for head in heads
        if Role.VIEW_ONLY not in head.roles and Role.SCALE_6_PLUS not in head.roles
    ]
    excluded_user_ids = excluded_user_ids or set()
    return {
        department.id for department in departments
        if any(
            head.id not in excluded_user_ids and head.has_department(department.name)
            for head in heads
        )
    }


def _approval_department_options(
    db: Session,
    owning_department: str,
    qa_workspace_id: int | None,
    *,
    excluded_user_ids: set[int] | None = None,
) -> dict:
    departments = db.query(models.Department).filter(
        models.Department.is_active == True,  # noqa: E712
    ).order_by(models.Department.name).all()
    eligible_ids = _department_ids_with_eligible_heads(
        db,
        departments,
        qa_workspace_id,
        excluded_user_ids=excluded_user_ids,
    )
    owning = next((row for row in departments if row.name == owning_department), None)
    return {
        "owning_department": owning_department,
        "owning_department_eligible": bool(owning and owning.id in eligible_ids),
        "departments": [
            {"id": row.id, "name": row.name}
            for row in departments
            if row.name != owning_department and row.id in eligible_ids
        ],
    }


def _validate_and_sync_department_approvals(
    db: Session,
    obj: "models.SuppressionRequest",
    additional_department_ids: list[int],
    *,
    excluded_user_ids: set[int] | None = None,
    department_ids_requiring_eligible_heads: set[int] | None = None,
) -> None:
    requested_ids = list(dict.fromkeys(additional_department_ids or []))
    departments = db.query(models.Department).filter(
        models.Department.is_active == True,  # noqa: E712
        or_(models.Department.id.in_(requested_ids), models.Department.name == obj.department),
    ).all()
    primary = next((row for row in departments if row.name == obj.department), None)
    if not primary:
        raise HTTPException(400, f"Owning department '{obj.department}' is not active")
    by_id = {row.id: row for row in departments}
    missing = [department_id for department_id in requested_ids if department_id not in by_id]
    if missing:
        raise HTTPException(400, "One or more selected additional departments are invalid or inactive")

    desired_ids = {primary.id, *requested_ids}
    excluded_user_ids = excluded_user_ids or set()
    eligible_department_ids = _department_ids_with_eligible_heads(
        db,
        list(by_id.values()),
        obj.qa_workspace_id,
        excluded_user_ids=excluded_user_ids,
    )
    head_required_ids = (
        desired_ids if department_ids_requiring_eligible_heads is None
        else desired_ids & department_ids_requiring_eligible_heads
    )
    missing_heads = [
        by_id[department_id].name for department_id in head_required_ids
        if department_id not in eligible_department_ids
    ]
    if missing_heads:
        raise HTTPException(
            400,
            "No eligible Department Head is assigned to: "
            f"{', '.join(sorted(missing_heads))}. An eligible approver must be active, have actionable "
            "access to this workspace, and satisfy maker-checker separation from the requester and approving SM.",
        )

    existing = {row.department_id: row for row in obj.department_approvals}
    for department_id, row in list(existing.items()):
        if department_id not in desired_ids:
            db.delete(row)
    for department_id in desired_ids:
        if department_id not in existing:
            obj.department_approvals.append(models.SuppressionDepartmentApproval(
                department_id=department_id,
                department=by_id[department_id],
                decision="Pending",
            ))


def _reset_department_approvals(obj: "models.SuppressionRequest") -> None:
    for row in getattr(obj, "department_approvals", []):
        row.decision = "Pending"
        row.approver_id = None
        row.decided_at = None
    obj.dept_head_decision = None
    obj.dept_head_id = None
    obj.dept_head_decided_at = None


def _restart_as_draft(obj: "models.SuppressionRequest") -> None:
    """Invalidate every workflow decision after a material relink."""
    obj.status = "Draft"
    obj.sm_decision = None
    obj.sm_id = None
    obj.sm_decided_at = None
    _reset_department_approvals(obj)
    obj.security_decision = None
    obj.security_id = None
    obj.security_decided_at = None
    obj.needs_dept_head_reapproval = False


def _unit_visibility_condition(db: Session, user: models.User):
    gateway_scope = department_unit_visibility_condition(
        db, user, models.QARequest.department, models.QARequest.department_unit_id,
    )
    return or_(
        models.SuppressionRequest.sast_request.has(
            models.SASTRequest.qa_request.has(gateway_scope),
        ),
        models.SuppressionRequest.dast_request.has(
            models.DASTRequest.qa_request.has(gateway_scope),
        ),
    )


def _require_visible(db: Session, obj: "models.SuppressionRequest", user: models.User) -> None:
    # Workspace isolation is always evaluated before the invited-department
    # exception below. An approval row grants a Department Head visibility
    # inside this request's workspace; it must never become a cross-workspace
    # bypass for detail, history, export, or document endpoints.
    require_entity_workspace_visibility(db, user, "SUPPRESSION", obj.id)
    # A Draft is private scratch work until its requester explicitly submits
    # it into the governed approval workflow. Department membership alone
    # must not expose it to an SM or any other colleague.
    if obj.status in _PRIVATE_STATUSES and obj.created_by_id != user.id and not user.has_role(Role.ADMIN):
        raise HTTPException(404, "Suppression request not found")
    if not _pending_department_approval(obj, user):
        require_department_visibility(
            user,
            obj.department,
            requester_id=obj.created_by_id,
            entity_workspace_id=obj.qa_workspace_id,
        )
        require_department_unit_visibility(
            db, user, obj.department, _request_department_unit_id(obj),
            requester_id=obj.created_by_id,
        )


def _apply_private_status_visibility(query, user: models.User):
    """Keep pre-submission suppression drafts private to their author."""
    if user.has_role(Role.ADMIN):
        return query
    return query.filter(or_(
        models.SuppressionRequest.status.notin_(_PRIVATE_STATUSES),
        models.SuppressionRequest.created_by_id == user.id,
    ))


def _can_edit_details(obj: "models.SuppressionRequest", user: models.User,
                      db: Session | None = None) -> bool:
    """Match the request-module edit hand-off at each workflow stage."""
    if user.has_role(Role.ADMIN):
        return obj.status in _REQUESTER_EDIT_STATUSES
    if obj.status in _REQUESTER_EDIT_STATUSES:
        return obj.created_by_id == user.id
    # Reviewers never rewrite the request they are approving. If details need
    # correction they must Return with remarks; the requester edits it while
    # it is back in one of the requester-controlled statuses above.
    return False


def _require_linked_request(db: Session, data: dict, current_user: models.User):
    """Every field on the New/Edit Suppression form is now mandatory --
    including the SAST/DAST Request ID link itself (previously optional,
    allowing a "standalone" finding with no linked scan). Enforced here
    rather than in schemas.py to match this router's existing validation
    style (see the decision-endpoint checks above/below).

    Reported directly: also reject a link to a SAST/DAST request that
    hasn't reached Scanning yet -- a suppression is a decision about a
    *finding*, and nothing exists to suppress before a scan has actually
    started (Draft through Scan Configuration -- see
    constants.SAST_DAST_PRE_SCANNING_STATUSES). Mirrors the frontend's own
    dropdown filter in Suppression.tsx, which hides those requests from the
    picker entirely -- this is the server-side backstop in case the client
    submits a stale/hand-crafted id anyway.

    Reported directly (follow-up): also reject a link to a SAST/DAST request
    that has already reached Security Complete or later (see
    constants.SAST_DAST_COMPLETED_STATUSES) -- once a request is declared
    Security Complete it's finalized, so a new suppression can no longer be
    raised against it either. Combined with the Scanning-or-later check
    above, this narrows the eligible window to Scanning through the stage
    right before Security Complete."""
    if bool(data.get("sast_request_id")) == bool(data.get("dast_request_id")):
        raise HTTPException(400, "Exactly one of SAST or DAST Request ID must be selected")
    if data.get("sast_request_id"):
        linked = db.get(models.SASTRequest, data["sast_request_id"])
        kind = "SAST"
    else:
        linked = db.get(models.DASTRequest, data["dast_request_id"])
        kind = "DAST"
    if not linked:
        raise HTTPException(400, f"Linked {kind} request not found")
    _require_linked_request_workspace(db, linked, kind, current_user)
    if linked.status in SAST_DAST_PRE_SCANNING_STATUSES:
        raise HTTPException(
            400,
            f"The linked {kind} request hasn't reached Scanning yet (currently "
            f"'{linked.status}') -- a suppression can only be raised once scanning has started.",
        )
    if linked.status in SAST_DAST_COMPLETED_STATUSES:
        raise HTTPException(
            400,
            f"The linked {kind} request has already reached '{linked.status}' -- a suppression can no "
            f"longer be raised against it once the security review is complete.",
        )
    return linked, kind


def _require_linked_request_workspace(
    db: Session, linked, kind: str, current_user: models.User,
) -> None:
    """Reject a crafted link outside the caller's selected workspace scope."""
    require_entity_workspace_visibility(db, current_user, kind, linked.id)


def _apply_linked_request_identity(data: dict, linked, kind: str) -> None:
    """Copy authoritative ownership fields from the selected SAST/DAST row."""
    if not linked.department:
        raise HTTPException(
            409,
            f"Linked {kind} request {linked.request_id} has no QA Request department. "
            "Repair its QA Request linkage before raising a suppression.",
        )
    data["application_name"] = linked.application_name
    data["department"] = linked.department
    data["application_owner"] = linked.application_owner
    data["scan_type"] = kind
    parent = getattr(linked, "qa_request", None)
    data["qa_workspace_id"] = parent.qa_workspace_id if parent else None


def _require_no_existing_pending_suppression(db: Session, linked, kind: str, exclude_id: int = None) -> None:
    """Reported directly: "if pending supression request there, then dont
    allow to create new suppression request." One suppression decision
    against a given SAST/DAST request at a time -- current rule (see the two
    follow-ups below): block a new one unless every existing suppression
    against this linked request is Rejected. `exclude_id` lets
    update_suppression re-check a re-linked request without the suppression
    being edited blocking itself.

    Reported directly (follow-up bug): "Supression request is now rejected,
    but still user not able to create supression request." This originally
    checked `status != "Done"`, which -- unlike _pending_suppression_ids in
    sast_dast.py, where treating Rejected as still-blocking is correct per
    FR-06's literal rule text -- wrongly treated Rejected as still "pending"
    here too, permanently locking a requester out of ever raising another
    suppression once one got rejected. Rejected is terminal for THIS check:
    the natural next step after a rejection is either remediate the finding
    or raise a fresh, better-justified suppression, not a dead end.

    Reported directly (follow-up, reversed for Done specifically): "for same
    sast request, even though supression request is present and mark
    completed, again asking for new supression request and relink." Treating
    Done the same as Rejected here let a requester raise a SECOND suppression
    against a request that already had an APPROVED one -- but per the
    requirement doc's Section 4, once Approved the next step is reassigning
    to the analyst (Mark Fixed), not another suppression. So Done blocks a
    new suppression here (same as a still-pending one), while Rejected still
    doesn't -- the frontend's canInitiateSuppression mirrors this exactly
    (hasOpenSuppression OR hasDoneSuppression both disable Initiate/Link)."""
    sup_col = models.SuppressionRequest.sast_request_id if kind == "SAST" else models.SuppressionRequest.dast_request_id
    q = db.query(models.SuppressionRequest).filter(
        sup_col == linked.id, models.SuppressionRequest.status != "Rejected",
    )
    if exclude_id is not None:
        q = q.filter(models.SuppressionRequest.id != exclude_id)
    existing = q.first()
    if existing:
        raise HTTPException(
            400,
            f"A suppression request ({existing.suppression_id}) already exists against this {kind} request "
            f"({'pending decision' if existing.status != 'Done' else 'already approved'}) -- "
            + ("it must be resolved (marked Done) before another can be raised."
               if existing.status != "Done"
               else "reassign the request to the Security Analyst (Mark Fixed) instead of raising another one."),
        )


def _require_requester_of_linked(linked, current_user: models.User) -> None:
    """Reported directly: "suppression requests CAN ONLY be raised by
    requester, so this should be enable for requester, not QA team." Until
    now create_suppression had no permission check at all beyond being
    logged in -- any authenticated user, including a Security Analyst/QA
    team member with no relationship to the request, could raise a
    suppression against someone else's SAST/DAST request. Restricted to the
    linked request's own requester (or Admin, same bypass convention as
    every other check in this file).

    Reported directly (follow-up): "requester delegated, to qa ... Full
    stand-in for requester" briefly extended this to the linked SAST/DAST
    request's active Delegate for Input too, matching Mark Fixed's own
    delegate stand-in.

    Reported directly (reversed, immediately after seeing it in practice):
    "INITIATE SUPPRESSION REQUEST SHOULD BE FROM REQUESTER SIDE, NOT QA
    SIDE" -- the concrete case was a requester who'd delegated a
    WAITING_FOR_FIX request to a Security Analyst (a completely normal,
    intended use of "full stand-in"), and that analyst could then raise a
    suppression against their own team's finding, which defeats the point
    of suppression being the requester's own exception request. Suppression
    is now carved OUT of delegate stand-in entirely -- it's the one
    requester-side action that ALWAYS stays with the literal original
    requester (or Admin), regardless of whether the linked request currently
    has an active delegation. Since the delegate can no longer act here at
    all, the original requester is correspondingly no longer blocked while
    delegated out (there'd be nobody left who could raise a suppression
    otherwise) -- every OTHER requester-side action (Mark Fixed, etc.) is
    unaffected and stays exclusively the delegate's during an active
    delegation, per sast_dast.py's _mark_fixed and the frontend's
    requesterInputEditor."""
    if current_user.has_role(Role.ADMIN):
        return
    if linked.requester_id != current_user.id:
        raise HTTPException(
            403,
            "Only the requester of the linked SAST/DAST request (or an admin) can raise a suppression "
            "request against it -- this is not delegable, even while the request has an active "
            "Delegate for Input assigned.",
        )


@router.get("", response_model=List[schemas.SuppressionOut])
def list_suppressions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Reported directly, then extended to "everywhere" (see list_requests'
    # matching comment in routers/qa_requests.py) -- applied unconditionally.
    # SuppressionRequest.department is a real column (auto-populated at
    # creation time, see its own column comment in models.py), so this is a
    # plain filter, no join needed.
    # Perf tuning (2026-08, reported directly: "some of the apis are taking
    # lot of timing") -- SuppressionOut.items (one-to-many) and
    # .linked_request (resolved from sast_request/dast_request, both
    # many-to-one) were all previously lazy-loaded per row -- up to 3 extra
    # SELECTs per suppression. selectinload for the collection (avoids a
    # join-driven row explosion), joinedload for the two many-to-one FKs.
    q = db.query(models.SuppressionRequest).options(
        selectinload(models.SuppressionRequest.items),
        selectinload(models.SuppressionRequest.department_approvals).joinedload(models.SuppressionDepartmentApproval.department),
        selectinload(models.SuppressionRequest.department_approvals).joinedload(models.SuppressionDepartmentApproval.approver),
        joinedload(models.SuppressionRequest.sast_request),
        joinedload(models.SuppressionRequest.dast_request),
    )
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        visibility = _unit_visibility_condition(db, current_user)
        if current_user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
            visibility = or_(visibility, models.SuppressionRequest.department_approvals.any(
                models.SuppressionDepartmentApproval.department.has(
                    models.Department.name.in_(current_user.departments),
                ),
            ))
        q = q.filter(visibility)
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if workspace_ids:
        q = q.filter(models.SuppressionRequest.qa_workspace_id.in_(workspace_ids))
    q = _apply_private_status_visibility(q, current_user)
    return q.order_by(models.SuppressionRequest.created_at.desc()).all()


@router.post("", response_model=schemas.SuppressionOut)
def create_suppression(payload: schemas.SuppressionCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Requester raises the suppression request with all details -- starts life
    as a Draft (see models.SuppressionRequest.status default) until explicitly
    submitted below. A single scan often has multiple findings, so this
    covers a list of them (payload.items) under one suppression request
    rather than requiring a separate request per finding."""
    data = payload.model_dump()
    items_data = data.pop("items")
    additional_department_ids = data.pop("additional_department_ids", [])
    if not items_data:
        raise HTTPException(400, "At least one finding/issue is required")
    linked, kind = _require_linked_request(db, data, current_user)
    _require_requester_of_linked(linked, current_user)
    _require_no_existing_pending_suppression(db, linked, kind)
    _apply_linked_request_identity(data, linked, kind)
    obj = models.SuppressionRequest(**data, created_by_id=current_user.id, status="Draft")
    obj.items = [models.SuppressionItem(**item) for item in items_data]
    db.add(obj)
    db.flush()
    _validate_and_sync_department_approvals(
        db, obj, additional_department_ids,
        excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
    )
    _log(db, obj.id, "Requester", current_user, "Drafted")
    db.commit()
    db.refresh(obj)
    return obj


@router.get(
    "/approval-department-options",
    response_model=schemas.SuppressionApprovalDepartmentOptionsOut,
)
def create_approval_department_options(
    sast_request_id: int | None = None,
    dast_request_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Eligible approval departments for a not-yet-created suppression.

    The linked request remains the authority for the workspace, owning
    department, and requester. Callers cannot broaden the result by supplying
    those values independently.
    """
    data = {
        "sast_request_id": sast_request_id,
        "dast_request_id": dast_request_id,
    }
    linked, kind = _require_linked_request(db, data, current_user)
    _require_requester_of_linked(linked, current_user)
    identity = {}
    _apply_linked_request_identity(identity, linked, kind)
    return _approval_department_options(
        db,
        identity["department"],
        identity["qa_workspace_id"],
        # POST /api/suppressions stores current_user.id as created_by_id. Use
        # that prospective creator here too so the preview and authoritative
        # create validation stay identical for the Administrator override case.
        excluded_user_ids=_non_admin_user_ids(current_user),
    )


@router.get(
    "/{sup_id}/approval-department-options",
    response_model=schemas.SuppressionApprovalDepartmentOptionsOut,
)
def edit_approval_department_options(
    sup_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Eligible approval departments while routing is requester-editable."""
    obj = db.get(models.SuppressionRequest, sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    if obj.status not in _REQUESTER_EDIT_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    if not _can_edit_details(obj, current_user, db):
        raise HTTPException(403, "You do not have permission to edit this request in its current status")
    if obj.status not in _DEPARTMENT_ROUTING_EDIT_STATUSES:
        raise HTTPException(
            400,
            "Required approval departments cannot be changed after SM approval. "
            "Relink the request to restart its workflow if its ownership changed.",
        )
    if not obj.department:
        raise HTTPException(409, "Suppression request has no owning department")
    return _approval_department_options(
        db,
        obj.department,
        obj.qa_workspace_id,
        excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
    )


@router.get("/{sup_id}", response_model=schemas.SuppressionOut)
def get_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.get(models.SuppressionRequest, sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    return obj


@router.put("/{sup_id}", response_model=schemas.SuppressionOut)
def update_suppression(sup_id: int, payload: schemas.SuppressionCreate, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    if obj.status not in _REQUESTER_EDIT_STATUSES:
        raise HTTPException(400, f"Request cannot be edited while in status '{obj.status}'")
    if not _can_edit_details(obj, current_user, db):
        raise HTTPException(403, "You do not have permission to edit this request in its current status")
    data = payload.model_dump()
    items_data = data.pop("items", None)
    additional_department_ids = data.pop("additional_department_ids", [])
    if not items_data:
        raise HTTPException(400, "At least one finding/issue is required")
    linked, kind = _require_linked_request(db, data, current_user)
    # Relinking is a separate requester/Admin action because it must
    # invalidate every prior workflow decision and restart from Draft. Never
    # let the general edit endpoint become a way around that reset.
    is_requester = obj.created_by_id == current_user.id
    is_admin = current_user.has_role(Role.ADMIN)
    link_changed = (
        data.get("sast_request_id") != obj.sast_request_id
        or data.get("dast_request_id") != obj.dast_request_id
    )
    if link_changed:
        raise HTTPException(
            400,
            "Use the Relink action to change the linked SAST/DAST request; "
            "relinking resets all approvals and restarts the request from Draft.",
        )
    _require_requester_of_linked(linked, current_user)
    _apply_linked_request_identity(data, linked, kind)
    for k, v in data.items():
        setattr(obj, k, v)
    if items_data is not None:
        for item in list(obj.items):
            db.delete(item)
        db.flush()
        obj.items = [models.SuppressionItem(**item) for item in items_data]
    if is_requester or is_admin:
        current_additional_ids = set(_additional_department_ids(db, obj))
        requested_additional_ids = set(additional_department_ids)
        if obj.status not in _DEPARTMENT_ROUTING_EDIT_STATUSES \
                and requested_additional_ids != current_additional_ids:
            raise HTTPException(
                400,
                "Required approval departments cannot be changed after SM approval. "
                "Relink the request to restart its workflow if its ownership changed.",
            )
        # When Security returns a request straight back to itself, its
        # already-approved Department Head chain is intentionally retained.
        # Details/evidence may be corrected, but no Department Head will act
        # again, so a subsequently inactive head must not block that repair.
        if not (
            obj.status == "RETURNED_BY_SECURITY_TEAM"
            and not obj.needs_dept_head_reapproval
        ):
            _validate_and_sync_department_approvals(
                db, obj, additional_department_ids,
                excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
            )
    _log(db, obj.id, "Request Details", current_user, "Updated")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/relink", response_model=schemas.SuppressionOut)
def relink_suppression(sup_id: int, payload: schemas.SuppressionRelinkIn, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Reported directly: "give option to link and delink supression request
    from sast request and supression both." Unlike update_suppression above
    (full-form edit), relinking points this suppression at a *different*
    SAST/DAST request. It is allowed only while the record is with its
    requester (Draft or Returned). Because that changes the request's
    authoritative identity, a successful relink invalidates every prior
    decision and restarts the request as Draft. A suppression must always be
    linked to exactly one SAST/DAST request; "delink" means replacing the
    link, not clearing it."""
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can relink this request")
    if obj.status not in _REQUESTER_EDIT_STATUSES:
        raise HTTPException(
            400,
            f"Cannot relink a suppression request while it is in status '{obj.status}'. "
            "A reviewer must return it to the requester first.",
        )
    data = payload.model_dump()
    linked, kind = _require_linked_request(db, data, current_user)
    same_target = (
        kind == "SAST"
        and obj.sast_request_id == data.get("sast_request_id")
        and obj.dast_request_id is None
    ) or (
        kind == "DAST"
        and obj.dast_request_id == data.get("dast_request_id")
        and obj.sast_request_id is None
    )
    if same_target:
        raise HTTPException(
            400,
            f"This suppression request is already linked to {kind} request {linked.request_id}. "
            "Choose a different request to relink it.",
        )
    _require_requester_of_linked(linked, current_user)
    _require_no_existing_pending_suppression(db, linked, kind, exclude_id=obj.id)
    obj.sast_request_id = data.get("sast_request_id")
    obj.dast_request_id = data.get("dast_request_id")
    previous_department = obj.department
    additional_department_ids = [
        row.department_id for row in obj.department_approvals
        if row.department_name != previous_department
    ]
    identity = {}
    _apply_linked_request_identity(identity, linked, kind)
    obj.scan_type = identity["scan_type"]
    obj.application_name = identity["application_name"]
    obj.department = identity["department"]
    obj.application_owner = identity["application_owner"]
    obj.qa_workspace_id = identity["qa_workspace_id"]
    _restart_as_draft(obj)
    _validate_and_sync_department_approvals(
        db, obj, additional_department_ids,
        excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
    )
    _log(
        db, obj.id, "Requester", current_user, "Relinked",
        f"Relinked to {kind} request {linked.request_id}; all prior approvals were invalidated and the request returned to Draft",
    )
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/submit", response_model=schemas.SuppressionOut)
def submit_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can submit this request")
    _require(obj, "Draft", "Submit")
    _validate_and_sync_department_approvals(
        db, obj, _additional_department_ids(db, obj),
        excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
    )
    # Mirrors routers/functional.py::submit_request -- logs the requester's
    # own "Submitted" step before immediately moving on to SM Approval, same
    # fix as SAST/DAST/Performance so every request type's History
    # tab reads the same way. Unlike those, Suppression has no intermediate
    # "SUBMITTED" value in SUPPRESSION_STATUSES, so obj.status goes straight
    # to SM_APPROVAL_PENDING -- only the history log itself gains the extra row.
    _log(db, obj.id, "Requester", current_user, "Submitted", None)
    obj.status = "SM_APPROVAL_PENDING"
    _log(db, obj.id, "SM Approval", current_user, "Submitted", "Awaiting SM decision")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/resubmit", response_model=schemas.SuppressionOut)
def resubmit_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    if obj.created_by_id != current_user.id and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Only the requester or an admin can resubmit this request")
    _require(obj, ["RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_TEAM"], "Resubmit")
    if obj.status == "RETURNED_BY_SM":
        obj.sm_decision = None
        obj.sm_id = None
        obj.sm_decided_at = None
        obj.status = "SM_APPROVAL_PENDING"
        _log(db, obj.id, "SM Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_DEPARTMENT_HEAD":
        _validate_and_sync_department_approvals(
            db, obj, _additional_department_ids(db, obj),
            excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
        )
        _reset_department_approvals(obj)
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted", "Returned request re-submitted")
    elif obj.status == "RETURNED_BY_SECURITY_TEAM" and obj.needs_dept_head_reapproval:
        _validate_and_sync_department_approvals(
            db, obj, _additional_department_ids(db, obj),
            excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
        )
        _reset_department_approvals(obj)
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
        obj.needs_dept_head_reapproval = False
        obj.security_decision = None
        obj.security_id = None
        obj.security_decided_at = None
        _log(db, obj.id, "Department Head Approval", current_user, "Resubmitted",
             "Security Team return corrected and re-submitted (Department Head re-approval required)")
    else:
        obj.status = "SECURITY_TEAM_VERIFICATION"
        obj.needs_dept_head_reapproval = False
        obj.security_decision = None
        obj.security_id = None
        obj.security_decided_at = None
        _log(db, obj.id, "Security Team Verification", current_user, "Resubmitted", "Returned request re-submitted")
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/sm-decision", response_model=schemas.SuppressionOut)
def sm_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                current_user: models.User = Depends(require_roles(Role.SM))):
    """SM assigns the request on to the Department Head (Approve), sends it
    back to the requester (Return), or rejects it outright."""
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    require_same_department(current_user, obj.department)
    require_department_unit_action_scope(
        db, current_user, obj.department, _request_department_unit_id(obj),
    )
    require_not_requester(current_user, obj.created_by_id)
    _require(obj, "SM_APPROVAL_PENDING", "SM decision")
    obj.sm_decision = payload.decision
    obj.sm_id = current_user.id
    obj.sm_decided_at = models.now()
    if payload.decision == "Approved":
        _validate_and_sync_department_approvals(
            db, obj, _additional_department_ids(db, obj),
            excluded_user_ids=_approval_maker_checker_exclusions(db, obj, current_user),
        )
        _reset_department_approvals(obj)
        obj.status = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_SM"
    elif payload.decision == "Rejected":
        obj.status = "Rejected"
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    _log(db, obj.id, "SM Approval", current_user, payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/dept-head-decision", response_model=schemas.SuppressionOut)
def dept_head_decision(sup_id: int, payload: schemas.SuppressionDepartmentDecision, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM))):
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    require_not_requester(current_user, obj.created_by_id)
    _require(obj, "DEPARTMENT_HEAD_APPROVAL_PENDING", "Department Head decision")
    # Maker-checker separation is per request, not merely per role. A person
    # may legitimately hold both SM and Department Head roles, but must not
    # approve both consecutive stages of the same suppression request.
    if obj.sm_id == current_user.id and not is_system_admin(current_user):
        raise HTTPException(
            403,
            "Department Head approval must be completed by a different approver; "
            "your SM decision is already recorded on this request.",
        )
    # Revalidate the active configuration at decision time. This repairs a
    # legacy record with no approval rows, rejects deactivated departments,
    # and prevents an approval round from advancing after its last eligible
    # head was deactivated or lost actionable workspace access. Departments
    # already approved earlier in this round do not need a replacement head.
    pending_department_ids = (
        {row.department_id for row in obj.department_approvals if row.decision == "Pending"}
        if obj.department_approvals else None
    )
    _validate_and_sync_department_approvals(
        db, obj, _additional_department_ids(db, obj),
        excluded_user_ids=_approval_maker_checker_exclusions(db, obj),
        department_ids_requiring_eligible_heads=pending_department_ids,
    )
    approval = _can_decide_department_approval(db, obj, current_user, payload.department_id)
    if not approval:
        raise HTTPException(403, "You do not have a pending Department Head approval for this department")

    if approval:
        approval.decision = payload.decision
        approval.approver_id = current_user.id
        approval.decided_at = models.now()
    if payload.decision == "Approved":
        if approval:
            db.flush()
        remaining = any(
            row.id != approval.id and row.decision != "Approved" for row in obj.department_approvals
        )
        if not remaining:
            obj.status = "SECURITY_TEAM_VERIFICATION"
            obj.dept_head_decision = "Approved"
            obj.dept_head_id = current_user.id
            obj.dept_head_decided_at = models.now()
        else:
            obj.dept_head_decision = None
            obj.dept_head_id = None
            obj.dept_head_decided_at = None
    elif payload.decision == "Returned":
        obj.status = "RETURNED_BY_DEPARTMENT_HEAD"
        obj.dept_head_decision = "Returned"
        obj.dept_head_id = current_user.id
        obj.dept_head_decided_at = models.now()
    elif payload.decision == "Rejected":
        obj.status = "Rejected"
        obj.dept_head_decision = "Rejected"
        obj.dept_head_id = current_user.id
        obj.dept_head_decided_at = models.now()
    else:
        raise HTTPException(400, "decision must be one of: Approved, Returned, Rejected")
    approval_department = approval.department_name
    _log(db, obj.id, f"Department Head Approval — {approval_department}", current_user,
         payload.decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{sup_id}/security-team-decision", response_model=schemas.SuppressionOut)
def security_team_decision(sup_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.SECURITY_ANALYST))):
    """Security Team verifies the suppression is legitimate and accepts (Done
    -- unblocks the linked SAST/DAST request's mark-report-ready), rejects it
    outright (terminal), or returns it to the requester if something needs
    fixing first -- e.g. missing justification or evidence -- choosing (via
    require_dept_head_reapproval) whether the fix needs a fresh Department
    Head approval or can come straight back to Security Team Verification."""
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    require_not_requester(current_user, obj.created_by_id)
    _require(obj, "SECURITY_TEAM_VERIFICATION", "Security team decision")
    department_approver_ids = {
        approval.approver_id for approval in obj.department_approvals
        if approval.approver_id is not None
    }
    if obj.dept_head_id is not None:
        # Keep the aggregate actor as a compatibility backstop for legacy
        # requests that predate the per-department approval rows.
        department_approver_ids.add(obj.dept_head_id)
    if not is_system_admin(current_user) and current_user.id in department_approver_ids:
        raise HTTPException(
            403,
            "Security verification must be completed by a different verifier; "
            "your Department Head approval is already recorded on this request.",
        )
    if obj.department_approvals:
        approvals_complete = all(
            approval.decision == "Approved" for approval in obj.department_approvals
        )
    else:
        # Legacy records created before per-department approval rows were
        # introduced remain valid only when their aggregate approval is clear.
        approvals_complete = obj.dept_head_decision == "Approved"
    if not approvals_complete:
        raise HTTPException(
            409,
            "Department Head approvals are incomplete; Security verification cannot proceed.",
        )
    decision = payload.decision
    if decision not in ("Accepted", "Approved", "Rejected", "Returned"):
        raise HTTPException(400, "decision must be one of: Accepted, Rejected, Returned")
    obj.security_decision = decision
    obj.security_id = current_user.id
    obj.security_decided_at = models.now()
    if decision in ("Accepted", "Approved"):
        obj.status = "Done"
        obj.needs_dept_head_reapproval = False
    elif decision == "Rejected":
        obj.status = "Rejected"
        obj.needs_dept_head_reapproval = False
    else:
        # The status records the actor that performed the return. Department
        # Head reapproval is a later routing choice and must not make the UI
        # claim that the Department Head returned the request.
        obj.status = "RETURNED_BY_SECURITY_TEAM"
        obj.needs_dept_head_reapproval = bool(payload.require_dept_head_reapproval)
    _log(db, obj.id, "Security Team Verification", current_user, decision, payload.comments)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{sup_id}/history", response_model=List[schemas.ApprovalActionOut])
def suppression_history(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.get(models.SuppressionRequest, sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    return (db.query(models.ApprovalAction)
            .filter_by(entity_type="SUPPRESSION", entity_id=sup_id)
            .order_by(models.ApprovalAction.created_at).all())


@router.get("/{sup_id}/export")
def export_suppression(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every field on this Suppression / False Positive request, every
    finding it covers, and its full approval/workflow history -- who
    submitted, decided (SM/Department Head/Security Team), etc., and when --
    as one downloadable PDF."""
    obj = db.get(models.SuppressionRequest, sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)

    def uname(uid):
        if not uid:
            return None
        u = db.get(models.User, uid)
        return u.full_name if u else None

    owning_department_approval = _owning_department_approval(obj)
    if owning_department_approval is not None:
        owning_department_head_decision = owning_department_approval.decision or "Pending"
        owning_department_head_name = owning_department_approval.approver_name or "—"
    else:
        # Records created before per-department approvals were introduced only
        # have the aggregate fields, so retain their existing export output.
        owning_department_head_decision = obj.dept_head_decision or "Pending"
        owning_department_head_name = uname(obj.dept_head_id) or "—"

    sections = [
        ("Status", [
            ("Status", obj.status),
            ("Scan Type", obj.scan_type),
            ("Linked Request", (obj.sast_request.request_id if obj.sast_request else None)
                                or (obj.dast_request.request_id if obj.dast_request else None)),
        ]),
        ("Application", [
            ("Application Name", obj.application_name),
            ("Department", obj.department),
            ("Application Owner", obj.application_owner),
        ]),
        ("Decisions", [
            ("SM Decision", f"{obj.sm_decision or 'Pending'} — {uname(obj.sm_id) or '—'}"),
            ("Department Head Decision", f"{owning_department_head_decision} — {owning_department_head_name}"),
            ("Required Department Approvals", StructuredTableValue(
                headers=("Department", "Decision", "Decided By"),
                rows=[
                    (approval.department_name or "—", approval.decision, approval.approver_name or "—")
                    for approval in obj.department_approvals
                ],
                width_ratios=(.45, .2, .35),
            )),
            ("Security Team Decision", f"{obj.security_decision or 'Pending'} — {uname(obj.security_id) or '—'}"),
        ]),
        ("Risk Assessment", [
            ("Risk Assessment", obj.risk_assessment),
        ]),
        ("Findings Covered", [
            ("Findings", StructuredTableValue(
                headers=("Issue Group", "Severity", "Description", "Justification"),
                rows=[
                    (i.issue_id or f"Finding {i.id}", i.severity, i.description, i.justification)
                    for i in obj.items
                ],
                width_ratios=(.17, .13, .32, .38),
            )),
        ]),
        ("Requester", [
            ("Requester", uname(obj.created_by_id)),
        ]),
    ]

    history_rows = (db.query(models.ApprovalAction)
                     .filter_by(entity_type="SUPPRESSION", entity_id=sup_id)
                     .order_by(models.ApprovalAction.created_at).all())
    history = []
    for h in history_rows:
        history.append((h.step_name or "—", h.decision or "—", uname(h.actor_id) or "—",
                         h.actor_role or "—", h.comments or "—",
                         h.created_at.strftime("%Y-%m-%d %H:%M") if h.created_at else "—"))

    buf = build_request_detail_pdf(
        title=f"{obj.suppression_id} — {obj.application_name}",
        subtitle="Suppression / False Positive Request — Full Detail Export",
        sections=sections, history=history,
        generated_by=current_user.full_name,
        generated_at=models.now().strftime("%Y-%m-%d %H:%M IST"),
    )
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{obj.suppression_id}.pdf"'},
    )


def _can_upload_documents(db: Session, obj: "models.SuppressionRequest", user: models.User) -> bool:
    """Only the requester mutates evidence while the request is in their hands.

    Reviewers preserve maker/checker separation by returning the request with
    comments when evidence needs changing. Admin retains the application's
    standard recovery/oversight bypass.
    """
    if user.has_role(Role.ADMIN):
        return True
    return obj.status in _REQUESTER_EDIT_STATUSES and obj.created_by_id == user.id


# ---- Supporting documents (multiple files, uploaded any time after the
# request has been raised) -- see documents.py for the shared implementation. ----
@router.get("/{sup_id}/documents", response_model=List[schemas.RequestDocumentOut])
def list_suppression_documents(sup_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.get(models.SuppressionRequest, sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    return doc_store.list_documents(db, "SUPPRESSION", sup_id)


@router.post("/{sup_id}/documents", response_model=List[schemas.RequestDocumentOut])
def upload_suppression_documents(sup_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                                  current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    if not _can_upload_documents(db, obj, current_user):
        raise HTTPException(
            403,
            "Only the requester can upload documents while the request is Draft or Returned. "
            "Reviewers must return the request with comments for evidence changes.",
        )
    return doc_store.save_documents(db, "SUPPRESSION", sup_id, obj.suppression_id, files, current_user.id,
                                     log_entity_type="SUPPRESSION", log_entity_id=obj.id, log_actor=current_user)


@router.get("/{sup_id}/documents/{doc_id}/download")
def download_suppression_document(sup_id: int, doc_id: int, db: Session = Depends(get_db),
                                   current_user: models.User = Depends(get_current_user)):
    obj = db.get(models.SuppressionRequest, sup_id)
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    doc = doc_store.get_document_or_404(db, "SUPPRESSION", sup_id, doc_id)
    full_path = doc_store.full_path(doc)
    if not os.path.exists(full_path):
        raise HTTPException(404, "File is missing on disk")
    return FileResponse(full_path, filename=doc.file_name, media_type=doc.content_type or "application/octet-stream")


@router.delete("/{sup_id}/documents/{doc_id}")
def delete_suppression_document(sup_id: int, doc_id: int, db: Session = Depends(get_db),
                                 current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.SuppressionRequest).filter_by(id=sup_id).populate_existing().with_for_update().one_or_none()
    if not obj:
        raise HTTPException(404, "Suppression request not found")
    _require_visible(db, obj, current_user)
    doc = doc_store.get_document_or_404(db, "SUPPRESSION", sup_id, doc_id)
    if not doc_store.can_delete_document(doc, current_user, _can_upload_documents(db, obj, current_user)):
        raise HTTPException(403, "Only whoever uploaded this document, or an admin, can delete it -- and only while it's still your stage")
    doc_store.delete_document(db, doc, log_entity_type="SUPPRESSION", log_entity_id=sup_id, log_actor=current_user)
    return {"ok": True}
