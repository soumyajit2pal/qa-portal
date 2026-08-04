export const ROLE_LABELS: Record<string, string> = {
  REQUESTER: 'Requester / Others',
  BUSINESS_ANALYST: 'Business Analyst',
  QA_ENGINEER: 'QA Engineer (QA)',
  QA_LEAD: 'QA Lead',
  // Split from a single DEPARTMENT_HEAD_COE role (2026-08) into two roles
  // with IDENTICAL authority -- same rationale as the DEPARTMENT_HEAD_CM/
  // DEPARTMENT_HEAD_AGM split below: every hasRole(user, 'DEPARTMENT_HEAD_COE')
  // check now checks both, so either can approve the Executive COE / QA
  // Sign-off checkpoint. Purely so approval logs show the exact position.
  DEPARTMENT_HEAD_COE_CM: 'Chief Manager - COE',
  DEPARTMENT_HEAD_COE_AGM: 'Assistant General Manager - COE',
  SECURITY_ANALYST: 'Security Analyst (QA)',
  APPLICATION_OWNER: 'Application Owner',
  // Split from a single DEPARTMENT_HEAD role (2026-08) into two roles with
  // IDENTICAL authority everywhere -- every hasRole(user, 'DEPARTMENT_HEAD')
  // check now checks both, so either can approve at any existing Department
  // Head checkpoint. Purely so approval logs can show the approver's exact
  // position (CM vs AGM) instead of a generic "Department Head" label.
  DEPARTMENT_HEAD_CM: 'Chief Manager - Department',
  DEPARTMENT_HEAD_AGM: 'Assistant General Manager - Department',
  // New checkpoint between Requester and Department Head on QA Request/
  // SAST-DAST/Suppression workflows. Label deliberately left as literal
  // "SM" per how it was specified -- rename to a fuller name here any time.
  SM: 'SM',
  ADMIN: 'Administrator',
}

export const ALL_ROLES = Object.keys(ROLE_LABELS)

// Mirror backend/app/constants.py's DEPARTMENT_ADMIN_ASSIGNABLE_ROLES /
// QA_ADMIN_ASSIGNABLE_ROLES exactly -- the working-level roles a local admin
// may assign to users in their own department via DepartmentAdmin.tsx,
// without needing a System Admin. Split in two (2026-08, per request) since
// a business Department Head and the QA department's own Executive COE
// oversee different teams: DEPARTMENT_ADMIN_ASSIGNABLE_ROLES for the former,
// QA_ADMIN_ASSIGNABLE_ROLES for the latter (which DepartmentAdmin.tsx picks
// between based on which kind of local admin is logged in). Both exclude
// ADMIN and DEPARTMENT_HEAD_CM/DEPARTMENT_HEAD_AGM/DEPARTMENT_HEAD_COE_CM/
// DEPARTMENT_HEAD_COE_AGM -- neither kind of local admin may mint peer
// department heads, Executive COE approvers, or other System Admins
// themselves.
export const DEPARTMENT_ADMIN_ASSIGNABLE_ROLES: string[] = [
  'REQUESTER', 'BUSINESS_ANALYST', 'APPLICATION_OWNER', 'SM',
]
export const QA_ADMIN_ASSIGNABLE_ROLES: string[] = [
  'QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST',
]

// QA Sign-off is an IT - QA-owned workflow even when its linked testing
// request came from another business department.
export const QA_DEPARTMENT = 'IT - QA'

// Mirrors backend/app/constants.py's APPLICATION_MASTER_STATUS_LABELS
// exactly -- a brand-new Application Name goes through two approval tiers
// (PENDING_APP_OWNER, then PENDING_SM) before becoming APPROVED; either
// tier can REJECT it, which is terminal. See ApplicationNameBanner.tsx.
export const APPLICATION_MASTER_STATUS_LABELS: Record<string, string> = {
  PENDING_APP_OWNER: 'Pending Application Owner Approval',
  PENDING_SM: 'Pending SM Approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
}

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

