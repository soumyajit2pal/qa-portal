import asyncio
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile

from app.routers import document_portal


class DocumentPortalTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.original_root = document_portal.DOCUMENT_ROOT
        document_portal.DOCUMENT_ROOT = self.root

    def tearDown(self):
        document_portal.DOCUMENT_ROOT = self.original_root
        self.tempdir.cleanup()

    def test_blocks_traversal_and_symlinks(self):
        with self.assertRaises(HTTPException) as traversal:
            document_portal._path("../outside")
        self.assertEqual(traversal.exception.status_code, 400)
        target = self.root / "target"
        target.mkdir()
        (self.root / "link").symlink_to(target, target_is_directory=True)
        with self.assertRaises(HTTPException) as link:
            document_portal._path("link")
        self.assertEqual(link.exception.status_code, 400)

    def test_creates_lists_renames_and_moves_nested_folder(self):
        user = SimpleNamespace()
        document_portal.create_folder(document_portal.FolderCreate(name="Evidence"), user)
        document_portal.create_folder(document_portal.FolderCreate(path="Evidence", name="Release"), user)
        response = document_portal.browse(path="Evidence", sort="name", order="asc", _=user)
        self.assertEqual([item["name"] for item in response["items"]], ["Release"])
        document_portal.rename(document_portal.RenameItem(path="Evidence/Release", name="August"), user)
        document_portal.move(document_portal.MoveItem(path="Evidence/August", destination=""), user)
        self.assertTrue((self.root / "August").is_dir())

    def test_zip_keeps_empty_folder_and_nested_files(self):
        evidence = self.root / "Evidence"
        (evidence / "Empty").mkdir(parents=True)
        (evidence / "run.txt").write_text("approved", encoding="utf-8")
        archive = document_portal._archive([evidence], "evidence")
        try:
            with zipfile.ZipFile(archive) as zipped:
                self.assertIn("Evidence/Empty/", zipped.namelist())
                self.assertIn("Evidence/run.txt", zipped.namelist())
        finally:
            archive.unlink(missing_ok=True)

    def test_upload_preserves_folder_hierarchy_and_duplicate_keep(self):
        user = SimpleNamespace()

        def upload_file(contents: bytes):
            stream = tempfile.SpooledTemporaryFile()
            stream.write(contents)
            stream.seek(0)
            return UploadFile(filename="checklist.txt", file=stream)

        first = asyncio.run(document_portal.upload(
            path="", relative_path="Evidence/Release/checklist.txt", duplicate="keep",
            file=upload_file(b"first"), _=user,
        ))
        second = asyncio.run(document_portal.upload(
            path="", relative_path="Evidence/Release/checklist.txt", duplicate="keep",
            file=upload_file(b"second"), _=user,
        ))
        self.assertEqual(first["item"]["path"], "Evidence/Release/checklist.txt")
        self.assertEqual(second["item"]["path"], "Evidence/Release/checklist (1).txt")
        self.assertEqual((self.root / "Evidence/Release/checklist.txt").read_bytes(), b"first")

    def test_upload_capacity_rejects_entire_queue_before_transfer(self):
        user = SimpleNamespace()
        with patch.object(
            document_portal,
            "_upload_capacity",
            return_value={"free_bytes": 500, "reserved_bytes": 100, "available_bytes": 400},
        ):
            with self.assertRaises(HTTPException) as error:
                document_portal.validate_upload_capacity(
                    document_portal.UploadCapacityCheck(total_size=401, file_count=2),
                    path="",
                    _=user,
                )

        self.assertEqual(error.exception.status_code, 507)
        self.assertIn("401 B", error.exception.detail)
        self.assertFalse(any(self.root.iterdir()))

    def test_upload_capacity_accepts_queue_within_available_storage(self):
        user = SimpleNamespace()
        with patch.object(
            document_portal,
            "_upload_capacity",
            return_value={"free_bytes": 500, "reserved_bytes": 100, "available_bytes": 400},
        ):
            result = document_portal.validate_upload_capacity(
                document_portal.UploadCapacityCheck(total_size=400, file_count=2),
                path="",
                _=user,
            )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["requested_bytes"], 400)


if __name__ == "__main__":
    unittest.main()
