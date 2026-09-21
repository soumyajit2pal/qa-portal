"""Offline concurrency regressions; Oracle lock scheduling needs integration QA."""
import subprocess
import sys

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.dialects import oracle
from sqlalchemy.orm import Session

from app import models, schemas
from app.routers import test_execution as execution
from app.routers import functional, performance, sast_dast, suppression
from app.routers import qa_requests


def _run_processes(code, *arguments):
    workers = [subprocess.Popen([sys.executable, '-c', code, *map(str, arguments), str(n)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
               for n in range(4)]
    try:
        for worker in workers:
            stdout, stderr = worker.communicate(timeout=30)
            assert worker.returncode == 0, stdout + stderr
            assert 'Logging error' not in stderr
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.kill()
                worker.communicate()


def test_four_processes_rotate_without_lost_or_duplicate_log_records(tmp_path):
    path = tmp_path / 'app.log'
    _run_processes('''
import logging, sys, time
from app.process_logging import ProcessSafeRotatingFileHandler
handler = ProcessSafeRotatingFileHandler(sys.argv[1], maxBytes=256, backupCount=100)
logger = logging.getLogger('concurrency-test'); logger.setLevel(logging.INFO); logger.addHandler(handler)
for index in range(80):
    logger.info('worker-%s-record-%s', sys.argv[2], index)
    time.sleep(.001)
handler.close()
''', path)
    lines = []
    for candidate in tmp_path.glob('app.log*'):
        if candidate.suffix != '.lock':
            lines.extend(candidate.read_text().splitlines())
    expected = {f'worker-{worker}-record-{index}' for worker in range(4) for index in range(80)}
    assert len(lines) == len(expected)
    assert set(lines) == expected


def test_four_processes_upload_same_filename_without_overwriting(tmp_path):
    _run_processes('''
import io, sys
from unittest.mock import Mock
from fastapi import UploadFile
from app import documents
documents.get_upload_root = lambda: sys.argv[1]
for index in range(12):
    body = f'worker-{sys.argv[2]}-file-{index}'.encode()
    documents.save_documents(Mock(), 'FUNCTIONAL', 1, 'REQ',
        [UploadFile(file=io.BytesIO(body), filename='evidence.txt')], 1)
''', tmp_path)
    files = list((tmp_path / 'REQ' / 'FUNCTIONAL').iterdir())
    assert len(files) == 48
    assert {path.read_text() for path in files} == {
        f'worker-{worker}-file-{index}' for worker in range(4) for index in range(12)}


@pytest.fixture
def execution_database(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'execution.db'))
    models.Base.metadata.create_all(engine)
    # These tests exercise transaction/version behavior, not access policy.
    monkeypatch.setattr(execution, '_require_active_project', lambda *a: None)
    monkeypatch.setattr(execution, '_require_cycle_visibility', lambda *a: None)
    monkeypatch.setattr(execution, 'require_can_execute_project', lambda *a: None)
    monkeypatch.setattr(execution, '_require_assigned_runner', lambda *a: None)
    monkeypatch.setattr(execution, '_execution_status_gate', lambda *a: None)
    with Session(engine) as db:
        user = models.User(username='runner', full_name='Runner')
        project = models.TestProject(project_key='PRJ', name='Concurrency', department='QA')
        db.add_all([user, project]); db.flush()
        cycle = models.TestCycle(cycle_key='CYC-1', project_id=project.id, name='Cycle', status='In Progress', environment='UAT', build='1')
        case = models.TestCase(project_id=project.id, test_case_key='TC-1', test_scenario='Case')
        db.add_all([cycle, case]); db.flush()
        slot = models.TestExecution(cycle_id=cycle.id, test_case_id=case.id, pinned_version_id=1, run_version=0)
        db.add(slot); db.commit()
        ids = slot.id, user.id, cycle.id
    yield engine, ids
    engine.dispose()


def test_stale_execution_session_gets_conflict_instead_of_another_attempt(execution_database):
    engine, (slot_id, user_id, _) = execution_database
    with Session(engine) as first, Session(engine) as second:
        stale = second.get(models.TestExecution, slot_id)
        assert stale.run_version == 0
        execution.update_execution(slot_id, schemas.TestExecutionUpdate(status='Pass', expected_run_version=0),
                                   first, first.get(models.User, user_id))
        with pytest.raises(HTTPException) as error:
            execution.update_execution(slot_id, schemas.TestExecutionUpdate(status='Pass', expected_run_version=0),
                                       second, second.get(models.User, user_id))
        assert error.value.status_code == 409
        assert stale.run_version == 1
        assert second.query(models.TestExecutionRun).count() == 1


def test_attempt_numbers_do_not_reuse_gaps(execution_database):
    engine, (slot_id, user_id, _) = execution_database
    with Session(engine) as db:
        db.add(models.TestExecutionRun(execution_id=slot_id, attempt_no=2, status='Pass'))
        db.commit()
        execution.update_execution(slot_id, schemas.TestExecutionUpdate(status='Pass'), db, db.get(models.User, user_id))
        assert [n for (n,) in db.query(models.TestExecutionRun.attempt_no).order_by(models.TestExecutionRun.attempt_no)] == [2, 3]


def test_submit_rechecks_draft_after_another_session_cancels(execution_database, monkeypatch):
    engine, (_, user_id, _) = execution_database
    monkeypatch.setattr(qa_requests, '_require_gateway_visibility', lambda *a: None)
    with Session(engine) as db:
        gateway = models.QARequest(request_id='REQ-1', application_name='App', department='QA', requester_id=user_id, status='DRAFT')
        db.add(gateway); db.commit(); request_id = gateway.id
    with Session(engine) as first, Session(engine) as second:
        stale = second.get(models.QARequest, request_id)
        qa_requests.cancel_request(request_id, first, first.get(models.User, user_id))
        with pytest.raises(HTTPException) as error:
            qa_requests.submit_request(request_id, second, second.get(models.User, user_id))
        assert error.value.status_code == 400
        assert 'CANCELLED' in error.value.detail
        assert stale.status == 'CANCELLED'


def test_bulk_result_locks_selected_rows_in_order(execution_database):
    engine, (slot_id, _, cycle_id) = execution_database
    captured = []
    from types import SimpleNamespace
    admin = SimpleNamespace(id=999, full_name='Admin', roles_csv='ADMIN', has_role=lambda *_: True)
    with Session(engine) as db:
        @event.listens_for(db, 'do_orm_execute')
        def capture(state):
            captured.append(str(state.statement.compile(dialect=oracle.dialect())).upper())
        execution.bulk_update_execution_results(cycle_id,
            schemas.TestExecutionBulkResult(execution_ids=[slot_id], status='Pass'), db, admin)
        assert db.query(models.TestExecutionRun).count() == 1
    assert any('ORDER BY QAP_TEST_EXECUTIONS.ID FOR UPDATE' in sql for sql in captured)


@pytest.mark.parametrize('fetch', [
    lambda db: execution._execution_or_404(db, 999, lock=True),
    lambda db: functional._get_or_404(db, 999, lock=True),
    lambda db: performance._get_or_404(db, 999, lock=True),
    lambda db: sast_dast._get_or_404(db, models.SASTRequest, 999, 'SAST', lock=True),
    lambda db: suppression.update_suppression(999, None, db, None),
])
def test_lock_queries_compile_for_oracle_without_row_limit(fetch):
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    captured = []
    with Session(engine) as db:
        @event.listens_for(db, 'do_orm_execute')
        def capture(state):
            captured.append(str(state.statement.compile(dialect=oracle.dialect())).upper())
        with pytest.raises(HTTPException) as error:
            fetch(db)
        assert error.value.status_code == 404
    engine.dispose()
    locked = [sql for sql in captured if 'FOR UPDATE' in sql]
    assert locked
    assert all('FETCH FIRST' not in sql and 'ROWNUM' not in sql for sql in locked)
