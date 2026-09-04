import datetime
import unittest
from types import SimpleNamespace

from app import schemas


class ApplicationMasterSchemaTests(unittest.TestCase):
    def application(self, request_id):
        return SimpleNamespace(
            id=10,
            name="TEST APP",
            status="APPROVED",
            department="IT",
            requested_by_id=3,
            qa_request_id=42,
            qa_request=SimpleNamespace(id=42, request_id=request_id, status="DRAFT" if request_id is None else "RAISED"),
            app_owner_decided_by_id=None,
            app_owner_decided_at=None,
            app_owner_comments=None,
            decided_by_id=None,
            decided_at=None,
            comments=None,
            created_at=datetime.datetime(2026, 9, 4),
        )

    def test_application_name_accepts_introducing_draft_without_public_request_id(self):
        result = schemas.ApplicationMasterOut.model_validate(self.application(None))
        self.assertEqual(result.qa_request.id, 42)
        self.assertIsNone(result.qa_request.request_id)

    def test_application_name_keeps_public_id_after_request_is_raised(self):
        result = schemas.ApplicationMasterOut.model_validate(self.application("TQA-REQ-42"))
        self.assertEqual(result.qa_request.request_id, "TQA-REQ-42")


if __name__ == "__main__":
    unittest.main()
