"""Reviewed admin corrections, separate from business approvals.

Records are relocated, never cloned. A durable preview, row locks, a fresh
dependency fingerprint and an atomic receipt protect every apply/retry.
"""
from contextlib import contextmanager
from functools import wraps
from datetime import timedelta
import hashlib
import json
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import or_, false
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import selectinload

from . import models as m, schemas
from .constants import Role, QAStatus, QA_REQUEST_STATUSES, SAST_DAST_STATUSES, PERFORMANCE_STATUSES, SUPPRESSION_STATUSES
from .workflow_authority import is_system_admin, workflow_context
from .workspace_service import require_active_workspace, selectable_workspace_ids, inherited_workspace_access_mode

REQUESTS = {'FUNCTIONAL': m.FunctionalRequest, 'SAST': m.SASTRequest,
            'DAST': m.DASTRequest, 'PERFORMANCE': m.PerformanceRequest, 'SUPPRESSION': m.SuppressionRequest}
ENTITY_TYPES = {'FUNCTIONAL': 'FUNCTIONAL_REQUEST', 'SAST': 'SAST', 'DAST': 'DAST',
                'PERFORMANCE': 'PERFORMANCE', 'SUPPRESSION': 'SUPPRESSION'}
LEADS = (Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA)
PREVIEW_LIFETIME = timedelta(minutes=30)
MAX_CONNECTED_CASES = 5000


def dumps(value):
    return json.dumps(value, sort_keys=True, default=str, separators=(',', ':'))


def within(column, ids):
    ids = sorted(set(ids))
    return or_(*(column.in_(ids[start:start + 500]) for start in range(0, len(ids), 500))) if ids else false()


def authorize(db, user):
    if (not is_system_admin(user) or not user.is_active
            or set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS}):
        raise HTTPException(403, 'Recovery requires an active System Administrator account')
    workspace = require_active_workspace(user)
    record = db.get(m.QAWorkspace, workspace)
    if not record or not record.is_active:
        raise HTTPException(403, 'Select an active workspace before performing recovery')
    if (workspace not in selectable_workspace_ids(db, user)
            or inherited_workspace_access_mode(db, user, workspace) == 'PARENT_VIEWER'):
        raise HTTPException(403, 'Recovery requires working access to the selected workspace')
    return workspace


def _rows(db, cls, predicate, *, lock=False):
    query = db.query(cls).filter(predicate).order_by(*cls.__table__.primary_key.columns).populate_existing()
    if cls is m.TestCase:
        query = query.options(selectinload(m.TestCase.current_draft_version).selectinload(m.TestCaseVersion.steps),
                              selectinload(m.TestCase.current_approved_version).selectinload(m.TestCaseVersion.steps),
                              selectinload(m.TestCase.steps))
    elif cls is m.Defect:
        query = query.options(selectinload(m.Defect.execution_links), selectinload(m.Defect.test_case_links),
                              selectinload(m.Defect.execution_references), selectinload(m.Defect.qa_request))
    elif cls is m.TestCycleFolder:
        query = query.options(selectinload(m.TestCycleFolder.access_grants))
    return (query.with_for_update(nowait=True) if lock else query).all()


def _snapshot(rows):
    return sorted([{'table': obj.__tablename__, 'values': {
        column.name: getattr(obj, column.name) for column in obj.__table__.columns}}
        for obj in set(rows)], key=lambda row: (row['table'], dumps(row['values'])))


def _hash(rows):
    # Sensitive request inputs can affect freshness, but are never retained
    # in the preview, job payload, response or audit. Only a digest is stored.
    return hashlib.sha256(dumps(_snapshot(rows)).encode()).hexdigest()


def _request_key(obj):
    return getattr(obj, 'request_id', None) or getattr(obj, 'suppression_id', None) or f'#{obj.id}'


def _request_certificate_keys(obj):
    keys = {_request_key(obj)}
    parent = getattr(obj, 'qa_request', None)
    if parent is None and isinstance(obj, m.SuppressionRequest) and obj.linked_request:
        parent = obj.linked_request.qa_request
    if parent:
        keys.update(row.request_id for row in parent.linked_functional_requests)
    return keys


def _request_rows(db, obj):
    rows = [obj]
    parent = getattr(obj, 'qa_request', None)
    if parent is not None:
        rows.append(parent)
    rows += list(getattr(obj, 'checklist_items', []))
    rows += list(getattr(obj, 'obstacles', []))
    for obstacle in getattr(obj, 'obstacles', []):
        # Revisions of corrections and target identity changes also stale a preview.
        rows += list(getattr(obstacle, 'corrections', []))
    rows += list(getattr(obj, 'components', [])) + list(getattr(obj, 'targets', []))
    rows += list(getattr(obj, 'department_approvals', []))
    rows += list(getattr(obj, 'items', []))
    if getattr(obj, 'active_delegation', None):
        rows.append(obj.active_delegation)
    rows += _rows(db, m.QASignOff, within(m.QASignOff.testing_request_id, _request_certificate_keys(obj)))
    kind = next((key for key, cls in REQUESTS.items() if isinstance(obj, cls)), None)
    if kind:
        rows += _rows(db, m.AssignmentHistory, (m.AssignmentHistory.entity_type == ENTITY_TYPES[kind]) & (m.AssignmentHistory.entity_id == obj.id))
    if isinstance(obj, (m.SASTRequest, m.DASTRequest)):
        kind = 'SAST' if isinstance(obj, m.SASTRequest) else 'DAST'
        rows += _rows(db, m.SecurityScanResult, (m.SecurityScanResult.request_type == kind) & (m.SecurityScanResult.request_id == obj.id))
    return rows


