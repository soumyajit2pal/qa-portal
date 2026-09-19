import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models, schemas
from app.constants import (
    ALL_ROLES, DEPARTMENT_ADMIN_ASSIGNABLE_ROLES, QA_ADMIN_ASSIGNABLE_ROLES,
    QA_REQUEST_CREATOR_ROLES, REQUESTER_EQUIVALENT_ROLES, ROLE_LABELS, Role,
)
from app.routers import auth as auth_router


TEST_DEPARTMENT = "IT - Software"


class ExplicitRoleAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(self.engine, tables=[
            models.User.__table__, models.UserRole.__table__,
            models.UserDepartment.__table__, models.Department.__table__,
            models.DepartmentUnit.__table__, models.UserDepartmentUnit.__table__,
            models.AuthSession.__table__,
        ])
        self.db = sessionmaker(bind=self.engine)()
        self.db.add(models.Department(name=TEST_DEPARTMENT, is_active=True))
        self.db.commit()
        self.admin = models.User(id=900, username="admin", full_name="Admin", login_type="STANDARD")

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    @patch.object(auth_router, "write_audit")
    def test_create_does_not_add_implicit_baseline_roles(self, _write_audit):
        created = auth_router.create_user(
            schemas.UserCreate(
                username="agm.qa", full_name="AGM QA", login_type="LDAP",
                departments=[TEST_DEPARTMENT], roles=[Role.AGM_QA],
            ),
            request=None, db=self.db, current_user=self.admin,
        )
        self.assertEqual(created.roles, [Role.AGM_QA])

    @patch.object(auth_router, "write_audit")
    def test_update_replaces_with_exact_admin_selection(self, _write_audit):
        user = models.User(
            username="existing.qa", full_name="Existing QA", department=TEST_DEPARTMENT,
            login_type="LDAP", role_assignments=[
                models.UserRole(role=Role.QA_ENGINEER),
                models.UserRole(role=Role.DOCUMENT_PORTAL_VIEWER),
            ], department_assignments=[models.UserDepartment(department=TEST_DEPARTMENT)],
        )
        self.db.add(user)
        self.db.commit()

        updated = auth_router.update_user(
            user.id,
            schemas.UserUpdate(departments=[TEST_DEPARTMENT], roles=[Role.AGM_QA]),
            request=None, db=self.db, current_user=self.admin,
        )
        self.assertEqual(updated.roles, [Role.AGM_QA])

    def test_view_only_only_allows_document_portal_companion_roles(self):
        auth_router._validate_roles([Role.VIEW_ONLY])
        auth_router._validate_roles([Role.VIEW_ONLY, Role.DOCUMENT_PORTAL_VIEWER])
        with self.assertRaises(HTTPException) as raised:
            auth_router._validate_roles([Role.VIEW_ONLY, Role.REQUESTER])
        self.assertEqual(raised.exception.status_code, 400)

    def test_role_catalog_is_complete_unique_and_assignable(self):
        self.assertEqual(len(ALL_ROLES), len(set(ALL_ROLES)))
        self.assertEqual(set(ALL_ROLES), set(ROLE_LABELS))
        self.assertTrue(set(DEPARTMENT_ADMIN_ASSIGNABLE_ROLES).issubset(ALL_ROLES))
        self.assertTrue(set(QA_ADMIN_ASSIGNABLE_ROLES).issubset(ALL_ROLES))

    def test_developer_is_a_valid_business_role(self):
        auth_router._validate_roles([Role.DEVELOPER])
        self.assertEqual(REQUESTER_EQUIVALENT_ROLES, (Role.REQUESTER, Role.DEVELOPER))
        self.assertEqual(
            QA_REQUEST_CREATOR_ROLES,
            (Role.REQUESTER, Role.DEVELOPER, Role.BUSINESS_ANALYST),
        )
        self.assertIn(Role.DEVELOPER, DEPARTMENT_ADMIN_ASSIGNABLE_ROLES)
        self.assertNotIn(Role.DEVELOPER, QA_ADMIN_ASSIGNABLE_ROLES)

    def test_developer_matches_requester_defect_responsibility(self):
        developer = models.User(
            username="developer", full_name="Developer", login_type="LDAP",
            role_assignments=[models.UserRole(role=Role.DEVELOPER)],
        )
        business_analyst = models.User(
            username="analyst", full_name="Business Analyst", login_type="LDAP",
            role_assignments=[models.UserRole(role=Role.BUSINESS_ANALYST)],
        )

        self.assertTrue(models.Defect(assignee=developer).assignee_is_requester)
        self.assertFalse(models.Defect(assignee=business_analyst).assignee_is_requester)


if __name__ == "__main__":
    unittest.main()
