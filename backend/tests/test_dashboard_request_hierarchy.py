from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app import models
from app.routers import dashboard


def test_raised_parent_closes_only_when_all_children_finish():
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        parent = models.QARequest(id=1, status='RAISED', application_name='Example')
        first = models.FunctionalRequest(id=1, request_id='F-1', qa_request_id=1, status='SM_APPROVAL_PENDING')
        second = models.SASTRequest(id=1, request_id='S-1', qa_request_id=1, status='CLOSED', application_name='Example')
        db.add_all([parent, first, second]); db.flush()
        expression = dashboard._request_lifecycle_status(models.QARequest, [('Functional QA', models.FunctionalRequest), ('SAST', models.SASTRequest)])
        def status(): return db.scalar(select(expression).where(models.QARequest.id == 1))
        assert status() == 'RAISED'
        first.status = 'CLOSED'; db.flush()
        assert status() == 'CLOSED'
        first.status = 'SM_APPROVAL_PENDING'; db.flush()
        assert status() == 'RAISED'
        parent.status = 'CANCELLED'; db.flush()
        assert status() == 'CANCELLED'


def test_requests_feed_counts_parent_once_and_nests_children(monkeypatch):
    from sqlalchemy import func
    class Functions:
        dbms_lob = type('Lob', (), {'substr': staticmethod(lambda column, length, start: func.substr(column, start, length))})
        def __getattr__(self, name): return getattr(func, name)
    monkeypatch.setattr(dashboard, 'func', Functions())
    monkeypatch.setattr(dashboard, 'dashboard_department_scope', lambda user: None)
    monkeypatch.setattr(dashboard, '_dashboard_requests_scope_predicate', lambda *args: [])
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add_all([
            models.QARequest(id=1, request_id='Q-1', status='RAISED', application_name='Example'),
            models.FunctionalRequest(id=1, request_id='F-1', qa_request_id=1, status='SM_APPROVAL_PENDING'),
            models.SASTRequest(id=1, request_id='S-1', qa_request_id=1, status='CLOSED', application_name='Example'),
        ])
        db.flush()
        page = dashboard.dashboard_requests(scope='mine', date_from=None, date_to=None,
            page=1, page_size=25, cursor=None, db=db, current_user=None)
        assert page['total'] == 1
        assert page['active_total'] == 1
        assert page['terminal_total'] == 0
        assert len(page['items']) == 1
        assert page['items'][0]['request_id'] == 'Q-1'
        assert {child['request_id'] for child in page['items'][0]['children']} == {'F-1', 'S-1'}
