"""Retest observations, scoped verification and final confirmation in one service."""
import json
import os
from fastapi import HTTPException
from sqlalchemy import or_, func
from . import models, schemas, documents
from .defect_workflow import environment_for, verified_for
from .defect_assignment import current_defect_responsibility


def _iteration(defect):
    return defect.workflow_state.get('iteration', 0) if defect.modern_workflow else defect.reopen_count or 0


def outcome_key(outcome):
    return ('internal', outcome.defect_id) if outcome.defect_id else ('external', outcome.external_link_id)


def effective_outcomes(db, obj):
    """Untouched findings retain their last observation; a later result wins."""
    rows = db.query(models.TestRetestOutcome).join(models.TestRetest,
        models.TestRetestOutcome.run_id == models.TestRetest.run_id).join(models.TestExecutionRun,
        models.TestRetest.run_id == models.TestExecutionRun.id).filter(
        models.TestExecutionRun.execution_id == obj.id).order_by(
        models.TestExecutionRun.attempt_no.desc(), models.TestRetestOutcome.id.desc()).all()
    result = {}
    for row in rows:
        result.setdefault(outcome_key(row), row)
    return result


def current_context(outcome, obj):
    return (outcome.retest.environment == obj.cycle.environment
            and outcome.retest.pinned_version_id == obj.pinned_version_id
            and (not outcome.defect or outcome.fix_iteration == _iteration(outcome.defect)))


def approved_disposition(defect):
    from .routers import test_execution as execution
    return (defect.status in execution._DEFECT_UNCONDITIONAL_CLEAR_STATUSES
            or (defect.status == 'Closed' and defect.resolution_type == 'Accepted Risk'))


def final_outcomes(db, obj, governed, external):
    """Resolve current proof across partial attempts without copying old evidence."""
    observed = effective_outcomes(db, obj)
    required = [('internal', defect.id, defect.defect_key) for defect in governed if not approved_disposition(defect)]
    required += [('external', link.id, link.defect_key) for link in external]
    selected = []
    for kind, identifier, key in required:
        row = observed.get((kind, identifier))
        if not row or not current_context(row, obj) or not outcome_verified(row):
            raise HTTPException(400, f'{key}: Passed evidence and current verification are required')
        _require_evidence([row], documents.list_documents(db, execution_image_module(), row.run_id))
        selected.append(row)
    return selected


def execution_image_module():
    from .routers import test_execution as execution
    return execution._RESULT_IMAGE_MODULE


def _require_evidence(outcomes, documents_for_run):
    available={doc.id for doc in documents_for_run}
    for outcome in outcomes:
        if any(item['id'] not in available for item in outcome.evidence_documents):
            raise HTTPException(400,'Attached retest evidence was removed; record a fresh retest with valid evidence')


def outcome_verified(outcome):
    from .routers import test_execution as execution
    if outcome.outcome != 'Passed':
        return False
    if outcome.external_link:
        return (outcome.external_link.defect_status or 'Open').upper() in {'RESOLVED','CLOSED'}
    defect = outcome.defect
    if not defect or _iteration(defect) != outcome.fix_iteration:
        return False
    context = outcome.retest
    if execution._defect_blocks_execution(defect, context.run.execution.cycle, execution_id=context.run.execution_id):
        return False
    events = defect.workflow_state.get('history' if defect.modern_workflow else 'execution_verifications', [])
    matching = [event for event in events if event.get('retest_outcome_id') == outcome.id]
    if matching:
        return matching[-1].get('result') == 'Passed'
    # An existing valid verification can be reused only if the defect has not
    # changed since this fresh observed pass. A later confirmation needs an
    # explicit receipt linked to this attempt.
    return defect.workflow_revision == outcome.defect_revision


def _context(db, execution_id, user, *, require_runner=True):
    from .constants import Role
    if set(user.roles) & {Role.VIEW_ONLY,Role.SCALE_6_PLUS}:
        raise HTTPException(403,'Read-only users cannot record or verify retests')
    from .routers import test_execution as execution
    obj = execution._execution_or_404(db, execution_id, lock=True)
    execution._prepare_execution_activity(db, obj, user, require_runner=require_runner)
    return obj


