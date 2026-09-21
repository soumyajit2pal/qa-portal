import datetime
from collections import Counter, defaultdict
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, false, func, or_, select
from sqlalchemy.orm import Session, joinedload, selectinload

from .. import models
from ..database import get_db
from ..deps import (
    get_current_user, dashboard_department_scope, resolve_entity_department,
    resolve_entity_workspace_id, active_qa_workspace_scope_ids, viewable_project_ids,
)
from ..workspace_service import selectable_workspace_ids
from ..constants import QAStatus, GatewayStatus, REQUEST_TYPES, Role
from ..pdf_export import (
    DIGITAL_SIGNATURE_METHOD,
    QA_CLEARANCE_SIGNED_TYPE,
    parse_electronic_signature,
    qa_clearance_export_status,
)
from ..workspace_service import workspace_context

router = APIRouter(prefix="/api/reports", tags=["reports"])


_GATEWAY_PRIVATE_STATUSES = (GatewayStatus.DRAFT, GatewayStatus.CANCELLED)


def _period_bounds(date_from: str | None, date_to: str | None):
    try:
        start = datetime.datetime.fromisoformat(date_from.replace("Z", "+00:00")) if date_from else None
        end = datetime.datetime.fromisoformat(date_to.replace("Z", "+00:00")) if date_to else None
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "Invalid date filter. Use ISO date/time format.") from exc
    # Database datetimes are stored as naive local values, as in dashboard.py.
    if start and start.tzinfo:
        start = start.astimezone(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).replace(tzinfo=None)
    if end and end.tzinfo:
        end = end.astimezone(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).replace(tzinfo=None)
    if start and end and start > end:
        raise HTTPException(400, "date_from must be earlier than or equal to date_to.")
    return start, end


def _in_period(query, column, date_from: str | None, date_to: str | None):
    start, end = _period_bounds(date_from, date_to)
    if start:
        query = query.filter(column >= start)
    if end:
        query = query.filter(column <= end)
    return query


def _visible_qa_requests(db: Session, current_user: models.User, date_from: str | None = None, date_to: str | None = None):
    """Reported bug: this and the other report endpoints below queried every
    QARequest row unfiltered, so the "QA Request Summary" report (visible to
    every logged-in user, not just QA/management roles -- see
    Layout.tsx's nav, /reports has no role gate) leaked every user's
    still-Draft gateway requests -- Request ID, Application Name,
    Department, etc. -- to everyone. Same rule as
    routers/qa_requests.py::_can_view_gateway: Draft AND Cancelled (which can
    only ever be reached FROM Draft -- there is no cancel path from Raised --
    so it's always an abandoned Draft, never a real workflow) are only
    visible to their own requester (or an Admin); once genuinely Raised it's
    fair game for reporting like everything else.

    Also applies dashboard_department_scope (reported directly: "Report &
    Export Centre ... everything also by department only. other department
    data can not be shown") -- QARequest.department is a real column, so a
    direct .filter() is enough; every report/export below either calls this
    helper directly or applies the equivalent join/filter for its own model,
    so no report can surface another department's data."""
    q = db.query(models.QARequest)
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if workspace_ids:
        q = q.filter(models.QARequest.qa_workspace_id.in_(workspace_ids))
    if not current_user.has_role(Role.ADMIN):
        q = q.filter(or_(
            models.QARequest.status.notin_(_GATEWAY_PRIVATE_STATUSES),
            models.QARequest.requester_id == current_user.id,
        ))
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = q.filter(models.QARequest.department.in_(scope))
    return _in_period(q, models.QARequest.created_at, date_from, date_to)


def _visible_test_projects(db: Session, current_user: models.User, date_from: str | None = None, date_to: str | None = None):
    q = db.query(models.TestProject)
    project_ids = viewable_project_ids(db, current_user)
    if project_ids is not None:
        q = q.filter(models.TestProject.id.in_(project_ids))
    return _in_period(q, models.TestProject.created_at, date_from, date_to)


def _visible_defects(db: Session, current_user: models.User, date_from: str | None = None, date_to: str | None = None):
    """Report-centre equivalent of Defect Management's visibility scope."""
    from .defects import _scoped_defects
    q = _scoped_defects(db, current_user)
    return _in_period(q, models.Defect.reported_at, date_from, date_to)


def _user_name_map(db: Session, ids) -> dict[int, str]:
    clean_ids = sorted({int(value) for value in ids if value})
    if not clean_ids:
        return {}
    return {user.id: user.full_name for user in db.query(models.User).filter(
        _batched_ids(models.User.id, clean_ids),
    ).all()}


def _workspace_child(query, model, current_user: models.User):
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if not workspace_ids:
        return query
    return query.filter(model.qa_request_id.in_(select(models.QARequest.id).where(
        models.QARequest.qa_workspace_id.in_(workspace_ids))))


