import inspect
from types import SimpleNamespace

from sqlalchemy import or_, select
from sqlalchemy.dialects import oracle

from app import models
from app.routers import defects, test_reports


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
