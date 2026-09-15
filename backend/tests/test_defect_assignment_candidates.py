from types import SimpleNamespace as NS
import pytest
from app import models as m
from app import defect_assignment as policy
from app import workspace_service


@pytest.fixture
def scope(monkeypatch):
    monkeypatch.setattr(workspace_service, 'selectable_workspace_ids', lambda db, user: {2} if user.username != 'outside' else {21})
    monkeypatch.setattr(workspace_service, 'inherited_workspace_access_mode', lambda db, user, wid: 'PARENT_VIEWER' if user.username == 'parent' else 'DIRECT')
    return NS(qa_workspace_id=2, department='COE', qa_request=None)


def user(name='qa', department='CBS', roles=('DEVELOPER',)):
    return m.User(username=name, department=department, is_active=True, show_in_user_dropdowns=True,
                  role_assignments=[m.UserRole(role=role) for role in roles])


def test_resolver_requires_selected_department(scope):
    assert policy.assignment_error(None, scope, user(), 'assignee_id', 'CBS') is None
    assert policy.assignment_error(None, scope, user(department='COE'), 'assignee_id', 'CBS')
    assert policy.assignment_error(None, scope, user(), 'assignee_id', None)


def test_admin_resolver_uses_selected_department_but_other_stage_owners_do_not(scope):
    candidate = user('bmock6', 'Digital Banking', ('ADMIN','QA_ENGINEER','APPLICATION_OWNER'))
    assert policy.assignment_error(None, scope, candidate, "assignee_id", "Digital Banking") is None
    assert policy.assignment_error(None, scope, candidate, "assignee_id", "CBS")
    for field in ("retest_tester_id", "business_owner_id", "release_owner_id"):
        assert policy.assignment_error(None, scope, candidate, field, "Digital Banking")


def test_admin_requires_explicit_workflow_role_even_in_own_department(scope):
    assert policy.assignment_error(None, scope, user(department='COE', roles=('ADMIN',)), 'assignee_id','COE')
    assert policy.assignment_error(None, scope, user(department='COE', roles=('ADMIN','DEVELOPER')), 'assignee_id','COE') is None


@pytest.mark.parametrize('candidate', [user('outside'), user('parent'), user(roles=('VIEW_ONLY','DEVELOPER'))])
def test_workspace_and_readonly_boundaries(scope, candidate):
    assert policy.assignment_error(None, scope, candidate, 'assignee_id','CBS')


def test_stage_roles_are_explicit(scope):
    assert policy.assignment_error(None, scope, user(), 'retest_tester_id')
    assert policy.assignment_error(None, scope, user(roles=('QA_ENGINEER',)), 'retest_tester_id') is None
    assert policy.assignment_error(None, scope, user(roles=('APPLICATION_OWNER',)), 'business_owner_id') is None


def test_selected_department_resolver_can_work_without_cross_department_admin_bypass(monkeypatch):
    import json
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from fastapi import HTTPException
    from starlette.requests import Request
    from app import schemas
    from app.defect_workflow import policy as workflow_policy
    from app.workflow_authority import configure_request, workflow_context
    from app.routers.defect_workflow_actions import apply_action
    from app.routers.defects import _get_visible
    from app.workspace_service import workspace_context
    engine = create_engine('sqlite:///:memory:')
    m.Base.metadata.create_all(engine)
    with Session(engine) as db:
        workspace = m.QAWorkspace(workspace_key='QA', name='QA', is_active=True)
        lead = user('lead', 'COE', ('QA_LEAD',)); lead.full_name='Lead';lead.hashed_password='x'
        resolver = user('bmock6', 'Digital Banking', ('ADMIN','DEVELOPER'));resolver.full_name='Resolver';resolver.hashed_password='x'
        db.add_all([workspace,lead,resolver]);db.flush()
        db.add_all([m.QAWorkspaceMember(workspace_id=workspace.id,user_id=u.id,role='WORKSPACE_MEMBER',is_active=True) for u in (lead,resolver)])
        defect = m.Defect(defect_key='D-route',title='Routed defect',description='Routing regression',application_name='App',module_feature='Module',environment='SIT',
                          department='COE',qa_workspace_id=workspace.id,severity='Medium',priority='P3',steps_to_reproduce='Steps',
                          expected_result='Expected',actual_result='Actual',reporter_id=lead.id,status='New',
                          workflow_json=json.dumps(workflow_policy(None)),workflow_revision=0)
        db.add(defect);db.commit()
        for u in (lead,resolver):u.active_qa_workspace_id=workspace.id
        with workspace_context(workspace.id,(workspace.id,)), workflow_context(lead):
            assert policy.assignment_error(db,defect,resolver,'assignee_id','Digital Banking') is None
            apply_action(db,defect,schemas.DefectWorkflowAction(action='transition',revision=0,status='Triaged',production_impact='Unknown',
                                                               assigned_team='Digital Banking',assignee_id=resolver.id,remarks='Route to owning team'),lead)
        req = Request({'type':'http','method':'POST','path':f'/api/defects/{defect.id}/workflow-action','headers':[]})
        with workspace_context(workspace.id,(workspace.id,)), workflow_context(resolver):
            configure_request(db,resolver,req,workflow=True)
            assert _get_visible(defect.id,db,resolver).id == defect.id
            apply_action(db,defect,schemas.DefectWorkflowAction(action='transition',revision=1,status='In Progress',remarks='Investigating'),resolver)
            from app.routers.approvals import _comment_target_or_404
            assert _comment_target_or_404(db, 'DEFECT', defect.id, resolver) == 'DEFECT'
            assert defect.status=='In Progress' 
            assert defect.department=='COE'
            assert defect.assigned_team=='Digital Banking'
            assert db.query(m.ApprovalAction).filter_by(entity_type='DEFECT',entity_id=defect.id).count()==2
            # Other defects from the originating department remain outside this admin's authority.
            db.info.pop('workflow_actor',None)
            defect.assignee_id=lead.id;db.commit()
            with pytest.raises(HTTPException):configure_request(db,resolver,req,workflow=True)
            db.info['workflow_actor']=resolver
            defect.assignee_id=resolver.id
            with pytest.raises(HTTPException):db.flush()
            db.rollback()
