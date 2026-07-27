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
}

// Departments are DB-backed (see backend app/models.py Department, managed
// via /api/departments) -- fetched at render time everywhere a department
// picker is shown, instead of importing a hardcoded list.
export interface DepartmentOut {
  id: number
  name: string
  is_active: boolean
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

export interface WalkthroughOut {
  id: number
  session_date: string
  conducted_by?: string | null
  participants?: string | null
  recording_path?: string | null
  document_path?: string | null
  qa_acknowledged_by_id?: number | null
  qa_acknowledged_at?: string | null
  notes?: string | null
}

export interface LinkedRequestRef {
  id: number
  request_id: string
  status?: string | null
  // Only one of risk_rating (Functional)/risk_category (SAST/DAST/
  // Automation/Performance) is ever populated for a given row -- see
  // backend schemas.LinkedRequestRef.
  priority?: string | null
  risk_rating?: string | null
  risk_category?: string | null
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
// every other module (Functional/SAST/DAST/Automation/Performance/
// Suppression/Sign-off), backed by the shared models.RequestDocument table.
export type RequestDocumentOut = QARequestDocumentOut

// The QA Request is a pure intake/gateway record -- `status` here is just
// Draft/Submitted/Raised/Cancelled (see constants.GATEWAY_STATUSES). The
// real workflow state lives on whichever linked child request(s) below were
// auto-raised (see FunctionalOut for the Functional/Sanity/Regression
// Testing/UAT Support bucket's own full lifecycle).
export interface QARequestOut {
  id: number
  request_id: string
  request_date?: string | null
  department?: string | null
  application_name: string
  application_owner?: string | null
  cr_number?: string | null
  project_name?: string | null
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
  linked_functional_requests: LinkedRequestRef[]
  linked_sast_requests: LinkedRequestRef[]
  linked_dast_requests: LinkedRequestRef[]
  linked_automation_requests: LinkedRequestRef[]
  linked_performance_requests: LinkedRequestRef[]
  // Whatever the wizard's SAST/DAST/Performance/checklist steps collected on
  // an earlier Draft save (see models.QARequest.draft_child_details) --
  // read-only, used to pre-fill "Edit Request" instead of showing these
  // blank again. Always empty once this request has been raised.
  draft_checked_items: string[]
  draft_sast_components: SASTComponentIn[]
  draft_dast_components: DASTTargetIn[]
  draft_performance: Record<string, string>
  draft_automation_checked_items: string[]
  draft_performance_checked_items: string[]
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
  project_name?: string | null
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
}

export interface ApprovalActionOut {
  id: number
  entity_type: string
  entity_id: number
  request_ref?: string | null
  step_name?: string | null
  actor_id?: number | null
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
  project_name?: string | null
  cr_number?: string | null
  risk_category?: string | null
  priority?: string | null
  hash_value?: string | null
  status: string
  needs_dept_head_reapproval: boolean
  report_path?: string | null
  requester_id?: number | null
  security_lead_id?: number | null
  created_at: string
  findings: SASTFindingOut[]
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
  environment?: string | null
  target_promotion_environment?: string | null
  // One row per repository -- see SASTComponentOut above.
  components: SASTComponentOut[]
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
  created_at: string
  findings: DASTFindingOut[]
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
  // Delegated from the QA Request gateway -- collected once, at QA Request
  // creation time. No separate target_release field anymore.
  target_release_date?: string | null
  // DAST has no columns of its own for these -- delegated from the gateway.
  application_name?: string | null
  project_name?: string | null
  cr_number?: string | null
  deployment_environment?: string | null
  target_promotion_environment?: string | null
  // One row per scan target -- see DASTTargetOut above.
  targets: DASTTargetOut[]
}

// A combined SAST/DAST record used by the Suppression "Request ID"
// autosuggest, which searches both together (see modules/security/Suppression.tsx).
export type CombinedSecurityRequest = (SASTOut | DASTOut) & { _kind: 'SAST' | 'DAST' }

// ---------------- Automation Testing ----------------
// "Ready for Automation" readiness checklist -- distinct from Functional's
// ReadinessChecklistItem and Performance's PerformanceChecklistItemOut, own
// dedicated table (see backend models.AutomationChecklistItem).
export interface AutomationChecklistItemOut {
  id: number
  item: string
  owner?: string | null
  is_mandatory: boolean
  requester_checked: boolean
  is_complete: boolean
  approved_by_id?: number | null
  approved_at?: string | null
}

export interface AutomationOut {
  id: number
  request_id: string
  application_name: string
  project_name?: string | null
  cr_number?: string | null
  framework?: string | null
  repository_url?: string | null
  ci_cd_pipeline_url?: string | null
  risk_category?: string | null
  priority?: string | null
  status: string
  needs_dept_head_reapproval: boolean
  report_path?: string | null
  requester_id?: number | null
  engineer_id?: number | null
  created_at: string
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
  checklist_items: AutomationChecklistItemOut[]
}

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
  project_name?: string | null
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
  created_at: string
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
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
  risk_tier?: string | null
  release_version?: string | null
  build_number?: string | null
  environment_tested?: string | null
  target_promotion_environment?: string | null
  status: string
  issued_by_id?: number | null
  signed_by_id?: number | null
  created_at: string
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
  applications_scanned: number
  open_vulnerabilities: number
  severity_distribution: Record<string, number>
}

export interface SecurityDastDashboard {
  scan_coverage: number
  vulnerability_trends: Record<string, number>
}

export interface SuppressionDashboard {
  open_suppressions: number
  critical_high_risk_exceptions: number
  status_breakdown: Record<string, number>
}
