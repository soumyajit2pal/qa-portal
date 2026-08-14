import os
from typing import List, Optional
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload, selectinload

from .. import models, schemas, pagination
from ..database import get_db
from ..deps import (
    get_current_user, require_roles, viewable_project_ids,
    require_can_execute_project, require_can_manage_execution_governance,
    get_project_or_404 as _get_project_or_404,
)
from ..constants import Role, QAStatus, TEST_CYCLE_LOCKED_STATUSES, TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS
from .. import documents as doc_store
from .. import reassignment
from ..xlsx_export import add_summary_sheet, add_table_sheet, new_workbook, workbook_response

# PAG-005-adjacent -- list_executions below keeps the full TestExecutionOut
# shape (unlike Functional/SAST/DAST/Test Cases, no separate lightweight
# ListOut was introduced here; a cycle's execution count is naturally
# bounded by how many test cases were assigned to it, not an
# unbounded-growth list like a whole project's request/case history), but it
# had NO eager-loading at all before this pagination pass -- every row was a
# fresh set of lazy queries for test_case/assigned_to/assigned_by/
# executed_by/runs/linked_defects. This is a partial mitigation (the direct,
# most-used relationships), not a complete N+1 elimination -- test_case's
# OWN nested relations (folder/created_by/checked_out_by/current_draft_version
# chain, tags) still lazy-load per row, same as before this change.
_LIST_EXECUTION_EAGER_LOADS = [
    joinedload(models.TestExecution.test_case),
    joinedload(models.TestExecution.assigned_to),
    joinedload(models.TestExecution.assigned_by),
    joinedload(models.TestExecution.executed_by),
    # Perf tuning (2026-08) -- added_by was missing from this list even
    # though TestExecutionOut.added_by_name reads it exactly like
    # assigned_by_name/executed_by_name do; every row was still a lazy
    # extra SELECT for this one relationship. Found while chasing the
    # "3500 testcases, add to cycle, timeout" report below.
    joinedload(models.TestExecution.added_by),
    selectinload(models.TestExecution.runs),
    selectinload(models.TestExecution.linked_defects),
]

router = APIRouter(prefix="/api/test-execution", tags=["test-management"])

# Same access as the Test Repository (test_repository.py) -- QA Engineer +
# QA Lead both create cycles, add test cases to them, and record results.
# Admin always bypasses via require_roles.
_EXEC_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA)
_RESULT_IMAGE_MODULE = "TEST_EXEC_IMAGE"  # <= qap_module_documents.module VARCHAR2(20)
_RESULT_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_RESULT_IMAGE_LIMIT = 8
_RESULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
# Oracle raises ORA-01795 when one IN expression contains more than 1,000
# values. Leave headroom rather than relying on the exact boundary so bulk
# selection remains portable across Oracle versions and SQLAlchemy drivers.
_ORACLE_IN_BATCH_SIZE = 900


def _in_batches(values: List[int], size: int = _ORACLE_IN_BATCH_SIZE):
    """Yield Oracle-safe slices while preserving the caller's order."""
    for start in range(0, len(values), size):
        yield values[start:start + size]


def _get_cycle_or_404(db: Session, cycle_id: int) -> models.TestCycle:
    obj = db.query(models.TestCycle).get(cycle_id)
    if not obj:
        raise HTTPException(404, "Test Cycle not found")
    return obj


def _require_active_project(db: Session, project_id: int) -> None:
    project = _get_project_or_404(db, project_id)
    if not project.is_active:
        raise HTTPException(400, "This Test Project is inactive. Reactivate it before changing test execution data")


def _require_open_cycle(cycle: models.TestCycle) -> None:
    """Blocked freezes operations; Completed permanently freezes the cycle."""
    if cycle.status in TEST_CYCLE_LOCKED_STATUSES:
        detail = (
            "This Test Cycle is Blocked. Resume Execution before making any changes."
            if cycle.status == "Blocked"
            else "This Test Cycle is Completed and read-only. No further changes are allowed."
        )
        raise HTTPException(
            400,
            detail,
        )


_ALLOWED_CYCLE_TRANSITIONS = {
    "Draft": {"Ready"},
    "Ready": {"In Progress"},
    "In Progress": {"Blocked", "Completed"},
    "Blocked": {"In Progress"},
    "Completed": set(),
}
_CYCLE_TRANSITION_ACTIONS = {
    ("Draft", "Ready"): "Mark as Ready",
    ("Ready", "In Progress"): "Start Execution",
    ("In Progress", "Blocked"): "Block Execution",
    ("Blocked", "In Progress"): "Resume Execution",
    ("In Progress", "Completed"): "Complete Execution",
}


def _sync_linked_functional_request_status(db: Session, cycle: "models.TestCycle",
                                             transition_action: str,
                                             current_user: "models.User") -> None:
    """2026-08 -- reported directly: "If test lifecycle is Blocked, then
    automatically mark linked QA request WAITING_FOR_FIX" and "again
    lifecycle marked as In Progress then linked qa request again marked as
    EXECUTION_IN_PROGRESS." Only wired for a Functional child link -- SAST/
    DAST/Performance don't share this status vocabulary (Performance's own
    lifecycle has no Blocked-equivalent Execution/Waiting-For-Fix pair --
    see PERFORMANCE_STATUSES, which lumps that concern into a single
    DEFECT_FIX_RETEST status -- so it's deliberately left untouched pending
    its own design decision if this is ever extended there).

    Guarded so this only ever moves a request between the two statuses this
    sync itself owns -- it will never clobber a manually-reached state like
    QA_COMPLETED, or a DEFECT_RAISED still awaiting a human decision on the
    (unlinked-cycle) manual defect flow.

    A Functional request may have several linked Test Cycles at once (see
    FunctionalRequest.linked_test_cycles / complete_qa's own "every linked
    cycle must be Completed" gate) -- Resume Execution only restores
    EXECUTION_IN_PROGRESS once none of the request's OTHER linked cycles are
    still Blocked, so one cycle resuming doesn't prematurely unblock a
    request that's still genuinely stuck on a different cycle."""
    link = cycle.child_request_link
    if not link or link.child_type != "Functional":
        return
    freq = db.query(models.FunctionalRequest).get(link.child_id)
    if not freq:
        return
    if transition_action == "Block Execution":
        if freq.status == QAStatus.EXECUTION_IN_PROGRESS:
            freq.status = QAStatus.WAITING_FOR_FIX
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST", entity_id=freq.id, step_name="Execution In Progress",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision="Waiting For Fix (Test Cycle Blocked)",
                comments=f"Auto-set: linked Test Cycle {cycle.cycle_key} - {cycle.name} was marked Blocked.",
            ))
    elif transition_action == "Resume Execution":
        if freq.status == QAStatus.WAITING_FOR_FIX:
            still_blocked = any(
                other.status == "Blocked" for other in freq.linked_test_cycles if other.id != cycle.id
            )
            if not still_blocked:
                freq.status = QAStatus.EXECUTION_IN_PROGRESS
                db.add(models.ApprovalAction(
                    entity_type="FUNCTIONAL_REQUEST", entity_id=freq.id, step_name="Waiting For Fix",
                    actor_id=current_user.id, actor_role=current_user.roles_csv,
                    decision="Execution In Progress (Test Cycle Resumed)",
                    comments=f"Auto-set: linked Test Cycle {cycle.cycle_key} - {cycle.name} resumed to In Progress.",
                ))


def _validate_cycle_transition(current_status: str, requested_status: str,
                               blocking_reason: str) -> str:
    if requested_status not in _ALLOWED_CYCLE_TRANSITIONS.get(current_status, set()):
        raise HTTPException(
            400,
            "Invalid status transition. The Test Cycle cannot be changed from "
            f"{current_status} to {requested_status}.",
        )
    if requested_status == "Blocked" and not blocking_reason:
        raise HTTPException(400, "A blocking reason is required before blocking this Test Cycle")
    return _CYCLE_TRANSITION_ACTIONS[(current_status, requested_status)]


def _require_cycle_in_progress(cycle: models.TestCycle) -> None:
    if cycle.status != "In Progress":
        raise HTTPException(
            400,
            f"Test execution is unavailable while the Test Cycle is {cycle.status}. "
            "Use the permitted lifecycle action to move it to In Progress first.",
        )


_CYCLE_ITEM_NOT_READY_STATUSES = ("Draft", "In Review", "Review Completed", "Returned", "Rejected", "Archived")


def _validate_cycle_ready(db: Session, cycle: models.TestCycle, start_date, end_date) -> None:
    """2026-08 "Test Approval Workflow" refactor, section 7 -- "A cycle may
    become Ready only when" its five listed conditions all hold. Called
    only on a transition INTO "Ready" (see update_cycle below), not on
    every save, so a cycle can otherwise be edited freely while still being
    assembled. Item statuses are re-checked against each execution's
    PINNED version specifically (not just "was Approved when added") --
    add-to-cycle already only accepts an Approved version (CYC-003/004),
    but archiving a testcase after it was pinned retroactively changes that
    exact version's own status to Archived (see archive_test_case), so this
    is a genuine, not-redundant safety net at Ready time."""
    executions = cycle.executions
    if not executions:
        raise HTTPException(400, "A cycle needs at least one test case before it can become Ready")
    unassigned = [e for e in executions if not e.assigned_to_id]
    if unassigned:
        raise HTTPException(
            400,
            f"{len(unassigned)} test case(s) in this cycle have no assigned tester -- "
            "every planned execution needs an assignee before the cycle can become Ready",
        )
    if not start_date or not end_date:
        raise HTTPException(400, "Both a start date and an end date are required before the cycle can become Ready")
    if start_date > end_date:
        raise HTTPException(400, "Start date cannot be after end date")
    link = cycle.child_request_link
    if link:
        child_models = {
            "Functional": models.FunctionalRequest, "SAST": models.SASTRequest,
            "DAST": models.DASTRequest, "Performance": models.PerformanceRequest,
        }
        child_model = child_models.get(link.child_type)
        linked_request = db.query(child_model).get(link.child_id) if child_model else None
        if not linked_request or not linked_request.request_id:
            raise HTTPException(400, "This cycle's linked request is no longer valid -- unlink it before continuing")
    not_ready_items = [
        e.test_case.test_case_key for e in executions
        if e.pinned_version and e.pinned_version.status in _CYCLE_ITEM_NOT_READY_STATUSES and e.test_case
    ]
    if not_ready_items:
        preview = ", ".join(not_ready_items[:5])
        suffix = "…" if len(not_ready_items) > 5 else ""
        raise HTTPException(
            400,
            f"{len(not_ready_items)} test case(s) in this cycle are no longer Approved/Active "
            f"(likely archived since being added) and must be removed or replaced first: {preview}{suffix}",
        )


def _require_scope_change_permission(db: Session, cycle: models.TestCycle, current_user: models.User) -> None:
    """CYC-007 "Scope changes after execution starts shall require QA Lead
    permission and audit reason." Once at least one item in this cycle has
    a recorded attempt, adding/removing testcase slots is QA Lead Group/
    Admin-only -- the audit reason half of CYC-007 is satisfied by the
    ApprovalAction comment every caller of this already writes describing
    exactly what scope changed and why (e.g. "N testcase(s) removed
    from ..."). 2026-08 whole-module simplification: the old per-project
    "Project Lead"/"Owner" TestProjectMember carve-out is gone -- the QA Lead
    Group system-role set (QA_LEAD/CHIEF_MANAGER_QA/AGM_QA) is the sole
    authority now, matching can_manage_execution_governance in deps.py."""
    if current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        return
    has_started = db.query(models.TestExecutionRun.id).join(
        models.TestExecution, models.TestExecutionRun.execution_id == models.TestExecution.id,
    ).filter(models.TestExecution.cycle_id == cycle.id).first()
    if has_started:
        raise HTTPException(
            403,
            "This cycle already has recorded execution attempts -- only a QA Lead or Administrator "
            "can change its testcase scope now.",
        )


