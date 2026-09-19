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

    def test_shared_upload_accepts_supported_video_signatures(self):
        signatures = {
            "evidence.mp4": b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00",
            "evidence.mov": b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00",
            "evidence.webm": b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x00\x00\x00\x00\x00\x00\x00",
            "evidence.avi": b"RIFF\x10\x00\x00\x00AVI LIST",
        }
        for filename, signature in signatures.items():
            with self.subTest(filename=filename):
                upload = self.upload(filename, len(signature))
                upload.file.seek(0)
                upload.file.write(signature)
                upload.file.seek(0)
                validate_document_uploads([upload])

    def test_shared_upload_accepts_mp4_with_leading_iso_media_box(self):
        # Some valid recorders reserve a free-space box before the file-type
        # box instead of writing ftyp at byte offset four.
        signature = (
            b"\x00\x00\x00\x10free" + b"\x00" * 8
            + b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00isommp42"
        )
        upload = self.upload("recording.mp4", len(signature))
        upload.file.seek(0)
        upload.file.write(signature)
        upload.file.seek(0)
        validate_document_uploads([upload])

    def test_shared_upload_rejects_unstructured_embedded_ftyp_text(self):
        signature = b"not-mp4-ftyp" + b"\x00" * 20
        upload = self.upload("renamed.mp4", len(signature))
        upload.file.seek(0)
        upload.file.write(signature)
        upload.file.seek(0)
        with self.assertRaises(HTTPException) as raised:
            validate_document_uploads([upload])
        self.assertEqual(raised.exception.status_code, 415)

    def test_shared_upload_rejects_video_with_wrong_signature(self):
        with self.assertRaises(HTTPException) as raised:
            validate_document_uploads([self.upload("renamed.mp4", 16)])
        self.assertEqual(raised.exception.status_code, 415)

    def test_bcrypt_passwords_are_not_silently_truncated(self):
        with self.assertRaises(ValueError):
            hash_password("a" * 73)
        digest = hash_password("correct horse battery staple")
        self.assertTrue(verify_password("correct horse battery staple", digest))
        self.assertFalse(verify_password("a" * 73, digest))


if __name__ == "__main__":
    unittest.main()
