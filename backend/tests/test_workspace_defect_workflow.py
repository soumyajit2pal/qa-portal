import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from app.defect_workflow import policy, stages, transitions, verified_for, state, WorkflowPolicy
from app import schemas
from app.routers.defect_workflow_actions import apply_action


def defect(status='QA Testing', impact='Unaffected', **config):
    return SimpleNamespace(id=1, department='QA', defect_key='D-1', status=status, environment='UAT',
        workflow_json=json.dumps(policy(json.dumps(config))), workflow_revision=0,
        workflow_state_json=json.dumps({'production_impact': impact, 'iteration': 1,
                                       'deployed_build': '2.0', 'history': []}),
        retest_tester_id=2, assignee_id=3, reporter_id=4, qa_request=SimpleNamespace(qa_workspace_id=10),
        assignee_is_requester=False, reopen_count=0, closed_at=None)


class Query:
    def __init__(self, obj): self.obj = obj
    def filter_by(self, **kw): return self
    def filter(self, *args): return self
    def with_for_update(self): return self
    def populate_existing(self): return self
    def one(self): return self.obj
    def update(self, *args, **kw): return 1


class DB:
    def __init__(self, obj): self.obj = obj; self.committed = False
    def query(self, *args): return Query(self.obj)
    def commit(self): self.committed = True
    def refresh(self, obj): pass
    def get(self, model, key):
        return SimpleNamespace(id=key, is_active=True, show_in_user_dropdowns=True,
                               roles=['QA_ENGINEER', 'QA_LEAD', 'APPLICATION_OWNER', 'DEVELOPER'], role_assignments=[],
                               has_role=lambda *r: True, has_department=lambda d: True)


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    from app.routers import defects
    monkeypatch.setattr(defects, '_audit', lambda *a, **kw: None)
    from app import workspace_service
    monkeypatch.setattr(workspace_service, 'selectable_workspace_ids', lambda *a: {10})


def action(obj, target=None, user_id=2, **kw):
    user = SimpleNamespace(id=user_id, full_name='Tester', roles=['QA_ENGINEER'],
                           has_role=lambda *r: False)
    payload = schemas.DefectWorkflowAction(revision=obj.workflow_revision, status=target, **kw)
    return apply_action(DB(obj), obj, payload, user)


def passed(**kw):
    return dict(build='2.0', remarks='Original failure no longer occurs', reference='evidence-17',
                regression_confirmed=True, **kw)


def test_uat_only_test_defect_closes_without_production():
    obj = defect()
    assert 'Business Acceptance' not in stages(obj)
    assert 'Ready for Release' not in stages(obj)
    action(obj, 'Closed', **passed())
    assert obj.status == 'Closed'
    assert state(obj)['history'][-1]['environment'] == 'UAT'
    assert verified_for(obj, 'UAT', '2.0')
    assert not verified_for(obj, 'SIT', '2.0')
    assert not verified_for(obj, 'UAT', '1.0')


def test_production_defect_cannot_skip_release():
    obj = defect(impact='Affected')
    assert 'Closed' not in transitions(obj)
    with pytest.raises(HTTPException, match='Invalid transition'):
        action(obj, 'Closed', **passed())
    action(obj, 'Ready for Release', target_release='R2', release_owner_id=5, **passed())
    assert obj.status == 'Ready for Release'
    assert verified_for(obj, 'UAT', '2.0')
    action(obj, 'Production Verification', user_id=5, build='2.0-prod', reference='DEP-9', remarks='Deployment succeeded')
    action(obj, 'Closed', user_id=5, build='2.0-prod', reference='monitoring-9', remarks='Production verified')
    assert obj.closed_at
    assert verified_for(obj, 'Production', '2.0-prod')


def test_business_acceptance_separate_from_qa_even_in_same_environment():
    obj = defect(business_acceptance=True)
    s = state(obj); s['business_owner_id'] = 5; obj.workflow_state_json = json.dumps(s)
    action(obj, 'Business Acceptance', **passed())
    with pytest.raises(HTTPException) as exc:
        action(obj, 'Closed', **passed())
    assert exc.value.status_code == 403
    action(obj, 'Closed', user_id=5, **passed())
    assert len(state(obj)['history']) == 2


