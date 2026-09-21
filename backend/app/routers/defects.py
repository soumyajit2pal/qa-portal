import os
import json
from ..defect_workflow import policy
from collections import Counter
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from .. import documents as doc_store
from .. import models, schemas, pagination
from ..constants import (
    ENVIRONMENTS, Role, DEFECT_REASSIGNABLE_STATUSES,
)
from ..database import get_db
from ..deps import get_workflow_user as get_current_user, dashboard_department_scope, viewable_project_ids, active_qa_workspace_scope_ids
from ..xlsx_export import add_summary_sheet, add_table_sheet, new_workbook, workbook_response
from .. import reassignment

router = APIRouter(prefix="/api/defects", tags=["defect-management"])

STATUSES = ("Ready for QA", "QA Testing", "Business Acceptance", "Ready for Release", "Production Verification", "New", "Triaged", "Assigned", "In Progress", "Resolved", "Retest", "Reopened", "Deferred", "Rejected", "Duplicate", "Not a Defect", "Closed")
SEVERITIES = ("Critical", "High", "Medium", "Low")
PRIORITIES = ("P1 – Immediate", "P2 – High", "P3 – Medium", "P4 – Low")
RESOLUTION_TYPES = (
    "Fixed", "Configuration Changed", "Data Corrected", "Code Change",
    "Environment Issue Resolved", "Cannot Reproduce", "Working as Designed", "Other",
)
TRANSITIONS = {
    # Modern states use defect_workflow.transitions; never enter through the legacy API.
    "Ready for QA": set(), "QA Testing": set(), "Business Acceptance": set(),
    "Ready for Release": set(), "Production Verification": set(),
    # 2026-08 -- reported directly, with a full defect lifecycle diagram: a
    # New/Open defect should pass through an explicit "Triaged" checkpoint
    # (reviewed, validated, prioritized) before any disposition is made --
    # previously New went straight to Assigned/Rejected/Duplicate/etc. with
    # no tracked record that triage happened at all. Triaged now owns every
    # outgoing option New used to have; New itself only ever moves to
    # Triaged. (Two follow-up questions from that same report were answered
    # explicitly: "Won't Fix" is NOT a new status -- the existing "Not a
    # Defect" status covers that ground. Assignment is now captured as part
    # of Triage, while Reopened and Deferred work resume at In Progress.)
    "New": {"Triaged"},
    "Triaged": {"In Progress", "Rejected", "Duplicate", "Not a Defect", "Deferred"},
    "Assigned": {"In Progress", "Rejected", "Duplicate", "Not a Defect", "Deferred"},
    "In Progress": {"Resolved", "Rejected", "Duplicate", "Not a Defect", "Deferred"},
    "Resolved": {"Retest"},
    "Retest": {"Closed", "Reopened"},
    "Reopened": {"In Progress"},
    "Deferred": {"In Progress"},
    "Closed": {"Reopened"},
    "Rejected": {"Reopened"},
    "Duplicate": set(),
    "Not a Defect": {"Reopened"},
}
CREATE_ROLES = (
    Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    Role.SECURITY_ANALYST, Role.REQUESTER, Role.DEVELOPER, Role.BUSINESS_ANALYST,
    Role.APPLICATION_OWNER,
)
# 2026-08 -- reported directly, then corrected same day: "other than QA
# team, for others there should not be any option to open any defects," then
# "defect can be raised by requster, business analyst application owner too
# so defect management tool should be available for them as well." A role
# allow-list (DEFECT_MANAGEMENT_ROLES) gated list_defects/defect_dashboard/
# export_defects (plus test_execution.py's batch picker) for a while as a
# result -- but then, further reported directly: "currently Defect
# management is not available to everyone. make this visible to everyone
# based on department filter." The role gate is retired -- browsing the
# register is now open to any authenticated user, scoped purely by
# department (_scoped_defects below), exactly like every other module's own
# list endpoint (QA Requests, Functional, etc.) has always worked. Who may
# CREATE/link a defect is unaffected by this -- that's still CREATE_ROLES,
# checked separately by _require_create_role. A single-defect deep link
# (GET /{id}, GET /by-key/{key} -- e.g. from a direct link) was already
# open to any authenticated user regardless, unchanged here.
_DOC_MODULE = "DEFECT"
_REQUESTER_DISPOSITION_STATUSES = {"Rejected", "Duplicate", "Not a Defect"}
_QA_DEFECT_ROLES = {
    Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
}


def _get(defect_id: int, db: Session) -> models.Defect:
    obj = db.get(models.Defect, defect_id)
    if not obj:
        raise HTTPException(404, "Defect not found")
    return obj


def _get_visible(defect_id: int, db: Session, current_user: models.User) -> models.Defect:
    obj = _scoped_defects(db, current_user).filter(models.Defect.id == defect_id).first()
    if not obj:
        raise HTTPException(404, "Defect not found")
    return obj


def _get_mutable(defect_id: int, db: Session, current_user: models.User) -> models.Defect:
    """A project view grant may expose a linked defect, but never make it writable."""
    obj = _get_visible(defect_id, db, current_user)
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    defect_workspace_id = obj.qa_workspace_id or (
        obj.qa_request.qa_workspace_id if obj.qa_request else None
    )
    if workspace_ids and defect_workspace_id not in workspace_ids:
        raise HTTPException(404, "Defect not found in the active workspace")
    return obj


def _scoped_defects(db: Session, current_user: models.User):
    """Keep standalone and request-linked defects inside workspace/department scope.

    Direct ownership is authoritative. Request context is a compatibility
    fallback for historical rows; project visibility grants retain their
    existing access to linked defects.
    """
    q = (
        db.query(models.Defect)
        .outerjoin(models.QARequest, models.Defect.qa_request_id == models.QARequest.id)
        .outerjoin(models.TestCycle, models.Defect.cycle_id == models.TestCycle.id)
    )
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    project_ids = viewable_project_ids(db, current_user)
    if workspace_ids:
        q = q.filter(or_(
            func.coalesce(models.Defect.qa_workspace_id, models.QARequest.qa_workspace_id).in_(workspace_ids),
            models.TestCycle.project_id.in_(project_ids or []),
        ))
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = q.filter(or_(
            func.coalesce(models.Defect.department, models.QARequest.department).in_(scope),
            and_(models.Defect.assignee_id == current_user.id, models.Defect.assigned_team.in_(scope)),
            models.TestCycle.project_id.in_(project_ids or []),
        ))
    return q


def _can_touch_defect(db: Session, obj: models.Defect, user: models.User) -> bool:
    """Loophole fix: upload_attachments previously only blocked uploads once
    a defect was Closed -- it never checked WHO was uploading, unlike every
    sibling module's own _can_upload_documents (functional.py, sast_dast.py,
    performance.py, etc.), which all gate on the current stage's actual
    actor. True for anyone with a real stake in this specific defect: the
    reporter, current assignee, the assignee's Department Head, retest
    tester, or a manager. Department Heads need this access because they can
    now decide or reopen Rejected/Not a Defect outcomes and may need to provide
    the supporting evidence required by those decisions."""
    return (
        _is_manager(db, obj, user)
        or obj.reporter_id == user.id
        or obj.assignee_id == user.id
        or _is_assignee_department_head(db, obj, user)
        or obj.retest_tester_id == user.id
        or user.id in {obj.workflow_state.get('business_owner_id'), obj.workflow_state.get('release_owner_id')}
        or _can_assign(db, obj, user)
        or _can_defer(db, obj, user)
    )


def _is_manager(db: Session, obj: models.Defect, user: models.User) -> bool:
    # 2026-08 "Simplified Test Management" whole-module simplification: the
    # old per-project "Project Lead"/"Owner" TestProjectMember carve-out is
    # gone -- QA Lead Group system role (QA_LEAD/CHIEF_MANAGER_QA/AGM_QA,
    # matching the Executive bypass elsewhere -- ORACLE_MIGRATION_2026-07.md
    # section 59) is the sole "manager" authority now.
    return user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)


