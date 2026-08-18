import datetime
from collections import Counter
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, cache
from ..database import get_db
from ..deps import get_current_user, dashboard_department_scope
from ..xlsx_export import new_workbook, add_summary_sheet, add_table_sheet, workbook_response
from ..constants import (
    Role, QAStatus, SAST_DAST_TERMINAL_STATUSES, SUPPRESSION_TERMINAL_STATUSES,
    QA_DEPARTMENT, QA_REQUEST_TERMINAL_STATUSES, PERFORMANCE_TERMINAL_STATUSES,
    SAST_DAST_STATUS_LABELS, PERFORMANCE_STATUS_LABELS,
)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard-analytics"])


# Every endpoint in this file is only ever called by the Dashboard (see
# Dashboard.tsx -- nothing else in the frontend fetches /api/dashboard/*), so
# department scoping is applied here unconditionally rather than behind an
# opt-in flag like the shared request-list endpoints (list_requests/
# list_functional/list_sast/list_dast/list_performance) use, since there's no
# other consumer whose existing behaviour needs preserving.
def _join_qa_department(query, model, scope):
    """Joins `model` (FunctionalRequest/SASTRequest/DASTRequest/
    PerformanceRequest -- whichever the query's base/most-recently-joined
    entity already is) to its parent QARequest and filters to `scope`, if
    scope is given. All four of those models' own `department` is a
    delegated (read-only property) lookup through their qa_request, not a
    real column (see each model's own docstring in models.py) -- hence the
    join, rather than a plain .filter(model.department == scope), which
    SQLAlchemy cannot translate to SQL. A standalone request with no
    qa_request_id (already department=None today) is naturally excluded by
    this inner join, same as it already reads as unscoped/departmentless
    everywhere else in the app."""
    if not scope:
        return query
    # 2026-08 "one user can be on multiple departments" CR -- scope is now a
    # list of departments (dashboard_department_scope's own docstring), so
    # this is an `.in_()` membership filter, not `==`.
    return query.join(models.QARequest, model.qa_request_id == models.QARequest.id) \
                .filter(models.QARequest.department.in_(scope))


def _date_bounds(date_from: str | None, date_to: str | None):
    """Inclusive reporting-period bounds supplied by the dashboard."""
    start = datetime.datetime.fromisoformat(date_from.replace("Z", "+00:00")) if date_from else None
    end = datetime.datetime.fromisoformat(date_to.replace("Z", "+00:00")) if date_to else None
    # Oracle columns are stored as naive IST wall-clock values.
    if start and start.tzinfo:
        start = start.astimezone(ZoneInfo("Asia/Kolkata")).replace(tzinfo=None)
    if end and end.tzinfo:
        end = end.astimezone(ZoneInfo("Asia/Kolkata")).replace(tzinfo=None)
    return start, end


def _in_period(query, column, date_from: str | None, date_to: str | None):
    start, end = _date_bounds(date_from, date_to)
    if start:
        query = query.filter(column >= start)
    if end:
        query = query.filter(column <= end)
    return query


def _latest_scan_by_request(db: Session, kind: str, request_ids) -> dict:
    """Reported directly: "in dashboard sast dast findings showing 0
    result." Every SAST/DAST findings figure below used to read
    models.SASTFinding/DASTFinding -- the old manually-logged findings
    tables, retired when the "Findings Validation" doc moved findings to
    Fortify SSC-backed imports (see models.SecurityScanResult). Nothing has
    written a SASTFinding/DASTFinding row since, so every metric built on
    them (open findings, severity distribution, remediation status) has
    silently read as zero/empty ever since, on the Dashboard AND the
    Reports module (routers/reports.py has the identical bug -- see its own
    copy of this same fix).

    Returns {request_id: latest SecurityScanResult row} for whichever of
    `request_ids` have actually been scanned at least once -- request ids
    with no scan yet are simply absent, same as `_scan_results` in
    sast_dast.py treats "never scanned" (no special zero-row). Ordering
    ascending by (request_id, imported_at, id) and overwriting as we go is
    a plain Python "latest wins" reduction -- no window function needed,
    consistent with the rest of this file's fetch-then-aggregate-in-Python
    style."""
    request_ids = [rid for rid in request_ids if rid is not None]
    if not request_ids:
        return {}
    rows = (
        db.query(models.SecurityScanResult)
        .filter(models.SecurityScanResult.request_type == kind,
                models.SecurityScanResult.request_id.in_(request_ids))
        .order_by(models.SecurityScanResult.request_id,
                  models.SecurityScanResult.imported_at.asc(),
                  models.SecurityScanResult.id.asc())
        .all()
    )
    latest: dict = {}
    for row in rows:
        latest[row.request_id] = row
    return latest

# Statuses that represent "work still in flight" for a QA Request (i.e. not a
# terminal state and not sitting untouched in Draft).
ACTIVE_QA_STATUSES = {
    QAStatus.SUBMITTED, QAStatus.SM_APPROVAL_PENDING, QAStatus.RETURNED_BY_SM,
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD,
    QAStatus.QA_LEAD_ASSIGNED, QAStatus.READINESS_VERIFICATION, QAStatus.RETURNED_BY_QA_LEAD,
    QAStatus.QA_ACTIVITY_INITIATED, QAStatus.PLANNING, QAStatus.TESTER_ASSIGNED, QAStatus.TEST_DESIGN,
    QAStatus.EXECUTION_IN_PROGRESS, QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX,
    QAStatus.RETESTING, QAStatus.QA_COMPLETED,
    QAStatus.QA_SIGNOFF_PENDING, QAStatus.QA_SIGNED_OFF, QAStatus.REQUESTER_VERIFICATION,
}

# Statuses awaiting a decision/action from someone other than the requester --
# used for the "pending approvals" metric.
PENDING_APPROVAL_STATUSES = {
    QAStatus.SM_APPROVAL_PENDING, QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING,
    QAStatus.READINESS_VERIFICATION, QAStatus.QA_SIGNOFF_PENDING, QAStatus.REQUESTER_VERIFICATION,
}

# SAST/DAST statuses that represent an open approval checkpoint (i.e. sitting
# with someone other than the requester) -- used for the same "pending
# approvals" metric below. "Requested" is excluded deliberately: it's the
# equivalent of a Draft (not yet submitted), so it isn't "pending" on anyone.
SAST_DAST_PENDING_APPROVAL_STATUSES = {
    "SM_APPROVAL_PENDING", "DEPARTMENT_HEAD_APPROVAL_PENDING", "SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS",
}

# Once a Functional QA request reaches TESTER_ASSIGNED it retains its
# assigned_tester_ids for the rest of the lifecycle. These are every
# non-terminal status that can therefore still be pending against an
# assigned QA tester, in the same order used by the dashboard columns.
TESTER_WORKLOAD_STATUSES = [
    QAStatus.TESTER_ASSIGNED, QAStatus.TEST_DESIGN, QAStatus.EXECUTION_IN_PROGRESS,
    QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX, QAStatus.RETESTING,
    QAStatus.QA_COMPLETED, QAStatus.QA_SIGNOFF_PENDING,
    QAStatus.QA_SIGNED_OFF, QAStatus.REQUESTER_VERIFICATION,
]

# One tester carrying three fully-active concurrent assignments is considered
# 100% occupied. Lighter lifecycle stages consume a fraction of a slot. This
# makes the dashboard an explainable capacity aid for QA Leads instead of a
# relative "busiest person = 100%" chart whose meaning changes every day.
TESTER_CAPACITY_POINTS = 8.0
FUNCTIONAL_TESTER_LOAD = {
    QAStatus.TESTER_ASSIGNED: 0.50,
    QAStatus.TEST_DESIGN: 1.00,
    QAStatus.EXECUTION_IN_PROGRESS: 1.00,
    QAStatus.DEFECT_RAISED: 0.50,
    QAStatus.WAITING_FOR_FIX: 0.00,
    QAStatus.RETESTING: 0.75,
    QAStatus.QA_COMPLETED: 0.15,
    QAStatus.QA_SIGNOFF_PENDING: 0.10,
    QAStatus.QA_SIGNED_OFF: 0.10,
    QAStatus.REQUESTER_VERIFICATION: 0.05,
}
PERFORMANCE_TESTER_LOAD = {
    "ENVIRONMENT_SETUP": 1.00,
    "SCRIPT_DEVELOPMENT": 1.00,
    "BASELINE": 0.75,
    "LOAD_TEST_EXECUTION": 1.00,
    "RESULT_ANALYSIS": 0.25,
    "DEFECT_FIX_RETEST": 0.75,
    "REPORT": 0.15,
    "SIGNOFF_PENDING": 0.10,
}
PERFORMANCE_TESTER_WORKLOAD_STATUSES = list(PERFORMANCE_TESTER_LOAD)
SECURITY_ANALYST_LOAD = {
    "CONFIGURATION": 0.75,
    "SCANNING": 1.00,
    "FINDING_VALIDATION": 0.75,
    "REMEDIATION": 0.50,
    "ASSIGNED_TO_REQUESTER": 0.10,
    "WAITING_FOR_FIX": 0.00,
    "ASSIGNED_TO_LEAD": 0.10,
    "RESCAN": 0.75,
    "SECURITY_COMPLETE": 0.15,
    "REPORT_READY": 0.10,
}
SECURITY_ANALYST_WORKLOAD_STATUSES = list(SECURITY_ANALYST_LOAD)

