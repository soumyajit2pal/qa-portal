import pytest
from fastapi import FastAPI
import asyncio
import json
from types import SimpleNamespace
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from app import models as m
from app.database import get_db
from app.deps import get_current_user
from app.routers import auth

@pytest.fixture
def directory(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    m.Base.metadata.create_all(engine)
    with Session(engine) as db:
        ws = m.QAWorkspace(id=10, name='QA', workspace_key='QA', is_active=True)
        other = m.QAWorkspace(id=20, name='Other', workspace_key='OTHER', is_active=True)
        db.add_all([ws, other])
        for uid, role, workspace, visible in [(1, 'QA_ENGINEER', ws, True), (2, 'QA_LEAD', ws, True), (3, 'QA_LEAD', other, True), (4, 'QA_LEAD', ws, False)]:
            db.add(m.User(id=uid, username=f'login{uid}', full_name=f'Person {uid}', email=f'{uid}@example.org', hashed_password='secret', department='QA', is_active=True, show_in_user_dropdowns=visible, role_assignments=[m.UserRole(role=role)], qa_workspace_memberships=[m.QAWorkspaceMember(workspace=workspace, role='WORKSPACE_MEMBER', is_active=True)]))
        db.commit()
        actor = db.get(m.User, 1)
        monkeypatch.setattr(auth, 'active_qa_workspace_scope_ids', lambda user: (10,))
        app = FastAPI()
        app.include_router(auth.router)
        app.dependency_overrides[get_db] = lambda: db
        app.dependency_overrides[get_current_user] = lambda: actor
        class Client:
            def get(self, url):
                path, _, query = url.partition('?')
                messages = []
                async def receive():
                    return {'type': 'http.request', 'body': b'', 'more_body': False}
                async def send(message):
                    messages.append(message)
                asyncio.run(app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                                 'method': 'GET', 'scheme': 'https', 'path': path, 'raw_path': path.encode(),
                                 'query_string': query.encode(), 'headers': [], 'client': ('127.0.0.1', 1234),
                                 'server': ('localhost', 443)}, receive, send))
                code = next(m['status'] for m in messages if m['type'] == 'http.response.start')
                body = b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body')
                return SimpleNamespace(status_code=code, text=body.decode(), json=lambda: json.loads(body))
        yield Client(), db, actor


def test_minimal_scoped_lookup(directory):
    client, _, _ = directory
    response = client.get('/api/auth/user-options')
    assert response.status_code == 200, response.text
    assert {u['id'] for u in response.json()} == {1, 2, 4}
    for row in response.json():
        assert set(row) == {'id', 'full_name', 'department', 'departments', 'is_active', 'show_in_user_dropdowns'}


def test_server_filtered_candidates(directory):
    client, _, _ = directory
    response = client.get('/api/auth/user-options?purpose=qa_lead')
    assert response.status_code == 200, response.text
    assert [u['id'] for u in response.json()] == [2]
    assert client.get('/api/auth/user-options?workspace_id=20').status_code == 403
    assert client.get('/api/auth/user-options?purpose=invalid').status_code == 400


def test_admin_directory_and_minimal_admin_picker(directory):
    client, db, actor = directory
    assert client.get('/api/auth/users').status_code == 403
    assert client.get('/api/auth/users?all_workspaces=true').status_code == 403
    actor.role_assignments.append(m.UserRole(role='ADMIN'))
    db.commit()
    response = client.get('/api/auth/users?all_workspaces=true')
    assert response.status_code == 200, response.text
    assert len(response.json()) == 4
    assert 'roles' in response.json()[0]
    assert 'roles' not in client.get('/api/auth/user-options').json()[0]


def test_approvers_and_missing_scope(directory, monkeypatch):
    client, _, _ = directory
    response = client.get('/api/auth/user-options?purpose=approver&roles=QA_LEAD&department=QA&department_scoped=true')
    assert response.status_code == 200, response.text
    assert [u['id'] for u in response.json()] == [2]
    assert client.get('/api/auth/user-options?purpose=approver&roles=ADMIN').status_code == 400
    monkeypatch.setattr(auth, 'active_qa_workspace_scope_ids', lambda user: ())
    assert [u['id'] for u in client.get('/api/auth/user-options').json()] == [1]
