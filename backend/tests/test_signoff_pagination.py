import datetime
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models
from app.pagination import PageParams
from app.routers import signoff


def params(**overrides):
    values = dict(page=1, page_size=5, search=None, status=None, department=None,
                  raised_from=None, raised_to=None, sort_by=None, sort_order='desc')
    return PageParams(**(values | overrides))


@pytest.fixture
def db(monkeypatch):
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    monkeypatch.setattr(signoff, 'dashboard_department_scope', lambda user: None)
    monkeypatch.setattr(signoff, 'active_qa_workspace_scope_ids', lambda user: {1})
    with Session(engine) as session:
        for department in ('Finance', 'IT'):
            parent = models.QARequest(application_name='Portal', department=department)
            session.add(parent)
            session.flush()
            session.add(models.FunctionalRequest(request_id=f'FUNC-{department}', qa_request_id=parent.id))
        session.flush()
        for i in range(1, 14):
            session.add(models.QASignOff(
                certificate_id=f'TQA-SIGN-{i:02}', application_name='Portal',
                certificate_type='Full Clearance', testing_type='Functional',
                qa_workspace_id=1 if i < 13 else 2,
                status='ISSUED' if i % 2 else 'DRAFT',
                testing_request_id='FUNC-Finance' if i <= 6 else 'FUNC-IT',
                created_at=datetime.datetime(2026, 1, 1),
                certificate_data_json=json.dumps({'current': {'testing_scope': {'testing_type': 'Functional'}, 'large': 'x' * 10000}}),
            ))
        session.commit()
        yield session
    engine.dispose()


def test_pages_are_bounded_stable_and_exclude_evidence(db):
    first = signoff.SignOffPage.model_validate(signoff.list_signoffs(db, SimpleNamespace(), params()))
    second = signoff.SignOffPage.model_validate(signoff.list_signoffs(db, SimpleNamespace(), params(page=2)))
    assert first.total == 12
    assert first.total_pages == 3
    assert first.has_next and not first.has_previous
    assert len(first.items) == len(second.items) == 5
    assert not ({row.id for row in first.items} & {row.id for row in second.items})
    assert first.items[0].certificate_id == 'TQA-SIGN-12'
    assert first.status_counts == {'DRAFT': 6, 'ISSUED': 6}
    assert 'certificate_summary' not in first.model_dump()['items'][0]
    assert len(first.model_dump_json()) < 10000


def test_search_status_and_out_of_range(db):
    result = signoff.list_signoffs(db, SimpleNamespace(), params(search='TQA-SIGN-11', status=['ISSUED']))
    assert result['total'] == 1
    assert result['items'][0].certificate_id == 'TQA-SIGN-11'
    assert signoff.list_signoffs(db, SimpleNamespace(), params(search='TQA-SIGN-13'))['total'] == 0
    assert signoff.list_signoffs(db, SimpleNamespace(), params(page=9))['items'] == []


def test_department_scope_applies_before_totals(db, monkeypatch):
    monkeypatch.setattr(signoff, 'dashboard_department_scope', lambda user: ['Finance'])
    result = signoff.list_signoffs(db, SimpleNamespace(), params())
    assert result['total'] == 6
    assert result['status_counts'] == {'DRAFT': 3, 'ISSUED': 3}
    assert result['departments'] == ['Finance']
    assert signoff.list_signoffs(db, SimpleNamespace(), params(department='IT'))['total'] == 0


def test_department_filter_and_options_cover_all_pages(db):
    result = signoff.list_signoffs(db, SimpleNamespace(), params(department='IT'))
    assert result['total'] == 6
    assert result['departments'] == ['Finance', 'IT']
    assert all(row.testing_request_id == 'FUNC-IT' for row in result['items'])
