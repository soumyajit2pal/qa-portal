export const ROLE_LABELS: Record<string, string> = {
  REQUESTER: 'Requester (Developer) / Others',
  BUSINESS_ANALYST: 'Business Analyst',
  QA_ENGINEER: 'QA Engineer (QA)',
  QA_LEAD: 'QA Lead',
  DEPARTMENT_HEAD_COE: 'Executive COE (AGM-QA)',
  SECURITY_ANALYST: 'Security Analyst (QA)',
  APPLICATION_OWNER: 'Application Owner',
  DEPARTMENT_HEAD: 'Department Head - CM/AGM',
  // New checkpoint between Requester and Department Head on QA Request/
  // SAST-DAST/Suppression workflows. Label deliberately left as literal
  // "SM" per how it was specified -- rename to a fuller name here any time.
  SM: 'SM',
  ADMIN: 'Administrator',
}

export const ALL_ROLES = Object.keys(ROLE_LABELS)

// Minimal shape needed by hasRole -- deliberately looser than the full
// UserOut so it works for both the logged-in user and any user row.
export interface RoleBearer {
  roles?: string[] | null
}

// A user may hold several roles at once (all active simultaneously) -- this
// passes if the user has ANY of the given roles (ADMIN always passes).
export function hasRole(user: RoleBearer | null | undefined, ...roles: string[]): boolean {
  const userRoles = user?.roles || []
  if (userRoles.includes('ADMIN')) return true
  return roles.some((r) => userRoles.includes(r))
}

// Departments are now DB-backed (see backend app/models.py Department,
// managed via /api/departments) instead of a hardcoded list -- every place
// that used to import DEPARTMENTS from here now calls api.get<DepartmentOut[]>
// ('/api/departments') at render time instead (Admin.tsx's user picker,
// QARequests.tsx's new-request form, etc). This export is intentionally
// gone; nothing in the app should hardcode a department list anymore.

export interface ChecklistItemDef {
  item: string
  owner: string
}

// Mirrors backend constants.py DEFAULT_CHECKLIST_ITEMS. Used to also include
// "SAST readiness"/"DAST readiness" as two conditionally-mandatory items
// (see the removed CONDITIONAL_CHECKLIST_ITEMS) -- removed now that SAST and
// DAST each have their own dedicated "Security Readiness" checklist, the
// correct place for that concern to live.
export const DEFAULT_CHECKLIST_ITEMS: ChecklistItemDef[] = [
  { item: 'BRD / FRS / User Stories approved', owner: 'Business / BA' },
  { item: 'Scope finalized & change freeze', owner: 'Business / IT' },
  { item: 'Test Environment availability (UAT / SIT)', owner: 'Business' },
  { item: 'Test data creation', owner: 'User dept / Dev team' },
  { item: 'Assess Test Scenarios', owner: 'User Dept' },
  { item: 'Project walkthrough to QA', owner: 'User Dept / Dev team' },
  { item: 'Application builds deployed & validated', owner: 'Dev team / Business' },
  { item: 'Security access (VPN Proxy/URLs whitelisting/credentials/firewall)', owner: 'User dept' },
]

// The QA Request is a pure intake/gateway record ("QA request form is the
// gateway only") -- must mirror backend app/constants.py GatewayStatus. It
// has no approval workflow of its own: Draft -> Submitted -> Raised
// (immediately, once its linked child request(s) exist), or Cancelled while
// still Draft.
export const GATEWAY_STATUSES: string[] = ['DRAFT', 'SUBMITTED', 'RAISED', 'CANCELLED']
export const GATEWAY_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', RAISED: 'Raised', CANCELLED: 'Cancelled',
}
export const GATEWAY_EDITABLE_STATUSES: string[] = ['DRAFT']
export const GATEWAY_TERMINAL_STATUSES: string[] = ['RAISED', 'CANCELLED']
export const GATEWAY_CANCELLABLE_STATUSES: string[] = ['DRAFT']

