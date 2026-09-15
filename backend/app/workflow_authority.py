"""Separate system administration from operational workflow authority.

The request resolver activates this policy only for workflow APIs. The user's
stored assignments are never changed; admin APIs continue to see ADMIN.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

from fastapi import HTTPException
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

WORKFLOW_ROLES = {
    'REQUESTER', 'DEVELOPER', 'BUSINESS_ANALYST', 'APPLICATION_OWNER', 'SM',
    'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM', 'QA_ENGINEER', 'QA_LEAD',
    'CHIEF_MANAGER_QA', 'AGM_QA', 'SECURITY_ANALYST',
}


def is_system_admin(user):
    return any(row.role == 'ADMIN' for row in user.role_assignments)


_workflow_actors = ContextVar("workflow_actors", default=())


def workflow_active(user):
    return any(actor is user for actor in _workflow_actors.get())


@contextmanager
def workflow_context(user, *, enabled=True):
    """Effective authority belongs to the request/task, never the ORM identity."""
    token = _workflow_actors.set((user,) if enabled else ())
    try:
        yield
    finally:
        _workflow_actors.reset(token)


def workflow_endpoint(fn):
    """Also applies to direct service calls used by tests and diagnostics."""
    @wraps(fn)
    def wrapped(*args, **kwargs):
        user = kwargs.get('current_user') or inspect_signature.bind(*args, **kwargs).arguments['current_user']
        with workflow_context(user):
            return fn(*args, **kwargs)
    from inspect import signature
    inspect_signature = signature(fn)
    return wrapped


def admin_department_allowed(user, department):
    return not is_system_admin(user) or bool(department and user.has_department(department))


def require_admin_department(user, department):
    if not admin_department_allowed(user, department):
        raise HTTPException(403, 'Administrators may perform workflow actions only within their own department, using an assigned workflow role.')


def configure_request(db, user, request, *, workflow=False):
    _workflow_actors.set((user,) if workflow else ())
    if not workflow or request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
        return
    if is_system_admin(user) and not set(user.roles) & WORKFLOW_ROLES:
        raise HTTPException(403, 'Administrator access does not grant workflow authority. An explicit workflow role is required.')
    db.info['workflow_actor'] = user
    if is_system_admin(user):
        require_request_department(db, user, request)


def require_request_department(db, user, request):
    """Reject direct-record actions before uploads or other side effects.

    New records and mixed bulk payloads are additionally checked at flush.
    """
    from . import models as m
    parts = request.url.path.strip('/').split('/')
    models_by_segment = {
        'qa-requests': m.QARequest, 'functional-requests': m.FunctionalRequest,
        'sast-requests': m.SASTRequest, 'dast-requests': m.DASTRequest,
        'performance-requests': m.PerformanceRequest, 'suppressions': m.SuppressionRequest,
        'signoffs': m.QASignOff, 'defects': m.Defect, 'application-names': m.ApplicationMaster,
        'test-projects': m.TestProject, 'projects': m.TestProject,
        'test-cases': m.TestCase, 'versions': m.TestCaseVersion,
        'cycles': m.TestCycle, 'executions': m.TestExecution, 'runs': m.TestExecutionRun,
        'folders': m.TestFolder, 'cycle-folders': m.TestCycleFolder,
    }
    with db.no_autoflush:
        for segment, identifier in zip(parts, parts[1:]):
            model = models_by_segment.get(segment)
            if model is None or not identifier.isdigit():
                continue
            obj = db.get(model, int(identifier))
            if obj is not None:
                applicable, department = record_department(db, obj, user)
                if applicable:
                    require_admin_department(user, department)
        if parts[:2] == ['api', 'approvals']:
            from .deps import resolve_entity_department
            params = request.path_params
            if params.get('entity_type') and params.get('entity_id'):
                if params['entity_type'] == 'DEFECT':
                    obj = db.get(m.Defect, int(params['entity_id']))
                    applicable, department = record_department(db, obj, user)
                    require_admin_department(user, department if applicable else None)
                else:
                    require_admin_department(user, resolve_entity_department(
                        db, params['entity_type'], int(params['entity_id'])))



def record_department(db, obj, user=None):
    from . import models as m
    from .project_workspace_ownership import root_for
    if isinstance(obj, m.Defect) and user is not None:
        # Assignment moves the resolver's responsibility to the destination
        # department. Use persisted ownership when validating a mutation, so
        # setting oneself as assignee cannot create permission to do so.
        state = inspect(obj)
        def previous_or_current(field):
            history = state.attrs[field].history
            if history.deleted:
                return history.deleted[0]
            if history.has_changes() and state.persistent:
                return db.query(getattr(m.Defect, field)).filter(m.Defect.id == obj.id).scalar()
            return getattr(obj, field)
        if state.persistent and previous_or_current('assignee_id') == user.id:
            return True, previous_or_current('assigned_team') or obj.department
        return True, obj.department
    root = root_for(db, obj)
    if root is not None:
        project = getattr(root, 'project', None) or db.get(m.TestProject, root.project_id)
        return True, project.department if project else None
    if isinstance(obj, (m.QARequest, m.FunctionalRequest, m.SASTRequest, m.DASTRequest,
                        m.PerformanceRequest, m.SuppressionRequest, m.QASignOff,
                        m.Defect, m.TestProject, m.ApplicationMaster)):
        return True, getattr(obj, 'department', None)
    if isinstance(obj, m.ApprovalAction):
        from .deps import resolve_entity_department
        if obj.entity_type == 'DEFECT' and user is not None:
            defect = db.get(m.Defect, obj.entity_id)
            return record_department(db, defect, user) if defect is not None else (True, None)
        if obj.entity_type == 'SIGNOFF':
            signoff = db.get(m.QASignOff, obj.entity_id)
            return True, signoff.department if signoff else None
        return True, resolve_entity_department(db, obj.entity_type, obj.entity_id)
    return False, None


@event.listens_for(Session, 'before_flush')
def enforce_admin_workflow_department(db, flush_context, instances):
    user = db.info.get('workflow_actor')
    if user is None or not is_system_admin(user):
        return
    with db.no_autoflush:
        for obj in set(db.new) | set(db.dirty) | set(db.deleted):
            if obj in db.dirty and not db.is_modified(obj, include_collections=False):
                continue
            applicable, department = record_department(db, obj, user)
            if not applicable:
                continue
            require_admin_department(user, department)
            # Changing ownership must not make an out-of-department record writable.
            state = inspect(obj)
            if 'department' in state.attrs:
                for previous in state.attrs.department.history.deleted:
                    require_admin_department(user, previous)
