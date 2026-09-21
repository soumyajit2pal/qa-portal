from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.routers.test_repository import (
    checkout_test_case,
    checkin_test_case,
    _next_major_version_numbers,
    _next_provisional_version_numbers,
    _require_checkout_holder_for_edit,
)
from app.routers import test_repository


def version(major, minor):
    return SimpleNamespace(version_major=major, version_minor=minor)


def test_next_draft_skips_rejected_or_superseded_version_numbers():
    approved = version(1, 1)
    case = SimpleNamespace(
        current_approved_version=approved,
        versions=[version(1, 0), approved, version(1, 2)],
    )

    assert _next_provisional_version_numbers(case) == (1, 3)


def test_next_draft_uses_full_history_before_first_approval():
    case = SimpleNamespace(
        current_approved_version=None,
        versions=[version(1, 0), version(1, 1)],
    )

    assert _next_provisional_version_numbers(case) == (1, 2)


def test_major_approval_never_reuses_a_historical_major_number():
    approved = version(1, 4)
    case = SimpleNamespace(
        current_approved_version=approved,
        versions=[approved, version(2, 0)],
    )

    assert _next_major_version_numbers(case) == (3, 0)


def test_save_requires_current_user_to_hold_checkout():
    case = SimpleNamespace(
        test_case_key="TQA-TC-50",
        checked_out_by_id=None,
        checked_out_by_name=None,
    )

    with pytest.raises(HTTPException) as exc_info:
        _require_checkout_holder_for_edit(case, SimpleNamespace(id=10))

    assert exc_info.value.status_code == 409
    assert "Start editing" in exc_info.value.detail


def test_save_is_allowed_for_checkout_holder_only():
    case = SimpleNamespace(
        test_case_key="TQA-TC-50",
        checked_out_by_id=10,
        checked_out_by_name="QA 1",
    )

    _require_checkout_holder_for_edit(case, SimpleNamespace(id=10))

    with pytest.raises(HTTPException) as exc_info:
        _require_checkout_holder_for_edit(case, SimpleNamespace(id=20))

    assert exc_info.value.status_code == 423
    assert "QA 1" in exc_info.value.detail


def test_start_and_finish_editing_only_change_the_checkout(monkeypatch):
    versions = [version(1, 0), version(1, 1)]
    case = SimpleNamespace(
        id=50,
        project_id=7,
        is_deleted=False,
        status="Draft",
        current_draft_version=None,
        current_draft_version_id=None,
        versions=versions,
        checked_out_by_id=None,
        checked_out_by_name=None,
        checked_out_at=None,
    )
    project = SimpleNamespace(is_active=True)
    user = SimpleNamespace(id=10)
    db = MagicMock()
    monkeypatch.setattr(test_repository, "get_or_404", lambda *_args: case)
    monkeypatch.setattr(test_repository, "_get_project_or_404", lambda *_args: project)
    monkeypatch.setattr(test_repository, "require_can_author_repository", lambda *_args: None)
    monkeypatch.setattr(test_repository, "_lock_case_version_state", lambda *_args: None)

    checkout_test_case(case.id, db, user)

    assert case.checked_out_by_id == user.id
    assert case.current_draft_version_id is None
    assert case.versions == versions

    checkin_test_case(case.id, db, user)

    assert case.checked_out_by_id is None
    assert case.current_draft_version_id is None
    assert case.versions == versions
