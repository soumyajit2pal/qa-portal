from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..constants import SUPPRESSION_TERMINAL_STATUSES

router = APIRouter(prefix="/api/reports", tags=["reports"])


# ---------------- 4.10.1 Operational Reports ----------------
@router.get("/qa-request-summary")
def qa_request_summary(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = db.query(models.QARequest).all()
    return [{
        "Request ID": r.request_id, "Request Date": r.request_date, "Department": r.department,
        "Application Name": r.application_name, "Project Name": r.project_name,
        "Request Type(s)": r.request_types, "Priority": r.priority, "Risk Rating": r.risk_rating,
        "Status": r.status,
    } for r in rows]


# Test Case Repository / Test Execution Management (Modules 2 & 3) are
# temporarily DISABLED -- the portal is currently focused on the QA Request
# module only, so the reports below (which all read TestCase/TestRun/
# TestRunCase directly) have been taken out of REPORT_REGISTRY and the
# Reports & Export Centre listing (see constants.js REPORTS). The functions
# are left in place, commented out, so they can be re-enabled together with
# those modules later.
#
# @router.get("/project-testing-status")
# def project_testing_status(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
#     rows = db.query(models.TestRun).all()
#     out = []
#     for r in rows:
#         cases = r.cases
#         executed = len([c for c in cases if c.execution_status != "Not Started"])
#         passed = len([c for c in cases if c.execution_status in ("Passed", "Retest Passed")])
#         out.append({
#             "Test Run ID": r.test_run_id, "Project": r.project, "Application": r.application,
#             "Release": r.release, "Status": r.status, "Total Cases": len(cases),
#             "Executed": executed, "Pass %": round(passed / executed * 100, 2) if executed else 0,
#         })
#     return out
#
#
# @router.get("/test-case-execution")
# def test_case_execution(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
#     rows = db.query(models.TestRunCase).all()
#     return [{
#         "Test Run ID": rc.test_run.test_run_id if rc.test_run else None,
#         "Test Case ID": rc.test_case.test_case_id if rc.test_case else None,
#         "Scenario": rc.test_case.test_scenario if rc.test_case else None,
#         "Execution Status": rc.execution_status, "Actual Result": rc.actual_result,
#         "Defect ID": rc.defect_id, "Executed At": rc.executed_at,
#     } for rc in rows]
#
#
# @router.get("/requirement-traceability-matrix")
# def rtm(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
#     rows = db.query(models.TestCase).filter(models.TestCase.is_archived == False).all()  # noqa: E712
#     return [{
#         "Epic ID": tc.epic_id, "Feature ID": tc.feature_id, "User Story ID": tc.user_story_id,
#         "Test Case ID": tc.test_case_id, "Test Scenario": tc.test_scenario, "Status": tc.status,
#         "Defect ID": tc.defect_id,
#     } for tc in rows]
#
#
# @router.get("/defect-summary")
# def defect_summary(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
#     rows = db.query(models.TestRunCase).filter(models.TestRunCase.defect_id.isnot(None)).all()
#     return [{
#         "Defect ID": rc.defect_id, "Test Case ID": rc.test_case.test_case_id if rc.test_case else None,
#         "Test Run ID": rc.test_run.test_run_id if rc.test_run else None,
#         "Status": rc.execution_status, "Logged At": rc.executed_at,
#     } for rc in rows]


# ---------------- 4.10.2 Security Reports ----------------
@router.get("/sast-scan")
def sast_scan_report(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = db.query(models.SASTRequest).all()
    return [{
        "Request ID": r.request_id, "Application": r.application_name, "Build": r.build_number,
        "Status": r.status, "Findings": len(r.findings),
    } for r in rows]


@router.get("/dast-scan")
def dast_scan_report(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = db.query(models.DASTRequest).all()
    return [{
        "Request ID": r.request_id, "Application URL": r.application_url, "Environment": r.environment,
        "Status": r.status, "Findings": len(r.findings),
    } for r in rows]


@router.get("/vulnerability-trend")
def vulnerability_trend(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    findings = db.query(models.SASTFinding).all() + db.query(models.DASTFinding).all()
    from collections import Counter
    return dict(Counter(f.severity for f in findings))


@router.get("/severity-distribution")
def severity_distribution(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return vulnerability_trend(db=db, current_user=current_user)


@router.get("/suppression-register")
def suppression_register(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # One suppression request can now cover several findings (see
    # models.SuppressionItem) -- the register lists one row per finding,
    # same pattern as test-case-execution/defect-summary used to.
    rows = db.query(models.SuppressionRequest).all()
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
@router.get("/monthly-qa-kpi")
def monthly_kpi(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    total_requests = db.query(models.QARequest).count()
    completed = db.query(models.QARequest).filter(models.QARequest.status == "Completed").count()
    # "Test Cases Executed" / "Pass %" (TestRunCase-based) removed along with
    # Modules 2 & 3 -- portal is currently focused on the QA Request module only.
    return [{
        "Total QA Requests": total_requests, "Completed Requests": completed,
        "Open Suppressions": db.query(models.SuppressionRequest).filter(
            models.SuppressionRequest.status.notin_(SUPPRESSION_TERMINAL_STATUSES)).count(),
    }]


@router.get("/application-quality-scorecard")
def quality_scorecard(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    apps = {r.application_name for r in db.query(models.QARequest).all() if r.application_name}
    out = []
    for app in apps:
        reqs = db.query(models.QARequest).filter(models.QARequest.application_name == app).all()
        sast = db.query(models.SASTRequest).filter(models.SASTRequest.application_name == app).count()
        dast_count = db.query(models.DASTRequest).count()
        out.append({
            "Application": app, "QA Requests": len(reqs),
            "Completed": len([r for r in reqs if r.status == "Completed"]),
            "SAST Requests": sast,
        })
    return out


# Resource Utilization Report is TestRunCase-based (Module 3, disabled) --
# see note above test-case-execution/etc. Commented out for the same reason.
#
# @router.get("/resource-utilization")
# def resource_utilization(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
#     from collections import Counter
#     run_cases = db.query(models.TestRunCase).filter(models.TestRunCase.executed_by_id.isnot(None)).all()
#     counts = Counter(c.executed_by_id for c in run_cases)
#     out = []
#     for uid, cnt in counts.items():
#         u = db.query(models.User).get(uid)
#         out.append({"QA Engineer": u.full_name if u else uid, "Cases Executed": cnt})
#     return out


@router.get("/audit-evidence")
def audit_evidence(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = db.query(models.ApprovalAction).order_by(models.ApprovalAction.created_at.desc()).limit(1000).all()
    out = []
    for a in rows:
        u = db.query(models.User).get(a.actor_id) if a.actor_id else None
        out.append({
            "Entity Type": a.entity_type, "Entity ID": a.entity_id, "Step": a.step_name,
            "Decision": a.decision, "Actor": u.full_name if u else None, "Role": a.actor_role,
            "Comments": a.comments, "Timestamp": a.created_at,
        })
    return out


REPORT_REGISTRY = {
    "qa-request-summary": qa_request_summary,
    # "project-testing-status", "test-case-execution", "requirement-traceability-matrix",
    # "defect-summary" and "resource-utilization" are disabled along with Test Case
    # Repository / Test Execution Management (Modules 2 & 3) -- see the commented-out
    # functions above. Re-add here when those modules are re-enabled.
    "sast-scan": sast_scan_report,
    "dast-scan": dast_scan_report,
    "vulnerability-trend": vulnerability_trend,
    "severity-distribution": severity_distribution,
    "suppression-register": suppression_register,
    "monthly-qa-kpi": monthly_kpi,
    "application-quality-scorecard": quality_scorecard,
    "audit-evidence": audit_evidence,
}
