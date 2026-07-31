"""Shared enumerations / constant lists used across models, schemas and routers."""

# ---- Roles (Section: User Roles table in the CR document) ----
class Role:
    REQUESTER = "REQUESTER"                    # Requester (Developer) - Raise Requests
    BUSINESS_ANALYST = "BUSINESS_ANALYST"       # Upload Finalised CR / User Stories
    QA_ENGINEER = "QA_ENGINEER"                 # Execute Testing
    QA_LEAD = "QA_LEAD"                         # Review & approve
    DEPARTMENT_HEAD_COE = "DEPARTMENT_HEAD_COE"  # QA Sign-off (CM/AGM-QA) / Executive COE (AGM-QA) -- QA Sign-off only
    SECURITY_ANALYST = "SECURITY_ANALYST"       # SAST/DAST Management
    APPLICATION_OWNER = "APPLICATION_OWNER"     # Approval Authority
    DEPARTMENT_HEAD = "DEPARTMENT_HEAD"         # QA Request + Suppression Approval (business dept head)
    ADMIN = "ADMIN"                             # Configuration & Access
    # New checkpoint role sitting between the requester and Department Head on
    # every workflow (QA Request, SAST/DAST, Suppression) -- added per request.
    # Label is deliberately left as the literal "SM" (not expanded to a guessed
    # full name like "Senior Manager"/"Section Manager") since that's what was
    # specified; rename ROLE_LABELS[Role.SM] below if you want a fuller label.
    SM = "SM"

ALL_ROLES = [
    Role.REQUESTER, Role.BUSINESS_ANALYST, Role.QA_ENGINEER, Role.QA_LEAD,
    Role.DEPARTMENT_HEAD_COE, Role.SECURITY_ANALYST, Role.APPLICATION_OWNER,
    Role.DEPARTMENT_HEAD, Role.SM, Role.ADMIN,
]

# ---- Login / authentication type (Admin section: Module 9 - Configuration & Access) ----
class LoginType:
    STANDARD = "STANDARD"   # local username + bcrypt-hashed password
    LDAP = "LDAP"           # authenticated against the bank's LDAP / Active Directory

ALL_LOGIN_TYPES = [LoginType.STANDARD, LoginType.LDAP]

LOGIN_TYPE_LABELS = {
    LoginType.STANDARD: "Standard (local password)",
    LoginType.LDAP: "LDAP / Active Directory",
}

# Role granted automatically when a brand-new LDAP account is just-in-time
# provisioned on its first successful login (see routers/auth.py::login).
# Deliberately the lowest-privilege role in the system -- the account is
# flagged (User.needs_role_review) until an admin reviews it and assigns
# the role it actually needs.
DEFAULT_LDAP_PROVISION_ROLE = Role.REQUESTER

ROLE_LABELS = {
    Role.REQUESTER: "Requester (Developer) / Others",
    Role.BUSINESS_ANALYST: "Business Analyst",
    Role.QA_ENGINEER: "QA Engineer (QA)",
    Role.QA_LEAD: "QA Lead",
    Role.DEPARTMENT_HEAD_COE: "Executive COE (AGM-QA)",
    Role.SECURITY_ANALYST: "Security Analyst (QA)",
    Role.APPLICATION_OWNER: "Application Owner",
    Role.DEPARTMENT_HEAD: "Department Head - CM/AGM",
    Role.SM: "SM",
    Role.ADMIN: "Administrator",
}

# ---- Departments (Admin section: user mapping = department + role(s)) ----
# NOTE: departments are now DB-backed (see models.Department / routers/departments.py)
# instead of this hardcoded list, so an admin can add/deactivate departments at
# runtime without a redeploy. This constant is kept ONLY as the one-time seed
# list consumed by seed.py on first run -- nothing else should import it.
SEED_DEPARTMENTS = [
    "Information Technology Department",
    "Digital Banking Department (DBD)",
    "Software",
    "QA Team",
    "Information Security",
    "Core Banking Systems (CBS)",
    "Human Resources (HR)",
    "Business Development",
    "Operations",
    "Compliance",
    "Finance & Accounts",
    "Risk Management",
    "Internal Audit",
]

# ---- Module 1: QA Request (gateway) / Functional Testing Request ----
REQUEST_TYPES = [
    "Functional Testing", "Sanity Testing", "Regression Testing", "UAT Support",
    "Performance Testing", "SAST", "DAST", "Automation Testing", "Others",
]

