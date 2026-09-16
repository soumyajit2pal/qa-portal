import datetime
import asyncio
import io
import json
from types import SimpleNamespace

from openpyxl import load_workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models
from app.routers import reports


def test_testcase_and_attempt_registers_keep_project_scope_and_run_history(monkeypatch):
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = models.User(username='report-user', full_name='Report User', hashed_password='x')
        visible = models.TestProject(project_key='P-VISIBLE', name='Visible project', department='QA')
        hidden = models.TestProject(project_key='P-HIDDEN', name='Hidden project', department='Other')
        db.add_all([user, visible, hidden]); db.flush()

        for project, key in ((visible, 'TC-VISIBLE'), (hidden, 'TC-HIDDEN')):
            case = models.TestCase(project=project, test_case_key=key, created_by=user,
                                   created_at=datetime.datetime(2026, 9, 16, 10))
            cycle = models.TestCycle(project=project, cycle_key=f'CY-{key}', name='Cycle')
            db.add_all([case, cycle]); db.flush()
            slot = models.TestExecution(cycle=cycle, test_case=case)
            db.add(slot); db.flush()
            db.add(models.TestExecutionRun(execution=slot, attempt_no=1, status='Fail', executed_by=user,
                                           executed_at=datetime.datetime(2026, 9, 16, 11)))
            if project is visible:
                db.add(models.TestExecutionRun(execution=slot, attempt_no=2, status='Retest Passed',
                                               executed_by=user, executed_at=datetime.datetime(2026, 9, 16, 12)))
        db.commit()
        monkeypatch.setattr(reports, 'viewable_project_ids', lambda _db, _user: [visible.id])

        cases = reports.testcase_register(db=db, current_user=user)
        attempts = reports.execution_attempt_register(db=db, current_user=user)
        assert [row['Test Case ID'] for row in cases] == ['TC-VISIBLE']
        assert cases[0]['Created By'] == 'Report User'
        assert {row['Result'] for row in attempts} == {'Fail', 'Retest Passed'}
        assert {row['Project ID'] for row in attempts} == {'P-VISIBLE'}


def test_clearance_evidence_reads_frozen_snapshot_and_marks_legacy_rows(monkeypatch):
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = models.User(username='report-user', full_name='Report User', hashed_password='x')
        db.add_all([
            user,
            models.QASignOff(certificate_id='CERT-FROZEN', application_name='App', status='ISSUED',
                certificate_data_json=json.dumps({'current': {
                    'revision': 2, 'execution': {'total': 3, 'counts': {'Fail': 1, 'Pass': 2}, 'pass_pct': 66.67},
                    'defects': {'total': 1, 'counts': {'Deferred': 1}},
                    'severity': [{'severity': 'High', 'open': 1}], 'open_critical_high': 1,
                    'assigned_testers': [{'name': 'QA 1'}],
                }})),
            models.QASignOff(certificate_id='CERT-LEGACY', application_name='App', status='DRAFT'),
        ])
        db.commit()
        monkeypatch.setattr(reports, 'dashboard_department_scope', lambda _user: None)
        monkeypatch.setattr(reports, 'active_qa_workspace_scope_ids', lambda _user: ())

        rows = {row['Certificate ID']: row for row in reports.qa_clearance_evidence(db=db, current_user=user)}
        assert rows['CERT-FROZEN']['Evidence Revision'] == 2
        assert rows['CERT-FROZEN']['Fail'] == 1
        assert rows['CERT-FROZEN']['Open Defects'] == 1
        assert rows['CERT-FROZEN']['Assigned Testers'] == 'QA 1'
        assert rows['CERT-LEGACY']['Assigned Testers'] == 'Not captured in this revision'


def test_document_inventory_is_selected_workspace_only_and_filters_modified_date(tmp_path, monkeypatch):
    root = tmp_path / 'selected-workspace'
    root.mkdir()
    (root / 'folder').mkdir()
    (root / 'folder' / 'evidence.txt').write_text('evidence')
    (root / 'other.txt').write_text('other')
    from app.routers import document_portal
    rows = document_portal._inventory_rows(root, 'Selected workspace')
    assert {row['Relative Path'] for row in rows} == {'folder/evidence.txt', 'other.txt'}
    assert all(str(tmp_path) not in row['Relative Path'] for row in rows)
    assert document_portal._inventory_rows(root, 'Selected workspace', date_from='2030-01-01T00:00:00+05:30') == []

    monkeypatch.setattr(document_portal, '_scope', lambda _db, _user: (root, SimpleNamespace(name='Selected workspace')))
    user = SimpleNamespace(full_name='Document Viewer')

    async def body(response):
        return b''.join([part async for part in response.body_iterator])

    xlsx = asyncio.run(body(document_portal.export_inventory(format='xlsx', db=object(), _=user)))
    csv = asyncio.run(body(document_portal.export_inventory(format='csv', db=object(), _=user)))
    pdf = asyncio.run(body(document_portal.export_inventory(format='pdf', db=object(), _=user)))
    workbook = load_workbook(io.BytesIO(xlsx), read_only=True)
    assert 'Selected workspace' in str([cell.value for row in workbook.active for cell in row])
    assert b'folder/evidence.txt' in csv
    assert pdf.startswith(b'%PDF')
