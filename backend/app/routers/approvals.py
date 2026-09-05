import os
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas, pagination
from ..database import get_db
from ..deps import (
    get_current_user, require_roles, dashboard_department_scope,
    resolve_entity_department, require_department_visibility, viewable_project_ids,
)
from .. import documents as doc_store
from ..constants import GatewayStatus, Role

router = APIRouter(prefix="/api/approvals", tags=["approval-workflow-engine"])


def _resolve_request_ref(db: Session, entity_type: str, entity_id: int) -> Optional[str]:
    """Human-readable business ID for an ApprovalAction's entity_type/entity_id
    (e.g. "TQA-REQ-...", "TQA-SAST-...", "TQA-SUP-...") -- shown in the Approval
    Workflow Log instead of the raw internal entity_id. Returns None if the
    underlying record no longer exists."""
    if entity_type == "QA_REQUEST":
        obj = db.query(models.QARequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "FUNCTIONAL_REQUEST":
        obj = db.query(models.FunctionalRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "SAST":
        obj = db.query(models.SASTRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "DAST":
        obj = db.query(models.DASTRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "SAST_DAST":
        # Legacy rows logged before SAST/DAST were split into their own
        # distinct entity_type values above (see the long comment on
        # routers/sast_dast.py::_legacy_history_rows) -- entity_id here may
        # belong to either table, so this is a best-effort lookup only, kept
        # for rows written before the split.
        sast = db.query(models.SASTRequest).get(entity_id)
        if sast:
            return sast.request_id
        dast = db.query(models.DASTRequest).get(entity_id)
        return dast.request_id if dast else None
    if entity_type == "PERFORMANCE":
        obj = db.query(models.PerformanceRequest).get(entity_id)
        return obj.request_id if obj else None
    if entity_type == "SUPPRESSION":
        obj = db.query(models.SuppressionRequest).get(entity_id)
        return obj.suppression_id if obj else None
    if entity_type == "SIGNOFF":
        obj = db.query(models.QASignOff).get(entity_id)
        return obj.certificate_id if obj else None
    if entity_type == "DEFECT":
        obj = db.query(models.Defect).get(entity_id)
        return obj.defect_key if obj else None
    return None


def _to_out(db: Session, row: models.ApprovalAction) -> dict:
    return {
        "id": row.id, "entity_type": row.entity_type, "entity_id": row.entity_id,
        "request_ref": _resolve_request_ref(db, row.entity_type, row.entity_id),
        "step_name": row.step_name, "actor_id": row.actor_id, "actor_name": row.actor_name, "actor_role": row.actor_role,
        "decision": row.decision, "comments": row.comments, "created_at": row.created_at,
    }


def _filtered_approval_rows(db: Session, current_user: models.User, entity_type: Optional[str],
                            entity_id: Optional[int] = None) -> List[models.ApprovalAction]:
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
    q = db.query(models.ApprovalAction)
    if entity_type:
        q = q.filter(models.ApprovalAction.entity_type == entity_type)
    if entity_id is not None:
        q = q.filter(models.ApprovalAction.entity_id == entity_id)
    rows = q.order_by(models.ApprovalAction.created_at.desc()).limit(2000).all()
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
                rows = [r for r in rows if not (r.entity_type == "QA_REQUEST" and r.entity_id in hidden_ids)]
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        rows = [r for r in rows if resolve_entity_department(db, r.entity_type, r.entity_id) in scope]
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
    return [_to_out(db, r) for r in _filtered_approval_rows(db, current_user, entity_type, entity_id)]


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
    if params.search:
        needle = params.search.casefold()
        filtered = []
        for row in rows:
            request_ref = _resolve_request_ref(db, row.entity_type, row.entity_id)
            searchable = (
                row.entity_type, request_ref, f"#{row.entity_id}", row.step_name,
                row.decision, row.actor_name, row.actor_role, row.comments,
                row.previous_state, row.new_state,
            )
            if any(needle in str(value or "").casefold() for value in searchable):
                filtered.append(row)
        rows = filtered
    total = len(rows)
    start = (params.page - 1) * params.page_size
    page_rows = rows[start:start + params.page_size]
    total_pages = max(1, -(-total // params.page_size)) if params.page_size else 1
    result = pagination.PaginationResult(items=[_to_out(db, r) for r in page_rows], total=total, total_pages=total_pages)
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

_COMMENT_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_COMMENT_IMAGE_LIMIT = 8
_COMMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024


def _comment_target_or_404(db: Session, entity_type: str, entity_id: int, current_user: models.User):
    normalized_type = entity_type.strip().upper()
    model = _COMMENT_ENTITY_MODELS.get(normalized_type)
    if not model:
        raise HTTPException(400, f"Comments are not supported for entity type '{entity_type}'")
    obj = db.query(model).get(entity_id)
    if not obj:
        raise HTTPException(404, "Record not found")
    if normalized_type in {"TEST_PROJECT", "TEST_CASE", "TEST_CYCLE"}:
        project_id = obj.id if normalized_type == "TEST_PROJECT" else obj.project_id
        visible_ids = viewable_project_ids(db, current_user)
        if visible_ids is not None and project_id not in visible_ids:
            raise HTTPException(403, "You do not have access to this record")
    else:
        requester_id = getattr(obj, "requester_id", None) or getattr(obj, "created_by_id", None)
        require_department_visibility(
            current_user, resolve_entity_department(db, normalized_type, entity_id),
            requester_id=requester_id,
        )
    return normalized_type


def _validated_comment_body(body: str, allow_empty: bool = False) -> str:
    text = body.strip()
    if not text and not allow_empty:
        raise HTTPException(400, "Comment cannot be blank")
    if len(text) > 5000:
        raise HTTPException(400, "Comment cannot exceed 5,000 characters")
    return text


def _validate_comment_images(files: List[UploadFile]) -> None:
    if len(files) > _COMMENT_IMAGE_LIMIT:
        raise HTTPException(400, f"A comment can contain at most {_COMMENT_IMAGE_LIMIT} images")
    for image in files:
        if (image.content_type or "").lower() not in _COMMENT_IMAGE_TYPES:
            raise HTTPException(
                400,
                f"'{image.filename or 'pasted image'}' is not a supported image. "
                "Use PNG, JPEG, GIF, or WebP.",
            )
        image.file.seek(0, os.SEEK_END)
        size = image.file.tell()
        image.file.seek(0)
        if size > _COMMENT_IMAGE_MAX_BYTES:
            raise HTTPException(400, f"'{image.filename or 'pasted image'}' exceeds the 10 MB image limit")


def _create_comment(db: Session, normalized_type: str, entity_id: int, body: str,
                    current_user: models.User) -> models.ApprovalAction:
    row = models.ApprovalAction(
        entity_type=normalized_type, entity_id=entity_id, step_name="Comment",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Commented", comments=body or None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
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
    """Post formatted comment text plus images pasted or selected in the
    shared Jira-style editor. Formatting is stored as safe Markdown text;
    images are immutable authenticated attachments owned by the comment."""
    normalized_type = _comment_target_or_404(db, entity_type, entity_id, current_user)
    _validate_comment_images(files)
    text = _validated_comment_body(body, allow_empty=bool(files))
    row = _create_comment(db, normalized_type, entity_id, text, current_user)
    if files:
        doc_store.save_documents(
            db, "COMMENT_IMAGE", row.id, f"comment-{row.id}", files, current_user.id
        )
    return _to_out(db, row)


def _comment_or_404(db: Session, comment_id: int) -> models.ApprovalAction:
    row = db.query(models.ApprovalAction).get(comment_id)
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
    if not os.path.exists(path):
        raise HTTPException(404, "Comment image is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")


@router.get("/pending-mine", response_model=List[schemas.ApprovalActionOut])
def my_recent_actions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = (db.query(models.ApprovalAction)
            .filter(models.ApprovalAction.actor_id == current_user.id)
            .order_by(models.ApprovalAction.created_at.desc()).limit(100).all())
    return [_to_out(db, r) for r in rows]