# The QA Request is a pure intake/gateway record (see models.QARequest / the
# GATEWAY_* constants below) -- it captures application/change details and
# request_types, then immediately raises whichever independent child
# request(s) apply, each with its own unique ID and its own workflow:
#   - Functional Testing / Sanity Testing / Regression Testing / UAT Support
#     (any of these types) -> one combined FunctionalRequest (see
#     models.FunctionalRequest, QAStatus below).
#   - SAST / DAST -> SASTRequest / DASTRequest.
#   - Automation Testing -> AutomationRequest.
#   - Performance Testing -> PerformanceRequest.
# See routers/qa_requests.py::_sync_linked_child_requests.
FUNCTIONAL_BUCKET_TYPES = ["Functional Testing", "Sanity Testing", "Regression Testing", "UAT Support"]

# ---- QA Request gateway lifecycle -- deliberately minimal: the gateway
# itself has no approval workflow of its own ("QA request form will be the
# gateway only" per request). Draft -> Submitted -> Raised (immediately, in
# the same call -- see routers/qa_requests.py::submit_request) once its
# linked child request(s) exist, or Cancelled while still in Draft.
class GatewayStatus:
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    RAISED = "RAISED"
    CANCELLED = "CANCELLED"

GATEWAY_STATUSES = [GatewayStatus.DRAFT, GatewayStatus.SUBMITTED, GatewayStatus.RAISED, GatewayStatus.CANCELLED]
GATEWAY_STATUS_LABELS = {
    GatewayStatus.DRAFT: "Draft",
    GatewayStatus.SUBMITTED: "Submitted",
    GatewayStatus.RAISED: "Raised",
    GatewayStatus.CANCELLED: "Cancelled",
}
GATEWAY_EDITABLE_STATUSES = [GatewayStatus.DRAFT]
GATEWAY_TERMINAL_STATUSES = [GatewayStatus.RAISED, GatewayStatus.CANCELLED]
GATEWAY_CANCELLABLE_STATUSES = [GatewayStatus.DRAFT]


class QAStatus:
    """The Functional Testing Request lifecycle (covers whichever of
    Functional/Sanity/Regression Testing/UAT Support were selected on the QA
    Request gateway -- see models.FunctionalRequest): Requester -> Draft ->
    Submit to SM -> SM approval -> Department Head approval (also assigns
    the QA Lead) -> QA Lead readiness verification -> QA activity (planning/
    tester assignment/test design/execution, with a defect-fix-retest-
    regression cycle) -> QA sign-off -> Requester verification -> Closed.

    Can only be marked QA_COMPLETED once every SAST/DAST/Automation/
    Performance request linked to the *same gateway QA Request* (see
    FunctionalRequest.qa_request.linked_sast_requests/etc) is itself in a
    terminal state -- see SAST_DAST_TERMINAL_STATUSES/AUTOMATION_TERMINAL_STATUSES/
    PERFORMANCE_TERMINAL_STATUSES and routers/functional.py::complete_qa.
    """
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    # New: sits between Submitted and Department Head Approval.
    SM_APPROVAL_PENDING = "SM_APPROVAL_PENDING"
    RETURNED_BY_SM = "RETURNED_BY_SM"
    SM_REJECTED = "SM_REJECTED"
    DEPARTMENT_HEAD_APPROVAL_PENDING = "DEPARTMENT_HEAD_APPROVAL_PENDING"
    RETURNED_BY_DEPARTMENT_HEAD = "RETURNED_BY_DEPARTMENT_HEAD"
    DEPARTMENT_HEAD_REJECTED = "DEPARTMENT_HEAD_REJECTED"
    QA_LEAD_ASSIGNED = "QA_LEAD_ASSIGNED"
    READINESS_VERIFICATION = "READINESS_VERIFICATION"
    RETURNED_BY_QA_LEAD = "RETURNED_BY_QA_LEAD"
    QA_ACTIVITY_INITIATED = "QA_ACTIVITY_INITIATED"
    PLANNING = "PLANNING"
    TESTER_ASSIGNED = "TESTER_ASSIGNED"
    TEST_DESIGN = "TEST_DESIGN"
    EXECUTION_IN_PROGRESS = "EXECUTION_IN_PROGRESS"
    DEFECT_RAISED = "DEFECT_RAISED"
    WAITING_FOR_FIX = "WAITING_FOR_FIX"
    RETESTING = "RETESTING"
    REGRESSION_TESTING = "REGRESSION_TESTING"
    QA_COMPLETED = "QA_COMPLETED"
    QA_SIGNOFF_PENDING = "QA_SIGNOFF_PENDING"
    QA_SIGNED_OFF = "QA_SIGNED_OFF"
    REQUESTER_VERIFICATION = "REQUESTER_VERIFICATION"
    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"


