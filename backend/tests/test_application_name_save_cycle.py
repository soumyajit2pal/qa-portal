from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app import models, schemas
from app.constants import GatewayStatus
from app.routers.applications import decide_app_owner_name
from app.workspace_service import workspace_context


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
    requester = models.User(
        username="requester", full_name="Requester",
        department="IT", is_active=True,
        role_assignments=[models.UserRole(role="REQUESTER")],
    )
    gateway = models.QARequest(
        application_name="CYCLE APP", department="IT", requester=requester,
        status=GatewayStatus.SUBMITTED,
    )
    application = models.ApplicationMaster(
        name="CYCLE APP", department="IT", status="PENDING_APP_OWNER",
        requested_by=requester, qa_request=gateway,
    )
    gateway.application_master = application
    db.add_all([owner, requester, gateway, application])
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


def test_application_name_requester_cannot_approve_own_proposal():
    with _session() as db:
        requester = models.User(
            username="dual-role-requester", full_name="Dual Role Requester",
            department="IT", is_active=True,
            role_assignments=[
                models.UserRole(role="REQUESTER"),
                models.UserRole(role="APPLICATION_OWNER"),
            ],
        )
        gateway = models.QARequest(
            application_name="SELF APPROVAL APP", department="IT",
            requester=requester, status=GatewayStatus.SUBMITTED,
        )
        application = models.ApplicationMaster(
            name="SELF APPROVAL APP", department="IT", status="PENDING_APP_OWNER",
            requested_by=requester, qa_request=gateway,
        )
        gateway.application_master = application
        db.add_all([requester, gateway, application])
        db.commit()

        with pytest.raises(HTTPException) as denied:
            decide_app_owner_name(
                application.id,
                schemas.ApplicationMasterDecision(decision="Approved", comments="Self approved"),
                db,
                requester,
            )

        assert denied.value.status_code == 403
        db.refresh(application)
        assert application.status == "PENDING_APP_OWNER"


def test_decision_can_follow_a_reusing_gateway_in_the_active_workspace():
    with _session() as db:
        first_workspace = models.QAWorkspace(
            workspace_key="FIRST", name="First", is_active=True,
        )
        active_workspace = models.QAWorkspace(
            workspace_key="ACTIVE", name="Active", is_active=True,
        )
        first_requester = models.User(
            username="first-requester", full_name="First Requester",
            department="IT", is_active=True,
            role_assignments=[models.UserRole(role="REQUESTER")],
        )
        second_requester = models.User(
            username="second-requester", full_name="Second Requester",
            department="IT", is_active=True,
            role_assignments=[models.UserRole(role="REQUESTER")],
        )
        owner = models.User(
            username="active-owner", full_name="Active Owner",
            department="IT", is_active=True,
            role_assignments=[models.UserRole(role="APPLICATION_OWNER")],
        )
        db.add_all([
            first_workspace, active_workspace, first_requester, second_requester, owner,
        ])
        db.flush()
        first_gateway = models.QARequest(
            application_name="SHARED PENDING APP", department="IT",
            requester=first_requester, qa_workspace=first_workspace,
            status=GatewayStatus.SUBMITTED,
        )
        application = models.ApplicationMaster(
            name="SHARED PENDING APP", department="IT", status="PENDING_APP_OWNER",
            requested_by=first_requester, qa_request=first_gateway,
        )
        first_gateway.application_master = application
        second_gateway = models.QARequest(
            application_name="SHARED PENDING APP", department="IT",
            requester=second_requester, qa_workspace=active_workspace,
            application_master=application, status=GatewayStatus.SUBMITTED,
        )
        db.add_all([first_gateway, application, second_gateway])
        db.flush()
        db.add(models.QAWorkspaceMember(
            workspace_id=active_workspace.id, user_id=owner.id,
            role="WORKSPACE_MEMBER", is_active=True,
        ))
        db.commit()
        owner.active_qa_workspace_id = active_workspace.id

        with workspace_context(active_workspace.id, (active_workspace.id,)), \
                patch("app.routers.qa_requests._promote_draft_upload_folder"), \
                patch("app.routers.qa_requests._promote_draft_checklist_evidence"), \
                patch("app.routers.applications._invalidate_approved_names_cache"):
            decide_app_owner_name(
                application.id,
                schemas.ApplicationMasterDecision(decision="Approved", comments="Reviewed"),
                db,
                owner,
            )

        db.refresh(application)
        db.refresh(first_gateway)
        db.refresh(second_gateway)
        assert application.status == "APPROVED"
        assert first_gateway.status == GatewayStatus.RAISED
        assert second_gateway.status == GatewayStatus.RAISED
