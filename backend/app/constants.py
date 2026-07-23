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

ALL_ROLES = [
    Role.REQUESTER, Role.BUSINESS_ANALYST, Role.QA_ENGINEER, Role.QA_LEAD,
    Role.DEPARTMENT_HEAD_COE, Role.SECURITY_ANALYST, Role.APPLICATION_OWNER,
    Role.DEPARTMENT_HEAD, Role.ADMIN,
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
    Role.ADMIN: "Administrator",
}

# ---- Departments (Admin section: user mapping = department + role(s)) ----
# Fixed list in code (searchable dropdown on the frontend). Add/remove entries
# here and redeploy if the bank's department list changes.
DEPARTMENTS = [
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

# ---- Module 1: QA Request ----
REQUEST_TYPES = [
    "Functional Testing", "Sanity Testing", "Regression Testing", "UAT Support",
    "Performance Testing", "SAST", "DAST", "Automation Testing", "Others",
]

class QAStatus:
    """The QA Request lifecycle: Requester -> Department Head approval (also
    assigns the QA Lead) -> QA Lead readiness verification -> QA activity
    (planning/tester assignment/test design/execution, with a
    defect-fix-retest-regression cycle) -> QA sign-off -> Requester
    verification -> Closed."""
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
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
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.DEPARTMENT_HEAD_REJECTED,
    QAStatus.QA_LEAD_ASSIGNED,
    QAStatus.READINESS_VERIFICATION, QAStatus.RETURNED_BY_QA_LEAD, QAStatus.QA_ACTIVITY_INITIATED,
    QAStatus.PLANNING, QAStatus.TESTER_ASSIGNED, QAStatus.TEST_DESIGN, QAStatus.EXECUTION_IN_PROGRESS,
    QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX, QAStatus.RETESTING, QAStatus.REGRESSION_TESTING,
    QAStatus.QA_COMPLETED, QAStatus.QA_SIGNOFF_PENDING, QAStatus.QA_SIGNED_OFF,
    QAStatus.REQUESTER_VERIFICATION, QAStatus.CLOSED, QAStatus.CANCELLED,
]

# Statuses from which the request can still be edited by the requester.
QA_REQUEST_EDITABLE_STATUSES = [
    QAStatus.DRAFT, QAStatus.RETURNED_BY_DEPARTMENT_HEAD, QAStatus.RETURNED_BY_QA_LEAD,
]

# Terminal statuses -- no further transitions possible.
QA_REQUEST_TERMINAL_STATUSES = [
    QAStatus.CLOSED, QAStatus.CANCELLED, QAStatus.DEPARTMENT_HEAD_REJECTED,
]

# Statuses from which the requester (or admin) may still cancel the request --
# once the Department Head approves and a QA Lead is assigned (QA_LEAD_ASSIGNED
# onwards, including a later RETURNED_BY_QA_LEAD loop back), the request is
# already committed to QA and cancellation is no longer offered.
QA_REQUEST_CANCELLABLE_STATUSES = [
    QAStatus.DRAFT, QAStatus.SUBMITTED,
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD,
]

# Human-readable labels for the frontend status filter / badges.
QA_REQUEST_STATUS_LABELS = {
    QAStatus.DRAFT: "Draft",
    QAStatus.SUBMITTED: "Submitted",
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

# ---- Module 2: Test Case ----
TEST_TYPES = ["Functional", "Sanity", "Regression", "UAT", "Performance", "Automation", "Security"]
TEST_CASE_STATUSES = ["Draft", "Under Review", "Approved", "Deprecated"]

# ---- Module 3: Test Execution ----
RUN_TYPES = ["Release-wise", "Sprint-wise", "Regression"]
EXECUTION_STATUSES = ["Not Started", "In Progress", "Passed", "Failed", "Blocked", "Retest Passed", "NA"]

# ---- Module 4/5: SAST / DAST ----
SAST_DAST_STATUSES = ["Requested", "Lead Approved", "Allocated", "Scanning", "Report Ready", "Closed"]

# ---- Module 6: Suppression ----
SEVERITIES = ["Critical", "High", "Medium", "Low", "Informational"]
SUPPRESSION_STATUSES = [
    "Pending Application Owner", "Pending Department Head", "Approved", "Rejected",
]

# ---- Module 7: Approval workflow engine ----
APPROVAL_DECISIONS = ["Approved", "Rejected", "Returned"]

WORKFLOW_STEPS = {
    "QA_REQUEST": [
        "Requester", "Department Head Approval", "QA Lead Assignment", "Readiness Verification",
        "QA Activity (Planning/Tester Assignment/Design/Execution)", "Defect-Retest-Regression Cycle",
        "QA Sign-off", "Requester Verification",
    ],
    "TEST_CASE": ["Author", "Reviewer", "QA Lead"],
    "SAST_DAST": ["Requester", "Security Team", "Approver"],
    "SUPPRESSION": ["Application Owner", "Business Head", "Security Approver"],
}

# ---- Module 8: QA Sign-off ----
CERTIFICATE_TYPES = ["Full Clearance", "Conditional Clearance", "Clearance Denied"]
SIGNOFF_TESTING_TYPES = ["Functional", "SAST", "DAST"]
RISK_TIERS = ["Tier 1 (Critical)", "Tier 2 (High)", "Tier 3 (Medium)", "Tier 4 (Low)"]

# ---- Module 11: Export ----
EXPORT_FORMATS = ["xlsx", "pdf", "csv"]