def _can_defer(db: Session, obj: models.Defect, user: models.User) -> bool:
    return _is_manager(db, obj, user) or user.has_role(Role.APPLICATION_OWNER)


def _can_assign(db: Session, obj: models.Defect, user: models.User) -> bool:
    """QA Engineers can route defects without inheriting lead-only decisions."""
    return user.has_role(Role.QA_ENGINEER) or _is_manager(db, obj, user)


def _is_assignee(obj: models.Defect, user: models.User) -> bool:
    return obj.assignee_id == user.id


def _qa_disposition_blocked_for_requester_assignment(
    obj: models.Defect,
    user: models.User,
    requested: str,
) -> bool:
    """Requester ownership prevents QA from closing the investigation path."""
    roles = set(user.roles or [])
    is_qa_user = bool(roles & _QA_DEFECT_ROLES) and Role.ADMIN not in roles
    return bool(
        requested in _REQUESTER_DISPOSITION_STATUSES
        and obj.assignee_is_requester
        and is_qa_user
    )


def _is_assignee_department_head(db: Session, obj: models.Defect, user: models.User) -> bool:
    """Return whether ``user`` heads any department of the current assignee.

    The assignee's live department memberships are authoritative because a
    defect can be routed outside the QA Request's department. Role mapping is
    shared with reassignment: QA departments use CHIEF_MANAGER_QA/AGM_QA;
    other departments use DEPARTMENT_HEAD_CM/DEPARTMENT_HEAD_AGM.
    """
    if not obj.assignee_id:
        return False
    assigned_user = db.get(models.User, obj.assignee_id)
    if not assigned_user:
        return False
    workspace_id = obj.qa_workspace_id or (obj.qa_request.qa_workspace_id if obj.qa_request else None)
    if set(assigned_user.roles) & _QA_DEFECT_ROLES:
        return user.has_qa_workspace_role(
            Role.CHIEF_MANAGER_QA, Role.AGM_QA,
            workspace_id=workspace_id,
        )
    departments = assigned_user.departments or ([obj.assigned_team] if obj.assigned_team else [])
    return any(
        department
        and user.has_department(department)
        and bool(set(user.roles) & set(reassignment.department_head_roles(department)))
        for department in departments
    )


def _valid_defect_reassignment_departments(obj: models.Defect, previous_assignee: Optional[models.User],
                                           new_assignee: models.User) -> set:
    """Destination departments shared by the allowed pool and target user.

    The allowed pool is the current assignee's teammate department(s) plus
    every configured QA/Test Management department. Returning the actual
    intersection also guarantees the persisted ``assigned_team`` belongs to
    the selected user.
    """
    previous_departments = set(previous_assignee.departments if previous_assignee else [])
    if not previous_departments and obj.assigned_team:
        previous_departments.add(obj.assigned_team)
    workspace_id = obj.qa_workspace_id or (obj.qa_request.qa_workspace_id if obj.qa_request else None)
    if new_assignee.has_qa_workspace_role(*_QA_DEFECT_ROLES, workspace_id=workspace_id):
        return set(new_assignee.departments)
    return previous_departments & set(new_assignee.departments)


def _is_tester(obj: models.Defect, user: models.User) -> bool:
    return user.id in {
        obj.retest_tester_id, obj.reporter_id,
        obj.execution.assigned_to_id if obj.execution else None,
    }


def _require_create_role(user: models.User) -> None:
    if not (user.has_role(*CREATE_ROLES) or user.has_role(Role.ADMIN)):
        raise HTTPException(403, "Your role is not authorized to report defects")


def _require_execution_link_access(db: Session, cycle: models.TestCycle, current_user: models.User) -> None:
    """Loophole fix: this check used to live only inside link_defect_execution
    -- but create_defect calls _link_to_execution directly too, whenever a
    caller supplies execution_id up front instead of linking afterwards, so
    that path attached the same execution/cycle/project traceability with
    NO authorization check at all. Shared by both call sites now so linking
    at creation time isn't a way to bypass this.

    CREATE_ROLES is broad (Requester/Business Analyst/Application Owner
    included, not just QA staff), so access needs their department scope to
    include this execution's own project -- same dashboard_department_scope
    semantics used everywhere else (QA/Security/Executive-COE roles and Admin
    stay unrestricted). 2026-08 whole-module simplification: the old
    "Tester/Project Lead/Owner member of THIS project acts regardless of
    department" TestProjectMember carve-out is gone -- QA staff already get
    the equivalent unrestricted access here via dashboard_department_scope's
    own QA/Security/Executive-COE carve-out, so no separate escape hatch is
    needed now that project membership itself is no longer assigned."""
    if not current_user.has_role(*CREATE_ROLES):
        raise HTTPException(403, "You are not authorized to link defects in this Test Cycle")
    scope = dashboard_department_scope(current_user)
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    project_workspace_id = cycle.origin_workspace_id or (cycle.project.qa_workspace_id if cycle.project else None)
    if workspace_ids and project_workspace_id not in workspace_ids:
        raise HTTPException(404, "Test Cycle not found in the active workspace")
    project_department = cycle.project.department if cycle.project else None
    if scope and project_department and project_department not in scope:
        raise HTTPException(403, "You can only link defects to Test Cycles in your own department.")


def _audit(db: Session, obj: models.Defect, user: models.User, decision: str,
           comments: str, previous_state: Optional[str] = None,
           new_state: Optional[str] = None, step_name: str = "Workflow") -> None:
    db.add(models.ApprovalAction(
        entity_type="DEFECT", entity_id=obj.id, step_name=step_name,
        actor_id=user.id, actor_role=user.roles_csv, decision=decision,
        comments=comments, previous_state=previous_state, new_state=new_state,
    ))


def _required(value, label: str):
    if value is None or (isinstance(value, str) and not value.strip()):
        raise HTTPException(400, f"{label} is required")
    return value.strip() if isinstance(value, str) else value


def _execution_context(db: Session, execution_id: int, request: Optional[models.QARequest]):
    execution = db.get(models.TestExecution, execution_id)
    if not execution or not execution.cycle or not execution.test_case:
        raise HTTPException(404, "Test Execution, Test Cycle, or Test Case was not found")
    cycle, test_case = execution.cycle, execution.test_case
    if execution.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can be linked only to a Failed or Blocked Test Execution")
    linked_request = cycle.child_request_link
    if linked_request:
        child_model = {
            "Functional": models.FunctionalRequest, "SAST": models.SASTRequest,
            "DAST": models.DASTRequest, "Performance": models.PerformanceRequest,
        }.get(linked_request.child_type)
        child = db.get(child_model, linked_request.child_id) if child_model else None
        if request and child and child.qa_request_id and child.qa_request_id != request.id:
            raise HTTPException(400, "This execution's Test Cycle is linked to a different QA Request")
    return execution, cycle, test_case


def _ensure_case_link(db: Session, defect_id: int, test_case_id: int) -> None:
    """Bug fix (ORA-00001 on UQ_QAP_DEF_CASE): add a DefectTestCaseLink for
    (defect_id, test_case_id) unless one already exists. `SessionLocal` is
    configured with autoflush=False (database.py), so a plain DB query alone
    misses a link that was `db.add()`-ed earlier in the very same request but
    never flushed -- that's exactly what create_defect used to do: its own
    case_ids loop added the primary test case's link, then immediately called
    _link_to_execution, whose "does a link already exist?" query ran against
    the DB only, didn't see its own session's pending insert, and added a
    byte-for-byte duplicate. Both pending rows then landed in the same
    executemany at flush/commit time and violated the unique constraint. This
    helper checks the session's own pending (`db.new`) objects first, so it's
    safe to call more than once for the same (defect_id, test_case_id) within
    one request regardless of flush timing, in addition to the DB check that
    still catches a link created in an earlier, already-committed request."""
    already_pending = any(
        isinstance(pending, models.DefectTestCaseLink)
        and pending.defect_id == defect_id and pending.test_case_id == test_case_id
        for pending in db.new
    )
    if already_pending:
        return
    existing = db.query(models.DefectTestCaseLink).filter_by(
        defect_id=defect_id, test_case_id=test_case_id,
    ).first()
    if not existing:
        db.add(models.DefectTestCaseLink(defect_id=defect_id, test_case_id=test_case_id))


