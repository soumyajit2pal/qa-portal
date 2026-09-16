import asyncio
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models
from app.constants import Role
from app.deps import require_document_portal_manager
from app.routers import document_portal
from app.document_portal_storage import prepare_existing_roots, rename_workspace_root, workspace_root


class DocumentPortalTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.original_root = document_portal.DOCUMENT_ROOT
        document_portal.DOCUMENT_ROOT = self.root
        self.engine = create_engine('sqlite:///:memory:')
        models.Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.workspace = models.QAWorkspace(workspace_key='TEST', name='Test Workspace',
                                            is_active=True, document_portal_quota_bytes=1024 * 1024)
        self.db.add(self.workspace)
        self.db.commit()
        self.scope = self.root / self.workspace.name
        self.user = SimpleNamespace(username='portal-user', active_qa_workspace_id=self.workspace.id)

    def tearDown(self):
        document_portal.DOCUMENT_ROOT = self.original_root
        self.db.close()
        self.engine.dispose()
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
        user = self.user
        document_portal.create_folder(document_portal.FolderCreate(name="Evidence"), user, self.db)
        document_portal.create_folder(document_portal.FolderCreate(path="Evidence", name="Release"), user, self.db)
        response = document_portal.browse(path="Evidence", sort="name", order="asc", _=user, db=self.db)
        self.assertEqual([item["name"] for item in response["items"]], ["Release"])
        document_portal.rename(document_portal.RenameItem(path="Evidence/Release", name="August"), user, self.db)
        document_portal.move(document_portal.MoveItem(path="Evidence/August", destination=""), user, self.db)
        self.assertTrue((self.scope / "August").is_dir())

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
        user = self.user

        def upload_file(contents: bytes):
            stream = tempfile.SpooledTemporaryFile()
            stream.write(contents)
            stream.seek(0)
            return UploadFile(filename="checklist.txt", file=stream)

        first = asyncio.run(document_portal.upload(
            path="", relative_path="Evidence/Release/checklist.txt", duplicate="keep",
            file=upload_file(b"first"), _=user, db=self.db,
        ))
        second = asyncio.run(document_portal.upload(
            path="", relative_path="Evidence/Release/checklist.txt", duplicate="keep",
            file=upload_file(b"second"), _=user, db=self.db,
        ))
        self.assertEqual(first["item"]["path"], "Evidence/Release/checklist.txt")
        self.assertEqual(second["item"]["path"], "Evidence/Release/checklist (1).txt")
        self.assertEqual((self.scope / "Evidence/Release/checklist.txt").read_bytes(), b"first")

    def test_upload_capacity_rejects_entire_queue_before_transfer(self):
        user = self.user
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
                    db=self.db,
                )

        self.assertEqual(error.exception.status_code, 507)
        self.assertIn("401 B", error.exception.detail)
        self.assertFalse(any(item.name != document_portal.OWNER_FILE for item in self.scope.iterdir()))

    def test_upload_capacity_accepts_queue_within_available_storage(self):
        user = self.user
        with patch.object(
            document_portal,
            "_upload_capacity",
            return_value={"free_bytes": 500, "reserved_bytes": 100, "available_bytes": 400},
        ):
            result = document_portal.validate_upload_capacity(
                document_portal.UploadCapacityCheck(total_size=400, file_count=2),
                path="",
                _=user,
                db=self.db,
            )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["requested_bytes"], 400)

    def test_quota_blocks_additional_files_but_replace_uses_old_file_credit(self):
        self.workspace.document_portal_quota_bytes = 5
        self.db.commit()
        def file(name, data):
            stream = tempfile.SpooledTemporaryFile()
            stream.write(data); stream.seek(0)
            return UploadFile(filename=name, file=stream)
        asyncio.run(document_portal.upload(path='', relative_path='first.txt', duplicate='keep',
                                           file=file('first.txt', b'abc'), _=self.user, db=self.db))
        with self.assertRaises(HTTPException) as error:
            asyncio.run(document_portal.upload(path='', relative_path='second.txt', duplicate='keep',
                                               file=file('second.txt', b'def'), _=self.user, db=self.db))
        self.assertEqual(error.exception.status_code, 507)
        self.assertFalse((self.scope / 'second.txt').exists())
        self.assertFalse(any(path.name.endswith('.uploading') for path in self.scope.iterdir()))
        asyncio.run(document_portal.upload(path='', relative_path='first.txt', duplicate='replace',
                                           file=file('first.txt', b'12345'), _=self.user, db=self.db))
        self.assertEqual((self.scope / 'first.txt').read_bytes(), b'12345')
        result = document_portal.browse(path='', sort='name', order='asc', _=self.user, db=self.db)
        self.assertEqual(result['stats']['used'], 5)
        self.assertEqual(result['upload_capacity'], 0)

    def test_parent_quota_is_shared_by_parent_and_children_while_files_stay_in_child_roots(self):
        self.workspace.document_portal_quota_bytes = 5
        first = models.QAWorkspace(workspace_key='CHILD1', name='Child One', is_active=True,
                                   parent_workspace_id=self.workspace.id, document_portal_quota_bytes=5)
        second = models.QAWorkspace(workspace_key='CHILD2', name='Child Two', is_active=True,
                                    parent_workspace_id=self.workspace.id, document_portal_quota_bytes=5)
        self.db.add_all([first, second]); self.db.commit()

        def file(name, data):
            stream = tempfile.SpooledTemporaryFile()
            stream.write(data); stream.seek(0)
            return UploadFile(filename=name, file=stream)

        first_user = SimpleNamespace(username='first', active_qa_workspace_id=first.id)
        second_user = SimpleNamespace(username='second', active_qa_workspace_id=second.id)
        asyncio.run(document_portal.upload(path='', relative_path='first.txt', duplicate='keep',
                                           file=file('first.txt', b'abc'), _=first_user, db=self.db))
        asyncio.run(document_portal.upload(path='', relative_path='parent.txt', duplicate='keep',
                                           file=file('parent.txt', b'12'), _=self.user, db=self.db))
        child_browse = document_portal.browse(path='', sort='name', order='asc', _=second_user, db=self.db)
        self.assertEqual(child_browse['upload_capacity'], 0)
        self.assertEqual(child_browse['family_storage_used_bytes'], 5)
        with self.assertRaises(HTTPException) as error:
            asyncio.run(document_portal.upload(path='', relative_path='second.txt', duplicate='keep',
                                               file=file('second.txt', b'x'), _=second_user, db=self.db))
        self.assertEqual(error.exception.status_code, 507)
        self.assertFalse((self.root / second.name / 'second.txt').exists())
        asyncio.run(document_portal.upload(path='', relative_path='first.txt', duplicate='replace',
                                           file=file('first.txt', b'ab'), _=first_user, db=self.db))
        asyncio.run(document_portal.upload(path='', relative_path='second.txt', duplicate='keep',
                                           file=file('second.txt', b'x'), _=second_user, db=self.db))
        self.assertEqual((self.root / second.name / 'second.txt').read_bytes(), b'x')
        self.assertFalse((self.root / first.name / 'second.txt').exists())

    def test_upload_waits_for_admin_to_set_limit(self):
        self.workspace.document_portal_quota_bytes = None
        self.db.commit()
        with self.assertRaises(HTTPException) as error:
            document_portal.validate_upload_capacity(
                document_portal.UploadCapacityCheck(total_size=1, file_count=1),
                path='', _=self.user, db=self.db)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(document_portal.browse(path='', sort='name', order='asc',
                                                _=self.user, db=self.db)['storage_limit_bytes'], None)

    def test_active_workspace_cannot_browse_search_or_download_another_root(self):
        self.scope.mkdir()
        (self.scope / document_portal.OWNER_FILE).write_text(str(self.workspace.id))
        (self.scope / 'private.txt').write_text('first workspace')
        other = models.QAWorkspace(workspace_key='OTHER', name='Other Workspace', is_active=True,
                                   document_portal_quota_bytes=100)
        self.db.add(other); self.db.commit()
        other_user = SimpleNamespace(username='other', active_qa_workspace_id=other.id)
        result = document_portal.browse(path='', sort='name', order='asc', _=other_user, db=self.db)
        self.assertEqual(result['items'], [])
        self.assertEqual(document_portal.search(q='private', _=other_user, db=self.db)['items'], [])
        with self.assertRaises(HTTPException) as error:
            document_portal.download(path='private.txt', _=other_user, db=self.db)
        self.assertEqual(error.exception.status_code, 404)
        self.assertTrue((self.scope / 'private.txt').exists())

    def test_legacy_content_is_preserved_under_default_workspace(self):
        self.workspace.is_default = True
        self.workspace.document_portal_quota_bytes = None
        self.db.commit()
        (self.root / 'old.txt').write_text('legacy evidence')
        (self.root / 'Old Folder').mkdir()
        (self.root / 'Old Folder' / 'nested.txt').write_text('nested evidence')
        prepare_existing_roots(self.db, repository_root=self.root)
        legacy = workspace_root(self.workspace, repository_root=self.root) / 'Legacy Documents'
        self.assertEqual((legacy / 'old.txt').read_text(), 'legacy evidence')
        self.assertEqual((legacy / 'Old Folder' / 'nested.txt').read_text(), 'nested evidence')
        self.assertEqual(document_portal.browse(path='', sort='name', order='asc',
                                                _=self.user, db=self.db)['items'][0]['name'], 'Legacy Documents')

    def test_workspace_owner_file_cannot_be_uploaded_or_modified(self):
        with self.assertRaises(HTTPException) as error:
            document_portal._validate_name(document_portal.OWNER_FILE, is_file=True)
        self.assertEqual(error.exception.status_code, 400)

    def test_workspace_root_rejects_filesystem_alias(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / document_portal.OWNER_FILE).write_text(str(self.workspace.id))
        self.scope.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            workspace_root(self.workspace, repository_root=self.root, create=True)

    def test_workspace_root_rename_keeps_existing_documents(self):
        original = workspace_root(self.workspace, repository_root=self.root, create=True)
        (original / 'certificate.txt').write_text('approved')
        rename_workspace_root(self.workspace, 'Renamed Workspace', repository_root=self.root)
        self.assertFalse(original.exists())
        renamed = self.root / 'Renamed Workspace'
        self.assertEqual((renamed / 'certificate.txt').read_text(), 'approved')
        self.assertEqual((renamed / document_portal.OWNER_FILE).read_text(), str(self.workspace.id))

    def test_manager_can_delete_file_and_non_empty_folder(self):
        user = self.user
        self.scope.mkdir()
        (self.scope / document_portal.OWNER_FILE).write_text(str(self.workspace.id))
        document = self.scope / "evidence.txt"
        document.write_text("evidence", encoding="utf-8")
        folder = self.scope / "Release"
        folder.mkdir()
        (folder / "nested.txt").write_text("nested", encoding="utf-8")

        document_portal.delete_item(path="evidence.txt", _=user, db=self.db)
        document_portal.delete_item(path="Release", _=user, db=self.db)

        self.assertFalse(document.exists())
        self.assertFalse(folder.exists())

    def test_document_repository_root_cannot_be_deleted(self):
        with self.assertRaises(HTTPException) as error:
            document_portal.delete_item(path="", _=self.user, db=self.db)

        self.assertEqual(error.exception.status_code, 400)
        self.assertTrue(self.root.exists())

    def test_delete_permission_is_manager_only(self):
        def user_with(*roles):
            return SimpleNamespace(
                roles=list(roles),
                login_type="STANDARD",
                has_role=lambda *allowed: bool(set(roles).intersection(allowed)),
            )

        self.assertIsNotNone(require_document_portal_manager(user_with(Role.DOCUMENT_PORTAL_MANAGER)))
        with self.assertRaises(HTTPException) as contributor_error:
            require_document_portal_manager(user_with(Role.DOCUMENT_PORTAL_CONTRIBUTOR))
        with self.assertRaises(HTTPException) as viewer_error:
            require_document_portal_manager(user_with(Role.DOCUMENT_PORTAL_VIEWER))

        self.assertEqual(contributor_error.exception.status_code, 403)
        self.assertEqual(viewer_error.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