// Functional's "Ready for Testing" readiness checklist used to be hardcoded
// here (DEFAULT_CHECKLIST_ITEMS) -- Admin-configurable now (Admin >
// Readiness Checklist Configuration) and fetched live via
// useChecklistTemplate('FUNCTIONAL') (see
// QARequests/steps/useChecklistTemplate.ts), which returns
// ChecklistTemplateItemOut (types.ts) rows instead of a static list.

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
// "Pending With" -- who needs to act next, for the list table column of the
// same name. The gateway itself has no approval chain of its own (Draft ->
// Submitted -> Raised happens in one step -- see routers/qa_requests.py); once
// Raised, the real workflow lives on the linked Functional/SAST/DAST/
// Performance request(s), so this deliberately points there rather than
// naming a role that has nothing further to do on the gateway record itself.
export const GATEWAY_PENDING_WITH: Record<string, string> = {
  DRAFT: 'Requester', SUBMITTED: 'Requester',
  RAISED: 'See linked requests', CANCELLED: '—',
}

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
  'WAITING_FOR_FIX', 'RETESTING', 'QA_COMPLETED', 'QA_SIGNOFF_PENDING',
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
  WAITING_FOR_FIX: 'Waiting For Fix', RETESTING: 'Retesting',
  QA_COMPLETED: 'QA Completed', QA_SIGNOFF_PENDING: 'QA Sign-off Pending', QA_SIGNED_OFF: 'QA Signed Off',
  REQUESTER_VERIFICATION: 'Requester Verification', CLOSED: 'Closed', CANCELLED: 'Cancelled',
}

// "Pending With" -- who needs to act next, for the list table column of the
// same name. Mirrors dashboard.py's own STAGE_TEAM (backend, used by the 3W
// dashboard) exactly for every status it covers; DRAFT/CLOSED/CANCELLED/
// SM_REJECTED/DEPARTMENT_HEAD_REJECTED are added here since STAGE_TEAM only
// covers "in flight" statuses. "QA" (not "QA Lead") for the actual
// design/execution stages matches STAGE_TEAM's own team names -- see that
// map's comments for why DEFECT_RAISED/WAITING_FOR_FIX point at Requester
// even though a QA Lead/Engineer clicks the button that logs them.
export const QA_PENDING_WITH: Record<string, string> = {
  DRAFT: 'Requester', SUBMITTED: 'SM',
  // SM_REJECTED: reported directly -- reopenable by the requester (edit +
  // resubmit, same as RETURNED_BY_SM), not a dead end, so this is now
  // "Requester" instead of "--".
  SM_APPROVAL_PENDING: 'SM', RETURNED_BY_SM: 'Requester', SM_REJECTED: 'Requester',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head',
  RETURNED_BY_DEPARTMENT_HEAD: 'Requester', DEPARTMENT_HEAD_REJECTED: '—',
  QA_LEAD_ASSIGNED: 'QA Lead', READINESS_VERIFICATION: 'QA Lead', RETURNED_BY_QA_LEAD: 'Requester',
  QA_ACTIVITY_INITIATED: 'QA Lead', PLANNING: 'QA Lead',
  TESTER_ASSIGNED: 'QA', TEST_DESIGN: 'QA', EXECUTION_IN_PROGRESS: 'QA',
  DEFECT_RAISED: 'Requester', WAITING_FOR_FIX: 'Requester',
  RETESTING: 'QA',
  QA_COMPLETED: 'QA Lead', QA_SIGNOFF_PENDING: 'QA Lead',
  QA_SIGNED_OFF: 'Requester', REQUESTER_VERIFICATION: 'Requester',
  CLOSED: '—', CANCELLED: '—',
}

