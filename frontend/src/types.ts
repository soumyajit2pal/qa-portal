// Shared entity/DTO types for the frontend, mirroring backend/app/schemas.py
// (Pydantic `*Out` models -- the shapes actually returned by the API). Kept
// pragmatic: fields the UI never reads are still declared for accuracy, but
// ad-hoc, purely-local shapes (form state, etc.) are typed inline in each
// page rather than centralized here.

export interface UserOut {
  id: number
  username: string
  full_name: string
  email?: string | null
  department?: string | null
  roles: string[]
  login_type: string
  is_active: boolean
  needs_role_review: boolean
  // True right after this person's first-ever LDAP login, until they pick
  // their own department via the department-selection popup (see
  // components/DepartmentPrompt.tsx, PATCH /api/auth/me).
  needs_department_selection: boolean
  // System-Admin-only flag (see backend models.User.admin_managed_only) --
  // when true, this user is hidden from Department Admin / Executive COE
  // rosters (DepartmentAdmin.tsx) and only a System Admin (Admin.tsx) can
  // reassign their role(s) or activate/deactivate them.
  admin_managed_only: boolean
}

export interface AuditLogOut {
  id: number
  event_type: string
  action: string
  outcome: string
  actor_id?: number | null
  actor_username?: string | null
  actor_name?: string | null
  actor_roles?: string | null
  method?: string | null
  path?: string | null
  status_code?: number | null
  target_type?: string | null
  target_id?: string | null
  target_name?: string | null
  details?: string | null
  ip_address?: string | null
  user_agent?: string | null
  request_id?: string | null
  created_at: string
}

export interface AuditLogPage {
  rows: AuditLogOut[]
  total: number
  page: number
  page_size: number
  summary: {
    total: number
    failed: number
    authentication: number
    access_management: number
  }
}

// Departments are DB-backed (see backend app/models.py Department, managed
// via /api/departments) -- fetched at render time everywhere a department
// picker is shown, instead of importing a hardcoded list.
export interface DepartmentOut {
  id: number
  name: string
  is_active: boolean
}

// ---------------- Configurable Readiness Checklists ----------------
// See backend models.ChecklistTemplateItem / checklist_config.py.
export interface ChecklistTemplateItemOut {
  id: number
  module: string
  item: string
  detail?: string | null
  is_mandatory: boolean
  sort_order: number
  active: boolean
}

// ---------------- Application Name Master ----------------
export interface ApplicationMasterOut {
  id: number
  name: string
  status: string
  department?: string | null
  requested_by_id?: number | null
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  // Application Owner tier -- populated once an Application Owner has
  // decided (see backend models.ApplicationMaster's two-tier docstring).
  app_owner_decided_by_id?: number | null
  app_owner_decided_at?: string | null
  app_owner_comments?: string | null
  decided_by_id?: number | null
  decided_at?: string | null
  comments?: string | null
  created_at: string
}

export interface ApplicationSeedResult {
  created: number
  approved_existing: number
  skipped_duplicate: number
  skipped_rejected: number
  skipped_invalid: number
  errors: string[]
  failure_reason?: string | null
}

// ---------------- QA Request ----------------
export interface ChecklistItemOut {
  id: number
  item: string
  owner?: string | null
  is_mandatory: boolean
  requester_checked: boolean
  is_complete: boolean
  approved_by_id?: number | null
  approved_at?: string | null
}

export interface LinkedRequestRef {
  id: number
  request_id: string
  status?: string | null
  // Only one of risk_rating (Functional)/risk_category (SAST/DAST/
  // Performance) is ever populated for a given row -- see
  // backend schemas.LinkedRequestRef.
  priority?: string | null
  risk_rating?: string | null
  risk_category?: string | null
}

// Minimal cross-reference the other direction from LinkedRequestRef -- one
// of the Suppression / False Positive requests raised against a given
// SAST/DAST request -- see backend schemas.LinkedSuppressionRef.
export interface LinkedSuppressionRef {
  id: number
  suppression_id: string
  status?: string | null
}