// Every one of these request types auto-raises its own independent linked
// request (own unique ID, own Draft -> SM -> ... lifecycle) from the QA
// Request gateway -- Functional/Sanity/Regression Testing/UAT Support are
// combined into one Functional Testing Request; see FUNCTIONAL_BUCKET_TYPES
// below and CHILD_REQUEST_TYPES in shell/QARequests.tsx.
export const FUNCTIONAL_BUCKET_TYPES: string[] = [
  'Functional Testing', 'Sanity Testing', 'Regression Testing', 'UAT Support',
]

// The Functional Testing Request lifecycle -- covers whichever of
// Functional/Sanity/Regression Testing/UAT Support were selected on the QA
// Request gateway, combined into one request (must mirror backend
// app/constants.py QAStatus). Requester -> Draft -> Submit to SM -> SM
// Approval -> Department Head Approval (assigns QA Lead) -> QA Lead starts
// Readiness Verification -> QA activity -> Sign-off -> Requester
// Verification -> Closed.
export const QA_STATUSES: string[] = [
  'DRAFT', 'SUBMITTED',
  'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_REJECTED',
  'QA_LEAD_ASSIGNED',
  'READINESS_VERIFICATION', 'RETURNED_BY_QA_LEAD', 'QA_ACTIVITY_INITIATED',
  'PLANNING', 'TESTER_ASSIGNED', 'TEST_DESIGN', 'EXECUTION_IN_PROGRESS', 'DEFECT_RAISED',
  'WAITING_FOR_FIX', 'RETESTING', 'REGRESSION_TESTING', 'QA_COMPLETED', 'QA_SIGNOFF_PENDING',
  'QA_SIGNED_OFF', 'REQUESTER_VERIFICATION', 'CLOSED', 'CANCELLED',
]

export const QA_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted',
  SM_APPROVAL_PENDING: 'SM Approval Pending',
  RETURNED_BY_SM: 'Returned by SM',
  SM_REJECTED: 'Rejected by SM',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head Approval Pending',
  RETURNED_BY_DEPARTMENT_HEAD: 'Returned by Department Head',
  DEPARTMENT_HEAD_REJECTED: 'Department Head Rejected',
  QA_LEAD_ASSIGNED: 'QA Lead Assigned',
  READINESS_VERIFICATION: 'Readiness Verification',
  RETURNED_BY_QA_LEAD: 'Returned by QA Lead', QA_ACTIVITY_INITIATED: 'QA Activity Initiated',
  PLANNING: 'Planning', TESTER_ASSIGNED: 'Tester Assigned', TEST_DESIGN: 'Test Design',
  EXECUTION_IN_PROGRESS: 'Execution In Progress', DEFECT_RAISED: 'Defect Raised',
  WAITING_FOR_FIX: 'Waiting For Fix', RETESTING: 'Retesting', REGRESSION_TESTING: 'Regression Testing',
  QA_COMPLETED: 'QA Completed', QA_SIGNOFF_PENDING: 'QA Sign-off Pending', QA_SIGNED_OFF: 'QA Signed Off',
  REQUESTER_VERIFICATION: 'Requester Verification', CLOSED: 'Closed', CANCELLED: 'Cancelled',
}

// Statuses from which the Functional Testing Request's own descriptive
// fields (currently just Priority/Risk Rating -- see PUT
// /api/functional-requests/{id}) can still be edited by the requester (or
// QA) -- mirrors backend constants.FUNCTIONAL_EDITABLE_STATUSES, same
// pattern/values as SAST_DAST_EDITABLE_STATUSES/
// PERFORMANCE_EDITABLE_STATUSES below.
export const FUNCTIONAL_EDITABLE_STATUSES: string[] = ['DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD']
// Terminal statuses -- no further transitions possible.
export const QA_TERMINAL_STATUSES: string[] = ['CLOSED', 'CANCELLED', 'SM_REJECTED', 'DEPARTMENT_HEAD_REJECTED']
// Statuses from which the request may still be cancelled -- mirrors backend
// constants.py QA_REQUEST_CANCELLABLE_STATUSES. Once the Department Head
// approves and a QA Lead is assigned, cancellation is no longer offered.
export const QA_CANCELLABLE_STATUSES: string[] = [
  'DRAFT', 'SUBMITTED', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD',
]
// "In flight" statuses used for nav-count badges / active-project metrics.
export const QA_ACTIVE_STATUSES: string[] = QA_STATUSES.filter(
  (s) => s !== 'DRAFT' && !QA_TERMINAL_STATUSES.includes(s)
)

