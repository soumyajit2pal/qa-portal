# NOTE: Test Execution Management (Module 3) is temporarily DISABLED per
# request -- this router is fully implemented and correct, but app/main.py
# currently does NOT import or mount it, so none of these endpoints are live.
# Re-enable by uncommenting the relevant lines in main.py (see comment there).
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/test-runs", tags=["test-runs"])


@router.get("", response_model=List[schemas.TestRunOut])
def list_runs(project: Optional[str] = None, application: Optional[str] = None,
              db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    q = db.query(models.TestRun)
    if project:
        q = q.filter(models.TestRun.project.ilike(f"%{project}%"))
    if application:
        q = q.filter(models.TestRun.application.ilike(f"%{application}%"))
    return q.order_by(models.TestRun.created_at.desc()).all()


@router.get("/{run_id}", response_model=schemas.TestRunOut)
def get_run(run_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.TestRun).get(run_id)
    if not obj:
        raise HTTPException(404, "Test run not found")
    return obj


@router.post("", response_model=schemas.TestRunOut)
def create_run(payload: schemas.TestRunCreate, db: Session = Depends(get_db),
                current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD))):
    data = payload.model_dump()
    case_ids = data.pop("test_case_ids", [])
    obj = models.TestRun(**data, qa_owner_id=current_user.id, status="Not Started")
    db.add(obj)
    db.flush()
    for cid in case_ids:
        db.add(models.TestRunCase(test_run_id=obj.id, test_case_id=cid, execution_status="Not Started"))
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{run_id}/cases/{run_case_id}", response_model=schemas.TestRunCaseOut)
def update_run_case(run_id: int, run_case_id: int, payload: schemas.TestRunCaseUpdate,
                     db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_ENGINEER, Role.QA_LEAD))):
    obj = db.query(models.TestRunCase).filter_by(id=run_case_id, test_run_id=run_id).first()
    if not obj:
        raise HTTPException(404, "Test run case not found")
    import datetime
    obj.execution_status = payload.execution_status
    obj.actual_result = payload.actual_result
    obj.defect_id = payload.defect_id
    obj.executed_by_id = current_user.id
    obj.executed_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(obj)

    run = db.query(models.TestRun).get(run_id)
    statuses = [c.execution_status for c in run.cases]
    if statuses and all(s in ("Passed", "Retest Passed", "NA") for s in statuses):
        run.status = "Completed"
    elif any(s in ("In Progress", "Passed", "Failed", "Blocked", "Retest Passed") for s in statuses):
        run.status = "In Progress"
    db.commit()
    return obj


@router.get("/{run_id}/metrics")
def run_metrics(run_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Module 3.4 metrics: Total/Executed/Passed/Failed/Pass %/Defect density/Re-open rate."""
    run = db.query(models.TestRun).get(run_id)
    if not run:
        raise HTTPException(404, "Test run not found")
    cases = run.cases
    total = len(cases)
    executed = len([c for c in cases if c.execution_status not in ("Not Started",)])
    passed = len([c for c in cases if c.execution_status in ("Passed", "Retest Passed")])
    failed = len([c for c in cases if c.execution_status == "Failed"])
    defects = len([c for c in cases if c.defect_id])
    return {
        "test_run_id": run.test_run_id,
        "total_cases": total,
        "executed_cases": executed,
        "passed": passed,
        "failed": failed,
        "pass_percentage": round((passed / executed * 100), 2) if executed else 0,
        "defect_density": round((defects / total), 3) if total else 0,
        "re_open_rate": 0,
    }
