import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.routers.dashboard import _scope_fortify_suppression_requests
from app.routers.suppression import (
    _apply_linked_request_identity,
    _apply_private_status_visibility,
    _require_visible,
)


class _User:
    def __init__(self, user_id, roles=()):
        self.id = user_id
        self.roles = set(roles)

    def has_role(self, *roles):
        return bool(self.roles.intersection(roles))


class SuppressionDepartmentScopeTests(unittest.TestCase):
    def test_requester_workspace_is_passed_to_direct_record_visibility(self):
        request = SimpleNamespace(
            status="Draft", created_by_id=1, department="IT - Software",
            qa_workspace_id=2,
        )
        user = _User(1)

        with (
            patch("app.routers.suppression.require_department_visibility") as department_visibility,
            patch("app.routers.suppression.require_department_unit_visibility"),
            patch("app.routers.suppression._request_department_unit_id", return_value=None),
        ):
            _require_visible(None, request, user)

        department_visibility.assert_called_once_with(
            user, "IT - Software", requester_id=1, entity_workspace_id=2,
        )

    def test_draft_is_not_visible_to_same_department_reviewer(self):
        request = SimpleNamespace(
            status="Draft", created_by_id=1, department="IT - Software",
            qa_workspace_id=2,
        )
        with self.assertRaises(HTTPException) as raised:
            _require_visible(None, request, _User(11, roles=("SM",)))

        self.assertEqual(raised.exception.status_code, 404)

    def test_list_hides_other_users_drafts_but_keeps_requesters_own(self):
        engine = create_engine("sqlite:///:memory:")
        db = sessionmaker(bind=engine)()
        try:
            query = _apply_private_status_visibility(
                db.query(models.SuppressionRequest), _User(1),
            )
            sql = str(query.statement.compile(compile_kwargs={"literal_binds": True}))
        finally:
            db.close()
            engine.dispose()

        self.assertIn("status NOT IN ('Draft')", sql)
        self.assertIn("created_by_id = 1", sql)

    def test_identity_is_derived_from_linked_security_request(self):
        payload = {
            "application_name": "Modified by client",
            "department": "Another Department",
            "application_owner": "Another Owner",
            "scan_type": "DAST",
        }
        linked = SimpleNamespace(
            request_id="TQA-SAST-101",
            application_name="Payments Portal",
            department="IT - Software",
            application_owner="Application Owner",
        )

        _apply_linked_request_identity(payload, linked, "SAST")

        self.assertEqual(payload["application_name"], "Payments Portal")
        self.assertEqual(payload["department"], "IT - Software")
        self.assertEqual(payload["application_owner"], "Application Owner")
        self.assertEqual(payload["scan_type"], "SAST")

    def test_missing_qa_department_is_rejected(self):
        linked = SimpleNamespace(
            request_id="TQA-SAST-102",
            application_name="Payments Portal",
            department=None,
            application_owner="Application Owner",
        )

        with self.assertRaises(HTTPException) as raised:
            _apply_linked_request_identity({}, linked, "SAST")

        self.assertEqual(raised.exception.status_code, 409)

    def test_fortify_scope_uses_parent_or_suppression_department(self):
        engine = create_engine("sqlite:///:memory:")
        db = sessionmaker(bind=engine)()
        try:
            query = _scope_fortify_suppression_requests(
                db.query(models.SASTRequest),
                models.SASTRequest,
                ["IT - Software"],
            )
            sql = str(query.statement.compile(compile_kwargs={"literal_binds": True}))
        finally:
            db.close()
            engine.dispose()

        self.assertIn("LEFT OUTER JOIN qap_requests", sql)
        self.assertIn("qap_requests.department IN ('IT - Software')", sql)
        self.assertIn("EXISTS", sql)
        self.assertIn("qap_suppression_requests.sast_request_id = qap_sast_requests.id", sql)
        self.assertIn("qap_suppression_requests.department IN ('IT - Software')", sql)


if __name__ == "__main__":
    unittest.main()
