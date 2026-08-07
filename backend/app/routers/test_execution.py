import os
from typing import List
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role, QA_DEPARTMENT
from .. import documents as doc_store
from ..xlsx_export import add_summary_sheet, add_table_sheet, new_workbook, workbook_response

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


def _runner_or_404(db: Session, user_id: int) -> models.User:
    target = db.query(models.User).get(user_id)
    if not target or not target.is_active:
        raise HTTPException(404, "Selected runner was not found or is inactive")
    if not (set(target.roles) & {Role.QA_ENGINEER, Role.QA_LEAD}):
        raise HTTPException(400, "Runner must have the QA Engineer or QA Lead role")
    if target.department != QA_DEPARTMENT:
        raise HTTPException(400, f"Runner must be mapped to the {QA_DEPARTMENT} department")
    return target


def _require_qa_assignment_manager(current_user: models.User) -> None:
    """Assignment is available to the whole IT-QA execution team.

    require_roles(*_EXEC_ROLES) checks the QA role; this additional department
    check prevents a mis-mapped QA role outside IT-QA from managing the shared
    execution queue. Administrators retain the standard global bypass.
    """
    if current_user.has_role(Role.ADMIN):
        return
    if current_user.department != QA_DEPARTMENT:
        raise HTTPException(403, f"Only members of the {QA_DEPARTMENT} team can assign testcase runners")


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


def _require_assigned_runner(obj: models.TestExecution, current_user: models.User) -> None:
    if current_user.has_role(Role.ADMIN):
        return
    if not obj.assigned_to_id:
        raise HTTPException(400, "This testcase is unassigned. An IT-QA QA Engineer or QA Lead must assign a runner before execution")
    if obj.assigned_to_id != current_user.id:
        raise HTTPException(
            403,
            f"This testcase is assigned to {obj.assigned_to_name or 'another runner'}. "
            "Ask an IT-QA QA Engineer or QA Lead to reassign it before recording an attempt.",
        )


def _prepare_execution_update(db: Session, obj: models.TestExecution, status_value: str,
                              current_user: models.User) -> None:
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    if not obj.test_case or obj.test_case.status != "Active":
        raise HTTPException(400, "This test case is awaiting QA Lead approval and cannot be executed")
    from ..constants import TEST_EXECUTION_STATUSES
    if status_value not in TEST_EXECUTION_STATUSES:
        raise HTTPException(400, f"Invalid execution status '{status_value}'")
    _require_assigned_runner(obj, current_user)


def _validate_defect_values(defect_key: str, defect_url: str = "") -> tuple[str, str]:
    key = defect_key.strip()
    url = defect_url.strip()
    if len(key) > 100:
        raise HTTPException(400, "Defect key cannot exceed 100 characters")
    if len(url) > 500:
        raise HTTPException(400, "Defect URL cannot exceed 500 characters")
    if url:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(400, "Defect URL must be a complete http:// or https:// link")
    return key, url


def _link_defect(db: Session, run: models.TestExecutionRun, payload: schemas.TestRunDefectCreate,
                 current_user: models.User) -> models.TestRunDefect:
    key, url = _validate_defect_values(payload.defect_key, payload.defect_url or "")
    if not key:
        raise HTTPException(400, "Defect key is required")
    if len((payload.title or "").strip()) > 255:
        raise HTTPException(400, "Defect title cannot exceed 255 characters")
    if len((payload.defect_status or "").strip()) > 40:
        raise HTTPException(400, "Defect status cannot exceed 40 characters")
    if len((payload.notes or "").strip()) > 5000:
        raise HTTPException(400, "Defect notes cannot exceed 5,000 characters")
    if db.query(models.TestRunDefect).filter_by(run_id=run.id, defect_key=key).first():
        raise HTTPException(400, f"Defect '{key}' is already linked to this attempt")
    defect = models.TestRunDefect(
        run_id=run.id,
        defect_key=key,
        defect_url=url or None,
        title=(payload.title or "").strip() or None,
        defect_status=(payload.defect_status or "").strip() or None,
        notes=(payload.notes or "").strip() or None,
        linked_by_id=current_user.id,
    )
    db.add(defect)
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=run.execution.cycle_id,
        step_name=f"Attempt #{run.attempt_no} Defect",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Defect Linked", comments=f"Linked defect {key} to execution attempt #{run.attempt_no}.",
    ))
    return defect


def _migrate_legacy_result_if_needed(db: Session, obj: models.TestExecution) -> None:
    """One-time, lazy migration for a row saved before per-attempt history
    existed. Before this feature shipped, a TestExecution could only ever
    hold a single result, overwritten in place on every run -- so whatever
    is on it right now (if it was ever actually run at all) IS the one and
    only attempt that existed. The first time a *new* attempt is recorded
    after upgrading, preserve that prior result as Run #1 -- including
    re-pointing its already-uploaded evidence images onto the new row --
    before it gets overwritten with the new attempt's result. A no-op once
    this has run once (or for a row that's never been executed, or that
    already has real attempt history)."""
    if obj.status == "Not Executed":
        return
    if db.query(models.TestExecutionRun).filter_by(execution_id=obj.id).first():
        return
    legacy_run = models.TestExecutionRun(
        execution_id=obj.id, attempt_no=1, status=obj.status,
        actual_result=obj.actual_result, test_run_artifacts=obj.test_run_artifacts,
        defect_id=obj.defect_id, executed_by_id=obj.executed_by_id,
        executed_at=obj.executed_at or obj.created_at,
    )
    db.add(legacy_run)
    db.flush()
    # RequestDocument's (module, request_id) pair is a loose polymorphic
    # association, not a real FK -- so "moving" an already-uploaded image
    # from the execution row onto its new Run #1 is just updating which id
    # it's keyed under, no file move needed (folder_name on disk was never
    # derived from this id -- see documents.py::save_documents).
    db.query(models.RequestDocument).filter_by(
        module=_RESULT_IMAGE_MODULE, request_id=obj.id,
    ).update({"request_id": legacy_run.id})


