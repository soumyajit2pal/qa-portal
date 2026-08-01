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
    Role.DEPARTMENT_HEAD_COE: "Executive COE (CM/AGM-QA)",
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
"Agriculture",
"Alternate Business Channel",
"Business Development"
"Cash Management",
"Chairman Secretariat",
"CISO",
"Compliance",
"CORPORATE CREDIT & INT FINANC",
"Corporate Services",
"Credit -Comm and Corp",
"Credit Monitoring",
"DATA CENTER",
"Digital Banking IT",
"Digital Business Zone",
"FI SLBC",
"FM & A",
"GOVERNMENT SCHEMES",
"HRM",
"IT - Software",
"IT - QA",
"Inspection and Audit",
"Integrated Risk Management",
"Legal Services",
"Marketing",
"MSME",
"NRI SERVICES",
"Operation Department",
"Planning & Development",
"PMO",
"Rajbhasha Vibhag",
"Recovery",
"Retail",
"Security",
"Strategic Data Management",
"STRATEGY",
"TIBD",
"Transaction Monitoring Department",
"Vigilance",
]

# Central department that owns the QA Sign-off Certificate workflow. Its
# linked testing request may belong to any business department, but the
# certificate itself is raised and approved entirely inside IT - QA.
QA_DEPARTMENT = "IT - QA"

# ---- Module 1: QA Request (gateway) / Functional Testing Request ----
REQUEST_TYPES = [
    "Functional Testing", "Sanity Testing", "Regression Testing", "UAT Support",
    "Performance Testing", "SAST", "DAST", "Others",
]

# The QA Request is a pure intake/gateway record (see models.QARequest / the
# GATEWAY_* constants below) -- it captures application/change details and
# request_types, then immediately raises whichever independent child
# request(s) apply, each with its own unique ID and its own workflow:
#   - Functional Testing / Sanity Testing / Regression Testing / UAT Support
#     (any of these types) -> one combined FunctionalRequest (see
#     models.FunctionalRequest, QAStatus below).
#   - SAST / DAST -> SASTRequest / DASTRequest.
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

    Can only be marked QA_COMPLETED once every SAST/DAST/Performance request
    linked to the *same gateway QA Request* (see
    FunctionalRequest.qa_request.linked_sast_requests/etc) is itself in a
    terminal state -- see SAST_DAST_TERMINAL_STATUSES/
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
# and PUT /api/functional-requests/{id}) can still be edited -- same
# pattern/values as SAST_DAST_EDITABLE_STATUSES/PERFORMANCE_EDITABLE_STATUSES
# below. Who specifically may edit at each of these statuses is further
# scoped by routers/functional.py::_can_edit_details -- being in this list
# only means "editable by *someone*", not "editable by the requester" (e.g.
# SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are only editable by
# that stage's own reviewer, not the requester -- see that helper's own
# docstring).
FUNCTIONAL_EDITABLE_STATUSES = [
    QAStatus.DRAFT,
    QAStatus.SM_APPROVAL_PENDING, QAStatus.RETURNED_BY_SM,
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD,
    QAStatus.RETURNED_BY_QA_LEAD,
]

# Readiness evidence is normally locked after Department Head approval. A
# RETURNED_BY_* status is the explicit exception: the request is back with
# the requester, who must be able to attach whatever evidence the returning
# QA/Security/Engineering stage asked them to provide.
READINESS_EVIDENCE_EDITABLE_STATUSES = [
    "DRAFT", "SM_APPROVAL_PENDING", "RETURNED_BY_SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD",
]