def _certificate_blockers(db, request_keys, cycle_ids=(), defect_ids=()):
    """Reviewed/issued evidence is corrected through clearance's own process."""
    blocked = []
    for cert in _rows(db, m.QASignOff, within(m.QASignOff.testing_request_id, request_keys)):
        if cert.status not in {'DRAFT', 'CANCELLED', 'REJECTED'}:
            blocked.append(f'{cert.certificate_id} ({cert.status}): use QA Clearance review/amendment before changing its source work')
    # Include standalone cycles explicitly captured by a certificate snapshot.
    if cycle_ids or defect_ids:
        for cert in db.query(m.QASignOff).filter(m.QASignOff.certificate_data_json.isnot(None)).all():
            snapshot = cert.certificate_summary or {}
            boundary = set(snapshot.get('cycle_ids', []) + snapshot.get('defect_scope_cycle_ids', []))
            if (set(cycle_ids) & boundary or set(defect_ids) & set(snapshot.get('defect_ids', []))) and cert.status not in {'DRAFT', 'CANCELLED', 'REJECTED'}:
                blocked.append(f'{cert.certificate_id} ({cert.status}) contains a selected cycle; use QA Clearance review/amendment')
    return sorted(set(blocked))


def _migration_graph(db, project_ids):
    """Both project populations are watched, including newly added dependencies."""
    roots = []
    for cls in (m.TestProject, m.TestCase, m.TestCycle, m.TestFolder, m.TestCycleFolder):
        roots += _rows(db, cls, within(cls.id if cls is m.TestProject else cls.project_id, project_ids))
    roots += [row.application_master for row in roots if isinstance(row, m.TestProject) and row.application_master]
    cases = [row for row in roots if isinstance(row, m.TestCase)]
    cycles = [row for row in roots if isinstance(row, m.TestCycle)]
    executions = _rows(db, m.TestExecution, within(m.TestExecution.cycle_id, [row.id for row in cycles]))
    rows = roots + executions
    versions = _rows(db, m.TestCaseVersion, within(m.TestCaseVersion.test_case_id, [row.id for row in cases]))
    runs = _rows(db, m.TestExecutionRun, within(m.TestExecutionRun.execution_id, [row.id for row in executions]))
    rows += versions + runs
    for cls, column, ids in (
        (m.TestCaseTag, m.TestCaseTag.test_case_id, [row.id for row in cases]),
        (m.TestStep, m.TestStep.test_case_id, [row.id for row in cases]),
        (m.TestCaseVersionStep, m.TestCaseVersionStep.version_id, [row.id for row in versions]),
        (m.TestRunDefect, m.TestRunDefect.run_id, [row.id for row in runs]),
        (m.TestRetest, m.TestRetest.run_id, [row.id for row in runs]),
        (m.TestRetestOutcome, m.TestRetestOutcome.run_id, [row.id for row in runs]),
        (m.TestCycleChildRequestLink, m.TestCycleChildRequestLink.cycle_id, [row.id for row in cycles]),
        (m.DefectExecutionReference, m.DefectExecutionReference.execution_id, [row.id for row in executions]),
        (m.DefectExecutionLink, m.DefectExecutionLink.execution_id, [row.id for row in executions]),
        (m.DefectTestCaseLink, m.DefectTestCaseLink.test_case_id, [row.id for row in cases]),
        (m.TestCycleFolderAccess, m.TestCycleFolderAccess.folder_id, [row.id for row in roots if isinstance(row, m.TestCycleFolder)]),
    ):
        rows += _rows(db, cls, within(column, ids))
    defect_ids = {row.defect_id for row in rows if isinstance(row, (m.DefectExecutionReference, m.DefectExecutionLink, m.DefectTestCaseLink))}
    defect_ids.update(row.governed_defect_id for row in rows if isinstance(row, m.TestRunDefect) and row.governed_defect_id)
    defects = _rows(db, m.Defect, or_(within(m.Defect.id, defect_ids),
        within(m.Defect.primary_test_case_id, [row.id for row in cases]),
        within(m.Defect.cycle_id, [row.id for row in cycles]),
        within(m.Defect.execution_id, [row.id for row in executions])))
    rows += defects
    for defect in defects:
        rows += list(defect.execution_links) + list(defect.test_case_links) + list(defect.execution_references)
        rows += _rows(db, m.TestRunDefect, m.TestRunDefect.governed_defect_id == defect.id)
        rows += _rows(db, m.DefectFunctionalRequestLink, m.DefectFunctionalRequestLink.defect_id == defect.id)
        if defect.qa_request:
            rows.append(defect.qa_request)
    links = [row for row in rows if isinstance(row, m.TestCycleChildRequestLink)]
    functional_ids = {row.child_id for row in links if row.child_type == 'Functional'}
    functional_ids.update(row.functional_request_id for row in rows if isinstance(row, m.DefectFunctionalRequestLink))
    for defect in defects:
        if defect.qa_request:
            functional_ids.update(row.id for row in defect.qa_request.linked_functional_requests)
    for req in _rows(db, m.FunctionalRequest, within(m.FunctionalRequest.id, functional_ids)):
        rows += _request_rows(db, req)
    for module, ids in [('TEST_CASE_IMAGE', [row.id for row in cases]),
                        ('TEST_EXEC_IMAGE', [row.id for row in runs]),
                        ('TEST_CYCLE', [row.id for row in cycles]), ('DEFECT', [row.id for row in defects])]:
        rows += _rows(db, m.RequestDocument, (m.RequestDocument.module == module) & within(m.RequestDocument.request_id, ids))
    if len(rows) > 25000:
        raise HTTPException(413, 'This recovery is too large for an interactive transaction; select a smaller connected set')
    return list(set(rows))


