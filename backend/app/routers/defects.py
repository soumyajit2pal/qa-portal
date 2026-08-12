import os
from collections import Counter
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from .. import documents as doc_store
from .. import models, schemas, pagination
from ..constants import ENVIRONMENTS, Role, DEFECT_MANAGEMENT_ROLES, DEFECT_REASSIGNABLE_STATUSES
from ..database import get_db
from ..deps import get_current_user, require_roles, dashboard_department_scope
from ..xlsx_export import add_summary_sheet, add_table_sheet, new_workbook, workbook_response
from . import notifications
from .. import reassignment

router = APIRouter(prefix="/api/defects", tags=["defect-management"])

STATUSES = ("New", "Assigned", "In Progress", "Resolved", "Retest", "Reopened", "Deferred", "Rejected", "Duplicate", "Closed")
SEVERITIES = ("Critical", "High", "Medium", "Low")
PRIORITIES = ("P1 – Immediate", "P2 – High", "P3 – Medium", "P4 – Low")
RESOLUTION_TYPES = (
    "Fixed", "Configuration Changed", "Data Corrected", "Code Change",
    "Environment Issue Resolved", "Cannot Reproduce", "Working as Designed", "Other",
)
TRANSITIONS = {
    "New": {"Assigned", "Rejected", "Duplicate", "Deferred"},
    "Assigned": {"In Progress", "Deferred"},
    "In Progress": {"Resolved", "Deferred"},
    "Resolved": {"Retest"},
    "Retest": {"Closed", "Reopened"},
    "Reopened": {"Assigned"},
    "Deferred": {"Assigned"},
    "Closed": {"Reopened"},
    "Rejected": set(),
    "Duplicate": set(),
}
CREATE_ROLES = (
    Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA,
    Role.SECURITY_ANALYST, Role.REQUESTER, Role.BUSINESS_ANALYST,
    Role.APPLICATION_OWNER,
)
# 2026-08 -- reported directly, then corrected same day (see
# DEFECT_MANAGEMENT_ROLES' own comment in constants.py): "other than QA
# team, for others there should not be any option to open any defects,"
# then "defect can be raised by requster, business analyst application
# owner too so defect management tool should be available for them as
# well." DEFECT_MANAGEMENT_ROLES (imported above, shared with
# routers/test_execution.py's batch picker) gates
# list_defects/defect_dashboard/export_defects below -- effectively
# "whoever CREATE_ROLES already lets report/link a defect, plus AGM_QA" --
# scoped narrowly to the *register* (browsing defects at all); a
# single-defect deep link (GET /{id}, GET /by-key/{key} -- e.g. from a
# notification) stays open to any authenticated user regardless.
_DOC_MODULE = "DEFECT"


def _get(defect_id: int, db: Session) -> models.Defect:
    obj = db.query(models.Defect).get(defect_id)
    if not obj:
        raise HTTPException(404, "Defect not found")
    return obj


def _scoped_defects(db: Session, current_user: models.User):
    """Loophole fix: every OTHER list endpoint in this app applies
    dashboard_department_scope (see that function's own docstring in
    deps.py) so a department-scoped role only ever sees its own
    department's records -- this module's list/dashboard/export endpoints
    had no such scoping at all, so any authenticated user (Requester,
    Business Analyst, Application Owner -- not just QA staff) could browse
    every governed defect in the entire org, including steps to reproduce,
    API endpoints, and log details for defects completely unrelated to
    them. Defect has no department column of its own (unlike QARequest/
    TestProject/etc.), so this joins through its always-present
    qa_request_id to get one, mirroring how approvals.py/reports.py already
    do the same join-based scoping for cross-entity feeds."""
    q = db.query(models.Defect)
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.join(models.QARequest, models.Defect.qa_request_id == models.QARequest.id) \
             .filter(models.QARequest.department == scope)
    return q


