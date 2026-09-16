import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import models, schemas
from app.routers import sast_dast
from app.routers.sast_dast import _import_scan_results, _selected_scan_targets


def test_dast_scan_can_cover_multiple_selected_urls_and_rejects_foreign_ids():
    request = models.DASTRequest()
    request.targets = [
        models.DASTTarget(id=11, application_url="https://one.example.test", environment="UAT"),
        models.DASTTarget(id=12, application_url="https://two.example.test", environment="SIT"),
    ]

    targets = _selected_scan_targets(request, "DAST", [12, 11])

    assert [row["id"] for row in targets] == [12, 11]
    assert [row["label"] for row in targets] == ["https://two.example.test", "https://one.example.test"]
    assert targets[0]["detail"] == "SIT"
    with pytest.raises(HTTPException, match="do not belong"):
        _selected_scan_targets(request, "DAST", [99])


def test_sast_target_snapshots_keep_each_repository_identity():
    request = models.SASTRequest(application_name="Payments")
    request.components = [
        models.SASTComponent(id=21, repository_url="https://git.example.test/a.git", git_branch="main", commit_id="abc"),
        models.SASTComponent(id=22, repository_url="https://git.example.test/b.git", git_branch="release"),
    ]

    targets = _selected_scan_targets(request, "SAST", None)

    assert [row["id"] for row in targets] == [21, 22]
    assert targets[0]["detail"] == "main · abc"


def test_scan_target_selection_is_required_and_snapshot_round_trips():
    with pytest.raises(ValueError, match="Configure at least one target scan"):
        schemas.SecurityScanStartIn(scans=[])

    payload = schemas.SecurityScanStartIn(scans=[
        {"target_id": 31, "application_name": "Portal URL One", "application_version": "1"},
        {"target_id": 32, "application_name": "Portal URL Two", "application_version": "2"},
    ])
    assert payload.scans[0].application_name == "Portal URL One"
    assert payload.scans[1].application_version == "2"

    with pytest.raises(ValueError, match="configured once"):
        schemas.SecurityScanStartIn(scans=[
            {"target_id": 31, "application_name": "A", "application_version": "1"},
            {"target_id": 31, "application_name": "B", "application_version": "2"},
        ])

    result = models.SecurityScanResult(targets_json=json.dumps([
        {"id": 31, "label": "https://app.example.test", "detail": "UAT"},
    ]))
    assert result.targets == [{"id": 31, "label": "https://app.example.test", "detail": "UAT"}]


def test_each_selected_url_creates_its_own_scan_result(monkeypatch):
    request = models.DASTRequest(id=8)
    request.targets = [
        models.DASTTarget(id=41, application_url="https://one.example.test", environment="UAT"),
        models.DASTTarget(id=42, application_url="https://two.example.test", environment="SIT"),
    ]
    counts = {"One": 3, "Two": 7}

    class FakeClient:
        def __init__(self, kind):
            assert kind == "DAST"

        def retrieve_snapshot(self, application_name, application_version):
            total = counts[application_name]
            return SimpleNamespace(
                application_name=application_name, application_version=application_version,
                project_version_id=f"pv-{application_name}", critical_count=total,
                high_count=0, medium_count=0, low_count=0, total_count=total,
                audit_url=f"https://ssc/{application_name}", suppressed_critical_count=0,
                suppressed_high_count=0, suppressed_medium_count=0,
                suppressed_low_count=0, suppressed_total_count=0, filters=[],
            )

    class FakeDb:
        def __init__(self):
            self.added = []

        def add(self, row):
            self.added.append(row)

    monkeypatch.setattr(sast_dast, "FortifySSCClient", FakeClient)
    payload = schemas.SecurityScanStartIn(scans=[
        {"target_id": 41, "application_name": "One", "application_version": "1"},
        {"target_id": 42, "application_name": "Two", "application_version": "9"},
    ])

    results = _import_scan_results(FakeDb(), request, "DAST", payload.scans, SimpleNamespace(id=5))

    assert len(results) == 2
    assert results[0].execution_key == results[1].execution_key
    assert results[0].application_name == "One" and results[0].total_count == 3
    assert results[1].application_name == "Two" and results[1].total_count == 7
    assert results[0].targets == [{"id": 41, "label": "https://one.example.test", "detail": "UAT"}]
    assert results[1].targets == [{"id": 42, "label": "https://two.example.test", "detail": "SIT"}]

    with pytest.raises(HTTPException, match="every application URL"):
        _import_scan_results(FakeDb(), request, "DAST", payload.scans[:1], SimpleNamespace(id=5))

