import os
import zipfile
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.datastructures import Headers
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, or_

from .. import models, schemas, pagination
from ..database import get_db
from ..deps import (
    get_workflow_user as get_current_user, require_workflow_roles as require_roles, dashboard_department_scope,
    resolve_entity_department, resolve_entity_workspace_id, require_entity_workspace_visibility,
    require_department_visibility, viewable_project_ids,
)
from .. import documents as doc_store
from ..constants import GatewayStatus, Role, format_role_labels
from ..upload_limits import validate_document_file_types
from ..activity_mentions import mentioned_usernames, mentionable_username

router = APIRouter(prefix="/api/approvals", tags=["approval-workflow-engine"])


def _resolve_request_ref(db: Session, entity_type: str, entity_id: int) -> Optional[str]:
    """Human-readable business ID for an ApprovalAction's entity_type/entity_id
    (e.g. "TQA-REQ-...", "TQA-SAST-...", "TQA-SUP-...") -- shown in the Approval
    Workflow Log instead of the raw internal entity_id. Returns None if the
    underlying record no longer exists."""
    if entity_type == "QA_REQUEST":
        obj = db.get(models.QARequest, entity_id)
        return obj.request_id if obj else None
    if entity_type == "FUNCTIONAL_REQUEST":
        obj = db.get(models.FunctionalRequest, entity_id)
        return obj.request_id if obj else None
    if entity_type == "SAST":
        obj = db.get(models.SASTRequest, entity_id)
        return obj.request_id if obj else None
    if entity_type == "DAST":
        obj = db.get(models.DASTRequest, entity_id)
        return obj.request_id if obj else None
    if entity_type == "SAST_DAST":
        # Legacy rows logged before SAST/DAST were split into their own
        # distinct entity_type values above (see the long comment on
        # routers/sast_dast.py::_legacy_history_rows) -- entity_id here may
        # belong to either table, so this is a best-effort lookup only, kept
        # for rows written before the split.
        sast = db.get(models.SASTRequest, entity_id)
        if sast:
            return sast.request_id
        dast = db.get(models.DASTRequest, entity_id)
        return dast.request_id if dast else None
    if entity_type == "PERFORMANCE":
        obj = db.get(models.PerformanceRequest, entity_id)
        return obj.request_id if obj else None
    if entity_type == "SUPPRESSION":
        obj = db.get(models.SuppressionRequest, entity_id)
        return obj.suppression_id if obj else None
    if entity_type == "SIGNOFF":
        obj = db.get(models.QASignOff, entity_id)
        return obj.certificate_id if obj else None
    if entity_type == "DEFECT":
        obj = db.get(models.Defect, entity_id)
        return obj.defect_key if obj else None
    return None


def _request_refs(db: Session, rows) -> dict:
    """Batch display references without loading full requests or their CLOBs."""
    sources = {
        "QA_REQUEST": (models.QARequest, "request_id"),
        "FUNCTIONAL_REQUEST": (models.FunctionalRequest, "request_id"),
        "SAST": (models.SASTRequest, "request_id"),
        "DAST": (models.DASTRequest, "request_id"),
        "PERFORMANCE": (models.PerformanceRequest, "request_id"),
        "SUPPRESSION": (models.SuppressionRequest, "suppression_id"),
        "SIGNOFF": (models.QASignOff, "certificate_id"),
        "DEFECT": (models.Defect, "defect_key"),
    }
    keys = {(row.entity_type, row.entity_id) for row in rows}
    refs = {}
    for kind in {key[0] for key in keys}:
        candidates = [(models.SASTRequest, "request_id"), (models.DASTRequest, "request_id")] if kind == "SAST_DAST" else ([sources[kind]] if kind in sources else [])
        identifiers = [identifier for entity_type, identifier in keys if entity_type == kind]
        for model, attribute in candidates:
            for identifier, ref in db.query(model.id, getattr(model, attribute)).filter(model.id.in_(identifiers)):
                # Legacy SAST_DAST resolves SAST first, even if its ID is blank.
                refs.setdefault((kind, identifier), ref)
    return refs


