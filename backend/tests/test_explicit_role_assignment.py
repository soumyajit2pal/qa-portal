import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models, schemas
from app.constants import QA_DEPARTMENT, Role
from app.routers import auth as auth_router


class ExplicitRoleAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(self.engine, tables=[
            models.User.__table__, models.UserRole.__table__,
            models.UserDepartment.__table__, models.Department.__table__,
        ])
        self.db = sessionmaker(bind=self.engine)()
        self.db.add(models.Department(name=QA_DEPARTMENT, is_active=True))
        self.db.commit()
        self.admin = models.User(id=900, username="admin", full_name="Admin", login_type="STANDARD")

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    @patch.object(auth_router, "write_audit")
    def test_create_does_not_add_coe_baseline_roles(self, _write_audit):
        created = auth_router.create_user(
            schemas.UserCreate(
                username="agm.qa", full_name="AGM QA", login_type="LDAP",
                departments=[QA_DEPARTMENT], roles=[Role.AGM_QA],
            ),
            request=None, db=self.db, current_user=self.admin,
        )
        self.assertEqual(created.roles, [Role.AGM_QA])

    @patch.object(auth_router, "write_audit")
    def test_update_replaces_with_exact_admin_selection(self, _write_audit):
        user = models.User(
            username="existing.qa", full_name="Existing QA", department=QA_DEPARTMENT,
            login_type="LDAP", role_assignments=[
                models.UserRole(role=Role.QA_ENGINEER),
                models.UserRole(role=Role.DOCUMENT_PORTAL_VIEWER),
            ], department_assignments=[models.UserDepartment(department=QA_DEPARTMENT)],
        )
        self.db.add(user)
        self.db.commit()

        updated = auth_router.update_user(
            user.id,
            schemas.UserUpdate(departments=[QA_DEPARTMENT], roles=[Role.AGM_QA]),
            request=None, db=self.db, current_user=self.admin,
        )
        self.assertEqual(updated.roles, [Role.AGM_QA])


if __name__ == "__main__":
    unittest.main()
