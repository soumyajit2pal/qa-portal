"""Independent observation lifecycle and audited creation of a linked defect."""
import json
import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException

from . import models, defect_cc
from .constants import ENVIRONMENTS, Role
from .defect_workflow import policy


def is_observation(record):
    return getattr(record, 'record_type', None) == 'Observation'


def require_defect(record):
    if is_observation(record):
        raise HTTPException(400, 'This is an observation. Use its observation workflow or Create defect from observation.')


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
    # Serialize creation on the source. A unique source PK and target unique
    # constraint also protect against duplicate requests across processes.
    db.query(models.Defect).filter_by(id=obj.id).with_for_update().populate_existing().one()
    writable(db, obj, user)
    if not qa_reviewer(user):
        raise HTTPException(403, 'Only QA can create a defect from an observation')
    if not is_observation(obj):
        raise HTTPException(409, 'Select the original observation to create or open its linked defect')
    existing = db.get(models.ObservationDefectLink, obj.id)
    if existing:
        # Idempotent retries return the same DEF, even if the response to the
        # original request was lost. Never update either workflow on retry.
        return existing.defect
    if obj.workflow_revision != payload.revision:
        raise HTTPException(409, 'Observation changed. Refresh and review before retrying.')
    if payload.environment not in ENVIRONMENTS:
        raise HTTPException(400, 'Select a valid defect environment')
    reason = d._required(payload.reason, 'Reason for creating a defect')
    values = {field: d._required(getattr(payload, field), field.replace('_', ' ').title()) for field in
        ('severity', 'priority', 'environment', 'module_feature', 'steps_to_reproduce', 'expected_result', 'actual_result')}
    copied = ('title', 'description', 'qa_request_id', 'qa_workspace_id', 'department', 'application_name',
        'module_name', 'reporter_id', 'execution_id', 'cycle_id', 'primary_test_case_id', 'build_version',
        'device_details', 'api_endpoint', 'request_response_details', 'log_details', 'related_cr_number',
        'external_defect_id', 'remarks', 'labels')
    workspace = db.get(models.QAWorkspace, obj.qa_workspace_id)
    target = models.Defect(**{field: getattr(obj, field) for field in copied}, **values,
        record_type='Defect', defect_key=models.gen_defect_id(db), status='New',
        workflow_json=json.dumps(policy(workspace.defect_workflow_json if workspace else None)),
        workflow_state_json=json.dumps({'production_impact': 'Affected' if values['environment'] == 'Production' else 'Unknown',
            'iteration': 0, 'history': [], 'occurrences': [{'environment': values['environment'], 'build': obj.build_version,
                'remarks': f'Created from {obj.defect_key}'}]}))
    activity = db.query(models.ApprovalAction).filter_by(entity_type='DEFECT', entity_id=obj.id).order_by(
        models.ApprovalAction.created_at, models.ApprovalAction.id).all()
    snapshot = dict(id=obj.id, key=obj.defect_key, title=obj.title, description=obj.description,
        status=obj.status, category=obj.observation_category, outcome=obj.observation_outcome,
        revision=obj.workflow_revision, workflow_state=obj.workflow_state,
        activity=[dict(id=item.id, entity_type=item.entity_type, entity_id=item.entity_id, actor_id=item.actor_id,
            decision=item.decision, comments=item.comments, actor_name=item.actor_name, actor_role=item.actor_role,
            created_at=item.created_at.isoformat() if item.created_at else '', step_name=item.step_name,
            previous_state=item.previous_state, new_state=item.new_state) for item in activity])
    created_paths = []
    from . import documents
    from .storage_config import get_upload_root
    try:
        db.add(target); db.flush()
        db.add(models.ObservationDefectLink(observation=obj, defect=target, created_by_id=user.id,
            reason=reason, source_snapshot_json=json.dumps(snapshot)))
        for link in obj.test_case_links:
            db.add(models.DefectTestCaseLink(defect_id=target.id, test_case_id=link.test_case_id))
        for link in obj.execution_links:
            db.add(models.DefectExecutionLink(defect_id=target.id, execution_id=link.execution_id,
                linked_by_id=link.linked_by_id, created_at=link.created_at))
        for link in obj.functional_request_links:
            db.add(models.DefectFunctionalRequestLink(defect_id=target.id, functional_request_id=link.functional_request_id,
                linked_by_id=link.linked_by_id, linked_at=link.linked_at, reason=link.reason, linked_workflow_revision=0))
        for entry in obj.cc_entries:
            db.add(models.DefectCCUser(defect_id=target.id, user_id=entry.user_id,
                added_by_id=entry.added_by_id, added_at=entry.added_at))
        # Separate document rows AND bytes keep later attachment deletion on
        # one record from damaging the other. Original filenames preserve
        # embedded rich-text image resolution. Comments stay on their OBS.
        for document in documents.list_documents(db, 'DEFECT', obj.id):
            relative = str(Path(target.defect_key) / 'DEFECT' / (uuid.uuid4().hex + Path(document.file_name).suffix))
            destination = Path(get_upload_root()) / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            created_paths.append(destination)
            try:
                shutil.copy2(documents.full_path(document), destination)
            except OSError as error:
                raise HTTPException(409, f'Could not copy attachment {document.file_name}. Restore its file and retry; the observation is unchanged.') from error
            db.add(models.RequestDocument(module='DEFECT', request_id=target.id, file_name=document.file_name,
                stored_path=relative, content_type=document.content_type, file_size=document.file_size,
                uploaded_by_id=document.uploaded_by_id, uploaded_at=document.uploaded_at))
        obj.observation_converted_at = models.now()
        obj.workflow_revision += 1
        d._audit(db, obj, user, 'Defect Created from Observation',
            f'Created {target.defect_key} from {obj.defect_key}. Reason: {reason}. Observation status unchanged.',
            previous_state=obj.status, new_state=obj.status, step_name='Observation escalation')
        # Use the normal creation event so named participants (including a
        # reporter who is also the actor) retain the standard notification and
        # delivery-permission contract. Provenance stays in its audit text.
        d._audit(db, target, user, 'Created',
            f'Created from {obj.defect_key}. Reason: {reason}. Details, attachments and links copied; original history retained on the observation.',
            new_state='New', step_name='Observation escalation')
        db.commit(); db.refresh(target)
    except Exception:
        db.rollback()
        # An uncertain commit may have succeeded. Only remove bytes that have
        # no committed document row, using the existing storage convention.
        for path in created_paths:
            relative = str(path.relative_to(get_upload_root()))
            if db.query(models.RequestDocument).filter_by(stored_path=relative).first() is None:
                path.unlink(missing_ok=True)
        raise
    return target