def _record_attempt(db: Session, obj: models.TestExecution, status_value: str,
                     actual_result, test_run_artifacts, defect_id,
                     current_user: models.User) -> models.TestExecutionRun:
    """Records a new attempt instead of overwriting the last one -- see
    models.TestExecutionRun's own docstring for why. TestExecution's own
    columns are then updated to mirror this newest attempt, purely so every
    existing list/filter/report that reads those columns directly keeps
    working unchanged."""
    _migrate_legacy_result_if_needed(db, obj)
    next_attempt_no = db.query(models.TestExecutionRun).filter_by(execution_id=obj.id).count() + 1
    executed_at = models.now()
    run = models.TestExecutionRun(
        execution_id=obj.id, attempt_no=next_attempt_no, status=status_value,
        actual_result=actual_result, test_run_artifacts=test_run_artifacts,
        defect_id=defect_id, executed_by_id=current_user.id, executed_at=executed_at,
    )
    db.add(run)
    db.flush()
    obj.status = status_value
    obj.actual_result = actual_result
    obj.test_run_artifacts = test_run_artifacts
    obj.defect_id = defect_id
    obj.executed_by_id = current_user.id
    obj.executed_at = executed_at
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=obj.cycle_id,
        step_name=f"Test Execution Attempt #{next_attempt_no}",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Attempt Recorded",
        comments=(
            f"{obj.test_case.test_case_key if obj.test_case else f'Testcase #{obj.test_case_id}'} "
            f"recorded as {status_value} by {current_user.full_name}."
        ),
    ))
    return run


def _run_or_404(db: Session, obj: models.TestExecution, run_id: int) -> models.TestExecutionRun:
    run = db.query(models.TestExecutionRun).filter_by(id=run_id, execution_id=obj.id).first()
    if not run:
        raise HTTPException(404, "Execution attempt not found")
    return run


def _latest_run_or_404(db: Session, obj: models.TestExecution) -> models.TestExecutionRun:
    run = (db.query(models.TestExecutionRun).filter_by(execution_id=obj.id)
           .order_by(models.TestExecutionRun.attempt_no.desc()).first())
    if not run:
        raise HTTPException(404, "This test case has not been executed yet")
    return run


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
    linked_request = None
    child_models = {
        "Functional": models.FunctionalRequest, "SAST": models.SASTRequest,
        "DAST": models.DASTRequest, "Performance": models.PerformanceRequest,
    }
    if payload.linked_request_id is not None:
        child_model = child_models.get(payload.linked_request_type or "")
        if not child_model:
            raise HTTPException(400, "Select a valid child request type")
        linked_request = db.query(child_model).get(payload.linked_request_id)
        if not linked_request or not linked_request.request_id:
            raise HTTPException(404, "Child request not found")
    obj = models.TestCycle(
        project_id=project_id, name=name, description=payload.description,
        start_date=payload.start_date, end_date=payload.end_date, created_by_id=current_user.id,
    )
    db.add(obj)
    if linked_request:
        db.flush()
        obj.child_request_link = models.TestCycleChildRequestLink(
            child_type=payload.linked_request_type, child_id=linked_request.id,
            child_key=linked_request.request_id,
        )
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
    link_changed = "linked_request_type" in data or "linked_request_id" in data
    link_type = data.pop("linked_request_type", None)
    link_id = data.pop("linked_request_id", None)
    for field, value in data.items():
        setattr(obj, field, value)
    if link_changed:
        if link_id is None:
            obj.child_request_link = None
        else:
            child_models = {
                "Functional": models.FunctionalRequest, "SAST": models.SASTRequest,
                "DAST": models.DASTRequest, "Performance": models.PerformanceRequest,
            }
            child_model = child_models.get(link_type or "")
            if not child_model:
                raise HTTPException(400, "Select a valid child request type")
            linked_request = db.query(child_model).get(link_id)
            if not linked_request or not linked_request.request_id:
                raise HTTPException(404, "Child request not found")
            if obj.child_request_link:
                obj.child_request_link.child_type = link_type
                obj.child_request_link.child_id = linked_request.id
                obj.child_request_link.child_key = linked_request.request_id
            else:
                obj.child_request_link = models.TestCycleChildRequestLink(
                    child_type=link_type, child_id=linked_request.id, child_key=linked_request.request_id,
                )
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/cycles/{cycle_id}/request-link", response_model=schemas.TestCycleOut)
def unlink_cycle_request(cycle_id: int, db: Session = Depends(get_db),
                         current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, obj.project_id)
    link = obj.child_request_link
    if not link:
        raise HTTPException(404, "This test cycle does not have a linked request")
    child_type, child_id, child_key = link.child_type, link.child_id, link.child_key
    obj.child_request_link = None
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=obj.id, step_name="Request Link",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Request Unlinked", comments=f"Unlinked {child_type} request {child_key}",
    ))
    if child_type == "Functional":
        db.add(models.ApprovalAction(
            entity_type="FUNCTIONAL_REQUEST", entity_id=child_id, step_name="Test Execution",
            actor_id=current_user.id, actor_role=current_user.roles_csv,
            decision="Test Cycle Unlinked", comments=f"Unlinked test cycle {obj.cycle_key} - {obj.name}",
        ))
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


