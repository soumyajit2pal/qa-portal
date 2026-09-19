from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app import models, schemas
from app.constants import GatewayStatus
from app.routers.applications import decide_app_owner_name


def _session():
    engine = create_engine("sqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    models.Base.metadata.create_all(engine)
    return Session(engine)


def _linked_pair(db):
    owner = models.User(
        username="application-owner", full_name="Application Owner",
        department="IT", is_active=True,
        role_assignments=[models.UserRole(role="APPLICATION_OWNER")],
    )
    gateway = models.QARequest(
        application_name="CYCLE APP", department="IT", requester=owner,
        status=GatewayStatus.SUBMITTED,
    )
    application = models.ApplicationMaster(
        name="CYCLE APP", department="IT", status="PENDING_APP_OWNER",
        requested_by=owner, qa_request=gateway,
    )
    gateway.application_master = application
    db.add_all([owner, gateway, application])
    return owner, gateway, application


def test_new_mutually_linked_application_and_gateway_can_commit():
    with _session() as db:
        _, gateway, application = _linked_pair(db)
        db.commit()
        db.expire_all()
        assert application.qa_request_id == gateway.id
        assert gateway.application_master_id == application.id
        assert application.qa_request is gateway
        assert gateway.application_master is application


@pytest.mark.parametrize("decision", ["Approved", "Rejected"])
def test_owner_decision_commits_both_linked_records(decision):
    with _session() as db:
        owner, gateway, application = _linked_pair(db)
        db.commit()
        # Load both sides, as the permission checks and response do.
        assert application.qa_request.application_master is application
        with patch("app.routers.qa_requests._promote_draft_upload_folder"), \
                patch("app.routers.qa_requests._promote_draft_checklist_evidence"), \
                patch("app.routers.applications._invalidate_approved_names_cache"):
            result = decide_app_owner_name(
                application.id,
                schemas.ApplicationMasterDecision(decision=decision, comments="Reviewed"),
                db, owner,
            )
        db.expire_all()
        assert result.status == decision.upper()
        assert gateway.status == (
            GatewayStatus.RAISED if decision == "Approved" else GatewayStatus.DRAFT
        )
        assert result.qa_request_id == gateway.id
        assert gateway.application_master_id == result.id
        assert result.app_owner_decided_by_id == owner.id
        assert db.query(models.ApprovalAction).filter_by(
            entity_type="QA_REQUEST", entity_id=gateway.id,
            step_name="Application Name (Application Owner)", decision=decision,
        ).count() == 1
