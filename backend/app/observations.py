"""Observation lifecycle and in-place, audited conversion to a governed defect."""
import json

from fastapi import HTTPException

from . import models, defect_cc
from .constants import ENVIRONMENTS, Role
from .defect_workflow import policy


def is_observation(record):
    return getattr(record, 'record_type', None) == 'Observation'


def require_defect(record):
    if is_observation(record):
        raise HTTPException(400, 'This is an observation. Use its observation workflow or Convert to Defect.')


def writable(db, record, user):
    from .workspace_service import inherited_workspace_access_mode
    if user.has_role(Role.VIEW_ONLY, Role.SCALE_6_PLUS) or inherited_workspace_access_mode(db, user, record.qa_workspace_id) == 'PARENT_VIEWER':
        raise HTTPException(403, 'This observation is read-only in your current workspace')


def qa_reviewer(user):
    return user.has_role(Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)


def locked(db, record, revision, user):
    db.query(models.Defect).filter_by(id=record.id).with_for_update().populate_existing().one()
    writable(db, record, user)
    if not is_observation(record):
        raise HTTPException(409, 'This record is already a defect. Refresh to view its current workflow.')
    if record.workflow_revision != revision:
        raise HTTPException(409, 'Observation changed. Refresh and review before retrying.')


def create(db, payload, user):
    from .routers import defects as d
    from .application_modules import save_defect_module
    from .functional_request_scope import visible_functional_requests
    d._require_create_role(user)
    request = db.get(models.QARequest, payload.qa_request_id) if payload.qa_request_id else None
    if payload.qa_request_id and request is None:
        raise HTTPException(404, 'QA Request was not found')
    functional = None
    if payload.functional_request_id:
        functional = visible_functional_requests(db, user).filter(models.FunctionalRequest.id == payload.functional_request_id).one_or_none()
        if not functional or not functional.qa_request:
            raise HTTPException(404, 'Functional Request was not found in your scope')
        if request and functional.qa_request_id != request.id:
            raise HTTPException(400, 'Functional Request belongs to a different QA Request')
        request = functional.qa_request
    if request:
        d._require_request_access(db, request, user)
    execution = cycle = case = None
    if payload.execution_id:
        execution, cycle, case = d._execution_context(db, payload.execution_id, request, historical=True)
        d._require_execution_link_access(db, cycle, user)
        from .routers.test_execution import _require_cycle_visibility
        _require_cycle_visibility(db, cycle, user)
    workspace_id, department, application = d._creation_context(db, user, payload, request, cycle)
    if payload.environment and payload.environment not in ENVIRONMENTS:
        raise HTTPException(400, 'Select a valid environment')
    key = models.gen_observation_id(db)
    obj = models.Defect(record_type='Observation', observation_key=key, defect_key=key,
        title=d._required(payload.title, 'Title'), description=d._required(payload.description, 'Observation details'),
        observation_category=payload.observation_category, qa_request_id=request.id if request else None,
        qa_workspace_id=workspace_id, department=department, application_name=application,
        module_name=save_defect_module(db, workspace_id=workspace_id, application_name=application,
            name=payload.module_name if 'module_name' in payload.model_fields_set else request.module_name if request else None),
        module_feature=payload.module_feature or 'General', environment=payload.environment or (cycle.environment if cycle else None) or 'Not specified',
        # These legacy non-null columns belong to the defect form; observations
        # have no severity or reproduction requirement and never enter its KPIs.
        severity='Not applicable', priority='Not applicable', steps_to_reproduce='Not applicable',
        expected_result='Not applicable', actual_result='Not applicable', reporter_id=user.id,
        related_cr_number=payload.related_cr_number, status='New',
        execution_id=execution.id if execution else None, cycle_id=cycle.id if cycle else None,
        primary_test_case_id=case.id if case else None, build_version=cycle.build if cycle else None,
        workflow_state_json=json.dumps({'observation_history': []}))
    writable(db, obj, user)
    defect_cc.replace(db, obj, payload.cc_user_ids, user)
    db.add(obj); db.flush()
    if case:
        d._ensure_case_link(db, obj.id, case.id)
    if functional:
        db.add(models.DefectFunctionalRequestLink(defect_id=obj.id, functional_request_id=functional.id,
            linked_by_id=user.id, linked_workflow_revision=0, reason='Linked when observation was recorded'))
    d._audit(db, obj, user, 'Observation Created', f'Recorded {key}: {payload.observation_category}.', new_state='New', step_name='Observation')
    db.commit(); db.refresh(obj)
    return obj