def _to_out(db: Session, row: models.ApprovalAction, request_refs=None) -> dict:
    return {
        "id": row.id, "entity_type": row.entity_type, "entity_id": row.entity_id,
        "request_ref": (_resolve_request_ref(db, row.entity_type, row.entity_id) if request_refs is None
                        else request_refs.get((row.entity_type, row.entity_id))),
        "step_name": row.step_name, "actor_id": row.actor_id, "actor_name": row.actor_name,
        "actor_role": format_role_labels(row.actor_role),
        "decision": row.decision, "comments": row.comments, "created_at": row.created_at,
    }


def _invited_suppression_ids(db: Session, current_user: models.User, entity_ids) -> set[int]:
    """Suppression requests assigned to one of this Department Head's teams.

    A multi-department suppression remains owned by the requester's primary
    department, so the generic entity-department resolver cannot by itself
    grant an invited Department Head access to its history or comments.
    """
    ids = {entity_id for entity_id in entity_ids if entity_id is not None}
    if not ids or not current_user.has_role(Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM):
        return set()
    departments = current_user.departments
    if not departments:
        return set()
    return {
        request_id for (request_id,) in db.query(
            models.SuppressionDepartmentApproval.suppression_request_id,
        ).join(
            models.Department,
            models.SuppressionDepartmentApproval.department_id == models.Department.id,
        ).filter(
            models.SuppressionDepartmentApproval.suppression_request_id.in_(ids),
            models.Department.name.in_(departments),
        ).distinct().all()
    }


def _filtered_approval_rows(db: Session, current_user: models.User, entity_type: Optional[str],
                            entity_id: Optional[int] = None,
                            approval_action_id: Optional[int] = None) -> List[models.ApprovalAction]:
    """Shared by `list_approvals` and `list_approval_history` (see each of
    their own docstrings for why there are two endpoints over the same
    underlying feed).

    Reported bug: this feed has no role gate on its own (any logged-in user
    can open Approval Workflow Log) and was returning every row completely
    unfiltered -- including "Drafted"/"Cancelled" QA_REQUEST entries for
    every other user's gateway request that was never actually raised, the
    same data routers/qa_requests.py::_can_view_gateway already restricts to
    its own requester elsewhere. Pull extra rows, then drop any QA_REQUEST
    entry whose underlying gateway is Draft or Cancelled (Cancelled can only
    ever be reached FROM Draft -- there's no cancel path from Raised, so it's
    always an abandoned Draft too) and isn't the caller's own, before
    trimming to the usual 500.

    Department scoping (see dashboard_department_scope) is applied
    unconditionally -- previously an opt-in `dashboard_scope` flag limited
    this to the Dashboard's own "Recent Activity" fetch and deliberately left
    the standalone Approval Workflow Log page (modules/governance/
    Approvals.tsx) showing every department; reported directly that this
    page should also be department-scoped like everything else, so the flag
    was removed and this now always applies the same restriction, whichever
    page calls it.

    Department scoping can't be pushed into the SQL query itself:
    ApprovalAction's entity_type is heterogeneous (QA_REQUEST/SAST/DAST/.../
    DEFECT, each resolved via resolve_entity_department's own per-row
    lookup against a different table, not one joinable column) -- so this
    stays a pull-2000-then-filter-in-Python shape rather than a real SQL
    WHERE clause."""
    q = db.query(models.ApprovalAction).options(selectinload(models.ApprovalAction.actor))
    if approval_action_id is not None:
        q = q.filter(models.ApprovalAction.id == approval_action_id)
    if entity_type:
        q = q.filter(models.ApprovalAction.entity_type == entity_type)
    if entity_id is not None:
        q = q.filter(models.ApprovalAction.entity_id == entity_id)
    rows = q.order_by(models.ApprovalAction.created_at.desc()).limit(2000).all()
    # Discussion events follow the record's exact policy, just like their
    # attachments. Keep legacy/orphaned workflow audit visibility unchanged.
    comment_visibility = {}
    def comment_visible(row):
        key = (row.entity_type, row.entity_id)
        if key not in comment_visibility:
            try:
                _comment_target_or_404(db, *key, current_user)
                comment_visibility[key] = True
            except HTTPException:
                comment_visibility[key] = False
        return comment_visibility[key]
    rows = [row for row in rows if row.decision != "Commented" or comment_visible(row)]
    if not current_user.has_role(Role.ADMIN):
        draft_qa_ids = {r.entity_id for r in rows if r.entity_type == "QA_REQUEST"}
        if draft_qa_ids:
            hidden_ids = {
                row[0] for row in db.query(models.QARequest.id).filter(
                    models.QARequest.id.in_(draft_qa_ids),
                    models.QARequest.status.in_((GatewayStatus.DRAFT, GatewayStatus.CANCELLED)),
                    models.QARequest.requester_id != current_user.id,
                ).all()
            }
            if hidden_ids:
                rows = [r for r in rows if r.decision == "Commented" or not (r.entity_type == "QA_REQUEST" and r.entity_id in hidden_ids)]
    invited_suppression_ids = _invited_suppression_ids(
        db,
        current_user,
        (r.entity_id for r in rows if r.entity_type == "SUPPRESSION"),
    )
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        from ..workflow_authority import record_department
        departments = {}
        def department(row):
            key = (row.entity_type, row.entity_id)
            if key not in departments:
                departments[key] = resolve_entity_department(db, *key)
            return departments[key]
        rows = [r for r in rows if r.decision == "Commented" or department(r) in scope
                or (r.entity_type == "SUPPRESSION" and r.entity_id in invited_suppression_ids)
                or (r.entity_type == 'DEFECT' and record_department(db, r, current_user)[1] in scope)]
    # Always run the entity visibility resolver. For ordinary business users
    # there may be no QA-workspace scope tuple, but project/folder visibility
    # (notably restricted Test Cycle folders) still applies.
    visibility = {}
    def visible(row):
        if row.decision == "Commented":
            return comment_visible(row)
        key = (row.entity_type, row.entity_id)
        if key not in visibility:
            try:
                require_entity_workspace_visibility(db, current_user, *key)
                visibility[key] = True
            except HTTPException:
                visibility[key] = False
        return visibility[key]
    rows = [r for r in rows if visible(r)]
    return rows[:500]


