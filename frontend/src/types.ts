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
}

export interface QARequestDocumentOut {
  id: number
  file_name: string
  content_type?: string | null
  file_size?: number | null
  uploaded_by_id?: number | null
  uploaded_at: string
}

export interface QARequestOut {
  id: number
  request_id: string
  request_date?: string | null
  department?: string | null
  application_name: string
  application_owner?: string | null
  cr_number?: string | null
  project_name?: string | null
  release_version?: string | null
  environment?: string | null
  request_types?: string | null
  request_type_other?: string | null
  priority?: string | null
  risk_rating?: string | null
  target_release_date?: string | null
  supporting_doc_path?: string | null
  remarks?: string | null
  status: string
  requester_id?: number | null
  department_head_id?: number | null
  qa_lead_id?: number | null
  assigned_tester_ids?: string | null
  signoff_id?: number | null
  created_at: string
  updated_at: string
  linked_sast_requests: LinkedRequestRef[]
  linked_dast_requests: LinkedRequestRef[]
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

// ---------------- Test Case / Test Run (Modules 2/3 -- currently disabled) ----------------
export interface TestCaseOut {
  id: number
  test_case_id: string
  epic_id?: string | null
  feature_id?: string | null
  user_story_id?: string | null
  test_type?: string | null
  module_name?: string | null
  project_name?: string | null
  test_scenario?: string | null
  precondition?: string | null
  description?: string | null
  steps?: string | null
  expected_result?: string | null
  priority?: string | null
  actual_result?: string | null
  status: string
  review_status: string
  defect_id?: string | null
  version: number
  is_archived: boolean
  qa_request_id?: number | null
  created_at: string
  updated_at: string
}

export interface TestCaseVersionOut {
  version: number
  archived_at: string
}

export interface TestRunCaseOut {
  id: number
  test_run_id: number
  test_case_id: number
  test_case_id_label?: string
  execution_status: string
  actual_result?: string | null
  defect_id?: string | null
  executed_at?: string | null
}

export interface TestRunOut {
  id: number
  test_run_id: string
  project?: string | null
  application?: string | null
  release?: string | null
  run_type: string
  qa_owner_id?: number | null
  start_date?: string | null
  end_date?: string | null
  status: string
  created_at: string
  cases: TestRunCaseOut[]
}

export interface TestRunMetricsOut {
  total_cases: number
  executed_cases: number
  pass_percentage: number
  defect_density: number
}

// ---------------- SAST / DAST ----------------
export interface SASTFindingOut {
  id: number
  issue_id?: string | null
  severity: string
  description?: string | null
  status: string
}

export interface SASTOut {
  id: number
  request_id: string
  application_name: string
  project_name?: string | null
  cr_number?: string | null
  build_number?: string | null
  repository_url?: string | null
  git_branch?: string | null
  commit_id?: string | null
  technology_stack?: string | null
  risk_category?: string | null
  hash_value?: string | null
  status: string
  report_path?: string | null
  requester_id?: number | null
  created_at: string
  findings: SASTFindingOut[]
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
}

export interface DASTFindingOut {
  id: number
  issue_id?: string | null
  severity: string
  description?: string | null
  status: string
}

export interface DASTOut {
  id: number
  request_id: string
  application_url: string
  environment?: string | null
  authentication_required: boolean
  target_release?: string | null
  risk_category?: string | null
  status: string
  report_path?: string | null
  requester_id?: number | null
  created_at: string
  findings: DASTFindingOut[]
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  department?: string | null
  application_owner?: string | null
}

// A combined SAST/DAST record used by the Suppression "Request ID"
// autosuggest, which searches both together (see pages/Suppression.tsx).
export type CombinedSecurityRequest = (SASTOut | DASTOut) & { _kind: 'SAST' | 'DAST' }

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

export interface QAWiseMetrics {
  assigned_projects: number
  assigned_test_cases: number
  executed_cases: number
  pass_rate: number
  defects_logged: number
}

export interface QAWiseOut {
  metrics: QAWiseMetrics
  charts: { test_execution_trend: Record<string, number> }
}
