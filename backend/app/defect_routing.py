"""Stable resolver routing, stage reassignment and governed routing recovery."""
from dataclasses import dataclass
from fastapi import HTTPException

from . import models, reassignment
from .constants import Role, DEFECT_REASSIGNABLE_STATUSES
from .defect_assignment import assignment_error, current_defect_responsibility
from .defect_workflow import state
from .workflow_authority import is_system_admin, workflow_context
from .workspace_service import selectable_workspace_ids, inherited_workspace_access_mode


@dataclass(frozen=True)
class ResolverScope:
    department: str | None
    source: str
    owner_id: int | None


def resolver_scope(obj):
    snapshot = state(obj)
    if snapshot.get('resolver_department'):
        return ResolverScope(snapshot['resolver_department'], 'snapshot', snapshot.get('resolver_owner_id'))
    for event in reversed(snapshot.get('history', [])):
        if event.get('to') == 'Triaged' and event.get('assigned_team'):
            return ResolverScope(event['assigned_team'], 'triage', event.get('assignee_id'))
    # Older legacy records have no immutable department snapshot. Ordinary
    # reassignment uses the persisted team, never the owner's other teams.
    return ResolverScope(obj.assigned_team, 'current', obj.assignee_id)


def writable_workspace(db, obj, user):
    workspace_id = obj.qa_workspace_id or (obj.qa_request.qa_workspace_id if obj.qa_request else None)
    return bool(user.is_active and not set(user.roles) & {Role.VIEW_ONLY, Role.SCALE_6_PLUS}
                and workspace_id in selectable_workspace_ids(db, user)
                and inherited_workspace_access_mode(db, user, workspace_id) != 'PARENT_VIEWER')


def can_recover_routing(db, obj, user):
    if obj.status not in DEFECT_REASSIGNABLE_STATUSES or not obj.assignee_id or not writable_workspace(db, obj, user):
        return False
    if is_system_admin(user):
        return True
    workspace_id = obj.qa_workspace_id or (obj.qa_request.qa_workspace_id if obj.qa_request else None)
    if user.has_qa_workspace_role(Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
                                  workspace_id=workspace_id, allow_admin=False):
        return True
    scope = resolver_scope(obj)
    return bool(scope.source != 'current' and scope.department and user.has_department(scope.department)
                and set(user.roles) & set(reassignment.department_head_roles(scope.department)))


def recovery_departments(db, obj, user):
    if not can_recover_routing(db, obj, user):
        return []
    scope = resolver_scope(obj)
    query = db.query(models.Department).filter(models.Department.is_active == True)
    if scope.source != 'current':
        query = query.filter(models.Department.name == scope.department)
    return [row.name for row in query.order_by(models.Department.name).all()]


def can_reassign_owner(db, obj, user):
    responsibility = current_defect_responsibility(obj)
    if obj.status not in DEFECT_REASSIGNABLE_STATUSES or not responsibility.owner_id or not writable_workspace(db, obj, user):
        return False
    previous = db.get(models.User, responsibility.owner_id)
    workspace_id = obj.qa_workspace_id or (obj.qa_request.qa_workspace_id if obj.qa_request else None)
    departments = [resolver_scope(obj).department] if responsibility.kind == 'resolver' else (previous.departments if previous else [])
    try:
        # Normal reassignment remains an operational action; ADMIN alone is
        # only authorized for the separate, audited recovery action.
        with workflow_context(user):
            reassignment.require_can_reassign(user, responsibility.owner_id, departments,
                qa_workspace_id=workspace_id if responsibility.kind == 'qa' else None)
        return True
    except HTTPException:
        return False


def resolver_routing_mismatch(obj):
    department = resolver_scope(obj).department
    return bool(not department or obj.assigned_team != department
                or not obj.assignee or not obj.assignee.has_department(department))


def reassignment_error(db, obj, candidate):
    responsibility = current_defect_responsibility(obj)
    department = resolver_scope(obj).department if responsibility.kind == 'resolver' else None
    error = assignment_error(db, obj, candidate, responsibility.field, department)
    if error:
        return error
    if responsibility.kind == 'resolver':
        active = db.query(models.Department.id).filter(models.Department.name == department,
                                                       models.Department.is_active == True).first()
        if not active:
            return 'The responsible department is inactive or missing; contact an administrator or QA lead for routing recovery'
    if responsibility.kind == 'qa':
        proposer = next((event.get('user_id') for event in reversed(state(obj).get('history', []))
                         if event.get('to') == 'Not a Defect Review'), None) if obj.status == 'Not a Defect Review' else None
        original_resolver_id = resolver_scope(obj).owner_id if responsibility.legacy_assignee_override else obj.assignee_id
        if candidate.id in {obj.assignee_id, original_resolver_id, proposer}:
            return 'Select an independent QA reviewer other than the resolver or proposal author'
    return None


def recovery_error(db, obj, candidate, department):
    error = assignment_error(db, obj, candidate, 'assignee_id', department)
    if error:
        return error
    responsibility = current_defect_responsibility(obj)
    qa_ids = {obj.retest_tester_id, state(obj).get('qa_owner_id')}
    if responsibility.kind == 'qa':
        qa_ids.add(responsibility.owner_id)
    if candidate.id in qa_ids:
        return 'Select a resolver different from the retained QA reviewer'
    return None