export interface QARequestDocumentOut {
  id: number
  file_name: string
  content_type?: string | null
  file_size?: number | null
  uploaded_by_id?: number | null
  uploaded_at: string
}

// Same shape as QARequestDocumentOut -- used by the /documents endpoints on
// every other module (Functional/SAST/DAST/Performance/
// Suppression/Sign-off), backed by the shared models.RequestDocument table.
export type RequestDocumentOut = QARequestDocumentOut

// Response shape for GET /api/qa-requests/{id}/checklist-evidence/documents
// -- the batched fetch of every readiness-checklist evidence document for a
// Draft QA Request in one call (see NewRequestModal.tsx), tagged with which
// checklist item each document belongs to so the flat list can be regrouped
// client-side using the same evidenceKey(kind, item_index) keying already
// used for not-yet-uploaded pending files.
export interface DraftChecklistEvidenceOut extends QARequestDocumentOut {
  kind: string
  item_index: number
}

// Response shape for GET .../checklist/documents on a raised (post-Draft)
// Functional/SAST/DAST/Performance request -- the batched counterpart to
// the per-item .../checklist/{item_id}/documents endpoint, tagged with
// item_id so the flat list can be regrouped client-side (see
// useChecklistDocuments in components/Common.tsx).
export interface ChecklistItemDocumentOut extends QARequestDocumentOut {
  item_id: number
}

// The QA Request is a pure intake/gateway record -- `status` here is just
// Draft/Submitted/Raised/Cancelled (see constants.GATEWAY_STATUSES). The
// real workflow state lives on whichever linked child request(s) below were
// auto-raised (see FunctionalOut for the Functional/Sanity/Regression
// Testing/UAT Support bucket's own full lifecycle).
export interface QARequestOut {
  id: number
  // Only assigned once this gateway is actually raised -- null while Draft.
  request_id?: string | null
  request_date?: string | null
  department?: string | null
  application_name: string
  application_owner?: string | null
  cr_number?: string | null
  epic_number?: string | null
  change_type?: string | null
  vendor_si_partner?: string | null
  technology_stack?: string | null
  release_version?: string | null
  build_number?: string | null
  environment?: string | null
  target_promotion_environment?: string | null
  request_types?: string | null
  request_type_other?: string | null
  target_release_date?: string | null
  supporting_doc_path?: string | null
  remarks?: string | null
  status: string
  requester_id?: number | null
  created_at: string
  updated_at: string
  // See backend models.ApplicationMaster -- live approval status of this
  // request's own Application Name (set on every create/edit); id lets an
  // SM's Approve/Reject action target the right master row.
  application_master_id?: number | null
  application_master_status?: string | null
  linked_functional_requests: LinkedRequestRef[]
  linked_sast_requests: LinkedRequestRef[]
  linked_dast_requests: LinkedRequestRef[]
  linked_performance_requests: LinkedRequestRef[]
  // Whatever the wizard's SAST/DAST/Performance/checklist steps collected on
  // an earlier Draft save (see models.QARequest.draft_child_details) --
  // read-only, used to pre-fill "Edit Request" instead of showing these
  // blank again. Always empty once this request has been raised.
  draft_checked_items: string[]
  draft_sast_components: SASTComponentIn[]
  draft_dast_components: DASTTargetIn[]
  draft_performance: Record<string, string>
  draft_performance_checked_items: string[]
  // Same pre-fill purpose as draft_checked_items above, for SAST's/DAST's own
  // Security Readiness checklist self-declaration.
  draft_sast_checked_items: string[]
  draft_dast_checked_items: string[]
  // Per-request-type Priority/Risk Category values collected on an earlier
  // Draft save (e.g. { functional_priority: 'High', sast_risk_category:
  // 'Critical', ... }) -- same pre-fill purpose as the draft_* fields above.
  draft_classification: Record<string, string>
}

