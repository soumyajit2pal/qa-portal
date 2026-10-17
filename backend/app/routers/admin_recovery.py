"""System-admin recovery commands with explicit workspace boundaries."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models as m, schemas, admin_recovery as service
from ..constants import Role
from ..database import get_db
from ..deps import require_roles

router = APIRouter(prefix='/api/admin-recovery', tags=['admin recovery'])
admin = require_roles(Role.ADMIN)


@router.get('/projects')
def projects(db: Session = Depends(get_db), user: m.User = Depends(admin)):
    workspace = service.authorize(db, user)
    rows = db.query(m.TestProject).filter_by(qa_workspace_id=workspace).order_by(m.TestProject.name).all()
    return [{'id': row.id, 'key': row.project_key, 'name': row.name, 'application': row.application_name,
             'active': bool(row.is_active and not row.is_archived)} for row in rows]


@router.get('/projects/{project_id}/scope')
def project_scope(project_id: int, db: Session = Depends(get_db), user: m.User = Depends(admin)):
    workspace = service.authorize(db, user)
    project = db.get(m.TestProject, project_id)
    if not project or project.qa_workspace_id != workspace:
        raise HTTPException(404, 'Project not found in this workspace')
    return {'testcases': [{'id': row.id, 'key': row.test_case_key, 'name': row.test_scenario}
                          for row in db.query(m.TestCase).filter_by(project_id=project_id).order_by(m.TestCase.id).all()],
            'cycles': [{'id': row.id, 'key': row.cycle_key, 'name': row.name}
                       for row in db.query(m.TestCycle).filter_by(project_id=project_id).order_by(m.TestCycle.id).all()]}


@router.get('/requests')
def requests(request_type: str = Query(...), search: str = Query('', max_length=150),
             db: Session = Depends(get_db), user: m.User = Depends(admin)):
    workspace = service.authorize(db, user)
    cls = service.REQUESTS.get(request_type)
    if cls is None:
        raise HTTPException(400, 'Select a supported request type')
    query = db.query(cls)
    if cls is m.SuppressionRequest:
        query = query.filter(cls.qa_workspace_id == workspace)
        key = cls.suppression_id
    else:
        query = query.join(m.QARequest, cls.qa_request_id == m.QARequest.id).filter(m.QARequest.qa_workspace_id == workspace)
        key = cls.request_id
    if search.strip():
        pattern = '%' + search.strip() + '%'
        query = query.filter(or_(key.ilike(pattern), cls.status.ilike(pattern)))
    rows = query.order_by(cls.id.desc()).limit(50).all()
    return [{'id': row.id, 'key': service._request_key(row), 'application': row.application_name,
             'status': row.status} for row in rows]


@router.get('/requests/{request_type}/{request_id}/context')
def context(request_type: str, request_id: int, db: Session = Depends(get_db), user: m.User = Depends(admin)):
    obj = service.request_context(db, request_type, request_id, user)
    actions = service._workflow_actions(db, request_type, obj)
    field, roles = service.owner_field(request_type, obj.status)
    candidates, hold_candidates = [], []
    for candidate in db.query(m.User).filter_by(is_active=True).order_by(m.User.full_name).all():
        for options, required in ((candidates, roles), (hold_candidates, (Role.SECURITY_ANALYST, *service.LEADS))):
            try:
                service._eligible_user(db, candidate.id, required, obj.qa_workspace_id)
                options.append({'id': candidate.id, 'name': candidate.full_name})
            except HTTPException:
                pass
    return {'key': service._request_key(obj), 'status': obj.status, 'application': obj.application_name,
            'actions': actions, 'owner_field': field, 'multiple_owners': field == 'assigned_tester_ids',
            'owners': candidates, 'hold_owners': hold_candidates,
            'message': ('Select a recovery action. Original approvals and evidence remain in history.' if actions else
                        'This request is protected or has no eligible recovery action. Use its existing approval, obstacle or QA Clearance workflow.')}


@router.post('/preview', response_model=schemas.AdminRecoveryOut)
def preview(payload: schemas.AdminRecoveryPreviewIn, db: Session = Depends(get_db), user: m.User = Depends(admin)):
    return service.preview(db, payload, user)


@router.post('/jobs/{recovery_key}/apply', response_model=schemas.AdminRecoveryOut)
def apply(recovery_key: str, db: Session = Depends(get_db), user: m.User = Depends(admin)):
    return service.apply(db, recovery_key, user)


@router.post('/jobs/{recovery_key}/reverse', response_model=schemas.AdminRecoveryOut)
def reverse(recovery_key: str, payload: schemas.AdminRecoveryReverseIn,
            db: Session = Depends(get_db), user: m.User = Depends(admin)):
    return service.reverse(db, recovery_key, payload.reason, user)


@router.get('/jobs', response_model=list[schemas.AdminRecoveryOut])
def jobs(db: Session = Depends(get_db), user: m.User = Depends(admin)):
    workspace = service.authorize(db, user)
    return [service.serialize(row) for row in db.query(m.AdminRecoveryJob).filter_by(
        qa_workspace_id=workspace).order_by(m.AdminRecoveryJob.id.desc()).limit(50).all()]