# 2026-08 -- reported directly: "'Remove from cycle' should be available
# only for QA lead, also once execution history created then remove from
# cycle should not be enable for everyone. Same for Test Cycle, once
# execution history created then remove option should not be there for QA
# lead. Administration can supersede everything." Refined with Scenario 1
# (also reported directly): "tester add testcase in lifecycle, but not
# executed it, just added ... might be by mistake ... now system should
# allow to remove from lifecycle as there are no test execution history."
# Resolution (confirmed directly): whoever ADDED a testcase to a cycle may
# remove their OWN addition themselves, but only while it still has zero
# execution history -- self-correcting a same-person, zero-consequence
# mistake, without needing a QA Lead. Full rule, in priority order:
#   1. Admin always may (has_role's standing ADMIN short-circuit).
#   2. Any recorded attempt on THIS slot -- QA Lead Group and the original
#      adder both lose the ability; Admin only. Deliberately per-execution,
#      not cycle-wide like _require_scope_change_permission above, since
#      removal targets one slot at a time and other still-untouched slots in
#      the same cycle should stay removable.
#   3. No recorded attempt yet -- QA Lead Group may always remove (any
#      slot, not just their own); the ORIGINAL ADDER (TestExecution.
#      added_by_id, set once at add-to-cycle time) may remove only their own
#      addition. Anyone else (a different QA_ENGINEER who didn't add it) is
#      still blocked.
# Router-level require_roles widened back to include QA_ENGINEER (was
# QA_LEAD Group only) so path 3's self-remove case can even reach this
# function -- the actual gate lives here, not at the router.
def _execution_removal_block_reason(execution: models.TestExecution, current_user: models.User) -> Optional[str]:
    """None if current_user may remove this execution; otherwise the reason
    it's blocked (used both to raise a single-item 403 and to build the
    bulk-remove skip list)."""
    if current_user.has_role(Role.ADMIN):
        return None
    if execution.runs:
        return "already has recorded execution history in this cycle -- only an Administrator can remove it now"
    if current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA):
        return None
    if execution.added_by_id and execution.added_by_id == current_user.id:
        return None
    return "was not added to this cycle by you -- only the QA Lead Group, an Administrator, or whoever added it can remove it before it has been executed"


def _require_can_remove_execution(execution: models.TestExecution, current_user: models.User) -> None:
    reason = _execution_removal_block_reason(execution, current_user)
    if reason:
        key = execution.test_case.test_case_key if execution.test_case else "This test case"
        raise HTTPException(403, f"{key} {reason}.")


def _execution_or_404(db: Session, execution_id: int) -> models.TestExecution:
    obj = db.query(models.TestExecution).get(execution_id)
    if not obj:
        raise HTTPException(404, "Execution not found")
    return obj


def _runner_or_404(db: Session, user_id: int) -> models.User:
    target = db.query(models.User).get(user_id)
    if not target or not target.is_active:
        raise HTTPException(404, "Selected runner was not found or is inactive")
    if not (set(target.roles) & {Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA}):
        raise HTTPException(400, "Runner must have the QA Engineer, QA Lead, or CM-QA role")
    if not target.has_department(*TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS):
        raise HTTPException(400, f"Runner must be mapped to one of: {', '.join(TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS)}")
    return target


def _require_qa_assignment_manager(current_user: models.User) -> None:
    """Assignment is available to the whole Test Management execution team.

    require_roles(*_EXEC_ROLES) checks the QA role; this additional department
    check prevents a mis-mapped QA role outside constants.
    TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS from managing the shared execution
    queue. Administrators retain the standard global bypass.
    """
    if current_user.has_role(Role.ADMIN):
        return
    if not current_user.has_department(*TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS):
        raise HTTPException(403, f"Only members of {', '.join(TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS)} can assign testcase runners")


def _validate_result_images(files: List[UploadFile]) -> None:
    if len(files) > _RESULT_IMAGE_LIMIT:
        raise HTTPException(400, f"Actual Result can contain at most {_RESULT_IMAGE_LIMIT} new images per save")
    for image in files:
        if (image.content_type or "").lower() not in _RESULT_IMAGE_TYPES:
            raise HTTPException(400, f"'{image.filename or 'pasted image'}' is not supported. Use PNG, JPEG, GIF, or WebP")
        image.file.seek(0, os.SEEK_END)
        size = image.file.tell()
        image.file.seek(0)
        if size > _RESULT_IMAGE_MAX_BYTES:
            raise HTTPException(400, f"'{image.filename or 'pasted image'}' exceeds the 10 MB image limit")


def _require_assigned_runner(obj: models.TestExecution, current_user: models.User) -> None:
    if current_user.has_role(Role.ADMIN):
        return
    if not obj.assigned_to_id:
        raise HTTPException(400, "This testcase is unassigned. A QA Engineer or QA Lead from the Test Management team must assign a runner before execution")
    if obj.assigned_to_id != current_user.id:
        raise HTTPException(
            403,
            f"This testcase is assigned to {obj.assigned_to_name or 'another runner'}. "
            "Ask a QA Engineer or QA Lead from the Test Management team to reassign it before recording an attempt.",
        )


# Governed statuses (defects.py) that count as "resolved enough to retest
# against" -- Deferred (accepted, tracked, testing may proceed) or Closed
# (fixed and verified). Every other status (New/Assigned/In Progress/
# Resolved/Retest/Reopened/Rejected/Duplicate) counts as "active" and keeps
# the full lock below engaged. Rejected/Duplicate deliberately NOT included
# even though they're also terminal -- reported directly as "Deferred or
# Closed" only; flag to the QA process owner if Rejected/Duplicate should
# also clear the lock.
_DEFECT_RETEST_CLEAR_STATUSES = ("Deferred", "Closed")


def _execution_lock_state(db: Session, execution_id: int):
    """Returns (active_defects, has_prior_fail) for _execution_status_gate.
    active_defects -- every governed Defect (defects.py) linked to this slot
    (Defect.execution_id) whose own status is not yet Deferred/Closed; a
    non-empty list here is what drives the full lock. has_prior_fail -- True
    if any attempt ever recorded on this slot (TestExecutionRun.status) was
    'Fail', which drives the permanent 'Pass'/'NA' block for the rest of
    this slot's history, regardless of whether a defect is linked right
    now."""
    defects = db.query(models.Defect).filter(models.Defect.execution_id == execution_id).all()
    active_defects = [d for d in defects if d.status not in _DEFECT_RETEST_CLEAR_STATUSES]
    has_prior_fail = db.query(models.TestExecutionRun.id).filter(
        models.TestExecutionRun.execution_id == execution_id,
        models.TestExecutionRun.status == "Fail",
    ).first() is not None
    return active_defects, has_prior_fail


def _execution_status_gate(db: Session, execution_id: int, status_value: str,
                           defect_key: str = "") -> "str | None":
    """Reported directly, in two parts, in this order:

    1. "testcase already failed, and defect also linked, then why again
       allowing to marked failed" -- clarified into a full spec: while ANY
       governed Defect linked to this slot is still active (not Deferred/
       Closed), the execution is completely locked -- no new attempt of any
       status (Pass/Fail/Blocked/NA/Retest Passed) may be recorded through
       any endpoint, matching the earlier-reported "keep the execution
       status as Fail... prevent status modification through the UI/APIs/
       bulk updates" requirement. There is deliberately no exception here,
       including for a fresh 'Fail' -- while a defect is open, the defect is
       what needs attention, not another execution attempt.

    2. Once every linked defect clears (or none was ever linked), but this
       slot has EVER recorded a 'Fail': 'Pass'/'NA' are permanently blocked
       for the rest of this slot's history (a defect-corrected pass is
       always 'Retest Passed', never 'Pass' -- keeps "clean first try" and
       "passed after a fix" distinguishable in reporting). 'Retest Passed'
       and 'Blocked' are available. A fresh 'Fail' (failed again on retest)
       requires a defect_key that resolves to an existing, currently-active
       governed Defect -- reopen the existing one, link a different active
       one, or create a new one in Defect Management first, then reference
       its key here. This is deliberately NOT auto-reopened from here: doing
       so would mutate defects.py's own Defect.status state machine (and its
       audit trail) as a side effect of a Test Execution save, which is a
       bigger, riskier change than this endpoint owning -- the tester takes
       that action explicitly in Defect Management, then comes back here.

    Returns a human-readable reason, or None if nothing blocks status_value."""
    if status_value not in ("Pass", "Fail", "Blocked", "NA", "Retest Passed"):
        return None
    active_defects, has_prior_fail = _execution_lock_state(db, execution_id)
    if active_defects:
        names = ", ".join(f"{d.defect_key} ({d.status})" for d in active_defects)
        return (
            f"this test case previously failed and has an active linked defect ({names}). The execution "
            "status cannot be changed until all linked defects are Closed or Deferred."
        )
    if not has_prior_fail:
        return None
    if status_value in ("Pass", "NA"):
        return (
            f"this test case failed earlier in its history -- '{status_value}' is no longer available. "
            "The linked defect has been Closed or Deferred: select 'Retest Passed' if it passes now, or "
            "'Fail' if it fails again."
        )
    if status_value == "Fail":
        if not defect_key:
            return (
                "this test case is failing again after a resolved defect -- reopen the existing defect, "
                "link another active defect, or create a new defect in Defect Management, then reference "
                "its Defect Key here before recording this Fail."
            )
        governed = db.query(models.Defect).filter(models.Defect.defect_key == defect_key).first()
        if not governed:
            return (
                f"'{defect_key}' is not a known governed defect -- create it in Defect Management first, "
                "then reference its Defect Key here."
            )
        if governed.status in _DEFECT_RETEST_CLEAR_STATUSES:
            return (
                f"defect '{defect_key}' is still {governed.status} -- reopen it in Defect Management "
                "before referencing it here."
            )
    return None


def _prepare_execution_update(db: Session, obj: models.TestExecution, status_value: str,
                              current_user: models.User, defect_key: str = "") -> models.TestCycle:
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    _require_cycle_in_progress(cycle)
    # SRS CYC-004/CYC-006 -- this slot is pinned to the exact TestCaseVersion
    # that was Approved when it was added (or last explicitly upgraded), and
    # stays executable even if the live testcase later moves into a new
    # Draft revision. Only a slot that was somehow never pinned at all
    # (shouldn't happen post add_test_cases_to_cycle, but defensive) is
    # blocked.
    if not obj.pinned_version_id:
        raise HTTPException(400, "This testcase slot has no pinned approved version and cannot be executed")
    from ..constants import TEST_EXECUTION_STATUSES
    if status_value not in TEST_EXECUTION_STATUSES:
        raise HTTPException(400, f"Invalid execution status '{status_value}'")
    violation = _execution_status_gate(db, obj.id, status_value, defect_key)
    if violation:
        raise HTTPException(400, f"Cannot record '{status_value}': {violation}")
    _require_assigned_runner(obj, current_user)
    return cycle


def _validate_defect_values(defect_key: str, defect_url: str = "") -> tuple[str, str]:
    key = defect_key.strip()
    url = defect_url.strip()
    if len(key) > 100:
        raise HTTPException(400, "Defect key cannot exceed 100 characters")
    if len(url) > 500:
        raise HTTPException(400, "Defect URL cannot exceed 500 characters")
    if url:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(400, "Defect URL must be a complete http:// or https:// link")
    return key, url