def update(db, obj, payload, user):
    from .routers import defects as d
    locked(db, obj, payload.revision, user)
    if obj.status == 'Closed':
        raise HTTPException(400, 'Reopen this observation before editing it')
    if obj.reporter_id != user.id and not qa_reviewer(user):
        raise HTTPException(403, 'Only the reporter or QA can edit this observation')
    changes = []
    for field in ('title', 'description', 'observation_category'):
        value = d._required(getattr(payload, field), field.replace('_', ' ').title())
        if getattr(obj, field) != value:
            setattr(obj, field, value); changes.append(field)
    if changes:
        obj.workflow_revision += 1
        d._audit(db, obj, user, 'Observation Updated', 'Updated ' + ', '.join(changes), step_name='Observation')
    db.commit(); db.refresh(obj)
    return obj


def action(db, obj, payload, user):
    from .routers import defects as d
    locked(db, obj, payload.revision, user)
    if not qa_reviewer(user):
        raise HTTPException(403, 'Only QA can review, close or reopen an observation')
    transitions = {'New': {'Under Review'}, 'Under Review': {'Closed'}, 'Closed': {'New'}}
    if payload.status not in transitions.get(obj.status, set()):
        raise HTTPException(400, 'Invalid observation workflow transition')
    reason = d._required(payload.reason, 'Review / closure reason')
    if payload.status == 'Closed' and not payload.outcome:
        raise HTTPException(400, 'Select an observation closure outcome')
    previous = obj.status
    state = obj.workflow_state
    state.setdefault('observation_history', []).append({'from': previous, 'to': payload.status,
        'reason': reason, 'outcome': payload.outcome, 'actor_id': user.id, 'at': models.now().isoformat()})
    obj.workflow_state_json = json.dumps(state)
    obj.status = payload.status
    obj.workflow_revision += 1
    obj.observation_outcome = payload.outcome if payload.status == 'Closed' else None
    obj.closure_remarks = reason if payload.status == 'Closed' else None
    obj.closed_at = models.now() if payload.status == 'Closed' else None
    d._audit(db, obj, user, 'Observation ' + ('Reopened' if previous == 'Closed' else payload.status),
        f'{obj.defect_key}: {reason}' + (f' Outcome: {payload.outcome}.' if payload.outcome else ''),
        previous_state=previous, new_state=obj.status, step_name='Observation')
    db.commit(); db.refresh(obj)
    return obj


def convert(db, obj, payload, user):
    from .routers import defects as d
    locked(db, obj, payload.revision, user)
    if not qa_reviewer(user):
        raise HTTPException(403, 'Only QA can convert an observation to a defect')
    if payload.environment not in ENVIRONMENTS:
        raise HTTPException(400, 'Select a valid defect environment')
    reason = d._required(payload.reason, 'Conversion reason')
    previous, old_key = obj.status, obj.defect_key
    observation = {'key': old_key, 'status': previous, 'category': obj.observation_category,
        'outcome': obj.observation_outcome, 'closure_remarks': obj.closure_remarks,
        'closed_at': obj.closed_at.isoformat() if obj.closed_at else None,
        'history': obj.workflow_state.get('observation_history', [])}
    for field in ('severity', 'priority', 'environment', 'module_feature', 'steps_to_reproduce', 'expected_result', 'actual_result'):
        setattr(obj, field, d._required(getattr(payload, field), field.replace('_', ' ').title()))
    obj.record_type = 'Defect'
    obj.defect_key = models.gen_defect_id(db)
    obj.observation_converted_at = models.now()
    obj.status = 'New'; obj.closed_at = None; obj.closure_remarks = None
    workspace = db.get(models.QAWorkspace, obj.qa_workspace_id)
    obj.workflow_json = json.dumps(policy(workspace.defect_workflow_json if workspace else None))
    obj.workflow_state_json = json.dumps({'production_impact': 'Affected' if obj.environment == 'Production' else 'Unknown',
        'iteration': 0, 'history': [], 'observation': observation,
        'occurrences': [{'environment': obj.environment, 'build': obj.build_version, 'remarks': f'Converted from {old_key}'}]})
    obj.workflow_revision += 1
    # Existing links remain on this same ID. Conversion never rewrites a
    # testcase result or an earlier attempt's immutable evidence.
    d._audit(db, obj, user, 'Converted to Defect', f'{old_key} → {obj.defect_key}. Reason: {reason}. Links, documents, comments and observation history retained.',
        previous_state=previous, new_state='New', step_name='Observation conversion')
    db.commit(); db.refresh(obj)
    return obj
