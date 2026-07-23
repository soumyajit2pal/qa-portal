import datetime
from collections import Counter
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..constants import QAStatus, QA_REQUEST_TERMINAL_STATUSES

router = APIRouter(prefix="/api/dashboard", tags=["dashboard-analytics"])

# Statuses that represent "work still in flight" for a QA Request (i.e. not a
# terminal state and not sitting untouched in Draft).
ACTIVE_QA_STATUSES = {
    QAStatus.SUBMITTED, QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD,
    QAStatus.QA_LEAD_ASSIGNED, QAStatus.READINESS_VERIFICATION, QAStatus.RETURNED_BY_QA_LEAD,
    QAStatus.QA_ACTIVITY_INITIATED, QAStatus.PLANNING, QAStatus.TESTER_ASSIGNED, QAStatus.TEST_DESIGN,
    QAStatus.EXECUTION_IN_PROGRESS, QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX,
    QAStatus.RETESTING, QAStatus.REGRESSION_TESTING, QAStatus.QA_COMPLETED,
    QAStatus.QA_SIGNOFF_PENDING, QAStatus.QA_SIGNED_OFF, QAStatus.REQUESTER_VERIFICATION,
}

# Statuses awaiting a decision/action from someone other than the requester --
# used for the "pending approvals" metric.
PENDING_APPROVAL_STATUSES = {
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING,
    QAStatus.READINESS_VERIFICATION, QAStatus.QA_SIGNOFF_PENDING, QAStatus.REQUESTER_VERIFICATION,
}


