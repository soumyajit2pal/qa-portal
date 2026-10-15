"""Append-only historical associations; never proof of current verification."""
from fastapi import HTTPException
from . import models
from .constants import Role, TEST_CYCLE_LOCKED_STATUSES
from .workflow_authority import workflow_context

LEAD_ROLES = (Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)


def execution_application(db, execution):
    project = execution.cycle.project
    if project.application_master:
        return project.application_master.name
    linkage = execution.cycle.child_request_link
    if linkage:
        cls = {'Functional':models.FunctionalRequest, 'SAST':models.SASTRequest,
               'DAST':models.DASTRequest, 'Performance':models.PerformanceRequest}.get(linkage.child_type)
        child = db.get(cls, linkage.child_id) if cls else None
        return child.application_name if child else None
    return None


def can_amend_cycle(cycle, user):
    workspace = cycle.origin_workspace_id or cycle.project.qa_workspace_id
    with workflow_context(user):
        return not set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS} and user.has_qa_workspace_role(*LEAD_ROLES, workspace_id=workspace, allow_admin=False)


def require_amendment_access(cycle, user):
    if (cycle.status in TEST_CYCLE_LOCKED_STATUSES or not cycle.project.is_active) and not can_amend_cycle(cycle, user):
        raise HTTPException(403, "Only a workspace QA Lead may add historical references to a locked cycle or inactive project")


def append_link(db, defect, execution, payload, user):
    if set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS}:
        raise HTTPException(403, "Read-only users cannot add historical references")
    if defect.workflow_revision != payload.expected_revision:
        raise HTTPException(409, "Defect changed. Refresh before adding a historical link.")
    if defect.status != "Closed":
        raise HTTPException(400, "Historical linking is available only for Closed defects. Use active linking for a current issue.")
    require_amendment_access(execution.cycle, user)
    application = execution_application(db, execution)
    if not application or application.casefold() != defect.application_name.casefold():
        raise HTTPException(400, "Historical execution must have a matching application through its project or linked QA request")
    run = db.query(models.TestExecutionRun).filter_by(id=payload.run_id, execution_id=execution.id).one_or_none()
    if not run:
        raise HTTPException(404, "The selected attempt does not belong to this execution")
    if run.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "Select the original Failed or Blocked attempt for historical linking")
    if defect.closed_at and run.executed_at and models.as_aware(run.executed_at) > models.as_aware(defect.closed_at):
        raise HTTPException(400, "This attempt occurred after the defect was closed. Reopen the defect or link an active defect for a recurring issue.")
    existing = next((item for item in db.new if isinstance(item, models.TestRunDefect)
                    and item.run_id == run.id and item.defect_key == defect.defect_key), None)
    if existing or db.query(models.TestRunDefect.id).filter_by(run_id=run.id, defect_key=defect.defect_key).first():
        raise HTTPException(409, "This defect is already linked to the selected attempt")
    link = models.TestRunDefect(run=run, defect_key=defect.defect_key, title=defect.title,
        defect_url=f"/defects?open={defect.defect_key}", defect_status="Closed", notes=payload.reason,
        linked_by_id=user.id, is_historical=True, governed_defect_id=defect.id,
        linked_workflow_revision=defect.workflow_revision)
    db.add(link)
    details = (f"Added Closed defect {defect.defect_key} (closure revision {defect.workflow_revision}) as a historical reference "
        f"to {execution.cycle.cycle_key} / {execution.test_case.test_case_key} / execution #{execution.id}, "
        f"attempt #{run.attempt_no} ({run.status}). Reason: {payload.reason}. "
        "Defect closure, ownership, execution results, approvals and verification remain unchanged.")
    for entity, identifier, state in (("DEFECT", defect.id, defect.status),
                                      ("TEST_CASE", execution.test_case_id, execution.test_case.status),
                                      ("TEST_CYCLE", execution.cycle_id, execution.cycle.status)):
        db.add(models.ApprovalAction(entity_type=entity, entity_id=identifier, step_name="Historical defect traceability",
            actor_id=user.id, actor_role=user.roles_csv, decision="Historical Defect Linked", comments=details,
            previous_state=state, new_state=state))
    db.flush()
    return link
