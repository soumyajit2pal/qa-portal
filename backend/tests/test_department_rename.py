from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.routers.departments import reconcile_department_references


def test_master_department_spelling_reconciles_user_access_without_duplicates():
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine, tables=[
        models.User.__table__, models.Department.__table__,
        models.UserDepartment.__table__, models.ChecklistTemplateItem.__table__,
    ])
    db = sessionmaker(bind=engine)()
    try:
        db.add(models.Department(name="IT-Software", is_active=True))
        db.add_all([
            models.User(id=1, username="one", full_name="One", login_type="STANDARD", department="IT - Software"),
            models.User(id=2, username="two", full_name="Two", login_type="STANDARD", department="IT-Software"),
        ])
        db.add_all([
            models.UserDepartment(user_id=1, department="IT - Software"),
            # A partially migrated account already has both spellings. The
            # obsolete row must be merged, not violate the unique key.
            models.UserDepartment(user_id=2, department="IT - Software"),
            models.UserDepartment(user_id=2, department="IT-Software"),
        ])
        db.commit()

        with patch(
            "app.routers.departments._SIMPLE_DEPARTMENT_COLUMNS",
            ((models.User, models.User.department),),
        ), patch(
            "app.routers.departments._SCOPED_DEPARTMENT_COLUMNS",
            ((models.UserDepartment, models.UserDepartment.department, models.UserDepartment.user_id),),
        ):
            changed = reconcile_department_references(db)

        assert changed >= 3
        assert {user.department for user in db.query(models.User).all()} == {"IT-Software"}
        rows = db.query(models.UserDepartment).order_by(models.UserDepartment.user_id).all()
        assert [(row.user_id, row.department) for row in rows] == [
            (1, "IT-Software"), (2, "IT-Software"),
        ]
    finally:
        db.close()
        engine.dispose()