def is_readiness_evidence_editable(status) -> bool:
    value = status.value if hasattr(status, "value") else str(status or "")
    return (value in READINESS_EVIDENCE_EDITABLE_STATUSES
            or value.startswith("RETURNED_BY_"))

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
    QAStatus.QA_LEAD_ASSIGNED: "QA Readiness Verification Pending",
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
#
# Used to also include "SAST readiness"/"DAST readiness" as two conditionally-
# mandatory items (see the removed CONDITIONAL_CHECKLIST_ITEMS/
# checklist_item_is_mandatory()) whenever SAST/DAST were also selected on the
# same QA Request -- removed now that SAST and DAST each have their own
# dedicated "Security Readiness" checklist (DEFAULT_SAST_CHECKLIST_ITEMS/
# DEFAULT_DAST_CHECKLIST_ITEMS below), which is the correct place for that
# concern to live rather than a single unqualified checkbox sitting on
# Functional's own checklist. None of these items are mandatory (self-
# declared/QA-verified for visibility only, same convention as every other
# checklist in this app).
DEFAULT_CHECKLIST_ITEMS = [
    ("BRD / FRS / User Stories approved", "Business / BA",  True),
    ("Scope finalized & change freeze", "Business / IT", True),
    ("Test Environment availability (UAT / SIT)", "Business", True),
    ("Test data creation", "User dept / Dev team", False),
    ("Assess Test Scenarios", "User Dept", False),
    ("Project walkthrough to QA", "User Dept / Dev team", False),
    ("Application builds deployed & validated", "Dev team / Business", False),
    ("Security access (VPN Proxy/URLs whitelisting/credentials/firewall)", "User dept", False),
]

PRIORITIES = ["Critical", "High", "Medium", "Low"]
RISK_RATINGS = ["Critical", "High", "Medium", "Low"]
ENVIRONMENTS = ["Dev", "SIT", "UAT", "Pre-Production", "Production"]

# Deployment Environment / Target Promotion Environment (see DetailsStep.tsx
# and Functional.tsx's Edit Details modal, the only two places these are
# editable) must move strictly forward along this pipeline -- reported
# directly: e.g. picking "UAT" as the Deployment Environment must force the
# Target Promotion Environment to be "Pre-Production" or "Production", never
# "SIT"/"UAT" again or anything earlier. "Dev" is deliberately excluded here
# (neither field's own dropdown ever offers it -- both already filter it out
# client-side), so it's not part of this ordering at all.
ENVIRONMENT_PIPELINE_ORDER = ["SIT", "UAT", "Pre-Production", "Production"]


def validate_environment_promotion(environment: str, target_promotion_environment: str) -> None:
    """Raises ValueError if `target_promotion_environment` is not strictly
    later than `environment` in ENVIRONMENT_PIPELINE_ORDER. Callers (see
    routers/qa_requests.py::create_request/edit_request and
    routers/functional.py::update_functional -- the only 3 write paths for
    these two fields) are expected to catch ValueError and re-raise as a 400
    HTTPException; kept framework-agnostic here so it isn't tied to FastAPI.
    Silently passes if either value isn't a recognised pipeline stage (e.g.
    blank/None on a still-in-progress Draft) -- this is a business-rule
    ordering check, not a substitute for "is this a valid environment name"
    validation."""
    if environment not in ENVIRONMENT_PIPELINE_ORDER or target_promotion_environment not in ENVIRONMENT_PIPELINE_ORDER:
        return
    if ENVIRONMENT_PIPELINE_ORDER.index(target_promotion_environment) <= ENVIRONMENT_PIPELINE_ORDER.index(environment):
        raise ValueError(
            f"Target Promotion Environment ('{target_promotion_environment}') must be later than "
            f"Deployment Environment ('{environment}') in the pipeline "
            f"{' -> '.join(ENVIRONMENT_PIPELINE_ORDER)}."
        )

