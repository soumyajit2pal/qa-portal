import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from .. import models
from ..database import get_db
from ..deps import (
    get_current_user, dashboard_department_scope, resolve_entity_department,
    viewable_project_ids,
)
from ..constants import QAStatus, GatewayStatus, REQUEST_TYPES, Role
from ..pdf_export import (
    DIGITAL_SIGNATURE_METHOD,
    QA_CLEARANCE_SIGNED_TYPE,
    parse_electronic_signature,
    qa_clearance_export_status,
)

router = APIRouter(prefix="/api/reports", tags=["reports"])


_GATEWAY_PRIVATE_STATUSES = (GatewayStatus.DRAFT, GatewayStatus.CANCELLED)


def _period_bounds(date_from: str | None, date_to: str | None):
    start = datetime.datetime.fromisoformat(date_from.replace("Z", "+00:00")) if date_from else None
    end = datetime.datetime.fromisoformat(date_to.replace("Z", "+00:00")) if date_to else None
    # Database datetimes are stored as naive local values, as in dashboard.py.
    if start and start.tzinfo:
        start = start.astimezone(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).replace(tzinfo=None)
    if end and end.tzinfo:
        end = end.astimezone(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).replace(tzinfo=None)
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
    if not current_user.has_role(Role.ADMIN):
        q = q.filter(or_(
            models.QARequest.status.notin_(_GATEWAY_PRIVATE_STATUSES),
            models.QARequest.requester_id == current_user.id,
        ))
    scope = dashboard_department_scope(current_user)
    if scope:
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
    q = db.query(models.Defect)
    scope = dashboard_department_scope(current_user)
    if scope:
        project_ids = viewable_project_ids(db, current_user)
        q = (q.join(models.QARequest, models.Defect.qa_request_id == models.QARequest.id)
             .outerjoin(models.TestCycle, models.Defect.cycle_id == models.TestCycle.id)
             .filter(or_(
                 models.QARequest.department.in_(scope),
                 models.TestCycle.project_id.in_(project_ids or []),
             )))
    return _in_period(q, models.Defect.reported_at, date_from, date_to)


def _user_name_map(db: Session, ids) -> dict[int, str]:
    clean_ids = sorted({int(value) for value in ids if value})
    if not clean_ids:
        return {}
    return {user.id: user.full_name for user in db.query(models.User).filter(models.User.id.in_(clean_ids)).all()}


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
    q = (db.query(models.FunctionalRequest)
         .join(models.QARequest,
               models.FunctionalRequest.qa_request_id == models.QARequest.id,
               isouter=True)
         .options(joinedload(models.FunctionalRequest.qa_request)))
    scope = dashboard_department_scope(current_user)
    if scope:
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
        models.TestCase.project_id.in_(project_ids), models.TestCase.is_deleted.is_(False),
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
    for row in rows:
        latest[row.request_id] = row
    return latest


# ---------------- 4.10.2 Security Reports ----------------
@router.get("/sast-scan")
def sast_scan_report(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # department is a delegated property (models.SASTRequest.department reads
    # through .qa_request), not a real column, so scoping needs a join same
    # as list_sast in routers/sast_dast.py -- standalone SAST requests (no
    # qa_request_id) are excluded by this inner join for a scoped user, same
    # as they already resolve to department=None today.
    q = db.query(models.SASTRequest)
    scope = dashboard_department_scope(current_user)
    if scope:
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
    q = db.query(models.DASTRequest)
    scope = dashboard_department_scope(current_user)
    if scope:
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
    request_query = db.query(request_model)
    scope = dashboard_department_scope(current_user)
    if scope:
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
    out = []
    for scan in scans:
        scan_numbers[scan.request_id] = scan_numbers.get(scan.request_id, 0) + 1
        if start and scan.imported_at < start:
            continue
        if end and scan.imported_at > end:
            continue

        request = by_id[scan.request_id]
        scan_no = scan_numbers[scan.request_id]
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
                    "Build": request.build_number,
                    "CR Number/EPIC Number": request.cr_number or request.epic_number,
                })
            else:
                row.update({
                    "Application URL": request.application_url,
                    "Environment": request.environment,
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
    q = db.query(models.PerformanceRequest).options(joinedload(models.PerformanceRequest.qa_request))
    scope = dashboard_department_scope(current_user)
    if scope:
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
    if scope:
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
    if scope:
        q = q.filter(models.SuppressionRequest.department.in_(scope))
    rows = _in_period(q, models.SuppressionRequest.created_at, date_from, date_to).all()
    out = []
    for s in rows:
        items = s.items or [None]
        for item in items:
            out.append({
                "Suppression ID": s.suppression_id, "Application": s.application_name, "Scan Type": s.scan_type,
                "Department": s.department, "Application Owner": s.application_owner,
                "Issue ID": item.issue_id if item else None, "Severity": item.severity if item else None,
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


@router.get("/qa-signoff-register")
def qa_signoff_register(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    q = db.query(models.QASignOff).options(joinedload(models.QASignOff.source_functional_request))
    scope = dashboard_department_scope(current_user)
    if scope:
        q = (q.join(models.FunctionalRequest,
                    models.FunctionalRequest.request_id == models.QASignOff.testing_request_id)
             .join(models.QARequest, models.QARequest.id == models.FunctionalRequest.qa_request_id)
             .filter(models.QARequest.department.in_(scope)))
    rows = _in_period(q, models.QASignOff.created_at, date_from, date_to).order_by(models.QASignOff.created_at.desc()).all()
    names = _user_name_map(db, [
        user_id for item in rows
        for user_id in (item.requester_id, item.reviewed_by_id, item.approved_by_id)
    ])
    return [{
        "Certificate ID": item.certificate_id,
        "Certificate Date": item.certificate_date,
        "Testing Request ID": item.testing_request_id,
        "Application": item.application_name,
        "Request Department": item.request_department,
        "CR Number/EPIC Number": item.change_request_ids,
        "Certificate Type": item.certificate_type,
        "Testing Type": item.testing_type,
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


@router.get("/audit-evidence")
def audit_evidence(date_from: str | None = None, date_to: str | None = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Same cross-entity feed as list_approvals (routers/approvals.py) -- uses
    # the same shared resolve_entity_department helper (deps.py) so this
    # export can't surface another department's approval/audit history
    # either (reported directly: "Report & Export Centre ... other
    # department data can not be shown").
    rows = _in_period(db.query(models.ApprovalAction), models.ApprovalAction.created_at, date_from, date_to).order_by(models.ApprovalAction.created_at.desc()).limit(1000).all()
    scope = dashboard_department_scope(current_user)
    if scope:
        rows = [r for r in rows if resolve_entity_department(db, r.entity_type, r.entity_id) in scope]
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


REPORT_REGISTRY = {
    "qa-request-summary": qa_request_summary,
    "functional-request-register": functional_request_register,
    "test-cycle-summary": test_cycle_summary,
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
    "audit-evidence": audit_evidence,
}