def _age_days(dt) -> int:
    if not dt:
        return 0
    if isinstance(dt, datetime.date) and not isinstance(dt, datetime.datetime):
        dt = datetime.datetime(dt.year, dt.month, dt.day)
    return (datetime.datetime.utcnow() - dt).days


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
def project_wise(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    requests = db.query(models.QARequest).all()
    active_projects = len({r.project_name for r in requests if r.status in ACTIVE_QA_STATUSES and r.project_name})

    # Test Case Repository / Test Execution Management (Modules 2 & 3) are
    # temporarily DISABLED -- the "Test cases tracked" and "Open defects"
    # Command Centre metrics (which read TestCase/TestRunCase directly) have
    # been removed along with them per request; the portal is currently
    # focused on the QA Request module only. Re-enable by restoring the
    # total_test_cases/open_defects computation here alongside the modules.
    sast_findings = db.query(models.SASTFinding).count()
    dast_findings = db.query(models.DASTFinding).count()

    # Was QA-Request-only, which disagreed with the "approvals needing
    # attention" count shown elsewhere in the app (e.g. the old Approval
    # Workflow Log nav badge) -- if the one pending item was actually a SAST/
    # DAST/Suppression request, approving it there never changed this number,
    # so the Command Centre banner looked stuck even after it was cleared.
    # Now counts the same things everywhere: QA Requests awaiting a decision,
    # plus SAST/DAST requests still "Requested", plus open Suppressions.
    pending_approvals = (
        len([r for r in requests if r.status in PENDING_APPROVAL_STATUSES])
        + db.query(models.SASTRequest).filter(models.SASTRequest.status == "Requested").count()
        + db.query(models.DASTRequest).filter(models.DASTRequest.status == "Requested").count()
        + db.query(models.SuppressionRequest).filter(
            models.SuppressionRequest.status.notin_(["Approved", "Rejected"])).count()
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


# ---------------- 4.9.3 / 4.9.4 QA-wise Dashboard ----------------
@router.get("/qa-wise/{user_id}")
def qa_wise(user_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    requests = db.query(models.QARequest).filter(
        models.QARequest.assigned_tester_ids.like(f"%{user_id}%")
    ).all()
    assigned_projects = len({r.project_name for r in requests if r.project_name})

    # See note in project_wise() above -- Test Case Repository / Test Execution
    # are disabled for direct use, but these metrics still read the tables.
    run_cases = db.query(models.TestRunCase).filter(models.TestRunCase.executed_by_id == user_id).all()
    executed = len(run_cases)
    passed = len([c for c in run_cases if c.execution_status in ("Passed", "Retest Passed")])
    defects_logged = len([c for c in run_cases if c.defect_id])

    assigned_cases = db.query(models.TestCase).filter(models.TestCase.created_by_id == user_id).count()

    return {
        "metrics": {
            "assigned_projects": assigned_projects,
            "assigned_test_cases": assigned_cases,
            "executed_cases": executed,
            "pass_rate": round(passed / executed * 100, 2) if executed else 0,
            "defects_logged": defects_logged,
            "defects_closed": 0,
        },
        "charts": {
            "qa_performance_overview": {"executed": executed, "passed": passed},
            "work_allocation": {"projects": assigned_projects, "test_cases": assigned_cases},
            "test_execution_trend": Counter(c.execution_status for c in run_cases),
        },
    }


# ---------------- 4.9.5 / 4.9.6 Security Dashboards ----------------
@router.get("/security/sast")
def security_sast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    reqs = db.query(models.SASTRequest).all()
    findings = db.query(models.SASTFinding).all()
    return {
        "applications_scanned": len({r.application_name for r in reqs if r.status in ("Report Ready", "Closed")}),
        "open_vulnerabilities": len([f for f in findings if f.status == "Open"]),
        "severity_distribution": Counter(f.severity for f in findings),
        "remediation_status": Counter(f.status for f in findings),
    }


@router.get("/security/dast")
def security_dast(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    reqs = db.query(models.DASTRequest).all()
    findings = db.query(models.DASTFinding).all()
    return {
        "scan_coverage": len({r.application_url for r in reqs}),
        "vulnerability_trends": Counter(f.severity for f in findings),
        "compliance_status": Counter(r.status for r in reqs),
    }


# ---------------- 4.9.7 Suppression Dashboard ----------------
@router.get("/suppression")
def suppression_dashboard(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    sups = db.query(models.SuppressionRequest).all()
    open_sups = [s for s in sups if s.status not in ("Approved", "Rejected")]
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
    QAStatus.SUBMITTED: "Department Head Approval Pending",
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING: "Department Head Approval Pending",
    QAStatus.RETURNED_BY_DEPARTMENT_HEAD: "Rework by Requester Pending",
    QAStatus.QA_LEAD_ASSIGNED: "Readiness Verification Pending",
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
    QAStatus.REGRESSION_TESTING: "Regression Testing In Progress",
    QAStatus.QA_COMPLETED: "Sign-off Request Pending",
    QAStatus.QA_SIGNOFF_PENDING: "QA Sign-off Pending",
    QAStatus.QA_SIGNED_OFF: "Requester Verification Pending",
    QAStatus.REQUESTER_VERIFICATION: "Requester Verification Pending",
}
STAGE_TEAM = {
    QAStatus.SUBMITTED: "Department Head",
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING: "Department Head",
    QAStatus.RETURNED_BY_DEPARTMENT_HEAD: "Business / BA",
    QAStatus.QA_LEAD_ASSIGNED: "QA Lead",
    QAStatus.READINESS_VERIFICATION: "QA Lead",
    QAStatus.RETURNED_BY_QA_LEAD: "Business / BA",
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
    QAStatus.REGRESSION_TESTING: "QA",
    QAStatus.QA_COMPLETED: "QA Lead",
    QAStatus.QA_SIGNOFF_PENDING: "QA Lead",
    QAStatus.QA_SIGNED_OFF: "Requester",
    QAStatus.REQUESTER_VERIFICATION: "Requester",
}


@router.get("/3w")
def three_w_dashboard(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """
    'Know What Is Pending, Where It Is Pending, and Since When' -- section 4.9.8.
    Aggregates pending items across QA requests, SAST/DAST requests and suppression
    requests with ageing, responsible team/owner, and priority.
    """
    items = []

    for r in db.query(models.QARequest).filter(models.QARequest.status.in_(list(STAGE_LABELS.keys()))).all():
        age = _age_days(r.updated_at)
        items.append({
            "project_id": r.request_id, "project_name": r.project_name or r.application_name,
            "application_name": r.application_name, "pending_stage": STAGE_LABELS.get(r.status, r.status),
            "responsible_team": STAGE_TEAM.get(r.status, "QA"), "owner": r.application_owner,
            "pending_since": r.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": r.priority, "status": r.status, "source": "QA Request",
        })

    for r in db.query(models.SASTRequest).filter(models.SASTRequest.status != "Closed").all():
        age = _age_days(r.updated_at)
        items.append({
            "project_id": r.request_id, "project_name": r.project_name or r.application_name,
            "application_name": r.application_name, "pending_stage": f"SAST - {r.status}",
            "responsible_team": "Security", "owner": None,
            "pending_since": r.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": r.risk_category, "status": r.status, "source": "SAST Request",
        })

    for r in db.query(models.DASTRequest).filter(models.DASTRequest.status != "Closed").all():
        age = _age_days(r.updated_at)
        items.append({
            "project_id": r.request_id, "project_name": r.application_url,
            "application_name": r.application_url, "pending_stage": f"DAST - {r.status}",
            "responsible_team": "Security", "owner": None,
            "pending_since": r.updated_at, "ageing_days": age, "ageing_bucket": _ageing_bucket(age),
            "priority": r.risk_category, "status": r.status, "source": "DAST Request",
        })

    for s in db.query(models.SuppressionRequest).filter(
            models.SuppressionRequest.status.notin_(["Approved", "Rejected"])).all():
        age = _age_days(s.updated_at)
        team = "Application Owner" if s.status == "Pending Application Owner" else "Department Head"
        items.append({
            "project_id": s.suppression_id, "project_name": s.application_name,
            "application_name": s.application_name, "pending_stage": s.status,
            "responsible_team": team, "owner": None,
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
    req = db.query(models.QARequest).filter(models.QARequest.request_id == project_id).first()
    if not req:
        return {"detail": "Project not found"}
    history = (db.query(models.ApprovalAction)
               .filter_by(entity_type="QA_REQUEST", entity_id=req.id)
               .order_by(models.ApprovalAction.created_at).all())
    checklist = db.query(models.ReadinessChecklistItem).filter_by(qa_request_id=req.id).all()
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
