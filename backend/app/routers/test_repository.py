import io
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
import openpyxl

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role

router = APIRouter(prefix="/api/test-repository", tags=["test-management"])

# QA Engineer + QA Lead both author (create/edit/import/delete) test cases in
# the Repository, per direct product decision -- Admin always bypasses via
# require_roles.
_AUTHOR_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD)


def _get_project_or_404(db: Session, project_id: int) -> models.TestProject:
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    return obj


# ---- Folders ----
@router.get("/projects/{project_id}/folders", response_model=List[schemas.TestFolderOut])
def list_folders(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_project_or_404(db, project_id)
    return db.query(models.TestFolder).filter_by(project_id=project_id).order_by(models.TestFolder.name).all()


@router.post("/projects/{project_id}/folders", response_model=schemas.TestFolderOut)
def create_folder(project_id: int, payload: schemas.TestFolderCreate, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    _get_project_or_404(db, project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Folder name cannot be blank")
    if payload.parent_id:
        parent = db.query(models.TestFolder).filter_by(id=payload.parent_id, project_id=project_id).first()
        if not parent:
            raise HTTPException(404, "Parent folder not found in this project")
    obj = models.TestFolder(project_id=project_id, parent_id=payload.parent_id, name=name,
                             created_by_id=current_user.id)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    obj = db.query(models.TestFolder).get(folder_id)
    if not obj:
        raise HTTPException(404, "Folder not found")
    has_children = db.query(models.TestFolder).filter_by(parent_id=folder_id).first()
    has_cases = db.query(models.TestCase).filter_by(folder_id=folder_id).first()
    if has_children or has_cases:
        raise HTTPException(400, "Move or remove everything inside this folder before deleting it")
    db.delete(obj)
    db.commit()
    return {"ok": True}


# ---- Test Cases ----
@router.get("/projects/{project_id}/test-cases", response_model=List[schemas.TestCaseOut])
def list_test_cases(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Every test case in the project, folder assignment included -- the
    Repository UI groups these into its folder tree client-side rather than
    fetching per-folder, same convention as every other list+client-filter
    table in this app."""
    _get_project_or_404(db, project_id)
    return (db.query(models.TestCase).filter_by(project_id=project_id)
            .order_by(models.TestCase.created_at.desc()).all())


@router.post("/projects/{project_id}/test-cases", response_model=schemas.TestCaseOut)
def create_test_case(project_id: int, payload: schemas.TestCaseCreate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    _get_project_or_404(db, project_id)
    key = (payload.test_case_key or "").strip() or models.gen_id("TC")
    if db.query(models.TestCase).filter_by(test_case_key=key).first():
        raise HTTPException(400, f"Test Case ID '{key}' already exists")
    data = payload.model_dump(exclude={"steps", "test_case_key"})
    obj = models.TestCase(project_id=project_id, test_case_key=key, created_by_id=current_user.id, **data)
    obj.steps = [models.TestStep(**s.model_dump()) for s in payload.steps]
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/test-cases/{case_id}", response_model=schemas.TestCaseOut)
def get_test_case(case_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    return obj


@router.patch("/test-cases/{case_id}", response_model=schemas.TestCaseOut)
def update_test_case(case_id: int, payload: schemas.TestCaseUpdate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    data = payload.model_dump(exclude_unset=True, exclude={"steps"})
    for field, value in data.items():
        setattr(obj, field, value)
    if payload.steps is not None:
        obj.steps = [models.TestStep(**s.model_dump()) for s in payload.steps]
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/test-cases/{case_id}")
def delete_test_case(case_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    db.delete(obj)
    db.commit()
    return {"ok": True}


# ---- xlsx import ----
# Maps the attached template's exact column headers (case/whitespace
# tolerant -- see _normalize_header) to the field each one feeds. Any column
# not in this map is ignored rather than rejected, so the template can gain
# extra columns later without breaking the parser.
_HEADER_MAP = {
    "test case id": "test_case_key",
    "epic id": "epic_id",
    "feature id": "feature_id",
    "user story id": "user_story_id",
    "test type": "test_type",
    "module name (if any)": "module_name",
    "test scenario": "test_scenario",
    "pre-condition (if any)": "pre_condition",
    "test case description": "description",
    "step no.": "step_no_label",
    "steps": "step_text",
    "expected result": "expected_result",
    "priority (critical/high/medium/low)": "priority",
    "actual result": "actual_result",
    "status (pass/fail/blocked/na/retest passed)": "status",
    "test run artifacts": "test_run_artifacts",
    "defect id (if any)": "defect_id",
}

# Fields captured only from the first row of a test case's block (the
# template leaves these blank on every subsequent step row -- see the
# template's own merged-cell-style layout).
_CASE_LEVEL_FIELDS = [
    "epic_id", "feature_id", "user_story_id", "test_type", "module_name",
    "test_scenario", "pre_condition", "description", "priority",
]
_EXECUTION_LEVEL_FIELDS = ["actual_result", "status", "test_run_artifacts", "defect_id"]


def _normalize_header(h) -> str:
    return str(h or "").strip().lower()


def _clean(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


@router.post("/projects/{project_id}/import-xlsx", response_model=schemas.TestCaseImportResult)
async def import_test_cases(project_id: int, file: UploadFile = File(...), folder_id: Optional[int] = Form(None),
                             db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    """Parses the attached "Test Cases - CR-XX - Template" xlsx format: one
    row per test step, with the test case's own descriptive fields (Epic ID,
    Feature ID, Test Scenario, Priority, etc.) filled in only on the first
    row of each test case's block and left blank on every subsequent step
    row -- a new block starts whenever the "Test Case ID" column is non-empty
    again. Creates one TestCase (+ its TestStep rows) per block; if that
    first row also has a Status/Actual Result/Test Run Artifacts/Defect ID
    filled in (i.e. someone already ran this test case and recorded the
    result directly in the sheet), an initial TestExecution is created too,
    under a get-or-created "Imported from Excel" cycle, so those results
    aren't lost on import."""
    _get_project_or_404(db, project_id)
    if folder_id:
        if not db.query(models.TestFolder).filter_by(id=folder_id, project_id=project_id).first():
            raise HTTPException(404, "Folder not found in this project")

    raw = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    except Exception:
        raise HTTPException(400, "Could not read this file as an Excel (.xlsx) workbook")
    ws = wb.worksheets[0]

    header_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), None)
    if not header_row:
        raise HTTPException(400, "Sheet has no header row")
    col_fields: dict = {}
    for idx, header in enumerate(header_row):
        field = _HEADER_MAP.get(_normalize_header(header))
        if field:
            col_fields[idx] = field

    if "test_case_key" not in col_fields.values():
        raise HTTPException(400, "Could not find a 'Test Case ID' column -- is this the right template?")

    created_test_cases = 0
    imported_executions = 0
    skipped_rows = 0
    errors: List[str] = []
    imported_cycle: Optional[models.TestCycle] = None

    def get_imported_cycle() -> models.TestCycle:
        nonlocal imported_cycle
        if imported_cycle is None:
            imported_cycle = (db.query(models.TestCycle)
                               .filter_by(project_id=project_id, name="Imported from Excel").first())
            if not imported_cycle:
                imported_cycle = models.TestCycle(project_id=project_id, name="Imported from Excel",
                                                   description="Auto-created to hold results already recorded "
                                                                "in an uploaded Excel sheet at import time.",
                                                   created_by_id=current_user.id)
                db.add(imported_cycle)
                db.flush()
        return imported_cycle

    def flush_group(case_row: dict, step_rows: List[dict]):
        nonlocal created_test_cases, imported_executions, skipped_rows
        key = case_row.get("test_case_key") or models.gen_id("TC")
        if db.query(models.TestCase).filter_by(test_case_key=key).first():
            errors.append(f"'{key}' already exists in the Repository -- skipped")
            skipped_rows += 1
            return
        tc = models.TestCase(
            project_id=project_id, folder_id=folder_id, test_case_key=key,
            epic_id=case_row.get("epic_id"), feature_id=case_row.get("feature_id"),
            user_story_id=case_row.get("user_story_id"), test_type=case_row.get("test_type"),
            module_name=case_row.get("module_name"), test_scenario=case_row.get("test_scenario"),
            pre_condition=case_row.get("pre_condition"), description=case_row.get("description"),
            priority=case_row.get("priority"), status="Active", created_by_id=current_user.id,
        )
        tc.steps = [
            models.TestStep(step_no=i + 1, step_text=s.get("step_text"), expected_result=s.get("expected_result"))
            for i, s in enumerate(step_rows)
            if s.get("step_text") or s.get("expected_result")
        ]
        db.add(tc)
        created_test_cases += 1

        if any(case_row.get(f) for f in _EXECUTION_LEVEL_FIELDS):
            db.flush()  # need tc.id
            cycle = get_imported_cycle()
            status = case_row.get("status") or "Not Executed"
            db.add(models.TestExecution(
                cycle_id=cycle.id, test_case_id=tc.id, status=status,
                actual_result=case_row.get("actual_result"),
                test_run_artifacts=case_row.get("test_run_artifacts"),
                defect_id=case_row.get("defect_id"),
                executed_by_id=current_user.id, executed_at=models.now(),
            ))
            imported_executions += 1

    current_case: Optional[dict] = None
    current_steps: List[dict] = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row is None or all(c is None for c in row):
            continue
        parsed = {}
        for idx, field in col_fields.items():
            if idx < len(row):
                parsed[field] = _clean(row[idx])

        starts_new_case = bool(parsed.get("test_case_key"))
        if starts_new_case:
            if current_case is not None:
                flush_group(current_case, current_steps)
            current_case = {f: parsed.get(f) for f in _CASE_LEVEL_FIELDS + _EXECUTION_LEVEL_FIELDS}
            current_case["test_case_key"] = parsed.get("test_case_key")
            current_steps = []

        if current_case is None:
            # A step-only row appeared before any Test Case ID was ever seen
            # -- malformed sheet, nothing to attach it to.
            skipped_rows += 1
            continue
        if parsed.get("step_text") or parsed.get("expected_result"):
            current_steps.append({"step_text": parsed.get("step_text"), "expected_result": parsed.get("expected_result")})

    if current_case is not None:
        flush_group(current_case, current_steps)

    db.commit()
    return schemas.TestCaseImportResult(
        created_test_cases=created_test_cases, imported_executions=imported_executions,
        skipped_rows=skipped_rows, errors=errors,
    )
