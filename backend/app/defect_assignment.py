"""Shared candidate policy for defect workflow selection and submission."""
from dataclasses import dataclass
import datetime

from .constants import Role
from .workflow_authority import WORKFLOW_ROLES, admin_department_allowed

OWNER_ROLES = {
    'assignee_id': WORKFLOW_ROLES,
    'retest_tester_id': {Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA},
    'business_owner_id': {Role.BUSINESS_ANALYST, Role.APPLICATION_OWNER, Role.REQUESTER},
    'release_owner_id': WORKFLOW_ROLES,
}


QA_RESPONSIBILITY_STATUSES = {
    "Resolved", "Retest", "Ready for QA", "QA Testing", "Not a Defect Review",
}
BUSINESS_RESPONSIBILITY_STATUSES = {"Business Acceptance"}
RELEASE_RESPONSIBILITY_STATUSES = {"Ready for Release", "Production Verification"}


@dataclass(frozen=True)
class DefectResponsibility:
    """The assignment field that owns the defect's current workflow stage."""

    kind: str
    field: str
    owner_id: int | None
    assignment_role: str
    legacy_assignee_override: bool = False


def _local_datetime(value) -> datetime.datetime | None:
    """Normalize database/JSON timestamps for legacy handoff comparison."""
    if isinstance(value, datetime.datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    # Workflow history is serialized with the IST offset, while Oracle's
    # plain DATE/TIMESTAMP columns return a naive local value. Compare their
    # local wall-clock values rather than mixing aware and naive datetimes.
    return parsed.replace(tzinfo=None)


def _latest_qa_handoff_at(defect, workflow_state) -> datetime.datetime | None:
    handoff_targets = {"Resolved", "Ready for QA", "Not a Defect Review"}
    for event in reversed(workflow_state.get("history", [])):
        if event.get("to") in handoff_targets:
            return _local_datetime(event.get("at"))
    return None


def current_defect_responsibility(defect) -> DefectResponsibility:
    """Resolve the person who owns the defect at its current stage.

    Older releases always rewrote ``assignee_id`` during reassignment, even
    after a developer had handed the defect to QA. For those already-affected
    rows, an assignee update recorded after the QA handoff is treated as the
    latest QA owner until the next reassignment normalizes ``retest_tester_id``
    and writes ``qa_owner_id`` into the versioned workflow state.
    """
    from .defect_workflow import state

    workflow_state = state(defect) if getattr(defect, "workflow_json", None) else {}
    status = getattr(defect, "status", None)
    if status in QA_RESPONSIBILITY_STATUSES:
        explicit_owner_id = workflow_state.get("qa_owner_id")
        if explicit_owner_id:
            return DefectResponsibility(
                "qa", "retest_tester_id", int(explicit_owner_id), "DEFECT_RETEST_TESTER",
            )
        retest_owner_id = getattr(defect, "retest_tester_id", None)
        assignee_id = getattr(defect, "assignee_id", None)
        assigned_at = _local_datetime(getattr(defect, "assigned_at", None))
        handoff_at = _latest_qa_handoff_at(defect, workflow_state)
        if (
            assignee_id
            and retest_owner_id
            and assignee_id != retest_owner_id
            and assigned_at is not None
            and handoff_at is not None
            and assigned_at > handoff_at
        ):
            return DefectResponsibility(
                "qa", "retest_tester_id", assignee_id, "DEFECT_RETEST_TESTER", True,
            )
        return DefectResponsibility(
            "qa", "retest_tester_id", retest_owner_id, "DEFECT_RETEST_TESTER",
        )
    if status in BUSINESS_RESPONSIBILITY_STATUSES:
        owner_id = workflow_state.get("business_owner_id")
        return DefectResponsibility(
            "business", "business_owner_id", int(owner_id) if owner_id else None,
            "DEFECT_BUSINESS_OWNER",
        )
    if status in RELEASE_RESPONSIBILITY_STATUSES:
        owner_id = workflow_state.get("release_owner_id")
        return DefectResponsibility(
            "release", "release_owner_id", int(owner_id) if owner_id else None,
            "DEFECT_RELEASE_OWNER",
        )
    return DefectResponsibility(
        "resolver", "assignee_id", getattr(defect, "assignee_id", None), "DEFECT_ASSIGNEE",
    )


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
