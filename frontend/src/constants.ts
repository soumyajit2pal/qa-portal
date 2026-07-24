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

// Mirrors backend constants.py DEFAULT_CHECKLIST_ITEMS / CONDITIONAL_CHECKLIST_ITEMS.
export const DEFAULT_CHECKLIST_ITEMS: ChecklistItemDef[] = [
  { item: 'BRD / FRS / User Stories approved', owner: 'Business / BA' },
  { item: 'Scope finalized & change freeze', owner: 'Business / IT' },
  { item: 'Test Environment availability (UAT / SIT)', owner: 'Business' },
  { item: 'Test data creation', owner: 'User dept / Dev team' },
  { item: 'Assess Test Scenarios', owner: 'User Dept' },
  { item: 'Project walkthrough to QA', owner: 'User Dept / Dev team' },
  { item: 'Application builds deployed & validated', owner: 'Dev team / Business' },
  { item: 'Security access (VPN Proxy/URLs whitelisting/credentials/firewall)', owner: 'User dept' },
  { item: 'SAST readiness', owner: 'User dept' },
  { item: 'DAST readiness', owner: 'User dept' },
]

export const CONDITIONAL_CHECKLIST_ITEMS: Record<string, string> = {
  'SAST readiness': 'SAST',
  'DAST readiness': 'DAST',
}

// The QA Request lifecycle (must mirror backend app/constants.py QAStatus).
// Requester -> Draft -> Submit to SM -> SM Approval -> Department Head
// Approval (assigns QA Lead) -> QA Lead starts Readiness Verification -> QA
// activity -> Sign-off -> Requester Verification -> Closed.
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

// Statuses from which the requester may still edit the request.
export const QA_EDITABLE_STATUSES: string[] = ['DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD']
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
// app/constants.py SAST_DAST_STATUSES). Requested -> Submit -> SM Approval ->
// Department Head Approval -> Readiness Check (QA Lead / Security Analyst) ->
// Allocated -> Scanning -> [vulnerability found -> Waiting For Fix -> fix ->
// Scanning again] -> Security Complete -> Report Ready (blocked while a
// linked Suppression request isn't Done yet).
export const SAST_DAST_STATUSES: string[] = [
  'Requested', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD',
  'READINESS_CHECK', 'RETURNED_BY_QA_LEAD',
  'Allocated', 'Scanning', 'WAITING_FOR_FIX', 'SECURITY_COMPLETE', 'Report Ready', 'Closed',
]

export const SAST_DAST_STATUS_LABELS: Record<string, string> = {
  Requested: 'Requested (Draft)',
  SM_APPROVAL_PENDING: 'SM Approval Pending',
  RETURNED_BY_SM: 'Returned by SM',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head Approval Pending',
  RETURNED_BY_DEPARTMENT_HEAD: 'Returned by Department Head',
  READINESS_CHECK: 'Readiness Check',
  RETURNED_BY_QA_LEAD: 'Returned by QA Lead',
  Allocated: 'Allocated',
  Scanning: 'Scanning',
  WAITING_FOR_FIX: 'Waiting For Fix (Requester)',
  SECURITY_COMPLETE: 'Security Complete',
  'Report Ready': 'Report Ready',
  Closed: 'Closed',
}

export const SAST_DAST_EDITABLE_STATUSES: string[] = [
  'Requested', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD',
]
export const SAST_DAST_TERMINAL_STATUSES: string[] = ['Report Ready', 'Closed']

// ---- Suppression request lifecycle (Application Owner step removed --
// must mirror backend app/constants.py SUPPRESSION_STATUSES). Requester ->
// Draft -> Submit to SM -> SM assigns to Department Head -> Department Head
// -> Security Team verification -> Done / Rejected.
export const SUPPRESSION_STATUSES: string[] = [
  'Draft', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD',
  'SECURITY_TEAM_VERIFICATION', 'Done', 'Rejected',
]

export const SUPPRESSION_STATUS_LABELS: Record<string, string> = {
  Draft: 'Draft',
  SM_APPROVAL_PENDING: 'SM Approval Pending',
  RETURNED_BY_SM: 'Returned by SM',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head Approval Pending',
  RETURNED_BY_DEPARTMENT_HEAD: 'Returned by Department Head',
  SECURITY_TEAM_VERIFICATION: 'Security Team Verification',
  Done: 'Done',
  Rejected: 'Rejected',
}

export const SUPPRESSION_TERMINAL_STATUSES: string[] = ['Done', 'Rejected']

// Admin section: account authentication type (must mirror backend LoginType).
export const LOGIN_TYPES: string[] = ['STANDARD', 'LDAP']
export const LOGIN_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Standard (local password)',
  LDAP: 'LDAP / Active Directory',
}

export const REQUEST_TYPES: string[] = [
  'Functional Testing', 'Sanity Testing', 'Regression Testing', 'UAT Support',
  'Performance Testing', 'SAST', 'DAST', 'Automation Testing', 'Others',
]

export const PRIORITIES: string[] = ['Critical', 'High', 'Medium', 'Low']
export const RISK_RATINGS: string[] = ['Critical', 'High', 'Medium', 'Low']
export const ENVIRONMENTS: string[] = ['Dev', 'SIT', 'UAT', 'Pre-Production', 'Production']
export const TEST_TYPES: string[] = ['Functional', 'Sanity', 'Regression', 'UAT', 'Performance', 'Automation', 'Security']
export const RUN_TYPES: string[] = ['Release-wise', 'Sprint-wise', 'Regression']
export const EXECUTION_STATUSES: string[] = ['Not Started', 'In Progress', 'Passed', 'Failed', 'Blocked', 'Retest Passed', 'NA']
export const SEVERITIES: string[] = ['Critical', 'High', 'Medium', 'Low', 'Informational']
export const CERTIFICATE_TYPES: string[] = ['Full Clearance', 'Conditional Clearance', 'Clearance Denied']
export const SIGNOFF_TESTING_TYPES: string[] = ['Functional', 'SAST', 'DAST']
export const RISK_TIERS: string[] = ['Tier 1 (Critical)', 'Tier 2 (High)', 'Tier 3 (Medium)', 'Tier 4 (Low)']

export interface ReportDef {
  key: string
  label: string
  group: string
}

// Test Case Repository / Test Execution Management (Modules 2 & 3) are
// temporarily DISABLED -- portal is currently focused on the QA Request
// module only, so 'project-testing-status', 'test-case-execution',
// 'requirement-traceability-matrix', 'defect-summary' and
// 'resource-utilization' are removed from the Reports & Export Centre
// listing (their backend endpoints are commented out to match, in
// app/routers/reports.py). Re-add these entries when those modules return.
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
