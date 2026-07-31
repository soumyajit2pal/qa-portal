from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/test-execution", tags=["test-management"])

# Same access as the Test Repository (test_repository.py) -- QA Engineer +
# QA Lead both create cycles, add test cases to them, and record results.
# Admin always bypasses via require_roles.
_EXEC_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD)


def _get_project_or_404(db: Session, project_id: int) -> models.TestProject:
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    return obj


def _get_cycle_or_404(db: Session, cycle_id: int) -> models.TestCycle:
    obj = db.query(models.TestCycle).get(cycle_id)
    if not obj:
        raise HTTPException(404, "Test Cycle not found")
    return obj


# ---- Cycles ----
@router.get("/projects/{project_id}/cycles", response_model=List[schemas.TestCycleOut])
def list_cycles(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_project_or_404(db, project_id)
    return db.query(models.TestCycle).filter_by(project_id=project_id).order_by(models.TestCycle.created_at.desc()).all()


@router.post("/projects/{project_id}/cycles", response_model=schemas.TestCycleOut)
def create_cycle(project_id: int, payload: schemas.TestCycleCreate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    _get_project_or_404(db, project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Cycle name cannot be blank")
    obj = models.TestCycle(
        project_id=project_id, name=name, description=payload.description,
        start_date=payload.start_date, end_date=payload.end_date, created_by_id=current_user.id,
    )
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/cycles/{cycle_id}", response_model=schemas.TestCycleOut)
def get_cycle(cycle_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_cycle_or_404(db, cycle_id)


@router.patch("/cycles/{cycle_id}", response_model=schemas.TestCycleOut)
def update_cycle(cycle_id: int, payload: schemas.TestCycleUpdate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _get_cycle_or_404(db, cycle_id)
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(obj, field, value)
    db.commit()
    db.refresh(obj)
    return obj


# ---- Executions (a test case's result within one cycle) ----
@router.get("/cycles/{cycle_id}/executions", response_model=List[schemas.TestExecutionOut])
def list_executions(cycle_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_cycle_or_404(db, cycle_id)
    return db.query(models.TestExecution).filter_by(cycle_id=cycle_id).order_by(models.TestExecution.id).all()


@router.post("/cycles/{cycle_id}/executions", response_model=List[schemas.TestExecutionOut])
def add_test_cases_to_cycle(cycle_id: int, payload: schemas.TestExecutionAdd, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Adds one or more existing Repository test cases to this cycle,
    creating a Not-Executed TestExecution row for each -- silently skips any
    that are already in this cycle (the (cycle_id, test_case_id) unique
    constraint means re-adding one would otherwise 500)."""
    cycle = _get_cycle_or_404(db, cycle_id)
    already = {
        e.test_case_id for e in
        db.query(models.TestExecution.test_case_id).filter_by(cycle_id=cycle_id).all()
    }
    created = []
    for case_id in payload.test_case_ids:
        if case_id in already:
            continue
        case = db.query(models.TestCase).filter_by(id=case_id, project_id=cycle.project_id).first()
        if not case:
            raise HTTPException(404, f"Test Case #{case_id} not found in this project")
        obj = models.TestExecution(cycle_id=cycle_id, test_case_id=case_id, status="Not Executed")
        db.add(obj)
        created.append(obj)
        already.add(case_id)
    db.commit()
    for obj in created:
        db.refresh(obj)
    return created


@router.patch("/executions/{execution_id}", response_model=schemas.TestExecutionOut)
def update_execution(execution_id: int, payload: schemas.TestExecutionUpdate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = db.query(models.TestExecution).get(execution_id)
    if not obj:
        raise HTTPException(404, "Execution not found")
    obj.status = payload.status
    obj.actual_result = payload.actual_result
    obj.test_run_artifacts = payload.test_run_artifacts
    obj.defect_id = payload.defect_id
    obj.executed_by_id = current_user.id
    obj.executed_at = models.now()
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/executions/{execution_id}")
def remove_execution(execution_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Removes a test case from a cycle entirely (not the same as recording
    a result) -- e.g. it was added by mistake."""
    obj = db.query(models.TestExecution).get(execution_id)
    if not obj:
        raise HTTPException(404, "Execution not found")
    db.delete(obj)
    db.commit()
    return {"ok": True}
