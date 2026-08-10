import datetime
from collections import Counter
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, cache
from ..database import get_db
from ..deps import get_current_user, dashboard_department_scope
from ..constants import (
    Role, QAStatus, SAST_DAST_TERMINAL_STATUSES, SUPPRESSION_TERMINAL_STATUSES,
    QA_DEPARTMENT, QA_REQUEST_TERMINAL_STATUSES, PERFORMANCE_TERMINAL_STATUSES,
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
    return query.join(models.QARequest, model.qa_request_id == models.QARequest.id) \
                .filter(models.QARequest.department == scope)


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
TESTER_CAPACITY_POINTS = 3.0
FUNCTIONAL_TESTER_LOAD = {
    QAStatus.TESTER_ASSIGNED: 0.50,
    QAStatus.TEST_DESIGN: 1.00,
    QAStatus.EXECUTION_IN_PROGRESS: 1.00,
    QAStatus.DEFECT_RAISED: 0.50,
    QAStatus.WAITING_FOR_FIX: 0.25,
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
    "ASSIGNED_TO_REQUESTER": 0.25,
    "WAITING_FOR_FIX": 0.25,
    "ASSIGNED_TO_LEAD": 0.50,
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


@router.get("/qa-tester-workload")
def qa_tester_workload(date_from: str | None = Query(None), date_to: str | None = Query(None),
                       db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    """QA-team-only capacity view. Work is converted to weighted concurrent
    assignment points so a QA Lead can see who is available, balanced, full,
    or overloaded. Shared requests divide their load across assigned testers."""
    qa_team_roles = {
        Role.QA_ENGINEER, Role.QA_LEAD, Role.SECURITY_ANALYST,
        Role.CHEIF_MANAGER_COE, Role.CHEIF_MANAGER_QA, Role.AGM_COE,
    }
    if not qa_team_roles.intersection(current_user.roles):
        raise HTTPException(403, "QA tester workload is restricted to the QA team")
    qa_testers = (db.query(models.User)
                  .join(models.UserRole, models.UserRole.user_id == models.User.id)
                  .filter(models.User.is_active == True,  # noqa: E712
                          models.UserRole.role.in_([Role.QA_ENGINEER, Role.SECURITY_ANALYST]),
                          models.User.department == QA_DEPARTMENT)
                  .distinct().order_by(models.User.full_name).all())
    functional_requests = (_in_period(db.query(models.FunctionalRequest), models.FunctionalRequest.created_at,
                                      date_from, date_to)
                           .filter(models.FunctionalRequest.status.in_(TESTER_WORKLOAD_STATUSES)).all())
    performance_requests = (_in_period(db.query(models.PerformanceRequest), models.PerformanceRequest.created_at,
                                       date_from, date_to)
                            .filter(models.PerformanceRequest.status.in_(PERFORMANCE_TESTER_WORKLOAD_STATUSES)).all())
    sast_requests = (_in_period(db.query(models.SASTRequest), models.SASTRequest.created_at, date_from, date_to)
                     .filter(models.SASTRequest.status.in_(SECURITY_ANALYST_WORKLOAD_STATUSES)).all())
    dast_requests = (_in_period(db.query(models.DASTRequest), models.DASTRequest.created_at, date_from, date_to)
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
            "department": (user.department if user else None) or "—",
            "role_label": role_label(user),
            "status_counts": {status: 0 for status in TESTER_WORKLOAD_STATUSES},
            "source_counts": {"Functional": 0, "Performance": 0, "SAST": 0, "DAST": 0},
            "total_pending": 0,
            "occupied_points": 0.0,
            "queued_count": 0,
            "active_count": 0,
            "waiting_count": 0,
            "near_complete_count": 0,
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

    for row in rows.values():
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
    }


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
    active_projects = len({r.epic_number for r in requests if r.status in ACTIVE_QA_STATUSES and r.epic_number})

    sast_findings = _join_qa_department(
        _in_period(db.query(models.SASTFinding).join(models.SASTRequest), models.SASTRequest.created_at, date_from, date_to),
        models.SASTRequest, scope).count()
    dast_findings = _join_qa_department(
        _in_period(db.query(models.DASTFinding).join(models.DASTRequest), models.DASTRequest.created_at, date_from, date_to),
        models.DASTRequest, scope).count()

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
        _pending_suppressions_q = _pending_suppressions_q.filter(models.SuppressionRequest.department == scope)
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
    cache_key = f"dashboard:summary:v1:{scope or 'all'}:{date_from or ''}:{date_to or ''}"
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
        nearing_release_q = nearing_release_q.filter(models.QARequest.department == scope)
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
    findings = _join_qa_department(
        _in_period(db.query(models.SASTFinding).join(models.SASTRequest), models.SASTRequest.created_at, date_from, date_to),
        models.SASTRequest, scope).all()
    return {
        # Every SAST request ever raised, any status -- distinct from
        # applications_scanned below (only those that actually finished
        # scanning). Answers "how many SAST requests are there", not "how
        # many have been scanned".
        "total_requests": len(reqs),
        "applications_scanned": len({r.application_name for r in reqs if r.status in ("REPORT_READY", "CLOSED")}),
        "open_vulnerabilities": len([f for f in findings if f.status == "Open"]),
        "severity_distribution": Counter(f.severity for f in findings),
        "remediation_status": Counter(f.status for f in findings),
    }


@router.get("/security/dast")
def security_dast(date_from: str | None = Query(None), date_to: str | None = Query(None), db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    scope = dashboard_department_scope(current_user)
    reqs = _join_qa_department(
        _in_period(db.query(models.DASTRequest), models.DASTRequest.created_at, date_from, date_to), models.DASTRequest, scope).all()
    findings = _join_qa_department(
        _in_period(db.query(models.DASTFinding).join(models.DASTRequest), models.DASTRequest.created_at, date_from, date_to),
        models.DASTRequest, scope).all()
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
        "vulnerability_trends": Counter(f.severity for f in findings),
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
        q = q.filter(models.SuppressionRequest.department == scope)
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
            "project_id": r.request_id, "epic_number": r.epic_number or r.application_name,
            "application_name": r.application_name, "pending_stage": STAGE_LABELS.get(r.status, r.status),
            "responsible_team": STAGE_TEAM.get(r.status, "QA"), "owner": r.application_owner,
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
            "project_id": r.request_id, "epic_number": r.epic_number or r.application_name,
            "application_name": r.application_name, "pending_stage": f"SAST - {r.status}",
            "responsible_team": "Security", "owner": None,
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
            "project_id": r.request_id, "epic_number": r.application_url,
            "application_name": r.application_url, "pending_stage": f"DAST - {r.status}",
            "responsible_team": "Security", "owner": None,
            "department": r.department,
            "pending_since": r.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": r.risk_category, "status": r.status, "source": "DAST Request",
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
        _suppression_q = _suppression_q.filter(models.SuppressionRequest.department == scope)
    for s in _suppression_q.all():
        age = _age_days(s.updated_at)
        team = _SUPPRESSION_STAGE_TEAM.get(s.status, "Requester")
        items.append({
            "project_id": s.suppression_id, "epic_number": s.application_name,
            "application_name": s.application_name, "pending_stage": s.status,
            "responsible_team": team, "owner": None,
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
    if scope and req.department != scope:
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
