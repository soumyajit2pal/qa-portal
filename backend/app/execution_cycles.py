from typing import Optional

from fastapi import HTTPException


_PRE_EXECUTION_FUNCTIONAL_STATUSES = {
    "DRAFT",
    "SUBMITTED",
    "SM_APPROVAL_PENDING",
    "RETURNED_BY_SM",
    "SM_REJECTED",
    "DEPARTMENT_HEAD_APPROVAL_PENDING",
    "RETURNED_BY_DEPARTMENT_HEAD",
    "QA_LEAD_ASSIGNED",
    "READINESS_VERIFICATION",
    "RETURNED_BY_QA_LEAD",
    "QA_ACTIVITY_INITIATED",
    "PLANNING",
    "TESTER_ASSIGNED",
    "TEST_DESIGN",
}
_STARTABLE_CYCLE_STATUSES = {"Draft", "Ready", "In Progress"}


def execution_cycle_choice(existing_link, requested_cycle_id: Optional[int]):
    """Require one cycle while allowing a request's existing link to be reused."""
    if existing_link:
        if requested_cycle_id is not None and existing_link.cycle_id != requested_cycle_id:
            raise HTTPException(
                400,
                f"Test cycle {existing_link.cycle.cycle_key} is already linked to this request",
            )
        return existing_link.cycle, False
    if requested_cycle_id is None:
        raise HTTPException(400, "A test cycle must be linked before execution can start")
    return None, True


def require_cycle_startable(cycle) -> None:
    if cycle.status not in _STARTABLE_CYCLE_STATUSES:
        raise HTTPException(
            400,
            f"The linked Test Cycle is {cycle.status}. Link a Draft, Ready, or In Progress cycle before starting execution.",
        )


def require_cycle_unlinkable(request_status: str) -> None:
    """Keep a Functional request linked once execution has begun."""
    if not cycle_unlink_allowed(request_status):
        raise HTTPException(
            400,
            "A Test Cycle cannot be unlinked after execution has started",
        )


def cycle_unlink_allowed(request_status: str) -> bool:
    return request_status in _PRE_EXECUTION_FUNCTIONAL_STATUSES


def require_cycles_completed(cycles) -> None:
    """Require a linked, completed cycle before Functional QA can complete."""
    if not cycles:
        raise HTTPException(
            400,
            "Mark QA Complete requires a linked Test Cycle. Relink the request from Test Lifecycle before continuing.",
        )
    open_cycles = [cycle for cycle in cycles if cycle.status != "Completed"]
    if open_cycles:
        names = ", ".join(f"{cycle.cycle_key} ({cycle.status})" for cycle in open_cycles)
        raise HTTPException(
            400,
            "Mark QA Complete requires every linked Test Cycle to reach Completed first. "
            f"Still open: {names}",
        )


def require_request_execution_started(request) -> None:
    """The linked request must enter execution before its cycle can start."""
    from .constants import QAStatus, QA_REQUEST_STATUS_LABELS
    if request.status != QAStatus.EXECUTION_IN_PROGRESS:
        label = QA_REQUEST_STATUS_LABELS.get(request.status, request.status or "Unknown")
        raise HTTPException(
            400,
            f"Cannot start this Test Cycle. Linked request {request.request_id} is {label}. "
            "Start execution on the linked request first; its status must be Execution In Progress.",
        )