// ---------------- Functional Testing Request ----------------
// Carries the full Draft -> SM -> Department Head -> QA Lead -> ... ->
// Closed lifecycle that used to live directly on QARequestOut. Descriptive
// fields are delegated (read-only) from the linked qa_request.
export interface FunctionalOut {
  id: number
  request_id: string
  status: string
  needs_dept_head_reapproval: boolean
  requester_id?: number | null
  department_head_id?: number | null
  qa_lead_id?: number | null
  assigned_tester_ids?: string | null
  signoff_id?: number | null
  created_at: string
  updated_at: string
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  application_name?: string | null
  epic_number?: string | null
  department?: string | null
  application_owner?: string | null
  priority?: string | null
  risk_rating?: string | null
  request_types?: string | null
  target_release_date?: string | null
  // Delegated (read-only unless edited via PUT /api/functional-requests/{id},
  // which writes these through to the parent qa_request) -- see
  // models.FunctionalRequest.
  cr_number?: string | null
  change_type?: string | null
  environment?: string | null
  target_promotion_environment?: string | null
  release_version?: string | null
  build_number?: string | null
  technology_stack?: string | null
  // See backend models.ApplicationMaster -- delegated the same way as
  // application_name/epic_number/etc. above, so an SM reviewing this
  // request's own SM Approval step can see (and act on) a pending new
  // Application Name right from this request's own detail view.
  application_master_id?: number | null
  application_master_status?: string | null
  // "Ready for Testing" readiness checklist -- see ChecklistItemOut. Lets
  // the Edit Details modal show/refresh a self-declaration section, same
  // as SASTOut/DASTOut/PerformanceOut's own checklist_items.
  checklist_items: ChecklistItemOut[]
}

export interface ApprovalActionOut {
  id: number
  entity_type: string
  entity_id: number
  request_ref?: string | null
  step_name?: string | null
  actor_id?: number | null
  actor_name?: string | null
  actor_role?: string | null
  decision?: string | null
  comments?: string | null
  created_at: string
}

// ---------------- SAST / DAST ----------------
export interface SASTFindingOut {
  id: number
  issue_id?: string | null
  severity: string
  description?: string | null
  status: string
}

// One repository row -- replaces the old design where Repository URL/
// Branch/Commit ID/Tech Stack/Build Number were each comma-joined into a
// single column (e.g. build_number = "1.1, 1.1"). One real DB row per
// repository now (see backend models.SASTComponent).
export interface SASTComponentOut {
  id: number
  repository_url?: string | null
  git_branch?: string | null
  commit_id?: string | null
  technology_stack?: string | null
  build_number?: string | null
}

// Same shape, used when creating/replacing components (no `id` yet).
export interface SASTComponentIn {
  repository_url?: string | null
  git_branch?: string | null
  commit_id?: string | null
  technology_stack?: string | null
  build_number?: string | null
}

export interface SASTOut {
  id: number
  request_id: string
  application_name: string
  epic_number?: string | null
  cr_number?: string | null
  risk_category?: string | null
  priority?: string | null
  hash_value?: string | null
  status: string
  needs_dept_head_reapproval: boolean
  report_path?: string | null
  requester_id?: number | null
  security_lead_id?: number | null
  security_analyst_id?: number | null
  created_at: string
  updated_at: string
  findings: SASTFindingOut[]
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
  // See backend models.ApplicationMaster -- delegated the same way as
  // department/application_owner above, so an SM reviewing this request's
  // own SM Approval step can see (and act on) a pending new Application
  // Name right from this request's own detail view.
  application_master_id?: number | null
  application_master_status?: string | null
  environment?: string | null
  target_promotion_environment?: string | null
  // One row per repository -- see SASTComponentOut above.
  components: SASTComponentOut[]
  // "Security Readiness" pre-scan checklist -- see backend
  // models.SASTChecklistItem. Reuses ChecklistItemOut, same shape as
  // Functional's own checklist item.
  checklist_items: ChecklistItemOut[]
  // Every Suppression / False Positive request raised against this SAST
  // request -- see backend models.SASTRequest.suppressions.
  suppressions: LinkedSuppressionRef[]
}