@router.get("", response_model=List[schemas.ApprovalActionOut])
def list_approvals(entity_type: Optional[str] = None, entity_id: Optional[int] = None,
                    db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Module 7: cross-entity approval/audit feed (QA_REQUEST, TEST_CASE, SAST_DAST, SUPPRESSION, SIGNOFF).

    Left as a bare array (not wrapped in Page[T]) -- unlike
    `list_approval_history` below, this endpoint's ~13 call sites across the
    app (Defects.tsx, TestRepository.tsx, TestProjects.tsx, TestExecution.tsx,
    JiraActivity's own per-entity feed, Dashboard.tsx's Recent Activity
    widget) all pass an explicit `entity_type`+`entity_id` pair and expect a
    bare array back. Each of those feeds is inherently bounded -- one
    record's own approval history never grows past what that one record
    could ever accumulate -- so PAG-001..010 pagination doesn't apply to
    them; see list_approval_history's own docstring for the one consumer
    (the standalone, no-entity_id Approval Workflow Log) that genuinely
    browses this feed page by page and was migrated instead."""
    rows = _filtered_approval_rows(db, current_user, entity_type, entity_id)
    refs = _request_refs(db, rows)
    return [_to_out(db, r, refs) for r in rows]


def _assignment_entity_department(db: Session, entity_type: str, entity_id: int) -> Optional[str]:
    if entity_type == "TEST_CYCLE":
        row = db.query(models.TestProject.department).join(
            models.TestCycle, models.TestCycle.project_id == models.TestProject.id,
        ).filter(models.TestCycle.id == entity_id).first()
        return row[0] if row else None
    if entity_type == "TEST_EXECUTION":
        row = db.query(models.TestProject.department).join(
            models.TestCycle, models.TestCycle.project_id == models.TestProject.id,
        ).join(
            models.TestExecution, models.TestExecution.cycle_id == models.TestCycle.id,
        ).filter(models.TestExecution.id == entity_id).first()
        return row[0] if row else None
    return resolve_entity_department(db, entity_type, entity_id)


@router.get("/assignment-history", response_model=List[schemas.AssignmentHistoryOut])
def list_assignment_history(
    entity_type: str,
    entity_id: int,
    assignment_role: Optional[str] = None,
    active_only: bool = False,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(
        Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
        Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM,
    )),
):
    """Return normalized assignee tenures for management/audit reporting."""
    normalized_type = entity_type.strip().upper()
    require_entity_workspace_visibility(db, current_user, normalized_type, entity_id)
    department = _assignment_entity_department(db, normalized_type, entity_id)
    if department is None:
        raise HTTPException(404, "Assignment-history entity not found")
    scope = dashboard_department_scope(current_user)
    if scope is not None and department not in scope and not current_user.has_role(Role.ADMIN):
        raise HTTPException(403, "Assignment history is outside your department scope")
    q = db.query(models.AssignmentHistory).filter(
        models.AssignmentHistory.entity_type == normalized_type,
        models.AssignmentHistory.entity_id == entity_id,
    )
    if assignment_role:
        q = q.filter(models.AssignmentHistory.assignment_role == assignment_role.strip().upper())
    if active_only:
        q = q.filter(models.AssignmentHistory.unassigned_at.is_(None))
    return q.order_by(models.AssignmentHistory.assigned_at.desc(), models.AssignmentHistory.id.desc()).limit(1000).all()


@router.get("/history", response_model=pagination.Page[schemas.ApprovalActionOut])
def list_approval_history(entity_type: Optional[str] = None, params: pagination.PageParams = Depends(),
                          db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """SRS 7.2 pagination rollout -- backs modules/governance/Approvals.tsx's
    "Approval Workflow Log," the one screen that genuinely paginates through
    this feed rather than reading one entity's own bounded history (see
    `list_approvals`' own docstring for why every other consumer was left
    on the plain, unpaginated endpoint). No `entity_id` filter here --
    Approvals.tsx only ever filters by entity_type, matching its existing
    UI (a single "entity type" dropdown, no per-record drill-down).

    `total`/`total_pages` reflect `_filtered_approval_rows`' existing
    500-row ceiling, not a true unbounded count of this app's entire audit
    history -- a known, pre-existing limitation (the same 500-row cap
    `list_approvals` already applied before this endpoint existed) carried
    forward rather than introduced by this change. Fixing that properly
    would mean denormalizing a `department` column onto ApprovalAction
    itself so scoping could run in SQL instead of Python -- out of scope
    for this pagination rollout."""
    rows = _filtered_approval_rows(db, current_user, entity_type)
    refs = _request_refs(db, rows) if params.search else None
    if params.search:
        needle = params.search.casefold()
        filtered = []
        for row in rows:
            request_ref = refs.get((row.entity_type, row.entity_id))
            searchable = (
                row.entity_type, request_ref, f"#{row.entity_id}", row.step_name,
                row.decision, row.actor_name, format_role_labels(row.actor_role), row.comments,
                row.previous_state, row.new_state,
            )
            if any(needle in str(value or "").casefold() for value in searchable):
                filtered.append(row)
        rows = filtered
    total = len(rows)
    start = (params.page - 1) * params.page_size
    page_rows = rows[start:start + params.page_size]
    total_pages = max(1, -(-total // params.page_size)) if params.page_size else 1
    refs = _request_refs(db, page_rows) if refs is None else refs
    result = pagination.PaginationResult(items=[_to_out(db, r, refs) for r in page_rows], total=total, total_pages=total_pages)
    return pagination.to_page_response(result, params)


_COMMENT_ENTITY_MODELS = {
    "QA_REQUEST": models.QARequest,
    "FUNCTIONAL_REQUEST": models.FunctionalRequest,
    "SAST": models.SASTRequest,
    "DAST": models.DASTRequest,
    "PERFORMANCE": models.PerformanceRequest,
    "SUPPRESSION": models.SuppressionRequest,
    "SIGNOFF": models.QASignOff,
    "TEST_PROJECT": models.TestProject,
    "TEST_CASE": models.TestCase,
    "TEST_CYCLE": models.TestCycle,
    "DEFECT": models.Defect,
}

_COMMENT_ATTACHMENT_MIMES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
    ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv", ".txt": "text/plain", ".log": "text/plain",
}
_COMMENT_ATTACHMENT_LIMIT = 8
_COMMENT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024


_PROJECT_VISIBILITY_UNSET = object()


def _comment_target_or_404(db: Session, entity_type: str, entity_id: int, current_user: models.User,
                           *, visible_project_ids=_PROJECT_VISIBILITY_UNSET):
    normalized_type = entity_type.strip().upper()
    model = _COMMENT_ENTITY_MODELS.get(normalized_type)
    if not model:
        raise HTTPException(400, f"Comments are not supported for entity type '{entity_type}'")
    obj = db.get(model, entity_id)
    if not obj:
        raise HTTPException(404, "Record not found")
    if normalized_type == "DEFECT":
        from .defects import _get_visible
        _get_visible(entity_id, db, current_user)
        return normalized_type
    if normalized_type in {"TEST_PROJECT", "TEST_CASE", "TEST_CYCLE"}:
        project_id = obj.id if normalized_type == "TEST_PROJECT" else obj.project_id
        # Callers checking many records for this same user/workspace can
        # reuse the live project scope resolved earlier in this request.
        visible_ids = (viewable_project_ids(db, current_user)
                       if visible_project_ids is _PROJECT_VISIBILITY_UNSET else visible_project_ids)
        if visible_ids is not None and project_id not in visible_ids:
            raise HTTPException(403, "You do not have access to this record")
        if normalized_type == "TEST_CYCLE":
            require_entity_workspace_visibility(db, current_user, normalized_type, entity_id)
    else:
        require_entity_workspace_visibility(db, current_user, normalized_type, entity_id)
        # Activity is part of the same record. Reuse its actual read policy,
        # including private drafts, verified delegates and invited reviewers.
        if normalized_type == "QA_REQUEST":
            from .qa_requests import _require_gateway_visibility
            _require_gateway_visibility(db, obj, current_user)
        elif normalized_type == "FUNCTIONAL_REQUEST":
            from .functional import _require_visible
            _require_visible(db, obj, current_user)
        elif normalized_type in {"SAST", "DAST"}:
            from .sast_dast import _require_visible
            _require_visible(db, obj, current_user)
        elif normalized_type == "PERFORMANCE":
            from .performance import _require_visible
            _require_visible(db, obj, current_user)
        elif normalized_type == "SUPPRESSION":
            from .suppression import _require_visible
            _require_visible(db, obj, current_user)
        elif normalized_type == "SIGNOFF":
            from .signoff import _get_visible_or_404
            _get_visible_or_404(db, entity_id, current_user)
    return normalized_type


def _validated_comment_body(body: str, allow_empty: bool = False) -> str:
    text = body.strip()
    if not text and not allow_empty:
        raise HTTPException(400, "Comment cannot be blank")
    if len(text) > 5000:
        raise HTTPException(400, "Comment cannot exceed 5,000 characters")
    return text


_MENTION_WORKSPACE_UNSET = object()


def _can_receive_mention(db: Session, entity_type: str, entity_id: int,
                         recipient: models.User, author: models.User, *,
                         owner_workspace=_MENTION_WORKSPACE_UNSET) -> bool:
    from ..deps import ldap_email_completion_required
    from ..workspace_service import selectable_workspace_ids, workspace_context
    from ..workflow_authority import workflow_context
    if (recipient.id == author.id or not recipient.is_active
            or not (recipient.email or "").strip()
            or recipient.needs_department_selection or recipient.needs_role_review
            or not recipient.roles
            or ldap_email_completion_required(recipient)
            or not mentionable_username(recipient.username)):
        return False
    accessible = selectable_workspace_ids(db, recipient)
    if owner_workspace is _MENTION_WORKSPACE_UNSET:
        owner_workspace = resolve_entity_workspace_id(db, entity_type, entity_id)
    # Shared project content may also be readable from a participating workspace.
    scopes = ([owner_workspace] if owner_workspace in accessible else [])
    if entity_type in {"TEST_PROJECT", "TEST_CASE", "TEST_CYCLE", "DEFECT"}:
        scopes.extend(sorted(accessible - set(scopes)))
    previous = getattr(recipient, "active_qa_workspace_id", None)
    try:
        for workspace_id in scopes:
            recipient.active_qa_workspace_id = workspace_id
            with workspace_context(workspace_id, (workspace_id,)), workflow_context(recipient), db.no_autoflush:
                try:
                    _comment_target_or_404(db, entity_type, entity_id, recipient)
                    return True
                except HTTPException as exc:
                    if exc.status_code not in {403, 404}:
                        raise
        return False
    finally:
        recipient.active_qa_workspace_id = previous


def _mention_candidates(db: Session):
    # Load directory/access relationships in batches instead of per keystroke/user.
    return db.query(models.User).options(
        selectinload(models.User.role_assignments),
        selectinload(models.User.department_assignments),
        selectinload(models.User.qa_workspace_memberships).selectinload(models.QAWorkspaceMember.workspace),
        selectinload(models.User.department_coordinator_assignments).selectinload(models.DepartmentCoordinatorAssignment.workspace),
    ).filter(models.User.is_active == True)  # noqa: E712


@router.get("/{entity_type}/{entity_id}/mention-options")
def mention_options(entity_type: str, entity_id: int, search: str = "",
                    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    normalized = _comment_target_or_404(db, entity_type, entity_id, current_user)
    # Keep the one target alive in the session's identity map while checking
    # recipients, rather than reloading its full record for each directory row.
    target = db.get(_COMMENT_ENTITY_MODELS[normalized], entity_id)
    owner_workspace = resolve_entity_workspace_id(db, normalized, target.id)
    term = search.strip()[:64].lower()
    candidates = _mention_candidates(db)
    if term:
        candidates = candidates.filter(or_(
            func.lower(models.User.username).contains(term, autoescape=True),
            func.lower(models.User.full_name).contains(term, autoescape=True),
        ))
    results = []
    for recipient in candidates.order_by(models.User.username, models.User.id).limit(100):
        if _can_receive_mention(db, normalized, entity_id, recipient, current_user, owner_workspace=owner_workspace):
            results.append({"id": recipient.id, "username": recipient.username,
                            "full_name": recipient.full_name})
            if len(results) == 20:
                break
    return results


def _validate_comment_attachments(files: List[UploadFile]) -> None:
    if not files:
        return
    if len(files) > _COMMENT_ATTACHMENT_LIMIT:
        raise HTTPException(400, f"A comment can contain at most {_COMMENT_ATTACHMENT_LIMIT} attachments")
    for upload in files:
        filename = upload.filename or ""
        extension = os.path.splitext(filename)[1].lower()
        if (not filename or len(filename) > 255 or any(char in filename for char in ("/", "\\", "\x00"))
                or extension not in _COMMENT_ATTACHMENT_MIMES):
            raise HTTPException(415, f"'{filename or 'Unnamed file'}' is not a supported attachment. Use PDF, Word, Excel, CSV, TXT, LOG, PNG, JPEG, GIF, or WebP.")
        position = upload.file.tell()
        try:
            upload.file.seek(0, os.SEEK_END)
            size = upload.file.tell()
            if size == 0:
                raise HTTPException(400, f"'{filename}' is empty. Attach a file containing evidence.")
            if size > _COMMENT_ATTACHMENT_MAX_BYTES:
                raise HTTPException(413, f"'{filename}' exceeds the 10 MB attachment limit")
        finally:
            upload.file.seek(position)
    # Sniff actual bytes using the common evidence boundary, rather than
    # accepting the client-provided Content-Type or extension alone.
    validate_document_file_types(files)
    for upload in files:
        extension = os.path.splitext(upload.filename)[1].lower()
        if extension in {".docx", ".xlsx"}:
            position = upload.file.tell()
            try:
                upload.file.seek(0)
                with zipfile.ZipFile(upload.file) as package:
                    names = set(package.namelist())
                required_part = "word/document.xml" if extension == ".docx" else "xl/workbook.xml"
                if "[Content_Types].xml" not in names or required_part not in names:
                    raise ValueError("Office document parts missing")
            except (zipfile.BadZipFile, OSError, ValueError) as exc:
                raise HTTPException(415, f"'{upload.filename}' is not a valid {'Word' if extension == '.docx' else 'Excel'} document") from exc
            finally:
                upload.file.seek(position)
        # Storage reads UploadFile.content_type from these headers. Normalize
        # it now so attachment metadata and later previews use a safe type.
        upload.headers = Headers({**dict(upload.headers), "content-type": _COMMENT_ATTACHMENT_MIMES[extension]})


def _create_comment(db: Session, normalized_type: str, entity_id: int, body: str,
                    current_user: models.User, *, commit: bool = True) -> models.ApprovalAction:
    row = models.ApprovalAction(
        entity_type=normalized_type, entity_id=entity_id, step_name="Comment",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Commented", comments=body or None,
    )
    db.add(row)
    names = mentioned_usernames(body)
    if names:
        from ..email_notifications import queue_activity_mentions
        with db.no_autoflush:
            target = db.get(_COMMENT_ENTITY_MODELS[normalized_type], entity_id)
            owner_workspace = resolve_entity_workspace_id(db, normalized_type, target.id)
            recipients = [recipient for recipient in _mention_candidates(db).filter(
                func.lower(models.User.username).in_(names),
            ).all() if _can_receive_mention(db, normalized_type, entity_id, recipient, current_user, owner_workspace=owner_workspace)]
            queue_activity_mentions(db, row, current_user, recipients)
    if commit:
        db.commit()
        db.refresh(row)
    else:
        # Reserve the comment id inside the same transaction that will write
        # its attachments.  save_documents commits both together; if upload
        # validation, storage, or the database operation fails, its rollback
        # removes this pending comment instead of leaving a phantom audit row.
        db.flush()
    return row


@router.post("/{entity_type}/{entity_id}/comments", response_model=schemas.ApprovalActionOut)
def add_comment(entity_type: str, entity_id: int, payload: schemas.CommentCreate,
                db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Append a Jira-style standalone comment to any supported module's
    existing audit stream. Comments are immutable audit events and therefore
    remain visible alongside workflow actions and approvals."""
    normalized_type = _comment_target_or_404(db, entity_type, entity_id, current_user)
    body = _validated_comment_body(payload.body)
    row = _create_comment(db, normalized_type, entity_id, body, current_user)
    return _to_out(db, row)


