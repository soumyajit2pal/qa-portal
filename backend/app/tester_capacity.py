"""Shared, versioned workload weights used by current and historical occupancy."""
from .constants import QAStatus

TESTER_CAPACITY_POINTS = 8.0
FUNCTIONAL_TESTER_LOAD = {
    QAStatus.TESTER_ASSIGNED: 0.50,
    QAStatus.TEST_DESIGN: 1.00,
    QAStatus.EXECUTION_IN_PROGRESS: 2.50,
    QAStatus.DEFECT_RAISED: 0.50,
    QAStatus.WAITING_FOR_FIX: 0.00,
    QAStatus.RETESTING: 0.75,
    QAStatus.QA_COMPLETED: 0.15,
    QAStatus.QA_CHANGE_REVIEW: 0.15,
    QAStatus.QA_SIGNOFF_PENDING: 0.10,
    QAStatus.QA_SIGNED_OFF: 0.10,
    QAStatus.REQUESTER_VERIFICATION: 0.05,
}
PERFORMANCE_TESTER_LOAD = {
    "ENVIRONMENT_SETUP": 1.00,
    "SCRIPT_DEVELOPMENT": 1.00,
    "BASELINE": 0.75,
    "LOAD_TEST_EXECUTION": 1.00,
    "RESULT_ANALYSIS": 0.25,
    "DEFECT_FIX_RETEST": 0.75,
    "REPORT": 0.15,
    "SIGNOFF_PENDING": 0.10,
}
PERFORMANCE_TESTER_WORKLOAD_STATUSES = list(PERFORMANCE_TESTER_LOAD)
SECURITY_ANALYST_LOAD = {
    "CONFIGURATION": 0.75,
    "SCANNING": 1.00,
    "FINDING_VALIDATION": 0.75,
    "REMEDIATION": 0.50,
    "ASSIGNED_TO_REQUESTER": 0.10,
    "WAITING_FOR_FIX": 0.00,
    "ASSIGNED_TO_LEAD": 0.10,
    "RESCAN": 0.75,
    "SECURITY_COMPLETE": 0.15,
    "REPORT_READY": 0.10,
}
SECURITY_ANALYST_WORKLOAD_STATUSES = list(SECURITY_ANALYST_LOAD)

_QUEUED_TESTER_STATUSES = {QAStatus.TESTER_ASSIGNED}
_WAITING_TESTER_STATUSES = {
    QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX, "ASSIGNED_TO_REQUESTER",
}
_NEAR_COMPLETE_TESTER_STATUSES = {
    QAStatus.QA_COMPLETED, QAStatus.QA_CHANGE_REVIEW,
    QAStatus.QA_SIGNOFF_PENDING, QAStatus.QA_SIGNED_OFF,
    QAStatus.REQUESTER_VERIFICATION, "REPORT", "SIGNOFF_PENDING", "SECURITY_COMPLETE", "REPORT_READY",
}


def _assigned_user_ids(value: str | None) -> list[int]:
    ids = []
    for raw_id in (value or "").split(","):
        try:
            ids.append(int(raw_id.strip()))
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys(ids))


def _occupancy_band(percent: int) -> str:
    if percent == 0:
        return "Available"
    if percent < 50:
        return "Light"
    if percent < 80:
        return "Balanced"
    if percent < 100:
        return "High"
    if percent == 100:
        return "Full"
    return "Overloaded"