def _link_defect(db: Session, run: models.TestExecutionRun, payload: schemas.TestRunDefectCreate,
                 current_user: models.User) -> models.TestRunDefect:
    key, url = _validate_defect_values(payload.defect_key, payload.defect_url or "")
    if not key:
        raise HTTPException(400, "Defect key is required")
    if len((payload.title or "").strip()) > 255:
        raise HTTPException(400, "Defect title cannot exceed 255 characters")
    if len((payload.defect_status or "").strip()) > 40:
        raise HTTPException(400, "Defect status cannot exceed 40 characters")
    if len((payload.notes or "").strip()) > 5000:
        raise HTTPException(400, "Defect notes cannot exceed 5,000 characters")
    # Reported directly: "testcase already failed, and defect also linked,
    # then why again allowing to marked failed" -- clarified to mean linking
    # a SECOND, separate defect to the same already-linked attempt (a fresh
    # 'Fail' attempt after retesting is still fine and expected -- see
    # _execution_status_gate, which governs that separately). Was previously
    # only checked per (run_id, defect_key), which blocked re-linking the
    # exact same key but let a different defect key be linked to the same
    # attempt without limit. Now checks the whole attempt.
    existing = db.query(models.TestRunDefect).filter_by(run_id=run.id).first()
    if existing:
        if existing.defect_key == key:
            raise HTTPException(400, f"Defect '{key}' is already linked to this attempt")
        raise HTTPException(
            400,
            f"Attempt #{run.attempt_no} already has defect '{existing.defect_key}' linked -- record a new "
            "attempt (retest) instead of linking a second defect to the same one.",
        )
    defect = models.TestRunDefect(
        run_id=run.id,
        defect_key=key,
        defect_url=url or None,
        title=(payload.title or "").strip() or None,
        defect_status=(payload.defect_status or "").strip() or None,
        notes=(payload.notes or "").strip() or None,
        linked_by_id=current_user.id,
    )
    db.add(defect)
    db.add(models.ApprovalAction(
        entity_type="TEST_CASE", entity_id=run.execution.test_case_id,
        step_name=f"Attempt #{run.attempt_no} Defect",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Defect Linked", comments=f"Linked defect {key} to execution attempt #{run.attempt_no}.",
    ))
    return defect


def _migrate_legacy_result_if_needed(db: Session, obj: models.TestExecution) -> None:
    """One-time, lazy migration for a row saved before per-attempt history
    existed. Before this feature shipped, a TestExecution could only ever
    hold a single result, overwritten in place on every run -- so whatever
    is on it right now (if it was ever actually run at all) IS the one and
    only attempt that existed. The first time a *new* attempt is recorded
    after upgrading, preserve that prior result as Run #1 -- including
    re-pointing its already-uploaded evidence images onto the new row --
    before it gets overwritten with the new attempt's result. A no-op once
    this has run once (or for a row that's never been executed, or that
    already has real attempt history)."""
    if obj.status == "Not Executed":
        return
    if db.query(models.TestExecutionRun).filter_by(execution_id=obj.id).first():
        return
    legacy_run = models.TestExecutionRun(
        execution_id=obj.id, attempt_no=1, status=obj.status,
        actual_result=obj.actual_result, test_run_artifacts=obj.test_run_artifacts,
        defect_id=obj.defect_id, executed_by_id=obj.executed_by_id,
        executed_at=obj.executed_at or obj.created_at,
    )
    db.add(legacy_run)
    db.flush()
    # RequestDocument's (module, request_id) pair is a loose polymorphic
    # association, not a real FK -- so "moving" an already-uploaded image
    # from the execution row onto its new Run #1 is just updating which id
    # it's keyed under, no file move needed (folder_name on disk was never
    # derived from this id -- see documents.py::save_documents).
    db.query(models.RequestDocument).filter_by(
        module=_RESULT_IMAGE_MODULE, request_id=obj.id,
    ).update({"request_id": legacy_run.id})


def _record_attempt(db: Session, obj: models.TestExecution, status_value: str,
                     actual_result, test_run_artifacts, defect_id,
                     current_user: models.User) -> models.TestExecutionRun:
    """Records a new attempt instead of overwriting the last one -- see
    models.TestExecutionRun's own docstring for why. TestExecution's own
    columns are then updated to mirror this newest attempt, purely so every
    existing list/filter/report that reads those columns directly keeps
    working unchanged."""
    _migrate_legacy_result_if_needed(db, obj)
    next_attempt_no = db.query(models.TestExecutionRun).filter_by(execution_id=obj.id).count() + 1
    executed_at = models.now()
    run = models.TestExecutionRun(
        execution_id=obj.id, attempt_no=next_attempt_no, status=status_value,
        actual_result=actual_result, test_run_artifacts=test_run_artifacts,
        defect_id=defect_id, executed_by_id=current_user.id, executed_at=executed_at,
    )
    db.add(run)
    db.flush()
    obj.status = status_value
    obj.actual_result = actual_result
    obj.test_run_artifacts = test_run_artifacts
    obj.defect_id = defect_id
    obj.executed_by_id = current_user.id
    obj.executed_at = executed_at
    # SRS EXE-007 "optimistic concurrency" -- bumped on every attempt so a
    # caller that read this slot before a concurrent save (see
    # update_execution's own expected_run_version check) can detect it.
    obj.run_version = (obj.run_version or 0) + 1
    db.add(models.ApprovalAction(
        entity_type="TEST_CASE", entity_id=obj.test_case_id,
        step_name=f"Test Execution Attempt #{next_attempt_no}",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Attempt Recorded",
        comments=(
            f"{obj.test_case.test_case_key if obj.test_case else f'Testcase #{obj.test_case_id}'} "
            f"recorded as {status_value} by {current_user.full_name}."
        ),
    ))
    return run


def _run_or_404(db: Session, obj: models.TestExecution, run_id: int) -> models.TestExecutionRun:
    run = db.query(models.TestExecutionRun).filter_by(id=run_id, execution_id=obj.id).first()
    if not run:
        raise HTTPException(404, "Execution attempt not found")
    return run


def _latest_run_or_404(db: Session, obj: models.TestExecution) -> models.TestExecutionRun:
    run = (db.query(models.TestExecutionRun).filter_by(execution_id=obj.id)
           .order_by(models.TestExecutionRun.attempt_no.desc()).first())
    if not run:
        raise HTTPException(404, "This test case has not been executed yet")
    return run


