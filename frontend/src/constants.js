export const ROLE_LABELS = {
  REQUESTER: 'Requester (Developer) / Others',
  BUSINESS_ANALYST: 'Business Analyst',
  QA_ENGINEER: 'QA Engineer (QA)',
  QA_LEAD: 'QA Lead',
  DEPARTMENT_HEAD_COE: 'Executive COE (AGM-QA)',
  SECURITY_ANALYST: 'Security Analyst (QA)',
  APPLICATION_OWNER: 'Application Owner',
  DEPARTMENT_HEAD: 'Department Head - CM/AGM',
  ADMIN: 'Administrator',
}

export const ALL_ROLES = Object.keys(ROLE_LABELS)

// A user may hold several roles at once (all active simultaneously) -- this
// passes if the user has ANY of the given roles (ADMIN always passes).
export function hasRole(user, ...roles) {
  const userRoles = user?.roles || []
  if (userRoles.includes('ADMIN')) return true
  return roles.some((r) => userRoles.includes(r))
}

// Fixed list of departments (Admin section: user mapping = department +
// role(s)), rendered as a searchable dropdown. Mirrors backend constants.py.
export const DEPARTMENTS = [
  'Information Technology Department',
  'Digital Banking Department (DBD)',
  'Software',
  'QA Team',
  'Information Security',
  'Core Banking Systems (CBS)',
  'Human Resources (HR)',
  'Business Development',
  'Operations',
  'Compliance',
  'Finance & Accounts',
  'Risk Management',
  'Internal Audit',
]

// Mirrors backend constants.py DEFAULT_CHECKLIST_ITEMS / CONDITIONAL_CHECKLIST_ITEMS.
export const DEFAULT_CHECKLIST_ITEMS = [
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

export const CONDITIONAL_CHECKLIST_ITEMS = {
  'SAST readiness': 'SAST',
  'DAST readiness': 'DAST',
}

// The QA Request lifecycle (must mirror backend app/constants.py QAStatus).
// Requester -> Department Head Approval (assigns QA Lead) -> QA Lead starts
// Readiness Verification -> QA activity -> Sign-off -> Requester
// Verification -> Closed.
export const QA_STATUSES = [
  'DRAFT', 'SUBMITTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_REJECTED',
  'QA_LEAD_ASSIGNED',
  'READINESS_VERIFICATION', 'RETURNED_BY_QA_LEAD', 'QA_ACTIVITY_INITIATED',
  'PLANNING', 'TESTER_ASSIGNED', 'TEST_DESIGN', 'EXECUTION_IN_PROGRESS', 'DEFECT_RAISED',
  'WAITING_FOR_FIX', 'RETESTING', 'REGRESSION_TESTING', 'QA_COMPLETED', 'QA_SIGNOFF_PENDING',
  'QA_SIGNED_OFF', 'REQUESTER_VERIFICATION', 'CLOSED', 'CANCELLED',
]

export const QA_STATUS_LABELS = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted',
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
export const QA_EDITABLE_STATUSES = ['DRAFT', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD']
// Terminal statuses -- no further transitions possible.
export const QA_TERMINAL_STATUSES = ['CLOSED', 'CANCELLED', 'DEPARTMENT_HEAD_REJECTED']
// Statuses from which the request may still be cancelled -- mirrors backend
// constants.py QA_REQUEST_CANCELLABLE_STATUSES. Once the Department Head
// approves and a QA Lead is assigned, cancellation is no longer offered.
export const QA_CANCELLABLE_STATUSES = ['DRAFT', 'SUBMITTED', 'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD']
// "In flight" statuses used for nav-count badges / active-project metrics.
export const QA_ACTIVE_STATUSES = QA_STATUSES.filter(
  (s) => s !== 'DRAFT' && !QA_TERMINAL_STATUSES.includes(s)
)

// Admin section: account authentication type (must mirror backend LoginType).
export const LOGIN_TYPES = ['STANDARD', 'LDAP']
export const LOGIN_TYPE_LABELS = {
  STANDARD: 'Standard (local password)',
  LDAP: 'LDAP / Active Directory',
}

export const REQUEST_TYPES = [
  'Functional Testing', 'Sanity Testing', 'Regression Testing', 'UAT Support',
  'Performance Testing', 'SAST', 'DAST', 'Automation Testing', 'Others',
]

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']
export const RISK_RATINGS = ['Critical', 'High', 'Medium', 'Low']
export const ENVIRONMENTS = ['Dev', 'SIT', 'UAT', 'Pre-Production', 'Production']
export const TEST_TYPES = ['Functional', 'Sanity', 'Regression', 'UAT', 'Performance', 'Automation', 'Security']
export const RUN_TYPES = ['Release-wise', 'Sprint-wise', 'Regression']
export const EXECUTION_STATUSES = ['Not Started', 'In Progress', 'Passed', 'Failed', 'Blocked', 'Retest Passed', 'NA']
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational']
export const CERTIFICATE_TYPES = ['Full Clearance', 'Conditional Clearance', 'Clearance Denied']
export const SIGNOFF_TESTING_TYPES = ['Functional', 'SAST', 'DAST']
export const RISK_TIERS = ['Tier 1 (Critical)', 'Tier 2 (High)', 'Tier 3 (Medium)', 'Tier 4 (Low)']

// Test Case Repository / Test Execution Management (Modules 2 & 3) are
// temporarily DISABLED -- portal is currently focused on the QA Request
// module only, so 'project-testing-status', 'test-case-execution',
// 'requirement-traceability-matrix', 'defect-summary' and
// 'resource-utilization' are removed from the Reports & Export Centre
// listing (their backend endpoints are commented out to match, in
// app/routers/reports.py). Re-add these entries when those modules return.
export const REPORTS = [
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