@pytest.mark.parametrize('impact', ['Unknown'])
def test_unknown_production_impact_blocks_test_only_closure(impact):
    obj = defect(impact=impact)
    with pytest.raises(HTTPException, match='unknown production impact'):
        action(obj, 'Closed', **passed())
    assert obj.status == 'QA Testing'


def test_failed_verification_reopens_and_invalidates_clearance():
    obj = defect()
    action(obj, 'Reopened', build='2.0', remarks='Still failing', reference='failure-1')
    assert obj.reopen_count == 1
    assert state(obj)['history'][-1]['result'] == 'Failed'
    assert not verified_for(obj, 'UAT', '2.0')


def test_stale_revision_rejected():
    obj = defect(); obj.workflow_revision = 4
    with pytest.raises(HTTPException) as exc:
        apply_action(DB(obj), obj, schemas.DefectWorkflowAction(revision=3, status='Closed'), SimpleNamespace())
    assert exc.value.status_code == 409


def test_production_occurrence_keeps_same_defect_and_adds_release_path():
    obj = defect()
    action(obj, action='occurrence', environment='Production', build='1.0', remarks='Same issue reproduced', reference='log-1')
    assert obj.status == 'QA Testing'
    assert 'Ready for Release' in transitions(obj)
    assert obj.environment == 'UAT'
    assert state(obj)['production_impact'] == 'Affected'


def test_wrong_build_cannot_pass():
    obj = defect()
    with pytest.raises(HTTPException, match='must match'):
        action(obj, 'Closed', build='1.0', reference='proof', remarks='Passed', regression_confirmed=True)


def test_workspace_policy_is_frozen_on_defect():
    obj = defect(qa_environment='SIT')
    newer = WorkflowPolicy(qa_environment='UAT', business_acceptance=True, version=2)
    assert newer.qa_environment == 'UAT'
    assert policy(obj.workflow_json)['qa_environment'] == 'SIT'
    assert 'Business Acceptance' not in stages(obj)


def test_all_fixes_policy_requires_production_even_when_unaffected():
    assert 'Ready for Release' in stages(defect(production_for_all=True))


def test_legacy_defect_has_no_modern_actions():
    assert transitions(SimpleNamespace(workflow_json=None)) == []


def test_blocker_preserves_stage_and_blocks_progress():
    obj = defect()
    action(obj, action='block', remarks='Environment unavailable', review_date='2026-09-20')
    assert obj.status == 'QA Testing'
    with pytest.raises(HTTPException, match='Clear the blocker'):
        action(obj, 'Closed', **passed())
    action(obj, action='unblock', remarks='Environment restored')
    action(obj, 'Closed', **passed())


def test_regression_confirmation_required():
    with pytest.raises(HTTPException, match='regression'):
        action(defect(), 'Closed', build='2.0', reference='proof', remarks='Passed')


def test_new_fix_invalidates_previous_build_results():
    obj = defect('In Progress')
    s = state(obj)
    s['history'] = [{'kind': 'verification', 'iteration': 1, 'environment': 'UAT', 'build': '1.0', 'result': 'Passed'}]
    obj.workflow_state_json = json.dumps(s)
    action(obj, 'Ready for QA', user_id=3, build='2.0', root_cause='Faulty condition',
           fix_details='Corrected condition', reference='Deployment 2', retest_tester_id=2)
    assert state(obj)['iteration'] == 2
    assert not verified_for(obj, 'UAT', '1.0')
    action(obj, 'QA Testing')
    action(obj, 'Closed', **passed())
    assert verified_for(obj, 'UAT', '2.0')
    assert not verified_for(obj, 'UAT', '1.0')


def test_qa_cannot_accept_business_risk():
    with pytest.raises(HTTPException) as exc:
        action(defect('Triaged'), 'Accept Risk', remarks='Accept risk', reference='Approval 1')
    assert exc.value.status_code == 403


