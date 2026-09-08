from types import SimpleNamespace

from sqlalchemy.dialects import oracle

from app.routers.test_reports import (
    _active_test_case_predicate,
    _traceability_source,
    _traceability_value,
)


def test_traceability_uses_pinned_version_for_historical_execution():
    current = SimpleNamespace(epic_id="EPIC-CURRENT", version_major=3, version_minor=0)
    pinned = SimpleNamespace(epic_id="EPIC-EXECUTED", version_major=1, version_minor=2)

    source = _traceability_source(current, pinned)

    assert source is pinned
    assert _traceability_value(source, "epic_id") == "EPIC-EXECUTED"


def test_traceability_falls_back_to_repository_case_and_normalizes_blank_ids():
    current = SimpleNamespace(cr_number="  CR-42  ", feature_id="   ")

    source = _traceability_source(current, None)

    assert source is current
    assert _traceability_value(source, "cr_number") == "CR-42"
    assert _traceability_value(source, "feature_id") is None


def test_active_test_case_filter_compiles_for_oracle_as_numeric_boolean():
    sql = str(_active_test_case_predicate().compile(dialect=oracle.dialect()))

    assert " = " in sql
    assert " IS " not in sql


def test_report_queries_compile_for_oracle_and_responses_validate():
    from unittest.mock import patch
    from sqlalchemy.orm import Query, Session
    from app import models, schemas
    from app.routers import test_reports as reports

    testcase = models.TestCase(id=1, project_id=7, test_case_key='TC-1',
                               version_major=1, version_minor=0, status=None)
    cycle = models.TestCycle(id=2, project_id=7, cycle_key='CYCLE-2', name='Cycle', status=None)
    execution = models.TestExecution(id=3, cycle_id=2, test_case_id=1, status=None)
    for populated in (False, True):
        responses = iter([
            [testcase] if populated else [],
            [(testcase, execution, cycle, None)] if populated else [],
            [], [], [], [], [],
        ])
        compiled = []

        def all_rows(query):
            sql = str(query.statement.compile(dialect=oracle.dialect()))
            assert ' IS 0' not in sql and ' IS 1' not in sql
            compiled.append(sql)
            return next(responses)

        with Session() as db, patch.object(Query, 'all', all_rows), \
                patch.object(reports, '_get_project_or_404', return_value=SimpleNamespace(id=7, project_key='P7')), \
                patch.object(reports, 'require_project_visibility') as visibility:
            result = reports.requirements_traceability(7, None, 'all', 50, 0, db, SimpleNamespace(id=9))
            parsed = schemas.RequirementTraceabilityOut.model_validate(result)
            parsed.model_dump_json()
            visibility.assert_called_once()
            assert len(compiled) == 7
            assert parsed.executed_test_cases == 0
            if populated:
                assert parsed.items[0].latest_result == 'Unknown'
                assert parsed.items[0].test_case_status == 'Unknown'