# ---- Module 4/5: SAST / DAST ----
# Independent lifecycle (identical for SAST and DAST), rebuilt with the fuller
# named stages requested:
#
#   Draft -> Submit -> SM Approval -> Department Head Approval -> Security
#   Readiness Verification Pending (available to the central Security/QA pool) ->
#   Security Readiness -> Planning -> Configuration (scan
#   setup -- "SAST Configuration"/"DAST Configuration" depending on scan type)
#   -> Scanning -> Complete Scan, gated on a confirmation pop-up ("Are you
#   sure no security findings were identified during the scan?"):
#     - Yes (clean scan) -> Security Complete -> Report Ready -> Closed, all
#       chained automatically in one step.
#     - No (findings identified) -> Finding Validation -> Remediation, which
#       itself cycles: Assigned To Requester -> Waiting For Fix -> Assigned
#       To Lead -> Rescan -> the same confirmation pop-up again -> either the
#       clean-scan chain above (Security Complete -> Report Ready -> Closed)
#       or back to Finding Validation to repeat remediation/rescan.
#
# Reaching Security Complete itself (from Finding Validation, a clean
# Complete Scan, or a Passed Rescan Decision) and the subsequent Security
# Complete -> Report Ready step both additionally check whether any
# Suppression request was raised against this SAST/DAST id -- if so, ALL such
# suppression requests must be "Done" before either is allowed (see
# routers/sast_dast.py::_require_no_pending_suppressions and
# SUPPRESSION_STATUSES below).
SAST_DAST_STATUSES = [
    "DRAFT", "SUBMITTED",
    "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD", "DEPARTMENT_HEAD_REJECTED",
    "SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS", "RETURNED_BY_SECURITY_LEAD",
    "PLANNING", "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION",
    "ASSIGNED_TO_REQUESTER", "WAITING_FOR_FIX", "ASSIGNED_TO_LEAD", "RESCAN",
    "SECURITY_COMPLETE", "REPORT_READY", "CLOSED",
]
# Reported directly: a Suppression / False Positive request's SAST/DAST
# Request ID picker should only offer (and its create/update endpoints
# should only accept) a SAST/DAST request that has actually reached
# Scanning or later -- a suppression is a decision about a *finding*, and
# there's nothing to suppress yet while the request is still sitting
# somewhere before a scan has even started (Draft through Scan
# Configuration). Everything from "SCANNING" onward in SAST_DAST_STATUSES
# above is eligible; this lists the everything-before-that set explicitly
# (rather than slicing the list by index) so it stays correct even if
# SAST_DAST_STATUSES is ever reordered.
SAST_DAST_PRE_SCANNING_STATUSES = [
    "DRAFT", "SUBMITTED",
    "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD", "DEPARTMENT_HEAD_REJECTED",
    "SECURITY_LEAD_ASSIGNED", "SECURITY_READINESS", "RETURNED_BY_SECURITY_LEAD",
    "PLANNING", "CONFIGURATION",
]
# The other end of the window: once a SAST/DAST request has been declared
# Security Complete (no more open findings -- see routers/sast_dast.py's
# suppression gate on reaching that status), it's considered finalized, so a
# NEW suppression can no longer be raised against it either -- pairs with
# SAST_DAST_PRE_SCANNING_STATUSES above to define the eligible window as
# "Scanning through the stage right before Security Complete". Report Ready
# and Closed are both strictly later than Security Complete in
# SAST_DAST_STATUSES, so they're included here too.
SAST_DAST_COMPLETED_STATUSES = ["SECURITY_COMPLETE", "REPORT_READY", "CLOSED"]
# Terminal states -- a linked SAST/DAST request must be in one of these before
# its parent QA Request can be marked QA_COMPLETED (see QAStatus docstring
# above and routers/qa_requests.py::complete_qa). Rejections at either
# approval checkpoint count as "resolved" for this purpose too.
SAST_DAST_TERMINAL_STATUSES = ["REPORT_READY", "CLOSED", "SM_REJECTED", "DEPARTMENT_HEAD_REJECTED"]
# Statuses from which mandatory details (repo URL/branch/commit/tech stack
# for SAST; target URL/env/credentials for DAST) can still be edited by
# *someone* -- see routers/sast_dast.py::_can_edit_details for exactly who,
# at each of these (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are
# that stage's own reviewer only, not the requester).
SAST_DAST_EDITABLE_STATUSES = [
    "DRAFT", "SM_APPROVAL_PENDING", "RETURNED_BY_SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_SECURITY_LEAD",
]