# ---------------- 4.10.1 Operational Reports ----------------
@router.get("/qa-request-summary")
def qa_request_summary(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """One row per QA Request (the intake gateway -- see constants.GatewayStatus
    for its own Draft/Submitted/Raised/Cancelled status). "QA Testing Status"
    additionally surfaces the linked Functional Testing Request's own Draft ->
    ... -> Closed status, if one was raised alongside it."""
    rows = _visible_qa_requests(db, current_user, date_from, date_to).options(
        selectinload(models.QARequest.linked_functional_requests),
        selectinload(models.QARequest.linked_sast_requests),
        selectinload(models.QARequest.linked_dast_requests),
        selectinload(models.QARequest.linked_performance_requests),
    ).all()
    out = []
    for r in rows:
        functional = next(iter(r.linked_functional_requests), None)
        sast = next(iter(r.linked_sast_requests), None)
        dast = next(iter(r.linked_dast_requests), None)
        performance = next(iter(r.linked_performance_requests), None)
        # Priority/Risk are per-request-type now (see models.FunctionalRequest
        # for the full reasoning), not a single shared gateway value -- so
        # this report lists "Type: Priority/Risk" for every type actually
        # linked to this QA Request instead of one flat column.
        classification = "; ".join(
            f"{label}: {req.priority or '—'}/{(getattr(req, 'risk_rating', None) or getattr(req, 'risk_category', None)) or '—'}"
            for label, req in (
                ("Functional", functional), ("SAST", sast), ("DAST", dast),
                ("Performance", performance),
            ) if req is not None
        )
        out.append({
            "Request ID": r.request_id, "Request Date": r.request_date, "Department": r.department,
            "Application Name": r.application_name,
            "CR Number/EPIC Number": r.cr_number or r.epic_number,
            "Previous Completed Request ID": r.bug_fix_source_request_id if r.change_type == "Bug Fix" else None,
            "Request Type(s)": ",".join(
                value for value in (r.request_types or "").split(",") if value in REQUEST_TYPES
            ),
            "Priority / Risk (per type)": classification or None,
            "Status": r.status,
            "QA Testing Request ID": functional.request_id if functional else None,
            "QA Testing Status": functional.status if functional else None,
        })
    return out


@router.get("/functional-request-register")
def functional_request_register(date_from: str | None = None, date_to: str | None = None,
                                db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """One row per Functional Testing child request.

    The QA Request Register deliberately gives a gateway-level view. This
    register is the operational counterpart for the Functional workflow: its
    own business ID, actual workflow status, assignment, and the parent
    change/release context.  It uses the same department scope as the
    Functional Requests screen, so an export cannot expose another
    department's requests.
    """
    q = _workspace_child((db.query(models.FunctionalRequest)
         .join(models.QARequest,
               models.FunctionalRequest.qa_request_id == models.QARequest.id,
               isouter=True)
         .options(joinedload(models.FunctionalRequest.qa_request))), models.FunctionalRequest, current_user)
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        # FunctionalRequest.department is a delegated property, hence the
        # explicit parent join rather than filtering a non-column property.
        q = q.filter(models.QARequest.department.in_(scope))
    rows = _in_period(q, models.FunctionalRequest.created_at, date_from, date_to) \
        .order_by(models.FunctionalRequest.created_at.desc()).all()

    people_ids = {
        user_id
        for item in rows
        for user_id in (
            item.requester_id,
            item.department_head_id,
            item.qa_lead_id,
            item.qa_request.requester_id if item.qa_request else None,
        )
    }
    for item in rows:
        people_ids.update(
            int(value) for value in (item.assigned_tester_ids or "").split(",")
            if value.strip().isdigit()
        )
    names = _user_name_map(db, people_ids)

    return [{
        "Functional Request ID": item.request_id,
        "QA Request ID": item.qa_request.request_id if item.qa_request else None,
        "Application": item.application_name,
        "Department": item.department,
        "Request Type(s)": item.request_types,
        "Change Description": item.change_description,
        "CR Number/EPIC Number": item.cr_number or item.epic_number,
        "Previous Completed Request ID": item.bug_fix_source_request_id if item.change_type == "Bug Fix" else None,
        "Change Type": item.change_type,
        "Environment": item.environment,
        "Target Promotion Environment": item.target_promotion_environment,
        "Target Release Date": item.target_release_date,
        "Priority": item.priority,
        "Risk": item.risk_rating,
        "Status": item.status,
        "Requester": names.get(item.requester_id or (item.qa_request.requester_id if item.qa_request else None)),
        "Department Head": names.get(item.department_head_id),
        "QA Lead": names.get(item.qa_lead_id),
        "Assigned Testers": ", ".join(
            names.get(int(value), f"User #{value}")
            for value in (item.assigned_tester_ids or "").split(",")
            if value.strip().isdigit()
        ),
        "Created At": item.created_at,
        "Last Updated": item.updated_at,
    } for item in rows]


@router.get("/test-cycle-summary")
def test_cycle_summary(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """One compact row per visible cycle; avoids exporting every execution attempt."""
    q = (db.query(
            models.TestCycle.cycle_key, models.TestCycle.name, models.TestCycle.status,
            models.TestCycle.start_date, models.TestCycle.end_date,
            models.TestProject.project_key, models.TestProject.name.label("project_name"),
            func.count(models.TestExecution.id).label("total"),
            func.sum(case((models.TestExecution.assigned_to_id.isnot(None), 1), else_=0)).label("assigned"),
            func.sum(case((models.TestExecution.status == "Not Executed", 1), else_=0)).label("not_executed"),
            func.sum(case((models.TestExecution.status == "Pass", 1), else_=0)).label("passed"),
            func.sum(case((models.TestExecution.status == "Fail", 1), else_=0)).label("failed"),
            func.sum(case((models.TestExecution.status == "Blocked", 1), else_=0)).label("blocked"),
            func.sum(case((models.TestExecution.status == "NA", 1), else_=0)).label("na_count"),
            func.sum(case((models.TestExecution.status == "Retest Passed", 1), else_=0)).label("retest_passed"),
        ).join(models.TestProject, models.TestCycle.project_id == models.TestProject.id)
         .outerjoin(models.TestExecution, models.TestExecution.cycle_id == models.TestCycle.id))
    project_ids = viewable_project_ids(db, current_user)
    if project_ids is not None:
        q = q.filter(models.TestProject.id.in_(project_ids))
    q = _in_period(q, models.TestCycle.created_at, date_from, date_to)
    rows = q.group_by(
        models.TestCycle.cycle_key, models.TestCycle.name, models.TestCycle.status,
        models.TestCycle.start_date, models.TestCycle.end_date,
        models.TestProject.project_key, models.TestProject.name,
    ).order_by(models.TestCycle.start_date.desc(), models.TestCycle.cycle_key).all()
    out = []
    for row in rows:
        total = int(row.total or 0)
        not_executed = int(row.not_executed or 0)
        assigned = int(row.assigned or 0)
        out.append({
            "Project": f"{row.project_key} — {row.project_name}",
            "Cycle ID": row.cycle_key, "Cycle Name": row.name, "Status": row.status,
            "Start Date": row.start_date, "End Date": row.end_date,
            "Total Testcases": total, "Assigned": assigned, "Unassigned": total - assigned,
            "Not Executed": not_executed,
            "Completion %": round((total - not_executed) / total * 100) if total else 0,
            "Pass": int(row.passed or 0), "Fail": int(row.failed or 0),
            "Blocked": int(row.blocked or 0), "NA": int(row.na_count or 0),
            "Retest Passed": int(row.retest_passed or 0),
        })
    return out


@router.get("/defect-retest-register")
def defect_retest_register(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = (_visible_defects(db, current_user, date_from, date_to).options(
        joinedload(models.Defect.qa_request), joinedload(models.Defect.reporter),
        joinedload(models.Defect.assignee), joinedload(models.Defect.retest_tester),
        joinedload(models.Defect.primary_test_case),
        joinedload(models.Defect.cycle).joinedload(models.TestCycle.project),
    ).order_by(models.Defect.reported_at.desc()).all())
    return [{
        "Defect ID": item.defect_key, "Title": item.title,
        "QA Request": item.qa_request_key,
        "Project": (f"{item.cycle.project.project_key} — {item.cycle.project.name}"
                    if item.cycle and item.cycle.project else None),
        "Cycle": item.cycle_key, "Test Case": item.test_case_key,
        "Application": item.application_name, "Module / Feature": item.module_feature,
        "Environment": item.environment, "Severity": item.severity,
        "Priority": item.priority, "Status": item.status,
        "Reporter": item.reporter_name, "Assignee": item.assignee_name,
        "Reported At": item.reported_at, "Resolution Type": item.resolution_type,
        "Resolved At": item.resolved_at,
        "Retest Tester": item.retest_tester.full_name if item.retest_tester else None,
        "Retest Result": item.retest_result, "Retest At": item.retest_at,
        "Reopen Count": item.reopen_count,
    } for item in rows]


@router.get("/testcase-approval-summary")
def testcase_approval_summary(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # The report measures test cases created in the period; an older project
    # must still appear when it contains matching new/reviewed test cases.
    projects = _visible_test_projects(db, current_user).order_by(models.TestProject.name).all()
    project_ids = [project.id for project in projects]
    grouped_query = db.query(models.TestCase.project_id, models.TestCase.status, func.count(models.TestCase.id)).filter(
        models.TestCase.project_id.in_(project_ids),
        models.TestCase.is_deleted == False,  # noqa: E712 - Oracle requires = 0, not IS 0
    )
    grouped_query = _in_period(grouped_query, models.TestCase.created_at, date_from, date_to)
    grouped = grouped_query.group_by(models.TestCase.project_id, models.TestCase.status).all() if project_ids else []
    counts: dict[int, dict[str, int]] = {}
    for project_id, status, count in grouped:
        counts.setdefault(int(project_id), {})[status or "Unknown"] = int(count)
    return [{
        "Project ID": project.project_key, "Project Name": project.name,
        "Department": project.department,
        "Project Status": "Archived" if project.is_archived else "Active" if project.is_active else "Inactive",
        "Total Testcases": sum(counts.get(project.id, {}).values()),
        "Draft": counts.get(project.id, {}).get("Draft", 0),
        "Recommendation Pending": sum(counts.get(project.id, {}).get(status, 0)
                                      for status in ("In Review", "Recommendation Pending")),
        "QA Lead Approval Pending": sum(counts.get(project.id, {}).get(status, 0)
                                        for status in ("Review Completed", "QA Lead Approval Pending")),
        "Approved": counts.get(project.id, {}).get("Approved", 0),
        "Returned": sum(counts.get(project.id, {}).get(status, 0)
                        for status in ("Returned", "Returned by QA", "Returned by QA Lead")),
        "Rejected": counts.get(project.id, {}).get("Rejected", 0),
        "Archived": counts.get(project.id, {}).get("Archived", 0),
    } for project in projects if not (date_from or date_to) or counts.get(project.id)]


@router.get("/testcase-register")
def testcase_register(date_from: str | None = None, date_to: str | None = None,
                      db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """One row per current testcase identity; created date includes imports."""
    project_ids = viewable_project_ids(db, current_user)
    q = db.query(models.TestCase).join(models.TestProject, models.TestCase.project_id == models.TestProject.id)
    if project_ids is not None:
        q = q.filter(_batched_ids(models.TestCase.project_id, project_ids))
    q = q.filter(models.TestCase.is_deleted == False)  # noqa: E712 - Oracle Boolean comparison
    q = _in_period(q, models.TestCase.created_at, date_from, date_to)
    rows = q.options(joinedload(models.TestCase.project), joinedload(models.TestCase.created_by)).order_by(
        models.TestCase.created_at.desc(), models.TestCase.id.desc()).all()
    return [{
        "Test Case ID": item.test_case_key,
        "Project ID": item.project.project_key,
        "Project Name": item.project.name,
        "Department": item.project.department,
        "EPIC": item.epic_id, "CR Number": item.cr_number,
        "Feature": item.feature_id, "User Story": item.user_story_id,
        "Scenario": item.test_scenario, "Module": item.module_name,
        "Type": item.test_type, "Priority": item.priority,
        "Status": item.status, "Version": item.version,
        "Created By": item.created_by_name or "Unknown creator",
        "Created / Imported At": item.created_at,
    } for item in rows]


@router.get("/execution-attempt-register")
def execution_attempt_register(date_from: str | None = None, date_to: str | None = None,
                               db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every immutable attempt, including failed results superseded by retest."""
    q = (db.query(models.TestExecutionRun)
         .join(models.TestExecution, models.TestExecutionRun.execution_id == models.TestExecution.id)
         .join(models.TestCycle, models.TestExecution.cycle_id == models.TestCycle.id)
         .join(models.TestProject, models.TestCycle.project_id == models.TestProject.id))
    project_ids = viewable_project_ids(db, current_user)
    if project_ids is not None:
        q = q.filter(_batched_ids(models.TestProject.id, project_ids))
    q = _in_period(q, models.TestExecutionRun.executed_at, date_from, date_to)
    rows = q.options(
        joinedload(models.TestExecutionRun.execution).joinedload(models.TestExecution.cycle).joinedload(models.TestCycle.project),
        joinedload(models.TestExecutionRun.execution).joinedload(models.TestExecution.test_case),
        joinedload(models.TestExecutionRun.execution).joinedload(models.TestExecution.pinned_version),
        joinedload(models.TestExecutionRun.executed_by),
        selectinload(models.TestExecutionRun.defects),
    ).order_by(models.TestExecutionRun.executed_at.desc(), models.TestExecutionRun.id.desc()).all()
    return [{
        "Project ID": item.execution.cycle.project.project_key,
        "Department": item.execution.cycle.project.department,
        "Cycle ID": item.execution.cycle.cycle_key,
        "Test Case ID": item.execution.test_case.test_case_key if item.execution.test_case else None,
        "Pinned Version": item.execution.pinned_version.version if item.execution.pinned_version else None,
        "Attempt": item.attempt_no, "Result": item.status,
        "Executed By": item.executed_by_name or "Unknown runner",
        "Executed At": item.executed_at,
        "Actual Result": item.actual_result,
        "Defects": ", ".join(sorted({link.defect_key for link in item.defects} | ({item.defect_id} if item.defect_id else set()))),
    } for item in rows]


def _latest_scan_by_request(db: Session, kind: str, request_ids) -> dict:
    """Reported directly: "in dashboard sast dast findings showing 0
    result." Every "Findings" figure below used to read
    len(r.findings)/f.severity off models.SASTFinding/DASTFinding -- the
    old manually-logged findings tables, retired when the "Findings
    Validation" doc moved findings to Fortify SSC-backed imports (see
    models.SecurityScanResult). Nothing has written a SASTFinding/
    DASTFinding row since, so every report built on them read as zero/empty.
    Same fix, same helper (by name and behavior) as routers/dashboard.py's
    own copy -- kept local rather than shared across router files, matching
    this codebase's existing per-file-locality convention.

    Returns {request_id: latest SecurityScanResult row} for whichever of
    `request_ids` have actually been scanned at least once."""
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
    grouped = defaultdict(list)
    for row in rows:
        grouped[row.request_id].append(row)
    count_fields = ("critical_count", "high_count", "medium_count", "low_count", "total_count",
                    "suppressed_critical_count", "suppressed_high_count", "suppressed_medium_count",
                    "suppressed_low_count", "suppressed_total_count")
    for request_id, request_rows in grouped.items():
        representative = request_rows[-1]
        from ..security_scan_state import current_scan_results
        batch = current_scan_results(list(reversed(request_rows)))
        values = {column.name: getattr(representative, column.name) for column in models.SecurityScanResult.__table__.columns}
        values.update({field: sum(int(getattr(row, field) or 0) for row in batch) for field in count_fields})
        values["filters"] = representative.filters
        values["targets"] = [target for row in batch for target in row.targets]
        latest[request_id] = SimpleNamespace(**values)
    return latest


# ---------------- 4.10.2 Security Reports ----------------
@router.get("/sast-scan")
def sast_scan_report(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # department is a delegated property (models.SASTRequest.department reads
    # through .qa_request), not a real column, so scoping needs a join same
    # as list_sast in routers/sast_dast.py -- standalone SAST requests (no
    # qa_request_id) are excluded by this inner join for a scoped user, same
    # as they already resolve to department=None today.
    q = _workspace_child(db.query(models.SASTRequest), models.SASTRequest, current_user)
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = q.join(models.QARequest, models.SASTRequest.qa_request_id == models.QARequest.id) \
             .filter(models.QARequest.department.in_(scope))
    rows = _in_period(q, models.SASTRequest.created_at, date_from, date_to).all()
    latest_scans = _latest_scan_by_request(db, "SAST", [r.id for r in rows])
    return [{
        "Request ID": r.request_id, "Application": r.application_name, "Build": r.build_number,
        "Status": r.status,
        # Latest imported Fortify SSC scan's open finding count -- 0 for a
        # request that's never been scanned yet, same as an empty findings
        # list used to render.
        "Findings": latest_scans[r.id].total_count if r.id in latest_scans else 0,
    } for r in rows]


@router.get("/dast-scan")
def dast_scan_report(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # See sast_scan_report's matching comment just above -- identical reasoning.
    q = _workspace_child(db.query(models.DASTRequest), models.DASTRequest, current_user)
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = q.join(models.QARequest, models.DASTRequest.qa_request_id == models.QARequest.id) \
             .filter(models.QARequest.department.in_(scope))
    rows = _in_period(q, models.DASTRequest.created_at, date_from, date_to).all()
    latest_scans = _latest_scan_by_request(db, "DAST", [r.id for r in rows])
    return [{
        "Request ID": r.request_id, "Application URL": r.application_url, "Environment": r.environment,
        "Status": r.status,
        "Findings": latest_scans[r.id].total_count if r.id in latest_scans else 0,
    } for r in rows]


def _security_observation_history(kind: str, date_from: str | None, date_to: str | None,
                                  db: Session, current_user: models.User):
    """Flatten every immutable Fortify scan and filter view for export.

    SSC filter sets are overlapping observations, so each becomes its own
    row instead of being summed. Suppression counts are available only for
    the primary Security Auditor View and are emitted only on that row; this
    keeps spreadsheet totals accurate when users aggregate the export.
    """
    request_model = models.SASTRequest if kind == "SAST" else models.DASTRequest
    request_query = _workspace_child(db.query(request_model), request_model, current_user)
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        request_query = (
            request_query
            .join(models.QARequest, request_model.qa_request_id == models.QARequest.id)
            .filter(models.QARequest.department.in_(scope))
        )
    requests = request_query.all()
    by_id = {request.id: request for request in requests}
    if not by_id:
        return []

    scans = (
        db.query(models.SecurityScanResult)
        .filter(
            models.SecurityScanResult.request_type == kind,
            models.SecurityScanResult.request_id.in_(by_id),
        )
        .order_by(
            models.SecurityScanResult.request_id,
            models.SecurityScanResult.imported_at.asc(),
            models.SecurityScanResult.id.asc(),
        )
        .all()
    )
    imported_by = _user_name_map(db, [scan.imported_by_id for scan in scans])
    start, end = _period_bounds(date_from, date_to)
    scan_numbers: dict[int, int] = {}
    batch_numbers: dict[tuple[int, str], int] = {}
    out = []
    for scan in scans:
        batch_key = scan.execution_key or f"legacy-{scan.id}"
        lookup = (scan.request_id, batch_key)
        if lookup not in batch_numbers:
            scan_numbers[scan.request_id] = scan_numbers.get(scan.request_id, 0) + 1
            batch_numbers[lookup] = scan_numbers[scan.request_id]
        if start and scan.imported_at < start:
            continue
        if end and scan.imported_at > end:
            continue

        request = by_id[scan.request_id]
        scan_no = batch_numbers[lookup]
        scan_targets = scan.targets or []
        target_labels = [str(target.get("label") or "").strip() for target in scan_targets if target.get("label")]
        filters = scan.filters or [{
            "title": "Security Auditor View",
            "critical_count": scan.critical_count,
            "high_count": scan.high_count,
            "medium_count": scan.medium_count,
            "low_count": scan.low_count,
            "total_count": scan.total_count,
            "audit_url": scan.audit_url,
        }]
        primary_index = next((
            index for index, observation in enumerate(filters)
            if "security auditor view" in str(observation.get("title") or "").strip().casefold()
        ), 0)
        for index, observation in enumerate(filters):
            is_primary = index == primary_index
            row = {
                "Scan Type": kind,
                "Request ID": request.request_id,
                "Application": scan.application_name,
                "Application Version": scan.application_version,
                "Selected Scan Targets": "\n".join(target_labels) or "Not captured (legacy scan)",
                "Selected Target Count": len(target_labels) if scan_targets else None,
                "Department": request.department,
                "Workflow Status": request.status,
                "Scan No": scan_no,
                "Scan Execution": "Initial Scan" if scan_no == 1 else "Rescan",
                "Observation View": observation.get("title") or "Unnamed Filter",
                "Active Critical": int(observation.get("critical_count") or 0),
                "Active High": int(observation.get("high_count") or 0),
                "Active Medium": int(observation.get("medium_count") or 0),
                "Active Low": int(observation.get("low_count") or 0),
                "Active Total": int(observation.get("total_count") or 0),
                # Blank outside the primary view prevents the same suppressed
                # findings being multiplied by the number of overlapping SSC
                # filter rows in pivots or spreadsheet totals.
                "Suppressed Critical (Security Auditor View)": int(scan.suppressed_critical_count or 0) if is_primary else None,
                "Suppressed High (Security Auditor View)": int(scan.suppressed_high_count or 0) if is_primary else None,
                "Suppressed Medium (Security Auditor View)": int(scan.suppressed_medium_count or 0) if is_primary else None,
                "Suppressed Low (Security Auditor View)": int(scan.suppressed_low_count or 0) if is_primary else None,
                "Suppressed Total (Security Auditor View)": int(scan.suppressed_total_count or 0) if is_primary else None,
                "Provider Version ID": scan.provider_version_id,
                "Imported By": imported_by.get(scan.imported_by_id),
                "Imported At": scan.imported_at,
                "Fortify Audit URL": observation.get("audit_url") or scan.audit_url,
            }
            if kind == "SAST":
                row.update({
                    "Repository URLs": "\n".join(target_labels) or "Not captured (legacy scan)",
                    "Build": request.build_number,
                    "CR Number/EPIC Number": request.cr_number or request.epic_number,
                })
            else:
                row.update({
                    "Application URLs": "\n".join(target_labels) or "Not captured (legacy scan)",
                    "Target Environments": "\n".join(str(target.get("detail") or "—") for target in scan_targets) if scan_targets else "Not captured (legacy scan)",
                    "CR Number/EPIC Number": request.cr_number or request.epic_number,
                })
            out.append(row)
    return out


@router.get("/sast-observation-history")
def sast_observation_history(date_from: str | None = None, date_to: str | None = None,
                             db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _security_observation_history("SAST", date_from, date_to, db, current_user)


@router.get("/dast-observation-history")
def dast_observation_history(date_from: str | None = None, date_to: str | None = None,
                             db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _security_observation_history("DAST", date_from, date_to, db, current_user)


@router.get("/performance-testing")
def performance_testing_report(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    q = _workspace_child(db.query(models.PerformanceRequest).options(joinedload(models.PerformanceRequest.qa_request)), models.PerformanceRequest, current_user)
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = (q.join(models.QARequest, models.PerformanceRequest.qa_request_id == models.QARequest.id)
             .filter(models.QARequest.department.in_(scope)))
    rows = _in_period(q, models.PerformanceRequest.created_at, date_from, date_to).order_by(models.PerformanceRequest.created_at.desc()).all()
    tester_ids = set()
    for item in rows:
        tester_ids.add(item.engineer_id)
        tester_ids.update(int(value) for value in (item.assigned_tester_ids or "").split(",") if value.strip().isdigit())
    names = _user_name_map(db, tester_ids)
    return [{
        "Request ID": item.request_id, "Application": item.application_name,
        "CR Number/EPIC Number": item.cr_number or item.epic_number,
        "Previous Completed Request ID": item.bug_fix_source_request_id if item.change_type == "Bug Fix" else None,
        "Department": item.department, "Request Type": item.request_type,
        "Environment": item.environment,
        "Target Promotion Environment": item.target_promotion_environment,
        "Target Load": item.target_load, "Tool": item.tool_used,
        "Priority": item.priority, "Risk": item.risk_category,
        "Status": item.status, "QA Lead": names.get(item.engineer_id),
        "Assigned Testers": ", ".join(names.get(int(value), f"User #{value}")
                                      for value in (item.assigned_tester_ids or "").split(",")
                                      if value.strip().isdigit()),
        "Report Available": "Yes" if item.report_path else "No",
        "Created At": item.created_at, "Last Updated": item.updated_at,
    } for item in rows]


def _security_severity_counts(db: Session, current_user: models.User, date_from: str | None = None, date_to: str | None = None):
    # Reported directly: "in dashboard sast dast findings showing 0
    # result." Used to read models.SASTFinding/DASTFinding -- see
    # _latest_scan_by_request's own comment for why that's always empty
    # now. Each in-scope SAST/DAST request's latest Fortify SSC scan
    # (if it's been scanned at least once) supplies its own severity
    # breakdown instead; SecurityScanResult itself has no department of
    # its own, so scoping is done via the SAST/DAST request id lists
    # (same join pattern as sast_scan_report/dast_scan_report above), not
    # a join on SecurityScanResult directly.
    scope = dashboard_department_scope(current_user)
    sast_q = db.query(models.SASTRequest.id)
    dast_q = db.query(models.DASTRequest.id)
    sast_q = _workspace_child(sast_q, models.SASTRequest, current_user)
    dast_q = _workspace_child(dast_q, models.DASTRequest, current_user)
    if scope is not None:
        sast_q = sast_q.join(models.QARequest, models.SASTRequest.qa_request_id == models.QARequest.id) \
                        .filter(models.QARequest.department.in_(scope))
        dast_q = dast_q.join(models.QARequest, models.DASTRequest.qa_request_id == models.QARequest.id) \
                        .filter(models.QARequest.department.in_(scope))
    sast_scans = _latest_scan_by_request(db, "SAST", [row[0] for row in _in_period(sast_q, models.SASTRequest.created_at, date_from, date_to).all()])
    dast_scans = _latest_scan_by_request(db, "DAST", [row[0] for row in _in_period(dast_q, models.DASTRequest.created_at, date_from, date_to).all()])
    from collections import Counter
    counts = Counter()
    for scan in list(sast_scans.values()) + list(dast_scans.values()):
        counts["Critical"] += scan.critical_count
        counts["High"] += scan.high_count
        counts["Medium"] += scan.medium_count
        counts["Low"] += scan.low_count
    return dict(counts)


@router.get("/severity-distribution")
def severity_distribution(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    counts = _security_severity_counts(db=db, current_user=current_user, date_from=date_from, date_to=date_to)
    return [{"Severity": severity, "Finding Count": count} for severity, count in sorted(counts.items())]


@router.get("/suppression-register")
def suppression_register(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # One suppression request can now cover several findings (see
    # models.SuppressionItem) -- the register lists one row per finding,
    # same pattern as test-case-execution/defect-summary used to.
    # SuppressionRequest.department is a real column, so a direct .filter()
    # is enough, same as list_suppressions in routers/suppression.py.
    q = db.query(models.SuppressionRequest).options(selectinload(models.SuppressionRequest.items))
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = q.filter(models.SuppressionRequest.department.in_(scope))
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if workspace_ids:
        q = q.filter(models.SuppressionRequest.qa_workspace_id.in_(workspace_ids))
    rows = _in_period(q, models.SuppressionRequest.created_at, date_from, date_to).all()
    out = []
    for s in rows:
        items = s.items or [None]
        for item in items:
            out.append({
                "Suppression ID": s.suppression_id, "Application": s.application_name, "Scan Type": s.scan_type,
                "Department": s.department, "Application Owner": s.application_owner,
                "Issue Group": item.issue_id if item else None, "Severity": item.severity if item else None,
                "Status": s.status,
                "SM Decision": s.sm_decision, "Dept Head Decision": s.dept_head_decision,
                "Security Team Decision": s.security_decision,
            })
    return out


# ---------------- 4.10.3 Management Reports ----------------
@router.get("/application-quality-scorecard")
def quality_scorecard(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Cross-module position by application, restricted through visible gateway IDs."""
    from collections import Counter

    visible = _visible_qa_requests(db, current_user, date_from, date_to).all()
    request_ids = [item.id for item in visible]
    if not request_ids:
        return []
    app_by_request = {item.id: item.application_name for item in visible}
    qa_counts = Counter(item.application_name for item in visible if item.application_name)

    functional_rows = db.query(
        models.FunctionalRequest.qa_request_id, models.FunctionalRequest.request_id,
        models.FunctionalRequest.status,
    ).filter(models.FunctionalRequest.qa_request_id.in_(request_ids)).all()
    sast_rows = db.query(models.SASTRequest.qa_request_id).filter(models.SASTRequest.qa_request_id.in_(request_ids)).all()
    dast_rows = db.query(models.DASTRequest.qa_request_id).filter(models.DASTRequest.qa_request_id.in_(request_ids)).all()
    performance_rows = db.query(models.PerformanceRequest.qa_request_id).filter(
        models.PerformanceRequest.qa_request_id.in_(request_ids)).all()
    open_defect_rows = db.query(models.Defect.qa_request_id).filter(
        models.Defect.qa_request_id.in_(request_ids),
        models.Defect.status.notin_(("Closed", "Rejected", "Duplicate", "Not a Defect")),
    ).all()

    functional_counts = Counter(app_by_request.get(row.qa_request_id) for row in functional_rows)
    closed_counts = Counter(app_by_request.get(row.qa_request_id) for row in functional_rows if row.status == QAStatus.CLOSED)
    sast_counts = Counter(app_by_request.get(row.qa_request_id) for row in sast_rows)
    dast_counts = Counter(app_by_request.get(row.qa_request_id) for row in dast_rows)
    performance_counts = Counter(app_by_request.get(row.qa_request_id) for row in performance_rows)
    open_defect_counts = Counter(app_by_request.get(row.qa_request_id) for row in open_defect_rows)

    functional_request_app = {
        row.request_id: app_by_request.get(row.qa_request_id) for row in functional_rows if row.request_id
    }
    issued_counts = Counter()
    if functional_request_app:
        issued_rows = db.query(models.QASignOff.testing_request_id).filter(
            models.QASignOff.testing_request_id.in_(list(functional_request_app)),
            models.QASignOff.status == "ISSUED",
        ).all()
        issued_counts.update(functional_request_app.get(row.testing_request_id) for row in issued_rows)

    return [{
        "Application": app,
        "QA Requests": qa_counts[app],
        "Functional Requests": functional_counts[app],
        "Functional Closed": closed_counts[app],
        "SAST Requests": sast_counts[app],
        "DAST Requests": dast_counts[app],
        "Performance Requests": performance_counts[app],
        "Open Defects": open_defect_counts[app],
        "Issued Clearances": issued_counts[app],
    } for app in sorted(qa_counts)]


def _visible_signoffs(db: Session, current_user: models.User,
                      date_from: str | None = None, date_to: str | None = None):
    q = db.query(models.QASignOff).options(joinedload(models.QASignOff.source_functional_request))
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        q = (q.join(models.FunctionalRequest,
                    models.FunctionalRequest.request_id == models.QASignOff.testing_request_id)
             .join(models.QARequest, models.QARequest.id == models.FunctionalRequest.qa_request_id)
             .filter(models.QARequest.department.in_(scope)))
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if workspace_ids:
        q = q.filter(models.QASignOff.qa_workspace_id.in_(workspace_ids))
    return _in_period(q, models.QASignOff.created_at, date_from, date_to)


@router.get("/qa-signoff-register")
def qa_signoff_register(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = _visible_signoffs(db, current_user, date_from, date_to).order_by(models.QASignOff.created_at.desc()).all()
    names = _user_name_map(db, [
        user_id for item in rows
        for user_id in (item.requester_id, item.reviewed_by_id, item.approved_by_id)
    ])
    return [{
        "Certificate ID": item.certificate_id,
        "Certificate Date": item.certificate_date,
        "Testing Request ID": item.certificate_testing_request_id,
        "Application": item.application_name,
        "Request Department": item.request_department,
        "CR Number/EPIC Number": item.change_request_ids,
        "Certificate Type": item.certificate_type,
        "Testing Type": item.certificate_testing_type,
        "Environment Tested": item.environment_tested,
        "Target Promotion Environment": item.target_promotion_environment,
        "Risk Tier": item.risk_tier,
        "Status": qa_clearance_export_status(item.status),
        "Workflow Status": item.status,
        "Clearance Signature Type": QA_CLEARANCE_SIGNED_TYPE if item.status == "ISSUED" else "",
        "Signature Method": DIGITAL_SIGNATURE_METHOD if item.status == "ISSUED" else "",
        "Requested By": names.get(item.requester_id),
        "QA Lead Approver": names.get(item.reviewed_by_id),
        "Executive Approver": names.get(item.approved_by_id),
        "Validity From": item.validity_from, "Validity To": item.validity_to,
        "Created At": item.created_at, "Last Updated": item.updated_at,
    } for item in rows]


@router.get("/qa-clearance-evidence")
def qa_clearance_evidence(date_from: str | None = None, date_to: str | None = None,
                          db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Frozen certificate figures, not recalculated live lifecycle counts."""
    rows = _visible_signoffs(db, current_user, date_from, date_to).order_by(models.QASignOff.created_at.desc()).all()
    result = []
    for item in rows:
        snapshot = item.certificate_summary or {}
        execution = snapshot.get("execution") or {}
        defects = snapshot.get("defects") or {}
        execution_counts = execution.get("counts") or {}
        defect_counts = defects.get("counts") or {}
        severity = snapshot.get("severity") or []
        result.append({
            "Certificate ID": item.certificate_id,
            "Testing Request ID": item.certificate_testing_request_id,
            "Application": item.application_name,
            "Department": item.request_department,
            "Certificate Type": item.certificate_type,
            "Status": qa_clearance_export_status(item.status),
            "Evidence Revision": snapshot.get("revision"),
            "Evidence Captured At": snapshot.get("captured_at"),
            "Assigned Testers": ", ".join(tester.get("name", "") for tester in snapshot.get("assigned_testers", []) if tester.get("name")) if "assigned_testers" in snapshot else "Not captured in this revision",
            "Test Cases": execution.get("total"),
            "Pass": execution_counts.get("Pass"), "Fail": execution_counts.get("Fail"),
            "Blocked": execution_counts.get("Blocked"), "NA": execution_counts.get("NA"),
            "Retest Passed": execution_counts.get("Retest Passed"),
            "Not Executed": execution_counts.get("Not Executed"),
            "Pass %": execution.get("pass_pct"),
            "Defects": defects.get("total"),
            "Open Defects": sum(int(severity_row.get("open") or 0) for severity_row in severity),
            "Open Critical / High": snapshot.get("open_critical_high"),
            "Deferred": defect_counts.get("Deferred"),
            "Closed": defect_counts.get("Closed"),
        })
    return result




@router.get("/audit-evidence")
def audit_evidence(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Same cross-entity feed as list_approvals (routers/approvals.py) -- uses
    # the same shared resolve_entity_department helper (deps.py) so this
    # export can't surface another department's approval/audit history
    # either (reported directly: "Report & Export Centre ... other
    # department data can not be shown").
    rows = _in_period(db.query(models.ApprovalAction), models.ApprovalAction.created_at, date_from, date_to).order_by(models.ApprovalAction.created_at.desc()).limit(1000).all()
    scope = dashboard_department_scope(current_user)
    if scope is not None:
        rows = [r for r in rows if resolve_entity_department(db, r.entity_type, r.entity_id) in scope]
    workspace_ids = active_qa_workspace_scope_ids(current_user)
    if workspace_ids:
        rows = [r for r in rows if resolve_entity_workspace_id(db, r.entity_type, r.entity_id) in workspace_ids]
    names = _user_name_map(db, [row.actor_id for row in rows])
    out = []
    for a in rows:
        signature = parse_electronic_signature(a.comments, stage=a.step_name or "Approval")
        signature_type = (
            QA_CLEARANCE_SIGNED_TYPE if signature and a.entity_type == "SIGNOFF"
            else "Digitally Signed Approval" if signature
            else ""
        )
        out.append({
            "Entity Type": a.entity_type, "Entity ID": a.entity_id, "Step": a.step_name,
            "Decision": a.decision, "Actor": names.get(a.actor_id), "Role": a.actor_role,
            "Signature Type": signature_type,
            "Signature ID": signature.signature_id if signature else "",
            "Signature Method": DIGITAL_SIGNATURE_METHOD if signature else "",
            "Comments": a.comments, "Timestamp": a.created_at,
        })
    return out


_ALL_DATA_MODULES = (
    "QA Request", "Functional Request", "SAST Request", "DAST Request",
    "Performance Request", "Suppression Request", "Test Project", "Test Cycle", "Testcase",
    "Test Execution", "Execution Attempt", "Defect", "Defect Severity", "QA Clearance",
)


def _batched_ids(column, values):
    """Oracle limits one IN expression to 1,000 values."""
    ids = sorted(set(values))
    if not ids:
        return false()
    return or_(*(column.in_(ids[start:start + 900]) for start in range(0, len(ids), 900)))


def _within_period(value, start, end):
    return value is not None and (start is None or value >= start) and (end is None or value <= end)


def all_data_report(date_from: str | None = None, date_to: str | None = None,
                    db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Workspace-wise operational counts, status breakdowns and record details.

    The parent request is one change; child Functional/SAST/DAST/Performance
    workflows are separate rows, never counted as additional QA Requests.
    Project content is attributed to its creating workspace, including when
    another workspace has been granted read access to the shared project.
    """
    start, end = _period_bounds(date_from, date_to)
    workspace_names = {row.id: row.name for row in db.query(models.QAWorkspace).all()}
    organisation_view = current_user.has_role(Role.SCALE_6_PLUS) or current_user.has_role(Role.ADMIN)
    scope_ids = set(selectable_workspace_ids(db, current_user))
    if organisation_view:
        scope_ids = {row.id for row in db.query(models.QAWorkspace).filter(
            models.QAWorkspace.is_active == True,  # noqa: E712
        ).all()}
    selected_id = getattr(current_user, "active_qa_workspace_id", None)

    with workspace_context(selected_id, scope_ids):
        return _all_data_report_rows(db, current_user, start, end, scope_ids, workspace_names, organisation_view)


def _all_data_report_rows(db, current_user, start, end, scope_ids, workspace_names, organisation_view):

    def workspace_name(workspace_id):
        return workspace_names.get(workspace_id, f"Workspace #{workspace_id}") if workspace_id else "Unassigned / Legacy"

    details = []
    counts = defaultdict(Counter)

    def add(workspace_id, module, record_id, status_value, *, parent="", description="",
            context="", department="", testcases="", metrics="", defects="",
            severity="", created=None):
        if not _within_period(created, start, end):
            return
        status_label = status_value or "Unknown"
        name = workspace_name(workspace_id)
        counts[(name, module)][status_label] += 1
        if module == "Defect":
            counts[(name, "Defect Severity")][severity or "Unknown"] += 1
        details.append({
            "Workspace": name, "Row Type": "Record", "Module": module,
            "Record ID": record_id or "", "Parent / Linked ID": parent or "",
            "Description": description or "", "Application / Project": context or "",
            "Department": department or "", "Status": status_label, "Count": "",
            "Testcases": testcases, "Execution Results": metrics or "",
            "Defects": defects, "Created At": created,
        })

    # Existing gateway visibility protects private Draft/Cancelled requests.
    # Child workflows are checked against those same visible parents.
    if organisation_view:
        parent_query = db.query(models.QARequest).filter(or_(
            _batched_ids(models.QARequest.qa_workspace_id, scope_ids),
            models.QARequest.qa_workspace_id.is_(None),
        ))
        if not current_user.has_role(Role.ADMIN):
            parent_query = parent_query.filter(or_(
                models.QARequest.status.notin_(_GATEWAY_PRIVATE_STATUSES),
                models.QARequest.requester_id == current_user.id,
            ))
        parents = parent_query.all()
    else:
        parents = _visible_qa_requests(db, current_user).all()
    parent_by_id = {row.id: row for row in parents}
    parent_ids = set(parent_by_id)
    for row in parents:
        add(row.qa_workspace_id, "QA Request", row.request_id or f"Draft #{row.id}", row.status,
            description=row.change_description, context=row.application_name,
            department=row.department, created=row.created_at)

    child_types = (
        ("Functional Request", models.FunctionalRequest),
        ("SAST Request", models.SASTRequest),
        ("DAST Request", models.DASTRequest),
        ("Performance Request", models.PerformanceRequest),
    )
    for module, model in child_types:
        predicate = _batched_ids(model.qa_request_id, parent_ids)
        # Standalone security requests predate workspace attribution. Only
        # organisation-wide viewers may see them in the legacy bucket.
        if organisation_view and model is not models.FunctionalRequest:
            predicate = or_(predicate, model.qa_request_id.is_(None))
        rows = db.query(model).filter(predicate).all()
        for row in rows:
            parent = parent_by_id.get(row.qa_request_id)
            if row.qa_request_id and parent is None:
                continue
            add(parent.qa_workspace_id if parent else None, module, row.request_id, row.status,
                parent=parent.request_id if parent else "",
                description=parent.change_description if parent else "",
                context=parent.application_name if parent else getattr(row, "application_name", ""),
                department=parent.department if parent else "",
                created=row.created_at)

    workspace_predicate = _batched_ids(models.SuppressionRequest.qa_workspace_id, scope_ids)
    if organisation_view:
        workspace_predicate = or_(workspace_predicate, models.SuppressionRequest.qa_workspace_id.is_(None))
    suppression_query = db.query(models.SuppressionRequest).filter(workspace_predicate)
    department_scope = dashboard_department_scope(current_user)
    if department_scope is not None:
        suppression_query = suppression_query.filter(models.SuppressionRequest.department.in_(department_scope))
    for row in suppression_query.all():
        add(row.qa_workspace_id, "Suppression Request", row.suppression_id, row.status,
            description=row.scan_type, context=row.application_name,
            department=row.department, created=row.created_at)

    project_query = db.query(models.TestProject)
    if organisation_view:
        project_query = project_query.filter(or_(
            _batched_ids(models.TestProject.qa_workspace_id, scope_ids),
            models.TestProject.qa_workspace_id.is_(None),
        ))
    else:
        visible_project_ids = viewable_project_ids(db, current_user)
        if visible_project_ids is not None:
            project_query = project_query.filter(_batched_ids(models.TestProject.id, visible_project_ids))
    projects = project_query.all()
    projects_by_id = {row.id: row for row in projects}
    project_ids = set(projects_by_id)

    testcases = db.query(models.TestCase).filter(
        _batched_ids(models.TestCase.project_id, project_ids),
        models.TestCase.is_deleted == False,  # noqa: E712
    ).all()
    testcase_by_id = {row.id: row for row in testcases}
    project_case_counts = Counter(row.project_id for row in testcases)
    cycles = db.query(models.TestCycle).filter(_batched_ids(models.TestCycle.project_id, project_ids)).all()
    cycle_by_id = {row.id: row for row in cycles}
    project_cycle_counts = Counter(row.project_id for row in cycles)
    executions = db.query(models.TestExecution).filter(
        _batched_ids(models.TestExecution.cycle_id, cycle_by_id),
    ).all()
    execution_by_id = {row.id: row for row in executions}
    execution_people = _user_name_map(db, (
        person_id for row in executions for person_id in (row.assigned_to_id, row.executed_by_id)
    ))
    cycle_results = defaultdict(Counter)
    cycle_assigned = Counter()
    for row in executions:
        cycle_results[row.cycle_id][row.status or "Unknown"] += 1
        if row.assigned_to_id:
            cycle_assigned[row.cycle_id] += 1
    attempt_counts = Counter()
    execution_ids = [row.id for row in executions]
    runs = []
    for start_index in range(0, len(execution_ids), 900):
        batch = execution_ids[start_index:start_index + 900]
        runs.extend(db.query(models.TestExecutionRun).filter(
            models.TestExecutionRun.execution_id.in_(batch),
        ).all())
    attempt_counts.update(row.execution_id for row in runs)
    cycle_attempts = Counter()
    for row in executions:
        cycle_attempts[row.cycle_id] += attempt_counts[row.id]

    defects = _visible_defects(db, current_user).options(
        joinedload(models.Defect.qa_request),
        joinedload(models.Defect.cycle).joinedload(models.TestCycle.project),
    ).all()
    if organisation_view:
        seen_defect_ids = {row.id for row in defects}
        legacy_defects = db.query(models.Defect).filter(
            models.Defect.qa_workspace_id.is_(None),
            models.Defect.qa_request_id.is_(None),
            models.Defect.cycle_id.is_(None),
        ).all()
        defects.extend(row for row in legacy_defects if row.id not in seen_defect_ids)
    cycle_defects = Counter(row.cycle_id for row in defects if row.cycle_id)
    project_defects = Counter(
        row.cycle.project_id for row in defects if row.cycle and row.cycle.project_id
    )

    for row in projects:
        state = "Archived" if row.is_archived else "Active" if row.is_active else "Inactive"
        add(row.qa_workspace_id, "Test Project", row.project_key, state,
            description=row.name, department=row.department,
            testcases=project_case_counts[row.id],
            metrics=f"Cycles {project_cycle_counts[row.id]}",
            defects=project_defects[row.id], created=row.created_at)
    for row in testcases:
        project = projects_by_id[row.project_id]
        add(row.origin_workspace_id or project.qa_workspace_id, "Testcase",
            row.test_case_key, row.status, parent=project.project_key,
            description=row.test_scenario or row.description, context=project.name,
            department=project.department, created=row.created_at)
    for row in cycles:
        project = projects_by_id[row.project_id]
        results = cycle_results[row.id]
        result_text = f"Assigned {cycle_assigned[row.id]} · Unassigned {sum(results.values()) - cycle_assigned[row.id]} · " + " · ".join(
            f"{status} {results[status]}" for status in (
                "Pass", "Fail", "Blocked", "NA", "Retest Passed", "Not Executed",
            )
        ) + f" · Attempts {cycle_attempts[row.id]}"
        add(row.origin_workspace_id or project.qa_workspace_id, "Test Cycle",
            row.cycle_key, row.status, parent=project.project_key,
            description=row.name, context=project.name, department=project.department,
            testcases=sum(results.values()), metrics=result_text,
            defects=cycle_defects[row.id], created=row.created_at)
    for row in executions:
        cycle = cycle_by_id[row.cycle_id]
        project = projects_by_id[cycle.project_id]
        case = testcase_by_id.get(row.test_case_id)
        people = " · ".join(value for value in (
            f"Assigned {execution_people.get(row.assigned_to_id, f'User #{row.assigned_to_id}')}" if row.assigned_to_id else "Unassigned",
            f"Last runner {execution_people.get(row.executed_by_id, f'User #{row.executed_by_id}')}" if row.executed_by_id else "",
        ) if value)
        add(cycle.origin_workspace_id or project.qa_workspace_id, "Test Execution",
            case.test_case_key if case else f"Execution #{row.id}", row.status,
            parent=cycle.cycle_key, description=case.test_scenario if case else "",
            context=project.name, department=project.department,
            metrics=f"Attempts {attempt_counts[row.id]} · {people}", created=row.created_at)
    for row in runs:
        execution = execution_by_id[row.execution_id]
        cycle = cycle_by_id[execution.cycle_id]
        project = projects_by_id[cycle.project_id]
        case = testcase_by_id.get(execution.test_case_id)
        add(cycle.origin_workspace_id or project.qa_workspace_id, "Execution Attempt",
            f"{case.test_case_key if case else f'Execution #{execution.id}'} / {row.attempt_no}",
            row.status, parent=cycle.cycle_key, description=row.actual_result,
            context=project.name, department=project.department, created=row.executed_at)
    for row in defects:
        workspace_id = row.qa_workspace_id or (
            row.qa_request.qa_workspace_id if row.qa_request else None
        ) or (
            (row.cycle.origin_workspace_id or row.cycle.project.qa_workspace_id)
            if row.cycle and row.cycle.project else None
        )
        add(workspace_id, "Defect", row.defect_key, row.status,
            parent=row.cycle.cycle_key if row.cycle else row.qa_request_key,
            description=row.title, context=row.application_name,
            department=row.department or (row.qa_request.department if row.qa_request else ""),
            metrics=f"Severity {row.severity or 'Unknown'}", severity=row.severity,
            created=row.reported_at)

    clearance_predicate = _batched_ids(models.QASignOff.qa_workspace_id, scope_ids)
    if organisation_view:
        clearance_predicate = or_(clearance_predicate, models.QASignOff.qa_workspace_id.is_(None))
    clearance_query = db.query(models.QASignOff).filter(clearance_predicate)
    if department_scope is not None:
        clearance_query = (clearance_query.join(
            models.FunctionalRequest,
            models.FunctionalRequest.request_id == models.QASignOff.testing_request_id,
        ).join(
            models.QARequest, models.QARequest.id == models.FunctionalRequest.qa_request_id,
        ).filter(models.QARequest.department.in_(department_scope)))
    for row in clearance_query.all():
        add(row.qa_workspace_id, "QA Clearance", row.certificate_id, row.status,
            parent=row.testing_request_id, description=row.certificate_type,
            context=row.application_name, department=row.request_department,
            created=row.created_at)

    summaries = []
    workspace_labels = {workspace_name(workspace_id) for workspace_id in scope_ids}
    workspace_labels.update(name for name, _ in counts)
    for name in sorted(workspace_labels):
        for module in _ALL_DATA_MODULES:
            statuses = counts[(name, module)]
            for status_label, count in [("Total", sum(statuses.values())), *sorted(statuses.items())]:
                summaries.append({
                    "Workspace": name, "Row Type": "Summary", "Module": module,
                    "Record ID": "", "Parent / Linked ID": "", "Description": "",
                    "Application / Project": "", "Department": "", "Status": status_label,
                    "Count": count, "Testcases": "", "Execution Results": "",
                    "Defects": "", "Created At": "",
                })
    details.sort(key=lambda row: (row["Workspace"], row["Module"], str(row["Record ID"])))
    return summaries + details


REPORT_REGISTRY = {
    "all-data-report": all_data_report,
    "qa-request-summary": qa_request_summary,
    "functional-request-register": functional_request_register,
    "test-cycle-summary": test_cycle_summary,
    "testcase-register": testcase_register,
    "execution-attempt-register": execution_attempt_register,
    "defect-retest-register": defect_retest_register,
    "performance-testing": performance_testing_report,
    "sast-scan": sast_scan_report,
    "dast-scan": dast_scan_report,
    "sast-observation-history": sast_observation_history,
    "dast-observation-history": dast_observation_history,
    "severity-distribution": severity_distribution,
    "suppression-register": suppression_register,
    "testcase-approval-summary": testcase_approval_summary,
    "application-quality-scorecard": quality_scorecard,
    "qa-signoff-register": qa_signoff_register,
    "qa-clearance-evidence": qa_clearance_evidence,
    "audit-evidence": audit_evidence,
}
