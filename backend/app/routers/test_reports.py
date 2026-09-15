"""Test Management Revamp -- section 11 "Reporting Requirements".

Five report views, each documenting its own population/exclusions/date
basis inline in a `population_note` string on its response (RPT-001) --
deliberately not a separate config table, since the population rules below
are fixed logic, not something an admin needs to tune per environment.

RPT-002 "Counts shall link to the filtered underlying records" -- every
grouped row below carries a `filters` object describing exactly which
query parameters the existing list endpoints (test_repository.py's
list_test_cases, test_execution.py's list_executions, etc.) need to
reproduce that exact slice client-side; this router itself only returns
aggregates, never the underlying rows, keeping payloads small.

RPT-003 "Reports for a closed cycle shall use pinned versions and immutable
attempts" -- structurally already true everywhere below: every executed-item
metric reads TestExecution.pinned_version_id / TestExecutionRun (both
immutable once written, see models.py's own docstrings), never the live,
possibly-since-edited TestCase content.

Every endpoint declares a typed Pydantic `response_model` (schemas.py's
"Test Management Reporting" section) -- same contract discipline as every
other router in this app; FastAPI validates and filters each response
against it, so a query bug that accidentally leaks an untyped/extra field
is caught rather than silently reaching the frontend.

List-shaped reports (version impact) are paginated with
`limit`/`offset` query parameters, matching the app-wide "database
pagination... for high-volume lists" NFR (SRS section 12) -- each response
reports both `total_items` (full population size before paging) and
`returned_items` (this page's size) so the frontend can render an accurate
page control.
"""
import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from .. import models, schemas
from ..database import get_db
from ..deps import (
    get_current_user, viewable_project_ids,
    get_project_or_404 as _get_project_or_404, require_project_visibility,
)
from ..constants import TEST_CYCLE_LOCKED_STATUSES
from ..xlsx_export import add_summary_sheet, add_table_sheet, new_workbook, workbook_response

router = APIRouter(prefix="/api/test-reports", tags=["test-management"])

# Default/maximum page size for this router's list-shaped reports. Smaller
# default than the app-wide "five items per page" REP-004 convention on
# purpose -- these are analyst-facing aggregate views, not the primary
# Repository/My Executions worklists REP-004/EXE-002 describe, so a larger
# default page is a reasonable, explicitly-bounded departure from it.
_DEFAULT_PAGE_SIZE = 50
_MAX_PAGE_SIZE = 500


def _traceability_value(source, field: str) -> Optional[str]:
    """Normalize an optional requirement value without inventing a label."""
    value = getattr(source, field, None)
    return str(value).strip() if value is not None and str(value).strip() else None


def _traceability_source(test_case: models.TestCase, pinned_version: Optional[models.TestCaseVersion]):
    """Executed rows must describe the immutable version actually run."""
    return pinned_version or test_case


def _active_test_case_predicate():
    """Oracle stores Boolean as NUMBER(1), so it requires ``= 0`` here."""
    return models.TestCase.is_deleted == False  # noqa: E712 - Oracle rejects IS 0


def _defect_trace_keys(defect: models.Defect) -> tuple[list[str], list[str]]:
    """Return every cycle and testcase linked to one governed defect."""
    cycles = {defect.cycle.cycle_key for _ in [0] if defect.cycle and defect.cycle.cycle_key}
    cases = {
        defect.primary_test_case.test_case_key for _ in [0]
        if defect.primary_test_case and defect.primary_test_case.test_case_key
    }
    for link in defect.execution_links:
        if link.cycle_key:
            cycles.add(link.cycle_key)
        if link.test_case_key:
            cases.add(link.test_case_key)
    for link in defect.test_case_links:
        if link.test_case and link.test_case.test_case_key:
            cases.add(link.test_case.test_case_key)
    return sorted(cycles), sorted(cases)


def _scoped_project_ids(db: Session, current_user: models.User) -> Optional[list]:
    """None means unrestricted (Admin/QA Lead-tier roles); otherwise the
    list of TestProject ids the caller may see -- their own department
    scope, widened by deps.viewable_project_ids to also include any
    2026-08 "view-only access to department/user" CR grant (see that
    function's own docstring in deps.py)."""
    return viewable_project_ids(db, current_user)


