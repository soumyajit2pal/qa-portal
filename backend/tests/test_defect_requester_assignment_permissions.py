from types import SimpleNamespace

import pytest

from app.constants import Role
from app import schemas
from app.routers.defects import CREATE_ROLES, STATUSES, TRANSITIONS, _qa_disposition_blocked_for_requester_assignment
from app.routers.test_execution import _DEFECT_CYCLE_COMPLETION_BLOCKING_STATUSES


@pytest.mark.parametrize("status", ["Rejected", "Duplicate", "Not a Defect"])
def test_qa_dispositions_are_blocked_while_requester_owns_assignment(status):
    defect = SimpleNamespace(assignee_is_requester=True)
    qa_user = SimpleNamespace(roles=["QA_ENGINEER"])

    assert _qa_disposition_blocked_for_requester_assignment(defect, qa_user, status)


def test_normal_progress_action_is_not_blocked():
    defect = SimpleNamespace(assignee_is_requester=True)
    qa_user = SimpleNamespace(roles=["QA_LEAD"])

    assert not _qa_disposition_blocked_for_requester_assignment(defect, qa_user, "In Progress")


def test_requester_and_admin_are_not_treated_as_qa_disposition_actors():
    defect = SimpleNamespace(assignee_is_requester=True)

    assert not _qa_disposition_blocked_for_requester_assignment(
        defect, SimpleNamespace(roles=["REQUESTER"]), "Rejected"
    )
    assert not _qa_disposition_blocked_for_requester_assignment(
        defect, SimpleNamespace(roles=["ADMIN", "QA_LEAD"]), "Rejected"
    )


def test_qa_disposition_rule_does_not_apply_before_requester_assignment():
    defect = SimpleNamespace(assignee_is_requester=False)
    qa_user = SimpleNamespace(roles=["QA_ENGINEER"])

    assert not _qa_disposition_blocked_for_requester_assignment(defect, qa_user, "Duplicate")


@pytest.mark.parametrize("terminal_status", ["Rejected", "Not a Defect"])
def test_reviewable_terminal_decisions_can_be_reopened(terminal_status):
    assert "Reopened" in TRANSITIONS[terminal_status]


def test_duplicate_remains_terminal():
    assert TRANSITIONS["Duplicate"] == set()


def test_every_defect_status_has_a_valid_transition_contract():
    assert set(TRANSITIONS) == set(STATUSES)
    assert all(set(targets).issubset(STATUSES) for targets in TRANSITIONS.values())


def test_standard_defect_lifecycle_is_complete():
    path = ["New", "Triaged", "In Progress", "Resolved", "Retest", "Closed"]
    assert all(next_status in TRANSITIONS[current] for current, next_status in zip(path, path[1:]))


def test_assignment_is_not_a_new_lifecycle_transition():
    assert all("Assigned" not in targets for targets in TRANSITIONS.values())
    assert TRANSITIONS["Assigned"] == {"In Progress", "Rejected", "Duplicate", "Not a Defect", "Deferred"}


def test_resolution_transition_accepts_explicit_retest_owner():
    payload = schemas.DefectTransition(status="Resolved", retest_tester_id=42)

    assert payload.retest_tester_id == 42


def test_active_investigation_can_be_resolved_as_not_a_defect():
    assert "Not a Defect" in TRANSITIONS["In Progress"]


def test_triaged_defects_block_cycle_completion():
    assert "Triaged" in _DEFECT_CYCLE_COMPLETION_BLOCKING_STATUSES


def test_agm_qa_has_full_defect_creation_authority():
    assert Role.AGM_QA in CREATE_ROLES