// Statuses from which the Functional Testing Request's own descriptive
// fields (currently just Priority/Risk Rating -- see PUT
// /api/functional-requests/{id}) can still be edited by *someone* --
// mirrors backend constants.FUNCTIONAL_EDITABLE_STATUSES, same pattern/
// values as SAST_DAST_EDITABLE_STATUSES/PERFORMANCE_EDITABLE_STATUSES below.
// Exactly who may edit at each of these is further scoped in Functional.tsx
// (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are that stage's
// own reviewer only, not the requester -- see canEditDetails there).
// SM_REJECTED: reported directly -- reopenable by the requester (edit
// details + resubmit, same path as RETURNED_BY_SM) instead of a dead end.
export const FUNCTIONAL_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD',
]
// Checklist evidence is normally collected before the Department Head
// decision and locked after approval. Any RETURNED_BY_* status is the
// deliberate exception: the request is back with the requester, who must be
// able to attach the evidence requested by whichever later stage returned it.
// SM_REJECTED is the same exception now that it's reopenable too.
export const READINESS_EVIDENCE_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD',
]
export function canManageReadinessEvidence(status?: string | null): boolean {
  return !!status && (
    READINESS_EVIDENCE_EDITABLE_STATUSES.includes(status)
    || status.startsWith('RETURNED_BY_')
  )
}
// Terminal statuses -- no further transitions possible. SM_REJECTED is
// deliberately NOT here -- reported directly, it's reopenable by the
// requester rather than a dead end. DEPARTMENT_HEAD_REJECTED is untouched.
export const QA_TERMINAL_STATUSES: string[] = ['CLOSED', 'CANCELLED', 'DEPARTMENT_HEAD_REJECTED']
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
// "Pending With" -- who needs to act next, for the list table column of the
// same name. Derived directly from each transition's require_roles() gate in
// routers/sast_dast.py (not guessed from the label text): SM/Department Head
// decide their own checkpoints; QA Lead runs Security Readiness through
// assigning a Security Analyst (SECURITY_LEAD_ASSIGNED/SECURITY_READINESS/
// PLANNING); the assigned Security Analyst owns everything from Configuration
// through Report Ready (_require_assigned_security_analyst gates all of
// those). WAITING_FOR_FIX points at Requester -- same reasoning as QA_PENDING_WITH's
// DEFECT_RAISED/WAITING_FOR_FIX -- even though a security analyst/admin may
// also click "Mark Fixed".
export const SAST_DAST_PENDING_WITH: Record<string, string> = {
  DRAFT: 'Requester', SUBMITTED: 'SM',
  // SM_REJECTED: reopenable by the requester (edit + resubmit), not a dead
  // end -- see SAST_DAST_TERMINAL_STATUSES below.
  SM_APPROVAL_PENDING: 'SM', RETURNED_BY_SM: 'Requester', SM_REJECTED: 'Requester',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head',
  RETURNED_BY_DEPARTMENT_HEAD: 'Requester', DEPARTMENT_HEAD_REJECTED: '—',
  SECURITY_LEAD_ASSIGNED: 'QA Lead', SECURITY_READINESS: 'QA Lead', RETURNED_BY_SECURITY_LEAD: 'Requester',
  PLANNING: 'QA Lead',
  CONFIGURATION: 'Security Analyst', SCANNING: 'Security Analyst',
  FINDING_VALIDATION: 'Security Analyst', REMEDIATION: 'Security Analyst',
  ASSIGNED_TO_REQUESTER: 'Requester', WAITING_FOR_FIX: 'Requester',
  ASSIGNED_TO_LEAD: 'Security Analyst', RESCAN: 'Security Analyst',
  SECURITY_COMPLETE: 'Security Analyst', REPORT_READY: 'Security Analyst',
  CLOSED: '—',
}

export const SAST_DAST_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD',
]
// SM_REJECTED deliberately NOT here -- reopenable by the requester, not a
// dead end (mirrors backend constants.SAST_DAST_TERMINAL_STATUSES).
export const SAST_DAST_TERMINAL_STATUSES: string[] = ['REPORT_READY', 'CLOSED', 'DEPARTMENT_HEAD_REJECTED']

