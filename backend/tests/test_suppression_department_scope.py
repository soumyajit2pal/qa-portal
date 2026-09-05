import unittest
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.routers.dashboard import _scope_fortify_suppression_requests
from app.routers.suppression import _apply_linked_request_identity


class SuppressionDepartmentScopeTests(unittest.TestCase):
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
