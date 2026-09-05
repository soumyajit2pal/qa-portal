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
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import (
    get_current_user, viewable_project_ids,
    get_project_or_404 as _get_project_or_404, require_project_visibility,
)
from ..constants import TEST_CYCLE_LOCKED_STATUSES

router = APIRouter(prefix="/api/test-reports", tags=["test-management"])

# Default/maximum page size for this router's list-shaped reports. Smaller
# default than the app-wide "five items per page" REP-004 convention on
# purpose -- these are analyst-facing aggregate views, not the primary
# Repository/My Executions worklists REP-004/EXE-002 describe, so a larger
# default page is a reasonable, explicitly-bounded departure from it.
_DEFAULT_PAGE_SIZE = 50
_MAX_PAGE_SIZE = 500


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
def defect_quality(project_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Defects linked in this project's cycles, grouped by module and by
    defect status; retest success rate approximates "leakage" as the share
    of defect-linked attempts whose testcase slot was later recorded Pass
    on a subsequent attempt (an honest proxy -- this app has no external
    defect-tracker integration to pull real severity/resolution data from)."""
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
    by_module, by_status = {}, {}
    retested_ok = 0
    for defect in defects:
        run = defect.run
        execution = run.execution if run else None
        module = (execution.test_case.module_name if execution and execution.test_case else None) or "Unspecified"
        by_module[module] = by_module.get(module, 0) + 1
        status_label = defect.defect_status or "Unspecified"
        by_status[status_label] = by_status.get(status_label, 0) + 1
        if execution and execution.status in ("Pass", "Retest Passed") and run and execution.runs:
            latest_attempt_no = max(r.attempt_no for r in execution.runs)
            if latest_attempt_no > run.attempt_no:
                retested_ok += 1
    return {
        "project_id": project_id, "project_key": project.project_key,
        "population_note": (
            "Every structured defect link recorded against any execution attempt in this project's "
            "cycles. Retest success rate is the share of defect-linked attempts where a later attempt "
            "on the same slot was eventually recorded Pass/Retest Passed."
        ),
        "total_defect_links": len(defects),
        "by_module": [{"key": key, "count": count, "filters": {"project_id": project_id}}
                     for key, count in sorted(by_module.items(), key=lambda kv: -kv[1])],
        "by_status": [{"key": key, "count": count, "filters": {"project_id": project_id}}
                     for key, count in sorted(by_status.items(), key=lambda kv: -kv[1])],
        "retest_success_rate_pct": round((retested_ok / len(defects)) * 100, 1) if defects else 0.0,
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
