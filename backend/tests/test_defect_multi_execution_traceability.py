import inspect
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.dialects import oracle

from app import models
from app.routers import defects, test_reports


def _defect_creator():
    return SimpleNamespace(has_role=lambda *_roles: True)


def test_execution_defect_link_checks_the_cycle_project_workspace(monkeypatch):
    monkeypatch.setattr(defects, "dashboard_department_scope", lambda _user: None)
    monkeypatch.setattr(defects, "active_qa_workspace_scope_ids", lambda _user: {21})
    cycle = SimpleNamespace(origin_workspace_id=None, project=SimpleNamespace(qa_workspace_id=21, department="QA"))

    defects._require_execution_link_access(object(), cycle, _defect_creator())


def test_execution_defect_link_rejects_a_cycle_outside_workspace_scope(monkeypatch):
    monkeypatch.setattr(defects, "dashboard_department_scope", lambda _user: None)
    monkeypatch.setattr(defects, "active_qa_workspace_scope_ids", lambda _user: {21})
    cycle = SimpleNamespace(origin_workspace_id=None, project=SimpleNamespace(qa_workspace_id=22, department="QA"))

    with pytest.raises(HTTPException) as raised:
        defects._require_execution_link_access(object(), cycle, _defect_creator())

    assert raised.value.status_code == 404
    assert raised.value.detail == "Test Cycle not found in the active workspace"


def test_defect_status_filter_has_one_multi_value_owner():
    """Repeated status query params must be handled by PageParams only."""
    assert "status" not in inspect.signature(defects.list_defects).parameters


def test_cycle_and_execution_filters_include_additional_links():
    cycle_query = select(models.Defect.id).where(or_(
        models.Defect.cycle_id == 12,
        models.Defect.execution_links.any(
            models.DefectExecutionLink.execution.has(models.TestExecution.cycle_id == 12)
        ),
    ))
    execution_query = select(models.Defect.id).where(or_(
        models.Defect.execution_id == 34,
        models.Defect.execution_links.any(models.DefectExecutionLink.execution_id == 34),
    ))

    cycle_sql = str(cycle_query.compile(dialect=oracle.dialect()))
    execution_sql = str(execution_query.compile(dialect=oracle.dialect()))

    assert "qap_defect_execution_links" in cycle_sql
    assert "qap_test_executions" in cycle_sql
    assert "qap_defect_execution_links" in execution_sql


def test_additional_link_preserves_primary_and_links_case_and_attempt(monkeypatch):
    recorded = []
    monkeypatch.setattr(defects, "_ensure_execution_link", lambda db, defect_id, execution_id: recorded.append(("execution", defect_id, execution_id)))
    monkeypatch.setattr(defects, "_ensure_case_link", lambda db, defect_id, case_id: recorded.append(("case", defect_id, case_id)))
    monkeypatch.setattr(defects, "_link_run_defect", lambda db, defect, execution, user: recorded.append(("attempt", defect.id, execution.id)))

    defect = SimpleNamespace(id=7, execution_id=100)
    execution = SimpleNamespace(id=200)
    test_case = SimpleNamespace(id=300)
    defects._link_additional_execution(object(), defect, execution, object(), test_case, object())

    assert defect.execution_id == 100
    assert recorded == [("execution", 7, 200), ("case", 7, 300), ("attempt", 7, 200)]


def test_execution_exposes_primary_and_additional_defects_without_duplicates():
    execution = models.TestExecution()
    primary = models.Defect(id=1)
    additional = models.Defect(id=2)
    execution.primary_linked_defects = [primary]
    execution.additional_linked_defects = [primary, additional]

    assert [defect.id for defect in execution.linked_defects] == [1, 2]


def test_defect_list_exposes_primary_and_additional_execution_results():
    primary_execution = models.TestExecution(id=100, status="Blocked")
    additional_execution = models.TestExecution(id=200, status="Fail")
    defect = models.Defect(id=1)
    defect.execution = primary_execution
    defect.execution_links = [
        models.DefectExecutionLink(id=2, execution_id=200, execution=additional_execution),
    ]

    assert defect.execution_status == "Blocked"
    assert [(link.execution_id, link.status) for link in defect.execution_links] == [(200, "Fail")]


def test_defect_quality_trace_includes_every_linked_testcase():
    primary_cycle = models.TestCycle(id=10, cycle_key="TQA-CYCLE-10")
    second_cycle = models.TestCycle(id=20, cycle_key="TQA-CYCLE-20")
    first_case = models.TestCase(id=1, test_case_key="TQA-TC-1")
    second_case = models.TestCase(id=2, test_case_key="TQA-TC-2")
    third_case = models.TestCase(id=3, test_case_key="TQA-TC-3")
    additional_execution = models.TestExecution(id=200, cycle=second_cycle, test_case=third_case)
    defect = models.Defect(id=1, cycle=primary_cycle, primary_test_case=first_case)
    defect.test_case_links = [models.DefectTestCaseLink(test_case=second_case)]
    defect.execution_links = [models.DefectExecutionLink(execution=additional_execution)]

    cycles, testcases = test_reports._defect_trace_keys(defect)

    assert cycles == ["TQA-CYCLE-10", "TQA-CYCLE-20"]
    assert testcases == ["TQA-TC-1", "TQA-TC-2", "TQA-TC-3"]


def test_incomplete_traceability_includes_unlinked_but_excludes_additional_links(monkeypatch):
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import Session
    from app import pagination

    engine = create_engine('sqlite://')
    with Session(engine) as db:
        db.execute(text('CREATE TABLE qap_defects (id INTEGER PRIMARY KEY, execution_id INTEGER, department TEXT)'))
        db.execute(text('CREATE TABLE qap_defect_execution_links (id INTEGER PRIMARY KEY, defect_id INTEGER, execution_id INTEGER)'))
        db.execute(text("INSERT INTO qap_defects VALUES (1, NULL, 'QA'), (2, 100, 'QA'), (3, NULL, 'QA'), (4, NULL, 'Other')"))
        db.execute(text('INSERT INTO qap_defect_execution_links VALUES (1, 3, 200)'))
        # Preserve an access-scope predicate while exercising the actual list filter.
        monkeypatch.setattr(defects, '_scoped_defects', lambda session, user: session.query(models.Defect).filter(models.Defect.department == 'QA'))
        monkeypatch.setattr(pagination, 'paginate', lambda query, params: db.execute(select(models.Defect.id).where(query.whereclause)).scalars().all())
        monkeypatch.setattr(pagination, 'to_page_response', lambda result, params: result)
        params = SimpleNamespace(search=None, status=None, sort_by=None, sort_order='desc')
        result = defects.list_defects(queue='incomplete-traceability', params=params, db=db, current_user=SimpleNamespace(id=1))
        assert result == [1]
