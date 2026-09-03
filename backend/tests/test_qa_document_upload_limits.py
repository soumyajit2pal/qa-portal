import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException, UploadFile

from app.upload_limits import QA_DOCUMENT_MAX_BYTES, validate_qa_document_sizes
from app.routers import qa_requests


class QADocumentUploadLimitTests(unittest.TestCase):
    def upload(self, name, size):
        stream = tempfile.TemporaryFile()
        self.addCleanup(stream.close)
        stream.truncate(size)
        # Size metadata must not override the actual file length.
        return UploadFile(file=stream, filename=name, size=0)

    def setUp(self):
        self.db = Mock()
        self.user = SimpleNamespace(id=1, has_role=lambda *roles: True)
        self.req = SimpleNamespace(id=42, request_id="QA-42", status="DRAFT")
        self.db.query.return_value.get.return_value = self.req

    def test_accepts_boundary_and_multiple_evidence_files_above_ten_mb_total(self):
        files = [self.upload("a.pdf", QA_DOCUMENT_MAX_BYTES), self.upload("b.pdf", QA_DOCUMENT_MAX_BYTES)]
        with tempfile.TemporaryDirectory() as root:
            with patch.object(qa_requests, "_draft_request_for_evidence", return_value=self.req), \
                 patch.object(qa_requests, "_draft_evidence_module", return_value="DRAFT_FUNCTIONAL_00"), \
                 patch.object(qa_requests.doc_store, "get_upload_root", return_value=root):
                result = qa_requests.upload_draft_checklist_evidence(42, "functional", 0, files, self.db, self.user)
            self.assertEqual([doc.file_size for doc in result], [QA_DOCUMENT_MAX_BYTES] * 2)
            self.assertEqual(len(list(Path(root).rglob("*.pdf"))), 2)
        self.db.commit.assert_called_once()

    def test_supporting_documents_do_not_use_the_evidence_limit(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(qa_requests.doc_store, "get_upload_root", return_value=root):
                result = qa_requests.upload_documents(
                    42, [self.upload("support.pdf", QA_DOCUMENT_MAX_BYTES + 1)], self.db, self.user,
                )
            self.assertEqual(result[0].file_size, QA_DOCUMENT_MAX_BYTES + 1)

    def test_draft_evidence_rejects_oversized_files_before_storage(self):
        with patch.object(qa_requests, "_draft_request_for_evidence", return_value=self.req), \
             patch.object(qa_requests, "_draft_evidence_module", return_value="DRAFT_FUNCTIONAL_00"), \
             patch.object(qa_requests.doc_store, "save_documents") as save:
            with self.assertRaises(HTTPException) as error:
                qa_requests.upload_draft_checklist_evidence(
                    42, "functional", 0, [self.upload("valid.pdf", 1), self.upload("evidence.pdf", QA_DOCUMENT_MAX_BYTES + 1)], self.db, self.user,
                )
            self.assertEqual(error.exception.status_code, 413)
            save.assert_not_called()

    def test_draft_evidence_accepts_exact_limit(self):
        files = [self.upload("evidence.pdf", QA_DOCUMENT_MAX_BYTES)]
        with patch.object(qa_requests, "_draft_request_for_evidence", return_value=self.req), \
             patch.object(qa_requests, "_draft_evidence_module", return_value="DRAFT_FUNCTIONAL_00"), \
             patch.object(qa_requests.doc_store, "save_documents") as save:
            qa_requests.upload_draft_checklist_evidence(42, "functional", 0, files, self.db, self.user)
            save.assert_called_once()

    def test_validation_preserves_stream_position(self):
        upload = self.upload("small.pdf", 20)
        upload.file.seek(7)
        validate_qa_document_sizes([upload])
        self.assertEqual(upload.file.tell(), 7)


if __name__ == "__main__":
    unittest.main()
