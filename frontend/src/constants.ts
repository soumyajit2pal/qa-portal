export const ROLE_LABELS: Record<string, string> = {
  REQUESTER: 'Requester / Others',
  BUSINESS_ANALYST: 'Business Analyst',
  QA_ENGINEER: 'QA Engineer (QA)',
  QA_LEAD: 'QA Lead',
  DEPARTMENT_HEAD_COE: 'Executive COE (CM/AGM)',
  SECURITY_ANALYST: 'Security Analyst (QA)',
  APPLICATION_OWNER: 'Application Owner',
  DEPARTMENT_HEAD: 'Requester Department Head - CM/AGM',
  // New checkpoint between Requester and Department Head on QA Request/
  // SAST-DAST/Suppression workflows. Label deliberately left as literal
  // "SM" per how it was specified -- rename to a fuller name here any time.
  SM: 'SM',
  ADMIN: 'Administrator',
}

export const ALL_ROLES = Object.keys(ROLE_LABELS)

// QA Sign-off is an IT - QA-owned workflow even when its linked testing
// request came from another business department.
export const QA_DEPARTMENT = 'IT - QA'

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
  is_mandatory: boolean
}

// Mirrors backend constants.py DEFAULT_CHECKLIST_ITEMS. Used to also include
// "SAST readiness"/"DAST readiness" as two conditionally-mandatory items
// (see the removed CONDITIONAL_CHECKLIST_ITEMS) -- removed now that SAST and
// DAST each have their own dedicated "Security Readiness" checklist, the
// correct place for that concern to live.
export const DEFAULT_CHECKLIST_ITEMS: ChecklistItemDef[] = [
  { item: 'BRD / FRS / User Stories approved', owner: 'Business / BA' , is_mandatory: true},
  { item: 'Scope finalized & change freeze', owner: 'Business / IT',is_mandatory: true },
  { item: 'Test Environment availability (UAT / SIT)', owner: 'Business' , is_mandatory: true},
  { item: 'Test data creation', owner: 'User dept / Dev team' , is_mandatory: false},
  { item: 'Assess Test Scenarios', owner: 'User Dept' , is_mandatory: false},
  { item: 'Project walkthrough to QA', owner: 'User Dept / Dev team' , is_mandatory: false},
  { item: 'Application builds deployed & validated', owner: 'Dev team / Business' , is_mandatory: false},
  { item: 'Security access (VPN Proxy/URLs whitelisting/credentials/firewall)', owner: 'User dept' , is_mandatory: false},
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
  QA_LEAD_ASSIGNED: 'QA Readiness Verification Pending',
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
// /api/functional-requests/{id}) can still be edited by *someone* --
// mirrors backend constants.FUNCTIONAL_EDITABLE_STATUSES, same pattern/
// values as SAST_DAST_EDITABLE_STATUSES/PERFORMANCE_EDITABLE_STATUSES below.
// Exactly who may edit at each of these is further scoped in Functional.tsx
// (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are that stage's
// own reviewer only, not the requester -- see canEditDetails there).
export const FUNCTIONAL_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD',
]
// Checklist evidence is normally collected before the Department Head
// decision and locked after approval. Any RETURNED_BY_* status is the
// deliberate exception: the request is back with the requester, who must be
// able to attach the evidence requested by whichever later stage returned it.
export const READINESS_EVIDENCE_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD',
]
export function canManageReadinessEvidence(status?: string | null): boolean {
  return !!status && (
    READINESS_EVIDENCE_EDITABLE_STATUSES.includes(status)
    || status.startsWith('RETURNED_BY_')
  )
}
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

// Statuses before scanning has actually started -- must mirror backend
// app/constants.py SAST_DAST_PRE_SCANNING_STATUSES exactly. A suppression /
// false-positive request is a decision about a *finding*, and there's
// nothing to suppress yet while the linked request is still sitting
// somewhere before a scan has even started, so Suppression's Request ID
// picker (Suppression.tsx) excludes these. Listed explicitly (not sliced
// from SAST_DAST_STATUSES by index) so it stays correct even if that list
// is ever reordered.
export const SAST_DAST_PRE_SCANNING_STATUSES: string[] = [
  'DRAFT', 'SUBMITTED',
  'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_REJECTED',
  'SECURITY_LEAD_ASSIGNED', 'SECURITY_READINESS', 'RETURNED_BY_SECURITY_LEAD',
  'PLANNING', 'CONFIGURATION',
]

// The other end of the window -- must mirror backend app/constants.py
// SAST_DAST_COMPLETED_STATUSES exactly. Once a SAST/DAST request has been
// declared Security Complete, it's finalized, so it's excluded from
// Suppression's Request ID picker too -- pairs with
// SAST_DAST_PRE_SCANNING_STATUSES above to define the eligible window as
// Scanning through the stage right before Security Complete.
export const SAST_DAST_COMPLETED_STATUSES: string[] = ['SECURITY_COMPLETE', 'REPORT_READY', 'CLOSED']

export const SAST_DAST_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted',
  SM_APPROVAL_PENDING: 'SM Approval Pending',
  RETURNED_BY_SM: 'Returned by SM',
  SM_REJECTED: 'Rejected by SM',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head Approval Pending',
  RETURNED_BY_DEPARTMENT_HEAD: 'Returned by Department Head',
  DEPARTMENT_HEAD_REJECTED: 'Department Head Rejected',
  SECURITY_LEAD_ASSIGNED: 'Security Readiness Verification Pending',
  SECURITY_READINESS: 'Security Readiness',
  RETURNED_BY_SECURITY_LEAD: 'Returned by QA Lead',
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

