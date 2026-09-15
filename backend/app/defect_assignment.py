"""Shared candidate policy for defect workflow selection and submission."""
from .constants import Role
from .workflow_authority import WORKFLOW_ROLES, admin_department_allowed

OWNER_ROLES = {
    'assignee_id': WORKFLOW_ROLES,
    'retest_tester_id': {Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA},
    'business_owner_id': {Role.BUSINESS_ANALYST, Role.APPLICATION_OWNER, Role.REQUESTER},
    'release_owner_id': WORKFLOW_ROLES,
}


def assignment_error(db, defect, candidate, field, department=None):
    if not candidate or not candidate.is_active or not candidate.show_in_user_dropdowns:
        return 'Select an active, visible user'
    roles = set(candidate.roles)
    if Role.VIEW_ONLY in roles or not roles.intersection(OWNER_ROLES[field]):
        return 'Select a user with an eligible workflow role'
    from .workspace_service import selectable_workspace_ids, inherited_workspace_access_mode
    workspace_id = getattr(defect, 'qa_workspace_id', None) or (defect.qa_request.qa_workspace_id if defect.qa_request else None)
    if workspace_id not in selectable_workspace_ids(db, candidate):
        return 'User must have access to this workspace'
    if inherited_workspace_access_mode(db, candidate, workspace_id) == 'PARENT_VIEWER':
        return 'Read-only workspace access cannot perform workflow actions'
    action_department = department if field == "assignee_id" else defect.department
    if not admin_department_allowed(candidate, action_department):
        return 'User cannot perform workflow outside their department'
    if field == 'assignee_id' and (not department or not candidate.has_department(department)):
        return 'Resolver must belong to the selected department'
    return None
