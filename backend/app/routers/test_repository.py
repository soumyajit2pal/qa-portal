import io
import os
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
import openpyxl

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..constants import Role, TEST_CASE_PRIORITIES
from ..xlsx_export import add_summary_sheet, add_table_sheet, new_workbook, workbook_response

# Canonical "Test Cases - CR-XX - Template" xlsx that import_test_cases()
# below parses -- shipped as a static, git-tracked asset (NOT the runtime
# uploads/ folder, which is excluded from deploy syncs) so the Test
# Repository "Download Template" button always has something to serve.
_IMPORT_TEMPLATE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "assets", "templates", "Test_Case_Import_Template.xlsx",
)

router = APIRouter(prefix="/api/test-repository", tags=["test-management"])

# QA Engineer + QA Lead both author (create/edit/import/delete) test cases in
# the Repository, per direct product decision -- Admin always bypasses via
# require_roles.
_AUTHOR_ROLES = (Role.QA_ENGINEER, Role.QA_LEAD)


def _case_workflow_action(case_id: int, current_user: models.User, decision: str,
                          comments: Optional[str] = None) -> models.ApprovalAction:
    return models.ApprovalAction(
        entity_type="TEST_CASE", entity_id=case_id, step_name="QA Lead Test Case Review",
        actor_id=current_user.id, actor_role=current_user.roles_csv,
        decision=decision, comments=comments,
    )


def _apply_approval_version(db: Session, obj: models.TestCase) -> None:
    """Test case versioning: a newly created case starts at 1.0 (column
    defaults). The first time it is approved it stays at 1.0. Every
    approval after that is a re-approval of a case that was edited since it
    was last Active (update_test_case / bulk_update_test_cases revert an
    Active case to Draft on substantive edits) -- those bump the minor
    version by one, e.g. 1.0 -> 1.1 -> 1.2. Detected by checking whether a
    prior 'Approved' audit row already exists for this case, rather than a
    counter, so it stays correct even if versioning is added after cases
    already have history."""
    was_approved_before = db.query(models.ApprovalAction).filter_by(
        entity_type="TEST_CASE", entity_id=obj.id, decision="Approved",
    ).first() is not None
    if was_approved_before:
        obj.version_minor += 1


def _get_project_or_404(db: Session, project_id: int) -> models.TestProject:
    obj = db.query(models.TestProject).get(project_id)
    if not obj:
        raise HTTPException(404, "Test Project not found")
    return obj


def _require_active_project(project: models.TestProject) -> None:
    if not project.is_active:
        raise HTTPException(400, "This Test Project is inactive. Reactivate it before changing repository content")


