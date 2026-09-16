from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import models, schemas
from app.routers import sast_dast


class Db:
    def __init__(self):
        self.actions = []
        self.commits = 0

    def add(self, row):
        self.actions.append(row)

    def commit(self):
        self.commits += 1

    def refresh(self, row):
        pass


def setup_request(monkeypatch, kind):
    request = (models.SASTRequest if kind == 'SAST' else models.DASTRequest)(
        id=8, requester_id=1, status='WAITING_FOR_FIX')
    if kind == 'SAST':
        request.components = [models.SASTComponent(id=i, repository_url=f'https://repo/{i}.git',
                                                   commit_id='old') for i in (41, 42, 43)]
    else:
        request.targets = [models.DASTTarget(id=i, application_url=f'https://app/{i}') for i in (41, 42, 43)]
    monkeypatch.setattr(sast_dast, '_pending_scan_target_ids', lambda *args: {41, 42})
    monkeypatch.setattr(sast_dast, '_pending_suppression_ids', lambda *args: [])
    user = SimpleNamespace(id=1, roles_csv='REQUESTER', has_role=lambda *args: False)
    return request, user


@pytest.mark.parametrize('kind', ['SAST', 'DAST'])
def test_mark_fixed_records_each_pending_code_reference_before_rescan(monkeypatch, kind):
    request, user = setup_request(monkeypatch, kind)
    payload = schemas.SecurityFixIn(targets=[{'target_id': i, 'commit_id': f' latest-{i} '} for i in (41, 42)])
    db = Db()
    sast_dast._mark_fixed(db, request, user, None, payload)
    assert request.status == 'RESCAN'
    assert db.commits == 1
    fix_action = db.actions[0]
    assert fix_action.actor_id == 1 and fix_action.decision == 'Fix Submitted'
    assert 'latest-41' in fix_action.comments and 'latest-42' in fix_action.comments
    assert ('https://repo/41.git' if kind == 'SAST' else 'https://app/41') in fix_action.comments
    assert '43' not in fix_action.comments
    if kind == 'SAST':
        assert [row.commit_id for row in request.components] == ['latest-41', 'latest-42', 'old']
        assert 'previous: old' in fix_action.comments


@pytest.mark.parametrize('ids', [[41], [41, 99], [41, 42, 43]])
def test_missing_foreign_or_clear_target_reference_cannot_mutate_request(monkeypatch, ids):
    request, user = setup_request(monkeypatch, 'SAST')
    db = Db()
    payload = schemas.SecurityFixIn(targets=[{'target_id': i, 'commit_id': 'new'} for i in ids])
    with pytest.raises(HTTPException, match='every target awaiting remediation'):
        sast_dast._mark_fixed(db, request, user, None, payload)
    assert request.status == 'WAITING_FOR_FIX'
    assert all(row.commit_id == 'old' for row in request.components)
    assert not db.actions and db.commits == 0


@pytest.mark.parametrize('value', ['', '   ', 'x' * 501])
def test_blank_or_oversized_code_reference_is_rejected(value):
    with pytest.raises(ValidationError):
        schemas.SecurityFixIn(targets=[{'target_id': 41, 'commit_id': value}])


def test_empty_and_duplicate_target_fix_evidence_are_rejected():
    for targets in [[], [{'target_id': 41, 'commit_id': 'a'}, {'target_id': 41, 'commit_id': 'b'}]]:
        with pytest.raises(ValidationError):
            schemas.SecurityFixIn(targets=targets)


def test_active_developer_delegate_can_submit_evidence_and_delegation_closes(monkeypatch):
    request, _ = setup_request(monkeypatch, 'SAST')
    delegation = models.QARequestDelegation(target_type='SAST', target_id=8,
                                             assigned_to_id=2, status='ACTIVE')
    request.qa_request = models.QARequest(application_name='App', delegations=[delegation])
    developer = SimpleNamespace(id=2, roles_csv='DEVELOPER', has_role=lambda *args: False)
    payload = schemas.SecurityFixIn(targets=[{'target_id': i, 'commit_id': 'new'} for i in (41, 42)])
    db = Db()
    sast_dast._mark_fixed(db, request, developer, None, payload)
    assert delegation.status == 'RETURNED' and delegation.closed_by_id == 2
    assert db.actions[0].actor_id == 2


def test_unassigned_developer_cannot_mark_fixed_with_evidence(monkeypatch):
    request, _ = setup_request(monkeypatch, 'SAST')
    developer = SimpleNamespace(id=2, roles_csv='DEVELOPER', has_role=lambda *args: False)
    payload = schemas.SecurityFixIn(targets=[{'target_id': i, 'commit_id': 'new'} for i in (41, 42)])
    with pytest.raises(HTTPException) as raised:
        sast_dast._mark_fixed(Db(), request, developer, None, payload)
    assert raised.value.status_code == 403
    assert request.status == 'WAITING_FOR_FIX'
