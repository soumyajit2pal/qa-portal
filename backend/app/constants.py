"""Shared enumerations / constant lists used across models, schemas and routers."""

import datetime
from zoneinfo import ZoneInfo

# ---- Roles (Section: User Roles table in the CR document) ----
class Role:
    REQUESTER = "REQUESTER"                    # Requester (Developer) - Raise Requests
    BUSINESS_ANALYST = "BUSINESS_ANALYST"       # Upload Finalised CR / User Stories
    QA_ENGINEER = "QA_ENGINEER"                 # Execute Testing
    QA_LEAD = "QA_LEAD"                         # Review & approve
    # 2026-08: consolidated with the former CHEIF_MANAGER_COE/AGM_COE roles
    # (reported directly -- "no ther pair is required, creating lots of
    # confusion"). Those two are retired; every place that used to check for
    # them now checks CHIEF_MANAGER_QA/AGM_QA instead -- see the
    # role-consolidation data-fix script (backend/scripts/) for the one-time
    # migration of existing UserRole rows. Also corrects the "CHEIF" ->
    # "CHIEF" spelling that was baked into the constant's own value, not just
    # its label.
    CHIEF_MANAGER_QA = "CHIEF_MANAGER_QA"       # QA executive management role (formerly CHEIF_MANAGER_QA / CHEIF_MANAGER_COE)
    AGM_QA = "AGM_QA"                           # QA executive management role (formerly also covered AGM_COE)
    SECURITY_ANALYST = "SECURITY_ANALYST"       # SAST/DAST Management
    APPLICATION_OWNER = "APPLICATION_OWNER"     # Approval Authority
    DEPARTMENT_HEAD_CM = "DEPARTMENT_HEAD_CM"   # QA Request + Suppression Approval (business dept head, CM)
    DEPARTMENT_HEAD_AGM = "DEPARTMENT_HEAD_AGM"  # QA Request + Suppression Approval (business dept head, AGM)
    ADMIN = "ADMIN"                             # Configuration & Access
    SM = "SM"
    SCALE_6_PLUS = "SCALE_6_PLUS"

ALL_ROLES = [
    Role.REQUESTER, Role.BUSINESS_ANALYST, Role.QA_ENGINEER, Role.QA_LEAD,
    Role.CHIEF_MANAGER_QA, Role.AGM_QA, Role.SECURITY_ANALYST,
    Role.APPLICATION_OWNER, Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM, Role.SM, Role.ADMIN,
    Role.SCALE_6_PLUS,
]

CONFIDENTIAL_ROLES = {Role.SCALE_6_PLUS}
DEPARTMENT_ADMIN_ASSIGNABLE_ROLES = [
    Role.REQUESTER, Role.BUSINESS_ANALYST, Role.APPLICATION_OWNER, Role.SM,
]
QA_ADMIN_ASSIGNABLE_ROLES = [
    Role.QA_ENGINEER, Role.QA_LEAD, Role.SECURITY_ANALYST,
]

# 2026-08 -- reported directly: "other than QA team, for others there
# should not be any option to open any defects" -- then corrected, same day:
# "defect can be raised by requster, business analyst application owner too
# so defect management tool should be available for them as well." This
# constant (originally named QA_TEAM_ROLES, QA-only) is now every role with
# a legitimate reason to be in the Defect Management module at all: QA team
# proper (QA_ENGINEER/QA_LEAD plus the Executive bypass CHIEF_MANAGER_QA/
# AGM_QA, and SECURITY_ANALYST for defects arising from SAST/DAST work) PLUS
# every role defects.py's own CREATE_ROLES already lets report/link a
# defect (REQUESTER, BUSINESS_ANALYST, APPLICATION_OWNER -- CREATE_ROLES
# itself doesn't separately list AGM_QA, but it's added here for the same
# Executive-bypass reason CHIEF_MANAGER_QA is). Excludes only roles with no
# stake in defects at all: SM, Department Head (CM/AGM), SCALE_6_PLUS. This
# briefly gated the Defect Management *register* (list/dashboard/export in
# routers/defects.py), the batch Fail/Blocked-executions picker
# (routers/test_execution.py), and the frontend nav/page (constants.ts's own
# mirror) -- then, further reported directly: "currently Defect management
# is not available to everyone. make this visible to everyone based on
# department filter." That role gate is now retired everywhere it applied;
# browsing the register is open to any authenticated user, scoped purely by
# department (defects.py's own _scoped_defects), same as every other
# module's list endpoint. Kept defined (unreferenced) purely as a record of
# the role set that combination briefly meant, not for any active check --
# CREATE_ROLES (who may actually report/link a defect) is unaffected by any
# of this and still enforced separately.
DEFECT_MANAGEMENT_ROLES = [
    Role.QA_ENGINEER, Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA,
    Role.SECURITY_ANALYST, Role.REQUESTER, Role.BUSINESS_ANALYST,
    Role.APPLICATION_OWNER,
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
    Role.CHIEF_MANAGER_QA: "Chief Manager - QA",
    Role.AGM_QA: "Assistant General Manager - QA",
    Role.SECURITY_ANALYST: "Security Analyst (QA)",
    Role.APPLICATION_OWNER: "Application Owner",
    Role.DEPARTMENT_HEAD_CM: "Chief Manager - Department",
    Role.DEPARTMENT_HEAD_AGM: "Assistant General Manager - Department",
    Role.SM: "SM",
    Role.ADMIN: "Administrator",
    Role.SCALE_6_PLUS: "Scale 6+",
}