@router.get("/cycles/{cycle_id}/export-xlsx")
def export_test_cycle(
    cycle_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Export one complete test lifecycle, including every retained run."""
    cycle = _get_cycle_or_404(db, cycle_id)
    project = _get_project_or_404(db, cycle.project_id)
    executions = (db.query(models.TestExecution).filter_by(cycle_id=cycle_id)
                  .order_by(models.TestExecution.id).all())

    folders = db.query(models.TestFolder).filter_by(project_id=project.id).all()
    folder_by_id = {folder.id: folder for folder in folders}

    def folder_path(folder_id):
        if not folder_id:
            return "Unfiled"
        parts, seen = [], set()
        current = folder_by_id.get(folder_id)
        while current and current.id not in seen:
            seen.add(current.id)
            parts.append(current.name)
            current = folder_by_id.get(current.parent_id)
        return " / ".join(reversed(parts)) or "Unfiled"

    real_run_ids = {run.id for execution in executions for run in execution.runs}
    legacy_execution_ids = {
        execution.id for execution in executions
        if not execution.runs and execution.status != "Not Executed"
    }
    evidence_keys = real_run_ids | legacy_execution_ids
    documents = []
    if evidence_keys:
        documents = (db.query(models.RequestDocument).filter(
            models.RequestDocument.module == _RESULT_IMAGE_MODULE,
            models.RequestDocument.request_id.in_(evidence_keys),
        ).order_by(models.RequestDocument.uploaded_at).all())
    docs_by_owner = {}
    for document in documents:
        docs_by_owner.setdefault(document.request_id, []).append(document)
    uploader_ids = {document.uploaded_by_id for document in documents if document.uploaded_by_id}
    uploader_names = {}
    if uploader_ids:
        uploader_names = {
            user.id: user.full_name
            for user in db.query(models.User).filter(models.User.id.in_(uploader_ids)).all()
        }

    actions = (db.query(models.ApprovalAction).filter_by(
        entity_type="TEST_CYCLE", entity_id=cycle.id,
    ).order_by(models.ApprovalAction.created_at).all())

    run_rows = []
    defect_rows = []
    evidence_rows = []
    for execution in executions:
        case = execution.test_case
        runs = list(execution.runs)
        if not runs and execution.status != "Not Executed":
            # Pre-attempt-history records are still retained in exports as a
            # clearly labelled legacy attempt instead of disappearing.
            run_rows.append([
                case.test_case_key, 1, execution.status, execution.actual_result,
                execution.test_run_artifacts, execution.defect_id,
                execution.executed_by_name, execution.executed_at,
                len(docs_by_owner.get(execution.id, [])),
                ", ".join(doc.file_name for doc in docs_by_owner.get(execution.id, [])),
                "Legacy current result (recorded before attempt history was enabled)",
            ])
            for document in docs_by_owner.get(execution.id, []):
                evidence_rows.append([
                    case.test_case_key, 1, document.file_name, document.content_type,
                    round((document.file_size or 0) / 1024, 2),
                    uploader_names.get(document.uploaded_by_id, "Unknown user"), document.uploaded_at,
                ])
        for run in runs:
            run_docs = docs_by_owner.get(run.id, [])
            structured_keys = ", ".join(defect.defect_key for defect in run.defects)
            run_rows.append([
                case.test_case_key, run.attempt_no, run.status, run.actual_result,
                run.test_run_artifacts, structured_keys or run.defect_id,
                run.executed_by_name, run.executed_at, len(run_docs),
                ", ".join(document.file_name for document in run_docs), "",
            ])
            for defect in run.defects:
                defect_rows.append([
                    case.test_case_key, run.attempt_no, defect.defect_key,
                    defect.defect_url, defect.title, defect.defect_status, defect.notes,
                    defect.linked_by_name, defect.created_at,
                ])
            for document in run_docs:
                evidence_rows.append([
                    case.test_case_key, run.attempt_no, document.file_name, document.content_type,
                    round((document.file_size or 0) / 1024, 2),
                    uploader_names.get(document.uploaded_by_id, "Unknown user"), document.uploaded_at,
                ])

    workbook = new_workbook()
    executed_count = sum(execution.status != "Not Executed" for execution in executions)
    pass_count = sum(execution.status in {"Pass", "Retest Passed"} for execution in executions)
    add_summary_sheet(
        workbook,
        f"{cycle.cycle_key} · Test Lifecycle",
        "Complete selected-cycle snapshot with assignments, attempts, evidence, and defect links.",
        [
            ("Cycle", cycle.name), ("Cycle ID", cycle.cycle_key),
            ("Project", f"{project.project_key} · {project.name}"), ("Cycle status", cycle.status),
            ("Start date", cycle.start_date or "—"), ("End date", cycle.end_date or "—"),
            ("Generated by", current_user.full_name), ("Generated at", models.now()),
        ],
        [
            ("Testcases", len(executions)), ("Executed", executed_count),
            ("Passed", pass_count),
            ("Failed", sum(execution.status == "Fail" for execution in executions)),
            ("Blocked", sum(execution.status == "Blocked" for execution in executions)),
            ("Unassigned", sum(not execution.assigned_to_id for execution in executions)),
            ("Attempts", len(run_rows)), ("Defect links", len(defect_rows)),
            ("Evidence files", len(evidence_rows)),
        ],
    )
    add_table_sheet(
        workbook, "Cycle Testcases", "Cycle Testcases", [
            "Test Case ID", "Version", "Folder Path", "Epic ID", "CR Number",
            "Feature ID", "User Story ID", "Test Type", "Module", "Priority",
            "Scenario", "Pre-Condition", "Latest Result", "Latest Actual Result",
            "Latest Artifact", "Latest Defect Summary", "Assigned To", "Assigned By",
            "Assigned At", "Last Runner", "Last Run At", "Attempt Count",
        ], [[
            execution.test_case.test_case_key, execution.test_case.version,
            folder_path(execution.test_case.folder_id), execution.test_case.epic_id,
            execution.test_case.cr_number, execution.test_case.feature_id,
            execution.test_case.user_story_id, execution.test_case.test_type,
            execution.test_case.module_name, execution.test_case.priority,
            execution.test_case.test_scenario, execution.test_case.pre_condition,
            execution.status, execution.actual_result, execution.test_run_artifacts,
            ", ".join(defect.defect_key for run in execution.runs for defect in run.defects)
            or execution.defect_id,
            execution.assigned_to_name, execution.assigned_by_name, execution.assigned_at,
            execution.executed_by_name, execution.executed_at,
            len(execution.runs) or (1 if execution.status != "Not Executed" else 0),
        ] for execution in executions],
        subtitle="One row per testcase slot; Latest Result mirrors the newest attempt.",
        wrap_headers={"Scenario", "Pre-Condition", "Latest Actual Result"},
        date_headers={"Assigned At", "Last Run At"}, status_headers={"Latest Result"},
        widths={"Scenario": 38, "Pre-Condition": 38, "Latest Actual Result": 48},
    )
    add_table_sheet(
        workbook, "Test Steps", "Test Steps", [
            "Test Case ID", "Version", "Step No", "Step", "Expected Result",
        ], [[
            execution.test_case.test_case_key, execution.test_case.version, step.step_no,
            step.step_text, step.expected_result,
        ] for execution in executions for step in execution.test_case.steps],
        subtitle="Definition used by each testcase in this cycle.",
        wrap_headers={"Step", "Expected Result"}, widths={"Step": 52, "Expected Result": 52},
    )
    add_table_sheet(
        workbook, "Execution Attempts", "Execution Attempt History", [
            "Test Case ID", "Attempt No", "Result", "Actual Result", "Artifact",
            "Defect Summary", "Executed By", "Executed At", "Evidence Count",
            "Evidence Files", "History Note",
        ], run_rows,
        subtitle="Every retained execution attempt; later retests never overwrite earlier results.",
        wrap_headers={"Actual Result", "Evidence Files", "History Note"},
        date_headers={"Executed At"}, status_headers={"Result"},
        widths={"Actual Result": 52, "Evidence Files": 38, "History Note": 40},
    )
    add_table_sheet(
        workbook, "Defect Links", "Structured Defect Links", [
            "Test Case ID", "Attempt No", "Defect Key", "Defect URL", "Title",
            "Defect Status", "Notes", "Linked By", "Linked At",
        ], defect_rows,
        subtitle="Defects are tied to the exact execution attempt where they were observed.",
        wrap_headers={"Title", "Notes"}, date_headers={"Linked At"},
        status_headers={"Defect Status"}, widths={"Defect URL": 42, "Notes": 48},
    )
    add_table_sheet(
        workbook, "Evidence Index", "Execution Evidence Index", [
            "Test Case ID", "Attempt No", "File Name", "Content Type", "Size (KB)",
            "Uploaded By", "Uploaded At",
        ], evidence_rows,
        subtitle="Evidence metadata index. Binary files remain protected in the portal.",
        date_headers={"Uploaded At"}, widths={"File Name": 42, "Content Type": 24},
    )
    add_table_sheet(
        workbook, "Cycle Activity", "Cycle Activity History", [
            "Activity", "Decision", "Actor", "Role Snapshot", "Comments", "Timestamp",
        ], [[
            action.step_name, action.decision, action.actor_name or "System",
            action.actor_role, action.comments, action.created_at,
        ] for action in actions],
        subtitle="Assignments, execution actions, defect links, and membership changes.",
        wrap_headers={"Comments"}, date_headers={"Timestamp"}, status_headers={"Decision"},
        widths={"Comments": 56, "Role Snapshot": 28},
    )
    return workbook_response(workbook, f"{cycle.cycle_key}_test_lifecycle.xlsx")


@router.post("/cycles/{cycle_id}/executions", response_model=List[schemas.TestExecutionOut])
def add_test_cases_to_cycle(cycle_id: int, payload: schemas.TestExecutionAdd, db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Adds one or more existing Repository test cases to this cycle,
    creating a Not-Executed TestExecution row for each -- silently skips any
    that are already in this cycle (the (cycle_id, test_case_id) unique
    constraint means re-adding one would otherwise 500)."""
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    assigned_runner = None
    if payload.assigned_to_id is not None:
        _require_qa_assignment_manager(current_user)
        assigned_runner = _runner_or_404(db, payload.assigned_to_id)
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
        obj = models.TestExecution(
            cycle_id=cycle_id, test_case_id=case_id, status="Not Executed",
            assigned_to_id=assigned_runner.id if assigned_runner else None,
            assigned_by_id=current_user.id if assigned_runner else None,
            assigned_at=models.now() if assigned_runner else None,
        )
        db.add(obj)
        created.append(obj)
        already.add(case_id)
    if created and assigned_runner:
        db.add(models.ApprovalAction(
            entity_type="TEST_CYCLE", entity_id=cycle.id, step_name="Bulk Testcase Assignment",
            actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Assigned",
            comments=f"{len(created)} testcase(s) assigned to {assigned_runner.full_name} while adding them to the cycle.",
        ))
    db.commit()
    for obj in created:
        db.refresh(obj)
    return created


@router.patch("/executions/{execution_id}/assign", response_model=schemas.TestExecutionOut)
def assign_execution(execution_id: int, payload: schemas.TestExecutionAssign,
                     db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """IT-QA runner management for one testcase slot in a cycle."""
    _require_qa_assignment_manager(current_user)
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    previous_name = obj.assigned_to_name
    target = None
    if payload.assigned_to_id is not None:
        target = _runner_or_404(db, payload.assigned_to_id)
    obj.assigned_to_id = target.id if target else None
    obj.assigned_by_id = current_user.id
    obj.assigned_at = models.now()
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=cycle.id, step_name="Testcase Assignment",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Assigned" if target else "Unassigned",
        comments=(
            f"{obj.test_case.test_case_key if obj.test_case else f'Testcase #{obj.test_case_id}'} "
            f"{'assigned to ' + target.full_name if target else 'unassigned'}"
            + (f" (previously {previous_name})" if previous_name else "")
        ),
    ))
    db.commit()
    db.refresh(obj)
    return obj