// ---- SAST/DAST lifecycle (identical for both -- must mirror backend
// app/constants.py SAST_DAST_STATUSES). Draft -> Submit -> SM Approval ->
// Department Head Approval (assigns a Security Lead) -> Security Readiness
// -> Planning -> Configuration -> Scanning -> Complete Scan -> Finding
// Validation -> [no findings ->] Security Complete, or [findings ->]
// Remediation -> Assigned To Requester -> Waiting For Fix -> (fixed) ->
// Assigned To Lead -> Rescan -> (Passed ->) Security Complete or (Failed ->
// back to) Scanning -> Report Ready (blocked while a linked Suppression
// request isn't Done yet).
export const SAST_DAST_STATUSES: string[] = [
  'DRAFT', 'SUBMITTED',
  'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_REJECTED',
  'SECURITY_LEAD_ASSIGNED', 'SECURITY_READINESS', 'RETURNED_BY_SECURITY_LEAD',
  'PLANNING', 'CONFIGURATION', 'SCANNING', 'FINDING_VALIDATION', 'REMEDIATION',
  'ASSIGNED_TO_REQUESTER', 'WAITING_FOR_FIX', 'ASSIGNED_TO_LEAD', 'RESCAN',
  'SECURITY_COMPLETE', 'REPORT_READY', 'CLOSED',
]

export const SAST_DAST_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted',
  SM_APPROVAL_PENDING: 'SM Approval Pending',
  RETURNED_BY_SM: 'Returned by SM',
  SM_REJECTED: 'Rejected by SM',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head Approval Pending',
  RETURNED_BY_DEPARTMENT_HEAD: 'Returned by Department Head',
  DEPARTMENT_HEAD_REJECTED: 'Department Head Rejected',
  SECURITY_LEAD_ASSIGNED: 'Security Lead Assigned',
  SECURITY_READINESS: 'Security Readiness',
  RETURNED_BY_SECURITY_LEAD: 'Returned by Security Lead',
  PLANNING: 'Planning',
  CONFIGURATION: 'Scan Configuration',
  SCANNING: 'Scanning',
  FINDING_VALIDATION: 'Finding Validation',
  REMEDIATION: 'Remediation',
  ASSIGNED_TO_REQUESTER: 'Assigned to Requester',
  WAITING_FOR_FIX: 'Waiting For Fix',
  ASSIGNED_TO_LEAD: 'Assigned to Lead',
  RESCAN: 'Rescan',
  SECURITY_COMPLETE: 'Security Complete',
  REPORT_READY: 'Report Ready',
  CLOSED: 'Closed',
}

export const SAST_DAST_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD',
]
export const SAST_DAST_TERMINAL_STATUSES: string[] = ['REPORT_READY', 'CLOSED', 'SM_REJECTED', 'DEPARTMENT_HEAD_REJECTED']

