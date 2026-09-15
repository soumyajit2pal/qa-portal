import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from app.defect_workflow import WorkflowPolicy
from app.routers import qa_workspaces as router

@pytest.fixture
def setup(monkeypatch):
    first = WorkflowPolicy().model_dump()
    second = WorkflowPolicy(version=2, qa_environment='SIT').model_dump()
    row = SimpleNamespace(id=9, defect_workflow_json=json.dumps(second), defect_workflow_history_json=json.dumps([{'previous': first, 'published': second}]))
    monkeypatch.setattr(router, '_workspace', lambda *args: row)
    monkeypatch.setattr(router, 'can_configure_workspace', lambda *args: True)
    class DB:
        committed = False
        def query(self, *args): return self
        def filter_by(self, **kwargs): return self
        def with_for_update(self): return self
        def populate_existing(self): return self
        def one(self): return row
        def commit(self): self.committed = True
    return row, first, second, DB(), SimpleNamespace(id=1)

def test_history_includes_initial_version(setup):
    row, first, second, db, user = setup
    assert router.defect_workflow_history(9, db, user) == [second, first]

def test_restore_preserves_history_and_increments_version(setup):
    row, first, second, db, user = setup
    router.publish_defect_workflow(9, WorkflowPolicy(**{**first, 'version': 2}), db, user)
    assert json.loads(row.defect_workflow_json) == {**first, 'version': 3}
    history = json.loads(row.defect_workflow_history_json)
    assert history[-1]['previous'] == second
    assert history[-1]['user_id'] == 1
    assert db.committed
    assert [item['version'] for item in router.defect_workflow_history(9, db, user)] == [3, 2, 1]

def test_stale_restore_rejected(setup):
    row, first, second, db, user = setup
    with pytest.raises(HTTPException) as error:
        router.publish_defect_workflow(9, WorkflowPolicy(**first), db, user)
    assert error.value.status_code == 409
    assert not db.committed
    assert json.loads(row.defect_workflow_json) == second

@pytest.mark.parametrize('restore', [False, True])
def test_configuration_permission_required(setup, monkeypatch, restore):
    row, first, second, db, user = setup
    monkeypatch.setattr(router, 'can_configure_workspace', lambda *args: False)
    with pytest.raises(HTTPException) as error:
        if restore:
            router.publish_defect_workflow(9, WorkflowPolicy(**second), db, user)
        else:
            router.defect_workflow_history(9, db, user)
    assert error.value.status_code == 403
    assert not db.committed