@router.get("/projects/{project_id}/repository-health", response_model=schemas.RepositoryHealthOut)
def repository_health(project_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    """Cases by status/module/priority/type/owner, plus average age and a
    "never executed" count as the closest honest proxy for "unused
    duration" this data model can support without a separate usage-tracking
    table."""
    project = _get_project_or_404(db, project_id)
    require_project_visibility(db, project.id, current_user)
    cases = db.query(models.TestCase).filter_by(project_id=project_id).all()
    now = models.now()

    def group_by(key_fn):
        counts = {}
        for case in cases:
            key = key_fn(case) or "Unspecified"
            counts[key] = counts.get(key, 0) + 1
        return [{"key": key, "count": count, "filters": {"project_id": project_id}}
                for key, count in sorted(counts.items(), key=lambda kv: -kv[1])]

    executed_case_ids = {
        row[0] for row in db.query(models.TestExecution.test_case_id)
        .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
        .filter(models.TestCycle.project_id == project_id).distinct().all()
    }
    # models.as_aware() -- Oracle round-trips Column(DateTime) values as
    # naive even though models.now() writes them as aware IST timestamps;
    # comparing/subtracting the two directly raises "can't subtract
    # offset-naive and offset-aware datetimes" the moment live data exists
    # to trigger it. See models.as_aware's own docstring for the full story.
    ages = [(now - models.as_aware(case.created_at)).days for case in cases if case.created_at]
    return {
        "project_id": project_id, "project_key": project.project_key,
        "population_note": (
            "All testcases currently in this project, regardless of status. Age is calendar days since "
            "creation as of report generation time. 'Never executed' counts testcases with zero "
            "TestExecution rows across every cycle in this project."
        ),
        "total_cases": len(cases),
        "by_status": group_by(lambda c: c.status),
        "by_module": group_by(lambda c: c.module_name),
        "by_priority": group_by(lambda c: c.priority),
        "by_test_type": group_by(lambda c: c.test_type),
        "by_owner": group_by(lambda c: c.created_by_name),
        "average_age_days": round(sum(ages) / len(ages), 1) if ages else 0,
        "never_executed_count": sum(1 for case in cases if case.id not in executed_case_ids),
    }


@router.get("/cycles/{cycle_id}/progress", response_model=schemas.CycleProgressOut)
def cycle_progress(cycle_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """SRS "Cycle progress": Not Executed/Pass/Fail/Blocked/NA/Retest
    Passed counts, assignment coverage, and completion percentage --
    reads TestExecution's own mirror columns (each mirrors its slot's
    latest immutable TestExecutionRun, see models.py), so this is accurate
    for an active or Completed cycle alike (RPT-003)."""
    cycle = db.query(models.TestCycle).get(cycle_id)
    if not cycle:
        raise HTTPException(404, "Test Cycle not found")
    require_project_visibility(db, cycle.project_id, current_user)
    executions = db.query(models.TestExecution).filter_by(cycle_id=cycle_id).all()
    total = len(executions)
    by_status = {}
    for execution in executions:
        by_status[execution.status] = by_status.get(execution.status, 0) + 1
    executed = total - by_status.get("Not Executed", 0)
    assigned = sum(1 for execution in executions if execution.assigned_to_id)
    return {
        "cycle_id": cycle_id, "cycle_key": cycle.cycle_key, "cycle_status": cycle.status,
        "population_note": (
            "All testcase slots currently in this cycle. Completion percentage is (executed / total) "
            "using each slot's latest recorded attempt; Not Executed slots are excluded from the numerator."
        ),
        "total_items": total,
        "by_status": [{"status": status, "count": count, "filters": {"cycle_id": cycle_id, "status": status}}
                      for status, count in sorted(by_status.items(), key=lambda kv: -kv[1])],
        "assigned_count": assigned, "unassigned_count": total - assigned,
        "completion_pct": round((executed / total) * 100, 1) if total else 0.0,
        "is_locked": cycle.status in TEST_CYCLE_LOCKED_STATUSES,
    }


@router.get("/projects/{project_id}/defect-quality", response_model=schemas.DefectQualityOut)
def defect_quality(
    project_id: int,
    resolver_id: Optional[int] = None,
    reopened_only: bool = False,
    limit: int = Query(_DEFAULT_PAGE_SIZE, ge=1, le=_MAX_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Project-scoped governed defect quality and resolution outcomes.

    Resolution ownership comes only from the latest append-only ``Resolved``
    workflow action. The current assignee is deliberately never used as a
    substitute because ownership can change during retest or after reopening.
    """
    project = _get_project_or_404(db, project_id)
    require_project_visibility(db, project.id, current_user)
    defects = (
        db.query(models.TestRunDefect)
        .join(models.TestExecutionRun, models.TestRunDefect.run_id == models.TestExecutionRun.id)
        .join(models.TestExecution, models.TestExecutionRun.execution_id == models.TestExecution.id)
        .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
        .filter(models.TestCycle.project_id == project_id)
        .all()
    )
    retested_ok = 0
    for defect in defects:
        run = defect.run
        execution = run.execution if run else None
        if execution and execution.status in ("Pass", "Retest Passed") and run and execution.runs:
            latest_attempt_no = max(r.attempt_no for r in execution.runs)
            if latest_attempt_no > run.attempt_no:
                retested_ok += 1

    # Keep project membership as subqueries. Materializing IDs into an IN
    # list would hit Oracle's 1,000-expression limit on large projects.
    cycle_ids = db.query(models.TestCycle.id).filter(models.TestCycle.project_id == project_id)
    execution_ids = db.query(models.TestExecution.id).filter(models.TestExecution.cycle_id.in_(cycle_ids))
    governed_query = db.query(models.Defect).filter(or_(
        models.Defect.cycle_id.in_(cycle_ids),
        models.Defect.execution_id.in_(execution_ids),
        models.Defect.execution_links.any(models.DefectExecutionLink.execution_id.in_(execution_ids)),
    ))
    # The aggregate/report layer remains database-side so a project with
    # many defects and concurrent viewers does not hydrate its entire defect
    # history for every report request.
    latest_resolution = db.query(
        models.ApprovalAction.entity_id.label("defect_id"),
        func.max(models.ApprovalAction.id).label("action_id"),
    ).filter(
        models.ApprovalAction.entity_type == "DEFECT",
        models.ApprovalAction.decision.in_(("Resolved", "Ready for QA")),
    ).group_by(models.ApprovalAction.entity_id).subquery()

    terminal_statuses = {"Closed", "Rejected", "Duplicate", "Not a Defect"}
    resolved_statuses = {"Resolved", "Retest", "Reopened", "Closed"}
    total_governed = governed_query.with_entities(func.count(models.Defect.id)).scalar() or 0
    open_defects = governed_query.filter(models.Defect.status.notin_(terminal_statuses)).with_entities(func.count(models.Defect.id)).scalar() or 0
    resolved_defects = governed_query.filter(or_(models.Defect.status.in_(resolved_statuses), models.Defect.resolved_at.isnot(None))).with_entities(func.count(models.Defect.id)).scalar() or 0
    reopened_defects = governed_query.filter(models.Defect.reopen_count > 0).with_entities(func.count(models.Defect.id)).scalar() or 0
    reopen_events = governed_query.with_entities(func.coalesce(func.sum(models.Defect.reopen_count), 0)).scalar() or 0
    module_label = func.coalesce(models.Defect.module_feature, "Unspecified")
    status_label = func.coalesce(models.Defect.status, "Unspecified")
    by_module = dict(governed_query.with_entities(module_label, func.count(models.Defect.id)).group_by(module_label).all())
    by_status = dict(governed_query.with_entities(status_label, func.count(models.Defect.id)).group_by(status_label).all())

    resolved_count = func.count(models.Defect.id)
    reopened_count = func.sum(case((models.Defect.reopen_count > 0, 1), else_=0))
    event_count = func.coalesce(func.sum(models.Defect.reopen_count), 0)
    resolver_rows = (
        governed_query.join(latest_resolution, latest_resolution.c.defect_id == models.Defect.id)
        .join(models.ApprovalAction, models.ApprovalAction.id == latest_resolution.c.action_id)
        .join(models.User, models.User.id == models.ApprovalAction.actor_id)
        .with_entities(models.User.id, models.User.full_name, resolved_count, reopened_count, event_count)
        .group_by(models.User.id, models.User.full_name)
        .order_by(resolved_count.desc(), models.User.full_name.asc()).all()
    )
    resolution_activity = [{
        "resolver_id": user_id,
        "resolver_name": name,
        "resolved_defects": int(resolved or 0),
        "reopened_defects": int(reopened or 0),
        "reopen_events": int(events or 0),
    } for user_id, name, resolved, reopened, events in resolver_rows]

    filtered_query = governed_query
    if resolver_id is not None:
        filtered_query = (
            filtered_query.join(latest_resolution, latest_resolution.c.defect_id == models.Defect.id)
            .join(models.ApprovalAction, models.ApprovalAction.id == latest_resolution.c.action_id)
            .filter(models.ApprovalAction.actor_id == resolver_id)
        )
    if reopened_only:
        filtered_query = filtered_query.filter(models.Defect.reopen_count > 0)
    total_items = filtered_query.with_entities(func.count(models.Defect.id)).scalar() or 0
    page_items = (
        filtered_query.options(
            joinedload(models.Defect.qa_request), joinedload(models.Defect.cycle),
            joinedload(models.Defect.primary_test_case),
            selectinload(models.Defect.test_case_links).joinedload(models.DefectTestCaseLink.test_case),
            selectinload(models.Defect.execution_links)
                .joinedload(models.DefectExecutionLink.execution)
                .joinedload(models.TestExecution.cycle),
            selectinload(models.Defect.execution_links)
                .joinedload(models.DefectExecutionLink.execution)
                .joinedload(models.TestExecution.test_case),
        )
        .order_by(models.Defect.updated_at.desc(), models.Defect.id.desc())
        .offset(offset).limit(limit).all()
    )
    page_ids = [defect.id for defect in page_items]
    actions = {
        action.entity_id: action for action in db.query(models.ApprovalAction)
        .options(joinedload(models.ApprovalAction.actor))
        .join(latest_resolution, latest_resolution.c.action_id == models.ApprovalAction.id)
        .filter(models.ApprovalAction.entity_id.in_(page_ids)).all()
    } if page_ids else {}

    items = []
    for defect in page_items:
        cycle_keys, test_case_keys = _defect_trace_keys(defect)
        action = actions.get(defect.id)
        items.append({
            "defect_id": defect.id,
            "defect_key": defect.defect_key,
            "title": defect.title,
            "qa_request_key": defect.qa_request_key,
            "project_id": project.id,
            "project_key": project.project_key,
            "project_name": project.name,
            "application_name": defect.application_name,
            "module_feature": defect.module_feature,
            "severity": defect.severity,
            "status": defect.status,
            "cycle_keys": cycle_keys,
            "test_case_keys": test_case_keys,
            "resolved_by_id": action.actor_id if action else None,
            "resolved_by_name": action.actor_name if action else None,
            "reopen_count": defect.reopen_count or 0,
            "target_release": defect.target_release,
            "updated_at": defect.updated_at,
        })

    return {
        "project_id": project_id, "project_key": project.project_key, "project_name": project.name,
        "population_note": (
            "Unique governed defects traced to this project through a primary or additional execution link. "
            "Resolver attribution uses the latest audited fix handoff (Resolved or Ready for QA). Retest success rate uses all "
            "structured execution defect links where a later attempt passed."
        ),
        "total_defect_links": len(defects),
        "total_governed_defects": total_governed,
        "open_defects": open_defects,
        "resolved_defects": resolved_defects,
        "reopened_defects": reopened_defects,
        "reopen_events": int(reopen_events),
        "by_module": [{"key": key, "count": count, "filters": {"project_id": project_id}}
                     for key, count in sorted(by_module.items(), key=lambda kv: -kv[1])],
        "by_status": [{"key": key, "count": count, "filters": {"project_id": project_id}}
                     for key, count in sorted(by_status.items(), key=lambda kv: -kv[1])],
        "retest_success_rate_pct": round((retested_ok / len(defects)) * 100, 1) if defects else 0.0,
        "resolution_activity": resolution_activity,
        "total_items": total_items,
        "returned_items": len(items),
        "items": items,
    }


@router.get("/projects/{project_id}/version-impact", response_model=schemas.VersionImpactOut)
def version_impact(
    project_id: int,
    limit: int = Query(_DEFAULT_PAGE_SIZE, ge=1, le=_MAX_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user),
):
    """Cycles carrying stale-pinned items -- SRS TestExecution.is_pinned_stale
    already computes "the testcase's approved version has moved on since
    this slot pinned"; this report just aggregates that property per cycle,
    split into items still eligible for upgrade_execution_version
    (unexecuted) vs. items now permanently pinned (already executed)."""
    project = _get_project_or_404(db, project_id)
    require_project_visibility(db, project.id, current_user)
    cycles = db.query(models.TestCycle).filter_by(project_id=project_id).all()
    rows = []
    for cycle in cycles:
        executions = cycle.executions
        stale = [execution for execution in executions if execution.is_pinned_stale]
        if not stale:
            continue
        upgradeable = sum(1 for execution in stale if not execution.runs)
        rows.append({
            "cycle_id": cycle.id, "cycle_key": cycle.cycle_key, "cycle_status": cycle.status,
            "stale_item_count": len(stale), "upgradeable_count": upgradeable,
            "permanently_pinned_count": len(stale) - upgradeable,
            "filters": {"cycle_id": cycle.id},
        })
    ordered_rows = sorted(rows, key=lambda r: -r["stale_item_count"])
    page = ordered_rows[offset:offset + limit]
    return {
        "project_id": project_id, "project_key": project.project_key,
        "population_note": (
            "Cycles in this project with at least one testcase slot whose pinned version is no longer "
            "the testcase's current Approved version. Upgradeable items have zero recorded attempts; "
            "permanently pinned items already have execution history and cannot change (CYC-006). Items "
            "are sorted by stale-item count and paginated; cycles_with_stale_items covers the full population."
        ),
        "cycles_with_stale_items": len(rows),
        "total_items": len(ordered_rows), "returned_items": len(page),
        "items": page,
    }


@router.get(
    "/projects/{project_id}/requirements-traceability",
    response_model=schemas.RequirementTraceabilityOut,
)
def requirements_traceability(
    project_id: int,
    search: Optional[str] = Query(None, max_length=150),
    requirement_type: str = Query("all", pattern="^(all|epic|cr|feature|story|unmapped)$"),
    limit: int = Query(_DEFAULT_PAGE_SIZE, ge=1, le=_MAX_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """End-to-end requirement coverage from repository to execution and defects.

    Each testcase produces one row per cycle slot. A testcase that has never
    been placed in a cycle still produces an uncovered repository row. Cycle
    rows intentionally read requirement metadata from the slot's immutable
    pinned version so later testcase edits cannot rewrite historical coverage.
    """
    project = _get_project_or_404(db, project_id)
    require_project_visibility(db, project.id, current_user)

    cases = (
        db.query(models.TestCase)
        .filter(models.TestCase.project_id == project_id, _active_test_case_predicate())
        .all()
    )
    case_ids = {case.id for case in cases}
    mapped_case_ids = {
        case.id for case in cases
        if any(_traceability_value(case, field) for field in
               ("epic_id", "cr_number", "feature_id", "user_story_id"))
    }

    raw_rows = (
        db.query(models.TestCase, models.TestExecution, models.TestCycle, models.TestCaseVersion)
        .outerjoin(models.TestExecution, models.TestExecution.test_case_id == models.TestCase.id)
        .outerjoin(models.TestCycle, models.TestCycle.id == models.TestExecution.cycle_id)
        .outerjoin(models.TestCaseVersion, models.TestCaseVersion.id == models.TestExecution.pinned_version_id)
        .filter(models.TestCase.project_id == project_id, _active_test_case_predicate())
        .all()
    )

    request_by_cycle = {
        cycle_id: (child_id, child_key) for cycle_id, child_id, child_key in (
            db.query(models.TestCycleChildRequestLink.cycle_id, models.TestCycleChildRequestLink.child_id,
                     models.TestCycleChildRequestLink.child_key)
            .join(models.TestCycle, models.TestCycleChildRequestLink.cycle_id == models.TestCycle.id)
            .filter(models.TestCycle.project_id == project_id)
            .all()
        )
    }
    run_counts = {
        execution_id: count for execution_id, count in (
            db.query(models.TestExecutionRun.execution_id, func.count(models.TestExecutionRun.id))
            .join(models.TestExecution, models.TestExecutionRun.execution_id == models.TestExecution.id)
            .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
            .filter(models.TestCycle.project_id == project_id)
            .group_by(models.TestExecutionRun.execution_id)
            .all()
        )
    }

    # Merge lightweight attempt-level links, governed primary links and
    # governed additional-execution links into one defect view per slot.
    defects_by_execution = {}

    def add_defect(execution_id, defect_key, defect_status):
        if not execution_id or not defect_key:
            return
        bucket = defects_by_execution.setdefault(execution_id, {})
        bucket[str(defect_key)] = str(defect_status) if defect_status else None

    for execution_id, defect_key, defect_status in (
        db.query(models.TestExecutionRun.execution_id, models.TestRunDefect.defect_key,
                 models.TestRunDefect.defect_status)
        .join(models.TestExecutionRun, models.TestRunDefect.run_id == models.TestExecutionRun.id)
        .join(models.TestExecution, models.TestExecutionRun.execution_id == models.TestExecution.id)
        .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
        .filter(models.TestCycle.project_id == project_id)
        .all()
    ):
        add_defect(execution_id, defect_key, defect_status)
    for execution_id, defect_key, defect_status in (
        db.query(models.Defect.execution_id, models.Defect.defect_key, models.Defect.status)
        .join(models.TestExecution, models.Defect.execution_id == models.TestExecution.id)
        .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
        .filter(models.TestCycle.project_id == project_id)
        .all()
    ):
        add_defect(execution_id, defect_key, defect_status)
    for execution_id, defect_key, defect_status in (
        db.query(models.DefectExecutionLink.execution_id, models.Defect.defect_key, models.Defect.status)
        .join(models.Defect, models.DefectExecutionLink.defect_id == models.Defect.id)
        .join(models.TestExecution, models.DefectExecutionLink.execution_id == models.TestExecution.id)
        .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
        .filter(models.TestCycle.project_id == project_id)
        .all()
    ):
        add_defect(execution_id, defect_key, defect_status)

    rows = []
    covered_case_ids = {execution.test_case_id for _, execution, cycle, _ in raw_rows
                        if execution and cycle and cycle.project_id == project_id}
    executed_case_ids = {execution.test_case_id for _, execution, cycle, _ in raw_rows
                         if execution and cycle and cycle.project_id == project_id
                         and (run_counts.get(execution.id, 0) or execution.status in
                              ("Pass", "Fail", "Blocked", "NA", "Retest Passed"))}
    failed_or_blocked = sum(1 for _, execution, cycle, _ in raw_rows
                            if execution and cycle and cycle.project_id == project_id
                            and execution.status in ("Fail", "Blocked"))
    defect_linked = sum(1 for _, execution, cycle, _ in raw_rows
                        if execution and cycle and cycle.project_id == project_id
                        and (defects_by_execution.get(execution.id) or execution.defect_id))
    search_term = (search or "").strip().lower()
    requirement_field = {
        "epic": "epic_id", "cr": "cr_number", "feature": "feature_id", "story": "user_story_id",
    }.get(requirement_type)

    for test_case, execution, cycle, pinned_version in raw_rows:
        # A corrupt cross-project execution should never be surfaced through
        # this project report even if its testcase FK points here.
        if execution and (not cycle or cycle.project_id != project_id):
            continue
        source = _traceability_source(test_case, pinned_version if execution else None)
        requirement_values = {
            field: _traceability_value(source, field)
            for field in ("epic_id", "cr_number", "feature_id", "user_story_id")
        }
        if requirement_field and not requirement_values[requirement_field]:
            continue
        if requirement_type == "unmapped" and any(requirement_values.values()):
            continue

        execution_id = execution.id if execution else None
        defect_map = defects_by_execution.get(execution_id, {})
        if execution and execution.defect_id:
            defect_map = dict(defect_map)
            defect_map.setdefault(execution.defect_id, None)
        functional_request = request_by_cycle.get(cycle.id) if cycle else None
        functional_request_id = functional_request[0] if functional_request else None
        functional_request_key = functional_request[1] if functional_request else None
        searchable = " ".join(str(value or "") for value in (
            test_case.test_case_key, *requirement_values.values(),
            getattr(source, "module_name", None), getattr(source, "test_scenario", None),
            functional_request_key, cycle.cycle_key if cycle else None, cycle.name if cycle else None,
            execution.status if execution else "Not in cycle", *defect_map.keys(),
        )).lower()
        if search_term and search_term not in searchable:
            continue

        defect_keys = sorted(defect_map)
        rows.append({
            "row_id": f"{test_case.id}:{execution_id or 'repository'}",
            "test_case_id": test_case.id,
            "test_case_key": test_case.test_case_key,
            "test_case_version": f"{source.version_major}.{source.version_minor}",
            "test_case_status": source.status or "Unknown",
            **requirement_values,
            "module_name": getattr(source, "module_name", None),
            "test_scenario": getattr(source, "test_scenario", None),
            "functional_request_id": functional_request_id,
            "functional_request_key": functional_request_key,
            "cycle_id": cycle.id if cycle else None,
            "cycle_key": cycle.cycle_key if cycle else None,
            "cycle_name": cycle.name if cycle else None,
            "cycle_status": cycle.status if cycle else None,
            "execution_id": execution_id,
            "latest_result": (execution.status or "Unknown") if execution else "Not in cycle",
            "executed_at": execution.executed_at if execution else None,
            "run_count": run_counts.get(execution_id, 0),
            "defect_keys": defect_keys,
            "defect_statuses": [defect_map[key] for key in defect_keys if defect_map[key]],
        })

    rows.sort(key=lambda row: (row["test_case_key"], row["cycle_key"] or ""))
    page = rows[offset:offset + limit]
    return {
        "project_id": project_id,
        "project_key": project.project_key,
        "population_note": (
            "One row per testcase and Test Cycle slot, plus one repository-only row for a testcase never "
            "added to a cycle. Cycle rows use the immutable testcase version pinned to that execution. "
            "Requirement IDs are testcase metadata; Functional Request is the mandatory request linked to the cycle. "
            "Summary cards cover the full current project; search and requirement filters refine the matrix rows."
        ),
        "total_rows": len(rows),
        "returned_rows": len(page),
        "total_test_cases": len(case_ids),
        "mapped_test_cases": len(mapped_case_ids),
        "unmapped_test_cases": len(case_ids - mapped_case_ids),
        "covered_test_cases": len(covered_case_ids),
        "executed_test_cases": len(executed_case_ids),
        "failed_or_blocked_rows": failed_or_blocked,
        "defect_linked_rows": defect_linked,
        "items": page,
    }


@router.get("/projects/{project_id}/requirements-traceability/export-xlsx")
def export_requirements_traceability(
    project_id: int,
    search: Optional[str] = Query(None, max_length=150),
    requirement_type: str = Query("all", pattern="^(all|epic|cr|feature|story|unmapped)$"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Download the complete filtered RTM using the same rules as the screen."""
    data = requirements_traceability(
        project_id=project_id,
        search=search,
        requirement_type=requirement_type,
        limit=10 ** 9,
        offset=0,
        db=db,
        current_user=current_user,
    )
    workbook = new_workbook()
    add_summary_sheet(
        workbook,
        "Requirements Traceability Matrix",
        data["population_note"],
        metadata=[
            ("Project", data["project_key"]),
            ("Generated at", models.now()),
            ("Requirement filter", requirement_type),
            ("Search", search or "All records"),
        ],
        metrics=[
            ("Test cases", data["total_test_cases"]),
            ("Requirement mapped", data["mapped_test_cases"]),
            ("Unmapped", data["unmapped_test_cases"]),
            ("Added to a cycle", data["covered_test_cases"]),
            ("Executed", data["executed_test_cases"]),
            ("Failed / Blocked", data["failed_or_blocked_rows"]),
            ("With defects", data["defect_linked_rows"]),
        ],
    )
    headers = [
        "Epic ID", "CR Number", "Feature ID", "User Story ID", "Test Case ID",
        "Test Case Version", "Test Case Status", "Module", "Test Scenario",
        "Functional Request", "Test Cycle", "Cycle Name", "Cycle Status",
        "Latest Result", "Run Count", "Executed At", "Defect IDs", "Defect Statuses",
    ]
    add_table_sheet(
        workbook,
        "Traceability Matrix",
        f"{data['project_key']} Requirements Traceability Matrix",
        headers,
        [[
            row["epic_id"], row["cr_number"], row["feature_id"], row["user_story_id"],
            row["test_case_key"], row["test_case_version"], row["test_case_status"],
            row["module_name"], row["test_scenario"], row["functional_request_key"],
            row["cycle_key"], row["cycle_name"], row["cycle_status"], row["latest_result"],
            row["run_count"], row["executed_at"], ", ".join(row["defect_keys"]),
            ", ".join(row["defect_statuses"]),
        ] for row in data["items"]],
        subtitle=data["population_note"],
        wrap_headers={"Test Scenario", "Cycle Name", "Defect IDs", "Defect Statuses"},
        date_headers={"Executed At"},
        status_headers={"Test Case Status", "Cycle Status", "Latest Result"},
        widths={"Test Scenario": 36, "Cycle Name": 26, "Defect IDs": 24},
    )
    safe_project_key = "".join(char for char in data["project_key"] if char.isalnum() or char in "-_")
    return workbook_response(workbook, f"{safe_project_key or 'project'}-requirements-traceability.xlsx")


@router.get("/portfolio", response_model=schemas.ProjectPortfolioOut)
def project_portfolio(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Cross-project rollup -- the one report in this set that is
    deliberately NOT scoped to a single project, department-scoped instead
    (same convention as test_projects.py::list_test_projects)."""
    scoped_ids = _scoped_project_ids(db, current_user)
    project_query = db.query(models.TestProject)
    if scoped_ids is not None:
        project_query = project_query.filter(models.TestProject.id.in_(scoped_ids or [-1]))
    projects = project_query.all()
    project_ids = [project.id for project in projects]

    cycles = db.query(models.TestCycle).filter(models.TestCycle.project_id.in_(project_ids)).all() if project_ids else []
    by_cycle_status = {}
    for cycle in cycles:
        by_cycle_status[cycle.status] = by_cycle_status.get(cycle.status, 0) + 1

    six_months_ago = models.now() - datetime.timedelta(days=180)
    trend = {}
    for cycle in cycles:
        # models.as_aware() -- see its own docstring; cycle.created_at comes
        # back from Oracle as a naive datetime, six_months_ago is aware, and
        # comparing them directly raised "can't compare offset-naive and
        # offset-aware datetimes" (reported directly, traceback).
        if not cycle.created_at or models.as_aware(cycle.created_at) < six_months_ago:
            continue
        bucket = cycle.created_at.strftime("%Y-%m")
        trend[bucket] = trend.get(bucket, 0) + 1

    ownership = {}
    for project in projects:
        owner = project.owner_name or "Unassigned"
        ownership[owner] = ownership.get(owner, 0) + 1

    return {
        "population_note": (
            "Every Test Project visible under your department scope (unrestricted for QA Lead/Admin). "
            "Execution trend counts cycles by creation month over the trailing 180 days."
        ),
        "active_project_count": sum(1 for project in projects if project.is_active and not project.is_archived),
        "inactive_project_count": sum(1 for project in projects if not project.is_active and not project.is_archived),
        "archived_project_count": sum(1 for project in projects if project.is_archived),
        "cycle_count": len(cycles),
        "cycles_by_status": [{"status": status, "count": count} for status, count in
                             sorted(by_cycle_status.items(), key=lambda kv: -kv[1])],
        "cycle_creation_trend": [{"month": month, "count": count} for month, count in sorted(trend.items())],
        "ownership": [{"owner": owner, "project_count": count} for owner, count in
                     sorted(ownership.items(), key=lambda kv: -kv[1])],
    }
