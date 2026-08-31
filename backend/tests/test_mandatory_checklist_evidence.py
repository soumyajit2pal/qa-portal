import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.routers.qa_requests import _missing_mandatory_draft_evidence


class MandatoryChecklistEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.db = Mock()
        self.db.query.return_value.filter.return_value.all.return_value = []
        self.request = SimpleNamespace(id=42)
        self.templates = [SimpleNamespace(item="Approved test data", is_mandatory=True)]

    @patch("app.routers.qa_requests.get_template_items")
    def test_reports_missing_evidence_for_a_mandatory_item(self, get_template_items):
        get_template_items.return_value = self.templates

        missing = _missing_mandatory_draft_evidence(self.db, self.request, ["Functional Testing"])

        self.assertEqual(missing, ["Approved test data"])

    @patch("app.routers.qa_requests.get_template_items")
    def test_accepts_a_real_uploaded_file_for_the_mandatory_item(self, get_template_items):
        get_template_items.return_value = self.templates
        self.db.query.return_value.filter.return_value.all.return_value = [
            SimpleNamespace(module="DRAFT_FUNCTIONAL_00", stored_path="DRAFT-42/functional-0/evidence.pdf")
        ]
        with tempfile.NamedTemporaryFile() as uploaded:
            with patch("app.routers.qa_requests.doc_store.full_path", return_value=uploaded.name):
                missing = _missing_mandatory_draft_evidence(
                    self.db, self.request, ["Functional Testing"]
                )

        self.assertEqual(missing, [])

    @patch("app.routers.qa_requests.get_template_items")
    def test_sanity_testing_uses_the_functional_checklist(self, get_template_items):
        get_template_items.return_value = self.templates

        missing = _missing_mandatory_draft_evidence(self.db, self.request, ["Sanity Testing"])

        self.assertEqual(missing, ["Approved test data"])


if __name__ == "__main__":
    unittest.main()
