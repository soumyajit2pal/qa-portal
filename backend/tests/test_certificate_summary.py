import json
from types import SimpleNamespace as Obj
import pytest
from fastapi import HTTPException
from app import certificate_summary as service, models
from app.routers import signoff


def defect(id, status, severity='High', blocked=False):
    return Obj(id=id, status=status, severity=severity, workflow_state={'blocked': {'reason': 'wait'}} if blocked else {})


def test_deduplication_deferred_and_all_execution_outcomes():
    records = [Obj(id=i, status=status) for i, status in enumerate(service.EXECUTION_STATUSES)]
    deferred = defect(1, 'Deferred')
    data = service.aggregate(records + [records[0]], [deferred, deferred, defect(2, 'Closed'), defect(3, 'QA Testing', blocked=True)])
    assert data['execution']['total'] == 6
    assert data['execution']['pass_pct'] == 40
    assert data['defects']['total'] == 3
    assert data['defects']['counts'] == {'Deferred': 1, 'Closed': 1, 'Blocked': 1}
    assert data['open_critical_high'] == 2


def test_no_evidence_is_not_a_passing_result():
    data = service.aggregate([], [])
    assert data['execution']['pass_pct'] is None
    with pytest.raises(HTTPException):
        service.validate(Obj(certificate_summary=data, certificate_type='Full Clearance'))


def test_full_clearance_blocks_deferred_high_but_conditional_can_progress():
    data = service.aggregate([Obj(id=1, status='Pass')], [defect(1, 'Deferred')])
    with pytest.raises(HTTPException) as error:
        service.validate(Obj(certificate_summary=data, certificate_type='Full Clearance'))
    assert 'Critical or High' in error.value.detail
    service.validate(Obj(certificate_summary=data, certificate_type='Conditional Clearance'))


def test_refresh_archives_previous_snapshot(monkeypatch):
    old = {'revision': 1, 'execution': {'total': 4}}
    obj = models.QASignOff(status='ISSUED', reviewed_by_id=8, approved_by_id=9, certificate_data_json=json.dumps({'current': old, 'history': []}))
    monkeypatch.setattr(service, 'capture', lambda db, obj: {'execution': {'total': 5}})
    service.refresh(None, obj)
    stored = json.loads(obj.certificate_data_json)
    assert stored['current']['revision'] == 2
    assert stored['history'][0]['execution']['total'] == 4
    assert stored['history'][0]['approved_by_id'] == 9


def test_changed_live_evidence_requires_explicit_refresh(monkeypatch):
    snapshot = service.aggregate([Obj(id=1, status='Pass')], [])
    monkeypatch.setattr(service, 'capture', lambda db, obj: service.aggregate([Obj(id=1, status='Fail')], []))
    with pytest.raises(HTTPException) as error:
        service.validate(Obj(certificate_summary=snapshot, certificate_type='Full Clearance'), object())
    assert error.value.status_code == 409


def test_refresh_invalidates_approval_and_linked_clearance(monkeypatch):
    obj = models.QASignOff(id=1, requester_id=2, status='ISSUED', reviewed_by_id=3, approved_by_id=4)
    source = Obj(status='CLOSED', id=8)
    class DB:
        def refresh(self, *args, **kwargs): pass
        def query(self, *args): return self
        def filter_by(self, **kwargs): return self
        def all(self): return [source]
        def add(self, row): pass
        def commit(self): pass
    monkeypatch.setattr(signoff, '_get_visible_or_404', lambda *args: obj)
    monkeypatch.setattr(service, 'refresh', lambda *args: {'revision': 2})
    monkeypatch.setattr(signoff, '_log', lambda *args: None)
    signoff.refresh_certificate_summary(1, DB(), Obj(id=2, roles_csv='QA_ENGINEER', has_role=lambda *args: False))
    assert obj.status == 'DRAFT'
    assert obj.reviewed_by_id is None and obj.approved_by_id is None
    assert source.status == 'QA_SIGNOFF_PENDING'


def test_refresh_denies_unrelated_user(monkeypatch):
    obj = models.QASignOff(id=1, requester_id=2, status='ISSUED')
    monkeypatch.setattr(signoff, '_get_visible_or_404', lambda *args: obj)
    with pytest.raises(HTTPException) as error:
        signoff.refresh_certificate_summary(1, None, Obj(id=9, has_role=lambda *args: False))
    assert error.value.status_code == 403
    assert obj.status == 'ISSUED'


def test_frozen_snapshot_is_not_recomputed_on_read(monkeypatch):
    obj = models.QASignOff(certificate_data_json=json.dumps({'current': {'revision': 1, 'execution': {'total': 2}}}))
    monkeypatch.setattr(service, 'capture', lambda *args: pytest.fail('Reading a certificate must not recapture live data'))
    assert obj.certificate_summary['execution']['total'] == 2


@pytest.mark.parametrize('status', ['SM_REJECTED', 'DEPT_HEAD_COE_REJECTED'])
@pytest.mark.parametrize('admin', [False, True])
def test_rejected_certificate_cannot_refresh_even_as_admin(monkeypatch, status, admin):
    from unittest.mock import MagicMock
    obj = models.QASignOff(id=1, requester_id=2, status=status, certificate_data_json='{"current":{"revision":1}}')
    db = MagicMock()
    monkeypatch.setattr(signoff, '_get_visible_or_404', lambda *args: obj)
    monkeypatch.setattr(service, 'refresh', lambda *args: pytest.fail('Rejected evidence must stay frozen'))
    with pytest.raises(HTTPException) as error:
        signoff.refresh_certificate_summary(1, db, Obj(id=9 if admin else 2, has_role=lambda *args: admin))
    assert error.value.status_code == 409
    assert 'Reopen' in error.value.detail
    assert obj.status == status
    assert obj.certificate_summary['revision'] == 1
    db.commit.assert_not_called()


def test_assigned_testers_are_deduplicated_and_names_frozen():
    user = Obj(id=2, full_name='QA Two', username='qa2')
    class DB:
        def query(self, *args): return self
        def filter(self, *args): return self
        def all(self): return [user]
    snapshot = {'assigned_testers': service.assigned_testers(DB(), Obj(assigned_tester_ids='2, 2, bad, 9'))}
    user.full_name = 'Changed later'
    assert snapshot['assigned_testers'] == [{'id': 2, 'name': 'QA Two'}, {'id': 9, 'name': 'User #9 (unavailable)'}]
    assert service.assigned_testers_label(snapshot) == 'QA Two, User #9 (unavailable)'
    assert service.assigned_testers_label({'assigned_testers': []}) == 'Not assigned'
    assert 'reapproval' in service.assigned_testers_label({})


def test_changed_tester_assignment_requires_reapproval(monkeypatch):
    snapshot = service.aggregate([Obj(id=1, status='Pass')], [])
    snapshot['assigned_testers'] = [{'id': 1, 'name': 'QA One'}]
    monkeypatch.setattr(service, 'capture', lambda *args: {**snapshot, 'assigned_testers': [{'id': 2, 'name': 'QA Two'}]})
    with pytest.raises(HTTPException) as error:
        service.validate(Obj(certificate_summary=snapshot, certificate_type='Full Clearance'), object())
    assert error.value.status_code == 409