# ---- Cycles ----
@router.get("/projects/{project_id}/cycles", response_model=pagination.Page[schemas.TestCycleOut])
def list_cycles(project_id: int, params: pagination.PageParams = Depends(),
                 db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # SRS 7.2 pagination rollout (task #82) -- like Test Projects, Test
    # Cycles is a flat, already-lightweight list (TestCycleOut has no heavy
    # nested arrays) that's never browsed through the app's real paginated
    # <Table>; every screen that lists cycles uses it as a complete
    # picker/aggregation source (project cycle picker, MyExecutions'
    # per-project fan-out, reports). Wrapped in Page[T] purely for
    # API-contract consistency -- frontend consumers request
    # page_size=100 and unwrap .items rather than getting a real pager UI.
    _get_project_or_404(db, project_id)
    q = db.query(models.TestCycle).filter_by(project_id=project_id)
    q = pagination.apply_search(q, params, models.TestCycle.name, models.TestCycle.cycle_key)
    q = pagination.apply_status_filter(q, params, models.TestCycle.status)
    q = pagination.apply_sort(q, params, sortable={"name": models.TestCycle.name},
                               default_column=models.TestCycle.created_at, id_column=models.TestCycle.id)
    result = pagination.paginate(q, params)
    return pagination.to_page_response(result, params)


@router.post("/projects/{project_id}/cycles", response_model=schemas.TestCycleOut)
def create_cycle(project_id: int, payload: schemas.TestCycleCreate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """SRS CYC-001 -- name, type, dates, owner, environment, build and an
    optional request link are all captured at creation."""
    _require_active_project(db, project_id)
    require_can_execute_project(db, project_id, current_user)
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Cycle name cannot be blank")
    if payload.start_date and payload.end_date and payload.start_date > payload.end_date:
        raise HTTPException(400, "Start date cannot be after end date")
    if payload.owner_id:
        owner = db.query(models.User).get(payload.owner_id)
        if not owner:
            raise HTTPException(404, "Selected cycle owner not found")
    linked_request = None
    child_models = {
        "Functional": models.FunctionalRequest, "SAST": models.SASTRequest,
        "DAST": models.DASTRequest, "Performance": models.PerformanceRequest,
    }
    if payload.linked_request_id is not None:
        child_model = child_models.get(payload.linked_request_type or "")
        if not child_model:
            raise HTTPException(400, "Select a valid child request type")
        linked_request = db.query(child_model).get(payload.linked_request_id)
        if not linked_request or not linked_request.request_id:
            raise HTTPException(404, "Child request not found")
    obj = models.TestCycle(
        project_id=project_id, name=name, description=payload.description,
        start_date=payload.start_date, end_date=payload.end_date, created_by_id=current_user.id,
        cycle_type=payload.cycle_type, environment=payload.environment,
        build=payload.build, owner_id=payload.owner_id,
    )
    db.add(obj)
    db.flush()
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=obj.id, step_name="Cycle",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Created", comments=f"Created test cycle {obj.cycle_key} - {obj.name}.",
    ))
    if linked_request:
        obj.child_request_link = models.TestCycleChildRequestLink(
            child_type=payload.linked_request_type, child_id=linked_request.id,
            child_key=linked_request.request_id,
        )
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/cycles/{cycle_id}", response_model=schemas.TestCycleOut)
def get_cycle(cycle_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_cycle_or_404(db, cycle_id)


@router.patch("/cycles/{cycle_id}", response_model=schemas.TestCycleOut)
def update_cycle(cycle_id: int, payload: schemas.TestCycleUpdate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Edit cycle metadata and enforce the controlled five-state lifecycle."""
    obj = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, obj.project_id)
    require_can_execute_project(db, obj.project_id, current_user)
    data = payload.model_dump(exclude_unset=True)
    blocking_reason = (data.pop("blocking_reason", None) or "").strip()
    remarks = (data.pop("remarks", None) or "").strip()
    if len(blocking_reason) > 5000 or len(remarks) > 5000:
        raise HTTPException(400, "Blocking reason and remarks cannot exceed 5,000 characters")
    previous_status = obj.status
    previous_link_type = obj.linked_request_type
    previous_link_key = obj.linked_request_key
    tracked_fields = {
        "name": "Name", "description": "Description", "start_date": "Start date",
        "end_date": "End date", "cycle_type": "Cycle type", "environment": "Environment",
        "build": "Build", "owner_id": "Owner",
    }
    previous_values = {field: getattr(obj, field) for field in tracked_fields}
    transition_action = None
    if "status" in data:
        new_status = data["status"]
        transition_action = _validate_cycle_transition(previous_status, new_status, blocking_reason)
        if new_status == "Completed":
            # A cycle represents the complete execution set, so it cannot be
            # closed while any testcase slot still has its initial
            # "Not Executed" state. Keep this server-side even though the UI
            # also disables completion: API clients and stale browser tabs
            # must not be able to bypass the lifecycle rule.
            incomplete_executions = db.query(models.TestExecution).options(
                joinedload(models.TestExecution.test_case)
            ).filter(
                models.TestExecution.cycle_id == obj.id,
                models.TestExecution.status == "Not Executed",
            ).all()
            if incomplete_executions:
                labels = ", ".join(
                    execution.test_case.test_case_key
                    if execution.test_case else f"Testcase #{execution.test_case_id}"
                    for execution in incomplete_executions[:8]
                )
                suffix = "…" if len(incomplete_executions) > 8 else ""
                raise HTTPException(
                    400,
                    f"Every testcase must be executed before completing this Test Cycle. "
                    f"{len(incomplete_executions)} testcase(s) are still Not Executed: {labels}{suffix}",
                )
            unresolved_statuses = ("New", "Assigned", "In Progress", "Resolved", "Retest", "Reopened")
            severe = db.query(models.Defect).filter(
                models.Defect.cycle_id == obj.id,
                models.Defect.severity.in_(("Critical", "High")),
                models.Defect.status.in_(unresolved_statuses),
            ).all()
            if severe:
                labels = ", ".join(defect.defect_key for defect in severe[:8])
                raise HTTPException(
                    400,
                    "This Test Cycle contains unresolved Critical or High severity defects. "
                    "Resolve, reject, defer with approval, or close these defects before completing the Test Cycle. "
                    f"Blocking defects: {labels}",
                )
            residual = db.query(models.Defect).filter(
                models.Defect.cycle_id == obj.id,
                models.Defect.severity.in_(("Medium", "Low")),
                models.Defect.status.in_(unresolved_statuses),
            ).all()
            if residual:
                # 2026-08 whole-module simplification: QA Lead Group system
                # role only -- the old per-project "Project Lead"/"Owner"
                # TestProjectMember carve-out is gone.
                manager = current_user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)
                if not manager:
                    raise HTTPException(403, "Open Medium or Low defects require QA Lead approval before cycle completion")
                if not remarks:
                    raise HTTPException(400, "Completion justification is required while Medium or Low defects remain open")
                missing_target = [defect.defect_key for defect in residual if not defect.target_release]
                if missing_target:
                    raise HTTPException(400, "Set a Target Release on every remaining Medium or Low defect before completing the cycle: " + ", ".join(missing_target))
    elif blocking_reason or remarks:
        raise HTTPException(400, "Blocking reason or transition remarks require a status change")
    # A Blocked cycle is frozen except for its one valid lifecycle action:
    # Resume Execution. It cannot smuggle metadata changes through alongside
    # that transition.
    if previous_status == "Blocked" and transition_action:
        if set(data) != {"status"}:
            raise HTTPException(400, "A Blocked Test Cycle can only be resumed; no other fields can be changed")
    else:
        _require_open_cycle(obj)
    if "owner_id" in data and data["owner_id"] is not None:
        if not db.query(models.User).get(data["owner_id"]):
            raise HTTPException(404, "Selected cycle owner not found")
    # 2026-08 Reassignment Requirement -- changing (or clearing) the cycle
    # owner once one is already set is a reassignment: only the current
    # owner, their Department Head, or an Admin may do it, and a reason is
    # mandatory. Setting an owner for the first time keeps the existing
    # broad _EXEC_ROLES gate already enforced at the endpoint level.
    previous_owner_id = previous_values["owner_id"]
    is_owner_reassignment = "owner_id" in data and previous_owner_id is not None and data["owner_id"] != previous_owner_id
    previous_owner = None
    owner_reason = None
    if is_owner_reassignment:
        previous_owner = db.query(models.User).get(previous_owner_id)
        reassignment.require_can_reassign(current_user, previous_owner_id, previous_owner.departments if previous_owner else None)
        owner_reason = reassignment.require_reason(payload.reason)
    start_date = data.get("start_date", obj.start_date)
    end_date = data.get("end_date", obj.end_date)
    if start_date and end_date and start_date > end_date:
        raise HTTPException(400, "Start date cannot be after end date")
    entering_ready = data.get("status") == "Ready" and obj.status != "Ready"
    link_changed = "linked_request_type" in data or "linked_request_id" in data
    link_type = data.pop("linked_request_type", None)
    link_id = data.pop("linked_request_id", None)
    for field, value in data.items():
        setattr(obj, field, value)
    if link_changed:
        if link_id is None:
            obj.child_request_link = None
        else:
            child_models = {
                "Functional": models.FunctionalRequest, "SAST": models.SASTRequest,
                "DAST": models.DASTRequest, "Performance": models.PerformanceRequest,
            }
            child_model = child_models.get(link_type or "")
            if not child_model:
                raise HTTPException(400, "Select a valid child request type")
            linked_request = db.query(child_model).get(link_id)
            if not linked_request or not linked_request.request_id:
                raise HTTPException(404, "Child request not found")
            if obj.child_request_link:
                obj.child_request_link.child_type = link_type
                obj.child_request_link.child_id = linked_request.id
                obj.child_request_link.child_key = linked_request.request_id
            else:
                obj.child_request_link = models.TestCycleChildRequestLink(
                    child_type=link_type, child_id=linked_request.id, child_key=linked_request.request_id,
                )
    # 2026-08 "Test Approval Workflow" refactor, section 7 -- validated
    # against the FULLY-UPDATED obj (after link changes above have
    # already been applied in this same request), not the pre-update
    # snapshot, so a request that sets a new link and Ready in one go
    # is checked against what it's actually about to become.
    if entering_ready:
        _validate_cycle_ready(db, obj, start_date, end_date)
    if transition_action:
        details = [f"Status changed from {previous_status} to {obj.status}."]
        if blocking_reason:
            details.append(f"Blocking reason: {blocking_reason}")
        if remarks:
            details.append(f"Remarks: {remarks}")
        db.add(models.ApprovalAction(
            entity_type="TEST_CYCLE", entity_id=obj.id, step_name="Lifecycle",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision=transition_action, comments="\n".join(details),
        ))
        if transition_action in ("Block Execution", "Resume Execution"):
            _sync_linked_functional_request_status(db, obj, transition_action, current_user)
    if link_changed:
        new_link_type = obj.linked_request_type
        new_link_key = obj.linked_request_key
        if (previous_link_type, previous_link_key) != (new_link_type, new_link_key):
            if new_link_key:
                decision = "Request Linked"
                comments = f"Linked {new_link_type} request {new_link_key}."
                if previous_link_key:
                    comments += f" Replaced {previous_link_type} request {previous_link_key}."
            else:
                decision = "Request Unlinked"
                comments = f"Unlinked {previous_link_type} request {previous_link_key}."
            db.add(models.ApprovalAction(
                entity_type="TEST_CYCLE", entity_id=obj.id, step_name="Request Link",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision=decision, comments=comments,
            ))
    changed_labels = [
        label for field, label in tracked_fields.items()
        if field in data and previous_values[field] != getattr(obj, field)
    ]
    if changed_labels:
        db.add(models.ApprovalAction(
            entity_type="TEST_CYCLE", entity_id=obj.id, step_name="Cycle Details",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Updated", comments=f"Updated: {', '.join(changed_labels)}.",
        ))
    if is_owner_reassignment:
        new_owner = db.query(models.User).get(obj.owner_id) if obj.owner_id else None
        reassignment.record_reassignment(
            db, "TEST_CYCLE", obj.id, current_user,
            previous_owner.full_name if previous_owner else "Unassigned",
            new_owner.full_name if new_owner else "Unassigned",
            owner_reason, step_name="Owner Reassignment",
        )
        if new_owner and new_owner.id != previous_owner_id:
            reassignment.notify_new_assignee(
                db, new_owner.id, "TEST_CYCLE", obj.id, obj.cycle_key,
                f"You have been assigned as owner of test cycle {obj.cycle_key}.", current_user.id,
            )
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/cycles/{cycle_id}/request-link", response_model=schemas.TestCycleOut)
def unlink_cycle_request(cycle_id: int, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, obj.project_id)
    require_can_execute_project(db, obj.project_id, current_user)
    _require_open_cycle(obj)
    link = obj.child_request_link
    if not link:
        raise HTTPException(404, "This test cycle does not have a linked request")
    child_type, child_id, child_key = link.child_type, link.child_id, link.child_key
    obj.child_request_link = None
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=obj.id, step_name="Request Link",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Request Unlinked", comments=f"Unlinked {child_type} request {child_key}",
    ))
    if child_type == "Functional":
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=child_id, step_name="Test Execution",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Test Cycle Unlinked", comments=f"Unlinked test cycle {obj.cycle_key} - {obj.name}",
        ))
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/cycles/{cycle_id}")
def delete_cycle(cycle_id: int, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Delete a Test Cycle. Governance is limited to the QA Lead Group
    (require_can_manage_execution_governance below rejects a plain
    QA_ENGINEER even though it passes this looser router-level check).

    2026-08 -- reported directly: "once execution history created then
    remove option should not be there for QA lead ... Administration can
    supersede everything." A QA Lead may only delete an EMPTY cycle (must
    remove every testcase slot first, via remove_execution/
    bulk_remove_executions -- itself now blocked per-slot once that slot has
    recorded history, see _require_can_remove_execution) -- unchanged, and
    already stricter than "once history exists" since it blocks on ANY
    slot being present, executed or not. An Administrator may override this
    and delete a non-empty cycle outright; doing so cascades to every
    execution slot, its full attempt history, and its evidence documents in
    one step (same cleanup bulk_remove_executions performs per-slot, applied
    to the whole cycle here), logged as a single audit row before the cycle
    itself is removed."""
    obj = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, obj.project_id)
    _require_open_cycle(obj)
    require_can_manage_execution_governance(db, obj.project_id, current_user)
    executions = db.query(models.TestExecution).filter_by(cycle_id=cycle_id).all()
    is_admin_override = bool(executions) and current_user.has_role(Role.ADMIN)
    if executions and not is_admin_override:
        raise HTTPException(
            400,
            f"Cannot delete this Test Cycle because it contains {len(executions)} test case execution record"
            f"{'s' if len(executions) != 1 else ''}. Remove the test cases from the cycle first."
        )
    documents_by_id = {}
    if is_admin_override:
        # Polymorphic documents have no FK back to TestExecution/
        # TestExecutionRun (see remove_execution's own comment on this) --
        # cleaned up explicitly for every execution in the cycle, same as a
        # per-slot removal, rather than orphaning screenshots on disk.
        for execution in executions:
            for run in execution.runs:
                for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id):
                    documents_by_id[document.id] = document
            for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, execution.id):
                documents_by_id[document.id] = document
        db.add(models.ApprovalAction(
            entity_type="TEST_CYCLE", entity_id=obj.id, step_name="Cycle Deletion",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Deleted (Administrator override)",
            comments=(
                f"{obj.cycle_key} - {obj.name} deleted with {len(executions)} test case execution record"
                f"{'s' if len(executions) != 1 else ''} and {len(documents_by_id)} evidence file"
                f"{'s' if len(documents_by_id) != 1 else ''} still attached, by Administrator override."
            ),
        ))
        for document in documents_by_id.values():
            db.delete(document)
    file_paths = [doc_store.full_path(document) for document in documents_by_id.values()]
    db.delete(obj)
    db.commit()
    # Database state is authoritative -- a stale/missing file is harmless and
    # must not turn a successfully committed deletion into a false API error.
    for path in file_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    return {"ok": True}


# ---- Executions (a test case's result within one cycle) ----
@router.get("/cycles/{cycle_id}/executions", response_model=pagination.Page[schemas.TestExecutionOut])
def list_executions(
    cycle_id: int,
    assignment: Optional[str] = Query(
        None, description="'mine', 'unassigned', or omitted for no extra assignment filter",
    ),
    params: pagination.PageParams = Depends(),
    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user),
):
    """SRS 7.2 pagination rollout -- was previously "every execution slot in
    the cycle" in one unpaginated call. `assignment` is a module-specific
    extra filter (like Test Cases' own `folder_id`/`tag`) resolved against
    the CURRENT user server-side, backing TestExecution.tsx's own "All /
    Mine / Unassigned" tab bar. See TestExecutionSummaryOut below for the
    progress bar / assignment stat / result tabs this list can no longer
    compute client-side from the complete cycle."""
    _get_cycle_or_404(db, cycle_id)
    q = db.query(models.TestExecution).filter(models.TestExecution.cycle_id == cycle_id).options(*_LIST_EXECUTION_EAGER_LOADS)
    if assignment == "mine":
        if not any(current_user.has_department(department) for department in TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS):
            raise HTTPException(403, "My execution assignments are restricted to the QA group")
        q = q.filter(models.TestExecution.assigned_to_id == current_user.id)
    elif assignment == "unassigned":
        q = q.filter(models.TestExecution.assigned_to_id.is_(None))
    q = pagination.apply_status_filter(q, params, models.TestExecution.status)
    q = pagination.apply_sort(
        q, params, sortable={"status": models.TestExecution.status},
        default_column=models.TestExecution.id, id_column=models.TestExecution.id,
    )
    result = pagination.paginate(q, params)
    return pagination.to_page_response(result, params)