def migration_plan(db, body, user, *, lock=False):
    workspace = authorize(db, user)
    if not body.source_project_id or not body.target_project_id or body.source_project_id == body.target_project_id:
        raise HTTPException(400, 'Select different source and destination projects')
    projects = _rows(db, m.TestProject, within(m.TestProject.id, [body.source_project_id, body.target_project_id]), lock=lock)
    by_id = {row.id: row for row in projects}
    if len(by_id) != 2:
        raise HTTPException(404, 'Source or destination project not found')
    source, target = by_id[body.source_project_id], by_id[body.target_project_id]
    for project in projects:
        if project.qa_workspace_id != workspace:
            raise HTTPException(403, 'Recovery moves work only between projects owned by the selected workspace')
        if not project.is_active or project.is_archived:
            raise HTTPException(409, 'Both projects must be active and unarchived')
    all_cases = _rows(db, m.TestCase, m.TestCase.project_id == source.id, lock=lock)
    all_cycles = _rows(db, m.TestCycle, m.TestCycle.project_id == source.id, lock=lock)
    source_executions = _rows(db, m.TestExecution, within(m.TestExecution.cycle_id, [row.id for row in all_cycles]), lock=lock)
    case_ids = {row.id for row in all_cases} if body.whole_project else set(body.case_ids)
    cycle_ids = {row.id for row in all_cycles} if body.whole_project else set(body.cycle_ids)
    if not case_ids <= {row.id for row in all_cases} or not cycle_ids <= {row.id for row in all_cycles}:
        raise HTTPException(409, 'Selected work is no longer in the source project; refresh the selection')
    if not case_ids and not cycle_ids and not body.whole_project:
        raise HTTPException(400, 'Select a testcase or cycle, or move the whole project contents')
    # Keep the complete connected execution set together; never strand a case
    # in one project while an existing cycle using it remains in another.
    previous = None
    while previous != (case_ids, cycle_ids):
        previous = case_ids.copy(), cycle_ids.copy()
        for execution in source_executions:
            if execution.cycle_id in cycle_ids or execution.test_case_id in case_ids:
                case_ids.add(execution.test_case_id)
                cycle_ids.add(execution.cycle_id)
        for cycle in all_cycles:
            if cycle.id in cycle_ids and cycle.reexecution_of_cycle_id:
                cycle_ids.add(cycle.reexecution_of_cycle_id)
            if cycle.reexecution_of_cycle_id in cycle_ids:
                cycle_ids.add(cycle.id)
        restricted = {row.folder_id for row in all_cycles if row.id in cycle_ids
                      and row.folder and row.folder.access_grants}
        cycle_ids.update(row.id for row in all_cycles if row.folder_id in restricted)
    blockers, warnings = [], []
    if not case_ids <= {row.id for row in all_cases} or not cycle_ids <= {row.id for row in all_cycles}:
        blockers.append('A selected cycle or re-execution lineage contains work in another project; resolve that association first')
    if len(case_ids) > MAX_CONNECTED_CASES:
        blockers.append(f'The connected selection exceeds {MAX_CONNECTED_CASES} testcases; choose a smaller independent set')
    cases = [row for row in all_cases if row.id in case_ids]
    cycles = [row for row in all_cycles if row.id in cycle_ids]
    executions = [row for row in source_executions if row.cycle_id in cycle_ids]
    execution_ids = {row.id for row in executions}
    for row in _rows(db, m.TestExecution, within(m.TestExecution.test_case_id, case_ids)):
        if row.id not in execution_ids:
            blockers.append(f'{row.test_case.test_case_key} is also used by a cycle outside the move; its complete history must remain together')
    for child in _rows(db, m.TestCycle, within(m.TestCycle.reexecution_of_cycle_id, cycle_ids)):
        if child.id not in cycle_ids:
            blockers.append('A re-execution successor is outside this project; its lineage must remain together')
    folders = []
    if body.whole_project:
        folders = (_rows(db, m.TestFolder, m.TestFolder.project_id == source.id, lock=lock)
                   + _rows(db, m.TestCycleFolder, m.TestCycleFolder.project_id == source.id, lock=lock))
    else:
        folders = list({row.folder for row in cycles if row.folder and row.folder.access_grants})
        if any(row.folder_id for row in cases + cycles):
            warnings.append('Repository cases and unrestricted cycles become Unfiled in the destination. Original folder locations remain in history. Restricted cycle folders move with all their cycles and access rules.')
    roots = cases + cycles + folders
    for root in roots:
        if (root.origin_workspace_id or source.qa_workspace_id) != workspace:
            blockers.append('The selection contains content owned by another workspace; cross-workspace transfer is unavailable')
    from .testcase_moves import _fingerprint
    destination_cases = _rows(db, m.TestCase, m.TestCase.project_id == target.id)
    destination_fingerprints = {_fingerprint(row): row.test_case_key for row in destination_cases}
    for row in cases:
        duplicate = destination_fingerprints.get(_fingerprint(row))
        if duplicate:
            blockers.append(f'{row.test_case_key} matches destination testcase {duplicate}; resolve the duplicate before moving')
    graph = _migration_graph(db, [source.id, target.id])
    defects = []
    for defect in [row for row in graph if isinstance(row, m.Defect)]:
        traces = {link.execution_id for link in defect.execution_links} | {ref.execution_id for ref in defect.execution_references}
        traces.update(row.run.execution_id for row in graph if isinstance(row, m.TestRunDefect) and row.governed_defect_id == defect.id)
        if defect.execution_id:
            traces.add(defect.execution_id)
        trace_cases = {link.test_case_id for link in defect.test_case_links}
        if defect.primary_test_case_id:
            trace_cases.add(defect.primary_test_case_id)
        involved = bool(traces & execution_ids or trace_cases & case_ids or defect.cycle_id in cycle_ids)
        if not involved:
            continue
        defects.append(defect)
        if defect.qa_workspace_id != workspace:
            blockers.append(f'{defect.defect_key} belongs to another workspace')
        if not traces <= execution_ids or not trace_cases <= case_ids or (defect.cycle_id and defect.cycle_id not in cycle_ids):
            blockers.append(f'{defect.defect_key} is shared with work outside this move; include that work or correct the association first')
    links = [row for row in graph if isinstance(row, m.TestCycleChildRequestLink) and row.cycle_id in cycle_ids]
    requests = _rows(db, m.FunctionalRequest, within(m.FunctionalRequest.id, [row.child_id for row in links if row.child_type == 'Functional']), lock=lock)
    request_keys = {_request_key(row) for row in requests}
    target_app = (target.application_name or '').strip()
    source_app = (source.application_name or '').strip()
    if not target_app:
        blockers.append('The destination project must have an approved application')
    elif target.application_master.status != 'APPROVED':
        blockers.append('The destination application is not approved')
    changed_application = source_app.casefold() != target_app.casefold()
    if changed_application and not body.classification_correction:
        blockers.append('Confirm that this corrects project/application classification and the recorded testing was performed for the destination application')
    for req in requests:
        if req.qa_workspace_id != workspace or (req.application_name or '').strip().casefold() != target_app.casefold():
            blockers.append(f'{req.request_id} does not belong to the destination application/workspace; its request cannot be silently relabelled')
    for defect in defects:
        for parent in ([defect.qa_request] if defect.qa_request else []):
            request_keys.update(row.request_id for row in parent.linked_functional_requests)
            if parent.qa_workspace_id != workspace or (parent.application_name or '').strip().casefold() != target_app.casefold():
                blockers.append(f'{defect.defect_key} has an incompatible QA request {parent.request_id}')
        for association in [row for row in graph if isinstance(row, m.DefectFunctionalRequestLink) and row.defect_id == defect.id]:
            req = db.get(m.FunctionalRequest, association.functional_request_id)
            if req:
                request_keys.add(req.request_id)
            if req and (req.qa_workspace_id != workspace or (req.application_name or '').strip().casefold() != target_app.casefold()):
                blockers.append(f'{defect.defect_key} has an incompatible Functional Request {_request_key(req)}')
        if (defect.application_name or '').strip().casefold() not in {source_app.casefold(), target_app.casefold()}:
            blockers.append(f'{defect.defect_key} has a different application; review its classification first')
    blockers += _certificate_blockers(db, request_keys, cycle_ids, [row.id for row in defects])
    if not roots:
        blockers.append('No testcases, cycles or folders remain in the source selection')
    if changed_application:
        warnings.append('This corrects classification only. Existing attempts, closure, evidence and verification are retained. Testing performed against a different application needs new testing.')
    warnings.append('Moved records will be listed only under the destination project. Source audit entries retain their original context.')
    return {'kind': 'MIGRATION', 'source': {'id': source.id, 'key': source.project_key, 'name': source.name, 'application': source_app},
            'destination': {'id': target.id, 'key': target.project_key, 'name': target.name, 'application': target_app},
            'counts': {'testcases': len(cases), 'cycles': len(cycles), 'executions': len(executions),
                       'attempts': sum(len(row.runs) for row in executions), 'defects': len(defects), 'folders': len(folders)},
            'records': {'testcases': [row.test_case_key for row in cases], 'cycles': [row.cycle_key for row in cycles],
                        'defects': [row.defect_key for row in defects], 'requests': sorted(request_keys)},
            'warnings': warnings, 'blockers': sorted(set(blockers)),
            '_roots': roots, '_defects': defects, '_graph': graph, '_state_hash': _hash(graph)}


