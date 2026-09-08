import unittest
from types import SimpleNamespace

from app.routers.suppression import _can_edit_details


class UserStub:
    def __init__(self, user_id, roles=(), departments=()):
        self.id = user_id
        self._roles = set(roles)
        self._departments = set(departments)

    def has_role(self, *roles):
        return bool(self._roles.intersection(roles))

    def has_department(self, department):
        return department in self._departments


class SuppressionEditPermissionTests(unittest.TestCase):
    def request(self, status):
        return SimpleNamespace(status=status, created_by_id=10, department="IT")

    def test_requester_can_edit_draft_and_returned_request(self):
        requester = UserStub(10)
        for status in ("Draft", "RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_TEAM"):
            with self.subTest(status=status):
                self.assertTrue(_can_edit_details(self.request(status), requester))

    def test_requester_cannot_edit_while_request_is_with_reviewer(self):
        requester = UserStub(10)
        self.assertFalse(_can_edit_details(self.request("SM_APPROVAL_PENDING"), requester))
        self.assertFalse(_can_edit_details(self.request("DEPARTMENT_HEAD_APPROVAL_PENDING"), requester))

    def test_reviewers_can_edit_only_their_own_pending_stage_and_department(self):
        sm = UserStub(20, roles=("SM",), departments=("IT",))
        head = UserStub(21, roles=("DEPARTMENT_HEAD_CM",), departments=("IT",))
        wrong_department_sm = UserStub(22, roles=("SM",), departments=("Finance",))

        self.assertTrue(_can_edit_details(self.request("SM_APPROVAL_PENDING"), sm))
        self.assertFalse(_can_edit_details(self.request("DEPARTMENT_HEAD_APPROVAL_PENDING"), sm))
        self.assertTrue(_can_edit_details(self.request("DEPARTMENT_HEAD_APPROVAL_PENDING"), head))
        self.assertFalse(_can_edit_details(self.request("SM_APPROVAL_PENDING"), head))
        self.assertFalse(_can_edit_details(self.request("SM_APPROVAL_PENDING"), wrong_department_sm))

    def test_security_stage_and_terminal_requests_are_locked(self):
        analyst = UserStub(30, roles=("SECURITY_ANALYST",), departments=("IT",))
        self.assertFalse(_can_edit_details(self.request("SECURITY_TEAM_VERIFICATION"), analyst))
        self.assertFalse(_can_edit_details(self.request("Done"), analyst))
        self.assertFalse(_can_edit_details(self.request("Rejected"), analyst))


if __name__ == "__main__":
    unittest.main()
