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


@pytest.mark.parametrize('types, expected_id, expected_types', [
    ('Functional Testing', 'TQA-FUNC-03', 'Functional Testing'),
    ('Functional Testing,SAST,DAST', 'TQA-REQ-03', 'Functional Testing, SAST, DAST'),
    ('Functional Testing, Performance Testing', 'TQA-REQ-03', 'Functional Testing, Performance Testing'),
    (' Functional Testing, Functional Testing, ', 'TQA-FUNC-03', 'Functional Testing'),
])
def test_certificate_testing_scope(types, expected_id, expected_types):
    parent = models.QARequest(request_id='TQA-REQ-03', request_types=types)
    source = models.FunctionalRequest(request_id='TQA-FUNC-03', qa_request=parent)
    obj = models.QASignOff(testing_request_id=source.request_id, testing_type='Functional', source_functional_request=source)
    assert obj.certificate_testing_request_id == expected_id
    assert obj.certificate_testing_type == expected_types
    assert obj.testing_request_id == 'TQA-FUNC-03'
    obj.certificate_data_json = json.dumps({'current': {'testing_scope': obj.live_testing_scope}})
    parent.request_types = 'Functional Testing,DAST,Performance Testing'
    assert obj.certificate_testing_request_id == expected_id
    assert obj.certificate_testing_type == expected_types


def test_unlinked_legacy_certificate_testing_scope():
    obj = models.QASignOff(testing_request_id='TQA-FUNC-03', testing_type='Functional')
    assert obj.certificate_testing_request_id == 'TQA-FUNC-03'
    assert obj.certificate_testing_type == 'Functional'


def test_security_totals_sum_targets_not_overlapping_views_or_rescans():
    def scan(id, batch, target, auditor, suppressed, other=999):
        return Obj(id=id, execution_key=batch, targets=[{'id': target}], total_count=other,
                   suppressed_total_count=suppressed,
                   filters=[{'title': 'Quick View', 'total_count': other},
                            {'title': 'Security Auditor View', 'total_count': auditor}])
    scans = [scan(1, 'initial', 10, 12, 1), scan(2, 'initial', 20, 8, 2),
             scan(3, 'rescan', 10, 0, 5)]
    assert service.security_scan_counts(scans) == {'initial_findings': 20, 'current_findings': 8, 'suppression_count': 7}


def test_security_legacy_scans_use_initial_total_and_latest_suppressions():
    scans = [Obj(id=1, execution_key=None, targets=[], filters=[], total_count=9, suppressed_total_count=0),
             Obj(id=2, execution_key=None, targets=[], filters=[], total_count=0, suppressed_total_count=4)]
    assert service.security_scan_counts(scans) == {'initial_findings': 9, 'current_findings': 0, 'suppression_count': 4}
    assert service.security_scan_counts([]) == {'initial_findings': None, 'current_findings': None, 'suppression_count': None}


def test_security_export_includes_all_sast_dast_requests_and_zero_counts():
    snapshot = {'security': [
        {'type': 'SAST', 'request_id': 'TQA-SAST-01', 'status': 'CLOSED', 'initial_findings': 20, 'suppression_count': 7},
        {'type': 'DAST', 'request_id': 'TQA-DAST-01', 'status': 'WAITING_FOR_FIX', 'initial_findings': 0, 'suppression_count': 0},
        {'type': 'DAST', 'request_id': 'TQA-DAST-02', 'status': 'CLOSED', 'findings': 999},
    ]}
    rows = service.security_assessment_rows(snapshot)
    assert len(rows) == 3
    assert rows[0][3] == '20'
    assert rows[0][5] == '7'
    assert rows[1][2] == 'Waiting For Fix'
    assert rows[1][5] == '0'
    assert rows[2][3] == 'Not captured'
    snapshot['security'][0].update(current_findings=2, suppression_request_ids=['TQA-SUP-01', 'TQA-SUP-02'])
    table = service.security_assessment_table(snapshot)
    assert '| Current findings | Suppression count | Suppression request ID(s) |' in table
    assert '| 20 | 2 | 7 | TQA-SUP-01, TQA-SUP-02 |' in table
    assert 'refresh and full reapproval' in table


@pytest.mark.parametrize('defects, expected_total', [([defect(1, 'Closed')], 1), ([], 0)])
def test_section_c_hides_zero_statuses_and_keeps_total(defects, expected_total):
    snapshot = service.aggregate([], defects)
    content = dict(service.markdown_tables(snapshot))['Section C – QA Defect Status Summary']
    assert f'| Total | {expected_total} |' in content
    for status in service.DEFECT_BUCKETS:
        if snapshot['defects']['counts'].get(status, 0):
            assert f'| {status} |' in content
        else:
            assert f'| {status} |' not in content