def test_owner_from_another_workspace_rejected(monkeypatch):
    from app import workspace_service
    monkeypatch.setattr(workspace_service, 'selectable_workspace_ids', lambda *a: {99})
    with pytest.raises(HTTPException, match='access to this workspace'):
        action(defect('In Progress'), 'Ready for QA', user_id=3, build='2.0', root_cause='Cause',
               fix_details='Fix', reference='DEP-1', retest_tester_id=2)


@pytest.mark.parametrize('qa_environment,business_required', [('SIT', True), ('UAT', False), ('UAT', True)])
@pytest.mark.parametrize('impact', ['Affected', 'Unaffected'])
def test_all_workspace_templates_follow_their_closure_branch(qa_environment, business_required, impact):
    obj = defect(impact=impact, qa_environment=qa_environment, business_acceptance=business_required)
    # A QA request is not needed to resolve stage owners or verify the defect.
    obj.qa_request = None
    obj.qa_workspace_id = 10
    s = state(obj); s['business_owner_id'] = 5; obj.workflow_state_json = json.dumps(s)
    if business_required:
        action(obj, 'Business Acceptance', **passed())
        assert state(obj)['history'][-1]['environment'] == qa_environment
        actor = 5
    else:
        assert 'Business Acceptance' not in stages(obj)
        actor = 2
    target = 'Ready for Release' if impact == 'Affected' else 'Closed'
    action(obj, target, user_id=actor, target_release='Release 2', release_owner_id=5, **passed())
    assert state(obj)['history'][-1]['environment'] == 'UAT'
    if impact == 'Affected':
        action(obj, 'Production Verification', user_id=5, build='2.0-prod', reference='DEP-2', remarks='Deployed')
        action(obj, 'Closed', user_id=5, build='2.0-prod', reference='MON-2', remarks='Verified')
    assert obj.status == 'Closed'


def test_requestless_defect_can_handoff_to_qa():
    obj = defect('In Progress')
    obj.qa_request = None
    obj.qa_workspace_id = 10
    action(obj, 'Ready for QA', user_id=3, build='2.0', root_cause='Cause', fix_details='Fix',
           reference='DEP-2', retest_tester_id=2)
    assert obj.status == 'Ready for QA'


def test_uploaded_evidence_satisfies_reference_and_is_recorded(monkeypatch):
    from app.routers import defects
    monkeypatch.setattr(defects.doc_store, 'list_documents', lambda *a: [SimpleNamespace(id=17, file_name='qa-proof.png')])
    obj = defect()
    values = passed()
    values.pop('reference')
    action(obj, 'Closed', evidence_document_ids=[17, 17], **values)
    event = state(obj)['history'][-1]
    assert event['evidence_documents'] == [{'id': 17, 'file_name': 'qa-proof.png'}]
    assert 'qa-proof.png' in event['reference']
    assert obj.status == 'Closed'


def test_evidence_from_another_defect_is_rejected(monkeypatch):
    from app.routers import defects
    monkeypatch.setattr(defects.doc_store, 'list_documents', lambda *a: [])
    obj = defect()
    with pytest.raises(HTTPException, match='Evidence must be attached to this defect'):
        action(obj, 'Closed', evidence_document_ids=[99], **passed())
    assert obj.status == 'QA Testing'
    assert state(obj)['history'] == []


@pytest.mark.parametrize("environment,build,expected", [
    ('UAT', 'NA', True), ('UAT', None, False), ('UAT', '', False),
    ('UAT', 'other', False), ('SIT', 'NA', False),
])
def test_closed_defect_requires_explicit_matching_cycle_build(environment, build, expected):
    obj = defect()
    data = state(obj)
    data['deployed_build'] = 'NA'
    obj.workflow_state_json = json.dumps(data)
    action(obj, 'Closed', **{**passed(), 'build': 'NA'})
    assert obj.status == 'Closed'
    assert verified_for(obj, environment, build) is expected
