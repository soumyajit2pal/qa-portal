from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..constants import SUPPRESSION_TERMINAL_STATUSES, QAStatus

router = APIRouter(prefix="/api/reports", tags=["reports"])


# ---------------- 4.10.1 Operational Reports ----------------
@router.get("/qa-request-summary")
def qa_request_summary(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """One row per QA Request (the intake gateway -- see constants.GatewayStatus
    for its own Draft/Submitted/Raised/Cancelled status). "QA Testing Status"
    additionally surfaces the linked Functional Testing Request's own Draft ->
    ... -> Closed status, if one was raised alongside it."""
    rows = db.query(models.QARequest).all()
    out = []
    for r in rows:
        functional = next(iter(r.linked_functional_requests), None)
        sast = next(iter(r.linked_sast_requests), None)
        dast = next(iter(r.linked_dast_requests), None)
        automation = next(iter(r.linked_automation_requests), None)
        performance = next(iter(r.linked_performance_requests), None)
        # Priority/Risk are per-request-type now (see models.FunctionalRequest
        # for the full reasoning), not a single shared gateway value -- so
        # this report lists "Type: Priority/Risk" for every type actually
        # linked to this QA Request instead of one flat column.
        classification = "; ".join(
            f"{label}: {req.priority or '—'}/{(getattr(req, 'risk_rating', None) or getattr(req, 'risk_category', None)) or '—'}"
            for label, req in (
                ("Functional", functional), ("SAST", sast), ("DAST", dast),
                ("Automation", automation), ("Performance", performance),
            ) if req is not None
        )
        out.append({
            "Request ID": r.request_id, "Request Date": r.request_date, "Department": r.department,
            "Application Name": r.application_name, "Project Name": r.project_name,
            "Request Type(s)": r.request_types, "Priority / Risk (per type)": classification or None,
            "Status": r.status,
            "QA Testing Request ID": functional.request_id if functional else None,
            "QA Testing Status": functional.status if functional else None,
        })
    return out


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
    # "Completed" is measured on the linked Functional Testing Request (the
    # QA Request gateway's own status is just Draft/Submitted/Raised/Cancelled
    # -- see constants.GatewayStatus).
    completed = db.query(models.FunctionalRequest).filter(models.FunctionalRequest.status == QAStatus.CLOSED).count()
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
        completed = 0
        for r in reqs:
            functional = next(iter(r.linked_functional_requests), None)
            if functional and functional.status == QAStatus.CLOSED:
                completed += 1
        sast = db.query(models.SASTRequest).filter(models.SASTRequest.application_name == app).count()
        out.append({
            "Application": app, "QA Requests": len(reqs),
            "Completed": completed,
            "SAST Requests": sast,
        })
    return out


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
    "sast-scan": sast_scan_report,
    "dast-scan": dast_scan_report,
    "vulnerability-trend": vulnerability_trend,
    "severity-distribution": severity_distribution,
    "suppression-register": suppression_register,
    "monthly-qa-kpi": monthly_kpi,
    "application-quality-scorecard": quality_scorecard,
    "audit-evidence": audit_evidence,
}