def _ensure_execution_link(db: Session, defect_id: int, execution_id: int) -> None:
    """Same autoflush=False caution as _ensure_case_link above -- add a
    DefectExecutionLink for (defect_id, execution_id) unless one already
    exists, checking the session's own pending inserts first (in case one
    was just added earlier in this same request) and then the DB."""
    already_pending = any(
        isinstance(pending, models.DefectExecutionLink)
        and pending.defect_id == defect_id and pending.execution_id == execution_id
        for pending in db.new
    )
    if already_pending:
        return
    existing = db.query(models.DefectExecutionLink).filter_by(
        defect_id=defect_id, execution_id=execution_id,
    ).first()
    if not existing:
        db.add(models.DefectExecutionLink(defect_id=defect_id, execution_id=execution_id))


def _link_run_defect(db: Session, obj: models.Defect, execution: models.TestExecution, user: models.User) -> None:
    """Attaches obj's defect_key to `execution`'s latest attempt
    (TestRunDefect) -- shared by both _link_to_execution (primary link) and
    _link_additional_execution below, so the attempt-level traceability rule
    (at most one defect per attempt; a fresh retest attempt can carry a
    different one) applies uniformly regardless of which kind of link this
    is. TestRunDefect's own uniqueness is per (run_id, defect_key), not per
    defect globally, so the same defect_key linking to a DIFFERENT
    execution's run here was already unproblematic at this layer -- the
    only thing that used to block it was Defect.execution_id's own single-
    primary-execution guard in the two callers below."""
    latest_run = execution.runs[-1] if execution.runs else None
    if not latest_run:
        raise HTTPException(400, "The Failed or Blocked execution has no recorded attempt to link")
    # Reported directly: "testcase already failed, and defect also linked,
    # then why again allowing to marked failed" -- clarified to mean linking
    # a SECOND, separate defect to the same already-linked attempt (a fresh
    # 'Fail' attempt after retesting is still fine and expected). Was
    # previously only checked per (run_id, defect_key), which allowed a
    # different defect to be linked to the same attempt without limit -- see
    # test_execution.py::_link_defect's matching fix for the free-text/
    # "Link existing"/"Link external" paths.
    existing_run_link = db.query(models.TestRunDefect).filter_by(run_id=latest_run.id).first()
    if existing_run_link and existing_run_link.defect_key != obj.defect_key:
        raise HTTPException(
            400,
            f"Attempt #{latest_run.attempt_no} already has defect '{existing_run_link.defect_key}' linked -- "
            "record a new attempt (retest) instead of linking a second defect to the same one.",
        )
    if not existing_run_link:
        db.add(models.TestRunDefect(
            run_id=latest_run.id, defect_key=obj.defect_key,
            defect_url=f"/defects?open={obj.defect_key}", title=obj.title,
            defect_status=obj.status, linked_by_id=user.id, notes="Governed portal defect",
        ))


def _link_to_execution(db: Session, obj: models.Defect, execution: models.TestExecution,
                       cycle: models.TestCycle, test_case: models.TestCase,
                       user: models.User) -> None:
    """Sets `execution` as obj's PRIMARY execution -- only ever called when
    obj has no primary execution yet, or `execution` already IS its primary
    (idempotent re-link); see link_defect_execution's own branch below for
    the "already primary-linked elsewhere" case, which goes to
    _link_additional_execution instead rather than raising 400 as this used
    to unconditionally."""
    obj.execution_id = execution.id
    obj.cycle_id = cycle.id
    obj.primary_test_case_id = test_case.id
    obj.retest_tester_id = obj.retest_tester_id or execution.assigned_to_id or user.id
    _ensure_case_link(db, obj.id, test_case.id)
    _link_run_defect(db, obj, execution, user)


def _link_additional_execution(db: Session, obj: models.Defect, execution: models.TestExecution,
                               cycle: models.TestCycle, test_case: models.TestCase,
                               user: models.User) -> None:
    """Reported directly: the "Link existing defect" picker used to only
    offer never-linked defects -- "instead of [unlinked only], show linked
    defect as well." Traces this SAME governed defect to a second (or
    third...) Failed/Blocked execution -- e.g. the same underlying bug also
    failed a different test case -- WITHOUT touching obj.execution_id/
    cycle_id/primary_test_case_id (its one primary execution, which keeps
    governing assignment/closure/retest workflow exactly as before). Only a
    DefectExecutionLink row is added, mirroring _ensure_case_link's own
    "primary field + separate many-to-many table" pattern for extra test
    cases."""
    _ensure_execution_link(db, obj.id, execution.id)
    _ensure_case_link(db, obj.id, test_case.id)
    _link_run_defect(db, obj, execution, user)


_TERMINAL_STATUSES = ("Closed", "Rejected", "Duplicate", "Not a Defect")
_ATTENTION_SEVERITIES = ("Critical", "High")
_RETEST_STATUSES = ("Resolved", "Retest", "Ready for QA", "QA Testing", "Business Acceptance", "Production Verification")

# SRS 7.2 pagination rollout -- every field the register table, the queue
# tabs, and every other module's own defect pickers need off a row, without
# lazy-loading `reporter_name`/`assignee_name`/`qa_request_key`/`cycle_key`/
# `test_case_key` (all `@property`s on `models.Defect`) once per row.
_LIST_DEFECT_EAGER_LOADS = [
    joinedload(models.Defect.qa_request), joinedload(models.Defect.cycle),
    joinedload(models.Defect.primary_test_case), joinedload(models.Defect.reporter),
    joinedload(models.Defect.assignee), joinedload(models.Defect.execution),
    selectinload(models.Defect.execution_links)
        .joinedload(models.DefectExecutionLink.execution)
        .joinedload(models.TestExecution.test_case),
    selectinload(models.Defect.execution_links)
        .joinedload(models.DefectExecutionLink.execution)
        .joinedload(models.TestExecution.cycle),
]