// SAST/DAST's own "Security Readiness" pre-scan checklists -- distinct from
// DEFAULT_CHECKLIST_ITEMS (Functional's) and each other. Must mirror backend
// app/constants.py DEFAULT_SAST_CHECKLIST_ITEMS / DEFAULT_DAST_CHECKLIST_ITEMS.
// Shown in the QA Request wizard's own SAST/DAST steps (see
// shell/QARequests.tsx::buildSteps -- Security Readiness Checklist is part of
// the SAST/DAST step itself, not a separate step) so the requester can
// self-declare at intake time instead of only from the SAST/DAST module's own
// Edit Details modal afterward. Unlike every other checklist in this app, a
// mandatory item here also blocks that child request's own Submit, not just
// Security Readiness -- see routers/sast_dast.py::_require_checklist_ready.
export interface SecurityChecklistItemDef {
  item: string
  owner: string
  is_mandatory: boolean
}
export const DEFAULT_SAST_CHECKLIST_ITEMS: SecurityChecklistItemDef[] = [
  { item: 'Application/source code repository access provided to the scan team', owner: 'Dev team', is_mandatory: true },
  { item: 'Change freeze / business hours confirmed for the scan window', owner: 'Business / User dept', is_mandatory: false },
  { item: 'Point of contact identified for application/code-level queries during the scan', owner: 'User dept / Dev team', is_mandatory: false },
]
export const DEFAULT_DAST_CHECKLIST_ITEMS: SecurityChecklistItemDef[] = [
  { item: 'Test environment / application URL accessible and stable', owner: 'User dept / Dev team', is_mandatory: true },
  { item: 'Test accounts and role-based credentials provided', owner: 'User dept', is_mandatory: true },
  { item: 'Firewall / VPN / IP whitelisting completed for scan tool access', owner: 'User dept / IT', is_mandatory: true },
  { item: 'Change freeze / business hours confirmed for the scan window', owner: 'Business / User dept', is_mandatory: false },
  { item: 'Backup taken / rollback plan confirmed before scanning starts', owner: 'Dev team', is_mandatory: false },
  { item: 'Third-party services, OTP, CAPTCHA and payment dependencies identified with test-mode or bypass mechanisms', owner: 'Business / Dev team', is_mandatory: false },
  { item: 'Point of contact identified for application/code-level queries during the scan', owner: 'User dept / Dev team', is_mandatory: false },
]

// ---- Performance Testing lifecycle -- must mirror backend
// app/constants.py PERFORMANCE_STATUSES. Auto-created from a QA Request when
// "Performance Testing" is selected.
export const PERFORMANCE_STATUSES: string[] = [
  'DRAFT', 'SUBMITTED',
  'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_REJECTED',
  'ENGINEER_ASSIGNED', 'RETURNED_BY_ENGINEER',
  'READINESS', 'FEASIBILITY', 'PLANNING', 'ENVIRONMENT_SETUP', 'SCRIPT_DEVELOPMENT',
  'BASELINE', 'LOAD_TEST_EXECUTION', 'RESULT_ANALYSIS', 'DEFECT_FIX_RETEST', 'REPORT',
  'SIGNOFF_PENDING', 'SIGNED_OFF', 'REQUESTER_VERIFICATION', 'CLOSED', 'CANCELLED',
]
export const PERFORMANCE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted',
  SM_APPROVAL_PENDING: 'SM Approval Pending', RETURNED_BY_SM: 'Returned by SM', SM_REJECTED: 'Rejected by SM',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head Approval Pending',
  RETURNED_BY_DEPARTMENT_HEAD: 'Returned by Department Head',
  DEPARTMENT_HEAD_REJECTED: 'Department Head Rejected',
  ENGINEER_ASSIGNED: 'Engineer Assigned', RETURNED_BY_ENGINEER: 'Returned by Engineer',
  READINESS: 'Readiness', FEASIBILITY: 'Feasibility', PLANNING: 'Planning',
  ENVIRONMENT_SETUP: 'Environment Setup', SCRIPT_DEVELOPMENT: 'Script Development',
  BASELINE: 'Baseline', LOAD_TEST_EXECUTION: 'Load Test Execution',
  RESULT_ANALYSIS: 'Result Analysis', DEFECT_FIX_RETEST: 'Defect / Fix / Retest', REPORT: 'Report',
  SIGNOFF_PENDING: 'Sign-off Pending', SIGNED_OFF: 'Signed Off',
  REQUESTER_VERIFICATION: 'Requester Verification', CLOSED: 'Closed', CANCELLED: 'Cancelled',
}
export const PERFORMANCE_TERMINAL_STATUSES: string[] = ['CLOSED', 'CANCELLED', 'SM_REJECTED', 'DEPARTMENT_HEAD_REJECTED']
export const PERFORMANCE_EDITABLE_STATUSES: string[] = ['DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER']

