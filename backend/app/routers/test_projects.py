from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles, dashboard_department_scope
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
    # Reported directly: "Test Management also restrict to Department only" --
    # same dashboard_department_scope rule as every other list endpoint
    # (TestProject.department is a real column, so a direct .filter() is
    # enough). This is the single entry point every Test Management screen
    # (Projects, Repository, Execution) picks a project from, so scoping it
    # here keeps a scoped user from ever reaching another department's
    # folders/test cases/cycles/executions through the normal UI -- same
    # convention as everywhere else: individual get-by-id endpoints (e.g.
    # get_test_project) are left unscoped, matching every other module's
    # own get-by-id endpoints (e.g. functional.py::get_functional).
    query = db.query(models.TestProject)
    if not include_inactive:
        query = query.filter(models.TestProject.is_active == True)  # noqa: E712
    scope = dashboard_department_scope(current_user)
    if scope:
        query = query.filter(models.TestProject.department == scope)
    return query.order_by(models.TestProject.is_active.desc(), models.TestProject.name).all()


@router.post("", response_model=schemas.TestProjectOut)
def create_test_project(payload: schemas.TestProjectCreate, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(*_MANAGE_ROLES))):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Project name cannot be blank")

    department = payload.department.strip()
    application_master_id = payload.application_master_id
    if application_master_id:
        app_master = db.query(models.ApplicationMaster).get(application_master_id)
        if not app_master:
            raise HTTPException(404, "Application not found")
        department = (app_master.department or "").strip()
        if not department:
            raise HTTPException(400, "The selected Application does not have a mapped department")
    if not department:
        raise HTTPException(400, "Department is required")
    department_row = db.query(models.Department).filter(
        models.Department.name == department,
        models.Department.is_active == True,  # noqa: E712 - Oracle boolean column
    ).first()
    if not department_row:
        raise HTTPException(400, "The selected department is not active in the system department list")

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
    """Reported directly: "Once Project is created, give option to edit
    details" (name/application link/department/description all editable by
    either manage role, same as at creation) and, separately: "Project
    Activation, deactivation should need approval from QA lead" -- only
    is_active is gated: a QA Lead (or Admin, via has_role()'s bypass) still
    flips it immediately, same as before, but a QA Engineer's request only
    records what they're asking for (pending_is_active) without touching the
    live is_active at all, until a QA Lead resolves it via
    review_project_activation below."""
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        data["name"] = data["name"].strip()
        if not data["name"]:
            raise HTTPException(400, "Project name cannot be blank")
    if "department" in data:
        department = (data["department"] or "").strip()
        if not department:
            raise HTTPException(400, "Department is required")
        department_row = db.query(models.Department).filter(
            models.Department.name == department,
            models.Department.is_active == True,  # noqa: E712 - Oracle boolean column
        ).first()
        if not department_row:
            raise HTTPException(400, "Select an active department from the system department list")
        data["department"] = department
    is_qa_lead_or_admin = current_user.has_role(Role.QA_LEAD)
    requested_active = data.pop("is_active", None)
    if "application_master_id" in data:
        new_app_id = data.pop("application_master_id")
        if new_app_id is not None:
            app_master = db.query(models.ApplicationMaster).get(new_app_id)
            if not app_master:
                raise HTTPException(404, "Application not found")
            obj.application_master_id = new_app_id
            mapped_department = (app_master.department or "").strip()
            if not mapped_department:
                raise HTTPException(400, "The selected Application does not have a mapped department")
            mapped_row = db.query(models.Department).filter(
                models.Department.name == mapped_department,
                models.Department.is_active == True,  # noqa: E712 - Oracle boolean column
            ).first()
            if not mapped_row:
                raise HTTPException(400, "The selected Application's department is not active")
            data["department"] = mapped_department
        else:
            obj.application_master_id = None
    elif obj.application_master_id and "department" in data:
        # A linked Application owns the department even if a caller attempts
        # to PATCH only the department and omit application_master_id.
        app_master = db.query(models.ApplicationMaster).get(obj.application_master_id)
        mapped_department = (app_master.department or "").strip() if app_master else ""
        if not mapped_department:
            raise HTTPException(400, "The linked Application does not have a mapped department")
        data["department"] = mapped_department
    for field in ("name", "department", "description"):
        if field in data and data[field] is not None:
            setattr(obj, field, data[field])

    if requested_active is not None:
        if requested_active == obj.is_active:
            # Requesting the state the project is already in -- e.g. a second
            # tab racing a request that was just approved. Quietly clears any
            # now-stale pending request instead of erroring; not a state
            # change worth its own audit row.
            obj.pending_is_active = None
            obj.pending_requested_by_id = None
            obj.pending_requested_at = None
        elif is_qa_lead_or_admin:
            obj.is_active = requested_active
            obj.pending_is_active = None
            obj.pending_requested_by_id = None
            obj.pending_requested_at = None
            db.add(models.ApprovalAction(
                entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision="Reactivated" if obj.is_active else "Deactivated",
                comments="Project reactivated for new test work" if obj.is_active else "Project deactivated; existing test assets retained",
            ))
        else:
            if obj.pending_is_active == requested_active:
                raise HTTPException(400, "This request is already pending QA Lead approval")
            obj.pending_is_active = requested_active
            obj.pending_requested_by_id = current_user.id
            obj.pending_requested_at = models.now()
            db.add(models.ApprovalAction(
                entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
                actor_id=current_user.id, actor_role=current_user.roles_csv,
                decision="Reactivation requested" if requested_active else "Deactivation requested",
                comments="Awaiting QA Lead approval before taking effect.",
            ))
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{project_id}/activation-review", response_model=schemas.TestProjectOut)
def review_project_activation(project_id: int, payload: schemas.TestProjectActivationReview,
                               db: Session = Depends(get_db),
                               current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """QA Lead (or Admin) resolves a pending activate/deactivate request from
    a QA Engineer -- Approve applies the requested value to is_active,
    Reject discards the request and leaves is_active untouched. Reported
    directly alongside update_test_project's gate above."""
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    if obj.pending_is_active is None:
        raise HTTPException(400, "This project has no pending activation request")
    decision = payload.decision.strip().upper()
    comments = (payload.comments or "").strip()
    if decision not in {"APPROVE", "REJECT"}:
        raise HTTPException(400, "Decision must be APPROVE or REJECT")
    if decision == "REJECT" and not comments:
        raise HTTPException(400, "A reason is required when rejecting an activation request")
    requested_active = obj.pending_is_active
    requested_by_name = obj.pending_requested_by_name
    if decision == "APPROVE":
        obj.is_active = requested_active
        action = "Reactivation approved" if requested_active else "Deactivation approved"
        comments = comments or (
            f"{'Reactivation' if requested_active else 'Deactivation'} requested by "
            f"{requested_by_name or 'a QA Engineer'} was approved."
        )
    else:
        action = "Reactivation request rejected" if requested_active else "Deactivation request rejected"
    obj.pending_is_active = None
    obj.pending_requested_by_id = None
    obj.pending_requested_at = None
    db.add(models.ApprovalAction(
        entity_type="TEST_PROJECT", entity_id=obj.id, step_name="Project lifecycle",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision=action, comments=comments,
    ))
    db.commit()
    db.refresh(obj)
    return obj
