"""Atomic relocation of unused Draft testcase identities between projects."""
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from . import models, schemas
from .constants import Role
from .deps import require_can_author_repository
from .project_workspace_ownership import assert_owned, validated_case_project_moves
from .testcase_imports import TEST_CASE_IMPORT_CONTENT_FIELDS, build_test_case_import_fingerprint
from .workflow_authority import is_system_admin


def _fingerprint(case):
    version = case.current_draft_version or case.current_approved_version
    definition = version or case
    return build_test_case_import_fingerprint(
        {field: getattr(definition, field) for field in TEST_CASE_IMPORT_CONTENT_FIELDS},
        [{"step_text": step.step_text, "expected_result": step.expected_result}
         for step in definition.steps],
    )


def _prepare(db, source_id, ids, target_id, folder_id, user, *, lock=False):
    ids = list(dict.fromkeys(ids))
    if not ids or len(ids) > 500:
        raise HTTPException(400, 'Select between 1 and 500 test cases')
    if source_id == target_id:
        raise HTTPException(400, 'Choose a different destination project')
    project_query = db.query(models.TestProject).filter(
        models.TestProject.id.in_(sorted({source_id, target_id}))).order_by(models.TestProject.id)
    if lock:
        project_query = project_query.populate_existing().with_for_update()
    projects = {project.id: project for project in project_query.all()}
    if source_id not in projects or target_id not in projects:
        raise HTTPException(404, 'Source or destination project not found')
    source, target = projects[source_id], projects[target_id]
    for project in (source, target):
        require_can_author_repository(db, project.id, user)
        if not project.is_active or project.is_archived:
            raise HTTPException(400, 'Both projects must be active to move test cases')
    workspace_id = getattr(user, 'active_qa_workspace_id', None)
    if workspace_id is None or source.qa_workspace_id != workspace_id or target.qa_workspace_id != workspace_id:
        raise HTTPException(403, 'Test cases can only move between projects in the current workspace')
    folder = None
    if folder_id is not None:
        folder_query = db.query(models.TestFolder).filter_by(id=folder_id, project_id=target_id)
        if lock:
            folder_query = folder_query.populate_existing().with_for_update()
        folder = folder_query.first()
        if folder is None:
            raise HTTPException(404, 'Destination folder not found in that project')
        assert_owned(db, folder, user)

    # Refresh after the locks: a case may have been submitted, reserved or
    # moved by another request since its detail/selection was first read.
    if lock:
        db.query(models.TestCase.id).filter(models.TestCase.project_id == source_id,
                                           models.TestCase.id.in_(ids)).order_by(
            models.TestCase.id).with_for_update().all()
    rows = db.query(models.TestCase).filter(
        models.TestCase.project_id == source_id, models.TestCase.id.in_(ids)
    ).options(selectinload(models.TestCase.versions).selectinload(models.TestCaseVersion.steps),
              selectinload(models.TestCase.steps)).populate_existing().all()
    by_id = {case.id: case for case in rows}
    if any(case_id not in by_id for case_id in ids):
        raise HTTPException(404, 'Some selected test cases are no longer in the source project; refresh the selection')
    rows = [by_id[case_id] for case_id in ids]

    linked_ids = {case_id for (case_id,) in db.query(models.TestExecution.test_case_id).filter(
        models.TestExecution.test_case_id.in_(ids)).all()}
    defect_ids = {case_id for (case_id,) in db.query(models.Defect.primary_test_case_id).filter(
        models.Defect.primary_test_case_id.in_(ids)).all()}
    defect_ids.update(case_id for (case_id,) in db.query(models.DefectTestCaseLink.test_case_id).filter(
        models.DefectTestCaseLink.test_case_id.in_(ids)).all())
    history_ids = set()
    for action in db.query(models.ApprovalAction).filter(
            models.ApprovalAction.entity_type == 'TEST_CASE', models.ApprovalAction.entity_id.in_(ids)).all():
        decision = (action.decision or '').casefold()
        if (any(word in decision for word in ('submit', 'recommend', 'approv', 'reject', 'return', 'archiv'))
                or any(state and state != 'Draft' for state in (action.previous_state, action.new_state))):
            history_ids.add(action.entity_id)

    # Include deleted cases and retained import fingerprints, as import does.
    destination = db.query(models.TestCase).filter_by(project_id=target_id).options(
        selectinload(models.TestCase.current_draft_version).selectinload(models.TestCaseVersion.steps),
        selectinload(models.TestCase.current_approved_version).selectinload(models.TestCaseVersion.steps),
        selectinload(models.TestCase.steps)).all()
    matches = {}
    for case in destination:
        matches[_fingerprint(case)] = case
        if case.import_fingerprint:
            matches[case.import_fingerprint] = case
    batch_fingerprints = {}
    fingerprints = {case.id: _fingerprint(case) for case in rows}
    for case in rows:
        batch_fingerprints.setdefault(fingerprints[case.id], []).append(case.id)

    blocked, eligible = [], []
    broader_authority = is_system_admin(user) or user.has_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)
    for case in rows:
        reasons = []
        if (case.origin_workspace_id or source.qa_workspace_id) != workspace_id:
            reasons.append('This test case belongs to another workspace')
        if not broader_authority and case.created_by_id != user.id:
            reasons.append('Only the creator or a QA Lead/Administrator can move this test case')
        if case.is_deleted:
            reasons.append('Restore this test case from the Recycle Bin first')
        if (case.status != 'Draft' or not case.current_draft_version_id or case.current_approved_version_id
                or case.id in history_ids or not case.versions
                or any(version.status != 'Draft' or version.submitted_at or version.submitted_by_id
                       or version.reviewed_at or version.reviewed_by_id or version.qa_lead_decided_at
                       or version.qa_lead_decided_by_id for version in case.versions)):
            reasons.append('Only Draft cases that have never entered review can move; use Clone for this case')
        if case.id in linked_ids:
            reasons.append('This test case is linked to a test cycle or execution; use Clone instead')
        if case.id in defect_ids:
            reasons.append('This test case is linked to a defect; use Clone instead')
        if case.checked_out_by_id and case.checked_out_by_id != user.id:
            reasons.append('Another user has checked out this test case; release the checkout first')
        duplicate = matches.get(fingerprints[case.id]) or matches.get(case.import_fingerprint)
        if duplicate:
            location = 'destination Recycle Bin' if duplicate.is_deleted else 'destination project'
            reasons.append(f'Duplicate definition already exists as {duplicate.test_case_key} in the {location}')
        if len(batch_fingerprints[fingerprints[case.id]]) > 1:
            reasons.append('The selection contains multiple cases with the same definition; select only one')
        if reasons:
            blocked.append(schemas.TestCaseMoveBlocked(id=case.id, test_case_key=case.test_case_key, reasons=reasons))
        else:
            eligible.append(case.id)
    return source, target, folder, rows, fingerprints, schemas.TestCaseMovePreviewOut(eligible_ids=eligible, blocked=blocked)


