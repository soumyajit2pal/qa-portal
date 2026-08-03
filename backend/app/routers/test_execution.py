import os
from typing import List
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role
from .. import documents as doc_store

router = APIRouter(prefix="/api/test-execution", tags=["test-management"])

# Same access as the Test Repository (test_repository.py) -- QA Engineer +
# QA Lead both create cycles, add test cases to them, and record results.
# Admin always bypasses via require_roles.
_EXEC_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD)
_RESULT_IMAGE_MODULE = "TEST_EXEC_IMAGE"  # <= qap_module_documents.module VARCHAR2(20)
_RESULT_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_RESULT_IMAGE_LIMIT = 8
_RESULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024


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


def _require_active_project(db: Session, project_id: int) -> None:
    project = _get_project_or_404(db, project_id)
    if not project.is_active:
        raise HTTPException(400, "This Test Project is inactive. Reactivate it before changing test execution data")


def _execution_or_404(db: Session, execution_id: int) -> models.TestExecution:
    obj = db.query(models.TestExecution).get(execution_id)
    if not obj:
        raise HTTPException(404, "Execution not found")
    return obj


def _validate_result_images(files: List[UploadFile]) -> None:
    if len(files) > _RESULT_IMAGE_LIMIT:
        raise HTTPException(400, f"Actual Result can contain at most {_RESULT_IMAGE_LIMIT} new images per save")
    for image in files:
        if (image.content_type or "").lower() not in _RESULT_IMAGE_TYPES:
            raise HTTPException(400, f"'{image.filename or 'pasted image'}' is not supported. Use PNG, JPEG, GIF, or WebP")
        image.file.seek(0, os.SEEK_END)
        size = image.file.tell()
        image.file.seek(0)
        if size > _RESULT_IMAGE_MAX_BYTES:
            raise HTTPException(400, f"'{image.filename or 'pasted image'}' exceeds the 10 MB image limit")


def _prepare_execution_update(db: Session, obj: models.TestExecution, status_value: str) -> None:
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    if not obj.test_case or obj.test_case.status != "Active":
        raise HTTPException(400, "This test case is awaiting QA Lead approval and cannot be executed")
    from ..constants import TEST_EXECUTION_STATUSES
    if status_value not in TEST_EXECUTION_STATUSES:
        raise HTTPException(400, f"Invalid execution status '{status_value}'")