SAST_DAST_STATUS_LABELS = {
    "DRAFT": "Draft",
    "SUBMITTED": "Submitted",
    "SM_APPROVAL_PENDING": "SM Approval Pending",
    "RETURNED_BY_SM": "Returned by SM",
    "SM_REJECTED": "Rejected by SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head Approval Pending",
    "RETURNED_BY_DEPARTMENT_HEAD": "Returned by Department Head",
    "DEPARTMENT_HEAD_REJECTED": "Department Head Rejected",
    "SECURITY_LEAD_ASSIGNED": "Security Readiness Verification Pending",
    "SECURITY_READINESS": "Security Readiness",
    "RETURNED_BY_SECURITY_LEAD": "Returned by QA Lead",
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

# SAST's own "Security Readiness" pre-scan checklist -- distinct from
# DEFAULT_CHECKLIST_ITEMS (Functional Testing's), DAST's own
# DEFAULT_DAST_CHECKLIST_ITEMS below, and DEFAULT_PERFORMANCE_CHECKLIST_ITEMS.
# Seeded onto every auto-created SASTRequest (see models.SASTChecklistItem
# and routers/qa_requests.py::_sync_linked_child_requests). Same tuple shape
# as DEFAULT_PERFORMANCE_CHECKLIST_ITEMS (item, owner, is_mandatory).
#
# Unlike every other checklist in this app, a mandatory item here is a hard
# gate at SUBMISSION time, not just at the readiness-verification step: the
# requester cannot even Submit for SM Approval while a mandatory item's own
# requester_checked is still false (see routers/sast_dast.py::
# _require_checklist_ready, called from _submit/_resubmit) -- these are
# prerequisites (repo access, etc.) the requester needs lined up themselves
# before a scan is worth scheduling at all, so it's checked at submission
# rather than waiting until Security Readiness. Non-mandatory items are still
# self-declared/QA-or-Security-verified for visibility only, same as elsewhere.
DEFAULT_SAST_CHECKLIST_ITEMS = [
    ("Application/source code repository access provided to the scan team", "Dev team", True),
    ("Change freeze / business hours confirmed for the scan window", "Business / User dept", False),
    ("Point of contact identified for application/code-level queries during the scan", "User dept / Dev team", False),
]

# DAST's own "Security Readiness" pre-scan checklist -- see the comment on
# DEFAULT_SAST_CHECKLIST_ITEMS above for the full reasoning (same
# submission-time mandatory-item gate applies here too).
DEFAULT_DAST_CHECKLIST_ITEMS = [
    ("Test environment / application URL accessible and stable", "User dept / Dev team", True),
    ("Test accounts and role-based credentials provided", "User dept", True),
    ("Firewall / VPN / IP whitelisting completed for scan tool access", "User dept / IT", True),
    ("Change freeze / business hours confirmed for the scan window", "Business / User dept", False),
    ("Backup taken / rollback plan confirmed before scanning starts", "Dev team", False),
    ("Third-party services, OTP, CAPTCHA and payment dependencies identified with test-mode or bypass mechanisms",
     "Business / Dev team", False),
    ("Point of contact identified for application/code-level queries during the scan", "User dept / Dev team", False),
]

# ---- Module 4c: Performance Testing ----
# Auto-created from a QA Request when "Performance Testing" is one of its
# request types, same pattern as SAST/DAST. Independent lifecycle
# after the common Draft/SM/Department Head prefix: readiness pending (the
# Department Head assigns an IT-QA QA Lead) -> Readiness -> Feasibility ->
# Planning (the QA Lead assigns IT-QA QA Testers) -> Environment Setup -> Script
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
# See routers/performance.py::_can_edit_details for exactly who may edit at
# each of these (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are
# that stage's own reviewer only, not the requester).
PERFORMANCE_EDITABLE_STATUSES = [
    "DRAFT", "SM_APPROVAL_PENDING", "RETURNED_BY_SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD", "RETURNED_BY_ENGINEER",
]
PERFORMANCE_STATUS_LABELS = {
    "DRAFT": "Draft", "SUBMITTED": "Submitted",
    "SM_APPROVAL_PENDING": "SM Approval Pending", "RETURNED_BY_SM": "Returned by SM",
    "SM_REJECTED": "Rejected by SM",
    "DEPARTMENT_HEAD_APPROVAL_PENDING": "Department Head Approval Pending",
    "RETURNED_BY_DEPARTMENT_HEAD": "Returned by Department Head",
    "DEPARTMENT_HEAD_REJECTED": "Department Head Rejected",
    "ENGINEER_ASSIGNED": "Readiness Verification Pending", "RETURNED_BY_ENGINEER": "Returned by QA Lead",
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
# routers/qa_requests.py::_sync_linked_child_requests). None of these items
# are mandatory (self-declared/QA-verified for visibility only, like
# Functional's checklist) -- an unticked item no longer
# blocks Readiness -> Feasibility (see routers/performance.py::
# readiness_decision).
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

# ---- Application Name Master (see models.ApplicationMaster) ----
# A brand-new name introduced via the QA Request wizard's "Other" option
# starts PENDING; an SM from the same department either APPROVEs it (making
# it a selectable option in the dropdown for everyone going forward) or
# REJECTs it. Independent of the QA Request's own workflow -- this never
# gates Submit/Raise (see routers/qa_requests.py::_resolve_application_name).
APPLICATION_MASTER_STATUSES = ["PENDING", "APPROVED", "REJECTED"]
APPLICATION_MASTER_STATUS_LABELS = {
    "PENDING": "Pending Approval",
    "APPROVED": "Approved",
    "REJECTED": "Rejected",
}

# ---- Module 7: Approval workflow engine ----
APPROVAL_DECISIONS = ["Approved", "Rejected", "Returned"]

WORKFLOW_STEPS = {
    # The gateway QA Request itself has no approval workflow -- just intake
    # (Drafted) -> Submitted -> Raised, or Cancelled while still Draft.
    "QA_REQUEST": ["Requester (Drafted)", "Submitted", "Raised / Cancelled"],
    "FUNCTIONAL_REQUEST": [
        "Requester", "SM Approval", "Department Head Approval", "QA Readiness Verification Pending", "Readiness Verification",
        "QA Activity (Planning/Tester Assignment/Design/Execution)", "Defect-Retest-Regression Cycle",
        "QA Sign-off", "Requester Verification",
    ],
    "TEST_CASE": ["Author", "Reviewer", "QA Lead"],
    "SAST_DAST": [
        "Requester", "SM Approval", "Department Head Approval", "Security Readiness Verification Pending",
        "Security Readiness", "Planning", "Configuration", "Scanning", "Finding Validation",
        "Remediation (Requester)", "Security Complete", "Report Ready",
    ],
    "PERFORMANCE": [
        "Requester", "SM Approval", "Department Head Approval", "Readiness Verification Pending", "Readiness", "Feasibility", "Planning",
        "Environment Setup", "Script Development", "Baseline", "Load Test Execution", "Result Analysis",
        "Defect/Fix/Retest", "Report", "Sign-off", "Requester Verification",
    ],
    "SUPPRESSION": ["Requester", "SM Approval", "Department Head Approval", "Security Team Verification"],
}

# ---- Module 8: QA Sign-off ----
CERTIFICATE_TYPES = ["Full Clearance", "Conditional Clearance", "Clearance Denied"]
SIGNOFF_TESTING_TYPES = ["Functional", "SAST", "DAST"]
RISK_TIERS = ["Tier 1 (Critical)", "Tier 2 (High)", "Tier 3 (Medium)", "Tier 4 (Low)"]

# QASignOff's own approval chain -- QA Engineer raises the certificate, a QA
# Lead approves it, then Executive COE gives the final approval that
# issues it. Replaces the old, much simpler Draft/Issued-only flow (a QA Lead
# alone could draft and immediately sign/issue) -- existing rows sitting at
# the old "Draft"/"Issued" string values need a one-time data migration, see
# ORACLE_MIGRATION_2026-07.md.
SIGNOFF_STATUSES = [
    "DRAFT", "SUBMITTED", "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPT_HEAD_COE_APPROVAL_PENDING", "RETURNED_BY_DEPT_HEAD_COE", "DEPT_HEAD_COE_REJECTED",
    "ISSUED",
]
SIGNOFF_TERMINAL_STATUSES = ["ISSUED", "SM_REJECTED", "DEPT_HEAD_COE_REJECTED"]
# QA requester's own editable statuses (Draft, or returned back to them for
# changes). QA Lead additionally gets an edit window while a certificate is
# freshly SM_APPROVAL_PENDING (legacy internal code; QA Lead review) -- see
# routers/signoff.py::update_signoff, not folded into this list since it's a
# different actor/condition, not a third "requester-editable" status.
SIGNOFF_EDITABLE_STATUSES = ["DRAFT", "RETURNED_BY_SM", "RETURNED_BY_DEPT_HEAD_COE"]
SIGNOFF_STATUS_LABELS = {
    "DRAFT": "Draft",
    "SUBMITTED": "Submitted",
    "SM_APPROVAL_PENDING": "QA Lead Approval Pending",
    "RETURNED_BY_SM": "Returned by QA Lead",
    "SM_REJECTED": "Rejected by QA Lead",
    "DEPT_HEAD_COE_APPROVAL_PENDING": "Executive COE Approval Pending",
    "RETURNED_BY_DEPT_HEAD_COE": "Returned by Executive COE",
    "DEPT_HEAD_COE_REJECTED": "Rejected by Executive COE",
    "ISSUED": "Issued",
}

# ---- Module 10: Test Management (Project Management / Test Repository / Test Execution) ----
# A Zephyr-style test case management layer -- see the header comment on
# models.TestProject for the full rationale. Test Type/Priority/execution
# Status values below match the attached xlsx upload template exactly
# (routers/test_repository.py's import parser reads these same strings).
TEST_CASE_TYPES = [
    "Functional Positive", "Functional Negative", "Regression", "Sanity",
    "Integration", "Security", "Performance", "UAT", "Other",
]
# Test case's own lifecycle state -- distinct from any execution result
# (see models.TestCase.status docstring).
TEST_CASE_STATUSES = ["Active", "Draft", "Deprecated"]
# Reuses the same Critical/High/Medium/Low vocabulary as PRIORITIES above
# (kept as its own alias rather than importing PRIORITIES directly at every
# call site, so this module's own statuses/labels read as a self-contained
# block -- same convention SEVERITIES already follows for SAST/DAST).
TEST_CASE_PRIORITIES = PRIORITIES

TEST_CYCLE_STATUSES = ["Not Started", "In Progress", "Completed"]

# Exact wording from the xlsx template's "Status (Pass/Fail/Blocked/NA/Retest
# Passed)" column, plus "Not Executed" as this app's own default for a test
# case that's been added to a cycle but not yet run (the template has no
# equivalent since every row it ever contains was already executed).
TEST_EXECUTION_STATUSES = ["Not Executed", "Pass", "Fail", "Blocked", "NA", "Retest Passed"]
# Terminal in the sense of "this run is done, no further action expected" --
# used to decide whether a test case still counts as pending within a cycle.
TEST_EXECUTION_TERMINAL_STATUSES = ["Pass", "Fail", "NA", "Retest Passed"]

# ---- Module 11: Export ----
EXPORT_FORMATS = ["xlsx", "pdf", "csv"]