def preview_test_case_move(db, source_id, payload, user):
    return _prepare(db, source_id, payload.ids, payload.target_project_id, payload.folder_id, user)[-1]


def move_test_cases(db, source_id, ids, payload, user):
    reason = payload.reason.strip()
    if not reason:
        raise HTTPException(400, 'A reason is required to move test cases')
    source, target, folder, cases, fingerprints, preview = _prepare(
        db, source_id, ids, payload.target_project_id, payload.folder_id, user, lock=True)
    if preview.blocked:
        labels = '; '.join(f'{item.test_case_key}: {", ".join(item.reasons)}' for item in preview.blocked[:5])
        raise HTTPException(409, detail={'message': f'No test cases were moved. {labels}',
                                         'blocked': [item.model_dump() for item in preview.blocked]})
    try:
        with validated_case_project_moves(db, cases, source, target, payload.folder_id, user):
            for case in cases:
                old_folder = case.folder.name if case.folder else 'Unfiled'
                case.project_id = target.id
                case.folder_id = payload.folder_id
                # Refresh the duplicate reservation for the current definition.
                case.import_fingerprint = fingerprints[case.id]
                db.add(models.ApprovalAction(
                    entity_type='TEST_CASE', entity_id=case.id, step_name='Test Case Project Move',
                    actor_id=user.id, actor_role=user.roles_csv, decision='Moved to another project',
                    comments=f'From {source.project_key} — {source.name} (ID {source.id}), {old_folder}; '
                             f'to {target.project_key} — {target.name} (ID {target.id}), '
                             f'{folder.name if folder else "Unfiled"}. Reason: {reason}',
                    previous_state='Draft', new_state='Draft',
                ))
            db.flush()
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'No test cases were moved. A destination duplicate was created concurrently; refresh and try again') from exc
    except Exception:
        db.rollback()
        raise
    for case in cases:
        db.refresh(case)
        db.expire(case, ['project', 'folder'])
    return cases