// Request type checkboxes shown on the Performance Testing page of the QA
// Request form (Annexure VIII, item 3) -- must mirror backend
// app/constants.py PERFORMANCE_REQUEST_TYPES.
export const PERFORMANCE_REQUEST_TYPES: string[] = ['Load Testing', 'Stress Testing', 'Spike Testing']
// Annexure VIII, item 7.
export const CHANGE_TYPES: string[] = ['New', 'Enhancement', 'Bug Fix']

// Annexure VIII ("QA Request Form & Checklist (Performance Testing)"),
// table 2: "L1: Pre-Testing Readiness Checklist" -- 19 fixed items, must
// mirror backend app/constants.py DEFAULT_PERFORMANCE_CHECKLIST_ITEMS.
export interface PerformanceChecklistItemDef {
  item: string
  data_required: string
}
export const DEFAULT_PERFORMANCE_CHECKLIST_ITEMS: PerformanceChecklistItemDef[] = [
  { item: 'Application Architecture Diagram', data_required: 'Architecture Diagram' },
  { item: 'Transaction Flow', data_required: 'Transaction Flow / Business Process Flow Document for Critical Transactions' },
  { item: 'Dependency Matrix', data_required: 'List of Dependent Applications, APIs, Databases & External Systems' },
  { item: 'API / Interface Inventory (If Applicable)', data_required: 'API List, API Specifications, Swagger/OpenAPI Document' },
  { item: 'Expected Average TPS', data_required: 'Average Transactions Per Second expected in Production' },
  { item: 'Peak TPS', data_required: 'Peak Transactions Per Second expected during Business Peak Hours' },
  { item: 'Concurrent Users / Sessions', data_required: 'Expected Peak Concurrent Users / Sessions' },
  { item: 'Average & Max Message Size', data_required: 'Average and Maximum Request/Response Payload Size (KB/MB)' },
  { item: 'Server Configuration', data_required: 'Application, Middleware and Database Server Details' },
  { item: 'JVM/Application Parameters (If Applicable)', data_required: 'Heap Size, Thread Pool, JVM & GC Parameters' },
  { item: 'Database Configuration', data_required: 'Database Version, Sizing, Connection Pool Details' },
  { item: 'API Timeout & Retry Settings', data_required: 'Timeout Values and Retry Logic Configuration' },
  { item: 'Performance SLA', data_required: 'Response Time SLA, Throughput Targets, Availability Targets' },
  { item: 'Maximum Acceptable System Load Defined (Threshold Values)', data_required: 'Maximum TPS, Concurrent Users, Transaction Volume, System Capacity Limits' },
  { item: 'Monitoring Dashboard Access', data_required: 'Monitoring Tool URLs and Required Access Details' },
  { item: 'Batch/Scheduler Details (If Applicable)', data_required: 'Batch Jobs, Schedule Details, Expected Volumes' },
  { item: 'Test Data Availability', data_required: 'Test Users, Test Accounts, Test Data Sets' },
  { item: 'Rollback Procedure', data_required: 'Rollback Document and Recovery Steps' },
  { item: 'Teardown Procedure', data_required: 'Environment Cleanup / Reset Procedure' },
]

// ---- Suppression request lifecycle (Application Owner step removed --
// must mirror backend app/constants.py SUPPRESSION_STATUSES). Requester ->
// Draft -> Submit to SM -> SM assigns to Department Head -> Department Head
// -> Security Team verification -> Done / Rejected.
export const SUPPRESSION_STATUSES: string[] = [
  'Draft', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD',
  'SECURITY_TEAM_VERIFICATION', 'RETURNED_BY_SECURITY_TEAM', 'Done', 'Rejected',
]

export const SUPPRESSION_STATUS_LABELS: Record<string, string> = {
  Draft: 'Draft',
  SM_APPROVAL_PENDING: 'SM Approval Pending',
  RETURNED_BY_SM: 'Returned by SM',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head Approval Pending',
  RETURNED_BY_DEPARTMENT_HEAD: 'Returned by Department Head',
  SECURITY_TEAM_VERIFICATION: 'Security Team Verification',
  RETURNED_BY_SECURITY_TEAM: 'Returned by Security Team',
  Done: 'Done',
  Rejected: 'Rejected',
}

