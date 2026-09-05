import tempfile
import unittest

from fastapi import HTTPException, UploadFile

from app.auth import hash_password, verify_password
from app.storage_config import resolve_upload_path
from app.upload_limits import validate_document_uploads


class SecurityHardeningTests(unittest.TestCase):
    def upload(self, name: str, size: int = 1) -> UploadFile:
        stream = tempfile.TemporaryFile()
        self.addCleanup(stream.close)
        stream.truncate(size)
        if name.lower().endswith(".pdf") and size >= 5:
            stream.seek(0)
            stream.write(b"%PDF-")
            stream.seek(0)
        return UploadFile(file=stream, filename=name)

    def test_stored_upload_path_cannot_escape_root(self):
        with self.assertRaises(ValueError):
            resolve_upload_path("../../outside.txt")

    def test_shared_upload_rejects_executable_content(self):
        with self.assertRaises(HTTPException) as raised:
            validate_document_uploads([self.upload("payload.html")])
        self.assertEqual(raised.exception.status_code, 415)

    def test_bcrypt_passwords_are_not_silently_truncated(self):
        with self.assertRaises(ValueError):
            hash_password("a" * 73)
        digest = hash_password("correct horse battery staple")
        self.assertTrue(verify_password("correct horse battery staple", digest))
        self.assertFalse(verify_password("a" * 73, digest))


if __name__ == "__main__":
    unittest.main()