@router.get("/cycles/{cycle_id}/executions/summary", response_model=schemas.TestExecutionSummaryOut)
def get_execution_summary(cycle_id: int, db: Session = Depends(get_db),
                           current_user: models.User = Depends(get_current_user)):
    """The progress bar, assignment stat, "My queue" count, the All/Mine/
    Unassigned tab bar, and the per-result-status tab bar all used to be
    computed in the browser from the complete (unpaginated) cycle execution
    list -- now that the main list above is paginated, none of those has
    enough data on hand any more. Computed via SQL COUNT/GROUP BY against
    the whole cycle regardless of which page/status/assignment filter the
    main list currently has selected -- never a full-row fetch."""
    _get_cycle_or_404(db, cycle_id)
    base = db.query(models.TestExecution).filter(models.TestExecution.cycle_id == cycle_id)
    total = base.count()
    status_counts = {
        status: count for status, count in
        db.query(models.TestExecution.status, func.count(models.TestExecution.id))
        .filter(models.TestExecution.cycle_id == cycle_id)
        .group_by(models.TestExecution.status).all()
    }
    executed_count = sum(count for status, count in status_counts.items() if status != "Not Executed")
    assigned_count = base.filter(models.TestExecution.assigned_to_id.isnot(None)).count()
    unassigned_count = total - assigned_count
    mine_count = base.filter(models.TestExecution.assigned_to_id == current_user.id).count()
    total_run_count = (
        db.query(func.count(models.TestExecutionRun.id))
        .join(models.TestExecution, models.TestExecution.id == models.TestExecutionRun.execution_id)
        .filter(models.TestExecution.cycle_id == cycle_id)
        .scalar()
    ) or 0
    return schemas.TestExecutionSummaryOut(
        total=total, status_counts=status_counts, executed_count=executed_count,
        assigned_count=assigned_count, unassigned_count=unassigned_count, mine_count=mine_count,
        total_run_count=total_run_count,
    )


@router.get("/executions/blocked-or-failed", response_model=List[schemas.DefectLinkableExecutionOut])
def list_blocked_failed_executions(db: Session = Depends(get_db),
                                    current_user: models.User = Depends(get_current_user)):
    """2026-08 -- reported directly: on Defect Management's page load, "if
    there are 30 project[s] then 30 api call[s] ... same for cycles,
    executions." Defects.tsx used to build its "pick a Failed/Blocked Test
    Execution" dropdown (for creating or linking a defect) by fetching every
    active project's cycles, then every one of THOSE cycles' Fail/Blocked
    executions, one round trip at a time -- N projects + N cycle-list calls +
    one execution-list call per cycle, scaling worse than linearly as the
    number of in-progress cycles grows. This single batch query replaces all
    of that: one SQL join across TestProject -> TestCycle -> TestExecution,
    filtered to active projects and Fail/Blocked status, scoped the same way
    every other cross-project list in this app is (deps.viewable_project_ids
    -- own department scope, widened by any 2026-08 "view-only access to
    department/user" CR grant).

    2026-08, further widened: Defect Management itself is no longer role-
    gated (see defects.py's own list_defects/defect_dashboard/export_defects
    and this router's own docstring update) -- open to any authenticated
    user, scoped by department exactly like every other module's register,
    so this picker only takes `get_current_user` too now rather than the
    retired DEFECT_MANAGEMENT_ROLES allow-list. Returns one flattened row
    per execution, each carrying its own project/cycle alongside it,
    mirroring the frontend's pre-existing `ExecutionContext` shape exactly
    so no consumer-side logic needs to change, only where the data comes
    from."""
    q = (
        db.query(models.TestExecution)
        .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
        .join(models.TestProject, models.TestCycle.project_id == models.TestProject.id)
        .filter(models.TestProject.is_active == True)  # noqa: E712
        .filter(models.TestExecution.status.in_(("Fail", "Blocked")))
        .options(
            joinedload(models.TestExecution.cycle).joinedload(models.TestCycle.project),
            *_LIST_EXECUTION_EAGER_LOADS,
        )
    )
    project_ids = viewable_project_ids(db, current_user)
    if project_ids is not None:
        q = q.filter(models.TestProject.id.in_(project_ids))
    executions = q.order_by(models.TestProject.id, models.TestCycle.id, models.TestExecution.id).all()
    return [
        {"project": execution.cycle.project, "cycle": execution.cycle, "execution": execution}
        for execution in executions
    ]