# ---- Folders ----
@router.get("/projects/{project_id}/folders", response_model=List[schemas.TestFolderOut])
def list_folders(project_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_project_or_404(db, project_id)
    return db.query(models.TestFolder).filter_by(project_id=project_id).order_by(models.TestFolder.name).all()


@router.post("/projects/{project_id}/folders", response_model=schemas.TestFolderOut)
def create_folder(project_id: int, payload: schemas.TestFolderCreate, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    _require_active_project(_get_project_or_404(db, project_id))
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


def _descendant_folder_ids(db: Session, folder_id: int) -> set:
    """Every folder id nested anywhere beneath folder_id, at any depth --
    used by _validate_new_parent's cycle guard below (a folder can never be
    re-parented under one of its own descendants, since that would
    disconnect it from the project's tree entirely -- parent_id would point
    at a node that itself hangs off the folder being moved)."""
    ids: set = set()
    frontier = [folder_id]
    while frontier:
        rows = db.query(models.TestFolder.id).filter(models.TestFolder.parent_id.in_(frontier)).all()
        frontier = [row[0] for row in rows]
        ids.update(frontier)
    return ids


def _validate_new_parent(db: Session, folder_id: int, project_id: int, new_parent_id: Optional[int]) -> None:
    """Shared cycle/existence guard for both move_folder and update_folder's
    parent_id reassignment -- raises if new_parent_id isn't a real folder in
    the same project, is the folder itself, or is one of its own descendants
    (either of which would disconnect the folder from the project's tree
    entirely). A None new_parent_id (top level) is always valid."""
    if new_parent_id is None:
        return
    if new_parent_id == folder_id:
        raise HTTPException(400, "A folder cannot be its own parent")
    parent = db.query(models.TestFolder).filter_by(id=new_parent_id, project_id=project_id).first()
    if not parent:
        raise HTTPException(404, "Destination folder not found in this project")
    if new_parent_id in _descendant_folder_ids(db, folder_id):
        raise HTTPException(400, "A folder cannot be moved into one of its own sub-folders")


@router.patch("/folders/{folder_id}", response_model=schemas.TestFolderOut)
def update_folder(folder_id: int, payload: schemas.TestFolderUpdate, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    """Reported directly: "Once folder is created, folder details should be
    editable." A folder's only real "detail" beyond its position in the tree
    is its name -- parent_id is accepted here too (same semantics as
    move_folder, via the shared _validate_new_parent guard) purely so this
    general-purpose PATCH is a complete edit endpoint on its own, even though
    the UI's dedicated Move action (see move_folder) is the primary, faster
    path for repositioning a folder."""
    obj = db.query(models.TestFolder).get(folder_id)
    if not obj:
        raise HTTPException(404, "Folder not found")
    _require_active_project(_get_project_or_404(db, obj.project_id))
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(400, "Folder name cannot be blank")
        obj.name = name
    if "parent_id" in payload.model_fields_set:
        new_parent_id = data.get("parent_id")
        _validate_new_parent(db, folder_id, obj.project_id, new_parent_id)
        obj.parent_id = new_parent_id
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db),
                   current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Folder deletion is a governance action reserved for QA Lead/Admin.
    QA Engineers may create and populate folders but cannot remove them."""
    obj = db.query(models.TestFolder).get(folder_id)
    if not obj:
        raise HTTPException(404, "Folder not found")
    _require_active_project(_get_project_or_404(db, obj.project_id))
    has_children = db.query(models.TestFolder).filter_by(parent_id=folder_id).first()
    has_cases = db.query(models.TestCase).filter_by(folder_id=folder_id).first()
    if has_children or has_cases:
        raise HTTPException(400, "Move or remove everything inside this folder before deleting it")
    db.delete(obj)
    db.commit()
    return {"ok": True}


@router.post("/folders/{folder_id}/move", response_model=schemas.TestFolderOut)
def move_folder(folder_id: int, payload: schemas.TestFolderMove, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    """Re-parents a folder (and everything already nested beneath it, which
    moves along with it automatically since children only reference their
    parent's id) to a different point in the same project's tree, or to top
    level if parent_id is null. Reported directly: "Add functionality of
    copy the folder and move the folder." Same author gate as create_folder
    -- QA Engineer or QA Lead. Cycle/existence checks are shared with
    update_folder's own parent_id handling via _validate_new_parent above."""
    obj = db.query(models.TestFolder).get(folder_id)
    if not obj:
        raise HTTPException(404, "Folder not found")
    _require_active_project(_get_project_or_404(db, obj.project_id))
    _validate_new_parent(db, folder_id, obj.project_id, payload.parent_id)
    obj.parent_id = payload.parent_id
    db.commit()
    db.refresh(obj)
    return obj


def _clone_folder_subtree(db: Session, source: models.TestFolder, new_parent_id: Optional[int],
                           current_user: models.User, name_override: Optional[str] = None) -> models.TestFolder:
    """Recursively duplicates `source` -- itself, every test case directly
    inside it (own steps included), and every child folder at any depth,
    each with its own test cases -- under new_parent_id. Every cloned test
    case is a brand-new definition (its own governed TQA-TC key, own steps)
    with status forced back to Draft, exactly like create_test_case/import
    already do for anything new: a copy is not the same approved artifact as
    its source, so it re-enters QA Lead review rather than inheriting the
    source case's current approval status."""
    new_folder = models.TestFolder(
        project_id=source.project_id, parent_id=new_parent_id,
        name=name_override or source.name, created_by_id=current_user.id,
    )
    db.add(new_folder)
    db.flush()

    for case in db.query(models.TestCase).filter_by(folder_id=source.id).order_by(models.TestCase.test_case_key).all():
        new_key = models.gen_id(models.BUSINESS_ID_PREFIXES["TEST_CASE"], db)
        new_case = models.TestCase(
            project_id=source.project_id, folder_id=new_folder.id, test_case_key=new_key,
            epic_id=case.epic_id, cr_number=case.cr_number, feature_id=case.feature_id,
            user_story_id=case.user_story_id, test_type=case.test_type, module_name=case.module_name,
            test_scenario=case.test_scenario, pre_condition=case.pre_condition, description=case.description,
            priority=case.priority, status="Draft", created_by_id=current_user.id,
        )
        new_case.steps = [
            models.TestStep(step_no=step.step_no, step_text=step.step_text, expected_result=step.expected_result)
            for step in case.steps
        ]
        new_case.tag_rows = [models.TestCaseTag(tag=tag) for tag in case.tags]
        db.add(new_case)
        db.flush()
        db.add(_case_workflow_action(
            new_case.id, current_user, "Submitted for review",
            f"Duplicated from {case.test_case_key} via folder copy and submitted to the QA Lead for verification.",
        ))

    children = db.query(models.TestFolder).filter_by(parent_id=source.id).order_by(models.TestFolder.name).all()
    for child in children:
        _clone_folder_subtree(db, child, new_folder.id, current_user)

    return new_folder


@router.post("/folders/{folder_id}/copy", response_model=schemas.TestFolderOut)
def copy_folder(folder_id: int, payload: schemas.TestFolderCopy, db: Session = Depends(get_db),
                 current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    """Duplicates a folder and its entire subtree -- child folders and every
    test case inside, at any depth -- into a new, independent copy. Reported
    directly, alongside Move above: "Add functionality of copy the folder
    and move the folder." No cycle guard is needed here (unlike Move): the
    copy always gets brand-new folder/test-case ids, so "copying a folder
    into one of its own sub-folders" is well-defined -- it just nests the
    new copy under the (untouched) original subtree."""
    source = db.query(models.TestFolder).get(folder_id)
    if not source:
        raise HTTPException(404, "Folder not found")
    _require_active_project(_get_project_or_404(db, source.project_id))
    dest_parent_id = payload.parent_id if payload.parent_id is not None else source.parent_id
    if dest_parent_id:
        dest_parent = db.query(models.TestFolder).filter_by(id=dest_parent_id, project_id=source.project_id).first()
        if not dest_parent:
            raise HTTPException(404, "Destination folder not found in this project")
    name_override = None
    if payload.name is not None:
        name_override = payload.name.strip()
        if not name_override:
            raise HTTPException(400, "Folder name cannot be blank")
    elif dest_parent_id == source.parent_id:
        # Copying into the same location as the original with no caller-given
        # name -- auto-suffix so the duplicate doesn't read as an unlabeled
        # second "same" folder sitting right next to it.
        name_override = f"{source.name} (Copy)"
    new_root = _clone_folder_subtree(db, source, dest_parent_id, current_user, name_override)
    db.commit()
    db.refresh(new_root)
    return new_root


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


@router.get("/projects/{project_id}/export-xlsx")
def export_test_repository(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Export the complete project repository and its QA review history.

    UI filters deliberately do not limit the export: this is a governed
    snapshot of the selected Project, including inactive/draft cases and
    every retained step and review event.
    """
    project = _get_project_or_404(db, project_id)
    folders = (db.query(models.TestFolder).filter_by(project_id=project_id)
               .order_by(models.TestFolder.name).all())
    cases = (db.query(models.TestCase).filter_by(project_id=project_id)
             .order_by(models.TestCase.test_case_key).all())
    folder_by_id = {folder.id: folder for folder in folders}

    def folder_path(folder_id: Optional[int]) -> str:
        if not folder_id:
            return "Unfiled"
        parts, seen = [], set()
        current = folder_by_id.get(folder_id)
        while current and current.id not in seen:
            seen.add(current.id)
            parts.append(current.name)
            current = folder_by_id.get(current.parent_id)
        return " / ".join(reversed(parts)) or "Unfiled"

    case_ids = [case.id for case in cases]
    actions = []
    if case_ids:
        actions = (db.query(models.ApprovalAction).filter(
            models.ApprovalAction.entity_type == "TEST_CASE",
            models.ApprovalAction.entity_id.in_(case_ids),
        ).order_by(models.ApprovalAction.created_at).all())
    case_key_by_id = {case.id: case.test_case_key for case in cases}

    workbook = new_workbook()
    add_summary_sheet(
        workbook,
        f"{project.project_key} · Test Repository",
        "Complete repository definition and QA Lead review snapshot.",
        [
            ("Project", project.name), ("Project ID", project.project_key),
            ("Department", project.department or "—"),
            ("Project status", "Active" if project.is_active else "Inactive"),
            ("Generated by", current_user.full_name), ("Generated at", models.now()),
        ],
        [
            ("Test cases", len(cases)),
            ("Approved", sum(case.status == "Active" for case in cases)),
            ("Pending review", sum(case.status == "Draft" for case in cases)),
            ("Deprecated", sum(case.status == "Deprecated" for case in cases)),
            ("Folders", len(folders)),
            ("Test steps", sum(len(case.steps) for case in cases)),
        ],
    )

    case_headers = [
        "Test Case ID", "Version", "Folder Path", "Epic ID", "CR Number",
        "Feature ID", "User Story ID", "Test Type", "Module", "Scenario",
        "Pre-Condition", "Description", "Priority", "Tags", "Workflow Status",
        "Created By", "Created At", "Updated At", "Step Count",
    ]
    add_table_sheet(
        workbook, "Test Cases", "Test Case Definitions", case_headers,
        [[
            case.test_case_key, case.version, folder_path(case.folder_id), case.epic_id,
            case.cr_number, case.feature_id, case.user_story_id, case.test_type,
            case.module_name, case.test_scenario, case.pre_condition, case.description,
            case.priority, ", ".join(case.tags), case.status, case.created_by_name, case.created_at,
            case.updated_at, len(case.steps),
        ] for case in cases],
        subtitle="One row per reusable testcase. Workflow Status shows its QA Lead approval state.",
        wrap_headers={"Scenario", "Pre-Condition", "Description"},
        date_headers={"Created At", "Updated At"},
        status_headers={"Workflow Status"},
        widths={"Scenario": 38, "Pre-Condition": 38, "Description": 42, "Folder Path": 26},
    )
    add_table_sheet(
        workbook, "Test Steps", "Test Steps", [
            "Test Case ID", "Version", "Step No", "Step", "Expected Result",
        ], [[
            case.test_case_key, case.version, step.step_no, step.step_text,
            step.expected_result,
        ] for case in cases for step in case.steps],
        subtitle="Every retained step in execution order.",
        wrap_headers={"Step", "Expected Result"},
        widths={"Step": 52, "Expected Result": 52},
    )
    add_table_sheet(
        workbook, "Review History", "QA Lead Review History", [
            "Test Case ID", "Review Step", "Decision", "Approver", "Role Snapshot",
            "Comments", "Timestamp",
        ], [[
            case_key_by_id.get(action.entity_id, f"Testcase #{action.entity_id}"),
            action.step_name, action.decision, action.actor_name or "System",
            action.actor_role, action.comments, action.created_at,
        ] for action in actions],
        subtitle="Append-only submission, approval, return, and re-approval events.",
        wrap_headers={"Comments"}, date_headers={"Timestamp"}, status_headers={"Decision"},
        widths={"Comments": 54, "Role Snapshot": 28},
    )
    return workbook_response(workbook, f"{project.project_key}_test_repository.xlsx")


@router.post("/projects/{project_id}/test-cases", response_model=schemas.TestCaseOut)
def create_test_case(project_id: int, payload: schemas.TestCaseCreate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    _require_active_project(_get_project_or_404(db, project_id))
    # IDs are always system-owned. Accepting a caller/import-supplied key
    # allowed arbitrary formats to leak into an otherwise governed sequence.
    key = models.gen_id(models.BUSINESS_ID_PREFIXES["TEST_CASE"], db)
    data = payload.model_dump(exclude={"steps", "test_case_key", "status", "tags"})
    obj = models.TestCase(project_id=project_id, test_case_key=key, created_by_id=current_user.id,
                          status="Draft", **data)
    obj.steps = [models.TestStep(**s.model_dump()) for s in payload.steps]
    obj.tag_rows = [models.TestCaseTag(tag=tag) for tag in _normalize_tags(payload.tags)]
    db.add(obj)
    db.flush()
    db.add(_case_workflow_action(
        obj.id, current_user, "Submitted for review",
        "Test case created and submitted to the QA Lead for verification.",
    ))
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/test-cases/by-key/{test_case_key}", response_model=schemas.TestCaseOut)
def get_test_case_by_key(test_case_key: str, db: Session = Depends(get_db),
                         current_user: models.User = Depends(get_current_user)):
    """Resolve a globally unique test-case business ID for Global Search.

    This route must remain above `/test-cases/{case_id}` so FastAPI does not
    try to parse the literal `by-key` path segment as an integer case ID.
    """
    normalized_key = test_case_key.strip().upper()
    obj = db.query(models.TestCase).filter_by(test_case_key=normalized_key).first()
    if not obj:
        raise HTTPException(404, f"Test Case {normalized_key} was not found")
    return obj


@router.get("/test-cases/{case_id}", response_model=schemas.TestCaseOut)
def get_test_case(case_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    return obj


def _enforce_checkout_lock(case: models.TestCase, current_user: models.User) -> None:
    """A checked-out test case is locked for editing/deleting to everyone
    except whoever holds the checkout -- Admin always bypasses (same escape
    hatch every other role gate in this router already gives Admin), so a
    lock nobody remembers to release can still be broken by an Administrator
    without anyone touching the database directly."""
    if case.checked_out_by_id and case.checked_out_by_id != current_user.id and not current_user.has_role():
        raise HTTPException(
            423,
            f"{case.test_case_key} is checked out by {case.checked_out_by_name} and locked for editing. "
            "Check it in first, or ask them to.",
        )


@router.post("/test-cases/{case_id}/checkout", response_model=schemas.TestCaseOut)
def checkout_test_case(case_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    """Reported directly: "check in checkout option should be available for
    testcases, otherwise multiple people can edit at once, if checkout, the
    testcase is locked for editing by that user." Explicit, SharePoint-style
    checkout -- locks a test case to whoever checks it out so nobody else's
    concurrent edit can silently race with theirs; update_test_case /
    delete_test_case / bulk_update_test_cases / bulk_delete_test_cases all
    refuse to touch a case someone else holds (see _enforce_checkout_lock).
    Idempotent for the current holder (re-checking out just refreshes the
    timestamp); rejected for anyone else while it's already held."""
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    _require_active_project(_get_project_or_404(db, obj.project_id))
    if obj.checked_out_by_id and obj.checked_out_by_id != current_user.id:
        raise HTTPException(423, f"Already checked out by {obj.checked_out_by_name}")
    obj.checked_out_by_id = current_user.id
    obj.checked_out_at = models.now()
    db.commit()
    db.refresh(obj)
    return obj


@router.post("/test-cases/{case_id}/checkin", response_model=schemas.TestCaseOut)
def checkin_test_case(case_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    """Releases a checkout. Only the holder can normally check a case back
    in; Admin may force-release an abandoned lock, same bypass as the edit/
    delete guard itself. Checking in a case that isn't checked out at all is
    a harmless no-op rather than an error -- the UI's Check In button and a
    second tab/user racing to release the same lock should never surface a
    confusing failure."""
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    if obj.checked_out_by_id and obj.checked_out_by_id != current_user.id and not current_user.has_role():
        raise HTTPException(
            423,
            f"This test case is checked out by {obj.checked_out_by_name} -- only they "
            "(or an Administrator) can check it back in",
        )
    obj.checked_out_by_id = None
    obj.checked_out_at = None
    db.commit()
    db.refresh(obj)
    return obj


@router.patch("/test-cases/{case_id}", response_model=schemas.TestCaseOut)
def update_test_case(case_id: int, payload: schemas.TestCaseUpdate, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    _require_active_project(_get_project_or_404(db, obj.project_id))
    _enforce_checkout_lock(obj, current_user)
    if "status" in payload.model_fields_set:
        raise HTTPException(400, "Test case status is controlled by QA Lead review and cannot be changed while editing")
    data = payload.model_dump(exclude_unset=True, exclude={"steps", "tags"})
    substantive_change = bool(set(data) - {"folder_id"}) or payload.steps is not None
    for field, value in data.items():
        setattr(obj, field, value)
    if payload.steps is not None:
        obj.steps = [models.TestStep(**s.model_dump()) for s in payload.steps]
    if payload.tags is not None:
        obj.tag_rows = [models.TestCaseTag(tag=tag) for tag in _normalize_tags(payload.tags)]
    if substantive_change and obj.status == "Active":
        obj.status = "Draft"
        db.add(_case_workflow_action(
            obj.id, current_user, "Resubmitted for review",
            "An approved test case was edited and must be verified again before execution.",
        ))
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/test-cases/{case_id}")
def delete_test_case(case_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    _require_active_project(_get_project_or_404(db, obj.project_id))
    _enforce_checkout_lock(obj, current_user)
    db.delete(obj)
    db.commit()
    return {"ok": True}


@router.post("/test-cases/{case_id}/review", response_model=schemas.TestCaseOut)
def review_test_case(case_id: int, payload: schemas.TestCaseReview, db: Session = Depends(get_db),
                     current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """QA Lead/Admin verification gate. Only Active (approved) test cases
    may be assigned to or executed in a Test Cycle."""
    obj = db.query(models.TestCase).get(case_id)
    if not obj:
        raise HTTPException(404, "Test Case not found")
    _require_active_project(_get_project_or_404(db, obj.project_id))
    decision = payload.decision.strip().upper()
    comments = (payload.comments or "").strip()
    if decision not in {"APPROVE", "RETURN"}:
        raise HTTPException(400, "Decision must be APPROVE or RETURN")
    if decision == "APPROVE":
        if obj.status == "Active":
            raise HTTPException(400, "This test case is already approved")
        _apply_approval_version(db, obj)
        obj.status = "Active"
        action = "Approved"
        comments = comments or "Verified by QA Lead and approved for use in Test Cycles."
    else:
        if not comments:
            raise HTTPException(400, "A reason is required when returning a test case for changes")
        obj.status = "Draft"
        action = "Changes requested"
    db.add(_case_workflow_action(obj.id, current_user, action, comments))
    db.commit()
    db.refresh(obj)
    return obj


def _selected_project_cases(db: Session, project_id: int, ids: List[int]) -> List[models.TestCase]:
    unique_ids = list(dict.fromkeys(ids))
    if not unique_ids:
        raise HTTPException(400, "Select at least one test case")
    rows = db.query(models.TestCase).filter(
        models.TestCase.project_id == project_id, models.TestCase.id.in_(unique_ids)).all()
    found = {row.id for row in rows}
    missing = [case_id for case_id in unique_ids if case_id not in found]
    if missing:
        raise HTTPException(404, f"{len(missing)} selected test case(s) were not found in this project")
    return rows


def _normalize_tags(tags: List[str]) -> List[str]:
    normalized = []
    seen = set()
    for raw in tags or []:
        tag = " ".join((raw or "").strip().split())[:80]
        key = tag.casefold()
        if tag and key not in seen:
            seen.add(key)
            normalized.append(tag)
    return normalized[:30]


@router.post("/projects/{project_id}/test-cases/bulk-update", response_model=List[schemas.TestCaseOut])
def bulk_update_test_cases(project_id: int, payload: schemas.TestCaseBulkUpdate,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    _require_active_project(_get_project_or_404(db, project_id))
    rows = _selected_project_cases(db, project_id, payload.ids)
    for row in rows:
        _enforce_checkout_lock(row, current_user)
    changes = payload.model_fields_set - {"ids"}
    if not changes:
        raise HTTPException(400, "Choose at least one field to update")
    if "status" in changes:
        raise HTTPException(400, "Test case status is controlled by QA Lead review and cannot be bulk updated")
    if "folder_id" in changes and payload.folder_id is not None:
        if not db.query(models.TestFolder).filter_by(id=payload.folder_id, project_id=project_id).first():
            raise HTTPException(404, "Folder not found in this project")
    if "priority" in changes and payload.priority not in TEST_CASE_PRIORITIES:
        raise HTTPException(400, "Invalid test case priority")
    for row in rows:
        if "folder_id" in changes:
            row.folder_id = payload.folder_id
        if "priority" in changes:
            row.priority = payload.priority
        if "test_type" in changes:
            row.test_type = payload.test_type
        if "module_name" in changes:
            row.module_name = payload.module_name
        if "tags" in changes:
            row.tag_rows = [models.TestCaseTag(tag=tag) for tag in _normalize_tags(payload.tags or [])]
        substantive_changes = changes.intersection({"priority", "test_type", "module_name"})
        if substantive_changes and row.status == "Active":
            row.status = "Draft"
            db.add(_case_workflow_action(
                row.id, current_user, "Resubmitted for review",
                "Test case classification was changed in a bulk update; QA Lead verification is required again.",
            ))
    db.commit()
    for row in rows:
        db.refresh(row)
    return rows


@router.post("/projects/{project_id}/test-cases/bulk-delete")
def bulk_delete_test_cases(project_id: int, payload: schemas.TestCaseBulkDelete,
                           db: Session = Depends(get_db),
                           current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    _require_active_project(_get_project_or_404(db, project_id))
    rows = _selected_project_cases(db, project_id, payload.ids)
    for row in rows:
        _enforce_checkout_lock(row, current_user)
    deleted_ids = [row.id for row in rows]
    for row in rows:
        db.delete(row)
    db.commit()
    return {"deleted": len(deleted_ids), "ids": deleted_ids}


@router.post("/projects/{project_id}/test-cases/bulk-approve", response_model=List[schemas.TestCaseOut])
def bulk_approve_test_cases(project_id: int, payload: schemas.TestCaseBulkApprove,
                            db: Session = Depends(get_db),
                            current_user: models.User = Depends(require_roles(Role.QA_LEAD))):
    """Approve several pending definitions in one atomic QA Lead decision.
    One approver message is deliberately reused for every case-specific audit
    row, so each testcase retains a complete history without asking the lead
    to repeat the same message."""
    _require_active_project(_get_project_or_404(db, project_id))
    rows = _selected_project_cases(db, project_id, payload.ids)
    comments = payload.comments.strip()
    if not comments:
        raise HTTPException(400, "Enter one approval message for the selected test cases")
    if len(comments) > 5000:
        raise HTTPException(400, "Approval message cannot exceed 5,000 characters")
    not_pending = [row.test_case_key for row in rows if row.status != "Draft"]
    if not_pending:
        preview = ", ".join(not_pending[:5])
        suffix = "…" if len(not_pending) > 5 else ""
        raise HTTPException(
            400,
            f"Bulk approval stopped because {len(not_pending)} selected test case(s) are not pending QA Lead review: {preview}{suffix}",
        )
    for row in rows:
        _apply_approval_version(db, row)
        row.status = "Active"
        db.add(_case_workflow_action(row.id, current_user, "Approved", comments))
    db.commit()
    for row in rows:
        db.refresh(row)
    return rows


# ---- xlsx import ----
# Maps the attached template's exact column headers (case/whitespace
# tolerant -- see _normalize_header) to the field each one feeds. Any column
# not in this map is ignored rather than rejected, so the template can gain
# extra columns later without breaking the parser.
_HEADER_MAP = {
    "test case id": "test_case_key",
    "epic id": "epic_id",
    "cr number": "cr_number",
    "cr id": "cr_number",
    "change request": "cr_number",
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
    "tags": "tags",
    "labels": "tags",
    "actual result": "actual_result",
    "status (pass/fail/blocked/na/retest passed)": "status",
    "test run artifacts": "test_run_artifacts",
    "defect id (if any)": "defect_id",
}

# Fields captured only from the first row of a test case's block (the
# template leaves these blank on every subsequent step row -- see the
# template's own merged-cell-style layout).
_CASE_LEVEL_FIELDS = [
    "epic_id", "cr_number", "feature_id", "user_story_id", "test_type", "module_name",
    "test_scenario", "pre_condition", "description", "priority", "tags",
]
_EXECUTION_LEVEL_FIELDS = ["actual_result", "status", "test_run_artifacts", "defect_id"]


def _normalize_header(h) -> str:
    return str(h or "").strip().lower()


def _clean(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


@router.get("/import-template")
def download_import_template(current_user: models.User = Depends(get_current_user)):
    """Serves the canonical "Test Cases - CR-XX - Template" xlsx that
    import_test_cases() below expects, so users import test cases using
    this template only instead of an arbitrary spreadsheet. Any
    authenticated user may download it -- it carries no project data,
    just the required header row and example rows."""
    if not os.path.exists(_IMPORT_TEMPLATE_PATH):
        raise HTTPException(404, "Import template file is missing on the server")
    return FileResponse(
        _IMPORT_TEMPLATE_PATH,
        filename="Test Case Import Template.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.post("/projects/{project_id}/import-xlsx", response_model=schemas.TestCaseImportResult)
async def import_test_cases(project_id: int, file: UploadFile = File(...), folder_id: Optional[int] = Form(None),
                             db: Session = Depends(get_db),
                             current_user: models.User = Depends(require_roles(*_AUTHOR_ROLES))):
    """Parses the attached "Test Cases - CR-XX - Template" xlsx format: one
    row per test step, with the test case's own descriptive fields (Epic ID,
    Feature ID, Test Scenario, Priority, etc.) filled in only on the first
    row of each test case's block and left blank on every subsequent step
    row -- a new block starts whenever the "Test Case ID" column is non-empty
    again. Every imported definition enters Draft/Pending QA Lead Review.
    Execution-result columns are deliberately not imported into a cycle:
    only a QA Lead-approved test case may enter Test Execution."""
    _require_active_project(_get_project_or_404(db, project_id))
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
    imported_source_keys: set[str] = set()

    def flush_group(case_row: dict, step_rows: List[dict], source_row: int):
        nonlocal created_test_cases, skipped_rows
        source_key = str(case_row.get("test_case_key") or "").strip()
        if source_key and source_key.casefold() in imported_source_keys:
            group_rows = max(1, len(step_rows))
            end_row = source_row + group_rows - 1
            row_label = f"Rows {source_row}-{end_row}" if end_row > source_row else f"Row {source_row}"
            errors.append(
                f"{row_label}: source Test Case ID '{source_key}' occurs more than once in this workbook; "
                "the duplicate block was skipped."
            )
            skipped_rows += group_rows
            return
        if source_key:
            imported_source_keys.add(source_key.casefold())
        # The spreadsheet's Test Case ID still groups its step rows, but the
        # repository assigns its own governed key instead of importing an
        # arbitrary external format.
        key = models.gen_id(models.BUSINESS_ID_PREFIXES["TEST_CASE"], db)
        tc = models.TestCase(
            project_id=project_id, folder_id=folder_id, test_case_key=key,
            epic_id=case_row.get("epic_id"), cr_number=case_row.get("cr_number"),
            feature_id=case_row.get("feature_id"),
            user_story_id=case_row.get("user_story_id"), test_type=case_row.get("test_type"),
            module_name=case_row.get("module_name"), test_scenario=case_row.get("test_scenario"),
            pre_condition=case_row.get("pre_condition"), description=case_row.get("description"),
            priority=case_row.get("priority"), status="Draft", created_by_id=current_user.id,
        )
        tc.tag_rows = [
            models.TestCaseTag(tag=tag)
            for tag in _normalize_tags((case_row.get("tags") or "").split(","))
        ]
        tc.steps = [
            models.TestStep(step_no=i + 1, step_text=s.get("step_text"), expected_result=s.get("expected_result"))
            for i, s in enumerate(step_rows)
            if s.get("step_text") or s.get("expected_result")
        ]
        db.add(tc)
        db.flush()
        db.add(_case_workflow_action(
            tc.id, current_user, "Submitted for review",
            f"Imported from Excel row {source_row}"
            + (f" (source Test Case ID: {source_key})" if source_key else "")
            + " and submitted to the QA Lead for verification.",
        ))
        created_test_cases += 1

    current_case: Optional[dict] = None
    current_steps: List[dict] = []
    current_case_source_row = 0
    for excel_row_number, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if row is None or all(c is None for c in row):
            continue
        parsed = {}
        for idx, field in col_fields.items():
            if idx < len(row):
                parsed[field] = _clean(row[idx])

        starts_new_case = bool(parsed.get("test_case_key"))
        if starts_new_case:
            if current_case is not None:
                flush_group(current_case, current_steps, current_case_source_row)
            current_case = {f: parsed.get(f) for f in _CASE_LEVEL_FIELDS + _EXECUTION_LEVEL_FIELDS}
            current_case["test_case_key"] = parsed.get("test_case_key")
            current_steps = []
            current_case_source_row = excel_row_number

        # The supplied template deliberately allows Test Case ID to be left
        # blank (the example block has six populated steps but no ID). When
        # the first populated row clearly contains case-level information,
        # treat it as a valid new test case and generate the ID in
        # flush_group instead of reporting every following step as orphaned.
        if current_case is None and any(parsed.get(f) for f in _CASE_LEVEL_FIELDS):
            current_case = {f: parsed.get(f) for f in _CASE_LEVEL_FIELDS + _EXECUTION_LEVEL_FIELDS}
            current_case["test_case_key"] = None
            current_steps = []
            current_case_source_row = excel_row_number

        if current_case is None:
            # A step-only row appeared before any Test Case ID was ever seen
            # -- malformed sheet, nothing to attach it to.
            skipped_rows += 1
            step_label = parsed.get("step_no_label") or "unlabelled step"
            errors.append(
                f"Row {excel_row_number}: {step_label} was skipped because it appears before any Test Case ID "
                "or populated test-case details. Fill in Test Case ID, Epic ID, Test Scenario, or another case field."
            )
            continue
        if parsed.get("step_text") or parsed.get("expected_result"):
            current_steps.append({"step_text": parsed.get("step_text"), "expected_result": parsed.get("expected_result")})

    if current_case is not None:
        flush_group(current_case, current_steps, current_case_source_row)

    if created_test_cases == 0 and skipped_rows == 0:
        errors.append("No test cases were found. Confirm that data starts below the header row and uses the standard template columns.")

    db.commit()
    failure_reason = None
    if created_test_cases == 0:
        failure_reason = errors[0] if errors else (
            "No test cases were created. The workbook did not contain a recognizable test-case block."
        )

    return schemas.TestCaseImportResult(
        created_test_cases=created_test_cases, imported_executions=imported_executions,
        skipped_rows=skipped_rows, errors=errors, failure_reason=failure_reason,
    )
