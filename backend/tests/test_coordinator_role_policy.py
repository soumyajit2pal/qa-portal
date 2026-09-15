import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app import models
from app.routers import auth

@pytest.fixture
def db():
    engine = create_engine('sqlite://')
    models.SystemSetting.__table__.create(engine)
    with Session(engine) as session:
        yield session


def test_defaults_and_configured_empty_list(db):
    user = SimpleNamespace(roles=['ADMIN'])
    assert 'QA_ENGINEER' in auth._local_admin_assignable_roles(user, user, db)
    db.add(models.SystemSetting(key='coordinator_assignable_roles', value='[]'))
    db.commit()
    assert auth._local_admin_assignable_roles(user, user, db) == []


def test_admin_policy_persists_and_is_used_by_assignments(db, monkeypatch):
    monkeypatch.setattr(auth, 'write_audit', lambda *args, **kwargs: None)
    user = SimpleNamespace(roles=['ADMIN'])
    assert auth.configure_coordinator_roles(['CHIEF_MANAGER_QA', 'REQUESTER'], None, db, user) == ['CHIEF_MANAGER_QA', 'REQUESTER']
    assert auth._local_admin_assignable_roles(user, user, db) == ['CHIEF_MANAGER_QA', 'REQUESTER']

@pytest.mark.parametrize('role', ['ADMIN', 'SCALE_6_PLUS', 'VIEW_ONLY', 'INVALID'])
def test_protected_and_invalid_roles_rejected(db, role):
    with pytest.raises(HTTPException) as error:
        auth.configure_coordinator_roles([role], None, db, SimpleNamespace(roles=['ADMIN']))
    assert error.value.status_code == 400


def test_coordinator_cannot_change_policy(db):
    with pytest.raises(HTTPException) as error:
        auth.configure_coordinator_roles(['REQUESTER'], None, db, SimpleNamespace(roles=['QA_LEAD']))
    assert error.value.status_code == 403
