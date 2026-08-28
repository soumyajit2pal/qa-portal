import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.constants import Role, is_document_portal_only
from app.deps import require_document_portal_contributor, require_document_portal_viewer


class ScopedQAAccessTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(self.engine, tables=[
            models.User.__table__, models.UserRole.__table__, models.UserDepartment.__table__,
        ])
        self.db = sessionmaker(bind=self.engine)()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_document_roles_enforced_server_side(self):
        viewer = models.User(id=1, username="viewer", full_name="Viewer", login_type="STANDARD")
        contributor = models.User(id=2, username="writer", full_name="Writer", login_type="STANDARD")
        self.db.add_all([
            viewer, contributor,
            models.UserRole(user_id=1, role=Role.DOCUMENT_PORTAL_VIEWER),
            models.UserRole(user_id=2, role=Role.DOCUMENT_PORTAL_CONTRIBUTOR),
        ])
        self.db.commit()
        self.db.refresh(viewer); self.db.refresh(contributor)
        self.assertEqual(require_document_portal_viewer(viewer).id, viewer.id)
        self.assertEqual(require_document_portal_contributor(contributor).id, contributor.id)
        with self.assertRaises(Exception):
            require_document_portal_contributor(viewer)

    def test_document_only_account_is_distinct_from_a_multi_role_account(self):
        self.assertTrue(is_document_portal_only([Role.DOCUMENT_PORTAL_VIEWER]))
        self.assertTrue(is_document_portal_only([
            Role.DOCUMENT_PORTAL_VIEWER,
            Role.DOCUMENT_PORTAL_CONTRIBUTOR,
        ]))
        self.assertFalse(is_document_portal_only([]))
        self.assertFalse(is_document_portal_only([
            Role.DOCUMENT_PORTAL_VIEWER,
            Role.REQUESTER,
        ]))


if __name__ == "__main__":
    unittest.main()