QA_REQUEST_STATUSES = [
    QAStatus.DRAFT, QAStatus.SUBMITTED,
    QAStatus.SM_APPROVAL_PENDING, QAStatus.RETURNED_BY_SM, QAStatus.SM_REJECTED,
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.DEPARTMENT_HEAD_REJECTED,
    QAStatus.QA_LEAD_ASSIGNED,
    QAStatus.READINESS_VERIFICATION, QAStatus.RETURNED_BY_QA_LEAD, QAStatus.QA_ACTIVITY_INITIATED,
    QAStatus.PLANNING, QAStatus.TESTER_ASSIGNED, QAStatus.TEST_DESIGN, QAStatus.EXECUTION_IN_PROGRESS,
    QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX, QAStatus.RETESTING, QAStatus.REGRESSION_TESTING,
    QAStatus.QA_COMPLETED, QAStatus.QA_SIGNOFF_PENDING, QAStatus.QA_SIGNED_OFF,
    QAStatus.REQUESTER_VERIFICATION, QAStatus.CLOSED, QAStatus.CANCELLED,
]

# Statuses from which the Functional Testing Request's own descriptive
# fields (currently just priority/risk_rating -- see models.FunctionalRequest
# and PUT /api/functional-requests/{id}) can still be edited by the
# requester -- same pattern/values as SAST_DAST_EDITABLE_STATUSES/
# AUTOMATION_EDITABLE_STATUSES/PERFORMANCE_EDITABLE_STATUSES below.
FUNCTIONAL_EDITABLE_STATUSES = [
    QAStatus.DRAFT, QAStatus.RETURNED_BY_SM, QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD,
]

# Terminal statuses -- no further transitions possible.
QA_REQUEST_TERMINAL_STATUSES = [
    QAStatus.CLOSED, QAStatus.CANCELLED, QAStatus.SM_REJECTED, QAStatus.DEPARTMENT_HEAD_REJECTED,
]

# Statuses from which the requester (or admin) may still cancel the request --
# once the Department Head approves and a QA Lead is assigned (QA_LEAD_ASSIGNED
# onwards, including a later RETURNED_BY_QA_LEAD loop back), the request is
# already committed to QA and cancellation is no longer offered.
QA_REQUEST_CANCELLABLE_STATUSES = [
    QAStatus.DRAFT, QAStatus.SUBMITTED,
    QAStatus.SM_APPROVAL_PENDING, QAStatus.RETURNED_BY_SM,
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD,
]

# Human-readable labels for the frontend status filter / badges.
QA_REQUEST_STATUS_LABELS = {
    QAStatus.DRAFT: "Draft",
    QAStatus.SUBMITTED: "Submitted",
    QAStatus.SM_APPROVAL_PENDING: "SM Approval Pending",
    QAStatus.RETURNED_BY_SM: "Returned by SM",
    QAStatus.SM_REJECTED: "Rejected by SM",
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING: "Department Head Approval Pending",
    QAStatus.RETURNED_BY_DEPARTMENT_HEAD: "Returned by Department Head",
    QAStatus.DEPARTMENT_HEAD_REJECTED: "Department Head Rejected",
    QAStatus.QA_LEAD_ASSIGNED: "QA Lead Assigned",
    QAStatus.READINESS_VERIFICATION: "Readiness Verification",
    QAStatus.RETURNED_BY_QA_LEAD: "Returned by QA Lead",
    QAStatus.QA_ACTIVITY_INITIATED: "QA Activity Initiated",
    QAStatus.PLANNING: "Planning",
    QAStatus.TESTER_ASSIGNED: "Tester Assigned",
    QAStatus.TEST_DESIGN: "Test Design",
    QAStatus.EXECUTION_IN_PROGRESS: "Execution In Progress",
    QAStatus.DEFECT_RAISED: "Defect Raised",
    QAStatus.WAITING_FOR_FIX: "Waiting For Fix",
    QAStatus.RETESTING: "Retesting",
    QAStatus.REGRESSION_TESTING: "Regression Testing",
    QAStatus.QA_COMPLETED: "QA Completed",
    QAStatus.QA_SIGNOFF_PENDING: "QA Sign-off Pending",
    QAStatus.QA_SIGNED_OFF: "QA Signed Off",
    QAStatus.REQUESTER_VERIFICATION: "Requester Verification",
    QAStatus.CLOSED: "Closed",
    QAStatus.CANCELLED: "Cancelled",
}