@router.get("", response_model=pagination.Page[schemas.DefectListOut])
def list_defects(severity: Optional[str] = None,
                 priority: Optional[str] = None, cycle_id: Optional[int] = None,
                 test_case_id: Optional[int] = None, execution_id: Optional[int] = None,
                 qa_request_id: Optional[int] = None, assignee_id: Optional[int] = None,
                 reporter_id: Optional[int] = None,
                 queue: Optional[str] = Query(
                     None, description="'attention'|'mine'|'unlinked'|'incomplete-traceability'|'retest'|'closed', omitted for all -- "
                                        "matches Defects.tsx's own queue tabs exactly",
                 ),
                 params: pagination.PageParams = Depends(),
                 db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    # Severity and entity IDs remain single-value exact filters. Status uses
    # PageParams.status exclusively because it deliberately accepts repeated
    # query parameters (status=New&status=Triaged&...), including the Test
    # Execution picker that needs every non-terminal workflow state.
    q = _scoped_defects(db, current_user).options(*_LIST_DEFECT_EAGER_LOADS)
    for column, value in (
        (models.Defect.severity, severity), (models.Defect.priority, priority),
        (models.Defect.qa_request_id, qa_request_id),
        (models.Defect.assignee_id, assignee_id), (models.Defect.reporter_id, reporter_id),
    ):
        if value is not None:
            q = q.filter(column == value)
    # A governed defect keeps one primary execution on qap_defects and any
    # further affected testcase executions in qap_defect_execution_links.
    # List filters must search both paths; otherwise the additional link is
    # saved successfully but disappears from the second cycle's defect list,
    # completion checks, and execution-scoped views.
    if cycle_id is not None:
        q = q.filter(or_(
            models.Defect.cycle_id == cycle_id,
            models.Defect.execution_links.any(
                models.DefectExecutionLink.execution.has(models.TestExecution.cycle_id == cycle_id)
            ),
        ))
    if execution_id is not None:
        q = q.filter(or_(
            models.Defect.execution_id == execution_id,
            models.Defect.execution_links.any(models.DefectExecutionLink.execution_id == execution_id),
        ))
    if test_case_id is not None:
        q = q.join(models.DefectTestCaseLink).filter(models.DefectTestCaseLink.test_case_id == test_case_id)
    if queue == "attention":
        q = q.filter(models.Defect.severity.in_(_ATTENTION_SEVERITIES)).filter(models.Defect.status.notin_(_TERMINAL_STATUSES))
    elif queue == "mine":
        q = q.filter(or_(models.Defect.assignee_id == current_user.id, models.Defect.reporter_id == current_user.id))
    elif queue == "unlinked":
        q = q.filter(models.Defect.execution_id.is_(None), ~models.Defect.execution_links.any())
    elif queue == "incomplete-traceability":
        # Additional execution links also establish traceability. Request,
        # cycle or testcase links alone do not establish an execution trail.
        q = q.filter(models.Defect.execution_id.is_(None), ~models.Defect.execution_links.any())
    elif queue == "retest":
        q = q.filter(models.Defect.status.in_(_RETEST_STATUSES))
    elif queue == "closed":
        q = q.filter(models.Defect.status == "Closed")
    q = pagination.apply_search(
        q, params, models.Defect.defect_key, models.Defect.title, models.Defect.application_name,
        models.Defect.module_feature,
    )
    q = pagination.apply_status_filter(q, params, models.Defect.status)
    q = pagination.apply_sort(
        q, params, sortable={
            "defect_key": models.Defect.defect_key, "severity": models.Defect.severity,
            "priority": models.Defect.priority, "status": models.Defect.status,
            "reported_at": models.Defect.reported_at,
        }, default_column=models.Defect.created_at, id_column=models.Defect.id,
    )
    result = pagination.paginate(q, params)
    return pagination.to_page_response(result, params)


@router.get("/dashboard", response_model=schemas.DefectDashboardOut)
def defect_dashboard(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # SRS 7.2 pagination rollout -- previously fetched every scoped defect's
    # full ORM row into Python just to run Counter() over it, an unbounded
    # fetch that grew with the register regardless of how many rows anyone
    # was actually looking at. by_status/by_severity/by_priority/
    # by_application/by_assignee are now real SQL `GROUP BY` aggregates
    # (never a full-row fetch), matching TestCaseSummaryOut/
    # TestExecutionSummaryOut's own pattern from the Test Management slice.
    base = _scoped_defects(db, current_user)

    by_status = Counter(dict(base.with_entities(models.Defect.status, func.count(models.Defect.id)).group_by(models.Defect.status).all()))
    by_severity = Counter(dict(base.with_entities(models.Defect.severity, func.count(models.Defect.id)).group_by(models.Defect.severity).all()))
    by_priority = Counter(dict(base.with_entities(models.Defect.priority, func.count(models.Defect.id)).group_by(models.Defect.priority).all()))
    by_application = Counter(dict(base.with_entities(models.Defect.application_name, func.count(models.Defect.id)).group_by(models.Defect.application_name).all()))
    # assignee_name is a Python @property (reads .assignee.full_name), not a
    # real column -- group by the delegated User.full_name via a join
    # instead, coalescing NULL (unassigned) the same way the old Counter
    # default did.
    # Built once and reused in both with_entities and group_by below -- two
    # separately-constructed func.coalesce(...) calls compile to two distinct
    # bind parameters for the "Unassigned" literal (:coalesce_2, :coalesce_3
    # etc.), and Oracle then fails ORA-00979 ("must appear in the GROUP BY
    # clause") because it doesn't recognize the GROUP BY expression as the
    # same one used in SELECT even though both evaluate identically. Reusing
    # the same expression object keeps them as one bind param, which Oracle
    # (and every other dialect) accepts.
    assignee_label = func.coalesce(models.User.full_name, "Unassigned")
    assignee_rows = (
        base.outerjoin(models.User, models.Defect.assignee_id == models.User.id)
        .with_entities(assignee_label, func.count(models.Defect.id))
        .group_by(assignee_label).all()
    )
    by_assignee = Counter(dict(assignee_rows))
    total = sum(by_status.values())

    # Ageing buckets and the monthly closure trend both need a date
    # computation per row that doesn't translate cleanly across this app's
    # supported DB dialects (SQLite locally, Oracle in production) -- kept
    # in Python, but selecting only the two date columns needed rather than
    # hydrating full Defect ORM objects (avoids every joined/property field
    # + the eager-loads a plain `.all()` on `base` would otherwise pull in).
    today = models.now().date()
    by_ageing = Counter()
    closure_trend = Counter()
    for reported_at, closed_at in base.with_entities(models.Defect.reported_at, models.Defect.closed_at).all():
        age = max(0, (today - reported_at.date()).days)
        by_ageing["0–7 days" if age <= 7 else "8–14 days" if age <= 14 else "15–30 days" if age <= 30 else "31+ days"] += 1
        if closed_at:
            closure_trend[closed_at.strftime("%Y-%m")] += 1

    # SRS 7.2 pagination rollout -- back Defects.tsx's queue tabs, which used
    # to be `.filter().length` over the whole unpaginated list. retest_count
    # is free (sum of two already-grouped by_status buckets); the other
    # three are compound conditions a single-column GROUP BY can't answer,
    # so each gets its own indexed COUNT.
    attention_count = base.filter(
        models.Defect.severity.in_(_ATTENTION_SEVERITIES), models.Defect.status.notin_(_TERMINAL_STATUSES),
    ).with_entities(func.count(models.Defect.id)).scalar() or 0
    mine_count = base.filter(
        or_(models.Defect.assignee_id == current_user.id, models.Defect.reporter_id == current_user.id),
    ).with_entities(func.count(models.Defect.id)).scalar() or 0
    unlinked_count = base.filter(models.Defect.execution_id.is_(None), ~models.Defect.execution_links.any()).with_entities(func.count(models.Defect.id)).scalar() or 0
    retest_count = sum(by_status.get(s, 0) for s in _RETEST_STATUSES)

    return {
        "total": total, "open": sum(v for k, v in by_status.items() if k not in _TERMINAL_STATUSES),
        "closed": by_status["Closed"], "reopened": by_status["Reopened"], "deferred": by_status["Deferred"],
        "attention_count": attention_count, "mine_count": mine_count,
        "unlinked_count": unlinked_count, "retest_count": retest_count,
        "by_status": dict(by_status), "by_severity": dict(by_severity), "by_priority": dict(by_priority),
        "by_application": dict(by_application), "by_assignee": dict(by_assignee),
        "by_ageing": dict(by_ageing), "closure_trend": dict(sorted(closure_trend.items())),
    }


@router.get("/export-xlsx")
def export_defects(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Export the governed defect register with workflow and traceability fields."""
    defects = _scoped_defects(db, current_user).order_by(models.Defect.created_at.desc()).all()
    status_counts = Counter(item.status for item in defects)
    workbook = new_workbook()
    add_summary_sheet(
        workbook, "Defect Management Register",
        "Governed defects linked to QA requests, test cycles, test cases, and executions.",
        [("Generated at", models.now()), ("Generated by", current_user.full_name)],
        [
            ("Total defects", len(defects)),
            ("Open defects", sum(v for k, v in status_counts.items() if k not in {"Closed", "Rejected", "Duplicate", "Not a Defect"})),
            ("Closed defects", status_counts["Closed"]),
            ("Reopened defects", status_counts["Reopened"]),
            ("Deferred defects", status_counts["Deferred"]),
        ],
    )
    headers = [
        "Defect ID", "Title", "QA Request", "Test Cycle", "Test Case", "Application",
        "Project", "Module", "Status", "Severity", "Priority", "Environment", "Assignee",
        "Reporter", "Created", "Target Release", "Expected Resolution", "Ageing (Days)",
        "Reopen Count", "External Defect ID", "Resolution Type", "Resolution Summary",
        "Workflow Version", "Production Impact", "Affected Environments", "Verified Builds",
    ]
    today = models.now().date()
    rows = []
    for item in defects:
        rows.append([
            item.defect_key, item.title, item.qa_request_key, item.cycle_key, item.test_case_key,
            item.application_name, item.cycle.project.project_key if item.cycle and item.cycle.project else None,
            item.module_feature, item.status, item.severity, item.priority, item.environment,
            item.assignee_name, item.reporter_name, item.reported_at, item.target_release,
            item.expected_resolution_date, max(0, (today - item.reported_at.date()).days),
            item.reopen_count, item.external_defect_id, item.resolution_type, item.resolution_summary,
            item.workflow.get("version") if item.workflow else "Legacy",
            item.workflow_state.get("production_impact", "Not recorded"),
            ", ".join(sorted({e["environment"] for e in item.workflow_state.get("occurrences", [])})),
            ", ".join(f"{v['environment']}: {v['build']}" for v in item.verified_builds),
        ])
    add_table_sheet(
        workbook, "Defects", "Defect Register", headers, rows,
        wrap_headers={"Title", "Resolution Summary"}, date_headers={"Created"},
        date_only_headers={"Expected Resolution"}, status_headers={"Status"},
    )
    return workbook_response(workbook, "defect-management-register.xlsx")


@router.get("/by-key/{defect_key}", response_model=schemas.DefectOut)
def get_defect_by_key(defect_key: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """SRS 7.2 pagination rollout -- Defects.tsx's own `?open=<defect_key>`
    deep-link (used both for Global Search and for the create-defect flow's
    own "open what was just created" step) used to resolve against the
    complete, unpaginated in-browser list; now that the list is paginated,
    this mirrors test_repository.py's `/test-cases/by-key/{key}` pattern
    instead. Must stay above `/{defect_id}` so FastAPI doesn't try to parse
    the literal `by-key` segment as an integer id."""
    obj = _scoped_defects(db, current_user).filter(
        models.Defect.defect_key == defect_key.strip().upper()
    ).first()
    if not obj:
        raise HTTPException(404, f"Defect {defect_key} was not found")
    return obj


@router.get("/{defect_id}", response_model=schemas.DefectOut)
def get_defect(defect_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_visible(defect_id, db, current_user)


def _require_request_access(db, request, user):
    from ..workspace_service import require_active_workspace, selectable_workspace_ids
    workspace_id = require_active_workspace(user)
    workspace_ids = active_qa_workspace_scope_ids(user) or (workspace_id,)
    if request.qa_workspace_id not in workspace_ids or request.qa_workspace_id not in selectable_workspace_ids(db, user):
        raise HTTPException(404, "QA Request was not found in the active workspace")
    scope = dashboard_department_scope(user)
    if scope is not None and request.department not in scope:
        raise HTTPException(403, "Select a QA Request from your department")


def _creation_context(db, user, payload, request=None, cycle=None):
    """Resolve ownership independently of the optional request relationship."""
    from ..workspace_service import require_active_workspace, selectable_workspace_ids
    selected_workspace = require_active_workspace(user)
    project = cycle.project if cycle else None
    workspace_id = (request.qa_workspace_id if request else None) or ((cycle.origin_workspace_id or project.qa_workspace_id) if cycle and project else None) or selected_workspace
    permitted = active_qa_workspace_scope_ids(user) or (selected_workspace,)
    if workspace_id not in permitted or workspace_id not in selectable_workspace_ids(db, user):
        raise HTTPException(403, "Select an accessible workspace before raising a defect")
    if cycle and (cycle.origin_workspace_id or project.qa_workspace_id) != workspace_id:
        raise HTTPException(400, "Request and execution must belong to the same workspace")
    workspace = db.get(models.QAWorkspace, workspace_id)
    if not workspace or not workspace.is_active:
        raise HTTPException(400, "Select an active workspace")
    department = _required((request.department if request else None) or (project.department if project else None)
                           or payload.department or user.department, "Department")
    scope = dashboard_department_scope(user)
    if scope is not None and department not in scope:
        raise HTTPException(403, "You can only raise defects for your department")
    if not db.query(models.Department).filter(models.Department.name == department, models.Department.is_active == True).first():
        raise HTTPException(400, "Select an active department")
    project_application = project.application_master.name if project and project.application_master else None
    application = _required((request.application_name if request else None) or project_application or payload.application_name, "Application")
    if request and project_application and application.casefold() != project_application.casefold():
        raise HTTPException(400, "Request and execution must belong to the same application")
    return workspace_id, department, application


@router.post("", response_model=schemas.DefectOut)
def create_defect(payload: schemas.DefectCreate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    _require_create_role(current_user)
    request = db.get(models.QARequest, payload.qa_request_id) if payload.qa_request_id else None
    if payload.qa_request_id is not None and request is None:
        raise HTTPException(404, "QA Request was not found")
    if request:
        _require_request_access(db, request, current_user)
    link_values = (payload.execution_id, payload.cycle_id, payload.test_case_id)
    if any(value is not None for value in link_values) and not all(value is not None for value in link_values):
        raise HTTPException(400, "Execution, Test Cycle, and Test Case must be supplied together, or all left blank")
    execution = cycle = test_case = None
    if payload.execution_id is not None:
        execution, cycle, test_case = _execution_context(db, payload.execution_id, request)
        _require_execution_link_access(db, cycle, current_user)
        if payload.cycle_id != cycle.id or payload.test_case_id != test_case.id:
            raise HTTPException(400, "Test Execution must belong to the selected Test Cycle and Test Case")
    workspace_id, department, application_name = _creation_context(db, current_user, payload, request, cycle)
    if payload.severity not in SEVERITIES:
        raise HTTPException(400, "Select a valid severity")
    if payload.priority not in PRIORITIES:
        raise HTTPException(400, "Select a valid priority")
    if payload.environment not in ENVIRONMENTS:
        raise HTTPException(400, "Select a valid environment")
    case_ids = list(dict.fromkeys(([payload.test_case_id] if payload.test_case_id else []) + payload.test_case_ids))
    if case_ids and not cycle:
        raise HTTPException(400, "Affected Test Cases can be selected after the defect is linked to a Test Cycle")
    linked_cases = db.query(models.TestCase).filter(models.TestCase.id.in_(case_ids)).all() if case_ids else []
    if cycle and (len(linked_cases) != len(case_ids) or any(case.project_id != cycle.project_id for case in linked_cases)):
        raise HTTPException(400, "Every linked Test Case must belong to the Test Cycle's project")
    obj = models.Defect(
        defect_key=models.gen_defect_id(db), title=_required(payload.title, "Defect Title"),
        description=_required(payload.description, "Description"), qa_request_id=request.id if request else None,
        qa_workspace_id=workspace_id, department=department,
        cycle_id=cycle.id if cycle else None, primary_test_case_id=test_case.id if test_case else None,
        execution_id=execution.id if execution else None,
        application_name=application_name, module_feature=_required(payload.module_feature, "Module/Feature"),
        environment=_required(payload.environment, "Environment"), severity=payload.severity,
        priority=payload.priority, steps_to_reproduce=_required(payload.steps_to_reproduce, "Steps to Reproduce"),
        expected_result=_required(payload.expected_result, "Expected Result"),
        actual_result=_required(payload.actual_result, "Actual Result"), reporter_id=current_user.id,
        retest_tester_id=payload.retest_tester_id or (execution.assigned_to_id if execution else None) or current_user.id,
        device_details=payload.device_details,
        build_version=payload.build_version or (cycle.build if cycle else None) or (request.build_number if request else None), api_endpoint=payload.api_endpoint,
        request_response_details=payload.request_response_details, log_details=payload.log_details,
        related_cr_number=payload.related_cr_number or (request.cr_number if request else None),
        external_defect_id=payload.external_defect_id, remarks=payload.remarks, labels=payload.labels,
    )
    workspace = db.get(models.QAWorkspace, workspace_id)
    obj.workflow_json = json.dumps(policy(workspace.defect_workflow_json if workspace else None))
    obj.workflow_state_json = json.dumps({"production_impact": "Affected" if obj.environment == "Production" else "Unknown", "iteration": 0, "history": [], "occurrences": [{"environment": obj.environment, "build": obj.build_version, "remarks": "Original report"}]})
    db.add(obj); db.flush()
    for case_id in case_ids:
        _ensure_case_link(db, obj.id, case_id)
    if execution and cycle and test_case:
        _link_to_execution(db, obj, execution, cycle, test_case, current_user)
    _audit(db, obj, current_user, "Created", f"Reported {obj.defect_key} with {obj.severity} severity and {obj.priority} priority.", new_state="New", step_name="Defect")
    db.commit(); db.refresh(obj)
    return obj


@router.post("/{defect_id}/link-execution", response_model=schemas.DefectOut)
def link_defect_execution(defect_id: int, payload: schemas.DefectLinkExecution,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    obj = _get_mutable(defect_id, db, current_user)
    if obj.status in {"Closed", "Rejected", "Duplicate", "Not a Defect"}:
        raise HTTPException(400, f"A {obj.status} defect cannot be linked to a new execution")
    execution, cycle, test_case = _execution_context(db, payload.execution_id, obj.qa_request)
    if obj.qa_workspace_id and (cycle.origin_workspace_id or cycle.project.qa_workspace_id) != obj.qa_workspace_id:
        raise HTTPException(400, "Test execution must belong to the defect workspace")
    if cycle.project.application_master and cycle.project.application_master.name.casefold() != obj.application_name.casefold():
        raise HTTPException(400, "Test execution must belong to the defect application")
    _require_execution_link_access(db, cycle, current_user)
    if obj.execution_id and obj.execution_id != execution.id:
        # Already has a DIFFERENT primary execution -- add this as an
        # additional link instead of the 400 this used to always raise.
        _link_additional_execution(db, obj, execution, cycle, test_case, current_user)
        _audit(db, obj, current_user, "Linked",
               f"Also linked to {cycle.cycle_key} / {test_case.test_case_key} / execution #{execution.id} "
               "(primary execution unchanged).", step_name="Traceability")
    else:
        _link_to_execution(db, obj, execution, cycle, test_case, current_user)
        _audit(db, obj, current_user, "Linked", f"Linked to {cycle.cycle_key} / {test_case.test_case_key} / execution #{execution.id}.", step_name="Traceability")
    db.commit(); db.refresh(obj)
    return obj


@router.patch("/{defect_id}", response_model=schemas.DefectOut)
def update_defect(defect_id: int, payload: schemas.DefectUpdate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    obj = _get_mutable(defect_id, db, current_user)
    manager = _is_manager(db, obj, current_user)
    if obj.status != "New":
        raise HTTPException(400, "Only a New defect can be edited. Use workflow actions for later changes")
    if not manager and obj.reporter_id != current_user.id:
        raise HTTPException(403, "Only the reporter, QA Lead group, or Administrator can edit a New defect")
    data = payload.model_dump(exclude_unset=True)
    if ("severity" in data or "priority" in data) and not manager:
        raise HTTPException(403, "Only an authorized lead can change severity or priority after submission")
    if data.get("severity") and data["severity"] not in SEVERITIES:
        raise HTTPException(400, "Select a valid severity")
    if data.get("priority") and data["priority"] not in PRIORITIES:
        raise HTTPException(400, "Select a valid priority")
    if data.get("environment") and data["environment"] not in ENVIRONMENTS:
        raise HTTPException(400, "Select a valid environment")
    if obj.workflow_json and "environment" in data and data["environment"] != obj.environment:
        raise HTTPException(400, "Reported environment is preserved; record another occurrence instead")
    changes = []
    for field, value in data.items():
        old = getattr(obj, field)
        if old != value:
            setattr(obj, field, value)
            changes.append(f"{field.replace('_', ' ').title()}: {old or '—'} → {value or '—'}")
    if changes:
        _audit(db, obj, current_user, "Updated", "\n".join(changes), step_name="Fields")
    db.commit(); db.refresh(obj)
    return obj


@router.post("/{defect_id}/transition", response_model=schemas.DefectOut)
def transition_defect(defect_id: int, payload: schemas.DefectTransition, db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    obj = _get_mutable(defect_id, db, current_user)
    if obj.workflow_json:
        raise HTTPException(400, "Use the versioned workspace workflow actions for this defect")
    requested = payload.status
    if requested not in STATUSES or requested not in TRANSITIONS.get(obj.status, set()):
        raise HTTPException(400, f"Invalid status transition. Defect {obj.defect_key} cannot be changed from {obj.status} to {requested}.")
    manager = _is_manager(db, obj, current_user)
    assignee = _is_assignee(obj, current_user)
    tester = _is_tester(obj, current_user)
    requester_owns_assignment = obj.assignee_is_requester
    if _qa_disposition_blocked_for_requester_assignment(obj, current_user, requested):
        raise HTTPException(
            403,
            "Rejected, Duplicate, and Not a Defect are controlled by the requester side while the defect is assigned to a Requester.",
        )
    # Triage now includes selecting the working owner. Assignment is an
    # attribute of the defect rather than a separate lifecycle state, so
    # only actors trusted to route work may complete this transition.
    if requested == "Triaged" and not _can_assign(db, obj, current_user):
        raise HTTPException(403, "Only a QA Engineer, QA Lead group member, or Administrator can triage and assign a defect")
    if requested == "Assigned" and not _can_assign(db, obj, current_user):
        raise HTTPException(403, "Only a QA Engineer, QA Lead group member, or Administrator can assign a defect")
    if requested in {"Rejected", "Duplicate"} and not (
        manager or obj.reporter_id == current_user.id or assignee
        or _is_assignee_department_head(db, obj, current_user)
    ):
        raise HTTPException(
            403,
            "Only the Defect Reporter, current assignee, the Department Head of the assignee, "
            "a QA Lead, or an Administrator can perform this action",
        )
    if requested == "Not a Defect" and not (
        (requester_owns_assignment and (
            assignee
            or _is_assignee_department_head(db, obj, current_user)
            or Role.ADMIN in set(current_user.roles or [])
        ))
        or (not requester_owns_assignment and (manager or obj.reporter_id == current_user.id))
    ):
        raise HTTPException(
            403,
            "Only the responsible requester side, or the Defect Reporter/QA Lead before requester assignment, can mark this as Not a Defect",
        )
    if requested == "Deferred" and not _can_defer(db, obj, current_user):
        raise HTTPException(403, "Only a QA Lead group member, Application Owner, or Administrator can defer a defect")
    if requested in {"In Progress", "Resolved"} and not (assignee or manager):
        raise HTTPException(403, "Only the assigned user or an authorized lead can perform this action")
    if requested in {"Retest", "Closed"} and not (tester or manager):
        raise HTTPException(403, "Only the assigned tester or an authorized lead can perform this action")
    if requested == "Reopened":
        # Reported directly: the reporter should also be able to reopen a
        # Closed defect (e.g. they find it still reproduces), not just a
        # lead -- previously only QA_LEAD/CHEIF_MANAGER_QA (Admin bypasses
        # has_role regardless) could reopen once Closed. Deliberately scoped
        # to just the reporter, not the full _is_tester set (retest_tester/
        # execution's assigned runner) -- those roles are specific to one
        # retest cycle and may no longer be current by the time a Closed
        # defect resurfaces, whereas the reporter is who'd actually notice.
        if obj.status == "Closed" and not (manager or obj.reporter_id == current_user.id):
            raise HTTPException(403, "Only the reporter, QA Lead group, or Administrator can reopen a Closed defect")
        if obj.status == "Retest" and not (tester or manager):
            raise HTTPException(403, "Only the assigned tester or an authorized lead can reopen this defect")
        if obj.status in {"Rejected", "Not a Defect"} and not (
            manager or obj.reporter_id == current_user.id or assignee
            or _is_assignee_department_head(db, obj, current_user)
        ):
            raise HTTPException(
                403,
                "Only the Defect Reporter, current assignee, the Department Head of the assignee, "
                "a QA Lead, or an Administrator can reopen this defect decision",
            )

    previous = obj.status
    remarks = (payload.remarks or "").strip()
    if requested in {"Triaged", "Assigned"}:
        assignee_id = _required(payload.assignee_id, "Assignee")
        assignee_user = db.get(models.User, assignee_id)
        if not assignee_user or not assignee_user.is_active:
            raise HTTPException(404, "Selected assignee was not found or is inactive")
        if not assignee_user.show_in_user_dropdowns:
            raise HTTPException(400, "The selected user is hidden from assignment dropdowns")
        assigned_department = _required(
            payload.assigned_team or (obj.qa_request.department if obj.qa_request else None),
            "Department",
        )
        department = db.query(models.Department).filter(
            models.Department.name == assigned_department,
            models.Department.is_active == True,  # noqa: E712
        ).first()
        if not department:
            raise HTTPException(400, "Select a valid active Department")
        if not assignee_user.has_department(department.name):
            raise HTTPException(400, "The selected assignee does not belong to the selected Department")
        previous_assignee_id = obj.assignee_id
        previous_assignee = obj.assignee_name
        previous_assigned_at = obj.assigned_at
        obj.assignee_id = assignee_user.id; obj.assigned_team = department.name
        obj.assigned_by_id = current_user.id; obj.assigned_at = models.now(); obj.assignment_remarks = remarks or None
        reassignment.record_assignment_change(
            db, "DEFECT", obj.id, "DEFECT_ASSIGNEE", current_user,
            [previous_assignee_id], [assignee_user.id], remarks,
            previous_assigned_at=previous_assigned_at,
        )
        details = f"Triaged and assigned to {assignee_user.full_name} ({department.name})" if requested == "Triaged" else f"Assigned to {assignee_user.full_name} ({department.name})"
        if previous_assignee: details += f"; previous assignee: {previous_assignee}"
        # 2026-08 -- reported directly: "whenever assigning defect to
        # requester, system asking for remark, that remark not showing any
        # where in the ui." The remark was already saved to
        # obj.assignment_remarks, but that column was never rendered
        # anywhere on the frontend, and it wasn't folded into the audit
        # trail `details` text either (unlike every other transition, e.g.
        # Retest's `details = remarks or "Retesting started."`) -- so it was
        # captured but genuinely invisible. Appending it here surfaces it
        # immediately in the existing Activity feed (DefectDetail ->
        # JiraActivity, GET /api/approvals?entity_type=DEFECT&entity_id=...)
        # without waiting on a schema/frontend round-trip; it's also now
        # rendered as its own labelled field (see DefectOut.assignment_remarks
        # + Defects.tsx's Workflow Details section).
        if remarks: details += f" -- {remarks}"
    elif requested == "Resolved":
        if payload.resolution_type not in RESOLUTION_TYPES:
            raise HTTPException(400, "Select a valid Resolution Type")
        obj.resolution_type = payload.resolution_type
        obj.resolution_summary = _required(payload.resolution_summary, "Resolution Summary")
        obj.root_cause = _required(payload.root_cause, "Root Cause")
        obj.fix_details = _required(payload.fix_details, "Fix Details")
        obj.fixed_build_version = _required(payload.fixed_build_version, "Fixed Build/Release Version")
        retest_tester_id = _required(payload.retest_tester_id, "QA Retest Owner")
        retest_tester = db.get(models.User, retest_tester_id)
        if not retest_tester or not retest_tester.is_active:
            raise HTTPException(404, "Selected QA Retest Owner was not found or is inactive")
        if not retest_tester.has_role(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
            raise HTTPException(400, "QA Retest Owner must be an active QA user")
        previous_retest_tester_id = obj.retest_tester_id
        obj.retest_tester_id = retest_tester.id
        reassignment.record_assignment_change(
            db, "DEFECT", obj.id, "DEFECT_RETEST_TESTER", current_user,
            [previous_retest_tester_id], [retest_tester.id], "Assigned during resolution",
        )
        obj.resolved_at = models.now(); details = obj.resolution_summary
    elif requested == "Retest":
        obj.retest_result = "In Progress"; obj.retest_at = models.now(); details = remarks or "Retesting started."
    elif requested == "Closed":
        obj.tested_build_version = _required(payload.tested_build_version, "Tested Build Version")
        obj.retest_actual_result = _required(payload.actual_result, "Retest Actual Result")
        obj.retest_remarks = _required(payload.retest_remarks, "Retest Remarks")
        obj.closure_remarks = _required(payload.closure_remarks, "Closure Remarks")
        obj.retest_result = "Passed"; obj.closed_at = models.now(); details = obj.closure_remarks
    elif requested == "Reopened":
        obj.reopen_reason = _required(payload.reopen_reason, "Reopening Reason")
        if not doc_store.list_documents(db, _DOC_MODULE, obj.id):
            raise HTTPException(400, "Supporting evidence must be attached before reopening a defect")
        # Reopening from Retest/Closed means a validation failure. Reopening
        # Reopening a Rejected or Not a Defect outcome reverses an
        # investigation decision, not a retest, so do not manufacture a
        # misleading failed-retest result for either decision.
        if previous not in {"Rejected", "Not a Defect"}:
            obj.retest_result = "Failed"
            obj.retest_at = models.now()
        obj.reopen_count += 1
        details = (
            f"{previous} decision reopened: {obj.reopen_reason}"
            if previous in {"Rejected", "Not a Defect"}
            else obj.reopen_reason
        )
    elif requested == "Deferred":
        obj.deferral_reason = _required(payload.deferral_reason, "Deferral Reason")
        obj.deferral_approved_by = _required(payload.deferral_approved_by, "Approved By")
        obj.target_release = _required(payload.target_release, "Target Release")
        obj.expected_resolution_date = _required(payload.expected_resolution_date, "Expected Resolution Date")
        details = obj.deferral_reason
    elif requested == "Rejected":
        obj.rejection_reason = _required(payload.rejection_reason, "Rejection Reason")
        if not doc_store.list_documents(db, _DOC_MODULE, obj.id):
            raise HTTPException(400, "Supporting evidence must be attached before rejecting a defect")
        details = obj.rejection_reason
    elif requested == "Duplicate":
        duplicate_id = _required(payload.duplicate_defect_id, "Original Defect ID")
        original = _scoped_defects(db, current_user).filter(models.Defect.id == duplicate_id).first()
        if not original or original.id == obj.id:
            raise HTTPException(400, "Select a valid original Defect ID")
        if original.status == "Duplicate":
            raise HTTPException(400, "Select the canonical defect instead of another Duplicate")
        obj.duplicate_of_id = original.id; details = f"Duplicate of {original.defect_key}."
    elif requested == "Not a Defect":
        obj.not_a_defect_reason = _required(
            payload.not_a_defect_reason,
            "Requirements confirmation and discussion outcome",
        )
        details = obj.not_a_defect_reason
    else:
        details = remarks or f"Changed to {requested}."

    obj.status = requested
    db.query(models.TestRunDefect).filter(
        models.TestRunDefect.defect_key == obj.defect_key,
    ).update({models.TestRunDefect.defect_status: requested}, synchronize_session=False)
    _audit(db, obj, current_user, requested, details, previous, requested)
    db.commit(); db.refresh(obj)
    return obj


# Reassignment stays separate from lifecycle transitions: it changes only
# the current owner while preserving status and history.
@router.post("/{defect_id}/reassign", response_model=schemas.DefectOut)
def reassign_defect(defect_id: int, payload: schemas.DefectReassign, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    obj = _get_mutable(defect_id, db, current_user)
    if not obj.assignee_id or obj.status not in DEFECT_REASSIGNABLE_STATUSES:
        raise HTTPException(400, f"{obj.defect_key} does not currently have an assignee that can be reassigned.")
    previous_assignee_id = obj.assignee_id
    previous_assigned_at = obj.assigned_at
    previous_assignee = db.get(models.User, previous_assignee_id)
    previous_is_qa = bool(previous_assignee and set(previous_assignee.roles) & _QA_DEFECT_ROLES)
    reassignment.require_can_reassign(
        current_user, obj.assignee_id,
        previous_assignee.departments if previous_assignee else None,
        qa_workspace_id=(obj.qa_workspace_id if previous_is_qa else None),
    )
    reason = reassignment.require_reason(payload.reason)
    new_assignee = db.get(models.User, payload.assignee_id)
    if not new_assignee or not new_assignee.is_active:
        raise HTTPException(404, "Selected assignee was not found or is inactive")
    if not new_assignee.show_in_user_dropdowns:
        raise HTTPException(400, "The selected user is hidden from assignment dropdowns")
    if new_assignee.id == previous_assignee_id:
        raise HTTPException(400, "Select a different assignee for reassignment")
    # Reassignment pool: teammates of the current assignee plus configured
    # QA teams. A developer can therefore hand the defect to another member
    # of their own team or directly to QA without browsing unrelated
    # departments. Validate this server-side as well as filtering the UI so
    # a crafted request cannot route the defect elsewhere or submit a team
    # that the selected user does not actually belong to.
    valid_destinations = _valid_defect_reassignment_departments(obj, previous_assignee, new_assignee)
    if not valid_destinations:
        raise HTTPException(
            400,
            "Select a teammate of the current assignee or a member of the QA team",
        )
    destination = payload.assigned_team if payload.assigned_team in valid_destinations else None
    if not destination:
        destination = sorted(valid_destinations)[0]
    department = db.query(models.Department).filter(
        models.Department.name == destination,
        models.Department.is_active == True,  # noqa: E712
    ).first()
    if not department:
        raise HTTPException(400, "The selected user's destination Department is not active")
    obj.assigned_team = department.name
    previous_label = previous_assignee.full_name if previous_assignee else (obj.assignee_name or "Unassigned")
    obj.assignee_id = new_assignee.id
    obj.assigned_by_id = current_user.id
    obj.assigned_at = models.now()
    reassignment.record_reassignment(
        db, "DEFECT", obj.id, current_user, previous_label, new_assignee.full_name, reason,
        assignment_role="DEFECT_ASSIGNEE",
        previous_assignee_ids=[previous_assignee_id],
        new_assignee_ids=[new_assignee.id],
        previous_assigned_at=previous_assigned_at,
    )
    db.commit(); db.refresh(obj)
    return obj


@router.post("/{defect_id}/attachments", response_model=List[schemas.RequestDocumentOut])
def upload_attachments(defect_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    obj = _get_mutable(defect_id, db, current_user)
    # Evidence remains addable by a real workflow actor even while Closed,
    # because a reporter who is allowed to reopen a Closed defect must be
    # able to satisfy the reopen action's mandatory-evidence precondition.
    # Everyone else is rejected by the same actor check used in the UI.
    if not _can_touch_defect(db, obj, current_user):
        raise HTTPException(403, "Only the reporter, assignee, assignee's Department Head, retest tester, or an authorized lead can attach evidence to this defect")
    return doc_store.save_documents(db, _DOC_MODULE, obj.id, obj.defect_key, files, current_user.id,
                                    log_entity_type="DEFECT", log_entity_id=obj.id,
                                    log_actor=current_user, log_label="defect evidence")


@router.get("/{defect_id}/attachments", response_model=List[schemas.RequestDocumentOut])
def list_attachments(defect_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_visible(defect_id, db, current_user)
    return doc_store.list_documents(db, _DOC_MODULE, defect_id)


@router.get("/{defect_id}/attachments/{document_id}/download")
def download_attachment(defect_id: int, document_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = _get_visible(defect_id, db, current_user)
    document = doc_store.get_document_or_404(db, _DOC_MODULE, obj.id, document_id)
    path = doc_store.full_path(document)
    if not os.path.exists(path):
        raise HTTPException(404, "Attachment file is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")


@router.get('/{defect_id}/workflow-candidates', response_model=dict[str, List[schemas.UserOption]])
def workflow_candidates(defect_id: int, department: Optional[str] = None,
                        db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    from ..defect_assignment import assignment_error, OWNER_ROLES
    obj = _get_visible(defect_id, db, current_user)
    candidates = db.query(models.User).filter(models.User.is_active == True).all()
    from .auth import _redact_confidential_roles
    return {field: [_redact_confidential_roles(candidate, current_user) for candidate in candidates
                    if assignment_error(db, obj, candidate, field, department) is None]
            for field in OWNER_ROLES}


@router.post('/{defect_id}/workflow-action', response_model=schemas.DefectOut)
def defect_workflow_action(defect_id: int, payload: schemas.DefectWorkflowAction,
                           db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    from .defect_workflow_actions import apply_action
    return apply_action(db, _get_mutable(defect_id, db, current_user), payload, current_user)


@router.post('/{defect_id}/link-request', response_model=schemas.DefectOut)
def link_defect_request(defect_id: int, payload: schemas.DefectLinkRequest,
                        db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = _get_mutable(defect_id, db, current_user)
    if not (_is_manager(db, obj, current_user) or obj.reporter_id == current_user.id or _is_assignee(obj, current_user)):
        raise HTTPException(403, 'Only the reporter, resolver or QA lead can link a request')
    db.query(models.Defect).filter_by(id=obj.id).with_for_update().populate_existing().one()
    if payload.revision != obj.workflow_revision:
        raise HTTPException(409, 'Defect changed. Refresh before linking a request.')
    if obj.qa_request_id:
        raise HTTPException(400, 'This defect already has a QA request link')
    if obj.status in _TERMINAL_STATUSES:
        raise HTTPException(400, 'Reopen this defect before adding a request link')
    request = db.get(models.QARequest, payload.qa_request_id)
    if not request:
        raise HTTPException(404, 'QA Request was not found')
    _require_request_access(db, request, current_user)
    if request.qa_workspace_id != obj.qa_workspace_id or request.department != obj.department:
        raise HTTPException(400, 'Request must belong to the defect workspace and department')
    if request.application_name.casefold() != obj.application_name.casefold():
        raise HTTPException(400, 'Request must belong to the defect application')
    executions = ([obj.execution] if obj.execution else []) + [link.execution for link in obj.execution_links if link.execution]
    for execution in executions:
        link = execution.cycle.child_request_link
        if link:
            model = {'Functional': models.FunctionalRequest, 'SAST': models.SASTRequest,
                     'DAST': models.DASTRequest, 'Performance': models.PerformanceRequest}.get(link.child_type)
            child = db.get(model, link.child_id) if model else None
            if child and child.qa_request_id and child.qa_request_id != request.id:
                raise HTTPException(400, 'A linked execution belongs to a different QA request')
    obj.qa_request_id = request.id
    obj.workflow_revision += 1
    _audit(db, obj, current_user, 'Request Linked', f'Linked {request.request_id}. Workspace workflow version retained.')
    db.commit()
    db.refresh(obj)
    return obj