// SAST/DAST's own "Security Readiness" pre-scan checklists used to be
// hardcoded here (DEFAULT_SAST_CHECKLIST_ITEMS/DEFAULT_DAST_CHECKLIST_ITEMS)
// -- both are Admin-configurable now (Admin > Readiness Checklist
// Configuration) and fetched live via useChecklistTemplate('SAST'/'DAST')
// (see QARequests/steps/useChecklistTemplate.ts), which returns
// ChecklistTemplateItemOut (types.ts) rows instead of a static list.

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
// SM_REJECTED deliberately NOT here -- reopenable by the requester, not a
// dead end (mirrors backend constants.PERFORMANCE_TERMINAL_STATUSES).
export const PERFORMANCE_TERMINAL_STATUSES: string[] = ['CLOSED', 'CANCELLED', 'DEPARTMENT_HEAD_REJECTED']
// "Pending With" -- who needs to act next, for the list table column of the
// same name. Derived from each transition's require_roles() gate in
// routers/performance.py: QA Lead owns Readiness through Result Analysis/
// Report/Sign-off; the assigned QA Lead/Engineer execution owner
// (_require_performance_execution_owner) owns Environment Setup through Load
// Test Execution, labeled "QA" here to match QA_PENDING_WITH's own team name
// for the equivalent Functional stages. DEFECT_FIX_RETEST points at Requester
// for the same reason QA_PENDING_WITH's DEFECT_RAISED does -- the actual fix
// happens on the requester/dev side even though QA clicks "Complete".
export const PERFORMANCE_PENDING_WITH: Record<string, string> = {
  DRAFT: 'Requester', SUBMITTED: 'SM',
  // SM_REJECTED: reopenable by the requester (edit + resubmit), not a dead
  // end -- see PERFORMANCE_TERMINAL_STATUSES above.
  SM_APPROVAL_PENDING: 'SM', RETURNED_BY_SM: 'Requester', SM_REJECTED: 'Requester',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head',
  RETURNED_BY_DEPARTMENT_HEAD: 'Requester', DEPARTMENT_HEAD_REJECTED: '—',
  ENGINEER_ASSIGNED: 'QA Lead', RETURNED_BY_ENGINEER: 'Requester',
  READINESS: 'QA Lead', FEASIBILITY: 'QA Lead', PLANNING: 'QA Lead',
  ENVIRONMENT_SETUP: 'QA', SCRIPT_DEVELOPMENT: 'QA', BASELINE: 'QA', LOAD_TEST_EXECUTION: 'QA',
  RESULT_ANALYSIS: 'QA Lead', DEFECT_FIX_RETEST: 'Requester', REPORT: 'QA Lead',
  SIGNOFF_PENDING: 'QA Lead', SIGNED_OFF: 'Requester', REQUESTER_VERIFICATION: 'Requester',
  CLOSED: '—', CANCELLED: '—',
}
// Who may edit at each of these is further scoped in Performance.tsx
// (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING are that stage's
// own reviewer only, not the requester -- see canEditDetails there).
export const PERFORMANCE_EDITABLE_STATUSES: string[] = [
  'DRAFT', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM', 'SM_REJECTED',
  'DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER',
]

// Request type checkboxes shown on the Performance Testing page of the QA
// Request form (Annexure VIII, item 3) -- must mirror backend
// app/constants.py PERFORMANCE_REQUEST_TYPES.
export const PERFORMANCE_REQUEST_TYPES: string[] = ['Load Testing', 'Stress Testing', 'Spike Testing']
// Annexure VIII, item 7.
export const CHANGE_TYPES: string[] = ['New', 'Enhancement', 'Bug Fix']