@router.patch("/executions/{execution_id}", response_model=schemas.TestExecutionOut)
def update_execution(execution_id: int, payload: schemas.TestExecutionUpdate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    """Records a new execution attempt (see models.TestExecutionRun) --
    reported directly, this used to overwrite the row's own result in
    place, silently destroying any prior attempt (e.g. a Fail with attached
    evidence, once a later retest logged a Pass)."""
    obj = _execution_or_404(db, execution_id)
    _prepare_execution_update(db, obj, payload.status, current_user)
    defect_key, _ = _validate_defect_values(payload.defect_id or "")
    if defect_key and payload.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    run = _record_attempt(db, obj, payload.status, payload.actual_result,
                          payload.test_run_artifacts, defect_key or None, current_user)
    if defect_key:
        _link_defect(db, run, schemas.TestRunDefectCreate(defect_key=defect_key), current_user)
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/cycles/{cycle_id}/executions/bulk-result", response_model=List[schemas.TestExecutionOut])
def bulk_update_execution_results(
    cycle_id: int,
    payload: schemas.TestExecutionBulkResult,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*_EXEC_ROLES)),
):
    """Record one new attempt on every selected testcase slot.

    Validation deliberately finishes for the whole selection before the
    first attempt is written. This prevents a bulk action from reporting a
    vague partial success and preserves the existing assigned-runner rule.
    """
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    execution_ids = list(dict.fromkeys(payload.execution_ids))
    if not execution_ids:
        raise HTTPException(400, "Select at least one testcase for bulk execution")
    if len(execution_ids) > 100:
        raise HTTPException(400, "Bulk execution supports at most 100 testcases at a time")

    from ..constants import TEST_EXECUTION_STATUSES
    if payload.status not in TEST_EXECUTION_STATUSES or payload.status == "Not Executed":
        raise HTTPException(400, f"'{payload.status}' is not a recordable execution result")

    actual_result = (payload.actual_result or "").strip()
    artifacts = (payload.test_run_artifacts or "").strip()
    if len(actual_result) > 10000:
        raise HTTPException(400, "Actual Result cannot exceed 10,000 characters")
    if len(artifacts) > 255:
        raise HTTPException(400, "Test Run Artifacts cannot exceed 255 characters")
    defect_key, defect_url = _validate_defect_values(payload.defect_id or "", payload.defect_url or "")
    if defect_key and payload.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    if not defect_key and any((value or "").strip() for value in (
        payload.defect_url, payload.defect_title, payload.defect_status, payload.defect_notes,
    )):
        raise HTTPException(400, "Enter a Defect Key before adding defect URL, title, status, or notes")
    if len((payload.defect_title or "").strip()) > 255:
        raise HTTPException(400, "Defect title cannot exceed 255 characters")
    if len((payload.defect_status or "").strip()) > 40:
        raise HTTPException(400, "Defect status cannot exceed 40 characters")
    if len((payload.defect_notes or "").strip()) > 5000:
        raise HTTPException(400, "Defect notes cannot exceed 5,000 characters")

    found = db.query(models.TestExecution).filter(models.TestExecution.id.in_(execution_ids)).all()
    found_by_id = {execution.id: execution for execution in found}
    missing = [str(execution_id) for execution_id in execution_ids if execution_id not in found_by_id]
    if missing:
        raise HTTPException(
            404,
            f"Bulk execution stopped. Execution record(s) not found: {', '.join(missing)}. No attempt was saved.",
        )
    wrong_cycle = [
        execution for execution in found
        if execution.cycle_id != cycle_id
    ]
    if wrong_cycle:
        labels = ", ".join(
            execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            for execution in wrong_cycle
        )
        raise HTTPException(
            400,
            f"Bulk execution stopped. These testcases do not belong to the selected cycle: {labels}. No attempt was saved.",
        )

    ordered = [found_by_id[execution_id] for execution_id in execution_ids]
    awaiting_approval = [
        execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
        for execution in ordered
        if not execution.test_case or execution.test_case.status != "Active"
    ]
    if awaiting_approval:
        raise HTTPException(
            400,
            "Bulk execution stopped. QA Lead approval is pending for: "
            f"{', '.join(awaiting_approval)}. No attempt was saved.",
        )

    if not current_user.has_role(Role.ADMIN):
        unassigned = [
            execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            for execution in ordered if not execution.assigned_to_id
        ]
        assigned_elsewhere = [
            f"{execution.test_case.test_case_key if execution.test_case else f'Execution #{execution.id}'} "
            f"({execution.assigned_to_name or 'another runner'})"
            for execution in ordered
            if execution.assigned_to_id and execution.assigned_to_id != current_user.id
        ]
        blockers = []
        if unassigned:
            blockers.append(f"unassigned: {', '.join(unassigned)}")
        if assigned_elsewhere:
            blockers.append(f"assigned to another runner: {', '.join(assigned_elsewhere)}")
        if blockers:
            raise HTTPException(
                403,
                "Bulk execution stopped because only the assigned runner can record an attempt; "
                + "; ".join(blockers)
                + ". Reassign those testcases or select only your assignments. No attempt was saved.",
            )

    for execution in ordered:
        run = _record_attempt(
            db, execution, payload.status, actual_result or None, artifacts or None,
            defect_key or None, current_user,
        )
        if defect_key:
            _link_defect(db, run, schemas.TestRunDefectCreate(
                defect_key=defect_key,
                defect_url=defect_url or None,
                title=(payload.defect_title or "").strip() or None,
                defect_status=(payload.defect_status or "").strip() or None,
                notes=(payload.defect_notes or "").strip() or None,
            ), current_user)

    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=cycle.id, step_name="Bulk Test Execution",
        actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Attempts Recorded",
        comments=(
            f"{len(ordered)} testcase attempt(s) recorded as {payload.status} "
            f"by {current_user.full_name}."
        ),
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    for execution in ordered:
        db.refresh(execution)
    return ordered