def _eligible_user(db, user_id, roles, workspace):
    user = db.get(m.User, user_id)
    with workflow_context(user) if user else _empty_scope():
        valid = bool(user and user.is_active and user.show_in_user_dropdowns
            and not (set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS})
            and user.has_qa_workspace_role(*roles, workspace_id=workspace, allow_admin=False))
    if not valid:
        raise HTTPException(400, 'Select active owners with the required working role in this workspace')
    return user


@contextmanager
def _empty_scope():
    yield


def request_context(db, kind, ident, user, *, lock=False):
    workspace = authorize(db, user)
    if kind not in REQUESTS:
        raise HTTPException(400, 'Select a supported child request type. Raised QA gateways retain their child workflows.')
    rows = _rows(db, REQUESTS[kind], REQUESTS[kind].id == ident, lock=lock)
    if not rows or rows[0].qa_workspace_id != workspace:
        raise HTTPException(404, 'Request not found in the selected workspace')
    return rows[0]


def _workflow_actions(db, kind, obj):
    status = obj.status or ''
    actions = []
    known = {'FUNCTIONAL': QA_REQUEST_STATUSES, 'SAST': SAST_DAST_STATUSES, 'DAST': SAST_DAST_STATUSES,
             'PERFORMANCE': PERFORMANCE_STATUSES, 'SUPPRESSION': SUPPRESSION_STATUSES}[kind]
    if status not in known:
        return actions
    protected = status in {'CLOSED', 'Closed', 'CANCELLED', 'Cancelled', 'DEPARTMENT_HEAD_REJECTED',
                           'QA_COMPLETED', 'QA_SIGNOFF_PENDING', 'QA_SIGNED_OFF', 'REQUESTER_VERIFICATION',
                           'QA_CHANGE_REVIEW', 'APPROVED', 'Approved', 'REJECTED', 'Rejected',
                           'Done', 'SECURITY_COMPLETE', 'REPORT_READY', 'SIGNOFF_PENDING', 'SIGNED_OFF'}
    if protected or _certificate_blockers(db, _request_certificate_keys(obj)):
        return actions
    if kind in {'SAST', 'DAST'}:
        from .security_scan_state import active_obstacles, OBSTACLE_STATES
        if active_obstacles(obj) or status in OBSTACLE_STATES:
            return actions
    preapproval = {'SUBMITTED', 'SM_APPROVAL_PENDING', 'DEPARTMENT_HEAD_APPROVAL_PENDING'}
    returned = status.startswith('RETURNED_BY_') or status in {'DRAFT', 'Draft', 'SM_REJECTED'}
    if status in preapproval or not returned:
        actions.append('RETURN_TO_REQUESTER')
    if status not in preapproval and not returned:
        if kind in {'SAST', 'DAST'}:
            from .security_obstacles import ACTIVE_STAGES
            if status in ACTIVE_STAGES:
                actions.append('INTERNAL_HOLD')
        else:
            actions.append('REVIEW_READINESS')
    if kind == 'FUNCTIONAL' and (status in {'QA_LEAD_ASSIGNED', 'READINESS_VERIFICATION'} or status in {
            'PLANNING', 'TESTER_ASSIGNED', 'TEST_DESIGN', 'EXECUTION_IN_PROGRESS', 'DEFECT_RAISED', 'WAITING_FOR_FIX', 'RETESTING', 'QA_ACTIVITY_INITIATED'}):
        actions.append('REASSIGN_OWNER')
    if kind in {'SAST', 'DAST', 'PERFORMANCE'} and not protected and status not in preapproval and not returned:
        actions.append('REASSIGN_OWNER')
    return actions