// Who may edit at each of these is further scoped in SAST.tsx/DAST.tsx
// (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are that stage's
// own reviewer only, not the requester -- see canEditDetails there).
export const SAST_DAST_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD',
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
  ENGINEER_ASSIGNED: 'Readiness Verification Pending', RETURNED_BY_ENGINEER: 'Returned by QA Lead',
  READINESS: 'Readiness', FEASIBILITY: 'Feasibility', PLANNING: 'Planning',
  ENVIRONMENT_SETUP: 'Environment Setup', SCRIPT_DEVELOPMENT: 'Script Development',
  BASELINE: 'Baseline', LOAD_TEST_EXECUTION: 'Load Test Execution',
  RESULT_ANALYSIS: 'Result Analysis', DEFECT_FIX_RETEST: 'Defect / Fix / Retest', REPORT: 'Report',
  SIGNOFF_PENDING: 'Sign-off Pending', SIGNED_OFF: 'Signed Off',
  REQUESTER_VERIFICATION: 'Requester Verification', CLOSED: 'Closed', CANCELLED: 'Cancelled',
}
export const PERFORMANCE_TERMINAL_STATUSES: string[] = ['CLOSED', 'CANCELLED', 'SM_REJECTED', 'DEPARTMENT_HEAD_REJECTED']
// Who may edit at each of these is further scoped in Performance.tsx
// (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are that stage's
// own reviewer only, not the requester -- see canEditDetails there).
export const PERFORMANCE_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER',
]

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

// QASignOff's own QA Engineer -> QA Lead -> Executive COE approval chain.
export const SIGNOFF_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  SM_APPROVAL_PENDING: 'QA Lead Approval Pending',
  RETURNED_BY_SM: 'Returned by QA Lead',
  SM_REJECTED: 'Rejected by QA Lead',
  DEPT_HEAD_COE_APPROVAL_PENDING: 'Executive COE Approval Pending',
  RETURNED_BY_DEPT_HEAD_COE: 'Returned by Executive COE',
  DEPT_HEAD_COE_REJECTED: 'Rejected by Executive COE',
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

// Deployment Environment / Target Promotion Environment must move strictly
// forward along this pipeline -- reported directly (e.g. Deployment=UAT must
// force Target=Pre-Production/Production, never SIT/UAT again or anything
// earlier). "Dev" is deliberately excluded -- neither field's own dropdown
// ever offers it (both already filter it out, see DetailsStep.tsx/
// Functional.tsx's Edit Details modal), so it's not part of this ordering.
// Mirrors backend/app/constants.py's ENVIRONMENT_PIPELINE_ORDER exactly.
export const ENVIRONMENT_PIPELINE_ORDER: string[] = ['SIT', 'UAT', 'Pre-Production', 'Production']

// Every Target Promotion Environment option that is strictly later than the
// given Deployment Environment in the pipeline above -- used to populate the
// Target dropdown so an invalid combination can't even be selected in the
// first place (rather than only being caught after the fact by
// validEnvironmentPromotion below). Returns every non-"Dev" environment if
// `environment` isn't a recognised pipeline stage yet (e.g. still blank).
export function validTargetPromotionOptions(environment: string): string[] {
  const idx = ENVIRONMENT_PIPELINE_ORDER.indexOf(environment)
  if (idx === -1) return ENVIRONMENT_PIPELINE_ORDER.slice()
  return ENVIRONMENT_PIPELINE_ORDER.slice(idx + 1)
}

// Same ordering rule as backend/app/constants.py's
// validate_environment_promotion -- used to gate Next/Submit/Save so a
// combination that somehow got out of sync (e.g. Deployment Environment
// changed after Target was already picked) is still caught, not just
// prevented from being freshly selected via validTargetPromotionOptions.
export function validEnvironmentPromotion(environment: string, targetPromotionEnvironment: string): boolean {
  const envIdx = ENVIRONMENT_PIPELINE_ORDER.indexOf(environment)
  const targetIdx = ENVIRONMENT_PIPELINE_ORDER.indexOf(targetPromotionEnvironment)
  if (envIdx === -1 || targetIdx === -1) return true
  return targetIdx > envIdx
}
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

// ---- Test Management (Project Management / Test Repository / Test Execution) ----
// Mirrors backend constants.py's own Test Management block exactly -- see
// models.TestProject's header comment for the feature's overall design.
export const TEST_CASE_TYPES: string[] = [
  'Functional Positive', 'Functional Negative', 'Regression', 'Sanity',
  'Integration', 'Security', 'Performance', 'UAT', 'Other',
]
export const TEST_CASE_STATUSES: string[] = ['Active', 'Draft', 'Deprecated']
export const TEST_CASE_STATUS_LABELS: Record<string, string> = {
  Draft: 'Pending QA Lead Review',
  Active: 'Approved',
  Deprecated: 'Deprecated',
}
export const TEST_CASE_PRIORITIES: string[] = PRIORITIES
export const TEST_CYCLE_STATUSES: string[] = ['Not Started', 'In Progress', 'Completed']
export const TEST_EXECUTION_STATUSES: string[] = ['Not Executed', 'Pass', 'Fail', 'Blocked', 'NA', 'Retest Passed']
export const TEST_EXECUTION_TERMINAL_STATUSES: string[] = ['Pass', 'Fail', 'NA', 'Retest Passed']