export interface DASTFindingOut {
  id: number
  issue_id?: string | null
  severity: string
  description?: string | null
  status: string
}

// One scan target row -- replaces the old design where Application URL/
// Environment/Authentication Required/Test Credentials were each
// newline-joined into a single column. One real DB row per target now (see
// backend models.DASTTarget).
export interface DASTTargetOut {
  id: number
  application_url: string
  environment?: string | null
  // "Yes"/"No" -- no longer a plain boolean.
  authentication_required?: string | null
  // Sensitive -- only populated by the API for the requester or a security
  // analyst/admin; blanked out server-side (per-row) for every other viewer
  // (see _dast_out in routers/sast_dast.py).
  test_credentials?: string | null
}

// Same shape, used when creating/replacing targets (no `id` yet).
export interface DASTTargetIn {
  application_url?: string | null
  environment?: string | null
  authentication_required?: string | null
  test_credentials?: string | null
}

export interface DASTOut {
  id: number
  request_id: string
  risk_category?: string | null
  priority?: string | null
  status: string
  needs_dept_head_reapproval: boolean
  report_path?: string | null
  requester_id?: number | null
  security_lead_id?: number | null
  security_analyst_id?: number | null
  created_at: string
  updated_at: string
  findings: DASTFindingOut[]
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
  // See backend models.ApplicationMaster -- delegated the same way as
  // department/application_owner above, so an SM reviewing this request's
  // own SM Approval step can see (and act on) a pending new Application
  // Name right from this request's own detail view.
  application_master_id?: number | null
  application_master_status?: string | null
  // Delegated from the QA Request gateway -- collected once, at QA Request
  // creation time. No separate target_release field anymore.
  target_release_date?: string | null
  // DAST has no columns of its own for these -- delegated from the gateway.
  application_name?: string | null
  epic_number?: string | null
  cr_number?: string | null
  deployment_environment?: string | null
  target_promotion_environment?: string | null
  // One row per scan target -- see DASTTargetOut above.
  targets: DASTTargetOut[]
  // "Security Readiness" pre-scan checklist -- see backend
  // models.DASTChecklistItem, same shape as SASTOut.checklist_items above.
  checklist_items: ChecklistItemOut[]
  // See SASTOut.suppressions above -- same idea, for DAST.
  suppressions: LinkedSuppressionRef[]
}

// A combined SAST/DAST record used by the Suppression "Request ID"
// autosuggest, which searches both together (see modules/security/Suppression.tsx).
export type CombinedSecurityRequest = (SASTOut | DASTOut) & { _kind: 'SAST' | 'DAST' }

// ---------------- Performance Testing ----------------
export interface PerformanceChecklistItemOut {
  id: number
  item: string
  data_required?: string | null
  is_mandatory: boolean
  requester_checked: boolean
  is_complete: boolean
  approved_by_id?: number | null
  approved_at?: string | null
}

export interface PerformanceOut {
  id: number
  request_id: string
  application_name: string
  epic_number?: string | null
  cr_number?: string | null
  tool_used?: string | null
  target_load?: string | null
  environment?: string | null
  risk_category?: string | null
  priority?: string | null
  // ---- Annexure VIII fields ----
  request_type?: string | null
  change_type?: string | null
  vendor_si_partner?: string | null
  technology_stack?: string | null
  release_version?: string | null
  build_number?: string | null
  hash_value?: string | null
  target_promotion_environment?: string | null
  status: string
  needs_dept_head_reapproval: boolean
  report_path?: string | null
  requester_id?: number | null
  engineer_id?: number | null
  assigned_tester_ids?: string | null
  created_at: string
  updated_at: string
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
  // See backend models.ApplicationMaster -- delegated the same way as
  // department/application_owner above, so an SM reviewing this request's
  // own SM Approval step can see (and act on) a pending new Application
  // Name right from this request's own detail view.
  application_master_id?: number | null
  application_master_status?: string | null
  checklist_items: PerformanceChecklistItemOut[]
}

