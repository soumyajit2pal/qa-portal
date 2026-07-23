# NOTE: Test Case Repository (Module 2) is temporarily DISABLED per request --
# this router is fully implemented and correct, but app/main.py currently does
# NOT import or mount it, so none of these endpoints are live. Re-enable by
# uncommenting the relevant lines in main.py (see comment there).
import json
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/test-cases", tags=["test-cases"])


def _snapshot(db: Session, tc: models.TestCase):
    payload = {c.name: str(getattr(tc, c.name)) for c in tc.__table__.columns}
    db.add(models.TestCaseVersion(test_case_id=tc.id, version=tc.version, snapshot_json=json.dumps(payload)))


@router.get("", response_model=List[schemas.TestCaseOut])
def list_test_cases(project_name: Optional[str] = None, module_name: Optional[str] = None,
                     status_filter: Optional[str] = None, qa_request_id: Optional[int] = None,
                     include_archived: bool = False,
                     db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    q = db.query(models.TestCase)
    if not include_archived:
        q = q.filter(models.TestCase.is_archived == False)  # noqa: E712
    if project_name:
        q = q.filter(models.TestCase.project_name.ilike(f"%{project_name}%"))
    if module_name:
        q = q.filter(models.TestCase.module_name.ilike(f"%{module_name}%"))
    if status_filter:
        q = q.filter(models.TestCase.status == status_filter)
    if qa_request_id:
        q = q.filter(models.TestCase.qa_request_id == qa_request_id)
    return q.order_by(models.TestCase.created_at.desc()).all()


@router.get("/{tc_id}", response_model=schemas.TestCaseOut)
def get_test_case(tc_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.TestCase).get(tc_id)
    if not obj:
        raise HTTPException(404, "Test case not found")
    return obj


@router.post("", response_model=schemas.TestCaseOut)
def create_test_case(payload: schemas.TestCaseCreate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(
                          Role.QA_ENGINEER, Role.QA_LEAD, Role.BUSINESS_ANALYST))):
    obj = models.TestCase(**payload.model_dump(), created_by_id=current_user.id, status="Draft", review_status="Draft")
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/bulk", response_model=List[schemas.TestCaseOut])
def bulk_create_test_cases(payloads: List[schemas.TestCaseCreate], db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(
                                Role.QA_ENGINEER, Role.QA_LEAD, Role.BUSINESS_ANALYST))):
    """Bulk upload endpoint backing the Excel/CSV/Bulk Upload Template feature (4.2.1)."""
    objs = []
    for p in payloads:
        obj = models.TestCase(**p.model_dump(), created_by_id=current_user.id, status="Draft", review_status="Draft")
        db.add(obj)
        objs.append(obj)
    db.commit()
    for o in objs:
        db.refresh(o)
    return objs


@router.put("/{tc_id}", response_model=schemas.TestCaseOut)
def update_test_case(tc_id: int, payload: schemas.TestCaseUpdate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(
                          Role.QA_ENGINEER, Role.QA_LEAD, Role.BUSINESS_ANALYST))):
    obj = db.query(models.TestCase).get(tc_id)
    if not obj:
        raise HTTPException(404, "Test case not found")
    _snapshot(db, obj)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(obj, k, v)
    obj.version += 1
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/{tc_id}/review", response_model=schemas.TestCaseOut)
def review_test_case(tc_id: int, payload: schemas.WorkflowDecision, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Test Case Approval workflow: Author -> Reviewer -> QA Lead (module 7)."""
    obj = db.query(models.TestCase).get(tc_id)
    if not obj:
        raise HTTPException(404, "Test case not found")
    obj.review_status = "Approved" if payload.decision == "Approved" else payload.decision
    if payload.decision == "Approved":
        obj.status = "Approved"
    db.add(models.ApprovalAction(
        entity_type="TEST_CASE", entity_id=obj.id, step_name="QA Lead",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision=payload.decision, comments=payload.comments,
    ))
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{tc_id}/versions")
def get_versions(tc_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    rows = db.query(models.TestCaseVersion).filter_by(test_case_id=tc_id).order_by(models.TestCaseVersion.version).all()
    return [{"version": r.version, "archived_at": r.archived_at, "snapshot": json.loads(r.snapshot_json)} for r in rows]


@router.post("/{tc_id}/archive", response_model=schemas.TestCaseOut)
def archive_test_case(tc_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    obj = db.query(models.TestCase).get(tc_id)
    if not obj:
        raise HTTPException(404, "Test case not found")
    obj.is_archived = True
    db.commit()
    db.refresh(obj)
    return obj