def _can_touch_defect(db: Session, obj: models.Defect, user: models.User) -> bool:
    """Loophole fix: upload_attachments previously only blocked uploads once
    a defect was Closed -- it never checked WHO was uploading, unlike every
    sibling module's own _can_upload_documents (functional.py, sast_dast.py,
    performance.py, etc.), which all gate on the current stage's actual
    actor. True for anyone with a real stake in this specific defect: the
    reporter, the current assignee, the retest tester, or a manager (Admin/
    QA Lead/Chief Manager QA/this defect's own Project Lead or Owner, via
    _is_manager)."""
    return (
        _is_manager(db, obj, user)
        or obj.reporter_id == user.id
        or obj.assignee_id == user.id
        or obj.retest_tester_id == user.id
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
    project_department = cycle.project.department if cycle.project else None
    if scope and project_department and project_department != scope:
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


def _execution_context(db: Session, execution_id: int, request: models.QARequest):
    execution = db.query(models.TestExecution).get(execution_id)
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
        child = db.query(child_model).get(linked_request.child_id) if child_model else None
        if child and child.qa_request_id and child.qa_request_id != request.id:
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


def _link_to_execution(db: Session, obj: models.Defect, execution: models.TestExecution,
                       cycle: models.TestCycle, test_case: models.TestCase,
                       user: models.User) -> None:
    if obj.execution_id and obj.execution_id != execution.id:
        raise HTTPException(400, "This defect is already linked to another primary execution")
    obj.execution_id = execution.id
    obj.cycle_id = cycle.id
    obj.primary_test_case_id = test_case.id
    obj.retest_tester_id = obj.retest_tester_id or execution.assigned_to_id or user.id
    _ensure_case_link(db, obj.id, test_case.id)
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


_TERMINAL_STATUSES = ("Closed", "Rejected", "Duplicate")
_ATTENTION_SEVERITIES = ("Critical", "High")
_RETEST_STATUSES = ("Resolved", "Retest")

# SRS 7.2 pagination rollout -- every field the register table, the queue
# tabs, and every other module's own defect pickers need off a row, without
# lazy-loading `reporter_name`/`assignee_name`/`qa_request_key`/`cycle_key`/
# `test_case_key` (all `@property`s on `models.Defect`) once per row.
_LIST_DEFECT_EAGER_LOADS = [
    joinedload(models.Defect.qa_request), joinedload(models.Defect.cycle),
    joinedload(models.Defect.primary_test_case), joinedload(models.Defect.reporter),
    joinedload(models.Defect.assignee),
]


@router.get("", response_model=pagination.Page[schemas.DefectListOut])
def list_defects(status: Optional[str] = None, severity: Optional[str] = None,
                 priority: Optional[str] = None, cycle_id: Optional[int] = None,
                 test_case_id: Optional[int] = None, execution_id: Optional[int] = None,
                 qa_request_id: Optional[int] = None, assignee_id: Optional[int] = None,
                 reporter_id: Optional[int] = None,
                 queue: Optional[str] = Query(
                     None, description="'attention'|'mine'|'unlinked'|'retest'|'closed', omitted for all -- "
                                        "matches Defects.tsx's own queue tabs exactly",
                 ),
                 params: pagination.PageParams = Depends(),
                 db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(*DEFECT_MANAGEMENT_ROLES))):
    # Kept as plain query params (not folded into PageParams.status) since
    # they're single-value exact filters used by other modules' own narrow
    # pickers (e.g. TestExecution.tsx's `?cycle_id=`), same convention as
    # every other module's list endpoint. `params.status`/`params.search`
    # (PAG-001/007) additionally cover the register's own multi-status and
    # free-text search needs.
    q = _scoped_defects(db, current_user).options(*_LIST_DEFECT_EAGER_LOADS)
    for column, value in (
        (models.Defect.status, status), (models.Defect.severity, severity),
        (models.Defect.priority, priority), (models.Defect.cycle_id, cycle_id),
        (models.Defect.execution_id, execution_id), (models.Defect.qa_request_id, qa_request_id),
        (models.Defect.assignee_id, assignee_id), (models.Defect.reporter_id, reporter_id),
    ):
        if value is not None:
            q = q.filter(column == value)
    if test_case_id is not None:
        q = q.join(models.DefectTestCaseLink).filter(models.DefectTestCaseLink.test_case_id == test_case_id)
    if queue == "attention":
        q = q.filter(models.Defect.severity.in_(_ATTENTION_SEVERITIES)).filter(models.Defect.status.notin_(_TERMINAL_STATUSES))
    elif queue == "mine":
        q = q.filter(or_(models.Defect.assignee_id == current_user.id, models.Defect.reporter_id == current_user.id))
    elif queue == "unlinked":
        q = q.filter(models.Defect.execution_id.is_(None))
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
def defect_dashboard(db: Session = Depends(get_db), current_user: models.User = Depends(require_roles(*DEFECT_MANAGEMENT_ROLES))):
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
    unlinked_count = base.filter(models.Defect.execution_id.is_(None)).with_entities(func.count(models.Defect.id)).scalar() or 0
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
def export_defects(db: Session = Depends(get_db), current_user: models.User = Depends(require_roles(*DEFECT_MANAGEMENT_ROLES))):
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
            ("Open defects", sum(v for k, v in status_counts.items() if k not in {"Closed", "Rejected", "Duplicate"})),
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
    obj = db.query(models.Defect).filter_by(defect_key=defect_key.strip().upper()).first()
    if not obj:
        raise HTTPException(404, f"Defect {defect_key} was not found")
    return obj