def _reviewer(db, defect, user):
    from .routers import defects
    from .constants import Role
    if set(user.roles) & {Role.VIEW_ONLY,Role.SCALE_6_PLUS}:
        raise HTTPException(403,'Read-only users cannot verify retests')
    owner = current_defect_responsibility(defect)
    qa_owner = defect.workflow_state.get('qa_owner_id') or defect.retest_tester_id
    if not (defects._is_manager(db, defect, user) or (owner.kind == 'qa' and owner.owner_id == user.id) or qa_owner == user.id):
        raise HTTPException(403, f'{defect.defect_key}: the assigned QA reviewer must verify this fix')
    if user.id == defect.assignee_id:
        raise HTTPException(403, 'The resolver cannot independently verify their own fix')


def _act(db, defect, user, status, reference, build, notes=None, context=None):
    from .routers import defects
    if defect.modern_workflow:
        from .routers.defect_workflow_actions import apply_action
        return apply_action(db, defect, schemas.DefectWorkflowAction(revision=defect.workflow_revision,
            status=status, build=build, reference=reference, remarks=notes,
            verification_confirmed=status != 'Reopened'), user, commit=False, verification_context=context,
            allow_failure_observation=status=='Reopened' and bool(context and context.get('run_id')))
    return defects._transition_defect(defect.id, schemas.DefectTransition(revision=defect.workflow_revision,
        status=status, reference=(reference or '')[:500] or None, remarks=notes, reopen_reason=notes,
        tested_build_version=build, actual_result=notes, retest_remarks=reference,
        verification_confirmed=status == 'Closed'), db, user, commit=False)


def _receipt(db, defect, obj, retest, outcome, user):
    """Record QA coverage without changing a defect's lifecycle or owners."""
    from .routers import defects
    state = defect.workflow_state
    event = dict(kind='verification', stage='Execution retest', result='Passed',
        execution_id=obj.id, run_id=retest.run_id, retest_outcome_id=outcome.id,
        pinned_version_id=obj.pinned_version_id, iteration=_iteration(defect),
        environment=retest.environment, build=retest.tested_build,
        reference=outcome.evidence_reference, evidence_documents=outcome.evidence_documents,
        at=models.now().isoformat(), user_id=user.id, user_name=user.full_name,
        verification_confirmed=True, confirmation_revision=defect.workflow_revision)
    state.setdefault('history' if defect.modern_workflow else 'execution_verifications', []).append(event)
    defect.workflow_state_json=json.dumps(state)
    defect.workflow_revision += 1
    outcome.defect_revision = defect.workflow_revision
    defects._audit(db, defect, user, 'Retest Verified',
        f'Passed execution #{obj.id}, attempt #{retest.run.attempt_no} in {retest.environment}. Defect status remains {defect.status}.',
        step_name='Traceability')


