import unittest
from types import SimpleNamespace

from app import schemas
from app.routers.suppression import resubmit_suppression, security_team_decision


class _Query:
    def __init__(self, record):
        self.record = record

    def filter_by(self, **kwargs):
        return self

    def populate_existing(self):
        return self

    def with_for_update(self):
        return self

    def first(self):
        return self.get(None)

    def get(self, _record_id):
        return self.record


class _Db:
    def __init__(self, record):
        self.record = record
        self.added = []

    def query(self, _model):
        return _Query(self.record)

    def add(self, value):
        self.added.append(value)

    def commit(self):
        pass

    def refresh(self, _value):
        pass


class _User:
    def __init__(self, user_id):
        self.id = user_id
        self.roles_csv = "REQUESTER"

    def has_role(self, *_roles):
        return False


class SuppressionSecurityReturnTests(unittest.TestCase):
    def request(self):
        return SimpleNamespace(
            id=3,
            status="SECURITY_TEAM_VERIFICATION",
            created_by_id=10,
            security_decision=None,
            security_id=None,
            security_decided_at=None,
            needs_dept_head_reapproval=False,
        )

    def test_security_return_keeps_security_team_as_return_actor(self):
        request = self.request()
        db = _Db(request)

        security_team_decision(
            request.id,
            schemas.WorkflowDecision(
                decision="Returned",
                comments="Please correct the justification",
                require_dept_head_reapproval=True,
            ),
            db,
            _User(20),
        )

        self.assertEqual(request.status, "RETURNED_BY_SECURITY_TEAM")
        self.assertTrue(request.needs_dept_head_reapproval)

    def test_security_return_with_reapproval_routes_resubmit_to_department_head(self):
        request = self.request()
        request.status = "RETURNED_BY_SECURITY_TEAM"
        request.needs_dept_head_reapproval = True
        db = _Db(request)

        resubmit_suppression(request.id, db, _User(request.created_by_id))

        self.assertEqual(request.status, "DEPARTMENT_HEAD_APPROVAL_PENDING")
        self.assertFalse(request.needs_dept_head_reapproval)

    def test_security_return_without_reapproval_routes_back_to_security_team(self):
        request = self.request()
        request.status = "RETURNED_BY_SECURITY_TEAM"
        db = _Db(request)

        resubmit_suppression(request.id, db, _User(request.created_by_id))

        self.assertEqual(request.status, "SECURITY_TEAM_VERIFICATION")
        self.assertFalse(request.needs_dept_head_reapproval)


if __name__ == "__main__":
    unittest.main()