# Default items seeded onto every new QA Request's "Ready for Testing" readiness checklist.
DEFAULT_CHECKLIST_ITEMS = [
    ("BRD / FRS / User Stories approved", "Business / BA"),
    ("Scope finalized & change freeze", "Business / IT"),
    ("Test Environment availability (UAT / SIT)", "Business"),
    ("Test data creation", "User dept / Dev team"),
    ("Assess Test Scenarios", "User Dept"),
    ("Project walkthrough to QA", "User Dept / Dev team"),
    ("Application builds deployed & validated", "Dev team / Business"),
    ("Security access (VPN Proxy/URLs whitelisting/credentials/firewall)", "User dept"),
    ("SAST readiness", "User dept"),
    ("DAST readiness", "User dept"),
]

# Checklist items whose mandatory-ness depends on which request type(s) were
# selected on the QA Request -- everything else in DEFAULT_CHECKLIST_ITEMS is
# unconditionally mandatory. "SAST readiness" only blocks the readiness gate
# when SAST was actually requested; same for "DAST readiness" and DAST.
CONDITIONAL_CHECKLIST_ITEMS = {
    "SAST readiness": "SAST",
    "DAST readiness": "DAST",
}


def checklist_item_is_mandatory(item: str, request_types) -> bool:
    required_type = CONDITIONAL_CHECKLIST_ITEMS.get(item)
    if required_type is not None:
        # Conditional item ("SAST readiness" / "DAST readiness") -- mandatory
        # only when that specific request type was actually selected.
        return required_type in request_types

    # Unconditional item (BRD approved, Scope finalized, Test Environment,
    # Test data, Test Scenarios, Project walkthrough, Application builds,
    # Security access). These are the *functional* readiness items -- mandatory
    # for normal QA requests, but NOT for a security-only request (one whose
    # request types are exclusively SAST and/or DAST, with no functional/other
    # testing type selected), since there's no functional test cycle to gate.
    security_types = set(CONDITIONAL_CHECKLIST_ITEMS.values())  # {"SAST", "DAST"}
    is_security_only = bool(request_types) and set(request_types) <= security_types
    return not is_security_only

PRIORITIES = ["Critical", "High", "Medium", "Low"]
RISK_RATINGS = ["Critical", "High", "Medium", "Low"]
ENVIRONMENTS = ["Dev", "SIT", "UAT", "Pre-Production", "Production"]

# Pipeline order for the QA Request gateway's "Deployment Environment" ->
# "Target Promotion Environment" pair -- Target Promotion Environment must be
# a *later* stage than Deployment Environment (e.g. Deployment Environment =
# UAT means Target Promotion Environment must be Pre-Production or
# Production, never SIT or UAT itself). "Dev" is excluded -- the wizard's
# Deployment Environment/Target Promotion Environment dropdowns never offer
# it (see ENVIRONMENTS usage in frontend/src/QARequests.tsx), so it never
# reaches this check as either value.
ENVIRONMENT_PROMOTION_ORDER = ["SIT", "UAT", "Pre-Production", "Production"]


def validate_promotion_environment(environment, target_promotion_environment):
    """Returns an error message string if target_promotion_environment isn't
    strictly later than environment in ENVIRONMENT_PROMOTION_ORDER, else
    None. Blank values or values outside ENVIRONMENT_PROMOTION_ORDER (e.g.
    "Dev", or not yet set) are left unchecked here -- the caller decides
    whether either field is actually required."""
    if not environment or not target_promotion_environment:
        return None
    if environment not in ENVIRONMENT_PROMOTION_ORDER or target_promotion_environment not in ENVIRONMENT_PROMOTION_ORDER:
        return None
    env_idx = ENVIRONMENT_PROMOTION_ORDER.index(environment)
    target_idx = ENVIRONMENT_PROMOTION_ORDER.index(target_promotion_environment)
    if target_idx <= env_idx:
        later_stages = ENVIRONMENT_PROMOTION_ORDER[env_idx + 1:]
        expected = ", ".join(later_stages) if later_stages else "no later stage -- Production is the last one"
        return (
            f"Target Promotion Environment ('{target_promotion_environment}') must be a later stage than "
            f"Deployment Environment ('{environment}'). Expected: {expected}."
        )
    return None