def owner_field(kind, status):
    if kind == 'FUNCTIONAL':
        return ('qa_lead_id', LEADS) if status in {'QA_LEAD_ASSIGNED', 'READINESS_VERIFICATION', 'QA_ACTIVITY_INITIATED', 'PLANNING'} else ('assigned_tester_ids', (Role.QA_ENGINEER,))
    if kind in {'SAST', 'DAST'}:
        return ('security_lead_id', LEADS) if status in {'SECURITY_READINESS', 'SECURITY_LEAD_ASSIGNED', 'PLANNING'} else ('security_analyst_id', (Role.SECURITY_ANALYST,))
    return ('engineer_id', LEADS) if status in {'READINESS', 'ENGINEER_ASSIGNED', 'FEASIBILITY', 'PLANNING'} else ('assigned_tester_ids', (Role.QA_ENGINEER,))


def workflow_plan(db, body, user, *, lock=False):
    obj = request_context(db, body.request_type, body.request_id, user, lock=lock)
    kind, status = body.request_type, obj.status
    actions = _workflow_actions(db, kind, obj)
    blockers, warnings = [], ['Existing evidence, approvals and execution history remain recorded. Completion and certificate gates continue to apply.']
    if body.action not in actions:
        blockers.append('This recovery action is unavailable at the current stage; use the request or QA Clearance workflow')
    if getattr(obj, 'active_delegation', None):
        blockers.append('Return or recall the active delegation before recovering this request')
    owner_ids = list(dict.fromkeys(body.owner_ids))
    destination = status
    changes = {}
    from .security_obstacles import ACTIVE_STAGES
    obstacle = kind in {'SAST', 'DAST'} and status in ACTIVE_STAGES and body.action in {'RETURN_TO_REQUESTER', 'INTERNAL_HOLD'}
    if body.action == 'REASSIGN_OWNER':
        field, roles = owner_field(kind, status)
        if not owner_ids or (field != 'assigned_tester_ids' and len(owner_ids) != 1):
            blockers.append('Select the required responsible owner(s)')
        else:
            for ident in owner_ids:
                _eligible_user(db, ident, roles, obj.qa_workspace_id)
            value = ','.join(map(str, owner_ids)) if field == 'assigned_tester_ids' else owner_ids[0]
            changes[field] = value
            if value == getattr(obj, field):
                blockers.append('The selected owners already have this responsibility')
        warnings.append('Existing cycle runners and analyst/resolver responsibilities at other stages are preserved.')
    elif body.action in {'RETURN_TO_REQUESTER', 'INTERNAL_HOLD'}:
        if not body.requested_correction:
            blockers.append('Describe the correction or action required from the responsible owner')
        requester_id = getattr(obj, 'requester_id', None) or getattr(obj, 'created_by_id', None)
        requester = db.get(m.User, requester_id) if requester_id else None
        if body.action == 'RETURN_TO_REQUESTER' and (not requester or not requester.is_active):
            blockers.append('The requester account is unavailable; restore account access before returning the request')
        if obstacle:
            from .security_scan_state import active_obstacles
            if active_obstacles(obj):
                blockers.append('An active security obstacle already exists; use its routing/review actions')
            destination = 'REQUESTER_ACTION_REQUIRED' if body.action == 'RETURN_TO_REQUESTER' else 'INTERNAL_HOLD'
            if body.action == 'INTERNAL_HOLD':
                if len(owner_ids) != 1:
                    blockers.append('Select one internal hold owner')
                else:
                    _eligible_user(db, owner_ids[0], (Role.SECURITY_ANALYST, *LEADS), obj.qa_workspace_id)
            warnings.append('The existing scoped obstacle flow preserves analyst ownership and requires fresh QA review before resuming.')
        elif body.action == 'RETURN_TO_REQUESTER':
            if status in {'SUBMITTED', 'SM_APPROVAL_PENDING'}:
                destination = 'RETURNED_BY_SM'
            elif status == 'DEPARTMENT_HEAD_APPROVAL_PENDING':
                destination = 'RETURNED_BY_DEPARTMENT_HEAD'
            else:
                destination = {'FUNCTIONAL': 'RETURNED_BY_QA_LEAD', 'SAST': 'RETURNED_BY_SECURITY_LEAD',
                               'DAST': 'RETURNED_BY_SECURITY_LEAD', 'PERFORMANCE': 'RETURNED_BY_ENGINEER',
                               'SUPPRESSION': 'RETURNED_BY_SECURITY_TEAM'}[kind]
                changes['needs_dept_head_reapproval'] = body.require_dept_head_reapproval
            changes['status'] = destination
    elif body.action == 'REVIEW_READINESS':
        destination = {'FUNCTIONAL': 'READINESS_VERIFICATION', 'PERFORMANCE': 'READINESS',
                       'SUPPRESSION': 'SECURITY_TEAM_VERIFICATION'}.get(kind, status)
        changes['status'] = destination
        if destination == status:
            blockers.append('The request is already at this review stage')
        warnings.append('A fresh review is required; previously recorded work is retained and no approval is manufactured.')
    graph = _request_rows(db, obj)
    if kind == 'FUNCTIONAL':
        linked_ids = [link.cycle_id for link in obj.test_cycle_links]
        graph += list(obj.test_cycle_links)
        graph += _rows(db, m.TestCycle, within(m.TestCycle.id, linked_ids))
        executions = _rows(db, m.TestExecution, within(m.TestExecution.cycle_id, linked_ids))
        runs = _rows(db, m.TestExecutionRun, within(m.TestExecutionRun.execution_id, [row.id for row in executions]))
        graph += executions + runs
        graph += _rows(db, m.TestRetest, within(m.TestRetest.run_id, [row.id for row in runs]))
        graph += _rows(db, m.TestRetestOutcome, within(m.TestRetestOutcome.run_id, [row.id for row in runs]))
    return {'kind': 'WORKFLOW', 'request_type': kind, 'request_id': obj.id, 'request_key': _request_key(obj),
            'application': obj.application_name, 'from_status': status, 'to_status': destination,
            'action': body.action, 'owner_ids': owner_ids, 'changes': changes,
            'warnings': warnings, 'blockers': sorted(set(blockers)), '_object': obj,
            '_obstacle': obstacle, '_graph': graph, '_state_hash': _hash(graph)}


