"""Workspace ownership for collaborative project content (independent of user roles)."""
from contextlib import contextmanager
from fastapi import HTTPException
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session


def bind_actor(db, user):
    db.info['project_workspace_actor'] = user


def workspace_can_contribute(db, project_id, user):
    from . import models
    workspace_id = getattr(user, 'active_qa_workspace_id', None)
    if getattr(user, 'is_active', True) is False or 'VIEW_ONLY' in getattr(user, 'roles', []):
        return False
    if isinstance(user, models.User):
        if not user.has_role('ADMIN', 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA'):
            return False
        from .workspace_service import inherited_workspace_access_mode, selectable_workspace_ids
        if workspace_id not in selectable_workspace_ids(db, user):
            return False
        if inherited_workspace_access_mode(db, user, workspace_id) == 'PARENT_VIEWER':
            return False
    if workspace_id is None:
        return False
    project = db.get(models.TestProject, project_id)
    if not project:
        return False
    if isinstance(user, models.User):
        # Keep this import inside the already-loaded real-user branch. Test
        # and migration workers sometimes bind a lightweight actor; importing
        # workflow_authority for the first time from inside SQLAlchemy's
        # before_flush iteration registers another before_flush listener and
        # mutates the listener deque mid-iteration.
        from .workflow_authority import admin_department_allowed
        if not admin_department_allowed(user, project.department):
            return False
    if project.qa_workspace_id == workspace_id:
        return True
    return db.query(models.TestProjectViewGrant.id).filter_by(
        project_id=project_id, workspace_id=workspace_id).first() is not None


def roots():
    from . import models as m
    return (m.TestCase, m.TestCycle, m.TestFolder, m.TestCycleFolder)


def root_for(db, obj):
    from . import models as m
    if isinstance(obj, roots()):
        return obj
    links = {
        m.TestCaseVersion: ('test_case', 'test_case_id', m.TestCase),
        m.TestCaseTag: ('test_case', 'test_case_id', m.TestCase),
        m.TestStep: ('test_case', 'test_case_id', m.TestCase),
        m.TestCaseVersionStep: ('version', 'version_id', m.TestCaseVersion),
        m.TestExecution: ('cycle', 'cycle_id', m.TestCycle),
        m.TestExecutionRun: ('execution', 'execution_id', m.TestExecution),
        m.TestRunDefect: ('run', 'run_id', m.TestExecutionRun),
        m.DefectExecutionReference: ('execution', 'execution_id', m.TestExecution),
        m.TestCycleChildRequestLink: ('cycle', 'cycle_id', m.TestCycle),
        m.TestCycleFolderAccess: ('folder', 'folder_id', m.TestCycleFolder),
    }
    link = links.get(type(obj))
    if link:
        relationship, key, model = link
        parent = getattr(obj, relationship, None)
        if parent is None and getattr(obj, key, None) is not None:
            parent = db.get(model, getattr(obj, key))
        return root_for(db, parent) if parent is not None else None
    if isinstance(obj, m.RequestDocument):
        targets = {'TEST_EXEC_IMAGE': m.TestExecutionRun, 'TEST_CASE_IMAGE': m.TestCase,
                   'TEST_CYCLE': m.TestCycle}
        model = targets.get(obj.module)
        if model and obj.request_id:
            return root_for(db, db.get(model, obj.request_id))
    return None


def assert_owned(db, root, user):
    from . import models
    if admin_recovery_root_allowed(db, root, user):
        return
    workspace_id = getattr(user, 'active_qa_workspace_id', None)
    project = db.get(models.TestProject, root.project_id)
    owner = root.origin_workspace_id or (project.qa_workspace_id if project else None)
    if workspace_id is None or owner != workspace_id or not workspace_can_contribute(db, root.project_id, user):
        raise HTTPException(403, 'This record belongs to another workspace and is read-only. Create a test case or cycle in your own workspace.')


def admin_recovery_root_allowed(db, root, user):
    """A transaction-local exception for precisely reviewed root relocations."""
    from .workflow_authority import is_system_admin
    allowed = db.info.get('validated_admin_recovery_roots', {}).get((root.__tablename__, root.id))
    return bool(allowed and is_system_admin(user)
                and root.project_id == allowed[1]
                and getattr(user, 'active_qa_workspace_id', None) == allowed[2]
                and (root.origin_workspace_id or allowed[2]) == allowed[2])


def assert_project_owned(db, project, user):
    """Protect project metadata; sharing grants content collaboration only."""
    from . import models
    # System Administrators may govern project metadata, owner and sharing
    # from the Admin section across workspace boundaries. This exception is
    # intentionally limited to the TestProject record; testcase/cycle roots
    # still pass through assert_owned and retain permanent workspace ownership.
    if isinstance(user, models.User) and user.has_role('ADMIN'):
        return
    workspace_id = getattr(user, 'active_qa_workspace_id', None)
    if (
        workspace_id is None
        or project.qa_workspace_id != workspace_id
        or not workspace_can_contribute(db, project.id, user)
    ):
        raise HTTPException(403, 'This project belongs to another workspace and is read-only.')


@contextmanager
def validated_case_project_moves(db, cases, source_project, target_project, folder_id, user):
    """Allow only the exact case relocations validated by the move operation.

    The exception expires after its explicit flush. All other container and
    permanent workspace ownership changes still use the normal guard.
    """
    from . import models
    workspace_id = getattr(user, 'active_qa_workspace_id', None)
    if (source_project.qa_workspace_id != workspace_id
            or target_project.qa_workspace_id != workspace_id
            or source_project.id == target_project.id):
        raise HTTPException(403, 'Test cases can only move between projects in the current workspace')
    for case in cases:
        assert_owned(db, case, user)
    if not workspace_can_contribute(db, target_project.id, user):
        raise HTTPException(403, 'The destination project is read-only')
    previous = db.info.get('validated_case_project_moves')
    db.info['validated_case_project_moves'] = {
        case.id: (source_project.id, target_project.id, folder_id) for case in cases
        if isinstance(case, models.TestCase)
    }
    try:
        yield
    finally:
        if previous is None:
            db.info.pop('validated_case_project_moves', None)
        else:
            db.info['validated_case_project_moves'] = previous


@event.listens_for(Session, 'before_flush')
def enforce_workspace_ownership(db, flush_context, instances):
    user = db.info.get('project_workspace_actor')
    if user is None:
        return
    with db.no_autoflush:
        for obj in list(db.new):
            if isinstance(obj, roots()):
                if not workspace_can_contribute(db, obj.project_id, user):
                    raise HTTPException(403, 'Your workspace does not have project collaboration access')
                obj.origin_workspace_id = getattr(user, 'active_qa_workspace_id', None)
        for obj in set(db.new) | set(db.dirty) | set(db.deleted):
            if obj in db.dirty and not db.is_modified(obj, include_collections=False):
                continue
            root = root_for(db, obj)
            if root is None:
                continue
            # Creation ownership is permanent, including after account/workspace changes.
            state = inspect(root)
            if root not in db.new and state.attrs.origin_workspace_id.history.has_changes():
                raise HTTPException(403, 'The creating workspace cannot be changed')
            # Check the persisted container too, so moving foreign content cannot transfer ownership.
            for key in ('project_id', 'test_case_id', 'version_id', 'cycle_id', 'execution_id', 'run_id', 'folder_id'):
                if key in inspect(obj).attrs and obj not in db.new and inspect(obj).attrs[key].history.has_changes():
                    old = inspect(obj).attrs[key].history.deleted
                    if old and key not in ('folder_id',):
                        from .models import TestCase
                        allowed = db.info.get('validated_case_project_moves', {}).get(getattr(obj, 'id', None))
                        if (key == 'project_id' and isinstance(obj, TestCase) and allowed
                                and (old[0], obj.project_id, obj.folder_id) == allowed):
                            continue
                        recovery = db.info.get('validated_admin_recovery_roots', {}).get((obj.__tablename__, obj.id))
                        if (key == 'project_id' and recovery and old[0] == recovery[0]
                                and admin_recovery_root_allowed(db, obj, user)):
                            continue
                        raise HTTPException(403, 'Content cannot be moved between ownership containers')
            assert_owned(db, root, user)
        # Serialize a newly added cycle slot against an administrative case
        # relocation. A concurrent move cannot leave this slot pointing at a
        # testcase that now belongs to a different project.
        from . import models as m
        for slot in [row for row in db.new if isinstance(row, m.TestExecution)]:
            cycle = slot.cycle or db.get(m.TestCycle, slot.cycle_id)
            case = slot.test_case or db.get(m.TestCase, slot.test_case_id)
            case_id = slot.test_case_id or (case.id if case else None)
            project_id = case.project_id if case else None
            if case_id is not None and case not in db.new:
                persisted = db.query(m.TestCase.project_id).filter(m.TestCase.id == case_id).with_for_update().one_or_none()
                project_id = persisted[0] if persisted else None
            if not cycle or project_id != cycle.project_id:
                raise HTTPException(409, 'The testcase project changed. Refresh the cycle selection before adding it; nothing was added.')


def guard_request(db, user, request):
    """Reject foreign-record writes before file uploads or other side effects."""
    from . import models as m
    if request.method.upper() in ('GET', 'HEAD', 'OPTIONS'):
        return
    path = request.url.path
    if path.startswith('/api/approvals/'):
        entity_type = str(request.path_params.get('entity_type', '')).upper()
        model = {'TEST_PROJECT': m.TestProject, 'TEST_CASE': m.TestCase, 'TEST_CYCLE': m.TestCycle, 'TEST_EXECUTION': m.TestExecution}.get(entity_type)
        entity_id = request.path_params.get('entity_id')
        if model and entity_id:
            obj = db.get(model, int(entity_id))
            if isinstance(obj, m.TestProject):
                assert_project_owned(db, obj, user)
            else:
                root = root_for(db, obj) if obj is not None else None
                if root is not None:
                    assert_owned(db, root, user)
        return
    if path.startswith('/api/test-projects/'):
        project_id = request.path_params.get('project_id')
        if project_id is not None:
            project = db.get(m.TestProject, int(project_id))
            if project is not None:
                assert_project_owned(db, project, user)
        return
    if not path.startswith(('/api/test-repository/', '/api/test-execution/')):
        return
    if path.endswith(('/clone', '/export-xlsx/jobs')):
        return  # Cloning reads the source and creates independently owned content.
    targets = {'case_id': m.TestCase, 'cycle_id': m.TestCycle, 'execution_id': m.TestExecution,
               'version_id': m.TestCaseVersion, 'run_id': m.TestExecutionRun,
               'folder_id': m.TestCycleFolder if '/cycle-folders/' in path else m.TestFolder}
    for key, model in targets.items():
        value = request.path_params.get(key)
        if value is not None:
            obj = db.get(model, int(value))
            root = root_for(db, obj) if obj is not None else None
            if root is not None:
                assert_owned(db, root, user)
