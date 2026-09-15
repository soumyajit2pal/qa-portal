from types import SimpleNamespace as Obj
import pytest
from fastapi import HTTPException
from app.routers import signoff
from app import schemas

class DB:
    def refresh(self, *args, **kwargs): pass
    def commit(self): pass


def user(roles, workspace=10):
    return Obj(id=2, has_role=lambda *requested: 'ADMIN' in roles or bool(set(roles) & set(requested)),
        has_qa_workspace_role=lambda *requested, workspace_id: workspace_id == workspace and bool(set(roles) & set(requested)))


@pytest.mark.parametrize('executive,roles', [(False, ['QA_LEAD']), (True, ['AGM_QA'])])
def test_actual_approval_endpoint_advances_without_missing_guard(monkeypatch, executive, roles):
    obj = Obj(id=1, qa_workspace_id=10, requester_id=3, reviewed_by_id=4,
        status='DEPT_HEAD_QA_APPROVAL_PENDING' if executive else 'SM_APPROVAL_PENDING')
    monkeypatch.setattr(signoff, '_get_or_404', lambda *args: obj)
    monkeypatch.setattr(signoff, '_validate_rich_text_before_progress', lambda *args: None)
    monkeypatch.setattr(signoff.certificate_summary, 'validate', lambda *args: None)
    monkeypatch.setattr(signoff, '_log', lambda *args: None)
    monkeypatch.setattr(signoff, '_sync_linked_functional_request', lambda *args: None)
    endpoint = signoff.executive_coe_decision if executive else signoff.qa_lead_decision
    endpoint(1, schemas.WorkflowDecision(decision='Approved'), DB(), user(roles))
    assert obj.status == ('ISSUED' if executive else 'DEPT_HEAD_QA_APPROVAL_PENDING')


@pytest.mark.parametrize('roles,workspace,executive', [(['QA_LEAD'], 20, False), (['QA_ENGINEER'], 10, False), (['QA_LEAD'], 10, True)])
def test_wrong_workspace_or_role_is_rejected(roles, workspace, executive):
    with pytest.raises(HTTPException) as error:
        signoff._require_workspace_approver(Obj(qa_workspace_id=10), user(roles, workspace), executive=executive)
    assert error.value.status_code == 403


def test_admin_retains_oversight():
    signoff._require_workspace_approver(Obj(qa_workspace_id=10), user(['ADMIN']), executive=True)