@router.post("/executions/{execution_id}/rich-result", response_model=schemas.TestExecutionOut)
def update_rich_execution_result(
    execution_id: int,
    status_value: str = Form(..., alias="status"),
    actual_result: str = Form(""),
    test_run_artifacts: str = Form(""),
    defect_id: str = Form(""),
    defect_url: str = Form(""),
    defect_title: str = Form(""),
    defect_status: str = Form(""),
    defect_notes: str = Form(""),
    files: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*_EXEC_ROLES)),
):
    """Save formatted Actual Result text and pasted/uploaded screenshots as a
    new execution attempt (see models.TestExecutionRun) -- reported
    directly, this used to overwrite the row's own result in place,
    silently destroying any prior attempt (e.g. a Fail with attached
    evidence, once a later retest logged a Pass).

    Text is retained as safe Markdown; images are authenticated documents
    linked to this exact attempt (not the execution slot as a whole), never
    embedded as unbounded base64 data.
    """
    obj = _execution_or_404(db, execution_id)
    _prepare_execution_update(db, obj, status_value, current_user)
    result_text = actual_result.strip()
    if len(result_text) > 10000:
        raise HTTPException(400, "Actual Result cannot exceed 10,000 characters")
    _validate_result_images(files)
    defect_key, validated_defect_url = _validate_defect_values(defect_id, defect_url)
    if defect_key and status_value not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    if not defect_key and any(value.strip() for value in (defect_url, defect_title, defect_notes)):
        raise HTTPException(400, "Enter a Defect Key before adding defect URL, title, or notes")
    run = _record_attempt(db, obj, status_value, result_text or None,
                           test_run_artifacts.strip() or None, defect_key or None, current_user)
    if defect_key:
        _link_defect(db, run, schemas.TestRunDefectCreate(
            defect_key=defect_key, defect_url=validated_defect_url or None,
            title=defect_title or None, defect_status=defect_status or None,
            notes=defect_notes or None,
        ), current_user)
    if files:
        # save_documents commits the pending execution/run update and
        # document metadata in the same DB transaction after the files are
        # written. Keyed by this specific attempt's own id (run.id), not
        # the execution slot's id, so each attempt's evidence stays separate.
        doc_store.save_documents(
            db, _RESULT_IMAGE_MODULE, run.id, f"execution-{obj.id}-attempt-{run.attempt_no}", files, current_user.id
        )
    else:
        db.commit()
    db.refresh(obj)
    return obj


