"""Read-only Oracle smoke check for dashboard parent/child aggregation."""
from app.database import SessionLocal
from app import models
from app.routers.dashboard import dashboard_requests

with SessionLocal() as db:
    user = db.query(models.User).join(models.QARequest, models.QARequest.requester_id == models.User.id).filter(models.QARequest.status == 'RAISED').order_by(models.QARequest.created_at.desc()).first()
    if user is None:
        raise RuntimeError('A raised request is required')
    result = dashboard_requests(scope='mine', date_from=None, date_to=None,
        page=1, page_size=25, cursor=None, db=db, current_user=user)
    print('Dashboard roots:', result['total'], 'active:', result['active_total'], 'terminal:', result['terminal_total'])
    print('Page roots:', len(result['items']), 'nested children:', sum(len(row['children']) for row in result['items']))
    db.rollback()
