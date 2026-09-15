from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.dialects import oracle
from app import models, schemas, workspace_service
from app.routers import defects


def payload(**overrides):
    values = dict(title='Standalone issue', description='Description', application_name='APP', department='IT',
                  module_feature='Login', environment='UAT', severity='Low', priority='P4 – Low',
                  steps_to_reproduce='Open login', expected_result='Loads', actual_result='Error')
    values.update(overrides)
    return schemas.DefectCreate(**values)


class FakeDB:
    def get(self, model, key): return SimpleNamespace(id=key, is_active=True)
    def query(self, *args): return self
    def filter(self, *args): return self
    def first(self): return SimpleNamespace(name='IT')


@pytest.fixture
def scope(monkeypatch):
    monkeypatch.setattr(workspace_service, 'require_active_workspace', lambda user: 10)
    monkeypatch.setattr(workspace_service, 'selectable_workspace_ids', lambda db, user: {10})
    monkeypatch.setattr(defects, 'active_qa_workspace_scope_ids', lambda user: (10,))
    monkeypatch.setattr(defects, 'dashboard_department_scope', lambda user: ['IT'])
    return SimpleNamespace(id=1, department='IT')


def test_qa_request_is_optional_in_create_and_storage():
    assert payload().qa_request_id is None
    assert models.Defect.__table__.c.qa_request_id.nullable
    assert schemas.DefectOut.model_fields['qa_request_id'].default is None


def test_standalone_creation_uses_active_workspace(scope):
    assert defects._creation_context(FakeDB(), scope, payload()) == (10, 'IT', 'APP')


def test_execution_without_request_uses_project_context(scope):
    project = SimpleNamespace(qa_workspace_id=10, department='IT', application_master=SimpleNamespace(name='PROJECT APP'))
    assert defects._creation_context(FakeDB(), scope, payload(), cycle=SimpleNamespace(origin_workspace_id=None, project=project)) == (10, 'IT', 'PROJECT APP')


def test_standalone_requires_application(scope):
    with pytest.raises(HTTPException, match='Application'):
        defects._creation_context(FakeDB(), scope, payload(application_name=None))


def test_standalone_cannot_claim_other_department(scope):
    with pytest.raises(HTTPException) as exc:
        defects._creation_context(FakeDB(), scope, payload(department='Finance'))
    assert exc.value.status_code == 403


def test_linked_request_cannot_claim_other_workspace(scope):
    request = SimpleNamespace(qa_workspace_id=20, department='IT')
    with pytest.raises(HTTPException) as exc:
        defects._require_request_access(FakeDB(), request, scope)
    assert exc.value.status_code == 404


def test_request_and_execution_cannot_cross_workspaces(scope):
    request = SimpleNamespace(qa_workspace_id=10, department='IT', application_name='APP')
    project = SimpleNamespace(qa_workspace_id=20, department='IT')
    with pytest.raises(HTTPException, match='same workspace'):
        defects._creation_context(FakeDB(), scope, payload(), request, SimpleNamespace(origin_workspace_id=None, project=project))


def test_visibility_query_preserves_requestless_rows_and_own_scope(scope, monkeypatch):
    monkeypatch.setattr(defects, 'viewable_project_ids', lambda db, user: [])
    with Session() as db:
        query = defects._scoped_defects(db, scope)
        sql = str(query.statement.compile(dialect=oracle.dialect(), compile_kwargs={'literal_binds': True}))
    assert 'LEFT OUTER JOIN qap_requests' in sql
    assert 'coalesce(qap_defects.qa_workspace_id, qap_requests.qa_workspace_id) IN (10)' in sql
    assert "coalesce(qap_defects.department, qap_requests.department) IN ('IT')" in sql
