import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.constants import Role, is_document_portal_only
from fastapi import HTTPException
from starlette.requests import Request

from app.deps import (
    _enforce_view_only_request,
    dashboard_department_scope,
    require_document_portal_contributor,
    require_document_portal_viewer,
    require_roles,
)
from app.routers.dashboard import _require_qa_dashboard_access


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

    def test_view_only_has_cross_department_read_and_document_access_but_not_write(self):
        viewer = models.User(
            id=3,
            username="org.viewer",
            full_name="Organisation Viewer",
            login_type="STANDARD",
            department="IT - Software",
            role_assignments=[models.UserRole(role=Role.VIEW_ONLY)],
        )
        self.db.add(viewer)
        self.db.commit()
        self.db.refresh(viewer)

        self.assertIsNone(dashboard_department_scope(viewer))
        self.assertIsNone(_require_qa_dashboard_access(viewer))
        with self.assertRaises(HTTPException):
            require_document_portal_viewer(viewer)
        with self.assertRaises(HTTPException):
            require_document_portal_contributor(viewer)

        viewer.role_assignments.append(models.UserRole(role=Role.DOCUMENT_PORTAL_VIEWER))
        self.db.commit()
        self.assertEqual(require_document_portal_viewer(viewer).id, viewer.id)
        with self.assertRaises(HTTPException):
            require_document_portal_contributor(viewer)

        read_request = Request({
            "type": "http", "method": "GET", "path": "/api/qa-requests",
            "raw_path": b"/api/qa-requests", "query_string": b"", "headers": [],
            "scheme": "http", "server": ("test", 80), "client": ("test", 1),
        })
        _enforce_view_only_request(read_request, viewer)
        self.assertEqual(require_roles(Role.QA_LEAD)(read_request, viewer).id, viewer.id)

        admin_read_request = Request({
            "type": "http", "method": "GET", "path": "/api/audit",
            "raw_path": b"/api/audit", "query_string": b"", "headers": [],
            "scheme": "http", "server": ("test", 80), "client": ("test", 1),
        })
        with self.assertRaises(HTTPException):
            require_roles(Role.ADMIN)(admin_read_request, viewer)

        write_request = Request({
            "type": "http", "method": "POST", "path": "/api/qa-requests",
            "raw_path": b"/api/qa-requests", "query_string": b"", "headers": [],
            "scheme": "http", "server": ("test", 80), "client": ("test", 1),
        })
        with self.assertRaises(HTTPException) as raised:
            _enforce_view_only_request(write_request, viewer)
        self.assertEqual(raised.exception.status_code, 403)

    def test_standard_requester_cannot_read_qa_tester_analytics(self):
        requester = models.User(
            id=4,
            username="requester",
            full_name="Requester",
            login_type="STANDARD",
            role_assignments=[models.UserRole(role=Role.REQUESTER)],
        )
        self.db.add(requester)
        self.db.commit()
        self.db.refresh(requester)

        with self.assertRaises(HTTPException) as raised:
            _require_qa_dashboard_access(requester)
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
