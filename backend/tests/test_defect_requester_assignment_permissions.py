from types import SimpleNamespace

import pytest

from app.constants import Role
from app import schemas
from app.routers.defects import CREATE_ROLES, NAD_QA_OUTCOMES, RESOLUTION_TYPES, STATUSES, TRANSITIONS, _qa_disposition_blocked_for_requester_assignment
from app.routers import test_execution
from app.routers.test_execution import _DEFECT_CYCLE_COMPLETION_BLOCKING_STATUSES, _DEFECT_RETEST_CLEAR_STATUSES


@pytest.mark.parametrize("status", ["Rejected", "Duplicate"])
def test_qa_dispositions_are_blocked_while_requester_owns_assignment(status):
    defect = SimpleNamespace(assignee_is_requester=True)
    qa_user = SimpleNamespace(roles=["QA_ENGINEER"])

    assert _qa_disposition_blocked_for_requester_assignment(defect, qa_user, status)


def test_normal_progress_action_is_not_blocked():
    defect = SimpleNamespace(assignee_is_requester=True)
    qa_user = SimpleNamespace(roles=["QA_LEAD"])

    assert not _qa_disposition_blocked_for_requester_assignment(defect, qa_user, "In Progress")


def test_not_a_defect_proposal_is_not_blocked_by_requester_assignment():
    defect = SimpleNamespace(assignee_is_requester=True)
    qa_user = SimpleNamespace(roles=["QA_ENGINEER"])

    assert not _qa_disposition_blocked_for_requester_assignment(
        defect, qa_user, "Not a Defect Review"
    )


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


@pytest.mark.parametrize("terminal_status", ["Rejected", "Not a Defect", "Change Request Raised"])
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
    assert TRANSITIONS["Assigned"] == {"In Progress", "Rejected", "Duplicate", "Not a Defect Review", "Deferred"}


def test_resolution_transition_accepts_explicit_retest_owner():
    payload = schemas.DefectTransition(status="Resolved", retest_tester_id=42)

    assert payload.retest_tester_id == 42


def test_active_investigation_requires_independent_not_a_defect_review():
    assert "Not a Defect Review" in TRANSITIONS["In Progress"]
    assert "Not a Defect" not in TRANSITIONS["In Progress"]
    assert TRANSITIONS["Not a Defect Review"] == {"Not a Defect", "Change Request Raised", "Reopened"}


def test_triaged_defects_block_cycle_completion():
    assert "Triaged" in _DEFECT_CYCLE_COMPLETION_BLOCKING_STATUSES


def test_not_a_defect_review_blocks_cycle_completion_until_qa_decides():
    assert "Not a Defect Review" in _DEFECT_CYCLE_COMPLETION_BLOCKING_STATUSES
    assert "Not a Defect Review" not in _DEFECT_RETEST_CLEAR_STATUSES
    assert "Not a Defect" in _DEFECT_RETEST_CLEAR_STATUSES
    assert "Change Request Raised" in _DEFECT_RETEST_CLEAR_STATUSES


def test_qa_triage_classifications_do_not_leak_into_normal_fix_resolution_types():
    qa_only = {"Requirement Misunderstanding", "Test Data Issue", "Configuration Issue", "Documentation Updated"}
    assert qa_only.issubset(NAD_QA_OUTCOMES)
    assert qa_only.isdisjoint(RESOLUTION_TYPES)
    assert "Enhancement / Change Request" not in RESOLUTION_TYPES


def test_na_is_allowed_after_failure_for_referenced_change_request(monkeypatch):
    defects = [SimpleNamespace(
        defect_key="TQA-DEF-14", status="Change Request Raised", related_cr_number="CR-2041",
    )]
    monkeypatch.setattr(test_execution, "_execution_lock_state", lambda *_: ([], True, defects))

    assert test_execution._execution_status_gate(None, 88, "NA") is None
    assert "no longer available" in test_execution._execution_status_gate(None, 88, "Pass")


@pytest.mark.parametrize("has_prior_failure", [False, True])
def test_na_is_blocked_when_change_request_reference_is_missing(monkeypatch, has_prior_failure):
    defects = [SimpleNamespace(
        defect_key="TQA-DEF-14", status="Change Request Raised", related_cr_number=" ",
    )]
    monkeypatch.setattr(test_execution, "_execution_lock_state", lambda *_: ([], has_prior_failure, defects))

    violation = test_execution._execution_status_gate(None, 88, "NA")
    assert "do not have a CR/enhancement reference" in violation
    assert "TQA-DEF-14" in violation


def test_na_change_request_exception_never_bypasses_an_active_defect(monkeypatch):
    active = SimpleNamespace(defect_key="TQA-DEF-15", status="In Progress")
    defects = [
        active,
        SimpleNamespace(defect_key="TQA-DEF-14", status="Change Request Raised", related_cr_number="CR-2041"),
    ]
    monkeypatch.setattr(test_execution, "_execution_lock_state", lambda *_: ([active], True, defects))

    assert "TQA-DEF-15 (In Progress)" in test_execution._execution_status_gate(None, 88, "NA")


def test_agm_qa_has_full_defect_creation_authority():
    assert Role.AGM_QA in CREATE_ROLES