# ---- Departments (Admin section: user mapping = department + role(s)) ----
# NOTE: departments are now DB-backed (see models.Department / routers/departments.py)
# instead of this hardcoded list, so an admin can add/deactivate departments at
# runtime without a redeploy. This constant is kept ONLY as the one-time seed
# list consumed by seed.py on first run -- nothing else should import it.
SEED_DEPARTMENTS = [
"IT - Software",
"COE - Quality Assurance",
"CBS PMO - Core Banking",
"CBS PMO - Deposit",
"CBS PMO - Loan",
"CBS PMO - Exim",
"CBS PMO - Remittance",
"CBS PMO - API Interface",
"CBS PMO - IBU (International Banking Unit)",
]

# Central department that owns the QA Clearance Certificate workflow. Its
# linked testing request may belong to any business department, but the
# certificate itself is raised and approved entirely inside COE - Quality Assurance.
QA_DEPARTMENT = "COE - Quality Assurance"

# Reported directly: "everywhere in test management whenever asking for
# users/members just show only users from COE - Quality Assurance, and make as list, so that in
# future if I want to add any other team like TCS-QA along with COE - Quality Assurance that
# can work, rather than long code change" -- single source of truth for
# which department(s) are eligible to appear in every Test Management user
# picker (Project owner/members, default Reviewer/QA Lead, per-item
# Reviewer/QA Lead reassignment, Cycle owner) and to pass the runner /
# assignment-manager department checks in routers/test_execution.py
# (_runner_or_404, _require_qa_assignment_manager). Everything that used to
# hardcode `== QA_DEPARTMENT` / `!= QA_DEPARTMENT` for Test Management now
# reads this list instead -- bringing on another team (e.g. a "TCS-QA"
# vendor team) later is a one-line append here, not a hunt through every
# individual check. Starts as just the one department, same effective
# behavior as before this change.
TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS = [QA_DEPARTMENT]

# ---- Module 1: QA Request (gateway) / Functional Testing Request ----
REQUEST_TYPES = [
    "Functional Testing", "Sanity Testing", "Regression Testing", "UAT Support",
    "Performance Testing", "SAST", "DAST",
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
    tester assignment/test design/execution, with a defect-fix-retest
    cycle) -> QA Clearance -> Requester verification -> Closed.

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
    QAStatus.DEFECT_RAISED, QAStatus.WAITING_FOR_FIX, QAStatus.RETESTING,
    QAStatus.QA_COMPLETED, QAStatus.QA_SIGNOFF_PENDING, QAStatus.QA_SIGNED_OFF,
    QAStatus.REQUESTER_VERIFICATION, QAStatus.CLOSED, QAStatus.CANCELLED,
]