_QUEUED_TESTER_STATUSES = {QAStatus.TESTER_ASSIGNED}
_WAITING_TESTER_STATUSES = {
    QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX, "ASSIGNED_TO_REQUESTER",
}
_NEAR_COMPLETE_TESTER_STATUSES = {
    QAStatus.QA_COMPLETED, QAStatus.QA_SIGNOFF_PENDING, QAStatus.QA_SIGNED_OFF,
    QAStatus.REQUESTER_VERIFICATION, "REPORT", "SIGNOFF_PENDING", "SECURITY_COMPLETE", "REPORT_READY",
}


def _assigned_user_ids(value: str | None) -> list[int]:
    ids = []
    for raw_id in (value or "").split(","):
        try:
            ids.append(int(raw_id.strip()))
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys(ids))


def _occupancy_band(percent: int) -> str:
    if percent == 0:
        return "Available"
    if percent < 50:
        return "Light"
    if percent < 80:
        return "Balanced"
    if percent < 100:
        return "High"
    if percent == 100:
        return "Full"
    return "Overloaded"


_QA_DASHBOARD_ROLES = {
    Role.QA_ENGINEER, Role.QA_LEAD, Role.SECURITY_ANALYST,
    Role.CHIEF_MANAGER_QA, Role.AGM_QA,
}


def _require_qa_dashboard_access(current_user: models.User) -> None:
    if not _QA_DASHBOARD_ROLES.intersection(current_user.roles):
        raise HTTPException(403, "QA tester analytics are restricted to the QA team")


def _grouped_actor_counts(db: Session, model, actor_column, date_column,
                          tester_ids: list[int], date_from: str | None, date_to: str | None) -> dict[int, int]:
    if not tester_ids:
        return {}
    query = _in_period(
        db.query(actor_column.label("tester_id"), func.count(model.id).label("item_count")),
        date_column, date_from, date_to,
    ).filter(actor_column.in_(tester_ids)).group_by(actor_column)
    return {int(tester_id): int(item_count) for tester_id, item_count in query.all()}


def _grouped_last_activity(db: Session, model, actor_column, date_column,
                           tester_ids: list[int], date_from: str | None, date_to: str | None) -> dict[int, datetime.datetime]:
    if not tester_ids:
        return {}
    query = _in_period(
        db.query(actor_column.label("tester_id"), func.max(date_column).label("last_at")),
        date_column, date_from, date_to,
    ).filter(actor_column.in_(tester_ids)).group_by(actor_column)
    return {int(tester_id): last_at for tester_id, last_at in query.all() if last_at}


def _add_contribution_metrics(db: Session, rows: dict[int, dict],
                              date_from: str | None, date_to: str | None) -> dict:
    """Attach period-based authoring/execution/defect/project metrics.

    Testcase count uses identity rows, never versions. Retests use the
    governed Defect's recorded retest tester/timestamp. Project coverage is
    evidence-based: authoring a testcase, executing an attempt, reporting a
    linked defect, or retesting a linked defect qualifies the project.
    """
    tester_ids = list(rows)
    for row in rows.values():
        row.update({
            "testcases_created": 0,
            "testcases_draft": 0, "recommendation_pending": 0,
            "qa_lead_approval_pending": 0, "testcases_approved": 0,
            "defects_raised": 0,
            "retests_performed": 0, "executions_completed": 0,
            "projects_worked": 0, "project_names": [],
            "current_execution_assignments": 0, "last_activity": None,
            "total_contributions": 0,
        })
    if not tester_ids:
        return {"active_contributors": 0, "testcases_created": 0,
                "testcases_draft": 0, "recommendation_pending": 0,
                "qa_lead_approval_pending": 0, "testcases_approved": 0,
                "defects_raised": 0,
                "retests_performed": 0, "executions_completed": 0, "projects_covered": 0}

    count_specs = [
        ("testcases_created", models.TestCase, models.TestCase.created_by_id, models.TestCase.created_at),
        ("defects_raised", models.Defect, models.Defect.reporter_id, models.Defect.reported_at),
        ("retests_performed", models.Defect, models.Defect.retest_tester_id, models.Defect.retest_at),
        ("executions_completed", models.TestExecutionRun, models.TestExecutionRun.executed_by_id, models.TestExecutionRun.executed_at),
    ]
    latest_by_tester: dict[int, datetime.datetime] = {}
    for field, model, actor_column, date_column in count_specs:
        for tester_id, count in _grouped_actor_counts(
            db, model, actor_column, date_column, tester_ids, date_from, date_to,
        ).items():
            rows[tester_id][field] = count
        for tester_id, activity_at in _grouped_last_activity(
            db, model, actor_column, date_column, tester_ids, date_from, date_to,
        ).items():
            if tester_id not in latest_by_tester or activity_at > latest_by_tester[tester_id]:
                latest_by_tester[tester_id] = activity_at

    # Management workflow breakdown within the same testcase-creation period
    # shown by "Test cases created". Count current testcase identities, not
    # versions, and support both retained legacy and simplified labels.
    pending_status_fields = {
        "Draft": "testcases_draft",
        "In Review": "recommendation_pending",
        "Recommendation Pending": "recommendation_pending",
        "Review Completed": "qa_lead_approval_pending",
        "QA Lead Approval Pending": "qa_lead_approval_pending",
        "Approved": "testcases_approved",
    }
    pending_rows = _in_period(
        db.query(
            models.TestCase.created_by_id,
            models.TestCase.status,
            func.count(models.TestCase.id),
        ),
        models.TestCase.created_at, date_from, date_to,
    ).filter(
        models.TestCase.created_by_id.in_(tester_ids),
        models.TestCase.status.in_(tuple(pending_status_fields)),
    ).group_by(models.TestCase.created_by_id, models.TestCase.status).all()
    for tester_id, status, count in pending_rows:
        rows[int(tester_id)][pending_status_fields[status]] += int(count)

    current_assignments = (db.query(
        models.TestExecution.assigned_to_id,
        func.count(models.TestExecution.id),
    ).join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
      .filter(models.TestExecution.assigned_to_id.in_(tester_ids),
              models.TestCycle.status != "Completed")
      .group_by(models.TestExecution.assigned_to_id).all())
    for tester_id, count in current_assignments:
        rows[int(tester_id)]["current_execution_assignments"] = int(count)

    project_sets: dict[int, set[int]] = {tester_id: set() for tester_id in tester_ids}

    testcase_pairs = _in_period(
        db.query(models.TestCase.created_by_id, models.TestCase.project_id),
        models.TestCase.created_at, date_from, date_to,
    ).filter(models.TestCase.created_by_id.in_(tester_ids)).distinct().all()
    run_pairs = _in_period(
        db.query(models.TestExecutionRun.executed_by_id, models.TestCycle.project_id)
          .join(models.TestExecution, models.TestExecutionRun.execution_id == models.TestExecution.id)
          .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id),
        models.TestExecutionRun.executed_at, date_from, date_to,
    ).filter(models.TestExecutionRun.executed_by_id.in_(tester_ids)).distinct().all()
    defect_report_pairs = _in_period(
        db.query(models.Defect.reporter_id, models.TestCycle.project_id)
          .join(models.TestCycle, models.Defect.cycle_id == models.TestCycle.id),
        models.Defect.reported_at, date_from, date_to,
    ).filter(models.Defect.reporter_id.in_(tester_ids)).distinct().all()
    defect_retest_pairs = _in_period(
        db.query(models.Defect.retest_tester_id, models.TestCycle.project_id)
          .join(models.TestCycle, models.Defect.cycle_id == models.TestCycle.id),
        models.Defect.retest_at, date_from, date_to,
    ).filter(models.Defect.retest_tester_id.in_(tester_ids)).distinct().all()
    for tester_id, project_id in testcase_pairs + run_pairs + defect_report_pairs + defect_retest_pairs:
        if tester_id and project_id:
            project_sets[int(tester_id)].add(int(project_id))

    all_project_ids = sorted({project_id for project_ids in project_sets.values() for project_id in project_ids})
    project_names = {
        project.id: f"{project.project_key} — {project.name}"
        for project in (db.query(models.TestProject).filter(models.TestProject.id.in_(all_project_ids)).all()
                        if all_project_ids else [])
    }
    for tester_id, row in rows.items():
        row["last_activity"] = latest_by_tester.get(tester_id)
        row["projects_worked"] = len(project_sets[tester_id])
        row["project_names"] = [project_names.get(project_id, f"Project #{project_id}")
                                for project_id in sorted(project_sets[tester_id])]
        row["total_contributions"] = sum(row[field] for field, *_rest in count_specs)

    return {
        "active_contributors": sum(1 for row in rows.values() if row["total_contributions"] > 0),
        "testcases_created": sum(row["testcases_created"] for row in rows.values()),
        "testcases_draft": sum(row["testcases_draft"] for row in rows.values()),
        "recommendation_pending": sum(row["recommendation_pending"] for row in rows.values()),
        "qa_lead_approval_pending": sum(row["qa_lead_approval_pending"] for row in rows.values()),
        "testcases_approved": sum(row["testcases_approved"] for row in rows.values()),
        "defects_raised": sum(row["defects_raised"] for row in rows.values()),
        "retests_performed": sum(row["retests_performed"] for row in rows.values()),
        "executions_completed": sum(row["executions_completed"] for row in rows.values()),
        "projects_covered": len(all_project_ids),
    }