// ---------------- Suppression ----------------
export interface SuppressionItemOut {
  id: number
  issue_id?: string | null
  severity: string
  description?: string | null
  justification?: string | null
}

export interface SuppressionOut {
  id: number
  suppression_id: string
  application_name: string
  scan_type: string
  department?: string | null
  application_owner?: string | null
  sast_request_id?: number | null
  dast_request_id?: number | null
  // Whichever of sast_request_id/dast_request_id is set, resolved to its
  // human-readable Request ID -- see backend schemas.SuppressionOut.
  linked_request?: LinkedRequestRef | null
  risk_assessment?: string | null
  items: SuppressionItemOut[]
  status: string
  created_by_id?: number | null
  sm_decision?: string | null
  dept_head_decision?: string | null
  security_decision?: string | null
  created_at: string
}

// ---------------- QA Sign-off ----------------
export interface SignOffOut {
  id: number
  certificate_id: string
  certificate_date?: string | null
  certificate_type: string
  testing_type: string
  testing_request_id?: string | null
  change_request_ids?: string | null
  application_name: string
  application_owner?: string | null
  department?: string | null
  vendor_si_partner?: string | null
  technology_stack?: string | null
  risk_tier?: string | null
  release_version?: string | null
  build_number?: string | null
  environment_tested?: string | null
  target_promotion_environment?: string | null
  validity_from?: string | null
  validity_to?: string | null
  exit_criteria_notes?: string | null
  open_defect_summary?: string | null
  residual_risk_notes?: string | null
  status: string
  // Requested By (QA Team) / Approved By (QA Lead) / Approved By
  // (Executive COE) -- see backend models.QASignOff.
  requester_id?: number | null
  reviewed_by_id?: number | null
  approved_by_id?: number | null
  // Vestigial -- see backend models.QASignOff.
  issued_by_id?: number | null
  signed_by_id?: number | null
  created_at: string
  updated_at: string
}

// ---------------- Dashboard ----------------
export interface ProjectWiseMetrics {
  active_projects: number
  sast_findings: number
  dast_findings: number
  pending_approvals: number
}

export interface ProjectWiseOut {
  metrics: ProjectWiseMetrics
  charts: { risk_distribution: Record<string, number> }
}

export interface ThreeWItem {
  project_id: string
  application_name?: string
  pending_stage: string
  responsible_team: string
  owner?: string | null
  department?: string | null
  ageing_days: number
  ageing_bucket: string
  priority?: string
  source?: string
}

export interface ThreeWOut {
  total_pending: number
  team_wise_distribution: Record<string, number>
  ageing_bucket_distribution: Record<string, number>
  priority_distribution: Record<string, number>
  items: ThreeWItem[]
}

export interface ThreeWDetailLifecycleEntry {
  step: string
  decision?: string
  actor_role?: string
  at: string
}

export interface ThreeWDetailChecklistEntry {
  complete: boolean
  item: string
  owner?: string
}

export interface ThreeWDetailOut {
  detail?: string
  project_id?: string
  application_name?: string
  status?: string
  ageing_days?: number
  lifecycle: ThreeWDetailLifecycleEntry[]
  readiness_checklist: ThreeWDetailChecklistEntry[]
}

export interface SecuritySastDashboard {
  total_requests: number
  applications_scanned: number
  open_vulnerabilities: number
  severity_distribution: Record<string, number>
  remediation_status: Record<string, number>
}

export interface SecurityDastDashboard {
  total_requests: number
  scan_coverage: number
  vulnerability_trends: Record<string, number>
  compliance_status: Record<string, number>
}

export interface SuppressionDashboard {
  open_suppressions: number
  critical_high_risk_exceptions: number
  status_breakdown: Record<string, number>
}