# 2026-08 -- reported directly: "once assigned there are no other option to
# reassign the tester or modify the tester." routers/functional.py::
# assign_tester originally only accepted status PLANNING (the very first
# assignment) -- every status after that permanently locked in whoever was
# picked, with no way for the QA Lead to swap testers mid-flight or for an
# overloaded tester to hand their own assignment off to a colleague. Every
# status where a tester assignment is still "live" -- the original PLANNING
# assignment through the defect-fix-retest cycle, right up to QA_COMPLETED
# (after which QA work is done and Sign-off takes over) -- is fair game for
# reassignment now. See assign_tester's own comment for the permission side
# (QA Lead group, OR any currently-assigned tester, may call it).
TESTER_REASSIGNABLE_STATUSES = [
    QAStatus.PLANNING, QAStatus.TESTER_ASSIGNED, QAStatus.TEST_DESIGN,
    QAStatus.EXECUTION_IN_PROGRESS, QAStatus.DEFECT_RAISED,
    QAStatus.WAITING_FOR_FIX, QAStatus.RETESTING,
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
    # SM_REJECTED: reported directly -- a Rejected-by-SM request used to be a
    # dead end. It's now reopenable the same way a Return is: the requester
    # may edit details, then call resubmit_request to send it straight back
    # to SM_APPROVAL_PENDING for a fresh decision. See resubmit_request's own
    # docstring in routers/functional.py.
    QAStatus.SM_REJECTED,
    QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING, QAStatus.RETURNED_BY_DEPARTMENT_HEAD,
    QAStatus.RETURNED_BY_QA_LEAD,
]

# Readiness evidence is normally locked after Department Head approval. A
# RETURNED_BY_* status is the explicit exception: the request is back with
# the requester, who must be able to attach whatever evidence the returning
# QA/Security/Engineering stage asked them to provide. SM_REJECTED is the
# same exception now that it's reopenable (see FUNCTIONAL_EDITABLE_STATUSES
# above) -- the requester may need to fix up evidence before reopening too.
READINESS_EVIDENCE_EDITABLE_STATUSES = [
    "DRAFT", "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPARTMENT_HEAD_APPROVAL_PENDING", "RETURNED_BY_DEPARTMENT_HEAD",
]


def is_readiness_evidence_editable(status) -> bool:
    value = status.value if hasattr(status, "value") else str(status or "")
    return (value in READINESS_EVIDENCE_EDITABLE_STATUSES
            or value.startswith("RETURNED_BY_"))

# Terminal statuses -- no further transitions possible. SM_REJECTED is
# deliberately NOT here -- reported directly, it's reopenable by the
# requester (edit details + resubmit, same path as RETURNED_BY_SM) rather
# than a dead end. DEPARTMENT_HEAD_REJECTED is untouched/still terminal --
# only SM rejection was asked to become reopenable.
QA_REQUEST_TERMINAL_STATUSES = [
    QAStatus.CLOSED, QAStatus.CANCELLED, QAStatus.DEPARTMENT_HEAD_REJECTED,
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
    QAStatus.QA_COMPLETED: "QA Completed",
    QAStatus.QA_SIGNOFF_PENDING: "QA Clearance Pending",
    QAStatus.QA_SIGNED_OFF: "QA Cleared",
    QAStatus.REQUESTER_VERIFICATION: "Requester Verification",
    QAStatus.CLOSED: "Closed",
    QAStatus.CANCELLED: "Cancelled",
}