@router.get("/executions/{execution_id}/runs", response_model=List[schemas.TestExecutionRunOut])
def list_execution_runs(execution_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Full attempt-by-attempt history for this test case's slot in this
    cycle, oldest first -- see models.TestExecutionRun."""
    obj = _execution_or_404(db, execution_id)
    return (db.query(models.TestExecutionRun).filter_by(execution_id=obj.id)
            .order_by(models.TestExecutionRun.attempt_no).all())


@router.post("/executions/{execution_id}/runs/{run_id}/defects", response_model=schemas.TestRunDefectOut)
def add_run_defect(execution_id: int, run_id: int, payload: schemas.TestRunDefectCreate,
                   db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    _require_assigned_runner(obj, current_user)
    run = _run_or_404(db, obj, run_id)
    latest_run = _latest_run_or_404(db, obj)
    if run.id != latest_run.id:
        raise HTTPException(400, "Defects can only be linked to the latest execution attempt")
    if run.status not in {"Fail", "Blocked"}:
        raise HTTPException(400, "A defect can only be linked when the latest attempt result is Fail or Blocked")
    defect = _link_defect(db, run, payload, current_user)
    db.commit()
    db.refresh(defect)
    return defect


@router.delete("/executions/{execution_id}/runs/{run_id}/defects/{defect_id}")
def remove_run_defect(execution_id: int, run_id: int, defect_id: int,
                      db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    run = _run_or_404(db, obj, run_id)
    defect = db.query(models.TestRunDefect).filter_by(id=defect_id, run_id=run.id).first()
    if not defect:
        raise HTTPException(404, "Defect link not found")
    if not (current_user.has_role(Role.QA_LEAD) or defect.linked_by_id == current_user.id):
        raise HTTPException(403, "Only the person who linked this defect, a QA Lead, or an Administrator can remove it")
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=cycle.id,
        step_name=f"Attempt #{run.attempt_no} Defect",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Defect Unlinked",
        comments=f"Unlinked defect {defect.defect_key} from execution attempt #{run.attempt_no}.",
    ))
    db.delete(defect)
    db.commit()
    return {"ok": True}


@router.get("/executions/{execution_id}/runs/{run_id}/images", response_model=List[schemas.RequestDocumentOut])
def list_run_images(execution_id: int, run_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = _run_or_404(db, obj, run_id)
    return doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id)


@router.get("/executions/{execution_id}/runs/{run_id}/images/{document_id}/download")
def download_run_image(execution_id: int, run_id: int, document_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = _run_or_404(db, obj, run_id)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
    path = doc_store.full_path(document)
    if not os.path.exists(path):
        raise HTTPException(404, "Actual Result image is missing from storage")
    return FileResponse(path, filename=document.file_name, media_type=document.content_type or "application/octet-stream")


@router.delete("/executions/{execution_id}/runs/{run_id}/images/{document_id}")
def delete_run_image(execution_id: int, run_id: int, document_id: int, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(*_EXEC_ROLES))):
    obj = _execution_or_404(db, execution_id)
    cycle = _get_cycle_or_404(db, obj.cycle_id)
    _require_active_project(db, cycle.project_id)
    run = _run_or_404(db, obj, run_id)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
    if not doc_store.can_delete_document(document, current_user):
        raise HTTPException(403, "Only the person who uploaded this image or an Administrator can delete it")
    doc_store.delete_document(db, document)
    return {"ok": True}


# ---- Backward-compatible "current result images" endpoints -- these now
# resolve to the LATEST attempt's evidence (see _latest_run_or_404), since
# result-recording itself moved from "the one and only result" to
# "attempt N of the history below" (models.TestExecutionRun). Prefer the
# /runs/{run_id}/images endpoints above for browsing a *specific* attempt's
# evidence instead of just the newest one. ----
@router.get("/executions/{execution_id}/result-images", response_model=List[schemas.RequestDocumentOut])
def list_result_images(execution_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = (db.query(models.TestExecutionRun).filter_by(execution_id=obj.id)
           .order_by(models.TestExecutionRun.attempt_no.desc()).first())
    if not run:
        return []
    return doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id)


@router.get("/executions/{execution_id}/result-images/{document_id}/download")
def download_result_image(execution_id: int, document_id: int, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    obj = _execution_or_404(db, execution_id)
    run = _latest_run_or_404(db, obj)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
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
    run = _latest_run_or_404(db, obj)
    document = doc_store.get_document_or_404(db, _RESULT_IMAGE_MODULE, run.id, document_id)
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
    # Polymorphic documents have no FK back to TestExecution/TestExecutionRun,
    # so remove the protected files and their metadata explicitly rather than
    # orphaning screenshots when the execution itself is deliberately
    # removed -- every attempt's own evidence (models.TestExecutionRun), not
    # just the legacy execution-keyed slot from before per-attempt history
    # existed.
    for run in obj.runs:
        for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id):
            doc_store.delete_document(db, document)
    for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, obj.id):
        doc_store.delete_document(db, document)
    db.delete(obj)
    db.commit()
    return {"ok": True}


@router.post("/cycles/{cycle_id}/executions/bulk-remove", response_model=schemas.TestExecutionBulkRemoveResult)
def bulk_remove_executions(
    cycle_id: int,
    payload: schemas.TestExecutionBulkRemove,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(*_EXEC_ROLES)),
):
    """Remove several testcase slots, their attempts, linked defects and
    evidence metadata from one cycle as one governed database transaction.

    Any IT-QA QA Engineer/QA Lead may manage cycle membership, matching the
    assignment permission. Files are unlinked only after the database commit
    succeeds, so a failed transaction cannot leave retained rows pointing at
    evidence that was already destroyed.
    """
    _require_qa_assignment_manager(current_user)
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    execution_ids = list(dict.fromkeys(payload.execution_ids))
    if not execution_ids:
        raise HTTPException(400, "Select at least one testcase to remove from the cycle")
    if len(execution_ids) > 100:
        raise HTTPException(400, "Bulk removal supports at most 100 testcases at a time")

    found = db.query(models.TestExecution).filter(models.TestExecution.id.in_(execution_ids)).all()
    found_by_id = {execution.id: execution for execution in found}
    missing = [str(execution_id) for execution_id in execution_ids if execution_id not in found_by_id]
    if missing:
        raise HTTPException(
            404,
            f"Bulk removal stopped. Execution record(s) not found: {', '.join(missing)}. Nothing was removed.",
        )
    ordered = [found_by_id[execution_id] for execution_id in execution_ids]
    wrong_cycle = [execution for execution in ordered if execution.cycle_id != cycle_id]
    if wrong_cycle:
        labels = ", ".join(
            execution.test_case.test_case_key if execution.test_case else f"Execution #{execution.id}"
            for execution in wrong_cycle
        )
        raise HTTPException(
            400,
            f"Bulk removal stopped. These testcases do not belong to the selected cycle: {labels}. Nothing was removed.",
        )

    removed_keys = [
        execution.test_case.test_case_key if execution.test_case else f"Testcase #{execution.test_case_id}"
        for execution in ordered
    ]
    removed_attempt_count = sum(len(execution.runs) for execution in ordered)
    documents_by_id = {}
    for execution in ordered:
        # Current evidence belongs to individual TestExecutionRun rows. The
        # execution-id lookup also includes screenshots created by the older
        # pre-attempt implementation. De-duplicate because numeric ids from
        # those two namespaces can coincide.
        for run in execution.runs:
            for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id):
                documents_by_id[document.id] = document
        for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, execution.id):
            documents_by_id[document.id] = document

    file_paths = [doc_store.full_path(document) for document in documents_by_id.values()]
    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=cycle.id, step_name="Bulk Testcase Removal",
        actor_id=current_user.id, actor_role=current_user.roles_csv, decision="Removed from Cycle",
        comments=(
            f"{len(ordered)} testcase(s) removed from {cycle.cycle_key}: "
            + ", ".join(removed_keys)
            + f". Removed {removed_attempt_count} execution attempt(s) and "
            f"{len(documents_by_id)} evidence file(s)."
        ),
    ))
    for document in documents_by_id.values():
        db.delete(document)
    for execution in ordered:
        db.delete(execution)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Database state is authoritative. A stale/missing file is harmless and
    # must not turn a successfully committed removal into a false API error.
    for path in file_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    return schemas.TestExecutionBulkRemoveResult(
        removed_count=len(ordered),
        removed_execution_ids=execution_ids,
        removed_test_case_keys=removed_keys,
        removed_attempt_count=removed_attempt_count,
        removed_evidence_count=len(documents_by_id),
    )


@router.post("/cycles/{cycle_id}/reset", response_model=schemas.TestCycleResetResult)
def reset_test_cycle(
    cycle_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles(Role.QA_LEAD)),
):
    """Reset execution state while preserving cycle membership and links.

    This is deliberately QA Lead/Admin-only because immutable attempts,
    defects and evidence are permanently removed. Database changes commit
    atomically; physical files are removed only after that commit succeeds.
    """
    _require_qa_assignment_manager(current_user)
    cycle = _get_cycle_or_404(db, cycle_id)
    _require_active_project(db, cycle.project_id)
    executions = (db.query(models.TestExecution).filter_by(cycle_id=cycle_id)
                  .order_by(models.TestExecution.id).all())
    runs = [run for execution in executions for run in execution.runs]
    removed_defect_count = sum(len(run.defects) for run in runs)

    documents_by_id = {}
    for execution in executions:
        for run in execution.runs:
            for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, run.id):
                documents_by_id[document.id] = document
        # Includes evidence from records created before attempt history was
        # introduced, where images were keyed directly by execution id.
        for document in doc_store.list_documents(db, _RESULT_IMAGE_MODULE, execution.id):
            documents_by_id[document.id] = document
    file_paths = [doc_store.full_path(document) for document in documents_by_id.values()]

    db.add(models.ApprovalAction(
        entity_type="TEST_CYCLE", entity_id=cycle.id, step_name="Lifecycle Reset",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision="Test Lifecycle Reset",
        comments=(
            f"Reset {len(executions)} testcase(s) to Not Executed. Permanently removed "
            f"{len(runs)} attempt(s), {removed_defect_count} defect link(s), and "
            f"{len(documents_by_id)} evidence file(s). Testcase membership, assignments, "
            "cycle/request link, and repository definitions were preserved."
        ),
    ))
    for document in documents_by_id.values():
        db.delete(document)
    for execution in executions:
        for run in list(execution.runs):
            db.delete(run)
        execution.status = "Not Executed"
        execution.actual_result = None
        execution.test_run_artifacts = None
        execution.defect_id = None
        execution.executed_by_id = None
        execution.executed_at = None
    cycle.status = "Not Started"
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise

    for path in file_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    return schemas.TestCycleResetResult(
        cycle_id=cycle.id,
        reset_execution_count=len(executions),
        removed_attempt_count=len(runs),
        removed_defect_count=removed_defect_count,
        removed_evidence_count=len(documents_by_id),
    )