# ---- Module 4/5: SAST / DAST ----
# Independent lifecycle (identical for SAST and DAST), rebuilt with the fuller
# named stages requested:
#
#   Draft -> Submit -> SM Approval -> Department Head Approval -> Security
#   Lead Assigned (a Security Analyst is assigned, mirroring how a QA Lead is
#   assigned on the QA Request) -> Security Readiness (readiness check by the
#   assigned Security Lead or a QA Lead) -> Planning -> Configuration (scan
#   setup -- "SAST Configuration"/"DAST Configuration" depending on scan type)
#   -> Scanning -> Finding Validation -> Remediation, which itself cycles:
#   Assigned To Requester -> Waiting For Fix -> Assigned To Lead -> Rescan ->
#   (back to Scanning if more issues, otherwise) Security Complete -> Report
#   Ready.
#
# The final Security Complete -> Report Ready step additionally checks whether
# any Suppression request was raised against this SAST/DAST id -- if so, ALL
# such suppression requests must be "Done" before Report Ready is allowed (see
# routers/sast_dast.py::_mark_report_ready and SUPPRESSION_STATUSES below).
SAST_DAST_STATUSES = [
    "DRAFT", "SUBMITTED",
    "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD", "DEPARTMENT_HEAD_REJECTED",
    "SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS", "RETURNED_BY_SECURITY_LEAD",
    "PLANNING", "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION",
    "ASSIGNED_TO_REQUESTER", "WAITING_FOR_FIX", "ASSIGNED_TO_LEAD", "RESCAN",
    "SECURITY_COMPLETE", "REPORT_READY", "CLOSED",
]
# Terminal states -- a linked SAST/DAST request must be in one of these before
# its parent QA Request can be marked QA_COMPLETED (see QAStatus docstring
# above and routers/qa_requests.py::complete_qa). Rejections at either
# approval checkpoint count as "resolved" for this purpose too.
SAST_DAST_TERMINAL_STATUSES = ["REPORT_READY", "CLOSED", "SM_REJECTED", "DEPARTMENT_HEAD_REJECTED"]
# Statuses from which the requester may still edit mandatory details (repo
# URL/branch/commit/tech stack for SAST; target URL/env/credentials for DAST).
SAST_DAST_EDITABLE_STATUSES = ["DRAFT", "RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD"]

SAST_DAST_STATUS_LABELS = {
    "DRAFT": "Draft",
    "SUBMITTED": "Submitted",
    "SM_APPROVAL_PENDING": "SM Approval Pending",
    "RETURNED_BY_SM": "Returned by SM",
    "SM_REJECTED": "Rejected by SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head Approval Pending",
    "RETURNED_BY_DEPARTMENT_HEAD": "Returned by Department Head",
    "DEPARTMENT_HEAD_REJECTED": "Department Head Rejected",
    "SECURITY_LEAD_ASSIGNED": "Security Lead Assigned",
    "SECURITY_READINESS": "Security Readiness",
    "RETURNED_BY_SECURITY_LEAD": "Returned by Security Lead",
    "PLANNING": "Planning",
    "CONFIGURATION": "Scan Configuration",
    "SCANNING": "Scanning",
    "FINDING_VALIDATION": "Finding Validation",
    "REMEDIATION": "Remediation",
    "ASSIGNED_TO_REQUESTER": "Assigned to Requester",
    "WAITING_FOR_FIX": "Waiting For Fix",
    "ASSIGNED_TO_LEAD": "Assigned to Lead",
    "RESCAN": "Rescan",
    "SECURITY_COMPLETE": "Security Complete",
    "REPORT_READY": "Report Ready",
    "CLOSED": "Closed",
}

# ---- Module 4b: Automation Testing ----
# Auto-created from a QA Request when "Automation Testing" is one of its
# request types (see routers/qa_requests.py::_sync_linked_child_requests),
# same pattern as SAST/DAST. Independent lifecycle after the common Draft/SM/
# Department Head prefix: Feasibility Assessment -> Planning -> Engineer
# Assignment -> Script Development -> Review -> Execution -> CI/CD Integration
# (optional -- can be skipped) -> Sign-off -> Requester Verification -> Closed.
AUTOMATION_STATUSES = [
    "DRAFT", "SUBMITTED",
    "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD", "DEPARTMENT_HEAD_REJECTED",
    "FEASIBILITY_ASSESSMENT", "RETURNED_BY_QA_LEAD", "PLANNING", "ENGINEER_ASSIGNMENT", "SCRIPT_DEVELOPMENT",
    "REVIEW", "EXECUTION", "CI_CD_INTEGRATION",
    "SIGNOFF_PENDING", "SIGNED_OFF", "REQUESTER_VERIFICATION", "CLOSED", "CANCELLED",
]
AUTOMATION_TERMINAL_STATUSES = ["CLOSED", "CANCELLED", "SM_REJECTED", "DEPARTMENT_HEAD_REJECTED"]
AUTOMATION_EDITABLE_STATUSES = ["DRAFT", "RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_QA_LEAD"]
AUTOMATION_STATUS_LABELS = {
    "DRAFT": "Draft", "SUBMITTED": "Submitted",
    "SM_APPROVAL_PENDING": "SM Approval Pending", "RETURNED_BY_SM": "Returned by SM",
    "SM_REJECTED": "Rejected by SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head Approval Pending",
    "RETURNED_BY_DEPARTMENT_HEAD": "Returned by Department Head",
    "DEPARTMENT_HEAD_REJECTED": "Department Head Rejected",
    "FEASIBILITY_ASSESSMENT": "Feasibility Assessment", "RETURNED_BY_QA_LEAD": "Returned by QA Lead",
    "PLANNING": "Planning",
    "ENGINEER_ASSIGNMENT": "Engineer Assignment", "SCRIPT_DEVELOPMENT": "Script Development",
    "REVIEW": "Review", "EXECUTION": "Execution", "CI_CD_INTEGRATION": "CI/CD Integration",
    "SIGNOFF_PENDING": "Sign-off Pending", "SIGNED_OFF": "Signed Off",
    "REQUESTER_VERIFICATION": "Requester Verification", "CLOSED": "Closed", "CANCELLED": "Cancelled",
}
# Linear order of the execution-side stages (after Department Head approval,
# before Sign-off) -- CI/CD Integration is explicitly optional/skippable, so
# it has its own "skip" transition straight to Sign-off Pending.
AUTOMATION_STAGE_ORDER = [
    "FEASIBILITY_ASSESSMENT", "PLANNING", "ENGINEER_ASSIGNMENT", "SCRIPT_DEVELOPMENT",
    "REVIEW", "EXECUTION", "CI_CD_INTEGRATION",
]

