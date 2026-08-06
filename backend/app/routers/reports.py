from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user, dashboard_department_scope, resolve_entity_department
from ..constants import SUPPRESSION_TERMINAL_STATUSES, QAStatus, GatewayStatus, Role

router = APIRouter(prefix="/api/reports", tags=["reports"])


_GATEWAY_PRIVATE_STATUSES = (GatewayStatus.DRAFT, GatewayStatus.CANCELLED)


def _visible_qa_requests(db: Session, current_user: models.User):
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
        q = q.filter(models.QARequest.department == scope)
    return q


# ---------------- 4.10.1 Operational Reports ----------------
@router.get("/qa-request-summary")
def qa_request_summary(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """One row per QA Request (the intake gateway -- see constants.GatewayStatus
    for its own Draft/Submitted/Raised/Cancelled status). "QA Testing Status"
    additionally surfaces the linked Functional Testing Request's own Draft ->
    ... -> Closed status, if one was raised alongside it."""
    rows = _visible_qa_requests(db, current_user).all()
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
            "Application Name": r.application_name, "Epic Number": r.epic_number,
            "Request Type(s)": r.request_types, "Priority / Risk (per type)": classification or None,
            "Status": r.status,
            "QA Testing Request ID": functional.request_id if functional else None,
            "QA Testing Status": functional.status if functional else None,
        })
    return out


# ---------------- 4.10.2 Security Reports ----------------
@router.get("/sast-scan")
def sast_scan_report(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # department is a delegated property (models.SASTRequest.department reads
    # through .qa_request), not a real column, so scoping needs a join same
    # as list_sast in routers/sast_dast.py -- standalone SAST requests (no
    # qa_request_id) are excluded by this inner join for a scoped user, same
    # as they already resolve to department=None today.
    q = db.query(models.SASTRequest)
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.join(models.QARequest, models.SASTRequest.qa_request_id == models.QARequest.id) \
             .filter(models.QARequest.department == scope)
    rows = q.all()
    return [{
        "Request ID": r.request_id, "Application": r.application_name, "Build": r.build_number,
        "Status": r.status, "Findings": len(r.findings),
    } for r in rows]


@router.get("/dast-scan")
def dast_scan_report(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # See sast_scan_report's matching comment just above -- identical reasoning.
    q = db.query(models.DASTRequest)
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.join(models.QARequest, models.DASTRequest.qa_request_id == models.QARequest.id) \
             .filter(models.QARequest.department == scope)
    rows = q.all()
    return [{
        "Request ID": r.request_id, "Application URL": r.application_url, "Environment": r.environment,
        "Status": r.status, "Findings": len(r.findings),
    } for r in rows]


@router.get("/vulnerability-trend")
def vulnerability_trend(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # SASTFinding/DASTFinding have no department of their own -- scope via
    # their parent SAST/DAST request's own department, same join pattern as
    # sast_scan_report/dast_scan_report above.
    sast_q = db.query(models.SASTFinding)
    dast_q = db.query(models.DASTFinding)
    scope = dashboard_department_scope(current_user)
    if scope:
        sast_q = sast_q.join(models.SASTRequest, models.SASTFinding.sast_request_id == models.SASTRequest.id) \
                        .join(models.QARequest, models.SASTRequest.qa_request_id == models.QARequest.id) \
                        .filter(models.QARequest.department == scope)
        dast_q = dast_q.join(models.DASTRequest, models.DASTFinding.dast_request_id == models.DASTRequest.id) \
                        .join(models.QARequest, models.DASTRequest.qa_request_id == models.QARequest.id) \
                        .filter(models.QARequest.department == scope)
    findings = sast_q.all() + dast_q.all()
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
    # SuppressionRequest.department is a real column, so a direct .filter()
    # is enough, same as list_suppressions in routers/suppression.py.
    q = db.query(models.SuppressionRequest)
    scope = dashboard_department_scope(current_user)
    if scope:
        q = q.filter(models.SuppressionRequest.department == scope)
    rows = q.all()
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
    total_requests = _visible_qa_requests(db, current_user).count()
    scope = dashboard_department_scope(current_user)
    # "Completed" is measured on the linked Functional Testing Request (the
    # QA Request gateway's own status is just Draft/Submitted/Raised/Cancelled
    # -- see constants.GatewayStatus). department is a delegated property
    # here (reads through .qa_request), so scoping needs a join, same as
    # list_functional in routers/functional.py.
    completed_q = db.query(models.FunctionalRequest).filter(models.FunctionalRequest.status == QAStatus.CLOSED)
    if scope:
        completed_q = completed_q.join(
            models.QARequest, models.FunctionalRequest.qa_request_id == models.QARequest.id
        ).filter(models.QARequest.department == scope)
    open_suppressions_q = db.query(models.SuppressionRequest).filter(
        models.SuppressionRequest.status.notin_(SUPPRESSION_TERMINAL_STATUSES))
    if scope:
        # SuppressionRequest.department is a real column -- direct filter.
        open_suppressions_q = open_suppressions_q.filter(models.SuppressionRequest.department == scope)
    return [{
        "Total QA Requests": total_requests, "Completed Requests": completed_q.count(),
        "Open Suppressions": open_suppressions_q.count(),
    }]


@router.get("/application-quality-scorecard")
def quality_scorecard(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # apps is already confined to the caller's department via
    # _visible_qa_requests' own scoping above -- the per-app SAST count below
    # is additionally scoped too (rather than relying on "same app name
    # implies same department"), since a standalone SAST request raised
    # directly (no linked QA Request) could otherwise share an application
    # name across departments and leak another department's scan count.
    visible = _visible_qa_requests(db, current_user).all()
    apps = {r.application_name for r in visible if r.application_name}
    scope = dashboard_department_scope(current_user)
    out = []
    for app in apps:
        reqs = [r for r in visible if r.application_name == app]
        completed = 0
        for r in reqs:
            functional = next(iter(r.linked_functional_requests), None)
            if functional and functional.status == QAStatus.CLOSED:
                completed += 1
        sast_q = db.query(models.SASTRequest).filter(models.SASTRequest.application_name == app)
        if scope:
            sast_q = sast_q.join(
                models.QARequest, models.SASTRequest.qa_request_id == models.QARequest.id
            ).filter(models.QARequest.department == scope)
        out.append({
            "Application": app, "QA Requests": len(reqs),
            "Completed": completed,
            "SAST Requests": sast_q.count(),
        })
    return out


@router.get("/audit-evidence")
def audit_evidence(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Same cross-entity feed as list_approvals (routers/approvals.py) -- uses
    # the same shared resolve_entity_department helper (deps.py) so this
    # export can't surface another department's approval/audit history
    # either (reported directly: "Report & Export Centre ... other
    # department data can not be shown").
    rows = db.query(models.ApprovalAction).order_by(models.ApprovalAction.created_at.desc()).limit(1000).all()
    scope = dashboard_department_scope(current_user)
    if scope:
        rows = [r for r in rows if resolve_entity_department(db, r.entity_type, r.entity_id) == scope]
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
