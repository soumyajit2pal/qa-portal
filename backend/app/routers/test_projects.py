from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/test-projects", tags=["test-management"])

# Project Management module -- one Project per Application (see the header
# comment on models.TestProject for why). QA Engineer + QA Lead both manage
# Projects (create/edit) as well as author/execute test cases under them --
# Admin always bypasses via require_roles/has_role.
_MANAGE_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD)


@router.get("", response_model=List[schemas.TestProjectOut])
def list_test_projects(include_inactive: bool = Query(False), db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    query = db.query(models.TestProject)
    if not include_inactive:
        query = query.filter(models.TestProject.is_active == True)  # noqa: E712
    return query.order_by(models.TestProject.is_active.desc(), models.TestProject.name).all()


@router.post("", response_model=schemas.TestProjectOut)
def create_test_project(payload: schemas.TestProjectCreate, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Project name cannot be blank")

    department = payload.department
    application_master_id = payload.application_master_id
    if application_master_id:
        app_master = db.query(models.ApplicationMaster).get(application_master_id)
        if not app_master:
            raise HTTPException(404, "Application not found")
        # Application Name is the canonical source of truth for department
        # when a Project is explicitly linked to one -- only falls back to
        # whatever the caller typed if the application itself has none set.
        department = app_master.department or department

    obj = models.TestProject(
        name=name, application_master_id=application_master_id, department=department,
        description=payload.description, is_active=True, created_by_id=current_user.id,
    )
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{project_id}", response_model=schemas.TestProjectOut)
def get_test_project(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    return obj


@router.patch("/{project_id}", response_model=schemas.TestProjectOut)
def update_test_project(project_id: int, payload: schemas.TestProjectUpdate, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        data["name"] = data["name"].strip()
        if not data["name"]:
            raise HTTPException(400, "Project name cannot be blank")
    previous_active = obj.is_active
    for field in ("name", "department", "description", "is_active"):
        if field in data and data[field] is not None:
            setattr(obj, field, data[field])
    if "is_active" in data and obj.is_active != previous_active:
        db.add(models.ApprovalAction(
            entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Reactivated" if obj.is_active else "Deactivated",
            comments="Project reactivated for new test work" if obj.is_active else "Project deactivated; existing test assets retained",
        ))
    db.commit()
    db.refresh(obj)
    return obj