@router.get("/qa-tester-workload")
def qa_tester_workload(date_from: str | None = Query(None), date_to: str | None = Query(None),
                       db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    """QA-team-only capacity view. Work is converted to weighted concurrent
    assignment points so a QA Lead can see who is available, balanced, full,
    or overloaded. Shared requests divide their load across assigned testers."""
    _require_qa_dashboard_access(current_user)
    qa_testers = (db.query(models.User)
                  .join(models.UserRole, models.UserRole.user_id == models.User.id)
                  .filter(models.User.is_active == True,  # noqa: E712
                          models.UserRole.role.in_([Role.QA_ENGINEER, Role.SECURITY_ANALYST]),
                          models.User.department_assignments.any(
                              models.UserDepartment.department == QA_DEPARTMENT
                          ))
                  .distinct().order_by(models.User.full_name).all())
    # Period filters apply only to completed-work history below. Capacity is
    # a current-state view, so an active assignment must never disappear just
    # because its request was raised before the selected reporting window.
    functional_requests = (db.query(models.FunctionalRequest)
                           .filter(models.FunctionalRequest.status.in_(TESTER_WORKLOAD_STATUSES)).all())
    performance_requests = (db.query(models.PerformanceRequest)
                            .filter(models.PerformanceRequest.status.in_(PERFORMANCE_TESTER_WORKLOAD_STATUSES)).all())
    sast_requests = (db.query(models.SASTRequest)
                     .filter(models.SASTRequest.status.in_(SECURITY_ANALYST_WORKLOAD_STATUSES)).all())
    dast_requests = (db.query(models.DASTRequest)
                     .filter(models.DASTRequest.status.in_(SECURITY_ANALYST_WORKLOAD_STATUSES)).all())

    def role_label(user) -> str:
        roles = []
        if user and user.has_role(Role.QA_ENGINEER):
            roles.append("QA Tester")
        if user and user.has_role(Role.SECURITY_ANALYST):
            roles.append("Security Analyst")
        return " & ".join(roles) or "QA Team Member"

    def empty_row(user_id: int, user=None):
        return {
            "tester_id": user_id,
            "tester_name": user.full_name if user else f"User #{user_id}",
            "department": (", ".join(user.departments) if user and user.departments else None) or "—",
            "role_label": role_label(user),
            "status_counts": {status: 0 for status in TESTER_WORKLOAD_STATUSES},
            "source_counts": {"Functional": 0, "Performance": 0, "SAST": 0, "DAST": 0},
            "total_pending": 0,
            "occupied_points": 0.0,
            "queued_count": 0,
            "active_count": 0,
            "waiting_count": 0,
            "near_complete_count": 0,
            "assignments": [],
        }

    rows = {
        user.id: empty_row(user.id, user)
        for user in qa_testers
    }

    def add_assignment(tester_id: int, request, source: str, load: float, shared_by: int = 1):
        if tester_id not in rows:
            user = db.query(models.User).get(tester_id)
            rows[tester_id] = empty_row(tester_id, user)
        row = rows[tester_id]
        row["status_counts"][request.status] = row["status_counts"].get(request.status, 0) + 1
        row["source_counts"][source] += 1
        row["total_pending"] += 1
        row["occupied_points"] += float(load) / max(1, shared_by)
        row["assignments"].append({
            "request_id": request.request_id,
            "request_pk": request.id,
            "source": source,
            "application_name": request.application_name or "—",
            "status": request.status,
            "updated_at": request.updated_at or request.created_at,
            "is_current": True,
        })
        if request.status in _QUEUED_TESTER_STATUSES:
            row["queued_count"] += 1
        elif request.status in _WAITING_TESTER_STATUSES:
            row["waiting_count"] += 1
        elif request.status in _NEAR_COMPLETE_TESTER_STATUSES:
            row["near_complete_count"] += 1
        else:
            row["active_count"] += 1

    def add_requests(requests, source: str, load_map: dict):
        for request in requests:
            assigned_ids = _assigned_user_ids(request.assigned_tester_ids)
            if not assigned_ids:
                continue
            for tester_id in assigned_ids:
                add_assignment(tester_id, request, source, load_map.get(request.status, 0), len(assigned_ids))

    def add_security_requests(requests, source: str):
        for request in requests:
            if request.security_analyst_id:
                add_assignment(
                    request.security_analyst_id, request, source,
                    SECURITY_ANALYST_LOAD.get(request.status, 0),
                )

    add_requests(functional_requests, "Functional", FUNCTIONAL_TESTER_LOAD)
    add_requests(performance_requests, "Performance", PERFORMANCE_TESTER_LOAD)
    add_security_requests(sast_requests, "SAST")
    add_security_requests(dast_requests, "DAST")

    # Historical ledger: assignment columns remain on completed child
    # requests, so they provide a durable "worked on" record in addition to
    # the active-capacity figures above. Keep these out of occupancy totals.
    completed_sources = [
        (models.FunctionalRequest, "Functional", QA_REQUEST_TERMINAL_STATUSES, "assigned_tester_ids"),
        (models.PerformanceRequest, "Performance", PERFORMANCE_TERMINAL_STATUSES, "assigned_tester_ids"),
        (models.SASTRequest, "SAST", SAST_DAST_TERMINAL_STATUSES, "security_analyst_id"),
        (models.DASTRequest, "DAST", SAST_DAST_TERMINAL_STATUSES, "security_analyst_id"),
    ]
    for model, source, terminal_statuses, assignment_field in completed_sources:
        completed = (_in_period(db.query(model), model.updated_at, date_from, date_to)
                     .filter(model.status.in_(terminal_statuses)).all())
        for request in completed:
            raw_assignment = getattr(request, assignment_field)
            assigned_ids = ([raw_assignment] if assignment_field == "security_analyst_id" and raw_assignment
                            else _assigned_user_ids(raw_assignment))
            for tester_id in assigned_ids:
                if tester_id not in rows:
                    user = db.query(models.User).get(tester_id)
                    rows[tester_id] = empty_row(tester_id, user)
                rows[tester_id]["assignments"].append({
                    "request_id": request.request_id,
                    "request_pk": request.id,
                    "source": source,
                    "application_name": request.application_name or "—",
                    "status": request.status,
                    "updated_at": request.updated_at or request.created_at,
                    "is_current": False,
                })

    contribution_summary = _add_contribution_metrics(db, rows, date_from, date_to)

    for row in rows.values():
        row["assignments"].sort(key=lambda item: item["updated_at"] or datetime.datetime.min, reverse=True)
        row["occupied_points"] = round(row["occupied_points"], 2)
        row["occupancy_percent"] = round(row["occupied_points"] / TESTER_CAPACITY_POINTS * 100)
        row["available_percent"] = max(0, 100 - row["occupancy_percent"])
        row["occupancy_band"] = _occupancy_band(row["occupancy_percent"])

    result_rows = sorted(rows.values(), key=lambda row: (-row["occupancy_percent"], row["tester_name"].lower()))
    average_occupancy = round(sum(row["occupancy_percent"] for row in result_rows) / len(result_rows)) if result_rows else 0
    return {
        "statuses": TESTER_WORKLOAD_STATUSES,
        "rows": result_rows,
        "capacity_points": TESTER_CAPACITY_POINTS,
        "total_pending": sum(row["total_pending"] for row in result_rows),
        "testers_with_pending": sum(1 for row in result_rows if row["total_pending"] > 0),
        "average_occupancy": average_occupancy,
        "available_testers": sum(1 for row in result_rows if row["occupancy_percent"] < 50),
        "highly_occupied_testers": sum(1 for row in result_rows if row["occupancy_percent"] >= 80),
        "overloaded_testers": sum(1 for row in result_rows if row["occupancy_percent"] > 100),
        "contribution_summary": contribution_summary,
    }


@router.get("/qa-tester-contribution/{tester_id}")
def qa_tester_contribution_detail(
    tester_id: int,
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    limit: int = Query(100, ge=10, le=250),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Drill-down evidence behind one tester's contribution metrics."""
    _require_qa_dashboard_access(current_user)
    tester = db.query(models.User).filter(models.User.id == tester_id).first()
    if not tester:
        raise HTTPException(404, "QA tester not found")

    activities: list[dict] = []

    defect_rows = _in_period(
        db.query(models.Defect, models.TestCycle, models.TestProject)
          .outerjoin(models.TestCycle, models.Defect.cycle_id == models.TestCycle.id)
          .outerjoin(models.TestProject, models.TestCycle.project_id == models.TestProject.id),
        models.Defect.reported_at, date_from, date_to,
    ).filter(models.Defect.reporter_id == tester_id) \
     .order_by(models.Defect.reported_at.desc(), models.Defect.id.desc()).limit(limit).all()
    for defect, cycle, project in defect_rows:
        activities.append({
            "activity_id": f"defect-{defect.id}",
            "activity_type": "Defect Raised", "record_key": defect.defect_key,
            "description": defect.title, "status": defect.status,
            "activity_at": defect.reported_at,
            "project_id": project.id if project else None,
            "project_key": project.project_key if project else None,
            "project_name": project.name if project else None,
            "route": f"/defects?open={defect.defect_key}",
        })

    retest_rows = _in_period(
        db.query(models.Defect, models.TestCycle, models.TestProject)
          .outerjoin(models.TestCycle, models.Defect.cycle_id == models.TestCycle.id)
          .outerjoin(models.TestProject, models.TestCycle.project_id == models.TestProject.id),
        models.Defect.retest_at, date_from, date_to,
    ).filter(models.Defect.retest_tester_id == tester_id) \
     .order_by(models.Defect.retest_at.desc(), models.Defect.id.desc()).limit(limit).all()
    for defect, cycle, project in retest_rows:
        activities.append({
            "activity_id": f"retest-{defect.id}",
            "activity_type": "Defect Retested", "record_key": defect.defect_key,
            "description": defect.retest_actual_result or defect.retest_remarks or defect.title,
            "status": defect.retest_result or defect.status,
            "activity_at": defect.retest_at,
            "project_id": project.id if project else None,
            "project_key": project.project_key if project else None,
            "project_name": project.name if project else None,
            "route": f"/defects?open={defect.defect_key}",
        })

    run_rows = _in_period(
        db.query(models.TestExecutionRun, models.TestExecution, models.TestCase,
                 models.TestCycle, models.TestProject)
          .join(models.TestExecution, models.TestExecutionRun.execution_id == models.TestExecution.id)
          .join(models.TestCase, models.TestExecution.test_case_id == models.TestCase.id)
          .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
          .join(models.TestProject, models.TestCycle.project_id == models.TestProject.id),
        models.TestExecutionRun.executed_at, date_from, date_to,
    ).filter(models.TestExecutionRun.executed_by_id == tester_id) \
     .order_by(models.TestExecutionRun.executed_at.desc(), models.TestExecutionRun.id.desc()).limit(limit).all()
    for run, execution, test_case, cycle, project in run_rows:
        activities.append({
            "activity_id": f"execution-{run.id}",
            "activity_type": "Execution Attempt", "record_key": test_case.test_case_key,
            "description": f"{cycle.cycle_key} · Attempt {run.attempt_no}",
            "status": run.status, "activity_at": run.executed_at,
            "project_id": project.id, "project_key": project.project_key,
            "project_name": project.name,
            "route": f"/test-execution?project={project.id}&cycle={cycle.id}",
        })

    assignment_rows = (db.query(models.TestExecution, models.TestCase, models.TestCycle, models.TestProject)
                       .join(models.TestCase, models.TestExecution.test_case_id == models.TestCase.id)
                       .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
                       .join(models.TestProject, models.TestCycle.project_id == models.TestProject.id)
                       .filter(models.TestExecution.assigned_to_id == tester_id,
                               models.TestCycle.status != "Completed")
                       .order_by(models.TestExecution.assigned_at.desc(), models.TestExecution.id.desc())
                       .limit(limit).all())
    current_assignments = [{
        "record_key": test_case.test_case_key,
        "cycle_key": cycle.cycle_key,
        "cycle_status": cycle.status,
        "execution_status": execution.status,
        "assigned_at": execution.assigned_at,
        "project_id": project.id, "project_key": project.project_key,
        "project_name": project.name,
        "route": f"/test-execution?project={project.id}&cycle={cycle.id}",
    } for execution, test_case, cycle, project in assignment_rows]

    activities.sort(key=lambda item: item["activity_at"] or datetime.datetime.min, reverse=True)
    project_rollup: dict[int, dict] = {}
    for item in activities:
        project_id = item.get("project_id")
        if not project_id:
            continue
        project = project_rollup.setdefault(project_id, {
            "project_id": project_id, "project_key": item.get("project_key"),
            "project_name": item.get("project_name"),
            "activity_types": set(), "last_activity": None,
        })
        project["activity_types"].add(item["activity_type"])
        if not project["last_activity"] or (item["activity_at"] and item["activity_at"] > project["last_activity"]):
            project["last_activity"] = item["activity_at"]

    # Testcase detail records are deliberately excluded from this endpoint:
    # the management drill-down only needs Defects, Retests and Executions.
    # Preserve accurate Projects coverage with one compact grouped query,
    # without loading or serializing hundreds of testcase rows.
    testcase_project_rows = _in_period(
        db.query(
            models.TestProject.id,
            models.TestProject.project_key,
            models.TestProject.name,
            func.max(models.TestCase.created_at),
        ).join(models.TestCase, models.TestCase.project_id == models.TestProject.id),
        models.TestCase.created_at, date_from, date_to,
    ).filter(models.TestCase.created_by_id == tester_id).group_by(
        models.TestProject.id, models.TestProject.project_key, models.TestProject.name,
    ).all()
    for project_id, project_key, project_name, last_created_at in testcase_project_rows:
        project = project_rollup.setdefault(project_id, {
            "project_id": project_id, "project_key": project_key,
            "project_name": project_name, "activity_types": set(), "last_activity": None,
        })
        project["activity_types"].add("Testcase Created")
        if not project["last_activity"] or (last_created_at and last_created_at > project["last_activity"]):
            project["last_activity"] = last_created_at
    projects = sorted(project_rollup.values(), key=lambda item: item["last_activity"] or datetime.datetime.min, reverse=True)
    for project in projects:
        project["activity_types"] = sorted(project["activity_types"])

    return {
        "tester_id": tester.id, "tester_name": tester.full_name,
        "period": {"date_from": date_from, "date_to": date_to},
        "activities": activities[:limit], "current_assignments": current_assignments,
        "projects": projects, "detail_limit": limit,
    }


@router.get("/qa-contribution-export")
def export_qa_tester_contribution(
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    search: str | None = Query(None),
    department: str | None = Query(None),
    project: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Excel evidence pack for the visible management contribution scope."""
    _require_qa_dashboard_access(current_user)
    qa_testers = (db.query(models.User)
                  .join(models.UserRole, models.UserRole.user_id == models.User.id)
                  .filter(models.User.is_active == True,  # noqa: E712
                          models.UserRole.role.in_([Role.QA_ENGINEER, Role.SECURITY_ANALYST]),
                          models.User.department_assignments.any(
                              models.UserDepartment.department == QA_DEPARTMENT
                          ))
                  .distinct().order_by(models.User.full_name).all())
    rows = {
        user.id: {
            "tester_id": user.id, "tester_name": user.full_name,
            "department": (", ".join(user.departments) if user.departments else None) or "—",
        }
        for user in qa_testers
    }
    summary = _add_contribution_metrics(db, rows, date_from, date_to)
    result_rows = list(rows.values())
    if search:
        needle = search.strip().lower()
        result_rows = [row for row in result_rows if needle in f"{row['tester_name']} {row['department']}".lower()]
    if department:
        result_rows = [row for row in result_rows if department in row["department"]]
    if project:
        result_rows = [row for row in result_rows if project in row["project_names"]]

    visible_summary = {
        "active_contributors": sum(1 for row in result_rows if row["total_contributions"] > 0),
        "testcases_created": sum(row["testcases_created"] for row in result_rows),
        "testcases_draft": sum(row["testcases_draft"] for row in result_rows),
        "recommendation_pending": sum(row["recommendation_pending"] for row in result_rows),
        "qa_lead_approval_pending": sum(row["qa_lead_approval_pending"] for row in result_rows),
        "testcases_approved": sum(row["testcases_approved"] for row in result_rows),
        "defects_raised": sum(row["defects_raised"] for row in result_rows),
        "retests_performed": sum(row["retests_performed"] for row in result_rows),
        "executions_completed": sum(row["executions_completed"] for row in result_rows),
        "projects_covered": len({name for row in result_rows for name in row["project_names"]}),
    } if any((search, department, project)) else summary
    workbook = new_workbook()
    add_summary_sheet(
        workbook,
        "QA Contribution & Coverage",
        "Management evidence for testcase authoring, governed defects, retests, execution attempts, and Test Project coverage.",
        [
            ("Generated by", current_user.full_name), ("Generated at", models.now()),
            ("From", date_from or "All time"), ("To", date_to or "All time"),
            ("Tester search", search or "All"), ("Department", department or "All"),
            ("Project", project or "All"),
        ],
        [
            ("Active contributors", visible_summary["active_contributors"]),
            ("Test cases created", visible_summary["testcases_created"]),
            ("Draft test cases", visible_summary["testcases_draft"]),
            ("Recommendation pending", visible_summary["recommendation_pending"]),
            ("QA Lead approval pending", visible_summary["qa_lead_approval_pending"]),
            ("Approved test cases", visible_summary["testcases_approved"]),
            ("Defects raised", visible_summary["defects_raised"]),
            ("Retests performed", visible_summary["retests_performed"]),
            ("Execution attempts", visible_summary["executions_completed"]),
            ("Projects covered", visible_summary["projects_covered"]),
        ],
    )
    add_table_sheet(
        workbook, "Tester Contribution", "QA Tester Contribution & Coverage",
        ["QA Tester", "Department", "Test Cases Created", "Draft Test Cases", "Recommendation Pending", "QA Lead Approval Pending", "Approved Test Cases", "Defects Raised", "Retests Performed",
         "Execution Attempts", "Projects Worked On", "Project Names", "Current Assignments", "Last Activity"],
        [[
            row["tester_name"], row["department"], row["testcases_created"],
            row["testcases_draft"], row["recommendation_pending"],
            row["qa_lead_approval_pending"], row["testcases_approved"], row["defects_raised"],
            row["retests_performed"], row["executions_completed"], row["projects_worked"],
            "; ".join(row["project_names"]), row["current_execution_assignments"], row["last_activity"],
        ] for row in result_rows],
        date_headers={"Last Activity"}, widths={"QA Tester": 24, "Department": 24, "Project Names": 42},
    )
    return workbook_response(workbook, "qa-contribution-and-coverage.xlsx")


def _age_days(dt) -> int:
    if not dt:
        return 0
    if isinstance(dt, datetime.date) and not isinstance(dt, datetime.datetime):
        dt = datetime.datetime(dt.year, dt.month, dt.day)
    # `updated_at`/`created_at` are plain `Column(DateTime)` (no
    # timezone=True), so Oracle round-trips them as naive datetimes even
    # though `models.now()` writes them as IST wall-clock time -- models.
    # as_aware() treats a naive value as already being in IST rather than
    # comparing it against a UTC-derived "now" (which raised "can't
    # subtract offset-naive and offset-aware datetimes"). Shared helper --
    # see its own docstring for the full story and every other call site
    # that needed the same fix.
    dt = models.as_aware(dt)
    now = models.now()
    return (now - dt).days


_SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Informational"]


def _worst_severity(items):
    """Highest-severity finding among a SuppressionRequest's items (see
    models.SuppressionItem) -- used wherever a single "priority" value is
    needed for a suppression request that may now cover several findings."""
    worst = None
    for i in items:
        if worst is None or _SEVERITY_ORDER.index(i.severity) < _SEVERITY_ORDER.index(worst):
            worst = i.severity
    return worst


def _ageing_bucket(days: int) -> str:
    if days <= 3:
        return "0-3 days"
    if days <= 7:
        return "4-7 days"
    if days <= 15:
        return "8-15 days"
    if days <= 30:
        return "16-30 days"
    return "30+ days"


# ---------------- 4.9.1 / 4.9.2 Project-wise Dashboard ----------------
@router.get("/project-wise")
def project_wise(date_from: str | None = Query(None), date_to: str | None = Query(None),
                 db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    scope = dashboard_department_scope(current_user)
    # The QA Request is now just an intake gateway (see constants.GatewayStatus)
    # -- the actual QAStatus workflow being measured here lives on the linked
    # Functional Testing Request (see models.FunctionalRequest).
    requests = _join_qa_department(
        _in_period(db.query(models.FunctionalRequest), models.FunctionalRequest.created_at, date_from, date_to),
        models.FunctionalRequest, scope).all()
    active_projects = len({
        r.cr_number or r.epic_number
        for r in requests
        if r.status in ACTIVE_QA_STATUSES and (r.cr_number or r.epic_number)
    })

    # Reported directly: "in dashboard sast dast findings showing 0
    # result." Used to count models.SASTFinding/DASTFinding rows -- the old
    # manually-logged findings tables, which nothing has written to since
    # findings moved to Fortify SSC imports (see _latest_scan_by_request's
    # own comment above). "Open security findings" now means each in-scope
    # SAST/DAST request's OWN latest scan's total_count, summed -- current
    # open findings across the portal, not a raw historical row count.
    sast_ids = [r.id for r in _join_qa_department(
        _in_period(db.query(models.SASTRequest), models.SASTRequest.created_at, date_from, date_to),
        models.SASTRequest, scope).all()]
    dast_ids = [r.id for r in _join_qa_department(
        _in_period(db.query(models.DASTRequest), models.DASTRequest.created_at, date_from, date_to),
        models.DASTRequest, scope).all()]
    sast_findings = sum(s.total_count for s in _latest_scan_by_request(db, "SAST", sast_ids).values())
    dast_findings = sum(s.total_count for s in _latest_scan_by_request(db, "DAST", dast_ids).values())

    # Was QA-Request-only, which disagreed with the "approvals needing
    # attention" count shown elsewhere in the app (e.g. the old Approval
    # Workflow Log nav badge) -- if the one pending item was actually a SAST/
    # DAST/Suppression request, approving it there never changed this number,
    # so the Dashboard banner looked stuck even after it was cleared.
    # Now counts the same things everywhere: QA Requests awaiting a decision,
    # plus SAST/DAST requests still "Requested", plus open Suppressions.
    _pending_suppressions_q = _in_period(
        db.query(models.SuppressionRequest), models.SuppressionRequest.created_at, date_from, date_to
    ).filter(models.SuppressionRequest.status.notin_(SUPPRESSION_TERMINAL_STATUSES))
    if scope:
        _pending_suppressions_q = _pending_suppressions_q.filter(models.SuppressionRequest.department.in_(scope))
    pending_approvals = (
        len([r for r in requests if r.status in PENDING_APPROVAL_STATUSES])
        + _join_qa_department(_in_period(db.query(models.SASTRequest), models.SASTRequest.created_at, date_from, date_to).filter(
            models.SASTRequest.status.in_(SAST_DAST_PENDING_APPROVAL_STATUSES)), models.SASTRequest, scope).count()
        + _join_qa_department(_in_period(db.query(models.DASTRequest), models.DASTRequest.created_at, date_from, date_to).filter(
            models.DASTRequest.status.in_(SAST_DAST_PENDING_APPROVAL_STATUSES)), models.DASTRequest, scope).count()
        + _pending_suppressions_q.count()
    )

    risk_counts = Counter(r.risk_rating for r in requests if r.risk_rating)

    return {
        "metrics": {
            "active_projects": active_projects,
            "sast_findings": sast_findings,
            "dast_findings": dast_findings,
            "pending_approvals": pending_approvals,
        },
        "charts": {
            "risk_distribution": risk_counts,
        },
    }


# DSH-001..004 -- (type, created_at column, status column, terminal-status
# list) for each of the 4 child request types CommandCentre's own
# "Active requests (org-wide)" stat card counts -- mirrors
# frontend/src/Dashboard.tsx's TERMINAL_STATUSES_BY_TYPE/isActiveRequest
# exactly (a request is "active" if its status isn't DRAFT and isn't in its
# own type's terminal list). The QA Request gateway itself is deliberately
# excluded, same as Dashboard.tsx's own unifiedRequests -- it's an intake
# wrapper, not an additional testing work item, and including it would
# inflate this count by one per parent.
_ACTIVE_REQUEST_MODELS = [
    (models.FunctionalRequest, QA_REQUEST_TERMINAL_STATUSES),
    (models.SASTRequest, SAST_DAST_TERMINAL_STATUSES),
    (models.DASTRequest, SAST_DAST_TERMINAL_STATUSES),
    (models.PerformanceRequest, PERFORMANCE_TERMINAL_STATUSES),
]


@router.get("/summary")
def dashboard_summary(date_from: str | None = Query(None), date_to: str | None = Query(None),
                      db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """DSH-001..004 -- consolidates the handful of derived numbers
    CommandCentre used to compute in the browser (see Dashboard.tsx's own
    comment on the fetch this replaces) by pulling all 5 request types'
    "complete" lists (page_size=100 -- not even reliably complete past 100
    of a single type) just to run a few `.filter().length` calls over them.
    `project-wise`/`3w` above already cover the rest of CommandCentre's
    stats via their own dedicated endpoints; this fills the remaining gap
    (the "Active requests" stat card, the "critical pending" tag on the
    approvals card, the "nearing release" footline, and the QA Lifecycle
    Health stepper) with real SQL `COUNT`/`GROUP BY`, never a full-row
    fetch.

    `active_requests_count`/`child_requests_total` respect `date_from`/
    `date_to` (created_at-scoped, mirroring project-wise/3w's own
    convention). `nearing_release_count`/`critical_pending_count`/
    `functional_status_counts` deliberately do not -- matching
    CommandCentre's own pre-existing behavior, where those three were never
    range-filtered client-side either.

    DSH-005/006 -- read-through Redis cache, 60s TTL, keyed by department
    scope + the two date params (this summary's only real inputs) so one
    department's cached response is never served to another. See
    `cache.py`'s own module docstring for why this degrades to "just
    compute it every time" rather than erroring when Redis isn't
    configured/reachable -- `cache.get_json`/`set_json` never raise."""
    scope = dashboard_department_scope(current_user)
    # 2026-08 CR -- scope is now a list; join it into a stable, readable cache
    # key segment (sorted so department order never produces a cache miss).
    cache_key = f"dashboard:summary:v1:{','.join(sorted(scope)) if scope else 'all'}:{date_from or ''}:{date_to or ''}"
    cached = cache.get_json(cache_key)
    if cached is not None:
        return cached

    child_requests_total = 0
    active_requests_count = 0
    for model, terminal_statuses in _ACTIVE_REQUEST_MODELS:
        q = _join_qa_department(_in_period(db.query(model), model.created_at, date_from, date_to), model, scope)
        child_requests_total += q.count()
        active_requests_count += q.filter(model.status.notin_(list(terminal_statuses) + ["DRAFT"])).count()

    # Not range-filtered -- see docstring above. target_release_date is a
    # plain Date column (no time component), so this compares against
    # today's date rather than the full now() datetime `_date_bounds` uses
    # elsewhere in this file.
    today = models.now().date()
    nearing_release_q = db.query(models.QARequest).filter(
        models.QARequest.target_release_date.isnot(None),
        models.QARequest.target_release_date >= today,
        models.QARequest.target_release_date <= today + datetime.timedelta(days=14),
    )
    if scope:
        nearing_release_q = nearing_release_q.filter(models.QARequest.department.in_(scope))
    nearing_release_count = nearing_release_q.count()

    critical_pending_q = db.query(models.FunctionalRequest).filter(
        models.FunctionalRequest.status.in_([
            QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.READINESS_VERIFICATION,
            QAStatus.QA_SIGNOFF_PENDING, QAStatus.REQUESTER_VERIFICATION,
        ]),
        models.FunctionalRequest.priority == "Critical",
    )
    critical_pending_q = _join_qa_department(critical_pending_q, models.FunctionalRequest, scope)
    critical_pending_count = critical_pending_q.count()

    # QA Lifecycle Health (LifecycleStepper) only ever reads each row's own
    # `status` -- a GROUP BY count dict feeds its existing client-side
    # stage-bucketing (STATUS_STAGE_INDEX in Dashboard.tsx) exactly as well
    # as full rows would, without fetching them. Kept as raw per-status
    # counts (not pre-bucketed into the 6 lifecycle stages here) so the
    # stage grouping stays defined in exactly one place -- Dashboard.tsx's
    # own STATUS_STAGE_INDEX -- instead of two copies that could drift.
    functional_status_q = _join_qa_department(db.query(models.FunctionalRequest), models.FunctionalRequest, scope)
    functional_status_counts = dict(
        functional_status_q.with_entities(models.FunctionalRequest.status, func.count(models.FunctionalRequest.id))
        .group_by(models.FunctionalRequest.status).all()
    )

    result = {
        "child_requests_total": child_requests_total,
        "active_requests_count": active_requests_count,
        "nearing_release_count": nearing_release_count,
        "critical_pending_count": critical_pending_count,
        "functional_status_counts": functional_status_counts,
    }
    cache.set_json(cache_key, result, ttl_seconds=60)
    return result


# ---------------- 4.9.5 / 4.9.6 Security Dashboards ----------------
@router.get("/security/sast")
def security_sast(date_from: str | None = Query(None), date_to: str | None = Query(None), db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    scope = dashboard_department_scope(current_user)
    reqs = _join_qa_department(
        _in_period(db.query(models.SASTRequest), models.SASTRequest.created_at, date_from, date_to), models.SASTRequest, scope).all()
    # Reported directly: "in dashboard sast dast findings showing 0
    # result." Used to read models.SASTFinding -- see
    # _latest_scan_by_request's own comment for why that's always empty
    # now. Each request's own latest Fortify SSC scan (if it's been
    # scanned at least once) stands in for "its findings" below.
    latest_scans = _latest_scan_by_request(db, "SAST", [r.id for r in reqs])
    severity_totals = Counter()
    for scan in latest_scans.values():
        severity_totals["Critical"] += scan.critical_count
        severity_totals["High"] += scan.high_count
        severity_totals["Medium"] += scan.medium_count
        severity_totals["Low"] += scan.low_count
    # "Current disposition of identified findings" -- of the requests that
    # have actually been scanned, how many now show 0 open findings on
    # their latest scan (Resolved) vs still have some (Open). Requests
    # never scanned yet have no findings to have a disposition about, so
    # they're left out of this one distribution (they still count in
    # total_requests above).
    remediation_status = Counter(
        "Resolved" if scan.total_count == 0 else "Open"
        for scan in latest_scans.values()
    )
    return {
        # Every SAST request ever raised, any status -- distinct from
        # applications_scanned below (only those that actually finished
        # scanning). Answers "how many SAST requests are there", not "how
        # many have been scanned".
        "total_requests": len(reqs),
        "applications_scanned": len({r.application_name for r in reqs if r.status in ("REPORT_READY", "CLOSED")}),
        "open_vulnerabilities": sum(scan.total_count for scan in latest_scans.values()),
        "severity_distribution": severity_totals,
        "remediation_status": remediation_status,
    }


@router.get("/security/dast")
def security_dast(date_from: str | None = Query(None), date_to: str | None = Query(None), db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    scope = dashboard_department_scope(current_user)
    reqs = _join_qa_department(
        _in_period(db.query(models.DASTRequest), models.DASTRequest.created_at, date_from, date_to), models.DASTRequest, scope).all()
    # Reported directly: "in dashboard sast dast findings showing 0
    # result." Used to read models.DASTFinding -- see
    # _latest_scan_by_request's own comment (and security_sast's matching
    # fix just above) for why that's always empty now.
    latest_scans = _latest_scan_by_request(db, "DAST", [r.id for r in reqs])
    vulnerability_totals = Counter()
    for scan in latest_scans.values():
        vulnerability_totals["Critical"] += scan.critical_count
        vulnerability_totals["High"] += scan.high_count
        vulnerability_totals["Medium"] += scan.medium_count
        vulnerability_totals["Low"] += scan.low_count
    # scan_coverage used to count every DAST request's application_url
    # regardless of status -- including ones still sitting in Draft/SM
    # Approval/Configuration that have never actually been scanned. Scoped
    # down to REPORT_READY/CLOSED only, matching SAST's own
    # applications_scanned above, so this only ever reflects applications
    # that were actually scanned.
    scanned_reqs = [r for r in reqs if r.status in ("REPORT_READY", "CLOSED")]
    return {
        # Every DAST request ever raised, any status -- see the matching
        # comment on total_requests in security_sast above.
        "total_requests": len(reqs),
        "scan_coverage": len({r.application_url for r in scanned_reqs if r.application_url}),
        "vulnerability_trends": vulnerability_totals,
        # compliance_status was never actually broken -- it reads DASTRequest.status directly,
        # not DASTFinding, so it's untouched here.
        "compliance_status": Counter(r.status for r in reqs),
    }


# ---------------- 4.9.7 Suppression Dashboard ----------------
@router.get("/suppression")
def suppression_dashboard(date_from: str | None = Query(None), date_to: str | None = Query(None), db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    scope = dashboard_department_scope(current_user)
    q = _in_period(db.query(models.SuppressionRequest), models.SuppressionRequest.created_at, date_from, date_to)
    # SuppressionRequest.department is a real column (auto-populated at
    # creation time, see its own column comment in models.py) -- unlike
    # Functional/SAST/DAST/Performance, no join needed here.
    if scope:
        q = q.filter(models.SuppressionRequest.department.in_(scope))
    sups = q.all()
    open_sups = [s for s in sups if s.status not in SUPPRESSION_TERMINAL_STATUSES]
    # A suppression request can cover several findings (models.SuppressionItem)
    # -- count it as critical/high risk if ANY of its findings are.
    critical_high = [s for s in open_sups if any(i.severity in ("Critical", "High") for i in s.items)]
    return {
        "open_suppressions": len(open_sups),
        "critical_high_risk_exceptions": len(critical_high),
        "status_breakdown": Counter(s.status for s in sups),
    }


# ---------------- 4.9.8 3W Project Dashboard (What / Where / Since When) ----------------
STAGE_LABELS = {
    QAStatus.SUBMITTED: "SM Approval Pending",
    QAStatus.SM_APPROVAL_PENDING: "SM Approval Pending",
    QAStatus.RETURNED_BY_SM: "Rework by Requester Pending",
    # Reported directly: Rejected by SM is now reopenable by the requester
    # (edit + resubmit, see routers/functional.py::resubmit_request) rather
    # than a dead end -- surfaced on this ageing dashboard the same way
    # RETURNED_BY_SM already is.
    QAStatus.SM_REJECTED: "Rework by Requester Pending",
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING: "Department Head Approval Pending",
    QAStatus.RETURNED_BY_DEPARTMENT_HEAD: "Rework by Requester Pending",
    QAStatus.QA_LEAD_ASSIGNED: "QA Readiness Verification Pending",
    QAStatus.READINESS_VERIFICATION: "Readiness Verification In Progress",
    QAStatus.RETURNED_BY_QA_LEAD: "Rework by Requester Pending",
    QAStatus.QA_ACTIVITY_INITIATED: "Planning Pending",
    QAStatus.PLANNING: "Tester Assignment Pending",
    QAStatus.TESTER_ASSIGNED: "Test Design Pending",
    QAStatus.TEST_DESIGN: "Execution Pending",
    QAStatus.EXECUTION_IN_PROGRESS: "Test Execution In Progress",
    QAStatus.DEFECT_RAISED: "Fix Pending",
    QAStatus.WAITING_FOR_FIX: "Fix Pending",
    QAStatus.RETESTING: "Retesting In Progress",
    QAStatus.QA_COMPLETED: "Sign-off Request Pending",
    QAStatus.QA_SIGNOFF_PENDING: "QA Sign-off Pending",
    QAStatus.QA_SIGNED_OFF: "Requester Verification Pending",
    QAStatus.REQUESTER_VERIFICATION: "Requester Verification Pending",
}
STAGE_TEAM = {
    QAStatus.SUBMITTED: "SM",
    QAStatus.SM_APPROVAL_PENDING: "SM",
    QAStatus.RETURNED_BY_SM: "Requester",
    QAStatus.SM_REJECTED: "Requester",
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING: "Department Head",
    QAStatus.RETURNED_BY_DEPARTMENT_HEAD: "Requester",
    QAStatus.QA_LEAD_ASSIGNED: "QA Lead",
    QAStatus.READINESS_VERIFICATION: "QA Lead",
    QAStatus.RETURNED_BY_QA_LEAD: "Requester",
    QAStatus.QA_ACTIVITY_INITIATED: "QA Lead",
    QAStatus.PLANNING: "QA Lead",
    QAStatus.TESTER_ASSIGNED: "QA",
    QAStatus.TEST_DESIGN: "QA",
    QAStatus.EXECUTION_IN_PROGRESS: "QA",
    # The defect itself must be fixed by the requester/dev side, even though a
    # QA Lead/Engineer clicks the button to move the status along -- so from a
    # "where is this actually sitting" standpoint it belongs with the Requester.
    QAStatus.DEFECT_RAISED: "Requester",
    QAStatus.WAITING_FOR_FIX: "Requester",
    QAStatus.RETESTING: "QA",
    QAStatus.QA_COMPLETED: "QA Lead",
    QAStatus.QA_SIGNOFF_PENDING: "QA Lead",
    QAStatus.QA_SIGNED_OFF: "Requester",
    QAStatus.REQUESTER_VERIFICATION: "Requester",
}

# "Pending At" is the readable current workflow stage; "Pending With" is
# the role that must perform the next action. These are deliberately separate
# from responsible_team, which is the owning business department in 3W.
SAST_DAST_PENDING_WITH = {
    "DRAFT": "Requester", "SUBMITTED": "SM", "SM_APPROVAL_PENDING": "SM",
    "RETURNED_BY_SM": "Requester", "SM_REJECTED": "Requester",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head",
    "RETURNED_BY_DEPARTMENT_HEAD": "Requester",
    "SECURITY_LEAD_ASSIGNED": "QA Lead", "SECURITY_READINESS": "QA Lead",
    "RETURNED_BY_SECURITY_LEAD": "Requester", "PLANNING": "QA Lead",
    "CONFIGURATION": "Security Analyst", "SCANNING": "Security Analyst",
    "FINDING_VALIDATION": "Security Analyst", "REMEDIATION": "Security Analyst",
    "ASSIGNED_TO_REQUESTER": "Requester", "WAITING_FOR_FIX": "Requester",
    "ASSIGNED_TO_LEAD": "Security Analyst", "RESCAN": "Security Analyst",
    "SECURITY_COMPLETE": "Security Analyst", "REPORT_READY": "Security Analyst",
}
PERFORMANCE_PENDING_WITH = {
    "DRAFT": "Requester", "SUBMITTED": "SM", "SM_APPROVAL_PENDING": "SM",
    "RETURNED_BY_SM": "Requester", "SM_REJECTED": "Requester",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head",
    "RETURNED_BY_DEPARTMENT_HEAD": "Requester",
    "ENGINEER_ASSIGNED": "QA Lead", "RETURNED_BY_ENGINEER": "Requester",
    "READINESS": "QA Lead", "FEASIBILITY": "QA Lead", "PLANNING": "QA Lead",
    "ENVIRONMENT_SETUP": "QA", "SCRIPT_DEVELOPMENT": "QA", "BASELINE": "QA",
    "LOAD_TEST_EXECUTION": "QA", "RESULT_ANALYSIS": "QA Lead",
    "DEFECT_FIX_RETEST": "Requester", "REPORT": "QA Lead",
    "SIGNOFF_PENDING": "QA Lead", "SIGNED_OFF": "Requester",
    "REQUESTER_VERIFICATION": "Requester",
}


@router.get("/3w")
def three_w_dashboard(date_from: str | None = Query(None), date_to: str | None = Query(None), db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """
    'Know What Is Pending, Where It Is Pending, and Since When' -- section 4.9.8.
    Aggregates pending items across QA requests, SAST/DAST requests and suppression
    requests with ageing, responsible team/owner, and priority.
    """
    items = []
    scope = dashboard_department_scope(current_user)

    for r in _join_qa_department(
            _in_period(db.query(models.FunctionalRequest), models.FunctionalRequest.updated_at, date_from, date_to)
            .filter(models.FunctionalRequest.status.in_(list(STAGE_LABELS.keys()))),
            models.FunctionalRequest, scope).all():
        age = _age_days(r.updated_at)
        items.append({
            "project_id": r.request_id, "epic_number": r.cr_number or r.epic_number or r.application_name,
            "application_name": r.application_name, "pending_stage": STAGE_LABELS.get(r.status, r.status),
            "responsible_team": r.department or "Unassigned Department",
            "pending_with": STAGE_TEAM.get(r.status, "QA"), "owner": r.application_owner,
            "department": r.department,
            "pending_since": r.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": r.priority, "status": r.status, "source": "Functional Testing Request",
        })

    for r in _join_qa_department(
            _in_period(db.query(models.SASTRequest), models.SASTRequest.updated_at, date_from, date_to).filter(
                models.SASTRequest.status.notin_(SAST_DAST_TERMINAL_STATUSES)),
            models.SASTRequest, scope).all():
        age = _age_days(r.updated_at)
        items.append({
            "project_id": r.request_id, "epic_number": r.cr_number or r.epic_number or r.application_name,
            "application_name": r.application_name,
            "pending_stage": f"SAST - {SAST_DAST_STATUS_LABELS.get(r.status, r.status)}",
            "responsible_team": r.department or "Unassigned Department",
            "pending_with": SAST_DAST_PENDING_WITH.get(r.status, "Security Analyst"), "owner": None,
            "department": r.department,
            "pending_since": r.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": r.risk_category, "status": r.status, "source": "SAST Request",
        })

    for r in _join_qa_department(
            _in_period(db.query(models.DASTRequest), models.DASTRequest.updated_at, date_from, date_to).filter(
                models.DASTRequest.status.notin_(SAST_DAST_TERMINAL_STATUSES)),
            models.DASTRequest, scope).all():
        age = _age_days(r.updated_at)
        items.append({
            "project_id": r.request_id, "epic_number": r.cr_number or r.epic_number or r.application_name,
            "application_name": r.application_name or r.application_url,
            "pending_stage": f"DAST - {SAST_DAST_STATUS_LABELS.get(r.status, r.status)}",
            "responsible_team": r.department or "Unassigned Department",
            "pending_with": SAST_DAST_PENDING_WITH.get(r.status, "Security Analyst"), "owner": None,
            "department": r.department,
            "pending_since": r.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": r.risk_category, "status": r.status, "source": "DAST Request",
        })

    for r in _join_qa_department(
            _in_period(db.query(models.PerformanceRequest), models.PerformanceRequest.updated_at, date_from, date_to)
            .filter(models.PerformanceRequest.status.notin_(PERFORMANCE_TERMINAL_STATUSES)),
            models.PerformanceRequest, scope).all():
        age = _age_days(r.updated_at)
        items.append({
            "project_id": r.request_id, "epic_number": r.cr_number or r.epic_number or r.application_name,
            "application_name": r.application_name,
            "pending_stage": f"Performance - {PERFORMANCE_STATUS_LABELS.get(r.status, r.status)}",
            "responsible_team": r.department or "Unassigned Department",
            "pending_with": PERFORMANCE_PENDING_WITH.get(r.status, "QA Lead"),
            "owner": r.application_owner, "department": r.department,
            "pending_since": r.updated_at, "ageing_days": age,
            "ageing_bucket": _ageing_bucket(age),
            "priority": r.priority or r.risk_category, "status": r.status,
            "source": "Performance Request",
        })

    _SUPPRESSION_STAGE_TEAM = {
        "SM_APPROVAL_PENDING": "SM",
        "RETURNED_BY_SM": "Requester",
        "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head",
        "RETURNED_BY_DEPARTMENT_HEAD": "Requester",
        "SECURITY_TEAM_VERIFICATION": "Security Team",
    }
    _suppression_q = _in_period(db.query(models.SuppressionRequest), models.SuppressionRequest.updated_at, date_from, date_to).filter(
        models.SuppressionRequest.status.notin_(SUPPRESSION_TERMINAL_STATUSES))
    if scope:
        _suppression_q = _suppression_q.filter(models.SuppressionRequest.department.in_(scope))
    for s in _suppression_q.all():
        age = _age_days(s.updated_at)
        team = _SUPPRESSION_STAGE_TEAM.get(s.status, "Requester")
        items.append({
            "project_id": s.suppression_id, "epic_number": s.application_name,
            "application_name": s.application_name, "pending_stage": s.status,
            "responsible_team": s.department or "Unassigned Department",
            "pending_with": team, "owner": None,
            "department": s.department,
            "pending_since": s.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": _worst_severity(s.items), "status": s.status, "source": "Suppression Request",
        })

    team_dist = Counter(i["responsible_team"] for i in items)
    ageing_dist = Counter(i["ageing_bucket"] for i in items)
    priority_dist = Counter(i["priority"] for i in items if i["priority"])
    owner_dist = Counter(i["owner"] for i in items if i["owner"])

    return {
        "total_pending": len(items),
        "team_wise_distribution": team_dist,
        "ageing_bucket_distribution": ageing_dist,
        "priority_distribution": priority_dist,
        "owner_wise_distribution": owner_dist,
        "items": sorted(items, key=lambda x: x["ageing_days"], reverse=True),
    }


@router.get("/3w/{project_id}")
def three_w_project_detail(project_id: str, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    """Drill-down: selecting a Project ID shows its full lifecycle + audit trail."""
    req = db.query(models.FunctionalRequest).filter(models.FunctionalRequest.request_id == project_id).first()
    if not req:
        return {"detail": "Project not found"}
    scope = dashboard_department_scope(current_user)
    if scope and req.department not in scope:
        # Same department scoping as the 3W list above (see
        # dashboard_department_scope) -- without this, a scoped user could
        # still drill into an out-of-department project's own lifecycle/audit
        # trail directly by its request_id even though the list itself
        # already hides it. Reuses the same "not found" shape as a genuinely
        # missing project rather than a 403, so this isn't distinguishable
        # from "this project ID doesn't exist" -- consistent with how the
        # list simply omits it instead of showing a blocked placeholder.
        return {"detail": "Project not found"}
    history = (db.query(models.ApprovalAction)
               .filter_by(entity_type="FUNCTIONAL_REQUEST", entity_id=req.id)
               .order_by(models.ApprovalAction.created_at).all())
    checklist = db.query(models.ReadinessChecklistItem).filter_by(functional_request_id=req.id).all()
    return {
        "project_id": req.request_id,
        "application_name": req.application_name,
        "status": req.status,
        "priority": req.priority,
        "risk_rating": req.risk_rating,
        "ageing_days": _age_days(req.updated_at),
        "lifecycle": [
            {"step": h.step_name, "decision": h.decision, "actor_role": h.actor_role,
             "comments": h.comments, "at": h.created_at}
            for h in history
        ],
        "readiness_checklist": [
            {"item": c.item, "owner": c.owner, "complete": c.is_complete} for c in checklist
        ],
    }