export const SUPPRESSION_TERMINAL_STATUSES: string[] = ['Done', 'Rejected']

// QASignOff's own Tester -> SM -> Department Head COE approval chain (see
// backend constants.SIGNOFF_STATUSES) -- mirrors this same
// Requester/SM/Department-Head shape used everywhere else in the app.
export const SIGNOFF_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  SM_APPROVAL_PENDING: 'SM Approval Pending',
  RETURNED_BY_SM: 'Returned by SM',
  SM_REJECTED: 'Rejected by SM',
  DEPT_HEAD_COE_APPROVAL_PENDING: 'Department Head COE Approval Pending',
  RETURNED_BY_DEPT_HEAD_COE: 'Returned by Department Head COE',
  DEPT_HEAD_COE_REJECTED: 'Rejected by Department Head COE',
  ISSUED: 'Issued',
  // No entries for the old pre-rollout literal "Draft"/"Issued" values --
  // those keys would collide with SUPPRESSION_STATUS_LABELS.Draft in the
  // shared ALL_STATUS_LABELS merge (see components/Common.tsx). The Oracle
  // migration includes a one-time UPDATE moving any existing certificate off
  // those old values onto DRAFT/ISSUED instead (see ORACLE_MIGRATION_2026-07.md).
}
export const SIGNOFF_EDITABLE_STATUSES: string[] = ['DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPT_HEAD_COE']
export const SIGNOFF_TERMINAL_STATUSES: string[] = ['ISSUED', 'SM_REJECTED', 'DEPT_HEAD_COE_REJECTED']

// Admin section: account authentication type (must mirror backend LoginType).
export const LOGIN_TYPES: string[] = ['STANDARD', 'LDAP']
export const LOGIN_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Standard (local password)',
  LDAP: 'LDAP / Active Directory',
}

export const REQUEST_TYPES: string[] = [
  'Functional Testing', 'Sanity Testing', 'Regression Testing', 'UAT Support',
  'Performance Testing', 'SAST', 'DAST', 'Others',
]

export const PRIORITIES: string[] = ['Critical', 'High', 'Medium', 'Low']
export const RISK_RATINGS: string[] = ['Critical', 'High', 'Medium', 'Low']
export const ENVIRONMENTS: string[] = ['Dev', 'SIT', 'UAT', 'Pre-Production', 'Production']
export const SEVERITIES: string[] = ['Critical', 'High', 'Medium', 'Low', 'Informational']
export const CERTIFICATE_TYPES: string[] = ['Full Clearance', 'Conditional Clearance', 'Clearance Denied']
export const SIGNOFF_TESTING_TYPES: string[] = ['Functional', 'SAST', 'DAST']
export const RISK_TIERS: string[] = ['Tier 1 (Critical)', 'Tier 2 (High)', 'Tier 3 (Medium)', 'Tier 4 (Low)']

export interface ReportDef {
  key: string
  label: string
  group: string
}

export const REPORTS: ReportDef[] = [
  { key: 'qa-request-summary', label: 'QA Request Summary', group: 'Operational' },
  { key: 'sast-scan', label: 'SAST Scan Report', group: 'Security' },
  { key: 'dast-scan', label: 'DAST Scan Report', group: 'Security' },
  { key: 'vulnerability-trend', label: 'Vulnerability Trend Report', group: 'Security' },
  { key: 'severity-distribution', label: 'Severity-wise Distribution', group: 'Security' },
  { key: 'suppression-register', label: 'Suppression Register', group: 'Security' },
  { key: 'monthly-qa-kpi', label: 'Monthly QA KPI Report', group: 'Management' },
  { key: 'application-quality-scorecard', label: 'Application-wise Quality Scorecard', group: 'Management' },
  { key: 'audit-evidence', label: 'Audit Evidence Report', group: 'Management' },
]