def public_plan(plan):
    return {key: value for key, value in plan.items() if not key.startswith('_')}


def serialize(job):
    return {'id': job.id, 'recovery_key': job.recovery_key, 'kind': job.kind, 'status': job.status,
            'reason': job.reason, 'actor_name': job.actor.full_name if job.actor else f'User #{job.actor_id}',
            'created_at': str(job.created_at), 'applied_at': str(job.applied_at) if job.applied_at else None,
            'reversed_at': str(job.reversed_at) if job.reversed_at else None,
            'preview': json.loads(job.preview_json), 'changes': json.loads(job.changes_json or '[]'),
            'can_reverse': job.kind == 'MIGRATION' and job.status == 'APPLIED'}


def preview(db, body, user):
    workspace = authorize(db, user)
    plan = migration_plan(db, body, user) if body.kind == 'MIGRATION' else workflow_plan(db, body, user)
    job = m.AdminRecoveryJob(recovery_key='REC-' + uuid4().hex, qa_workspace_id=workspace,
        actor_id=user.id, kind=body.kind, status='BLOCKED' if plan['blockers'] else 'PREVIEWED', reason=body.reason,
        payload_json=dumps(body.model_dump()), preview_json=dumps(public_plan(plan)), state_hash=plan['_state_hash'])
    db.add(job)
    db.commit()
    db.refresh(job)
    return serialize(job)


@contextmanager
def _write_scope(db, plan, user):
    roots = plan.get('_roots', [])
    source, target = plan.get('source', {}).get('id'), plan.get('destination', {}).get('id')
    records = plan.get('_defects', []) + ([plan['_object']] if '_object' in plan else [])
    audits = {(_entity_type(row), row.id) for row in roots + records}
    if source and target:
        audits |= {('TEST_PROJECT', source), ('TEST_PROJECT', target)}
    keys = ('validated_admin_recovery_roots', 'validated_admin_recovery_records', 'validated_admin_recovery_audits')
    previous = {key: db.info.get(key) for key in keys}
    db.info[keys[0]] = {(row.__tablename__, row.id): (source, target, user.active_qa_workspace_id) for row in roots}
    db.info[keys[1]] = {(type(row).__name__, row.id) for row in records}
    db.info[keys[2]] = audits
    try:
        yield
    finally:
        for key in keys:
            if previous[key] is None:
                db.info.pop(key, None)
            else:
                db.info[key] = previous[key]


def _entity_type(obj):
    return {m.TestProject: 'TEST_PROJECT', m.TestCase: 'TEST_CASE', m.TestCycle: 'TEST_CYCLE', m.TestFolder: 'TEST_FOLDER',
            m.TestCycleFolder: 'TEST_CYCLE_FOLDER', m.Defect: 'DEFECT',
            **{cls: ENTITY_TYPES[kind] for kind, cls in REQUESTS.items()}}[type(obj)]


def _audit(db, job, obj, user, previous, new, reason=None, decision='Recovered by Admin'):
    db.add(m.ApprovalAction(entity_type=_entity_type(obj), entity_id=obj.id,
        step_name='Admin Recovery', actor_id=user.id, actor_role=user.roles_csv,
        decision=decision, previous_state=previous, new_state=new,
        comments=f'{job.recovery_key}: {reason or job.reason}. '
                 'Original evidence, history and approval actors are preserved.'))


