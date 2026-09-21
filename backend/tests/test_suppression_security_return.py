import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from app import schemas
from app.routers.suppression import dept_head_decision, resubmit_suppression, security_team_decision


class _Query:
    def __init__(self, record):
        self.record = record

    def filter_by(self, **kwargs):
        return self

    def populate_existing(self):
        return self

    def with_for_update(self):
        return self

    def one_or_none(self):
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

    def test_security_analyst_cannot_decide_own_suppression(self):
        request = self.request()
        actor = _User(request.created_by_id)
        db = _Db(request)

        with self.assertRaises(HTTPException) as denied:
            security_team_decision(
                request.id,
                schemas.WorkflowDecision(decision="Accepted", comments="Self approved"),
                db,
                actor,
            )

        self.assertEqual(denied.exception.status_code, 403)
        self.assertEqual(request.status, "SECURITY_TEAM_VERIFICATION")

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

    def test_department_head_cannot_approve_after_own_sm_decision(self):
        actor = _User(20)
        request = SimpleNamespace(
            id=4,
            status="DEPARTMENT_HEAD_APPROVAL_PENDING",
            created_by_id=10,
            department="Operations",
            sm_id=actor.id,
        )
        db = _Db(request)

        with patch("app.routers.suppression._require_visible"), \
             patch("app.routers.suppression.require_same_department"), \
             patch("app.routers.suppression.require_department_unit_action_scope"), \
             patch("app.routers.suppression._request_department_unit_id", return_value=None):
            with self.assertRaises(HTTPException) as raised:
                dept_head_decision(
                    request.id,
                    schemas.WorkflowDecision(decision="Approved"),
                    db,
                    actor,
                )

        self.assertEqual(raised.exception.status_code, 403)
        self.assertIn("different approver", raised.exception.detail)
        self.assertEqual(request.status, "DEPARTMENT_HEAD_APPROVAL_PENDING")

    def test_system_admin_with_explicit_role_retains_second_stage_oversight(self):
        actor = _User(20)
        actor.role_assignments = [SimpleNamespace(role="ADMIN")]
        request = SimpleNamespace(
            id=5,
            status="DEPARTMENT_HEAD_APPROVAL_PENDING",
            created_by_id=10,
            department="Operations",
            sm_id=actor.id,
            dept_head_decision=None,
            dept_head_id=None,
            dept_head_decided_at=None,
        )
        db = _Db(request)

        with patch("app.routers.suppression._require_visible"), \
             patch("app.routers.suppression.require_same_department"), \
             patch("app.routers.suppression.require_department_unit_action_scope"), \
             patch("app.routers.suppression._request_department_unit_id", return_value=None):
            dept_head_decision(
                request.id,
                schemas.WorkflowDecision(decision="Approved"),
                db,
                actor,
            )

        self.assertEqual(request.status, "SECURITY_TEAM_VERIFICATION")


if __name__ == "__main__":
    unittest.main()