# Automation Testing's own "Ready for Automation" readiness checklist --
# distinct from DEFAULT_CHECKLIST_ITEMS (Functional Testing's) and
# DEFAULT_PERFORMANCE_CHECKLIST_ITEMS (Performance Testing's). Seeded onto
# every new AutomationRequest (see models.AutomationChecklistItem and
# routers/qa_requests.py::_sync_linked_child_requests) only while "Automation
# Testing" is one of the QA Request's selected request types -- the wizard's
# "Automation Readiness Checklist" step itself only appears under that same
# condition (see frontend QARequests.tsx::buildSteps), same "only relevant if
# that type is selected" behavior as the SAST/DAST readiness items embedded in
# the Functional checklist (see CONDITIONAL_CHECKLIST_ITEMS below). All items
# are mandatory before Feasibility Assessment can Pass (see
# routers/automation.py::feasibility_decision) except "Manual testing
# completed..." -- automation can legitimately start before manual testing
# has finished, so that one is informational only.
# Each entry is (item, owner, is_mandatory).
DEFAULT_AUTOMATION_CHECKLIST_ITEMS = [
    ("BRD / FRS / approved User Stories available", "Business / BA", True),
    ("Automation scope and objectives finalized", "Business / IT", True),
    ("Functional test scenarios reviewed and approved", "User Department", True),
    ("Manual testing completed and application functionality stabilized", "QA / Business", False),
    ("Stable application build deployed in the target environment", "Development Team", True),
    ("Dedicated and stable automation environment available", "IT / Development Team", True),
    ("Application URLs and required endpoints available", "Development Team", True),
    ("Test data requirements identified and reusable test data created", "User Department / Development Team", True),
    ("Test user accounts and role-based credentials available", "Business / IT", True),
    ("Stable UI element identifiers available, such as id, name, or data-testid", "Development Team", True),
    ("Application walkthrough provided to the Automation QA team", "User Department / Development Team", True),
    ("Expected results and business validation rules clearly documented", "Business / BA", True),
    ("Third-party services, OTP, CAPTCHA and payment dependencies identified with test-mode or bypass mechanisms",
     "Business / Development Team", True),
    ("Point of contact identified for functional queries, technical issues and environment support", "", True),
    ("Out-of-scope and non-automatable scenarios documented and approved", "QA / Business", True),
]