def record(db, execution_id, payload, user, files=()):
    from .routers import test_execution as execution, defects
    obj = _context(db, execution_id, user)
    if obj.run_version != payload.expected_run_version:
        raise HTTPException(409, 'Execution changed. Refresh before saving the result.')
    _, prior, _ = execution._execution_lock_state(db, obj.id)
    if not prior:
        raise HTTPException(400, 'A retest requires an earlier Failed or Blocked attempt')
    if not payload.actual_result.strip() or not payload.tested_build.strip():
        raise HTTPException(400, 'Actual result and tested build are required')
    execution._validate_result_evidence(list(files))
    governed = {d.id:d for d in db.query(models.Defect).filter(models.Defect.record_type == 'Defect').filter(or_(
        models.Defect.execution_id == obj.id,
        models.Defect.execution_links.any(models.DefectExecutionLink.execution_id == obj.id)
    )).order_by(models.Defect.id).with_for_update().populate_existing().all()}
    external = {link.id:link for link in db.query(models.TestRunDefect).join(models.TestExecutionRun).filter(
        models.TestExecutionRun.execution_id == obj.id, models.TestRunDefect.is_historical == False,
        or_(models.TestRunDefect.defect_url.is_(None), ~models.TestRunDefect.defect_url.startswith('/defects'))).all()}
    seen, selected = set(), []
    for item in payload.outcomes:
        if bool(item.defect_id) == bool(item.external_link_id):
            raise HTTPException(400, 'Select exactly one internal or external finding per outcome')
        key = ('internal', item.defect_id) if item.defect_id else ('external', item.external_link_id)
        if key in seen:
            raise HTTPException(409, 'A finding outcome was supplied twice')
        seen.add(key)
        defect = governed.get(item.defect_id) if item.defect_id else None
        link = external.get(item.external_link_id) if item.external_link_id else None
        if not defect and not link:
            raise HTTPException(404, 'The selected finding is not actively linked to this execution')
        if defect:
            defects._get_mutable(defect.id, db, user)
            if item.expected_defect_revision != defect.workflow_revision:
                raise HTTPException(409, f'{defect.defect_key} changed. Refresh the result form.')
        selected.append((item, defect, link))
    if payload.observed_result == 'Passed' and any(item.outcome in {'Failed', 'Blocked'} for item, _, _ in selected):
        raise HTTPException(400, 'A passing testcase result cannot contain a Failed or Blocked finding')
    status = {'Passed':'Retest Passed', 'Failed':'Fail', 'Blocked':'Blocked', 'NA':'NA'}[payload.observed_result]
    run = execution._record_attempt(db, obj, status, payload.actual_result.strip(),
        (payload.evidence_reference or '').strip()[:255] or None, None, user, capture_context=False)
    retest = models.TestRetest(run=run, observed_result=payload.observed_result,
        environment=obj.cycle.environment, tested_build=payload.tested_build.strip(),
        pinned_version_id=obj.pinned_version_id, final_run_id=run.id)
    db.add(retest); db.flush()
    created = []
    try:
        if files:
            created = documents.save_documents(db, execution._RESULT_IMAGE_MODULE, run.id,
                f'execution-{obj.id}-attempt-{run.attempt_no}', list(files), user.id, commit=False)
        snapshot = [{'id':doc.id, 'file_name':doc.file_name, 'module':doc.module, 'request_id':run.id} for doc in created]
        for item, defect, link in selected:
            reference = (item.evidence_reference or payload.evidence_reference or '').strip() or (
                f'Execution #{obj.id}, attempt #{run.attempt_no} evidence' if snapshot else None)
            outcome = models.TestRetestOutcome(retest=retest, defect_id=defect.id if defect else None,
                external_link_id=link.id if link else None, defect_key=defect.defect_key if defect else link.defect_key,
                defect_status=defect.status if defect else link.defect_status, outcome=item.outcome,
                notes=(item.notes or '').strip() or None, evidence_reference=reference,
                evidence_documents_json=json.dumps(snapshot), defect_revision=defect.workflow_revision if defect else None,
                fix_iteration=_iteration(defect) if defect else None)
            db.add(outcome); db.flush()
            if defect:
                defects._audit(db, defect, user, 'Retest Observed',
                    f'Execution #{obj.id}, attempt #{run.attempt_no}: {item.outcome} in {retest.environment}. '
                    f'Defect status retained as {defect.status}. Evidence: {reference or "Not supplied"}.', step_name='Traceability')
                if item.outcome == 'Passed' and (reference or snapshot) and defect.status in {
                        'Ready for QA', 'QA Testing', 'Resolved', 'Retest', 'Business Acceptance', 'Ready for Release', 'Production Verification', 'Closed'}:
                    try:
                        _reviewer(db, defect, user)
                    except HTTPException:
                        pass
                    else:
                        _receipt(db, defect, obj, retest, outcome, user)
        db.commit()
    except Exception:
        db.rollback()
        for doc in created:
            try:
                if db.query(models.RequestDocument.id).filter_by(stored_path=doc.stored_path).first() is None:
                    os.remove(documents.full_path(doc))
            except Exception:
                pass
        raise
    db.refresh(obj)
    return obj


