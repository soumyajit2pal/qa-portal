from types import SimpleNamespace as Obj
from unittest.mock import MagicMock
import pytest
from fastapi import HTTPException
from app import models
from app.routers import dashboard, sast_dast


@pytest.mark.parametrize('source,model,entity', [
    ('Functional Testing Request', models.FunctionalRequest, 'FUNCTIONAL_REQUEST'),
    ('SAST Request', models.SASTRequest, 'SAST'),
    ('DAST Request', models.DASTRequest, 'DAST'),
    ('Performance Request', models.PerformanceRequest, 'PERFORMANCE'),
    ('Suppression Request', models.SuppressionRequest, 'SUPPRESSION'),
])
def test_lifecycle_resolves_selected_source_and_history(monkeypatch, source, model, entity):
    db = MagicMock()
    req = Obj(id=7, application_name='Example', status='SM_APPROVAL_PENDING', updated_at=None)
    scoped = MagicMock()
    scoped.filter.return_value.first.return_value = req
    monkeypatch.setattr(dashboard, 'dashboard_department_scope', lambda user: ['IT'])
    def scope_query(query, *args): return scoped
    monkeypatch.setattr(dashboard, '_join_qa_department', scope_query)
    monkeypatch.setattr(dashboard, '_scope_suppressions', scope_query)
    monkeypatch.setattr(dashboard, '_age_days', lambda value: 0)
    db.query.return_value.filter_by.return_value.order_by.return_value.all.return_value = []
    db.query.return_value.filter_by.return_value.all.return_value = []
    security_history = MagicMock(return_value=[])
    monkeypatch.setattr(sast_dast, '_sast_dast_history_rows', security_history)
    result = dashboard.three_w_project_detail('REQUEST-7', db, Obj(), source=source)
    assert db.query.call_args_list[0].args == (model,)
    assert result['project_id'] == 'REQUEST-7'
    assert result['status'] == 'SM_APPROVAL_PENDING'
    if entity in ('SAST', 'DAST'):
        security_history.assert_called_once_with(db, entity, 7)
    else:
        db.query.return_value.filter_by.assert_any_call(entity_type=entity, entity_id=7)


def test_inaccessible_lifecycle_returns_404_not_success_payload(monkeypatch):
    scoped = MagicMock()
    scoped.filter.return_value.first.return_value = None
    monkeypatch.setattr(dashboard, 'dashboard_department_scope', lambda user: ['IT'])
    monkeypatch.setattr(dashboard, '_join_qa_department', lambda *args: scoped)
    with pytest.raises(HTTPException) as error:
        dashboard.three_w_project_detail('missing', MagicMock(), Obj(), source='SAST Request')
    assert error.value.status_code == 404
