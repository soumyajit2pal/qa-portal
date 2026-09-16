import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import certificate_summary, models, schemas
from app.constants import Role
from app.routers import functional as functional_router, signoff


@pytest.fixture
def linked_requests(monkeypatch):
    # Oracle's business-ID MERGE is unavailable in this SQLite unit fixture.
    monkeypatch.setattr(models, '_claim_business_seq', lambda *args: 1)
    engine = create_engine('sqlite:///:memory:')
    models.Base.metadata.create_all(engine)
    with Session(engine) as db:
        workspace = models.QAWorkspace(workspace_key='QA', name='Quality', is_active=True)
        user = models.User(username='tester', full_name='Tester', hashed_password='x',
                           is_active=True, role_assignments=[models.UserRole(role=Role.QA_ENGINEER)])
        db.add_all([workspace, user]); db.flush()
        parent = models.QARequest(request_id='TQA-REQ-SEC', application_name='Payments',
                                  department='IT', requester_id=user.id,
                                  qa_workspace_id=workspace.id,
                                  request_types='Functional Testing, SAST, DAST', status='RAISED')
        db.add(parent); db.flush()
        functional = models.FunctionalRequest(request_id='TQA-FUNC-SEC', qa_request_id=parent.id,
                                              status='QA_COMPLETED')
        sast = models.SASTRequest(request_id='TQA-SAST-SEC', application_name='Payments',
                                  qa_request_id=parent.id, status='REPORT_READY')
        dast = models.DASTRequest(request_id='TQA-DAST-SEC', qa_request_id=parent.id,
                                  status='CLOSED')
        db.add_all([functional, sast, dast]); db.commit()
        yield db, workspace, user, functional, sast, dast
    engine.dispose()


def payload():
    return schemas.SignOffCreate(certificate_type='Full Clearance', testing_type='Functional',
                                 testing_request_id='TQA-FUNC-SEC', application_name='Payments',
                                 environment_tested='UAT', target_promotion_environment='Production')


def test_clearance_creation_waits_for_every_security_sibling(linked_requests):
    db, workspace, user, functional, sast, dast = linked_requests
    with pytest.raises(HTTPException) as error:
        signoff.create_signoff(payload(), db, user)
    assert error.value.status_code == 409
    assert 'TQA-SAST-SEC (REPORT_READY)' in error.value.detail
    assert db.query(models.QASignOff).count() == 0

    sast.status = 'CLOSED'
    dast.status = 'SECURITY_APPROVAL_PENDING'
    db.flush()
    with pytest.raises(HTTPException) as error:
        signoff.create_signoff(payload(), db, user)
    assert 'TQA-DAST-SEC (SECURITY_APPROVAL_PENDING)' in error.value.detail

    dast.status = 'CLOSED'
    db.flush()
    created = signoff.create_signoff(payload(), db, user)
    assert created.status == 'DRAFT'
    assert len(created.certificate_summary['security']) == 2


def test_selected_security_type_without_child_blocks_clearance(linked_requests):
    db, _, _, functional, sast, dast = linked_requests
    db.delete(sast)
    db.flush()
    with pytest.raises(HTTPException) as error:
        certificate_summary.require_linked_security_closed(db, functional)
    assert 'SAST child request missing' in error.value.detail


def test_functional_only_parent_has_no_security_prerequisite(linked_requests):
    db, _, _, functional, sast, dast = linked_requests
    functional.qa_request.request_types = 'Functional Testing'
    db.delete(sast)
    db.delete(dast)
    db.flush()
    certificate_summary.require_linked_security_closed(db, functional)


def test_existing_draft_cannot_submit_if_security_reopens(linked_requests):
    db, _, user, _, sast, dast = linked_requests
    sast.status = 'CLOSED'
    db.flush()
    created = signoff.create_signoff(payload(), db, user)
    sast.status = 'REPORT_READY'
    db.flush()
    with pytest.raises(HTTPException) as error:
        signoff.submit_signoff(created.id, db, user)
    assert error.value.status_code == 409
    assert created.status == 'DRAFT'


def test_direct_functional_clearance_transition_cannot_bypass_gate(linked_requests, monkeypatch):
    db, _, user, functional, sast, dast = linked_requests
    monkeypatch.setattr(functional_router, '_require_assigned_qa_lead_or_current_tester',
                        lambda *args: None)
    with pytest.raises(HTTPException) as error:
        functional_router.request_signoff(functional.id, schemas.RequestSignoffIn(), db, user)
    assert error.value.status_code == 409
    db.refresh(functional)
    assert functional.status == 'QA_COMPLETED'