def _change(obj, values):
    return {'table': obj.__tablename__, 'id': obj.id,
            'record': getattr(obj, 'test_case_key', None) or getattr(obj, 'cycle_key', None)
                      or getattr(obj, 'defect_key', None) or getattr(obj, 'request_id', None)
                      or getattr(obj, 'name', None) or f'#{obj.id}',
            'before': {key: getattr(obj, key) for key in values}, 'after': values}


def _lock_graph(db, graph):
    # Match request -> cycle -> execution ordering used by clearance/retest.
    # NOWAIT makes active editing a retryable conflict, never a long hold.
    order = {m.QARequest: 0, m.FunctionalRequest: 1, m.SASTRequest: 1, m.DASTRequest: 1,
             m.PerformanceRequest: 1, m.SuppressionRequest: 1, m.QASignOff: 2,
             m.TestProject: 3, m.TestCycle: 4, m.TestExecution: 5, m.TestCase: 6, m.Defect: 7}
    for cls in sorted({type(row) for row in graph}, key=lambda value: (order.get(value, 10), value.__tablename__)):
        rows = [row for row in graph if type(row) is cls]
        primary = list(cls.__table__.primary_key.columns)
        if len(primary) == 1:
            _rows(db, cls, within(primary[0], [getattr(row, primary[0].key) for row in rows]), lock=True)
        else:
            for row in rows:
                _rows(db, cls, (primary[0] == getattr(row, primary[0].key)) & (primary[1] == getattr(row, primary[1].key)), lock=True)


def _conflict_boundary(function):
    @wraps(function)
    def wrapped(db, *args, **kwargs):
        try:
            return function(db, *args, **kwargs)
        except DBAPIError as exc:
            db.rollback()
            raise HTTPException(409, 'The recovery record set is busy or changed. Nothing was changed; refresh the preview and retry when editing is finished.') from exc
    return wrapped


@_conflict_boundary
def apply(db, recovery_key, user):
    workspace = authorize(db, user)
    job = db.query(m.AdminRecoveryJob).filter_by(recovery_key=recovery_key, qa_workspace_id=workspace).populate_existing().with_for_update(nowait=True).one_or_none()
    if not job:
        raise HTTPException(404, 'Recovery plan not found in this workspace')
    if job.status == 'APPLIED':
        return serialize(job)  # Lost response/retry cannot apply twice.
    if job.status != 'PREVIEWED':
        raise HTTPException(409, 'Create a new eligible recovery preview')
    if job.actor_id != user.id:
        raise HTTPException(403, 'Apply your own reviewed recovery preview')
    if m.as_aware(job.created_at) + PREVIEW_LIFETIME < m.as_aware(m.now()):
        raise HTTPException(409, 'This recovery preview expired; review a fresh preview')
    body = schemas.AdminRecoveryPreviewIn.model_validate(json.loads(job.payload_json))
    try:
        with db.no_autoflush:
            plan = migration_plan(db, body, user) if body.kind == 'MIGRATION' else workflow_plan(db, body, user)
        # Lock every discovered evidence row, then reload and fingerprint it.
        _lock_graph(db, plan['_graph'])
        db.expire_all()
        with db.no_autoflush:
            plan = migration_plan(db, body, user) if body.kind == 'MIGRATION' else workflow_plan(db, body, user)
        if plan['_state_hash'] != job.state_hash or plan['blockers']:
            raise HTTPException(409, 'The affected work changed or is no longer eligible. Nothing was moved or recovered; review a fresh preview.')
        changes = []
        with _write_scope(db, plan, user):
            if body.kind == 'MIGRATION':
                for obj in plan['_roots']:
                    values = {'project_id': body.target_project_id}
                    if not body.whole_project and isinstance(obj, (m.TestCase, m.TestCycle)):
                        moved_cycle_folders = {row.id for row in plan['_roots'] if isinstance(row, m.TestCycleFolder)}
                        if not isinstance(obj, m.TestCycle) or obj.folder_id not in moved_cycle_folders:
                            values['folder_id'] = None
                    changes.append(_change(obj, values))
                    for key, value in values.items():
                        setattr(obj, key, value)
                    _audit(db, job, obj, user, plan['source']['key'], plan['destination']['key'])
                for defect in plan['_defects']:
                    app = plan['destination']['application']
                    if defect.application_name != app:
                        changes.append(_change(defect, {'application_name': app}))
                        defect.application_name = app
                    _audit(db, job, defect, user, plan['source']['key'], plan['destination']['key'])
                for ident in (body.source_project_id, body.target_project_id):
                    _audit(db, job, db.get(m.TestProject, ident), user, plan['source']['key'], plan['destination']['key'])
            else:
                obj = plan['_object']
                if plan['_obstacle']:
                    from .security_obstacles import create_obstacle
                    payload = schemas.SecurityObstacleCreate(kind='INTERNAL' if body.action == 'INTERNAL_HOLD' else 'REQUESTER',
                        category='Administrative recovery', reason=body.reason, requested_correction=body.requested_correction,
                        owner_id=body.owner_ids[0] if body.action == 'INTERNAL_HOLD' else None,
                        require_dept_head_reapproval=body.require_dept_head_reapproval)
                    create_obstacle(db, type(obj), obj.id, payload, user, commit=False)
                    changes.append({'table': obj.__tablename__, 'id': obj.id, 'record': _request_key(obj),
                                    'before': {'status': plan['from_status']}, 'after': {'status': obj.status}})
                else:
                    change = _change(obj, plan['changes'])
                    changes.append(change)
                    for key, value in plan['changes'].items():
                        setattr(obj, key, value)
                    if body.action == 'REASSIGN_OWNER':
                        from .reassignment import record_assignment_change
                        field = next(iter(plan['changes']))
                        previous_value = change['before'][field]
                        previous_ids = ([int(value) for value in (previous_value or '').split(',') if value.strip()]
                                        if field == 'assigned_tester_ids' else [previous_value])
                        assignment_role = {'assigned_tester_ids': 'QA_TESTER', 'security_analyst_id': 'SECURITY_ANALYST',
                                           'qa_lead_id': 'QA_LEAD', 'security_lead_id': 'SECURITY_LEAD', 'engineer_id': 'QA_LEAD'}[field]
                        record_assignment_change(db, ENTITY_TYPES[body.request_type], obj.id, assignment_role,
                            user, previous_ids, body.owner_ids, f'{job.recovery_key}: {job.reason}')
                    if body.action == 'REVIEW_READINESS' or (body.action == 'RETURN_TO_REQUESTER' and obj.status in {
                            'RETURNED_BY_QA_LEAD', 'RETURNED_BY_SECURITY_LEAD', 'RETURNED_BY_ENGINEER'}):
                        for item in getattr(obj, 'checklist_items', []):
                            if hasattr(item, 'is_complete'):
                                values = {'is_complete': False, 'approved_by_id': None, 'approved_at': None}
                                changes.append(_change(item, values))
                                for key, value in values.items():
                                    setattr(item, key, value)
                _audit(db, job, obj, user, plan['from_status'], obj.status,
                       reason=job.reason + (f' Owner correction: {change["before"]} -> {change["after"]}.' if body.action == 'REASSIGN_OWNER' else '')
                       + (f' Required correction: {body.requested_correction}' if body.requested_correction else ''))
            db.flush()
            # IDs and nested attempt/evidence relationships never change.
            if body.kind == 'MIGRATION':
                for obj in plan['_roots']:
                    if obj.project_id != body.target_project_id:
                        raise HTTPException(409, 'Destination validation failed; the whole move was rolled back')
                job.after_hash = _hash(_migration_graph(db, [body.source_project_id, body.target_project_id]))
            job.changes_json = dumps(changes)
            job.status, job.applied_at = 'APPLIED', m.now()
            db.add(m.AuditLog(event_type='RECOVERY', action='ADMIN_RECOVERY_APPLIED', outcome='SUCCESS',
                actor_id=user.id, actor_username=user.username, actor_name=user.full_name,
                target_type='ADMIN_RECOVERY', target_id=job.recovery_key, target_name=job.kind,
                details=dumps({'workspace_id': workspace, 'record_changes': len(changes), 'reason': job.reason})))
            db.commit()
        db.refresh(job)
        return serialize(job)
    except DBAPIError as exc:
        db.rollback()
        raise HTTPException(409, 'Recovery could not obtain an unchanged, available record set. Nothing was changed; refresh the preview and retry when editing is finished.') from exc
    except Exception:
        db.rollback()
        raise


