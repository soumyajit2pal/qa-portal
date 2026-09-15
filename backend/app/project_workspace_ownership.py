"""Workspace ownership for collaborative project content (independent of user roles)."""
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
    from .workflow_authority import admin_department_allowed
    if isinstance(user, models.User) and not admin_department_allowed(user, project.department):
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
    workspace_id = getattr(user, 'active_qa_workspace_id', None)
    project = db.get(models.TestProject, root.project_id)
    owner = root.origin_workspace_id or (project.qa_workspace_id if project else None)
    if workspace_id is None or owner != workspace_id or not workspace_can_contribute(db, root.project_id, user):
        raise HTTPException(403, 'This record belongs to another workspace and is read-only. Create a test case or cycle in your own workspace.')


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
                        raise HTTPException(403, 'Content cannot be moved between ownership containers')
            assert_owned(db, root, user)


def guard_request(db, user, request):
    """Reject foreign-record writes before file uploads or other side effects."""
    from . import models as m
    if request.method.upper() in ('GET', 'HEAD', 'OPTIONS'):
        return
    path = request.url.path
    if path.startswith('/api/approvals/'):
        model = {'TEST_CASE': m.TestCase, 'TEST_CYCLE': m.TestCycle, 'TEST_EXECUTION': m.TestExecution}.get(str(request.path_params.get('entity_type', '')).upper())
        entity_id = request.path_params.get('entity_id')
        if model and entity_id:
            obj = db.get(model, int(entity_id))
            root = root_for(db, obj) if obj is not None else None
            if root is not None:
                assert_owned(db, root, user)
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