@router.post("/{entity_type}/{entity_id}/rich-comments", response_model=schemas.ApprovalActionOut)
def add_rich_comment(entity_type: str, entity_id: int, body: str = Form(""),
                     files: List[UploadFile] = File(default=[]), db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    """Post formatted comment text plus files pasted or selected in the
    shared Jira-style editor. Formatting is stored as safe Markdown text;
    files are immutable authenticated attachments owned by the comment."""
    normalized_type = _comment_target_or_404(db, entity_type, entity_id, current_user)
    _validate_comment_attachments(files)
    text = _validated_comment_body(body, allow_empty=bool(files))
    row = _create_comment(
        db, normalized_type, entity_id, text, current_user, commit=not files
    )
    if files:
        try:
            doc_store.save_documents(
                db, "COMMENT_IMAGE", row.id, f"comment-{row.id}", files, current_user.id
            )
        except Exception:
            # save_documents rolls back failures reached during file writes or
            # commit.  Validation happens before its own try block, so keep an
            # outer rollback to cover malformed filenames/content as well.
            db.rollback()
            raise
    return _to_out(db, row)


def _comment_or_404(db: Session, comment_id: int) -> models.ApprovalAction:
    row = db.get(models.ApprovalAction, comment_id)
    if not row or row.decision != "Commented":
        raise HTTPException(404, "Comment not found")
    return row


def _visible_comment_or_404(db: Session, comment_id: int, current_user: models.User) -> models.ApprovalAction:
    row = _comment_or_404(db, comment_id)
    _comment_target_or_404(db, row.entity_type, row.entity_id, current_user)
    return row


@router.get("/comments/{comment_id}/attachments", response_model=List[schemas.RequestDocumentOut])
def list_comment_attachments(comment_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    _visible_comment_or_404(db, comment_id, current_user)
    return doc_store.list_documents(db, "COMMENT_IMAGE", comment_id)


@router.get("/comments/{comment_id}/attachments/{document_id}/download")
def download_comment_attachment(comment_id: int, document_id: int, db: Session = Depends(get_db),
                                current_user: models.User = Depends(get_current_user)):
    _visible_comment_or_404(db, comment_id, current_user)
    document = doc_store.get_document_or_404(db, "COMMENT_IMAGE", comment_id, document_id)
    path = doc_store.full_path(document)
    if not os.path.isfile(path):
        raise HTTPException(404, "Comment attachment is missing from storage")
    extension = os.path.splitext(document.file_name)[1].lower()
    return FileResponse(path, filename=document.file_name,
        media_type=_COMMENT_ATTACHMENT_MIMES.get(extension, "application/octet-stream"),
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.get("/pending-mine", response_model=List[schemas.ApprovalActionOut])
def my_recent_actions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = (db.query(models.ApprovalAction)
            .filter(models.ApprovalAction.actor_id == current_user.id)
            .order_by(models.ApprovalAction.created_at.desc()).limit(100).all())
    visible = {}
    result = []
    for row in rows:
        if row.decision == "Commented":
            key = (row.entity_type, row.entity_id)
            if key not in visible:
                try:
                    _comment_target_or_404(db, *key, current_user)
                    visible[key] = True
                except HTTPException:
                    visible[key] = False
            if not visible[key]:
                continue
        result.append(_to_out(db, row))
    return result