@_conflict_boundary
def reverse(db, recovery_key, reason, user):
    workspace = authorize(db, user)
    job = db.query(m.AdminRecoveryJob).filter_by(recovery_key=recovery_key, qa_workspace_id=workspace).populate_existing().with_for_update(nowait=True).one_or_none()
    if not job or job.kind != 'MIGRATION':
        raise HTTPException(404, 'Project migration not found in this workspace')
    if job.status == 'REVERSED':
        return serialize(job)
    if job.status != 'APPLIED':
        raise HTTPException(409, 'Only an applied migration can be reversed')
    body = schemas.AdminRecoveryPreviewIn.model_validate(json.loads(job.payload_json))
    _rows(db, m.TestProject, within(m.TestProject.id, [body.source_project_id, body.target_project_id]), lock=True)
    graph = _migration_graph(db, [body.source_project_id, body.target_project_id])
    _lock_graph(db, graph)
    db.expire_all()
    graph = _migration_graph(db, [body.source_project_id, body.target_project_id])
    if _hash(graph) != job.after_hash:
        raise HTTPException(409, 'Work changed after this move. Reversal is unsafe; create a new reviewed migration instead.')
    changes = json.loads(job.changes_json)
    by_table = {cls.__tablename__: cls for cls in (m.TestCase, m.TestCycle, m.TestFolder, m.TestCycleFolder, m.Defect)}
    roots, defects = [], []
    for change in changes:
        obj = db.query(by_table[change['table']]).filter_by(id=change['id']).populate_existing().with_for_update(nowait=True).one()
        (defects if isinstance(obj, m.Defect) else roots).append(obj)
        if any(getattr(obj, key) != value for key, value in change['after'].items()):
            raise HTTPException(409, 'A moved record changed; reversal requires a new reviewed migration')
    plan = {'source': {'id': body.target_project_id}, 'destination': {'id': body.source_project_id},
            '_roots': roots, '_defects': defects}
    try:
        with _write_scope(db, plan, user):
            for change in changes:
                obj = db.get(by_table[change['table']], change['id'])
                for key, value in change['before'].items():
                    setattr(obj, key, value)
                _audit(db, job, obj, user, str(body.target_project_id), str(body.source_project_id), reason,
                       decision='Admin migration reversed')
            for ident in (body.source_project_id, body.target_project_id):
                _audit(db, job, db.get(m.TestProject, ident), user, str(body.target_project_id), str(body.source_project_id), reason,
                       decision='Admin migration reversed')
            job.status, job.reversed_at = 'REVERSED', m.now()
            db.commit()
        return serialize(job)
    except Exception:
        db.rollback()
        raise
