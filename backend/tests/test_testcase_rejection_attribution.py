import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from unittest.mock import Mock, patch

from app import models, schemas
from app.routers import test_repository


@pytest.mark.parametrize("lead_decision", [False, True])
def test_rejected_testcase_response_preserves_decision_stage(lead_decision):
    reviewer = models.User(id=2, full_name="qa2")
    lead = models.User(id=3, full_name="lead1")
    version = models.TestCaseVersion(
        id=10, status="Rejected", version_major=1, version_minor=0,
        reviewed_by_id=reviewer.id, reviewed_by=reviewer,
        qa_lead_decided_by_id=lead.id if lead_decision else None,
        qa_lead_decided_by=lead if lead_decision else None,
    )
    case = models.TestCase(
        id=390, test_case_key="TQA-TC-390", project_id=1, status="Rejected", is_deleted=False,
        current_draft_version_id=version.id, current_draft_version=version,
        created_at=datetime.datetime(2026, 9, 19), updated_at=datetime.datetime(2026, 9, 19),
    )
    response = schemas.TestCaseOut.model_validate(case)
    assert response.current_draft_reviewed_by_id == 2
    assert response.current_draft_reviewed_by_name == "qa2"
    assert response.current_draft_qa_lead_decided_by_id == (3 if lead_decision else None)
    assert response.current_draft_qa_lead_decided_by_name == ("lead1" if lead_decision else None)


@pytest.mark.parametrize("endpoint", ["checkout_test_case", "checkout_override", "update_test_case"])
def test_rejected_case_cannot_be_reopened_even_by_administrator(endpoint):
    case = models.TestCase(id=390, project_id=1, status="Rejected")
    actor = models.User(id=1, role_assignments=[models.UserRole(role="ADMIN")])
    db = Mock()
    with patch.object(test_repository, "get_or_404", return_value=case), \
            patch.object(test_repository, "_get_project_or_404"), \
            patch.object(test_repository, "_require_active_project"), \
            patch.object(test_repository, "require_can_author_repository"), \
            patch.object(test_repository, "require_can_manage_repository_governance"), \
            patch.object(test_repository, "_lock_case_version_state"):
        args = {"case_id": case.id, "db": db, "current_user": actor}
        if endpoint == "update_test_case":
            args["payload"] = schemas.TestCaseUpdate(test_scenario="Correction")
        elif endpoint == "checkout_override":
            args["payload"] = schemas.TestCaseCheckoutOverride(reason="Recovery")
        with pytest.raises(HTTPException) as error:
            getattr(test_repository, endpoint)(**args)
        assert error.value.status_code == 409
        assert "Clone" in error.value.detail
        db.commit.assert_not_called()


@pytest.mark.parametrize("endpoint,payload_type", [
    (test_repository.bulk_return_test_cases, schemas.TestCaseBulkReturn),
    (test_repository.bulk_reject_test_cases, schemas.TestCaseBulkReject),
])
def test_stage_two_bulk_decision_preserves_stage_one_reviewer_attribution(endpoint, payload_type):
    reviewed_at = datetime.datetime(2026, 9, 19, 10, 30)
    draft = SimpleNamespace(
        status="QA Lead Approval Pending",
        reviewed_by_id=17,
        reviewed_at=reviewed_at,
        review_comments="Recommended by QA reviewer",
        qa_lead_decided_by_id=None,
        qa_lead_decided_at=None,
        qa_lead_decision_comments=None,
    )
    case = SimpleNamespace(id=390, current_draft_version=draft)
    actor = models.User(id=23, username="lead", full_name="QA Lead", hashed_password="x")
    db = Mock()

    with patch.object(test_repository, "_get_project_or_404", return_value=Mock(is_active=True)), \
            patch.object(test_repository, "_require_active_project"), \
            patch.object(test_repository, "_bulk_new_path_decision_rows", return_value=[case]), \
            patch.object(test_repository, "_sync_case_mirror"), \
            patch.object(test_repository, "_case_workflow_action", return_value=Mock()):
        endpoint(
            7,
            payload_type(ids=[case.id], comments="Stage 2 decision"),
            db=db,
            current_user=actor,
        )

    assert draft.reviewed_by_id == 17
    assert draft.reviewed_at == reviewed_at
    assert draft.review_comments == "Recommended by QA reviewer"
    assert draft.qa_lead_decided_by_id == actor.id
    assert draft.qa_lead_decided_at is not None
    assert draft.qa_lead_decision_comments == "Stage 2 decision"
