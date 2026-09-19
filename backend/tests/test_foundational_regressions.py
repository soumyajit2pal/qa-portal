import asyncio, io, json, ssl, sys
from types import SimpleNamespace as NS
from unittest.mock import Mock
import pytest
from fastapi import Depends, FastAPI, HTTPException, UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app import cache, deps, documents, models as m, schemas, auth
from app.workspace_service import current_workspace_id, current_workspace_scope_ids, workspace_context
from app.routers import jobs
from app.routers.functional import sm_decision


@pytest.mark.parametrize("dependency", [deps.get_current_user, deps.get_workflow_user])
def test_http_workspace_propagation_and_isolation(monkeypatch, dependency):
    def resolve(request,token,db):
        i=int(request.headers['x-workspace-id'])
        return NS(active_qa_workspace_id=i,active_workspace_scope_ids=(i,i+10))
    monkeypatch.setattr(deps, 'resolve_session', lambda request, db: NS(user_id=1))
    monkeypatch.setattr(deps,'_resolve_current_user',resolve)
    app=FastAPI();app.dependency_overrides[deps.get_db]=lambda:None
    @app.get('/probe')
    def probe(actor=Depends(dependency)):
        return [current_workspace_id(),current_workspace_scope_ids()]
    async def call(i):
        messages=[]
        async def receive():return {'type':'http.request','body':b'','more_body':False}
        async def send(msg):
            if msg['type']=='http.response.body':messages.append(msg.get('body',b''))
        await app({'type':'http','http_version':'1.1','method':'GET','scheme':'http','path':'/probe','raw_path':b'/probe','query_string':b'','headers':[(b'x-workspace-id',str(i).encode())],'server':('test',80),'client':('test',1),'root_path':''},receive,send)
        assert json.loads(b''.join(messages))==[i,[i,i+10]]
        assert current_workspace_id()==99
    async def run():
        with workspace_context(99,(99,)):await asyncio.gather(call(2),call(3))
    asyncio.run(run())


def test_delete_commit_failure_preserves_evidence(tmp_path,monkeypatch):
    p=tmp_path/'evidence.txt';p.write_text('evidence')
    monkeypatch.setattr(documents,'full_path',lambda doc:str(p))
    monkeypatch.setattr(documents,'get_upload_root',lambda:str(tmp_path))
    db=Mock();db.commit.side_effect=RuntimeError('commit failed')
    with pytest.raises(RuntimeError):documents.delete_document(db,NS(id=1,stored_path=p.name,file_name=p.name))
    assert p.read_text()=='evidence'


def test_upload_failure_removes_only_new_files(tmp_path,monkeypatch):
    monkeypatch.setattr(documents,'get_upload_root',lambda:str(tmp_path))
    db=Mock();db.commit.side_effect=RuntimeError('commit failed')
    db.query.return_value.filter_by.return_value.first.return_value=None
    folder=tmp_path/'REQ'/'FUNCTIONAL';folder.mkdir(parents=True)
    old=folder/'evidence.txt';old.write_text('original')
    upload=UploadFile(file=io.BytesIO(b'new'),filename=old.name)
    with pytest.raises(RuntimeError):documents.save_documents(db,'FUNCTIONAL',1,'REQ',[upload],1)
    assert list(folder.iterdir())==[old]
    assert old.read_text()=='original'
    db.rollback.assert_called_once()


def test_redis_retries_after_backoff(monkeypatch):
    client=Mock();factory=Mock(side_effect=[OSError('offline'),client])
    monkeypatch.setitem(sys.modules,'redis',NS(Redis=NS(from_url=factory)))
    for k,v in {'_client':None,'_next_init_at':0,'CACHE_ENABLED':True,'REDIS_URL':'redis://localhost'}.items():monkeypatch.setattr(cache,k,v)
    monkeypatch.setattr(cache,'_cache_circuit_allows',lambda:True)
    clock=[100.];monkeypatch.setattr(cache.time,'monotonic',lambda:clock[0])
    assert cache._get_client() is None
    assert cache._get_client() is None
    assert factory.call_count==1
    clock[0]+=31
    assert cache._get_client() is client