DEFAULT_CHECKLIST_ITEMS = [
    ("EPIC / Feature / User Stories approved", "Business / BA",  True),
    ("Scope finalized & change freeze", "Business / IT", True),
    ("Test Environment availability (UAT / SIT)", "Business", True),
    ("Test data creation", "User dept / Dev team", False),
    ("Assess Test Scenarios", "User Dept", False),
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

# DAST scans and Performance tests are restricted to UAT and Pre-Production;
# Production is intentionally unavailable alongside Dev and SIT. Used by the
# DastStep.tsx/PerformanceStep.tsx pickers and enforced again server-side in
# routers/qa_requests.py::submit_request as a defense-in-depth check before
# either child request is ever created.
POST_SIT_ENVIRONMENTS = ["UAT", "Pre-Production"]


def validate_environment_promotion(environment: str, target_promotion_environment: str) -> None:
    """Raises ValueError if `target_promotion_environment` is not strictly
    later than `environment` in ENVIRONMENT_PIPELINE_ORDER. Callers (see
    routers/qa_requests.py::create_request/edit_request,
    routers/functional.py::update_functional, and -- 2026-08, reported
    directly ("Environment Tested / Target Promotion Environment should be
    linked like qa request form have") -- routers/signoff.py::
    create_signoff/update_signoff, reusing this same helper rather than a
    duplicate one) are expected to catch ValueError and re-raise as a 400
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


def validate_target_release_date(target_release_date) -> None:
    """Raises ValueError if `target_release_date` is in the past. The wizard
    (QARequests/steps/DetailsStep.tsx) already sets a `min` of today on its
    own date input, but that's an HTML attribute only -- easily bypassed by a
    direct API call, and Functional.tsx's own Edit Details modal (the only
    other place this field can be changed, once the QA Request gateway itself
    has left Draft) never had a `min` at all. Enforced here instead so every
    write path is covered the same way validate_environment_promotion covers
    Deployment/Target Promotion Environment. Callers (see
    routers/qa_requests.py::create_request/edit_request and
    routers/functional.py::update_functional -- the only 3 write paths for
    this field) are expected to catch ValueError and re-raise as a 400
    HTTPException. Silently passes on None (field left blank)."""
    if target_release_date is None:
        return
    if target_release_date < datetime.datetime.now(ZoneInfo("Asia/Kolkata")).date():
        raise ValueError(
            f"Target Release Date ('{target_release_date.isoformat()}') cannot be in the past."
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
# 2026-08 Reassignment CR, reported directly: "Everywhere the system
# provides an Assign option ... it must also provide a Reassign option."
# Previously Assign Security Analyst was single-shot, PLANNING-only --
# unlike Functional/Performance tester assignment, there was no way to
# change the analyst afterward at all. Mirrors TESTER_REASSIGNABLE_STATUSES/
# PERFORMANCE_TESTER_REASSIGNABLE_STATUSES' own window: the original
# PLANNING assignment through the last status where scan work is still
# "live" (SECURITY_COMPLETE) -- Report Ready/Closed are past the point
# where a different analyst taking over means anything.
SAST_DAST_ANALYST_REASSIGNABLE_STATUSES = [
    "PLANNING", "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION",
    "ASSIGNED_TO_REQUESTER", "WAITING_FOR_FIX", "ASSIGNED_TO_LEAD", "RESCAN",
    "SECURITY_COMPLETE",
]
# 2026-08 Reassignment CR, same rollout -- defects had NO way at all to
# change the assignee once assigned (routers/defects.py's TRANSITIONS only
# reaches "Assigned" from New/Reopened/Deferred, so a defect already In
# Progress/Resolved/Retest/Reopened/Deferred was stuck with its original
# assignee). Every status where obj.assignee_id is actually populated and
# the defect is still active -- excludes New (nothing to reassign yet) and
# the terminal Rejected/Duplicate/Closed states.
DEFECT_REASSIGNABLE_STATUSES = ["Assigned", "In Progress", "Resolved", "Retest", "Reopened", "Deferred"]
# Terminal states -- used to decide whether a SAST/DAST request still counts
# as "outstanding" for dashboard/ageing purposes (see routers/dashboard.py's
# 3W view). SM_REJECTED is deliberately NOT here -- reported directly, it's
# reopenable by the requester (edit details + resubmit, same path as
# RETURNED_BY_SM) rather than a dead end, so it should keep showing up as
# pending-with-Requester the same way RETURNED_BY_SM already does.
# DEPARTMENT_HEAD_REJECTED is untouched/still terminal -- only SM rejection
# was asked to become reopenable.
SAST_DAST_TERMINAL_STATUSES = ["REPORT_READY", "CLOSED", "DEPARTMENT_HEAD_REJECTED"]
# Statuses from which mandatory details (repo URL/branch/commit/tech stack
# for SAST; target URL/env/credentials for DAST) can still be edited by
# *someone* -- see routers/sast_dast.py::_can_edit_details for exactly who,
# at each of these (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are
# that stage's own reviewer only, not the requester). SM_REJECTED included
# alongside RETURNED_BY_SM -- see SAST_DAST_TERMINAL_STATUSES above.
SAST_DAST_EDITABLE_STATUSES = [
    "DRAFT", "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
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
# Shipped default only -- see checklist_config.py; this whole checklist is
# Admin-configurable now (Admin > Readiness Checklist Configuration). Seeded
# onto every auto-created SASTRequest (see models.SASTChecklistItem and
# routers/qa_requests.py::_sync_linked_child_requests).
#
# A mandatory item here is a hard gate at SUBMISSION time, not just at the
# readiness-verification step: the requester cannot even raise the QA Request
# (see routers/qa_requests.py::submit_request) or later re-Submit this SAST
# request for SM Approval (routers/sast_dast.py::_require_checklist_ready)
# while a mandatory item's own requester_checked is still false -- these are
# prerequisites (repo access, etc.) the requester needs lined up themselves
# before a scan is worth scheduling at all, so it's checked at submission
# rather than waiting until Security Readiness. Non-mandatory items are still
# self-declared/QA-or-Security-verified for visibility only, same as
# elsewhere. Functional and Performance now enforce their own mandatory items
# the same way at raise-time (see submit_request's pending_checklist_items
# gate) -- this used to be the one exception, it no longer is.
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
# Department Head assigns a COE - Quality Assurance QA Lead) -> Readiness -> Feasibility ->
# Planning (the QA Lead assigns COE - Quality Assurance QA Testers) -> Environment Setup -> Script
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
# SM_REJECTED deliberately NOT here -- reported directly, it's reopenable by
# the requester (edit details + resubmit, same path as RETURNED_BY_SM)
# rather than a dead end. DEPARTMENT_HEAD_REJECTED is untouched/still
# terminal -- only SM rejection was asked to become reopenable.
PERFORMANCE_TERMINAL_STATUSES = ["CLOSED", "CANCELLED", "DEPARTMENT_HEAD_REJECTED"]
# See routers/performance.py::_can_edit_details for exactly who may edit at
# each of these (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are
# that stage's own reviewer only, not the requester). SM_REJECTED included
# alongside RETURNED_BY_SM -- see PERFORMANCE_TERMINAL_STATUSES above.
PERFORMANCE_EDITABLE_STATUSES = [
    "DRAFT", "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
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
    "SIGNOFF_PENDING": "Clearance Pending", "SIGNED_OFF": "Cleared",
    "REQUESTER_VERIFICATION": "Requester Verification", "CLOSED": "Closed", "CANCELLED": "Cancelled",
}
# Linear order of the execution-side stages (after Department Head approval,
# before Sign-off).
PERFORMANCE_STAGE_ORDER = [
    "ENGINEER_ASSIGNED",
    "READINESS", "FEASIBILITY", "PLANNING", "ENVIRONMENT_SETUP", "SCRIPT_DEVELOPMENT",
    "BASELINE", "LOAD_TEST_EXECUTION", "RESULT_ANALYSIS", "DEFECT_FIX_RETEST", "REPORT",
]

# Same "no way to reassign once assigned" gap and fix as functional.py's
# TESTER_REASSIGNABLE_STATUSES above, mirrored for Performance's own
# assign_tester (routers/performance.py) -- every stage from the original
# PLANNING assignment through REPORT (the last stage before Sign-off) still
# has a "live" tester assignment worth being able to correct.
PERFORMANCE_TESTER_REASSIGNABLE_STATUSES = PERFORMANCE_STAGE_ORDER[PERFORMANCE_STAGE_ORDER.index("PLANNING"):]

# Request type checkboxes shown on the Performance Testing page of the QA
# Request form (Annexure VIII, item 3) -- distinct from the top-level
# REQUEST_TYPES list (which just has one "Performance Testing" entry).
PERFORMANCE_REQUEST_TYPES = ["Load Testing", "Stress Testing", "Spike Testing"]
# Annexure VIII, item 7.
CHANGE_TYPES = ["New", "Enhancement", "Bug Fix"]

# Annexure VIII ("QA Request Form & Checklist (Performance Testing)"), table 2:
# "L1: Pre-Testing Readiness Checklist" -- 19 items, each with a description of
# what data is required from the requesting department ("detail" on
# models.ChecklistTemplateItem, "data_required" on PerformanceChecklistItem).
# Shipped default only -- see checklist_config.py; this whole checklist is
# Admin-configurable now (Admin > Readiness Checklist Configuration), items
# below carry the initial shipped Mandatory value, editable from there
# afterward the same as every other module (see
# routers/qa_requests.py::submit_request's pending_checklist_items gate).
DEFAULT_PERFORMANCE_CHECKLIST_ITEMS = [
    ("Application Architecture Diagram", "Application Architecture Diagram (UML / Visio / PDF)", True),
    ("Transaction Flow", "Transaction Flow / Business Process Flow Document for Critical Transactions", True),
    ("Dependency Matrix", "List of Dependent Applications, APIs, Databases & External Systems", True),
    ("API / Interface Inventory (If Applicable)", "API List, API Specifications, Swagger/OpenAPI Document", False),
    ("Expected Average TPS", "Average Transactions Per Second expected in Production", True),
    ("Peak TPS", "Peak Transactions Per Second expected during Business Peak Hours", True),
    ("Concurrent Users / Sessions", "Expected Peak Concurrent Users / Sessions", True),
    ("Average & Max Message Size", "Average and Maximum Request/Response Payload Size (KB/MB)", False),
    ("Server Configuration", "Application, Middleware and Database Server Details", True),
    ("JVM/Application Parameters (If Applicable)", "Heap Size, Thread Pool, JVM & GC Parameters", False),
    ("Database Configuration", "Database Version, Sizing, Connection Pool Details", False),
    ("API Timeout & Retry Settings", "Timeout Values and Retry Logic Configuration", False),
    ("Performance SLA", "Response Time SLA, Throughput Targets, Availability Targets", True),
    ("Maximum Acceptable System Load Defined (Threshold Values)",
     "Maximum TPS, Concurrent Users, Transaction Volume, System Capacity Limits", True),
    ("Monitoring Dashboard Access", "Monitoring Tool URLs and Required Access Details", False),
    ("Batch/Scheduler Details (If Applicable)", "Batch Jobs, Schedule Details, Expected Volumes", False),
    ("Test Data Availability", "Test Users, Test Accounts, Test Data Sets", True),
    ("Rollback Procedure", "Rollback Document and Recovery Steps", False),
    ("Teardown Procedure", "Environment Cleanup / Reset Procedure", True),
]

SEVERITIES = ["Critical", "High", "Medium", "Low", "Informational"]

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

SUPPRESSION_TERMINAL_STATUSES = ["Done", "Rejected"]

# ---- Application Name Master (see models.ApplicationMaster) ----
# A brand-new name introduced via the QA Request wizard's "Other" option
# starts PENDING_APP_OWNER; an Application Owner from the same department
# either APPROVEs it (making it a selectable option in the dropdown for
# everyone going forward, and sending its request's own linked child
# requests straight to their assigned SM's normal readiness-verification
# queue -- reported directly: "only application owner approval required, no
# SM involvement. if application owner approved then automatically come to
# SM for readiness verification and all") or REJECTs it -- either outcome is
# terminal (single-tier, 2026-08 v2). Independent of the QA Request's own
# workflow -- this never gates Submit/Raise (see routers/qa_requests.py::
# _resolve_application_name).
# PENDING_SM is LEGACY-ONLY: a short-lived 2026-08 v1 second tier (a
# separate SM decision on the name itself, see routers/applications.py::
# decide_application_name) that a NEW name can never reach anymore -- kept
# in this list only so any pre-existing row left at PENDING_SM from before
# v2 shipped still round-trips correctly through the API while its one-time
# data fix-up (see the migration notes) is applied.
APPLICATION_MASTER_STATUSES = ["PENDING_APP_OWNER", "PENDING_SM", "APPROVED", "REJECTED"]
APPLICATION_MASTER_STATUS_LABELS = {
    # Reported directly, with this exact wording: "the request status shall
    # be displayed as 'Application Owner Approval Pending.'"
    "PENDING_APP_OWNER": "Application Owner Approval Pending",
    "PENDING_SM": "Pending SM Approval",
    "APPROVED": "Approved",
    "REJECTED": "Rejected",
}


def application_name_block_message(app_status, stage: str) -> str:
    """Shared wording for the 6 duplicated SM/Department-Head decision guard
    clauses across functional.py/sast_dast.py/performance.py that block
    Approve on the underlying request until its Application Name is
    APPROVED. `stage` is 'sm' or 'department_head' -- which checkpoint is
    being blocked; the message differs depending on whether the name is
    still stuck one tier earlier (Application Owner hasn't looked at it yet)
    or is genuinely this checkpoint's own turn to wait for SM."""
    if app_status == "PENDING_APP_OWNER":
        return (
            "This request's Application Name is still awaiting Application Owner approval -- "
            "it hasn't reached SM review yet, so there's nothing for you to decide here yet."
        )
    if stage == "sm":
        return (
            "This request's Application Name is not yet Approved -- decide it first "
            "(see the Application Name banner above) before approving the request itself."
        )
    return (
        "This request's Application Name is not yet Approved by SM -- it must be decided "
        "before this request can be approved."
    )

APPROVAL_DECISIONS = ["Approved", "Rejected", "Returned"]

WORKFLOW_STEPS = {
    "QA_REQUEST": ["Requester (Drafted)", "Submitted", "Raised / Cancelled"],
    "FUNCTIONAL_REQUEST": [
        "Requester", "SM Approval", "Department Head Approval", "QA Readiness Verification Pending", "Readiness Verification",
        "QA Activity (Planning/Tester Assignment/Design/Execution)", "Defect-Retest-Regression Cycle",
        "QA Clearance", "Requester Verification",
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
        "Defect/Fix/Retest", "Report", "Clearance", "Requester Verification",
    ],
    "SUPPRESSION": ["Requester", "SM Approval", "Department Head Approval", "Security Team Verification"],
}

# ---- Module 8: QA Clearance ----
CERTIFICATE_TYPES = ["Full Clearance", "Conditional Clearance", "Clearance Denied"]
SIGNOFF_TESTING_TYPES = ["Functional", "SAST", "DAST"]
RISK_TIERS = ["Tier 1 (Critical)", "Tier 2 (High)", "Tier 3 (Medium)", "Tier 4 (Low)"]

SIGNOFF_STATUSES = [
    "DRAFT", "SUBMITTED", "SM_APPROVAL_PENDING", "RETURNED_BY_SM", "SM_REJECTED",
    "DEPT_HEAD_QA_APPROVAL_PENDING", "RETURNED_BY_DEPT_HEAD_COE", "DEPT_HEAD_COE_REJECTED",
    "ISSUED", "RETURNED_BY_REQUESTER",
]

SIGNOFF_TERMINAL_STATUSES = ["ISSUED", "DEPT_HEAD_COE_REJECTED"]

SIGNOFF_EDITABLE_STATUSES = ["DRAFT", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPT_HEAD_COE", "RETURNED_BY_REQUESTER"]
SIGNOFF_STATUS_LABELS = {
    "DRAFT": "Draft",
    "SUBMITTED": "Submitted",
    "SM_APPROVAL_PENDING": "QA Lead Approval Pending",
    "RETURNED_BY_SM": "Returned by QA Lead",
    "SM_REJECTED": "Rejected by QA Lead",
    "DEPT_HEAD_QA_APPROVAL_PENDING": "Executive Approval Pending",
    "RETURNED_BY_DEPT_HEAD_COE": "Returned by Executive",
    "DEPT_HEAD_COE_REJECTED": "Rejected by Executive",
    "ISSUED": "Issued",
    "RETURNED_BY_REQUESTER": "Returned by Requester",
}

TEST_CASE_TYPES = [
    "Functional Positive", "Functional Negative", "Regression", "Sanity",
    "Integration", "Security", "Performance", "UAT", "Other",
]

TEST_CASE_STATUSES = ["Draft", "In Review", "Review Completed", "Returned", "Approved", "Rejected", "Archived"]

TEST_CASE_NEW_STATUSES = [
    "Recommendation Pending", "QA Lead Approval Pending", "Returned by QA", "Returned by QA Lead",
]
TEST_CASE_STATUSES = TEST_CASE_STATUSES + TEST_CASE_NEW_STATUSES

TEST_CASE_PENDING_DECISION_STATUSES = [
    "In Review", "Review Completed", "Recommendation Pending", "QA Lead Approval Pending",
]
TEST_CASE_TERMINAL_STATUSES = ["Rejected"]

TEST_CASE_VERSION_STATUSES = TEST_CASE_STATUSES

TEST_CASE_PRIORITIES = PRIORITIES

TEST_CYCLE_STATUSES = ["Draft", "Ready", "In Progress", "Blocked", "Completed"]
TEST_CYCLE_LOCKED_STATUSES = ["Blocked", "Completed"]

TEST_EXECUTION_STATUSES = ["Not Executed", "Pass", "Fail", "Blocked", "NA", "Retest Passed"]

TEST_EXECUTION_TERMINAL_STATUSES = ["Pass", "Fail", "NA", "Retest Passed"]

TEST_EXECUTION_DEFECT_ELIGIBLE_STATUSES = ["Fail", "Blocked"]

TEST_PROJECT_ROLES = ["Owner", "Project Lead", "Author", "Tester", "Reviewer", "Viewer"]

EXPORT_FORMATS = ["xlsx", "pdf", "csv"]