// Annexure VIII ("QA Request Form & Checklist (Performance Testing)"),
// table 2: "L1: Pre-Testing Readiness Checklist" -- 19 fixed items, used to
// be hardcoded here (DEFAULT_PERFORMANCE_CHECKLIST_ITEMS). Admin-configurable
// now (Admin > Readiness Checklist Configuration) and fetched live via
// useChecklistTemplate('PERFORMANCE') (see
// QARequests/steps/useChecklistTemplate.ts).

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
// "Pending With" -- who needs to act next, for the list table column of the
// same name. Derived from each transition's require_roles() gate in
// routers/suppression.py.
export const SUPPRESSION_PENDING_WITH: Record<string, string> = {
  Draft: 'Requester',
  SM_APPROVAL_PENDING: 'SM', RETURNED_BY_SM: 'Requester',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Department Head', RETURNED_BY_DEPARTMENT_HEAD: 'Requester',
  SECURITY_TEAM_VERIFICATION: 'Security Analyst', RETURNED_BY_SECURITY_TEAM: 'Requester',
  Done: '—', Rejected: '—',
}

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
// SM_REJECTED ("Rejected by QA Lead" -- see SIGNOFF_STATUS_LABELS above)
// included alongside RETURNED_BY_SM/RETURNED_BY_DEPT_HEAD_COE -- reopenable
// by the requester (edit + resubmit) rather than a dead end.
export const SIGNOFF_EDITABLE_STATUSES: string[] = ['DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPT_HEAD_COE']
export const SIGNOFF_TERMINAL_STATUSES: string[] = ['ISSUED', 'DEPT_HEAD_COE_REJECTED']
// "Pending With" -- who needs to act next, for the list table column of the
// same name. Derived from each transition's require_roles() gate in
// routers/signoff.py -- "Tester" (not "Requester") for the originator here,
// since that role is QA_ENGINEER, matching the "Tester -> QA Lead -> Executive
// COE" chain this workflow was built around.
export const SIGNOFF_PENDING_WITH: Record<string, string> = {
  DRAFT: 'Tester', SUBMITTED: 'QA Lead',
  SM_APPROVAL_PENDING: 'QA Lead', RETURNED_BY_SM: 'Tester', SM_REJECTED: '—',
  DEPT_HEAD_COE_APPROVAL_PENDING: 'Executive COE', RETURNED_BY_DEPT_HEAD_COE: 'Tester', DEPT_HEAD_COE_REJECTED: '—',
  ISSUED: '—',
}

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

// Reported directly: DAST scans and Performance tests are never run against
// Dev or SIT -- both are restricted to UAT and later. Simply
// ENVIRONMENT_PIPELINE_ORDER without its first entry (SIT); Dev was never in
// that list to begin with. Used by DastStep.tsx's own target Environment
// picker and PerformanceStep.tsx's Environment picker -- both offer only
// these three options, no blank/"Dev"/"SIT" choice. Mirrors backend
// app/constants.py's POST_SIT_ENVIRONMENTS exactly.
export const POST_SIT_ENVIRONMENTS: string[] = ENVIRONMENT_PIPELINE_ORDER.slice(1)

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
// "Pending With" -- who needs to act next, for the Test Repository list
// table's column of the same name. A testcase's only checkpoint is QA Lead
// verification (see TestRepository.tsx's review/bulk-approve flow); Active/
// Deprecated have nothing further pending.
export const TEST_CASE_PENDING_WITH: Record<string, string> = {
  Draft: 'QA Lead', Active: '—', Deprecated: '—',
}
export const TEST_CASE_PRIORITIES: string[] = PRIORITIES
export const TEST_CYCLE_STATUSES: string[] = ['Not Started', 'In Progress', 'Completed']
export const TEST_EXECUTION_STATUSES: string[] = ['Not Executed', 'Pass', 'Fail', 'Blocked', 'NA', 'Retest Passed']
export const TEST_EXECUTION_TERMINAL_STATUSES: string[] = ['Pass', 'Fail', 'NA', 'Retest Passed']