def test_stale_approval_rejected(tmp_path):
    engine=create_engine('sqlite:///'+str(tmp_path/'workflow.db'));m.Base.metadata.create_all(engine)
    with Session(engine) as db:
        users=[m.User(username=n,full_name=n,hashed_password='x',department='QA',role_assignments=[m.UserRole(role='SM')]) for n in ('a','b','author')]
        db.add_all(users);db.flush()
        gateway=m.QARequest(request_id='REQ',application_name='App',department='QA',requester_id=users[2].id,status='RAISED');db.add(gateway);db.flush()
        req=m.FunctionalRequest(request_id='FUNC',qa_request_id=gateway.id,requester_id=users[2].id,status='SM_APPROVAL_PENDING');db.add(req);db.commit();aid,bid,rid=users[0].id,users[1].id,req.id
    with Session(engine) as first,Session(engine) as second:
        stale=second.get(m.FunctionalRequest,rid)
        sm_decision(rid,schemas.WorkflowDecision(decision='Approved'),first,first.get(m.User,aid))
        with pytest.raises(HTTPException):sm_decision(rid,schemas.WorkflowDecision(decision='Rejected',comments='late'),second,second.get(m.User,bid))
        assert stale.status=='DEPARTMENT_HEAD_APPROVAL_PENDING'


def test_orphan_job_fails_but_live_job_is_preserved(tmp_path,monkeypatch):
    monkeypatch.setattr(jobs,'get_upload_root',lambda:str(tmp_path))
    jid='a'*32;user=NS(id=1)
    jobs._write(jid,{'id':jid,'status':'RUNNING','created_by_id':1})
    with jobs.exclusive_file_lock(str(tmp_path/'.jobs'/jid/'worker.lock')) as acquired:
        assert acquired
        assert jobs._authorized_job(jid,user)['status']=='RUNNING'
    assert jobs._authorized_job(jid,user)['status']=='FAILED'


def test_ldap_verifies_certificates(monkeypatch):
    monkeypatch.setattr(auth,'_mock_ldap_profile',lambda *a:(None,False))
    monkeypatch.setattr(auth,'LDAP_SERVER_URI','ldap.example.invalid');monkeypatch.setattr(auth,'LDAP_USE_SSL',True)
    captured=[]
    def server(*a,**kw):
        captured.append(kw);raise RuntimeError('stop before network')
    monkeypatch.setattr(auth,'Server',server)
    with pytest.raises(RuntimeError):auth._ldap_bind_and_fetch('user','password')
    assert captured[0]['tls'].validate==ssl.CERT_REQUIRED


def test_document_cleanup_requires_committed_deletion(tmp_path,monkeypatch):
    monkeypatch.setattr(documents,'get_upload_root',lambda:str(tmp_path))
    monkeypatch.setattr(documents,'resolve_upload_path',lambda path:str(tmp_path/path))
    journal=tmp_path/'.document-deletions'/'intent.json';journal.parent.mkdir()
    journal.write_text(json.dumps({'id':1,'stored_path':'evidence.txt'}))
    evidence=tmp_path/'evidence.txt';evidence.write_text('keep until committed')
    db=Mock();db.get.return_value=object()
    assert documents.cleanup_deleted_documents(db)==0
    assert evidence.exists()
    db.get.return_value=None
    assert documents.cleanup_deleted_documents(db)==1
    assert not evidence.exists()


def test_workflow_scope_restores_identity_and_is_url_independent():
    from app.workflow_authority import configure_request, workflow_context
    from starlette.requests import Request
    user=m.User(username='administrator',role_assignments=[m.UserRole(role='ADMIN')])
    with workflow_context(user,enabled=False):
        assert user.roles==['ADMIN']
        with pytest.raises(HTTPException):
            with workflow_context(user):
                configure_request(NS(info={}),user,Request({'type':'http','path':'/future-renamed-workflow','method':'POST','headers':[]}),workflow=True)
        assert user.roles==['ADMIN']
        assert '_workflow_authority' not in user.__dict__


def test_worker_process_exit_releases_job_lease(tmp_path,monkeypatch):
    import subprocess
    monkeypatch.setattr(jobs,'get_upload_root',lambda:str(tmp_path))
    jid='b'*32;user=NS(id=1)
    jobs._write(jid,{'id':jid,'status':'RUNNING','created_by_id':1})
    lock=tmp_path/'.jobs'/jid/'worker.lock'
    child=subprocess.Popen([sys.executable,'-c',
        'import fcntl,sys,time; f=open(sys.argv[1],"a+b"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(30)',str(lock)],stdout=subprocess.PIPE,text=True)
    try:
        assert child.stdout.readline().strip()=='ready'
        assert jobs._authorized_job(jid,user)['status']=='RUNNING'
    finally:
        child.terminate();child.wait(timeout=5)
        child.stdout.close()
    assert jobs._authorized_job(jid,user)['status']=='FAILED'


def test_ldap_uri_cannot_override_required_ssl(monkeypatch):
    monkeypatch.setattr(auth,'_mock_ldap_profile',lambda *a:(None,False))
    monkeypatch.setattr(auth,'LDAP_SERVER_URI','ldap://directory.example')
    monkeypatch.setattr(auth,'LDAP_USE_SSL',True)
    with pytest.raises(auth.LDAPAuthError):auth._ldap_bind_and_fetch('user','password')
