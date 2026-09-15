from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routers.test_repository import (
    _CONTENT_FIELDS,
    _require_returned_correction_owner,
    _submit_draft,
)


@pytest.mark.parametrize("status", ["Returned", "Returned by QA", "Returned by QA Lead"])
def test_only_version_author_can_correct_returned_testcase(status):
    draft = SimpleNamespace(
        status=status,
        author_id=11,
        author=SimpleNamespace(full_name="QA 1"),
    )
    returning_reviewer = SimpleNamespace(id=22)

    with pytest.raises(HTTPException) as exc_info:
        _require_returned_correction_owner(draft, returning_reviewer)

    assert exc_info.value.status_code == 403
    assert "returned to QA 1" in exc_info.value.detail
    assert "Only that author" in exc_info.value.detail


@pytest.mark.parametrize("status", ["Returned", "Returned by QA", "Returned by QA Lead"])
def test_version_author_can_correct_returned_testcase(status):
    draft = SimpleNamespace(
        status=status,
        author_id=11,
        author=SimpleNamespace(full_name="QA 1"),
    )

    _require_returned_correction_owner(draft, SimpleNamespace(id=11))


def test_non_returned_draft_keeps_existing_team_editing_behavior():
    draft = SimpleNamespace(status="Draft", author_id=11, author=None)

    _require_returned_correction_owner(draft, SimpleNamespace(id=22))


def test_author_resubmission_returns_work_to_role_group():
    author_id = 11
    returning_reviewer_id = 22
    draft_values = {field: None for field in _CONTENT_FIELDS}
    draft = SimpleNamespace(
        status="Returned by QA",
        author_id=author_id,
        submitted_by_id=author_id,
        submitted_at=None,
        submit_note=None,
        reviewed_by_id=returning_reviewer_id,
        reviewed_at=object(),
        review_comments="Correct the expected result",
        qa_lead_decided_by_id=None,
        qa_lead_decided_at=None,
        qa_lead_decision_comments=None,
        assigned_reviewer_id=22,
        assigned_qa_lead_id=33,
        version_major=1,
        version_minor=0,
        **draft_values,
    )
    case = SimpleNamespace(id=101, checked_out_by_id=author_id, checked_out_at=object())
    author = SimpleNamespace(id=author_id, roles_csv="QA_ENGINEER")

    class RecordingDb:
        def __init__(self):
            self.added = []

        def add(self, value):
            self.added.append(value)

    db = RecordingDb()
    _submit_draft(db, case, draft, author, "Corrected and resubmitted")

    assert draft.status == "Recommendation Pending"
    assert draft.submitted_by_id == author_id
    assert draft.reviewed_by_id is None
    assert case.checked_out_by_id is None
    assert returning_reviewer_id not in {draft.author_id, draft.submitted_by_id}
    assert draft.assigned_reviewer_id is None
    assert draft.assigned_qa_lead_id is None