// ---------------- Test Management (Project Management / Test Repository / Test Execution) ----------------
// See backend models.TestProject's header comment for the full design --
// one Project per Application, a folder tree of Test Cases (with Steps)
// under it, and Test Cycles that record a Pass/Fail/Blocked/NA/Retest
// Passed result per test case run.
export interface TestProjectOut {
  id: number
  project_key: string
  name: string
  application_master_id?: number | null
  department?: string | null
  description?: string | null
  is_active: boolean
  created_by_id?: number | null
  created_at: string
  pending_is_active?: boolean | null
  pending_requested_by_id?: number | null
  pending_requested_by_name?: string | null
  pending_requested_at?: string | null
}

export interface TestFolderOut {
  id: number
  project_id: number
  parent_id?: number | null
  name: string
  created_by_id?: number | null
  created_by_name?: string | null
  created_at: string
}

export interface TestStepIn {
  step_no: number
  step_text?: string | null
  expected_result?: string | null
}

export type TestStepOut = TestStepIn & { id: number }

export interface TestCaseOut {
  id: number
  test_case_key: string
  project_id: number
  folder_id?: number | null
  folder_name?: string | null
  epic_id?: string | null
  cr_number?: string | null
  feature_id?: string | null
  user_story_id?: string | null
  test_type?: string | null
  module_name?: string | null
  test_scenario?: string | null
  pre_condition?: string | null
  description?: string | null
  priority?: string | null
  status: string
  version?: string
  created_by_id?: number | null
  created_by_name?: string | null
  created_at: string
  updated_at: string
  checked_out_by_id?: number | null
  checked_out_by_name?: string | null
  checked_out_at?: string | null
  steps: TestStepOut[]
}

export interface TestCaseImportResult {
  created_test_cases: number
  imported_executions: number
  skipped_rows: number
  errors: string[]
  failure_reason?: string | null
}

export interface TestCycleOut {
  id: number
  cycle_key: string
  project_id: number
  name: string
  description?: string | null
  status: string
  start_date?: string | null
  end_date?: string | null
  created_by_id?: number | null
  created_at: string
}

// One immutable historical attempt -- see backend models.TestExecutionRun.
export interface TestRunDefectOut {
  id: number
  run_id: number
  defect_key: string
  defect_url?: string | null
  title?: string | null
  defect_status?: string | null
  notes?: string | null
  linked_by_id?: number | null
  linked_by_name?: string | null
  created_at: string
}

export interface TestExecutionRunOut {
  id: number
  execution_id: number
  attempt_no: number
  status: string
  actual_result?: string | null
  test_run_artifacts?: string | null
  defect_id?: string | null
  executed_by_id?: number | null
  executed_by_name?: string | null
  executed_at?: string | null
  defects: TestRunDefectOut[]
}

export interface TestExecutionOut {
  id: number
  cycle_id: number
  test_case_id: number
  test_case?: TestCaseOut | null
  status: string
  actual_result?: string | null
  test_run_artifacts?: string | null
  defect_id?: string | null
  assigned_to_id?: number | null
  assigned_to_name?: string | null
  assigned_by_id?: number | null
  assigned_by_name?: string | null
  assigned_at?: string | null
  executed_by_id?: number | null
  executed_by_name?: string | null
  executed_at?: string | null
  run_count: number
  created_at: string
  // Full attempt-by-attempt history, oldest first. These columns above
  // always mirror runs[runs.length - 1] once at least one attempt exists.
  runs?: TestExecutionRunOut[]
}

// One row in the logged-in user's Pending Approvals feed -- see
// backend/app/routers/pending_approvals.py's own module docstring for
// exactly how "awaiting this user" is worked out per category (Application
// Name Application Owner/SM tiers, Functional/SAST/DAST/Performance SM/
// Department Head/Readiness, Suppression SM/Department Head/Security Team,
// QA Sign-off QA Lead/Executive COE, Test Project activation). Not tied to
// any single entity's own Out type -- built up from many different tables
// on the backend, so this is its own flat shape.
export interface PendingApprovalItem {
  category: string
  entity_type: string
  entity_id: number
  display_id?: string | null
  title: string
  status: string
  status_label: string
  department?: string | null
  submitted_by?: string | null
  submitted_at?: string | null
  path: string
}
