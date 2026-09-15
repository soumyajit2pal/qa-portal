"""Exercise workflow persistence on local Oracle; roll back all smoke-test rows."""
import json
import uuid
from app.database import SessionLocal
from app import models, schemas
from app.defect_workflow import policy
from app.routers.defect_workflow_actions import apply_action
from app.routers.defects import create_defect, link_defect_request, _scoped_defects
from app.routers.reports import _visible_defects


def main():
    db = SessionLocal()
    # The handler flushes rather than commits during this smoke test. The outer
    # transaction is rolled back, including defect and approval history rows.
    db.commit = db.flush
    try:
        request = db.query(models.QARequest).first()
        users = db.query(models.User).filter(models.User.is_active == True).all()
        user = next((u for u in users if 'ADMIN' in u.roles), None)
        if request is None or user is None:
            raise RuntimeError('A local request and active administrator are required for this smoke test')
        workspace = db.get(models.QAWorkspace, request.qa_workspace_id)
        schemas.QAWorkspaceOut.model_validate(workspace)
        user.active_qa_workspace_id = workspace.id
        standalone = create_defect(schemas.DefectCreate(
            title='Rollback-only standalone defect', description='Synthetic test',
            application_name=request.application_name, department=request.department,
            module_feature='Smoke test', environment='UAT', severity='Low', priority='P4 – Low',
            steps_to_reproduce='Synthetic', expected_result='Pass', actual_result='Fail'), db, user)
        assert standalone.qa_request_id is None
        assert standalone.qa_workspace_id == workspace.id
        schemas.DefectOut.model_validate(standalone)
        assert _scoped_defects(db, user).filter(models.Defect.id == standalone.id).first()
        assert _visible_defects(db, user).filter(models.Defect.id == standalone.id).first()
        frozen_policy = standalone.workflow_json
        link_defect_request(standalone.id, schemas.DefectLinkRequest(qa_request_id=request.id, revision=0), db, user)
        assert standalone.qa_request_id == request.id
        assert standalone.workflow_json == frozen_policy
        for impact in ['Unaffected', 'Affected']:
            obj = models.Defect(defect_key='SMOKE-' + uuid.uuid4().hex[:16], title='Rollback-only workflow check',
                description='Rollback-only test', status='QA Testing', qa_request_id=None, qa_workspace_id=workspace.id, department=request.department,
                application_name=request.application_name, module_feature='Workflow smoke test', environment='UAT',
                severity='Low', priority='P4 – Low', steps_to_reproduce='Synthetic test', expected_result='Pass',
                actual_result='Fail', reporter_id=user.id, assignee_id=user.id, retest_tester_id=user.id,
                workflow_json=json.dumps(policy(None)), workflow_state_json=json.dumps({
                    'production_impact': impact, 'iteration': 1, 'deployed_build': 'smoke-1',
                    'release_owner_id': user.id, 'history': []}))
            db.add(obj); db.flush()
            target = 'Closed' if impact == 'Unaffected' else 'Ready for Release'
            apply_action(db, obj, schemas.DefectWorkflowAction(revision=0, status=target, build='smoke-1',
                remarks='Synthetic confirmation and regression passed', reference='rollback-only evidence',
                regression_confirmed=True, target_release='smoke-release', release_owner_id=user.id), user)
            if impact == 'Affected':
                apply_action(db, obj, schemas.DefectWorkflowAction(revision=1, status='Production Verification',
                    build='smoke-prod', reference='rollback-only deployment', remarks='Synthetic deployment'), user)
                apply_action(db, obj, schemas.DefectWorkflowAction(revision=2, status='Closed',
                    build='smoke-prod', reference='rollback-only observation', remarks='Synthetic production verification'), user)
            result = schemas.DefectOut.model_validate(obj)
            assert result.status == 'Closed'
            assert result.workflow_state['history'][-1]['result'] == 'Passed'
        print('Oracle smoke checks passed: optional request creation, visibility, linking later, and requestless test-only/production closure; response serialization valid.')
    finally:
        db.rollback()
        db.close()
        print('Smoke-test rows rolled back.')


if __name__ == '__main__':
    main()