def verify(db,execution_id,run_id,outcome_id,payload,user):
    from .routers import test_execution as execution, defects
    obj=_context(db,execution_id,user,require_runner=False)
    run=execution._run_or_404(db,obj,run_id)
    if not run.retest: raise HTTPException(409,'This attempt has no retained retest evidence')
    latest=execution._latest_run_or_404(db,obj)
    if latest.id != run.id:
        raise HTTPException(409,'Review the latest saved result instead')
    retest=run.retest
    if retest.environment!=obj.cycle.environment or retest.pinned_version_id!=obj.pinned_version_id:
        raise HTTPException(409,'Execution context changed; record a fresh retest')
    outcome=db.query(models.TestRetestOutcome).filter_by(id=outcome_id,run_id=run.id).one_or_none()
    if not outcome or not outcome.defect or outcome.outcome!='Passed': raise HTTPException(400,'Select an internal Passed observation')
    current=effective_outcomes(db,obj).get(outcome_key(outcome))
    if not current or current.id != outcome.id:
        raise HTTPException(409,'A newer outcome exists for this defect; verify its evidence instead')
    _require_evidence([outcome],documents.list_documents(db,execution._RESULT_IMAGE_MODULE,run.id))
    defect=defects._get_mutable(outcome.defect_id,db,user)
    db.query(models.Defect).filter(models.Defect.record_type == 'Defect').filter_by(id=defect.id).with_for_update().populate_existing().one()
    if defect.execution_id != obj.id and not any(link.execution_id == obj.id for link in defect.execution_links):
        raise HTTPException(409,'This defect is no longer actively linked to the execution')
    _reviewer(db,defect,user)
    if payload.expected_defect_revision!=defect.workflow_revision or outcome.fix_iteration!=_iteration(defect):
        raise HTTPException(409,'The defect or fix changed; record a fresh retest')
    if outcome_verified(outcome): raise HTTPException(409,'This observed fix is already verified')
    _receipt(db, defect, obj, retest, outcome, user)
    db.commit();db.refresh(obj)
    return obj


def finalize(db,execution_id,run_id,payload,user):
    from .routers import test_execution as execution
    obj=_context(db,execution_id,user)
    if obj.run_version!=payload.expected_run_version: raise HTTPException(409,'Execution changed. Refresh before confirming the final pass.')
    run=execution._run_or_404(db,obj,run_id);retest=run.retest
    if not retest or retest.final_run_id or execution._latest_run_or_404(db,obj).id!=run.id:
        raise HTTPException(409,'Only the latest unfinalized retest may be confirmed')
    if retest.observed_result!='Passed': raise HTTPException(400,'The observed testcase result must be Passed')
    if retest.environment!=obj.cycle.environment or retest.pinned_version_id!=obj.pinned_version_id:
        raise HTTPException(409,'Retest context changed; record a fresh attempt')
    _require_evidence(retest.outcomes,documents.list_documents(db,execution._RESULT_IMAGE_MODULE,run.id))
    governed=db.query(models.Defect).filter(models.Defect.record_type == 'Defect').filter(or_(models.Defect.execution_id==obj.id,
        models.Defect.execution_links.any(models.DefectExecutionLink.execution_id==obj.id))).order_by(models.Defect.id).with_for_update().populate_existing().all()
    external=db.query(models.TestRunDefect).join(models.TestExecutionRun).filter(
        models.TestExecutionRun.execution_id==obj.id,models.TestRunDefect.is_historical==False,
        or_(models.TestRunDefect.defect_url.is_(None),~models.TestRunDefect.defect_url.startswith('/defects'))).all()
    reused=[]  # Legacy pending attempts can finish without linked-defect locks.
    final=execution._record_attempt(db,obj,'Retest Passed',
        f'Confirmed retest attempt #{run.attempt_no}.\n{run.actual_result}',run.test_run_artifacts,None,user,capture_context=False)
    retest.final_run_id=final.id
    db.add(models.ApprovalAction(entity_type='TEST_CASE',entity_id=obj.test_case_id,step_name='Retest Confirmation',
        actor_id=user.id,actor_role=user.roles_csv,decision='Retest Confirmed',comments=f'Attempt #{run.attempt_no} confirmed as final attempt #{final.attempt_no}. Original observations and evidence retained. Outcome receipts: {", ".join(str(row.id) for row in reused)}.'))
    db.commit();db.refresh(obj)
    return obj
