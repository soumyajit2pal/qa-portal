from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models, schemas
from app.routers.applications import create_approved_application_name


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    models.Base.metadata.create_all(engine)
    return Session(engine)


def _admin(db: Session) -> models.User:
    user = models.User(
        username="admin-create-app",
        full_name="Application Administrator",
        department="COE - Quality Assurance",
        is_active=True,
        role_assignments=[models.UserRole(role="ADMIN")],
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_admin_can_create_one_approved_application_with_active_department():
    db = _session()
    db.add(models.Department(name="Digital Banking Department - IT", is_active=True))
    db.commit()
    admin = _admin(db)

    with patch("app.routers.applications._invalidate_approved_names_cache"):
        result = create_approved_application_name(
            schemas.ApplicationMasterAdminCreate(
                name="  mobile banking  ",
                department="Digital Banking Department - IT",
            ),
            db,
            admin,
        )

    assert result.name == "MOBILE BANKING"
    assert result.status == "APPROVED"
    assert result.department == "Digital Banking Department - IT"
    assert result.requested_by_id == admin.id
    assert result.app_owner_decided_by_id == admin.id
    assert result.decided_by_id == admin.id


def test_manual_create_rejects_inactive_department():
    db = _session()
    db.add(models.Department(name="Retired Department", is_active=False))
    db.commit()
    admin = _admin(db)

    with pytest.raises(HTTPException) as exc:
        create_approved_application_name(
            schemas.ApplicationMasterAdminCreate(
                name="MOBILE BANKING",
                department="Retired Department",
            ),
            db,
            admin,
        )

    assert exc.value.status_code == 400
    assert "active department" in str(exc.value.detail)


def test_manual_create_does_not_override_rejected_application():
    db = _session()
    db.add(models.Department(name="Digital Banking Department - IT", is_active=True))
    db.add(models.ApplicationMaster(
        name="MOBILE BANKING",
        status="REJECTED",
        department="Digital Banking Department - IT",
    ))
    db.commit()
    admin = _admin(db)

    with pytest.raises(HTTPException) as exc:
        create_approved_application_name(
            schemas.ApplicationMasterAdminCreate(
                name="mobile banking",
                department="Digital Banking Department - IT",
            ),
            db,
            admin,
        )

    assert exc.value.status_code == 409
    assert "previously rejected" in str(exc.value.detail)
