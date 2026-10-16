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


def _require_reference_context(defect, execution, payload, user, db):
    if set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS}:
        raise HTTPException(403, "Read-only users cannot add historical references")
    if payload.expected_revision is not None and defect.workflow_revision != payload.expected_revision:
        raise HTTPException(409, "Defect changed. Refresh before adding a historical link.")
    if defect.status != "Closed":
        raise HTTPException(400, "Historical linking is available only for Closed defects. Use active linking for a current issue.")
    require_amendment_access(execution.cycle, user)
    application = execution_application(db, execution)
    if not application or application.casefold() != defect.application_name.casefold():
        raise HTTPException(400, "Historical execution must have a matching application through its project or linked QA request")


def _audit_link(db, defect, execution, user, target, reason):
    details = (f"Linked Closed defect {defect.defect_key} (closure revision {defect.workflow_revision}) "
        f"to {execution.cycle.cycle_key} / {execution.test_case.test_case_key} / execution #{execution.id}. "
        f"{target}. Notes: {reason or 'Linked as a closed-defect reference'}. "
        "Defect closure, ownership, execution results, approvals and verification remain unchanged.")
    for entity, identifier, state in (("DEFECT", defect.id, defect.status),
                                      ("TEST_CASE", execution.test_case_id, execution.test_case.status),
                                      ("TEST_CYCLE", execution.cycle_id, execution.cycle.status)):
        db.add(models.ApprovalAction(entity_type=entity, entity_id=identifier, step_name="Historical defect traceability",
            actor_id=user.id, actor_role=user.roles_csv, decision="Historical Defect Linked", comments=details,
            previous_state=state, new_state=state))


def append_execution_reference(db, defect, execution, payload, user):
    """One-click traceability; no attempt is invented and no verification is granted."""
    _require_reference_context(defect, execution, payload, user, db)
    if (defect.execution_id == execution.id
        or any(link.execution_id == execution.id for link in defect.execution_links)
        or any(link.execution_id == execution.id for link in defect.historical_execution_links)
        or db.query(models.DefectExecutionReference.id).filter_by(defect_id=defect.id, execution_id=execution.id).first()
        or db.query(models.TestRunDefect.id).join(models.TestExecutionRun).filter(
            models.TestExecutionRun.execution_id == execution.id,
            models.TestRunDefect.defect_key == defect.defect_key).first()):
        raise HTTPException(409, "This defect is already linked to the selected execution")
    # An unambiguous old failure is useful context, not a claim that it found
    # this defect. Multiple/undated/later failures retain an execution-only link.
    runs = db.query(models.TestExecutionRun).filter_by(execution_id=execution.id).all()
    eligible = [run for run in runs if run.status in {'Fail', 'Blocked'} and defect.closed_at
                and run.executed_at and models.as_aware(run.executed_at) <= models.as_aware(defect.closed_at)]
    run = eligible[0] if len(eligible) == 1 else None
    link = models.DefectExecutionReference(defect_id=defect.id, execution=execution, run=run,
        defect_key=defect.defect_key, title=defect.title, defect_status='Closed', closed_at=defect.closed_at,
        linked_workflow_revision=defect.workflow_revision, linked_by_id=user.id, notes=payload.reason)
    db.add(link)
    target = (f"Execution reference; earlier attempt #{run.attempt_no} retained as context only" if run
              else "Execution reference only; no original attempt asserted")
    _audit_link(db, defect, execution, user, target, payload.reason)
    db.flush()
    return link


def append_link(db, defect, execution, payload, user):
    """Compatibility for explicit links from an existing attempt-history entry."""
    _require_reference_context(defect, execution, payload, user, db)
    if db.query(models.DefectExecutionReference.id).filter_by(defect_id=defect.id, execution_id=execution.id).first():
        raise HTTPException(409, "This defect is already linked to the selected execution")
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
    _audit_link(db, defect, execution, user, f"Historical attempt #{run.attempt_no} ({run.status})", payload.reason)
    db.flush()
    return link


def add_reference_export_sheet(workbook, references):
    """Use the same closure snapshot/provenance in defect and cycle exports."""
    if not references:
        return
    from .xlsx_export import add_table_sheet
    add_table_sheet(workbook, 'Closed Defect References', 'Closed Defect Execution References', [
        'Defect ID', 'Title', 'Test Cycle', 'Test Case', 'Execution ID',
        'Status at Link', 'Closed At', 'Linked By', 'Linked At', 'Closure Revision', 'Notes',
    ], [[ref.defect_key, ref.title, ref.cycle_key, ref.test_case_key, ref.execution_id,
         ref.defect_status, ref.closed_at, ref.linked_by_name, ref.created_at,
         ref.linked_workflow_revision, ref.notes] for ref in references],
        subtitle='Traceability only; these links are not proof of execution or verification.',
        wrap_headers={'Title', 'Notes'}, date_headers={'Closed At', 'Linked At'})