@router.get("/cycles/{cycle_id}/executions/case-ids", response_model=List[int])
def list_execution_case_ids(cycle_id: int, db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    """PAG-010 -- deliberately NOT paginated, same reasoning as Test Cases'
    own `/test-cases/all`. TestExecution.tsx's "Add test cases to cycle"
    picker needs the complete set of test_case_ids already in this cycle
    (to exclude them from the candidate pool), not one page of the full
    execution rows -- just the ids, so this is far cheaper than the main
    list endpoint above even at full cycle size."""
    _get_cycle_or_404(db, cycle_id)
    return [
        row[0] for row in
        db.query(models.TestExecution.test_case_id).filter(models.TestExecution.cycle_id == cycle_id).all()
    ]


@router.get("/executions/{execution_id}", response_model=schemas.TestExecutionOut)
def get_execution(execution_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """PAG-006-adjacent -- didn't exist before this pagination pass, because
    the list endpoint used to hand back every execution in the cycle at
    once so no caller ever needed to fetch just one by id. Now that the list
    is paginated, TestExecution.tsx's own `?execution=<id>` deep-link (from
    defect traceability) needs this to open a specific slot even when it
    isn't on whatever page happens to be loaded."""
    return _execution_or_404(db, execution_id)


@router.get("/cycles/{cycle_id}/export-xlsx")
def export_test_cycle(
    cycle_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Export one complete test lifecycle, including every retained run."""
    cycle = _get_cycle_or_404(db, cycle_id)
    project = _get_project_or_404(db, cycle.project_id)
    executions = (db.query(models.TestExecution).filter_by(cycle_id=cycle_id)
                  .order_by(models.TestExecution.id).all())

    folders = db.query(models.TestFolder).filter_by(project_id=project.id).all()
    folder_by_id = {folder.id: folder for folder in folders}

    def folder_path(folder_id):
        if not folder_id:
            return "Unfiled"
        parts, seen = [], set()
        current = folder_by_id.get(folder_id)
        while current and current.id not in seen:
            seen.add(current.id)
            parts.append(current.name)
            current = folder_by_id.get(current.parent_id)
        return " / ".join(reversed(parts)) or "Unfiled"

    real_run_ids = {run.id for execution in executions for run in execution.runs}
    legacy_execution_ids = {
        execution.id for execution in executions
        if not execution.runs and execution.status != "Not Executed"
    }
    evidence_keys = real_run_ids | legacy_execution_ids
    documents = []
    if evidence_keys:
        documents = (db.query(models.RequestDocument).filter(
            models.RequestDocument.module == _RESULT_IMAGE_MODULE,
            models.RequestDocument.request_id.in_(evidence_keys),
        ).order_by(models.RequestDocument.uploaded_at).all())
    docs_by_owner = {}
    for document in documents:
        docs_by_owner.setdefault(document.request_id, []).append(document)
    uploader_ids = {document.uploaded_by_id for document in documents if document.uploaded_by_id}
    uploader_names = {}
    if uploader_ids:
        uploader_names = {
            user.id: user.full_name
            for user in db.query(models.User).filter(models.User.id.in_(uploader_ids)).all()
        }

    actions = (db.query(models.ApprovalAction).filter_by(
        entity_type="TEST_CYCLE", entity_id=cycle.id,
    ).order_by(models.ApprovalAction.created_at).all())

    run_rows = []
    defect_rows = []
    evidence_rows = []
    for execution in executions:
        case = execution.test_case
        runs = list(execution.runs)
        if not runs and execution.status != "Not Executed":
            # Pre-attempt-history records are still retained in exports as a
            # clearly labelled legacy attempt instead of disappearing.
            run_rows.append([
                case.test_case_key, 1, execution.status, execution.actual_result,
                execution.test_run_artifacts, execution.defect_id,
                execution.executed_by_name, execution.executed_at,
                len(docs_by_owner.get(execution.id, [])),
                ", ".join(doc.file_name for doc in docs_by_owner.get(execution.id, [])),
                "Legacy current result (recorded before attempt history was enabled)",
            ])
            for document in docs_by_owner.get(execution.id, []):
                evidence_rows.append([
                    case.test_case_key, 1, document.file_name, document.content_type,
                    round((document.file_size or 0) / 1024, 2),
                    uploader_names.get(document.uploaded_by_id, "Unknown user"), document.uploaded_at,
                ])
        for run in runs:
            run_docs = docs_by_owner.get(run.id, [])
            structured_keys = ", ".join(defect.defect_key for defect in run.defects)
            run_rows.append([
                case.test_case_key, run.attempt_no, run.status, run.actual_result,
                run.test_run_artifacts, structured_keys or run.defect_id,
                run.executed_by_name, run.executed_at, len(run_docs),
                ", ".join(document.file_name for document in run_docs), "",
            ])
            for defect in run.defects:
                defect_rows.append([
                    case.test_case_key, run.attempt_no, defect.defect_key,
                    defect.defect_url, defect.title, defect.defect_status, defect.notes,
                    defect.linked_by_name, defect.created_at,
                ])
            for document in run_docs:
                evidence_rows.append([
                    case.test_case_key, run.attempt_no, document.file_name, document.content_type,
                    round((document.file_size or 0) / 1024, 2),
                    uploader_names.get(document.uploaded_by_id, "Unknown user"), document.uploaded_at,
                ])

    workbook = new_workbook()
    executed_count = sum(execution.status != "Not Executed" for execution in executions)
    pass_count = sum(execution.status in {"Pass", "Retest Passed"} for execution in executions)
    add_summary_sheet(
        workbook,
        f"{cycle.cycle_key} · Test Lifecycle",
        "Complete selected-cycle snapshot with assignments, attempts, evidence, and defect links.",
        [
            ("Cycle", cycle.name), ("Cycle ID", cycle.cycle_key),
            ("Project", f"{project.project_key} · {project.name}"), ("Cycle status", cycle.status),
            ("Start date", cycle.start_date or "—"), ("End date", cycle.end_date or "—"),
            ("Generated by", current_user.full_name), ("Generated at", models.now()),
        ],
        [
            ("Testcases", len(executions)), ("Executed", executed_count),
            ("Passed", pass_count),
            ("Failed", sum(execution.status == "Fail" for execution in executions)),
            ("Blocked", sum(execution.status == "Blocked" for execution in executions)),
            ("Unassigned", sum(not execution.assigned_to_id for execution in executions)),
            ("Attempts", len(run_rows)), ("Defect links", len(defect_rows)),
            ("Evidence files", len(evidence_rows)),
        ],
    )
    add_table_sheet(
        workbook, "Cycle Testcases", "Cycle Testcases", [
            "Test Case ID", "Version", "Folder Path", "Epic ID", "CR Number",
            "Feature ID", "User Story ID", "Test Type", "Module", "Priority",
            "Scenario", "Pre-Condition", "Latest Result", "Latest Actual Result",
            "Latest Artifact", "Latest Defect Summary", "Assigned To", "Assigned By",
            "Assigned At", "Last Runner", "Last Run At", "Attempt Count",
        ], [[
            execution.test_case.test_case_key, execution.test_case.version,
            folder_path(execution.test_case.folder_id), execution.test_case.epic_id,
            execution.test_case.cr_number, execution.test_case.feature_id,
            execution.test_case.user_story_id, execution.test_case.test_type,
            execution.test_case.module_name, execution.test_case.priority,
            execution.test_case.test_scenario, execution.test_case.pre_condition,
            execution.status, execution.actual_result, execution.test_run_artifacts,
            ", ".join(defect.defect_key for run in execution.runs for defect in run.defects)
            or execution.defect_id,
            execution.assigned_to_name, execution.assigned_by_name, execution.assigned_at,
            execution.executed_by_name, execution.executed_at,
            len(execution.runs) or (1 if execution.status != "Not Executed" else 0),
        ] for execution in executions],
        subtitle="One row per testcase slot; Latest Result mirrors the newest attempt.",
        wrap_headers={"Scenario", "Pre-Condition", "Latest Actual Result"},
        date_headers={"Assigned At", "Last Run At"}, status_headers={"Latest Result"},
        widths={"Scenario": 38, "Pre-Condition": 38, "Latest Actual Result": 48},
    )
    add_table_sheet(
        workbook, "Test Steps", "Test Steps", [
            "Test Case ID", "Version", "Step No", "Step", "Expected Result",
        ], [[
            execution.test_case.test_case_key, execution.test_case.version, step.step_no,
            step.step_text, step.expected_result,
        ] for execution in executions for step in execution.test_case.steps],
        subtitle="Definition used by each testcase in this cycle.",
        wrap_headers={"Step", "Expected Result"}, widths={"Step": 52, "Expected Result": 52},
    )
    add_table_sheet(
        workbook, "Execution Attempts", "Execution Attempt History", [
            "Test Case ID", "Attempt No", "Result", "Actual Result", "Artifact",
            "Defect Summary", "Executed By", "Executed At", "Evidence Count",
            "Evidence Files", "History Note",
        ], run_rows,
        subtitle="Every retained execution attempt; later retests never overwrite earlier results.",
        wrap_headers={"Actual Result", "Evidence Files", "History Note"},
        date_headers={"Executed At"}, status_headers={"Result"},
        widths={"Actual Result": 52, "Evidence Files": 38, "History Note": 40},
    )
    add_table_sheet(
        workbook, "Defect Links", "Structured Defect Links", [
            "Test Case ID", "Attempt No", "Defect Key", "Defect URL", "Title",
            "Defect Status", "Notes", "Linked By", "Linked At",
        ], defect_rows,
        subtitle="Defects are tied to the exact execution attempt where they were observed.",
        wrap_headers={"Title", "Notes"}, date_headers={"Linked At"},
        status_headers={"Defect Status"}, widths={"Defect URL": 42, "Notes": 48},
    )
    add_table_sheet(
        workbook, "Evidence Index", "Execution Evidence Index", [
            "Test Case ID", "Attempt No", "File Name", "Content Type", "Size (KB)",
            "Uploaded By", "Uploaded At",
        ], evidence_rows,
        subtitle="Evidence metadata index. Binary files remain protected in the portal.",
        date_headers={"Uploaded At"}, widths={"File Name": 42, "Content Type": 24},
    )
    add_table_sheet(
        workbook, "Cycle Activity", "Cycle Activity History", [
            "Activity", "Decision", "Actor", "Role Snapshot", "Comments", "Timestamp",
        ], [[
            action.step_name, action.decision, action.actor_name or "System",
            action.actor_role, action.comments, action.created_at,
        ] for action in actions],
        subtitle="Assignments, execution actions, defect links, and membership changes.",
        wrap_headers={"Comments"}, date_headers={"Timestamp"}, status_headers={"Decision"},
        widths={"Comments": 56, "Role Snapshot": 28},
    )
    return workbook_response(workbook, f"{cycle.cycle_key}_test_lifecycle.xlsx")


@router.post("/cycles/{cycle_id}/executions", response_model=List[schemas.TestExecutionOut])
def add_test_cases_to_cycle(cycle_id: int, payload: schemas.TestExecutionAdd, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Adds one or more existing Repository test cases to this cycle,
    creating a Not-Executed TestExecution row for each -- silently skips any
    that are already in this cycle (the (cycle_id, test_case_id) unique
    constraint means re-adding one would otherwise 500)."""
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    _require_scope_change_permission(db, cycle, current_user)
    assigned_runner = None
    if payload.assigned_to_id is not None:
        _require_qa_assignment_manager(current_user)
        assigned_runner = _runner_or_404(db, payload.assigned_to_id)
    already = {
        e.test_case_id for e in
        db.query(models.TestExecution.test_case_id).filter_by(cycle_id=cycle_id).all()
    }
    requested_ids = list(dict.fromkeys(payload.test_case_ids))
    # Do not put the whole UI selection into one IN clause: Oracle limits an
    # IN expression to 1,000 values (ORA-01795). Query bounded batches and
    # merge them into the same identity map used by the validation/creation
    # logic below. Eager-loading the approved version also prevents one lazy
    # SELECT per selected case during eligibility validation.
    selected_cases = []
    for id_batch in _in_batches(requested_ids):
        selected_cases.extend(
            db.query(models.TestCase)
            .options(joinedload(models.TestCase.current_approved_version))
            .filter(
                models.TestCase.project_id == cycle.project_id,
                models.TestCase.id.in_(id_batch),
            )
            .all()
        )
    selected_by_id = {case.id: case for case in selected_cases}
    missing = [case_id for case_id in requested_ids if case_id not in selected_by_id]
    if missing:
        raise HTTPException(404, f"{len(missing)} selected test case(s) were not found in this project")
    # SRS CYC-003 "Only approved, non-archived testcase versions... shall be
    # selectable for a new cycle item." A case whose approved baseline has
    # itself been Archived (TC-006) is excluded even though
    # current_approved_version_id is still set -- Archived is reachable only
    # from Approved, so this also naturally excludes a case that was never
    # approved at all (current_approved_version stays None).
    not_selectable = [
        case.test_case_key for case in selected_cases
        if not case.current_approved_version or case.current_approved_version.status != "Approved"
    ]
    if not_selectable:
        preview = ", ".join(not_selectable[:5])
        suffix = "…" if len(not_selectable) > 5 else ""
        raise HTTPException(
            400,
            f"Cannot add {len(not_selectable)} test case(s) because they have no Approved, "
            f"non-archived version: {preview}{suffix}",
        )
    created = []
    for case_id in requested_ids:
        if case_id in already:
            continue
        case = selected_by_id[case_id]
        obj = models.TestExecution(
            cycle_id=cycle_id, test_case_id=case_id, status="Not Executed",
            # SRS CYC-004 "Each cycle item shall store the exact
            # TestCaseVersion ID selected at the time it is added."
            pinned_version_id=case.current_approved_version_id,
            assigned_to_id=assigned_runner.id if assigned_runner else None,
            assigned_by_id=current_user.id if assigned_runner else None,
            assigned_at=models.now() if assigned_runner else None,
            # Scenario 1 self-remove fix -- see _execution_removal_block_
            # reason below for how this is used.
            added_by_id=current_user.id,
        )
        db.add(obj)
        created.append(obj)
        already.add(case_id)
    for execution in created:
        db.add(models.ApprovalAction(
            entity_type="TEST_CASE", entity_id=execution.test_case_id, step_name="Test Cycle",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Added to Cycle",
            comments=(
                f"Added to {cycle.cycle_key} - {cycle.name}."
                + (f" Assigned to {assigned_runner.full_name}." if assigned_runner else "")
            ),
        ))
    db.commit()
    if not created:
        return []
    # Perf tuning (2026-08, reported directly: "if i have 3500 testcase
    # present, then it's allowing all in one go, then application going to
    # loading stage and though it's completing the process still getting
    # timeout error") -- this used to be `for obj in created: db.refresh(obj)`,
    # one individual SELECT per created row just to repopulate server-side
    # defaults after commit, PLUS response_model serialization then lazily
    # loaded test_case/assigned_to/assigned_by/executed_by/added_by/runs/
    # linked_defects on top of that (no eager-loading at all) -- for a
    # 3,500-testcase selection that was on the order of 3,500+ extra
    # queries, comfortably enough to blow past api.ts's request timeout even
    # though the transaction itself had already committed successfully
    # (matching what was reported: the add completes, but the UI times out
    # anyway). Replaced with one Oracle-safe batched requery using the same
    # eager-load set list_executions itself uses, so this response costs a
    # small constant number of queries regardless of selection size.
    created_ids = [obj.id for obj in created]
    refreshed = []
    for id_batch in _in_batches(created_ids):
        refreshed.extend(
            db.query(models.TestExecution)
            .options(*_LIST_EXECUTION_EAGER_LOADS)
            .filter(models.TestExecution.id.in_(id_batch))
            .all()
        )
    order = {execution_id: index for index, execution_id in enumerate(created_ids)}
    refreshed.sort(key=lambda execution: order[execution.id])
    return refreshed


@router.patch("/executions/{execution_id}/assign", response_model=schemas.TestExecutionOut)
def assign_execution(execution_id: int, payload: schemas.TestExecutionAssign,
                     db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """COE - Quality Assurance runner management for one testcase slot in a
    cycle.

    2026-08 Reassignment CR, reported directly: "Everywhere the system
    provides an Assign option ... it must also provide a Reassign option
    ... Reassignment shall be permitted to: the current assignee, the
    Department Head of the department to which the current assignee
    belongs, or Admin users." Then, reported directly again: "for test
    execution reassignment of testcase can be perform by any QA user,
    otherwise it will be hectic for qa lead" -- unlike Functional/
    Performance tester and SAST/DAST analyst reassignment (which do apply
    the CR's narrower list, now widened back to also include QA_LEAD),
    runner reassignment here stays on the SAME broad gate as the first
    assignment (_require_qa_assignment_manager -- any Test Management
    execution-role member in an eligible department), for both first
    assignment and reassignment; a reason is still mandatory once the
    execution already has a runner. Deliberately covers explicit
    unassignment too, not just a hand-off to a named person, so the
    reason requirement can't be bypassed by unassigning and having someone
    else assign fresh."""
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    previous_id = obj.assigned_to_id
    previous_name = obj.assigned_to_name
    is_reassignment = previous_id is not None
    _require_qa_assignment_manager(current_user)
    if is_reassignment:
        reassignment.require_reason(payload.reason)
    target = None
    if payload.assigned_to_id is not None:
        target = _runner_or_404(db, payload.assigned_to_id)
    obj.assigned_to_id = target.id if target else None
    obj.assigned_by_id = current_user.id
    obj.assigned_at = models.now()
    test_case_label = obj.test_case.test_case_key if obj.test_case else f"Testcase #{obj.test_case_id}"
    db.add(models.ApprovalAction(
        entity_type="TEST_CASE", entity_id=obj.test_case_id, step_name="Testcase Assignment",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Assigned" if target else "Unassigned",
        comments=(
            f"{test_case_label} "
            f"{'assigned to ' + target.full_name if target else 'unassigned'}"
            + (f" (previously {previous_name})" if previous_name else "")
        ),
    ))
    if is_reassignment:
        reassignment.record_reassignment(
            db, "TEST_CASE", obj.test_case_id, current_user,
            previous_name or "Unassigned", target.full_name if target else "Unassigned", payload.reason,
        )
        if target and target.id != previous_id:
            reassignment.notify_new_assignee(
                db, target.id, "TEST_CASE", obj.test_case_id, test_case_label,
                f"You have been assigned to run {test_case_label} in {cycle.cycle_key}.", current_user.id,
            )
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/cycles/{cycle_id}/executions/bulk-assign", response_model=List[schemas.TestExecutionOut])
def bulk_assign_executions(cycle_id: int, payload: schemas.TestExecutionBulkAssign,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Atomically assign one runner to selected testcase slots in a cycle.

    2026-08 Reassignment CR, then reported directly again ("for test
    execution reassignment of testcase can be perform by any QA user,
    otherwise it will be hectic for qa lead") -- same broad
    _require_qa_assignment_manager gate for both first assignment and
    reassignment (see assign_execution's own docstring for the full
    reasoning); a reason is mandatory the moment any selected row already
    has a runner, checked per-row since a batch can freely mix currently-
    unassigned and currently-assigned executions.
    """
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    _require_qa_assignment_manager(current_user)

    execution_ids = list(dict.fromkeys(payload.execution_ids))
    if not execution_ids:
        raise HTTPException(400, "Select at least one testcase for bulk assignment")
    if len(execution_ids) > 100:
        raise HTTPException(400, "Bulk assignment supports at most 100 testcases at a time")
    target = _runner_or_404(db, payload.assigned_to_id)
    executions = db.query(models.TestExecution).filter(models.TestExecution.id.in_(execution_ids)).all()
    found_by_id = {execution.id: execution for execution in executions}
    missing = [str(execution_id) for execution_id in execution_ids if execution_id not in found_by_id]
    if missing:
        raise HTTPException(404, f"Execution record(s) not found: {', '.join(missing)}")
    wrong_cycle = [execution for execution in executions if execution.cycle_id != cycle_id]
    if wrong_cycle:
        raise HTTPException(400, "Every selected testcase must belong to the current Test Cycle")

    ordered = [found_by_id[execution_id] for execution_id in execution_ids]
    previously_assigned = [execution for execution in ordered if execution.assigned_to_id is not None]
    if previously_assigned:
        reassignment.require_reason(payload.reason)

    previous_names = {execution.id: execution.assigned_to_name for execution in ordered}
    for execution in ordered:
        execution.assigned_to_id = target.id
        execution.assigned_by_id = current_user.id
        execution.assigned_at = models.now()
    labels = [
        execution.test_case.test_case_key if execution.test_case else f"Testcase #{execution.test_case_id}"
        for execution in ordered
    ]
    for execution, label in zip(ordered, labels):
        db.add(models.ApprovalAction(
            entity_type="TEST_CASE", entity_id=execution.test_case_id, step_name="Testcase Assignment",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Assigned",
            comments=f"{label} assigned to {target.full_name} in {cycle.cycle_key}.",
        ))
        if execution.id in {e.id for e in previously_assigned}:
            reassignment.record_reassignment(
                db, "TEST_CASE", execution.test_case_id, current_user,
                previous_names[execution.id] or "Unassigned", target.full_name, payload.reason,
            )
    db.commit()
    for execution in ordered:
        db.refresh(execution)
    return ordered


@router.post("/executions/{execution_id}/upgrade-version", response_model=schemas.TestExecutionOut)
def upgrade_execution_version(execution_id: int, payload: schemas.TestExecutionVersionUpgrade,
                              db: Session = Depends(get_db),
                              current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """SRS CYC-006 "An authorized user may upgrade an unexecuted cycle item
    to a newer approved version after reviewing a change summary. Executed
    items shall remain pinned." Rejected once any attempt exists (use
    versions-compare in test_repository.py to build the "change summary"
    the SRS describes -- this endpoint only performs the pin change itself
    once the caller has reviewed it)."""
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    if obj.runs:
        raise HTTPException(400, "This testcase has already been executed in this cycle -- its pinned version cannot change")
    target = db.query(models.TestCaseVersion).get(payload.target_version_id)
    if not target or target.test_case_id != obj.test_case_id:
        raise HTTPException(404, "Target version not found on this testcase")
    if target.status != "Approved":
        raise HTTPException(400, "Only an Approved version can be pinned to a cycle item")
    previous_label = obj.pinned_version_label
    obj.pinned_version_id = target.id
    db.add(models.ApprovalAction(
        entity_type="TEST_CASE", entity_id=obj.test_case_id, step_name="Version Upgrade",
        actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Version Upgraded",
        comments=(
            f"{obj.test_case.test_case_key if obj.test_case else f'Testcase #{obj.test_case_id}'} "
            f"pinned version upgraded from {previous_label or 'none'} to {target.version}."
        ),
    ))
    db.commit()
    db.refresh(obj)
    return obj


@router.patch("/executions/{execution_id}", response_model=schemas.TestExecutionOut)
def update_execution(execution_id: int, payload: schemas.TestExecutionUpdate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Records a new execution attempt (see models.TestExecutionRun) --
    reported directly, this used to overwrite the row's own result in
    place, silently destroying any prior attempt (e.g. a Fail with attached
    evidence, once a later retest logged a Pass)."""
    obj = _execution_or_404(db, execution_id)
    defect_key, _ = _validate_defect_values(payload.defect_id or "")
    _prepare_execution_update(db, obj, payload.status, current_user, defect_key)
    if payload.expected_run_version is not None and payload.expected_run_version != (obj.run_version or 0):
        raise HTTPException(
            409,
            "This testcase's result was updated by someone else since you loaded it. "
            "Refresh and try again.",
        )
    if defect_key and payload.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    run = _record_attempt(db, obj, payload.status, payload.actual_result,
                          payload.test_run_artifacts, defect_key or None, current_user)
    if defect_key:
        _link_defect(db, run, schemas.TestRunDefectCreate(defect_key=defect_key), current_user)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/cycles/{cycle_id}/executions/bulk-result", response_model=List[schemas.TestExecutionOut])
def bulk_update_execution_results(
    cycle_id: int,
    payload: schemas.TestExecutionBulkResult,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*_EXEC_ROLES)),
):
    """Record one new attempt on every selected testcase slot.

    Validation deliberately finishes for the whole selection before the
    first attempt is written. This prevents a bulk action from reporting a
    vague partial success and preserves the existing assigned-runner rule.
    """
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    _require_cycle_in_progress(cycle)
    execution_ids = list(dict.fromkeys(payload.execution_ids))
    if not execution_ids:
        raise HTTPException(400, "Select at least one testcase for bulk execution")
    if len(execution_ids) > 100:
        raise HTTPException(400, "Bulk execution supports at most 100 testcases at a time")

    from ..constants import TEST_EXECUTION_STATUSES
    if payload.status not in TEST_EXECUTION_STATUSES or payload.status == "Not Executed":
        raise HTTPException(400, f"'{payload.status}' is not a recordable execution result")

    actual_result = (payload.actual_result or "").strip()
    artifacts = (payload.test_run_artifacts or "").strip()
    if len(actual_result) > 10000:
        raise HTTPException(400, "Actual Result cannot exceed 10,000 characters")
    if len(artifacts) > 255:
        raise HTTPException(400, "Test Run Artifacts cannot exceed 255 characters")
    defect_key, defect_url = _validate_defect_values(payload.defect_id or "", payload.defect_url or "")
    if defect_key and payload.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    if not defect_key and any((value or "").strip() for value in (
        payload.defect_url, payload.defect_title, payload.defect_status, payload.defect_notes,
    )):
        raise HTTPException(400, "Enter a Defect Key before adding defect URL, title, status, or notes")
    if len((payload.defect_title or "").strip()) > 255:
        raise HTTPException(400, "Defect title cannot exceed 255 characters")
    if len((payload.defect_status or "").strip()) > 40:
        raise HTTPException(400, "Defect status cannot exceed 40 characters")
    if len((payload.defect_notes or "").strip()) > 5000:
        raise HTTPException(400, "Defect notes cannot exceed 5,000 characters")

    found = db.query(models.TestExecution).filter(models.TestExecution.id.in_(execution_ids)).all()
    found_by_id = {execution.id: execution for execution in found}
    missing = [str(execution_id) for execution_id in execution_ids if execution_id not in found_by_id]
    if missing:
        raise HTTPException(
            404,
            f"Bulk execution stopped. Execution record(s) not found: {', '.join(missing)}. No attempt was saved.",
        )
    wrong_cycle = [
        execution for execution in found
        if execution.cycle_id != cycle_id
    ]
    if wrong_cycle:
        labels = ", ".join(
            execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            for execution in wrong_cycle
        )
        raise HTTPException(
            400,
            f"Bulk execution stopped. These testcases do not belong to the selected cycle: {labels}. No attempt was saved.",
        )

    ordered = [found_by_id[execution_id] for execution_id in execution_ids]
    unpinned = [
        execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
        for execution in ordered if not execution.pinned_version_id
    ]
    if unpinned:
        raise HTTPException(
            400,
            "Bulk execution stopped. These testcase slots have no pinned approved version: "
            f"{', '.join(unpinned)}. No attempt was saved.",
        )

    # Same lock/gate as the single-execution path (see
    # _execution_status_gate) -- checked for the whole selection up front so
    # a bulk status change either fully succeeds or saves nothing.
    defect_blocked = []
    for execution in ordered:
        violation = _execution_status_gate(db, execution.id, payload.status, defect_key)
        if violation:
            label = execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            defect_blocked.append(f"{label} ({violation})")
    if defect_blocked:
        raise HTTPException(
            400,
            f"Bulk execution stopped. Cannot record '{payload.status}': "
            f"{'; '.join(defect_blocked)}. No attempt was saved.",
        )

    if not current_user.has_role(Role.ADMIN):
        unassigned = [
            execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            for execution in ordered if not execution.assigned_to_id
        ]
        assigned_elsewhere = [
            f"{execution.test_case.test_case_key if execution.test_case else f'Execution #{execution.id}'} "
            f"({execution.assigned_to_name or 'another runner'})"
            for execution in ordered
            if execution.assigned_to_id and execution.assigned_to_id != current_user.id
        ]
        blockers = []
        if unassigned:
            blockers.append(f"unassigned: {', '.join(unassigned)}")
        if assigned_elsewhere:
            blockers.append(f"assigned to another runner: {', '.join(assigned_elsewhere)}")
        if blockers:
            raise HTTPException(
                403,
                "Bulk execution stopped because only the assigned runner can record an attempt; "
                + "; ".join(blockers)
                + ". Reassign those testcases or select only your assignments. No attempt was saved.",
            )

    for execution in ordered:
        run = _record_attempt(
            db, execution, payload.status, actual_result or None, artifacts or None,
            defect_key or None, current_user,
        )
        if defect_key:
            _link_defect(db, run, schemas.TestRunDefectCreate(
                defect_key=defect_key,
                defect_url=defect_url or None,
                title=(payload.defect_title or "").strip() or None,
                defect_status=(payload.defect_status or "").strip() or None,
                notes=(payload.defect_notes or "").strip() or None,
            ), current_user)

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    for execution in ordered:
        db.refresh(execution)
    return ordered


@router.post("/executions/{execution_id}/rich-result", response_model=schemas.TestExecutionOut)
def update_rich_execution_result(
    execution_id: int,
    status_value: str = Form(..., alias="status"),
    actual_result: str = Form(""),
    test_run_artifacts: str = Form(""),
    defect_id: str = Form(""),
    defect_url: str = Form(""),
    defect_title: str = Form(""),
    defect_status: str = Form(""),
    defect_notes: str = Form(""),
    files: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*_EXEC_ROLES)),
):
    """Save formatted Actual Result text and pasted/uploaded screenshots as a
    new execution attempt (see models.TestExecutionRun) -- reported
    directly, this used to overwrite the row's own result in place,
    silently destroying any prior attempt (e.g. a Fail with attached
    evidence, once a later retest logged a Pass).

    Text is retained as safe Markdown; images are authenticated documents
    linked to this exact attempt (not the execution slot as a whole), never
    embedded as unbounded base64 data.
    """
    obj = _execution_or_404(db, execution_id)
    defect_key, validated_defect_url = _validate_defect_values(defect_id, defect_url)
    _prepare_execution_update(db, obj, status_value, current_user, defect_key)
    result_text = actual_result.strip()
    if len(result_text) > 10000:
        raise HTTPException(400, "Actual Result cannot exceed 10,000 characters")
    _validate_result_images(files)
    if defect_key and status_value not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    if not defect_key and any(value.strip() for value in (defect_url, defect_title, defect_notes)):
        raise HTTPException(400, "Enter a Defect Key before adding defect URL, title, or notes")
    run = _record_attempt(db, obj, status_value, result_text or None,
                           test_run_artifacts.strip() or None, defect_key or None, current_user)
    if defect_key:
        _link_defect(db, run, schemas.TestRunDefectCreate(
            defect_key=defect_key, defect_url=validated_defect_url or None,
            title=defect_title or None, defect_status=defect_status or None,
            notes=defect_notes or None,
        ), current_user)
    if files:
        # save_documents commits the pending execution/run update and
        # document metadata in the same DB transaction after the files are
        # written. Keyed by this specific attempt's own id (run.id), not
        # the execution slot's id, so each attempt's evidence stays separate.
        doc_store.save_documents(
            db, _RESULT_IMAGE_MODULE, run.id, f"execution-{obj.id}-attempt-{run.attempt_no}", files, current_user.id
        )
    else:
        db.commit()
    db.refresh(obj)
    return obj


@router.get("/executions/{execution_id}/runs", response_model=List[schemas.TestExecutionRunOut])
def list_execution_runs(execution_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Full attempt-by-attempt history for this test case's slot in this
    cycle, oldest first -- see models.TestExecutionRun."""
    obj = _execution_or_404(db, execution_id)
    return (db.query(models.TestExecutionRun).filter_by(execution_id=obj.id)
            .order_by(models.TestExecutionRun.attempt_no).all())


@router.post("/executions/{execution_id}/runs/{run_id}/defects", response_model=schemas.TestRunDefectOut)
def add_run_defect(execution_id: int, run_id: int, payload: schemas.TestRunDefectCreate,
                   db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    _require_assigned_runner(obj, current_user)
    run = _run_or_404(db, obj, run_id)
    latest_run = _latest_run_or_404(db, obj)
    if run.id != latest_run.id:
        raise HTTPException(400, "Defects can only be linked to the latest execution attempt")
    if run.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    defect = _link_defect(db, run, payload, current_user)
    db.commit()
    db.refresh(defect)
    return defect


@router.delete("/executions/{execution_id}/runs/{run_id}/defects/{defect_id}")
def remove_run_defect(execution_id: int, run_id: int, defect_id: int,
                      db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    run = _run_or_404(db, obj, run_id)
    defect = db.query(models.TestRunDefect).filter_by(id=defect_id, run_id=run.id).first()
    if not defect:
        raise HTTPException(404, "Defect link not found")
    if not (current_user.has_role(Role.QA_LEAD) or defect.linked_by_id == current_user.id):
        raise HTTPException(403, "Only the person who linked this defect, a QA Lead, or an Administrator can remove it")
    db.add(models.ApprovalAction(
        entity_type="TEST_CASE", entity_id=obj.test_case_id,
        step_name=f"Attempt #{run.attempt_no} Defect",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Defect Unlinked",
        comments=f"Unlinked defect {defect.defect_key} from execution attempt #{run.attempt_no}.",
    ))
    db.delete(defect)
    db.commit()
    return {"ok": True}


@router.get("/executions/{execution_id}/runs/{run_id}/images", response_model=List[schemas.RequestDocumentOut])
def list_run_images(execution_id: int, run_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = _run_or_404(db, obj, run_id)
    return doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id)


@router.get("/executions/{execution_id}/runs/{run_id}/images/{document_id}/download")
def download_run_image(execution_id: int, run_id: int, document_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = _run_or_404(db, obj, run_id)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
    path = doc_store.full_path(document)
    if not os.path.exists(path):
        raise HTTPException(404, "Actual Result image is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")


@router.delete("/executions/{execution_id}/runs/{run_id}/images/{document_id}")
def delete_run_image(execution_id: int, run_id: int, document_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    run = _run_or_404(db, obj, run_id)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
    if not doc_store.can_delete_document(document, current_user):
        raise HTTPException(403, "Only the person who uploaded this image or an Administrator can delete it")
    doc_store.delete_document(db, document)
    return {"ok": True}


# ---- Backward-compatible "current result images" endpoints -- these now
# resolve to the LATEST attempt's evidence (see _latest_run_or_404), since
# result-recording itself moved from "the one and only result" to
# "attempt N of the history below" (models.TestExecutionRun). Prefer the
# /runs/{run_id}/images endpoints above for browsing a *specific* attempt's
# evidence instead of just the newest one. ----
@router.get("/executions/{execution_id}/result-images", response_model=List[schemas.RequestDocumentOut])
def list_result_images(execution_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = (db.query(models.TestExecutionRun).filter_by(execution_id=obj.id)
           .order_by(models.TestExecutionRun.attempt_no.desc()).first())
    if not run:
        return []
    return doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id)


@router.get("/executions/{execution_id}/result-images/{document_id}/download")
def download_result_image(execution_id: int, document_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = _latest_run_or_404(db, obj)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
    path = doc_store.full_path(document)
    if not os.path.exists(path):
        raise HTTPException(404, "Actual Result image is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")


@router.delete("/executions/{execution_id}/result-images/{document_id}")
def delete_result_image(execution_id: int, document_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    require_can_execute_project(db, cycle.project_id, current_user)
    _require_open_cycle(cycle)
    run = _latest_run_or_404(db, obj)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
    if not doc_store.can_delete_document(document, current_user):
        raise HTTPException(403, "Only the person who uploaded this image or an Administrator can delete it")
    doc_store.delete_document(db, document)
    return {"ok": True}


@router.delete("/executions/{execution_id}")
def remove_execution(execution_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(
                          require_roles(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA))):
    """Removes a test case from a cycle entirely (not the same as recording
    a result) -- e.g. it was added by mistake.

    2026-08 -- reported directly, refined by Scenario 1: QA Lead Group may
    always remove a not-yet-executed slot; a plain QA_ENGINEER may only
    remove one they personally added to the cycle (TestExecution.
    added_by_id), and only before it's been executed. Once a slot has any
    recorded attempt, only an Administrator may remove it, regardless of who
    added it or QA Lead standing -- see _execution_removal_block_reason's
    own docstring for the full priority order."""
    obj = db.query(models.TestExecution).get(execution_id)
    if not obj:
        raise HTTPException(404, "Execution not found")
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    _require_open_cycle(cycle)
    _require_can_remove_execution(obj, current_user)
    # Polymorphic documents have no FK back to TestExecution/TestExecutionRun,
    # so remove the protected files and their metadata explicitly rather than
    # orphaning screenshots when the execution itself is deliberately
    # removed -- every attempt's own evidence (models.TestExecutionRun), not
    # just the legacy execution-keyed slot from before per-attempt history
    # existed.
    for run in obj.runs:
        for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id):
            doc_store.delete_document(db, document)
    for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, obj.id):
        doc_store.delete_document(db, document)
    db.delete(obj)
    db.commit()
    return {"ok": True}


@router.post("/cycles/{cycle_id}/executions/bulk-remove", response_model=schemas.TestExecutionBulkRemoveResult)
def bulk_remove_executions(
    cycle_id: int,
    payload: schemas.TestExecutionBulkRemove,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)),
):
    """Remove several testcase slots, their attempts, linked defects and
    evidence metadata from one cycle as one governed database transaction.

    2026-08 -- reported directly, refined by Scenario 1: same per-execution
    eligibility as remove_execution above (see _execution_removal_block_
    reason) -- QA Lead Group may remove any not-yet-executed slot, a plain
    QA_ENGINEER only one they personally added, Admin always. Any selected
    slot the caller isn't eligible to remove stops the WHOLE batch below
    (all-or-nothing, matching this codebase's established atomic
    bulk-endpoint convention -- see _selected_project_cases in
    test_repository.py for the same pattern; the frontend is expected to
    have already filtered the selection down to what it knows is eligible,
    same "safety net, not primary UX path" reasoning used throughout). Files
    are unlinked only after the database commit succeeds, so a failed
    transaction cannot leave retained rows pointing at evidence that was
    already destroyed.
    """
    _require_qa_assignment_manager(current_user)
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    _require_open_cycle(cycle)
    execution_ids = list(dict.fromkeys(payload.execution_ids))
    if not execution_ids:
        raise HTTPException(400, "Select at least one testcase to remove from the cycle")
    if len(execution_ids) > 100:
        raise HTTPException(400, "Bulk removal supports at most 100 testcases at a time")

    found = db.query(models.TestExecution).filter(models.TestExecution.id.in_(execution_ids)).all()
    found_by_id = {execution.id: execution for execution in found}
    missing = [str(execution_id) for execution_id in execution_ids if execution_id not in found_by_id]
    if missing:
        raise HTTPException(
            404,
            f"Bulk removal stopped. Execution record(s) not found: {', '.join(missing)}. Nothing was removed.",
        )
    ordered = [found_by_id[execution_id] for execution_id in execution_ids]
    wrong_cycle = [execution for execution in ordered if execution.cycle_id != cycle_id]
    if wrong_cycle:
        labels = ", ".join(
            execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            for execution in wrong_cycle
        )
        raise HTTPException(
            400,
            f"Bulk removal stopped. These testcases do not belong to the selected cycle: {labels}. Nothing was removed.",
        )
    ineligible = [
        (execution, reason) for execution in ordered
        if (reason := _execution_removal_block_reason(execution, current_user))
    ]
    if ineligible:
        labels = ", ".join(
            execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            for execution, _reason in ineligible[:5]
        )
        suffix = f" and {len(ineligible) - 5} more" if len(ineligible) > 5 else ""
        raise HTTPException(
            403,
            f"Bulk removal stopped. These testcase(s) cannot be removed by you right now: {labels}{suffix}. "
            "Nothing was removed.",
        )

    removed_keys = [
        execution.test_case.test_case_key if execution.test_case else f"Testcase #{execution.test_case_id}"
        for execution in ordered
    ]
    # Capture cascade impact before deleting the execution rows. The result
    # response reports this value after commit, when the ORM collections may
    # already be expired/deleted.
    removed_attempt_count = sum(len(execution.runs) for execution in ordered)
    documents_by_id = {}
    for execution in ordered:
        # Current evidence belongs to individual TestExecutionRun rows. The
        # execution-id lookup also includes screenshots created by the older
        # pre-attempt implementation. De-duplicate because numeric ids from
        # those two namespaces can coincide.
        for run in execution.runs:
            for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id):
                documents_by_id[document.id] = document
        for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, execution.id):
            documents_by_id[document.id] = document

    file_paths = [doc_store.full_path(document) for document in documents_by_id.values()]
    for execution, test_case_key in zip(ordered, removed_keys):
        db.add(models.ApprovalAction(
            entity_type="TEST_CASE", entity_id=execution.test_case_id, step_name="Test Cycle",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Removed from Cycle",
            comments=f"{test_case_key} removed from {cycle.cycle_key} - {cycle.name}.",
        ))
    for document in documents_by_id.values():
        db.delete(document)
    for execution in ordered:
        db.delete(execution)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Database state is authoritative. A stale/missing file is harmless and
    # must not turn a successfully committed removal into a false API error.
    for path in file_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    return schemas.TestExecutionBulkRemoveResult(
        removed_count=len(ordered),
        removed_execution_ids=execution_ids,
        removed_test_case_keys=removed_keys,
        removed_attempt_count=removed_attempt_count,
        removed_evidence_count=len(documents_by_id),
    )