@router.get("/{defect_id}", response_model=schemas.DefectOut)
def get_defect(defect_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get(defect_id, db)


@router.post("", response_model=schemas.DefectOut)
def create_defect(payload: schemas.DefectCreate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    _require_create_role(current_user)
    request = db.query(models.QARequest).get(payload.qa_request_id)
    if not request:
        raise HTTPException(404, "QA Request was not found")
    # Loophole fix: create_request (qa_requests.py) explicitly sources a new
    # QA Request's own department from the requester's profile server-side,
    # "ignore whatever the payload sent" -- but this endpoint accepted any
    # client-supplied qa_request_id with no check the caller has any
    # relationship to it at all, letting a Requester/Business Analyst/
    # Application Owner from ANY department report (and see, via the
    # created row) a defect against a request belonging to a department
    # they have nothing to do with. Same dashboard_department_scope
    # semantics as every list endpoint: QA/Security/Executive-COE roles
    # (and Admin) stay unrestricted since they legitimately work across
    # every department's requests; a department-scoped role may only
    # report defects against its own department's requests.
    scope = dashboard_department_scope(current_user)
    if scope and request.department and request.department != scope:
        raise HTTPException(403, "You can only report defects against QA Requests from your own department.")
    link_values = (payload.execution_id, payload.cycle_id, payload.test_case_id)
    if any(value is not None for value in link_values) and not all(value is not None for value in link_values):
        raise HTTPException(400, "Execution, Test Cycle, and Test Case must be supplied together, or all left blank")
    execution = cycle = test_case = None
    if payload.execution_id is not None:
        execution, cycle, test_case = _execution_context(db, payload.execution_id, request)
        _require_execution_link_access(db, cycle, current_user)
        if payload.cycle_id != cycle.id or payload.test_case_id != test_case.id:
            raise HTTPException(400, "Test Execution must belong to the selected Test Cycle and Test Case")
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
        description=_required(payload.description, "Description"), qa_request_id=request.id,
        cycle_id=cycle.id if cycle else None, primary_test_case_id=test_case.id if test_case else None,
        execution_id=execution.id if execution else None,
        application_name=request.application_name, module_feature=_required(payload.module_feature, "Module/Feature"),
        environment=_required(payload.environment, "Environment"), severity=payload.severity,
        priority=payload.priority, steps_to_reproduce=_required(payload.steps_to_reproduce, "Steps to Reproduce"),
        expected_result=_required(payload.expected_result, "Expected Result"),
        actual_result=_required(payload.actual_result, "Actual Result"), reporter_id=current_user.id,
        retest_tester_id=payload.retest_tester_id or (execution.assigned_to_id if execution else None) or current_user.id,
        device_details=payload.device_details,
        build_version=payload.build_version or (cycle.build if cycle else None) or request.build_number, api_endpoint=payload.api_endpoint,
        request_response_details=payload.request_response_details, log_details=payload.log_details,
        related_cr_number=payload.related_cr_number or request.cr_number,
        external_defect_id=payload.external_defect_id, remarks=payload.remarks, labels=payload.labels,
    )
    db.add(obj); db.flush()
    for case_id in case_ids:
        _ensure_case_link(db, obj.id, case_id)
    if execution and cycle and test_case:
        _link_to_execution(db, obj, execution, cycle, test_case, current_user)
    _audit(db, obj, current_user, "Created", f"Reported {obj.defect_key} with {obj.severity} severity and {obj.priority} priority.", new_state="New", step_name="Defect")
    recipient_ids = [cycle.owner_id, cycle.project.default_qa_lead_id if cycle and cycle.project else None] if cycle else []
    notifications.fire(db, recipient_ids, "Defect Created", "DEFECT", obj.id, obj.defect_key,
                       f"{obj.defect_key} was reported" + (f" for {test_case.test_case_key}." if test_case else " and awaits execution linkage."), current_user.id)
    db.commit(); db.refresh(obj)
    return obj


@router.post("/{defect_id}/link-execution", response_model=schemas.DefectOut)
def link_defect_execution(defect_id: int, payload: schemas.DefectLinkExecution,
                          db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    obj = _get(defect_id, db)
    if obj.status in {"Closed", "Rejected", "Duplicate"}:
        raise HTTPException(400, f"A {obj.status} defect cannot be linked to a new execution")
    execution, cycle, test_case = _execution_context(db, payload.execution_id, obj.qa_request)
    _require_execution_link_access(db, cycle, current_user)
    _link_to_execution(db, obj, execution, cycle, test_case, current_user)
    _audit(db, obj, current_user, "Linked", f"Linked to {cycle.cycle_key} / {test_case.test_case_key} / execution #{execution.id}.", step_name="Traceability")
    notifications.fire(db, [obj.reporter_id, obj.assignee_id], "Defect Linked", "DEFECT", obj.id, obj.defect_key,
                       f"{obj.defect_key} was linked to {cycle.cycle_key} and {test_case.test_case_key}.", current_user.id)
    db.commit(); db.refresh(obj)
    return obj


@router.patch("/{defect_id}", response_model=schemas.DefectOut)
def update_defect(defect_id: int, payload: schemas.DefectUpdate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    obj = _get(defect_id, db)
    manager = _is_manager(db, obj, current_user)
    if obj.status != "New":
        raise HTTPException(400, "Only a New defect can be edited. Use workflow actions for later changes")
    if not manager and obj.reporter_id != current_user.id:
        raise HTTPException(403, "Only the reporter, QA Lead, Project Lead, or Administrator can edit a New defect")
    data = payload.model_dump(exclude_unset=True)
    if ("severity" in data or "priority" in data) and not manager:
        raise HTTPException(403, "Only an authorized lead can change severity or priority after submission")
    if data.get("severity") and data["severity"] not in SEVERITIES:
        raise HTTPException(400, "Select a valid severity")
    if data.get("priority") and data["priority"] not in PRIORITIES:
        raise HTTPException(400, "Select a valid priority")
    if data.get("environment") and data["environment"] not in ENVIRONMENTS:
        raise HTTPException(400, "Select a valid environment")
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
    obj = _get(defect_id, db)
    requested = payload.status
    if requested not in STATUSES or requested not in TRANSITIONS.get(obj.status, set()):
        raise HTTPException(400, f"Invalid status transition. Defect {obj.defect_key} cannot be changed from {obj.status} to {requested}.")
    manager = _is_manager(db, obj, current_user)
    assignee = _is_assignee(obj, current_user)
    tester = _is_tester(obj, current_user)
    if requested == "Assigned" and not _can_assign(db, obj, current_user):
        raise HTTPException(403, "Only a QA Engineer, QA Lead, Project Lead, or Administrator can assign a defect")
    if requested in {"Rejected", "Duplicate"} and not manager:
        raise HTTPException(403, "This defect action requires a QA Lead, Project Lead, or Administrator")
    if requested == "Deferred" and not _can_defer(db, obj, current_user):
        raise HTTPException(403, "Only a QA Lead, Project Lead, Application Owner, or Administrator can defer a defect")
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
        if obj.status == "Closed" and not (
            current_user.has_role(Role.QA_LEAD) or current_user.has_role(Role.CHIEF_MANAGER_QA)
            or obj.reporter_id == current_user.id
        ):
            raise HTTPException(403, "Only the reporter, a QA Lead, or an Administrator can reopen a Closed defect")
        if obj.status == "Retest" and not (tester or manager):
            raise HTTPException(403, "Only the assigned tester or an authorized lead can reopen this defect")

    previous = obj.status
    remarks = (payload.remarks or "").strip()
    if requested == "Assigned":
        assignee_id = _required(payload.assignee_id, "Assignee")
        assignee_user = db.query(models.User).get(assignee_id)
        if not assignee_user or not assignee_user.is_active:
            raise HTTPException(404, "Selected assignee was not found or is inactive")
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
        previous_assignee = obj.assignee_name
        obj.assignee_id = assignee_user.id; obj.assigned_team = department.name
        obj.assigned_by_id = current_user.id; obj.assigned_at = models.now(); obj.assignment_remarks = remarks or None
        details = f"Assigned to {assignee_user.full_name} ({department.name})"
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
        obj.retest_result = "Failed"; obj.retest_at = models.now(); obj.reopen_count += 1; details = obj.reopen_reason
    elif requested == "Deferred":
        obj.deferral_reason = _required(payload.deferral_reason, "Deferral Reason")
        obj.deferral_approved_by = _required(payload.deferral_approved_by, "Approved By")
        obj.target_release = _required(payload.target_release, "Target Release")
        obj.expected_resolution_date = _required(payload.expected_resolution_date, "Expected Resolution Date")
        details = obj.deferral_reason
    elif requested == "Rejected":
        obj.rejection_reason = _required(payload.rejection_reason, "Rejection Reason"); details = obj.rejection_reason
    elif requested == "Duplicate":
        duplicate_id = _required(payload.duplicate_defect_id, "Original Defect ID")
        original = db.query(models.Defect).get(duplicate_id)
        if not original or original.id == obj.id:
            raise HTTPException(400, "Select a valid original Defect ID")
        obj.duplicate_of_id = original.id; details = f"Duplicate of {original.defect_key}."
    else:
        details = remarks or f"Changed to {requested}."

    obj.status = requested
    db.query(models.TestRunDefect).filter(
        models.TestRunDefect.defect_key == obj.defect_key,
    ).update({models.TestRunDefect.defect_status: requested}, synchronize_session=False)
    _audit(db, obj, current_user, requested, details, previous, requested)
    recipient_ids = [obj.reporter_id, obj.assignee_id, obj.retest_tester_id]
    notifications.fire(db, recipient_ids, f"Defect {requested}", "DEFECT", obj.id, obj.defect_key,
                       f"{obj.defect_key} changed from {previous} to {requested}.", current_user.id)
    db.commit(); db.refresh(obj)
    return obj


# 2026-08 Reassignment Requirement -- the "Assigned" transition above is
# only reachable from New/Reopened/Deferred, so once a defect is In
# Progress/Resolved/Retest/Reopened/Deferred there was previously no way to
# change who it's assigned to at all. Dedicated endpoint, deliberately kept
# separate from transition_defect: it changes only the assignee, leaving
# status/history untouched, exactly as the CR requires ("The record's
# existing status and history shall remain unchanged").
@router.post("/{defect_id}/reassign", response_model=schemas.DefectOut)
def reassign_defect(defect_id: int, payload: schemas.DefectReassign, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    obj = _get(defect_id, db)
    if not obj.assignee_id or obj.status not in DEFECT_REASSIGNABLE_STATUSES:
        raise HTTPException(400, f"{obj.defect_key} does not currently have an assignee that can be reassigned.")
    previous_assignee = db.query(models.User).get(obj.assignee_id)
    reassignment.require_can_reassign(current_user, obj.assignee_id, previous_assignee.department if previous_assignee else None)
    reason = reassignment.require_reason(payload.reason)
    new_assignee = db.query(models.User).get(payload.assignee_id)
    if not new_assignee or not new_assignee.is_active:
        raise HTTPException(404, "Selected assignee was not found or is inactive")
    if payload.assigned_team:
        department = db.query(models.Department).filter(
            models.Department.name == payload.assigned_team,
            models.Department.is_active == True,  # noqa: E712
        ).first()
        if not department:
            raise HTTPException(400, "Select a valid active Department")
        obj.assigned_team = department.name
    previous_label = previous_assignee.full_name if previous_assignee else (obj.assignee_name or "Unassigned")
    obj.assignee_id = new_assignee.id
    obj.assigned_by_id = current_user.id
    obj.assigned_at = models.now()
    reassignment.record_reassignment(db, "DEFECT", obj.id, current_user, previous_label, new_assignee.full_name, reason)
    if not previous_assignee or new_assignee.id != previous_assignee.id:
        reassignment.notify_new_assignee(
            db, new_assignee.id, "DEFECT", obj.id, obj.defect_key,
            f"You have been reassigned {obj.defect_key}.", current_user.id,
        )
    db.commit(); db.refresh(obj)
    return obj


@router.post("/{defect_id}/attachments", response_model=List[schemas.RequestDocumentOut])
def upload_attachments(defect_id: int, files: List[UploadFile] = File(...), db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    obj = _get(defect_id, db)
    if obj.status == "Closed" and not _is_manager(db, obj, current_user):
        raise HTTPException(403, "Closed defects are read-only")
    # Loophole fix: this only ever checked the Closed-status case -- for
    # every other status, ANY authenticated user (no relationship to this
    # defect, its project, or its department at all) could attach files to
    # it. Every sibling module's own document upload endpoint gates on a
    # real "who can upload" check (_can_upload_documents in functional.py/
    # sast_dast.py/performance.py/etc.); this brings Defects in line.
    if not _can_touch_defect(db, obj, current_user):
        raise HTTPException(403, "Only the reporter, assignee, retest tester, or an authorized lead can attach evidence to this defect")
    return doc_store.save_documents(db, _DOC_MODULE, obj.id, obj.defect_key, files, current_user.id,
                                    log_entity_type="DEFECT", log_entity_id=obj.id,
                                    log_actor=current_user, log_label="defect evidence")


@router.get("/{defect_id}/attachments", response_model=List[schemas.RequestDocumentOut])
def list_attachments(defect_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get(defect_id, db)
    return doc_store.list_documents(db, _DOC_MODULE, defect_id)


@router.get("/{defect_id}/attachments/{document_id}/download")
def download_attachment(defect_id: int, document_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    obj = _get(defect_id, db)
    document = doc_store.get_document_or_404(db, _DOC_MODULE, obj.id, document_id)
    path = doc_store.full_path(document)
    if not os.path.exists(path):
        raise HTTPException(404, "Attachment file is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")