@pytest.mark.parametrize('kind', ['SAST', 'DAST'])
def test_rescan_imports_only_pending_targets_and_retains_clear_history(monkeypatch, kind):
    request = (models.SASTRequest if kind == 'SAST' else models.DASTRequest)(id=8, status='RESCAN')
    if kind == 'SAST':
        request.components = [models.SASTComponent(id=i, repository_url=f'https://target/{i}') for i in (41, 42)]
    else:
        request.targets = [models.DASTTarget(id=i, application_url=f'https://target/{i}') for i in (41, 42)]
    clear = models.SecurityScanResult(id=1, execution_key='initial', total_count=0, filters_json='[]',
                                      targets_json=json.dumps([{'id': 41, 'label': 'https://target/41'}]))
    pending = models.SecurityScanResult(id=2, execution_key='initial', total_count=0,
        filters_json=json.dumps([{'total_count': 7}]),
        targets_json=json.dumps([{'id': 42, 'label': 'https://target/42'}]))
    rows = [pending, clear]
    calls = []

    class Client:
        def __init__(self, _kind):
            pass

        def retrieve_snapshot(self, name, version):
            calls.append(name)
            return SimpleNamespace(application_name=name, application_version=version,
                project_version_id='pv', critical_count=0, high_count=0, medium_count=0,
                low_count=0, total_count=0, audit_url=None, suppressed_critical_count=0,
                suppressed_high_count=0, suppressed_medium_count=0, suppressed_low_count=0,
                suppressed_total_count=0, filters=[])

    class Db:
        def add(self, row):
            row.id = 3
            rows.insert(0, row)

        def commit(self):
            pass

        def refresh(self, row):
            pass

    monkeypatch.setattr(sast_dast, 'FortifySSCClient', Client)
    monkeypatch.setattr(sast_dast, '_scan_results', lambda *args: rows)
    monkeypatch.setattr(sast_dast, '_require', lambda *args: None)
    monkeypatch.setattr(sast_dast, '_require_assigned_security_analyst', lambda *args: None)
    monkeypatch.setattr(sast_dast, '_log', lambda *args: None)
    payload = schemas.SecurityScanStartIn(scans=[
        {'target_id': i, 'application_name': f'Target {i}', 'application_version': '1'} for i in (41, 42)
    ])
    _, imported = sast_dast._rescan_scan(Db(), request, kind, payload, SimpleNamespace(id=5))
    assert calls == ['Target 42']
    assert len(imported) == 1
    assert len(rows) == 3
    current = sast_dast._current_scan_results(rows)
    assert current == [imported[0], clear]
    assert sast_dast._batch_open_count(current) == 0
    assert sum(row.targets[0]['id'] == 41 for row in rows) == 1
    with pytest.raises(HTTPException, match='already clear'):
        sast_dast._rescan_scan(Db(), request, kind, payload, SimpleNamespace(id=5))
    assert len(rows) == 3


def test_latest_target_results_keep_pending_findings_from_other_execution():
    def row(i, target, count, execution):
        return models.SecurityScanResult(id=i, execution_key=execution, total_count=count,
            filters_json='[]', targets_json=json.dumps([{'id': target}]))
    results = [row(3, 41, 0, 'rescan'), row(2, 42, 8, 'initial'), row(1, 41, 3, 'initial')]
    current = sast_dast._current_scan_results(results)
    assert [result.id for result in current] == [3, 2]
    assert sast_dast._batch_open_count(current) == 8