# ---- Cycles ----
@router.get("/projects/{project_id}/cycles", response_model=List[schemas.TestCycleOut])
def list_cycles(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_project_or_404(db, project_id)
    return db.query(models.TestCycle).filter_by(project_id=project_id).order_by(models.TestCycle.created_at.desc()).all()


@router.post("/projects/{project_id}/cycles", response_model=schemas.TestCycleOut)
def create_cycle(project_id: int, payload: schemas.TestCycleCreate, db: Session = Depends(get_db),
                  current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    _require_active_project(db, project_id)
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
    _require_active_project(db, obj.project_id)
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(obj, field, value)
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/cycles/{cycle_id}")
def delete_cycle(cycle_id: int, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Delete an empty Test Cycle. This governance action is limited to QA
    Lead/Admin and never silently destroys recorded execution evidence."""
    obj = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, obj.project_id)
    execution_count = db.query(models.TestExecution).filter_by(cycle_id=cycle_id).count()
    if execution_count:
        raise HTTPException(
            400,
            f"Cannot delete this Test Cycle because it contains {execution_count} test case execution record"
            f"{'s' if execution_count != 1 else ''}. Remove the test cases from the cycle first."
        )
    db.delete(obj)
    db.commit()
    return {"ok": True}


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
    _require_active_project(db, cycle.project_id)
    already = {
        e.test_case_id for e in
        db.query(models.TestExecution.test_case_id).filter_by(cycle_id=cycle_id).all()
    }
    requested_ids = list(dict.fromkeys(payload.test_case_ids))
    selected_cases = db.query(models.TestCase).filter(
        models.TestCase.project_id == cycle.project_id,
        models.TestCase.id.in_(requested_ids),
    ).all() if requested_ids else []
    selected_by_id = {case.id: case for case in selected_cases}
    missing = [case_id for case_id in requested_ids if case_id not in selected_by_id]
    if missing:
        raise HTTPException(404, f"{len(missing)} selected test case(s) were not found in this project")
    awaiting_approval = [case.test_case_key for case in selected_cases if case.status != "Active"]
    if awaiting_approval:
        preview = ", ".join(awaiting_approval[:5])
        suffix = "…" if len(awaiting_approval) > 5 else ""
        raise HTTPException(
            400,
            f"Cannot add {len(awaiting_approval)} test case(s) because QA Lead approval is pending: {preview}{suffix}",
        )
    created = []
    for case_id in requested_ids:
        if case_id in already:
            continue
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
    obj = _execution_or_404(db, execution_id)
    _prepare_execution_update(db, obj, payload.status)
    obj.status = payload.status
    obj.actual_result = payload.actual_result
    obj.test_run_artifacts = payload.test_run_artifacts
    obj.defect_id = payload.defect_id
    obj.executed_by_id = current_user.id
    obj.executed_at = models.now()
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/executions/{execution_id}/rich-result", response_model=schemas.TestExecutionOut)
def update_rich_execution_result(
    execution_id: int,
    status_value: str = Form(..., alias="status"),
    actual_result: str = Form(""),
    test_run_artifacts: str = Form(""),
    defect_id: str = Form(""),
    files: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*_EXEC_ROLES)),
):
    """Save formatted Actual Result text and pasted/uploaded screenshots.

    Text is retained as safe Markdown; images are authenticated documents
    linked to this exact execution, never embedded as unbounded base64 data.
    """
    obj = _execution_or_404(db, execution_id)
    _prepare_execution_update(db, obj, status_value)
    result_text = actual_result.strip()
    if len(result_text) > 10000:
        raise HTTPException(400, "Actual Result cannot exceed 10,000 characters")
    _validate_result_images(files)
    obj.status = status_value
    obj.actual_result = result_text or None
    obj.test_run_artifacts = test_run_artifacts.strip() or None
    obj.defect_id = defect_id.strip() or None
    obj.executed_by_id = current_user.id
    obj.executed_at = models.now()
    if files:
        # save_documents commits the pending execution update and document
        # metadata in the same DB transaction after the files are written.
        doc_store.save_documents(
            db, _RESULT_IMAGE_MODULE, obj.id, f"execution-{obj.id}", files, current_user.id
        )
    else:
        db.commit()
    db.refresh(obj)
    return obj


@router.get("/executions/{execution_id}/result-images", response_model=List[schemas.RequestDocumentOut])
def list_result_images(execution_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    _execution_or_404(db, execution_id)
    return doc_store.list_documents(db, _RESULT_IMAGE_MODULE, execution_id)


@router.get("/executions/{execution_id}/result-images/{document_id}/download")
def download_result_image(execution_id: int, document_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    _execution_or_404(db, execution_id)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, execution_id, document_id)
    path = doc_store.full_path(document)
    if not os.path.exists(path):
        raise HTTPException(404, "Actual Result image is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")


@router.delete("/executions/{execution_id}/result-images/{document_id}")
def delete_result_image(execution_id: int, document_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, execution_id, document_id)
    if not doc_store.can_delete_document(document, current_user):
        raise HTTPException(403, "Only the person who uploaded this image or an Administrator can delete it")
    doc_store.delete_document(db, document)
    return {"ok": True}


@router.delete("/executions/{execution_id}")
def remove_execution(execution_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Removes a test case from a cycle entirely (not the same as recording
    a result) -- e.g. it was added by mistake."""
    obj = db.query(models.TestExecution).get(execution_id)
    if not obj:
        raise HTTPException(404, "Execution not found")
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    # Polymorphic documents have no FK back to TestExecution, so remove the
    # protected files and their metadata explicitly rather than orphaning
    # screenshots when the execution itself is deliberately removed.
    for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, obj.id):
        doc_store.delete_document(db, document)
    db.delete(obj)
    db.commit()
    return {"ok": True}