# ---- Module 4c: Performance Testing ----
# Auto-created from a QA Request when "Performance Testing" is one of its
# request types, same pattern as SAST/DAST/Automation. Independent lifecycle
# after the common Draft/SM/Department Head prefix: Engineer Assigned (the
# Department Head assigns a QA Engineer/Lead at approval time, mirroring how
# SAST/DAST assign a Security Lead and Automation assigns an Engineer) ->
# Readiness -> Feasibility -> Planning -> Environment Setup -> Script
# Development -> Baseline -> Load Test Execution -> Result Analysis ->
# Defect/Fix/Retest -> Report -> Sign-off -> Requester Verification -> Closed.
PERFORMANCE_STATUSES = [
    "DRAFT", "SUBMITTED",
    "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD", "DEPARTMENT_HEAD_REJECTED",
    "ENGINEER_ASSIGNED", "RETURNED_BY_ENGINEER",
    "READINESS", "FEASIBILITY", "PLANNING", "ENVIRONMENT_SETUP", "SCRIPT_DEVELOPMENT",
    "BASELINE", "LOAD_TEST_EXECUTION", "RESULT_ANALYSIS", "DEFECT_FIX_RETEST", "REPORT",
    "SIGNOFF_PENDING", "SIGNED_OFF", "REQUESTER_VERIFICATION", "CLOSED", "CANCELLED",
]
PERFORMANCE_TERMINAL_STATUSES = ["CLOSED", "CANCELLED", "SM_REJECTED", "DEPARTMENT_HEAD_REJECTED"]
PERFORMANCE_EDITABLE_STATUSES = ["DRAFT", "RETURNED_BY_SM", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_ENGINEER"]
PERFORMANCE_STATUS_LABELS = {
    "DRAFT": "Draft", "SUBMITTED": "Submitted",
    "SM_APPROVAL_PENDING": "SM Approval Pending", "RETURNED_BY_SM": "Returned by SM",
    "SM_REJECTED": "Rejected by SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head Approval Pending",
    "RETURNED_BY_DEPARTMENT_HEAD": "Returned by Department Head",
    "DEPARTMENT_HEAD_REJECTED": "Department Head Rejected",
    "ENGINEER_ASSIGNED": "Engineer Assigned", "RETURNED_BY_ENGINEER": "Returned by Engineer",
    "READINESS": "Readiness", "FEASIBILITY": "Feasibility", "PLANNING": "Planning",
    "ENVIRONMENT_SETUP": "Environment Setup", "SCRIPT_DEVELOPMENT": "Script Development",
    "BASELINE": "Baseline", "LOAD_TEST_EXECUTION": "Load Test Execution",
    "RESULT_ANALYSIS": "Result Analysis", "DEFECT_FIX_RETEST": "Defect / Fix / Retest", "REPORT": "Report",
    "SIGNOFF_PENDING": "Sign-off Pending", "SIGNED_OFF": "Signed Off",
    "REQUESTER_VERIFICATION": "Requester Verification", "CLOSED": "Closed", "CANCELLED": "Cancelled",
}
# Linear order of the execution-side stages (after Department Head approval,
# before Sign-off).
PERFORMANCE_STAGE_ORDER = [
    "ENGINEER_ASSIGNED",
    "READINESS", "FEASIBILITY", "PLANNING", "ENVIRONMENT_SETUP", "SCRIPT_DEVELOPMENT",
    "BASELINE", "LOAD_TEST_EXECUTION", "RESULT_ANALYSIS", "DEFECT_FIX_RETEST", "REPORT",
]

# Request type checkboxes shown on the Performance Testing page of the QA
# Request form (Annexure VIII, item 3) -- distinct from the top-level
# REQUEST_TYPES list (which just has one "Performance Testing" entry).
PERFORMANCE_REQUEST_TYPES = ["Load Testing", "Stress Testing", "Spike Testing"]
# Annexure VIII, item 7.
CHANGE_TYPES = ["New", "Enhancement", "Bug Fix"]

# Annexure VIII ("QA Request Form & Checklist (Performance Testing)"), table 2:
# "L1: Pre-Testing Readiness Checklist" -- 19 items, each with a description of
# what data is required from the requesting department. Seeded onto every new
# PerformanceRequest (see models.PerformanceChecklistItem and
# routers/qa_requests.py::_sync_linked_child_requests); all mandatory, and must
# all be complete before Readiness -> Feasibility (see
# routers/performance.py::complete_readiness).
DEFAULT_PERFORMANCE_CHECKLIST_ITEMS = [
    ("Application Architecture Diagram", "Architecture Diagram"),
    ("Transaction Flow", "Transaction Flow / Business Process Flow Document for Critical Transactions"),
    ("Dependency Matrix", "List of Dependent Applications, APIs, Databases & External Systems"),
    ("API / Interface Inventory (If Applicable)", "API List, API Specifications, Swagger/OpenAPI Document"),
    ("Expected Average TPS", "Average Transactions Per Second expected in Production"),
    ("Peak TPS", "Peak Transactions Per Second expected during Business Peak Hours"),
    ("Concurrent Users / Sessions", "Expected Peak Concurrent Users / Sessions"),
    ("Average & Max Message Size", "Average and Maximum Request/Response Payload Size (KB/MB)"),
    ("Server Configuration", "Application, Middleware and Database Server Details"),
    ("JVM/Application Parameters (If Applicable)", "Heap Size, Thread Pool, JVM & GC Parameters"),
    ("Database Configuration", "Database Version, Sizing, Connection Pool Details"),
    ("API Timeout & Retry Settings", "Timeout Values and Retry Logic Configuration"),
    ("Performance SLA", "Response Time SLA, Throughput Targets, Availability Targets"),
    ("Maximum Acceptable System Load Defined (Threshold Values)",
     "Maximum TPS, Concurrent Users, Transaction Volume, System Capacity Limits"),
    ("Monitoring Dashboard Access", "Monitoring Tool URLs and Required Access Details"),
    ("Batch/Scheduler Details (If Applicable)", "Batch Jobs, Schedule Details, Expected Volumes"),
    ("Test Data Availability", "Test Users, Test Accounts, Test Data Sets"),
    ("Rollback Procedure", "Rollback Document and Recovery Steps"),
    ("Teardown Procedure", "Environment Cleanup / Reset Procedure"),
]

# ---- Module 6: Suppression ----
SEVERITIES = ["Critical", "High", "Medium", "Low", "Informational"]
# Requester raises (Draft) -> Submit to SM -> SM approves & assigns to
# Department Head -> Department Head approves -> Security Team verifies
# (Accept -> Done / Reject -> Rejected). A SAST/DAST request can only be
# marked "Report Ready" once every Suppression request raised against it is
# "Done" (see SAST_DAST_STATUSES docstring above).
SUPPRESSION_STATUSES = [
    "Draft",
    "SM_APPROVAL_PENDING", "RETURNED_BY_SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD",
    "SECURITY_TEAM_VERIFICATION", "RETURNED_BY_SECURITY_TEAM",
    "Done", "Rejected",
]
SUPPRESSION_STATUS_LABELS = {
    "Draft": "Draft",
    "SM_APPROVAL_PENDING": "SM Approval Pending",
    "RETURNED_BY_SM": "Returned by SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head Approval Pending",
    "RETURNED_BY_DEPARTMENT_HEAD": "Returned by Department Head",
    "SECURITY_TEAM_VERIFICATION": "Security Team Verification",
    "RETURNED_BY_SECURITY_TEAM": "Returned by Security Team",
    "Done": "Done",
    "Rejected": "Rejected",
}
# Terminal states for a suppression request.
SUPPRESSION_TERMINAL_STATUSES = ["Done", "Rejected"]

# ---- Module 7: Approval workflow engine ----
APPROVAL_DECISIONS = ["Approved", "Rejected", "Returned"]

WORKFLOW_STEPS = {
    # The gateway QA Request itself has no approval workflow -- just intake
    # (Drafted) -> Submitted -> Raised, or Cancelled while still Draft.
    "QA_REQUEST": ["Requester (Drafted)", "Submitted", "Raised / Cancelled"],
    "FUNCTIONAL_REQUEST": [
        "Requester", "SM Approval", "Department Head Approval", "QA Lead Assignment", "Readiness Verification",
        "QA Activity (Planning/Tester Assignment/Design/Execution)", "Defect-Retest-Regression Cycle",
        "QA Sign-off", "Requester Verification",
    ],
    "TEST_CASE": ["Author", "Reviewer", "QA Lead"],
    "SAST_DAST": [
        "Requester", "SM Approval", "Department Head Approval", "Security Lead Assigned",
        "Security Readiness", "Planning", "Configuration", "Scanning", "Finding Validation",
        "Remediation (Requester)", "Security Complete", "Report Ready",
    ],
    "AUTOMATION": [
        "Requester", "SM Approval", "Department Head Approval", "Feasibility Assessment", "Planning",
        "Engineer Assignment", "Script Development", "Review", "Execution", "CI/CD Integration (optional)",
        "Sign-off", "Requester Verification",
    ],
    "PERFORMANCE": [
        "Requester", "SM Approval", "Department Head Approval", "Readiness", "Feasibility", "Planning",
        "Environment Setup", "Script Development", "Baseline", "Load Test Execution", "Result Analysis",
        "Defect/Fix/Retest", "Report", "Sign-off", "Requester Verification",
    ],
    "SUPPRESSION": ["Requester", "SM Approval", "Department Head Approval", "Security Team Verification"],
}

# ---- Module 8: QA Sign-off ----
CERTIFICATE_TYPES = ["Full Clearance", "Conditional Clearance", "Clearance Denied"]
SIGNOFF_TESTING_TYPES = ["Functional", "SAST", "DAST"]
RISK_TIERS = ["Tier 1 (Critical)", "Tier 2 (High)", "Tier 3 (Medium)", "Tier 4 (Low)"]

# ---- Module 11: Export ----
EXPORT_FORMATS = ["xlsx", "pdf", "csv"]
