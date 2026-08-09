import os
from collections import Counter
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import documents as doc_store
from .. import models, schemas
from ..constants import ENVIRONMENTS, Role
from ..database import get_db
from ..deps import get_current_user, get_project_member_role, dashboard_department_scope
from ..xlsx_export import add_summary_sheet, add_table_sheet, new_workbook, workbook_response
from . import notifications

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
    Role.QA_ENGINEER, Role.QA_LEAD, Role.CHEIF_MANAGER_QA,
    Role.SECURITY_ANALYST, Role.REQUESTER, Role.BUSINESS_ANALYST,
    Role.APPLICATION_OWNER,
)
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
    if user.has_role(Role.QA_LEAD) or user.has_role(Role.CHEIF_MANAGER_QA):
        return True
    if not obj.cycle:
        return False
    project_role = get_project_member_role(db, obj.cycle.project_id, user.id)
    return project_role in {"Project Lead", "Owner"}


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
    included, not just QA staff), so a non-member additionally needs their
    department scope to include this execution's own project -- same
    dashboard_department_scope semantics used everywhere else (QA/Security/
    Executive-COE roles and Admin stay unrestricted). An actual Tester/
    Project Lead/Owner member of THIS project may act regardless of
    department, same override every other project-role check in this app
    grants."""
    project_role = get_project_member_role(db, cycle.project_id, current_user.id)
    if project_role in {"Project Lead", "Owner", "Tester"}:
        return
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


@router.get("", response_model=List[schemas.DefectOut])
def list_defects(status: Optional[str] = None, severity: Optional[str] = None,
                 priority: Optional[str] = None, cycle_id: Optional[int] = None,
                 test_case_id: Optional[int] = None, execution_id: Optional[int] = None,
                 qa_request_id: Optional[int] = None, assignee_id: Optional[int] = None,
                 reporter_id: Optional[int] = None, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    q = _scoped_defects(db, current_user)
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
    return q.order_by(models.Defect.created_at.desc()).all()


@router.get("/dashboard", response_model=schemas.DefectDashboardOut)
def defect_dashboard(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    defects = _scoped_defects(db, current_user).all()
    by_status = Counter(item.status for item in defects)
    by_severity = Counter(item.severity for item in defects)
    by_priority = Counter(item.priority for item in defects)
    by_application = Counter(item.application_name for item in defects)
    by_assignee = Counter(item.assignee_name or "Unassigned" for item in defects)
    today = models.now().date()
    by_ageing = Counter()
    for item in defects:
        age = max(0, (today - item.reported_at.date()).days)
        by_ageing["0–7 days" if age <= 7 else "8–14 days" if age <= 14 else "15–30 days" if age <= 30 else "31+ days"] += 1
    closure_trend = Counter(item.closed_at.strftime("%Y-%m") for item in defects if item.closed_at)
    return {
        "total": len(defects), "open": sum(v for k, v in by_status.items() if k not in {"Closed", "Rejected", "Duplicate"}),
        "closed": by_status["Closed"], "reopened": by_status["Reopened"], "deferred": by_status["Deferred"],
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
            current_user.has_role(Role.QA_LEAD) or current_user.has_role(Role.CHEIF_MANAGER_QA)
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
