// Shared entity/DTO types for the frontend, mirroring backend/app/schemas.py
// (Pydantic `*Out` models -- the shapes actually returned by the API). Kept
// pragmatic: fields the UI never reads are still declared for accuracy, but
// ad-hoc, purely-local shapes (form state, etc.) are typed inline in each
// page rather than centralized here.

// PAG-003 -- the standard envelope every server-paginated list endpoint
// returns (see backend/app/pagination.py's `Page[T]`/`to_page_response`).
// Consumed by hooks/usePaginatedList.ts; matches 1:1 with the backend
// Pydantic model so response_model=Page[SomeListOut] on the Python side
// needs no translation here.
export interface PageOut<T> {
  items: T[]
  page: number
  page_size: number
  total: number
  total_pages: number
  has_next: boolean
  has_previous: boolean
  next_cursor?: number | null
}

export interface UserOut {
  id: number
  username: string
  full_name: string
  email?: string | null
  department?: string | null
  // 2026-08 "one user can be on multiple departments" CR -- the full set a
  // System Admin has granted this user (mirrors backend schemas.UserOut);
  // `department` (singular) is kept for compat, synced to the primary
  // (first-assigned) department.
  departments: string[]
  roles: string[]
  login_type: string
  is_active: boolean
  needs_role_review: boolean
  // True right after this person's first-ever LDAP login, until they pick
  // their own department via the department-selection popup (see
  // components/DepartmentPrompt.tsx, PATCH /api/auth/me).
  needs_department_selection: boolean
  // System-Admin-only flag (see backend models.User.admin_managed_only) --
  // when true, this user is hidden from Department Admin / Executive 
  // rosters (DepartmentAdmin.tsx) and only a System Admin (Admin.tsx) can
  // reassign their role(s) or activate/deactivate them.
  admin_managed_only: boolean
}

export interface QARequestDelegationOut {
  id: number
  qa_request_id: number
  target_type: 'QA_REQUEST' | 'FUNCTIONAL' | 'SAST' | 'DAST' | 'PERFORMANCE'
  target_id: number
  assigned_by_id: number
  assigned_to_id: number
  assigned_by_name?: string | null
  assigned_to_name?: string | null
  assignment_reason: string
  status: 'ACTIVE' | 'RETURNED' | 'RECALLED'
  assigned_at: string
  closed_by_id?: number | null
  closed_by_name?: string | null
  returned_at?: string | null
  return_comments?: string | null
}

// SRS 7.2 pagination rollout -- backs Admin.tsx's account-summary strip and
// sidebar-nav badge (see backend UserSummaryOut).
export interface UserSummaryOut {
  total: number
  active_count: number
  ldap_count: number
  review_count: number
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

// SRS 7.2 pagination rollout -- backs AuditLog.tsx's summary strip, fetched
// separately from the (now shared-Page[T]-shaped) list itself.
export interface AuditSummary {
  total: number
  failed: number
  authentication: number
  access_management: number
}

// Departments are DB-backed (see backend app/models.py Department, managed
// via /api/departments) -- fetched at render time everywhere a department
// picker is shown, instead of importing a hardcoded list.
export interface DepartmentOut {
  id: number
  name: string
  is_active: boolean
}

export interface RequestTypeConfigOut {
  id: number
  request_type: string
  sort_order: number
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
  mandatory_departments: string[]
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
// PAG-005 lightweight counterpart to QARequestOut, returned by the
// paginated GET /api/qa-requests list -- see backend/app/schemas.py's
// QARequestListOut for exactly which fields this omits and why. Opening a
// request (QARequests/index.tsx) fetches the full QARequestOut via
// GET /api/qa-requests/{id} before showing RequestDetail (PAG-006).
export interface QARequestListOut {
  id: number
  request_id?: string | null
  request_date?: string | null
  department?: string | null
  application_name: string
  // See backend schemas.QARequestListOut's own comment -- previously
  // missing from this lightweight list schema entirely, which is why the
  // "CR Number/EPIC Number" list column always showed blank.
  cr_number?: string | null
  epic_number?: string | null
  target_release_date?: string | null
  status: string
  requester_id?: number | null
  created_at: string
  updated_at: string
  application_master_status?: string | null
  active_delegation?: QARequestDelegationOut | null
  linked_functional_requests: LinkedRequestRef[]
  linked_sast_requests: LinkedRequestRef[]
  linked_dast_requests: LinkedRequestRef[]
  linked_performance_requests: LinkedRequestRef[]
  // Sign-off has no FK to QARequest (matched by business ID string) so it's
  // populated explicitly server-side rather than auto-linked like the 4
  // fields above -- see backend schemas.QARequestListOut's own comment.
  linked_signoffs: LinkedRequestRef[]
  change_description?: string | null
}

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
  bug_fix_source_request_id?: string | null
  vendor_si_partner?: string | null
  technology_stack?: string | null
  release_version?: string | null
  build_number?: string | null
  environment?: string | null
  target_promotion_environment?: string | null
  request_types?: string | null
  target_release_date?: string | null
  supporting_doc_path?: string | null
  remarks?: string | null
  change_description?: string | null
  status: string
  requester_id?: number | null
  created_at: string
  updated_at: string
  // See backend models.ApplicationMaster -- live approval status of this
  // request's own Application Name (set on every create/edit); id lets an
  // SM's Approve/Reject action target the right master row.
  application_master_id?: number | null
  application_master_status?: string | null
  active_delegation?: QARequestDelegationOut | null
  linked_functional_requests: LinkedRequestRef[]
  linked_sast_requests: LinkedRequestRef[]
  linked_dast_requests: LinkedRequestRef[]
  linked_performance_requests: LinkedRequestRef[]
  // Sign-off has no FK to QARequest (matched by business ID string) so it's
  // populated explicitly server-side rather than auto-linked like the 4
  // fields above -- see backend routers/qa_requests.py's get_request().
  linked_signoffs: LinkedRequestRef[]
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
// PAG-005 lightweight list schema -- mirrors backend schemas.FunctionalListOut.
export interface FunctionalListOut {
  id: number
  request_id: string
  status: string
  application_master_status?: string | null
  requester_id?: number | null
  qa_lead_id?: number | null
  priority?: string | null
  application_name?: string | null
  epic_number?: string | null
  cr_number?: string | null
  change_description?: string | null
  department?: string | null
  application_owner?: string | null
  qa_request?: LinkedRequestRef | null
  created_at: string
  updated_at: string
}

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
  signoff_certificate_id?: string | null      // 2026-08 -- "LINK THE CERTIFICATE ONCE GENERATED"
  signoff_certificate_status?: string | null
  created_at: string
  updated_at: string
  qa_request_id?: number | null
  qa_request?: LinkedRequestRef | null
  active_delegation?: QARequestDelegationOut | null
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
  change_description?: string | null
  change_type?: string | null
  bug_fix_source_request_id?: string | null
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
  linked_test_cycles: LinkedTestCycleRef[]
}

export interface LinkedTestCycleRef {
  id: number
  cycle_key: string
  project_id: number
  name: string
  status: string
  start_date?: string | null
  end_date?: string | null
}

export interface EligibleTestCycleOut extends LinkedTestCycleRef {
  project_key: string
  project_name: string
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
  // 2026-08 Test Approval Workflow refactor (APR-005) -- populated only by
  // the Test Case approval workflow's own audit calls; NULL for every other
  // entity type's approval actions, which predate this column pair.
  previous_state?: string | null
  new_state?: string | null
}

// ---------------- SAST / DAST ----------------
export interface SASTFindingOut {
  id: number
  issue_id?: string | null
  severity: string
  description?: string | null
  status: string
}

export interface SecurityScanFilterOut {
  title: string
  guid: string
  total_count: number
  critical_count: number
  high_count: number
  medium_count: number
  low_count: number
  audit_url?: string | null
}

export interface SecurityScanResultOut {
  id: number
  request_type: 'SAST' | 'DAST'
  request_id: number
  application_name: string
  application_version: string
  provider: string
  provider_version_id: string
  critical_count: number
  high_count: number
  medium_count: number
  low_count: number
  total_count: number
  suppressed_critical_count: number
  suppressed_high_count: number
  suppressed_medium_count: number
  suppressed_low_count: number
  suppressed_total_count: number
  audit_url?: string | null
  filters: SecurityScanFilterOut[]
  imported_by_id?: number | null
  imported_at: string
  // 2026-08 "Findings Validation" doc, section 4.3 Scan History -- derived
  // by the backend from position in this request's own scan history, not
  // stored columns (see schemas.SecurityScanResultOut).
  scan_no: number
  scan_type: 'Initial Scan' | 'Rescan'
  status: string
}

// Backs the "Findings Validation" doc's 4.1 Scan Summary section.
export interface SecurityScanSummaryOut {
  initial?: SecurityScanResultOut | null
  current?: SecurityScanResultOut | null
  total_rescans: number
  open_findings: number
  suppressed_findings: number
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

// PAG-005 lightweight list schema -- mirrors backend schemas.SASTListOut.
export interface SASTListOut {
  id: number
  request_id: string
  status: string
  application_master_status?: string | null
  requester_id?: number | null
  security_lead_id?: number | null
  priority?: string | null
  risk_category?: string | null
  application_name?: string | null
  // Cheap to include -- already eager-loaded server-side. Needed by
  // Suppression.tsx's cross-module SAST/DAST request picker.
  department?: string | null
  application_owner?: string | null
  change_description?: string | null
  findings_count: number
  // 2026-08 "Findings Validation" doc -- lets the list Status column
  // overlay "Suppression Approval Pending" over Waiting For Fix, mirroring
  // application_master_status's overlay of Application Owner Approval
  // Pending over SM Approval Pending. See backend schemas.SASTListOut.
  has_open_suppression: boolean
  qa_request?: LinkedRequestRef | null
  created_at: string
  updated_at: string
}

export interface SASTOut {
  id: number
  request_id: string
  application_name: string
  epic_number?: string | null
  cr_number?: string | null
  change_description?: string | null
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
  active_delegation?: QARequestDelegationOut | null
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

// PAG-005 lightweight list schema -- mirrors backend schemas.DASTListOut.
export interface DASTListOut {
  id: number
  request_id: string
  status: string
  application_master_status?: string | null
  requester_id?: number | null
  security_lead_id?: number | null
  priority?: string | null
  risk_category?: string | null
  application_name?: string | null
  // See the matching comment on SASTListOut above -- same reasoning.
  department?: string | null
  application_owner?: string | null
  change_description?: string | null
  findings_count: number
  // See SASTListOut.has_open_suppression above -- same idea, for DAST.
  has_open_suppression: boolean
  qa_request?: LinkedRequestRef | null
  created_at: string
  updated_at: string
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
  active_delegation?: QARequestDelegationOut | null
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
  change_description?: string | null
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
// Uses the lightweight PAG-005 list schemas -- the picker only ever needs to
// browse/filter/display a candidate, never a full record (see
// SASTListOut/DASTListOut, which include department/application_owner for
// exactly this consumer).
export type CombinedSecurityRequest = (SASTListOut | DASTListOut) & { _kind: 'SAST' | 'DAST' }

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

// PAG-005 lightweight list schema -- mirrors backend schemas.PerformanceListOut.
export interface PerformanceListOut {
  id: number
  request_id: string
  status: string
  application_master_status?: string | null
  requester_id?: number | null
  engineer_id?: number | null
  priority?: string | null
  risk_category?: string | null
  application_name?: string | null
  // Cheap to include -- already eager-loaded server-side. Needed by
  // Dashboard.tsx's "My Department" unified-request filter.
  department?: string | null
  change_description?: string | null
  qa_request?: LinkedRequestRef | null
  created_at: string
  updated_at: string
}

export interface PerformanceOut {
  id: number
  request_id: string
  application_name: string
  epic_number?: string | null
  cr_number?: string | null
  change_description?: string | null
  tool_used?: string | null
  target_load?: string | null
  environment?: string | null
  risk_category?: string | null
  priority?: string | null
  // ---- Annexure VIII fields ----
  request_type?: string | null
  change_type?: string | null
  bug_fix_source_request_id?: string | null
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
  active_delegation?: QARequestDelegationOut | null
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

// ---------------- QA Clearance ----------------
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
  request_department?: string | null
  change_description?: string | null
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
  // (Executive ) -- see backend models.QASignOff.
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

// DSH-001..004 -- backed by GET /api/dashboard/summary (see dashboard.py's
// own docstring). Consolidates the 4 numbers Dashboard.tsx's Command Centre
// tab used to derive client-side from 5 full page_size=100 request-list
// fetches, plus the raw per-status Functional counts (kept as a flat dict,
// not pre-bucketed into lifecycle stages, so Dashboard.tsx's own
// STATUS_STAGE_INDEX/lifecycleDistribution() stays the single source of
// truth for stage grouping).
export interface DashboardSummaryOut {
  child_requests_total: number
  active_requests_count: number
  nearing_release_count: number
  critical_pending_count: number
  functional_status_counts: Record<string, number>
}

export type DashboardAttentionMetric =
  | 'active-projects'
  | 'security-findings'
  | 'pending-decisions'
  | 'active-requests'

export interface DashboardAttentionRow {
  key: string
  type?: string
  request_id?: string
  request_ids?: string
  linked_requests?: { id: number; request_id: string; status: string; route: string }[]
  project_id?: string
  application_name?: string
  department?: string | null
  status?: string
  pending_with?: string
  request_count?: number
  critical?: number
  high?: number
  medium?: number
  low?: number
  value?: number
  created_at?: string
  updated_at?: string
  route?: string | null
}

export interface DashboardAttentionOut {
  metric: DashboardAttentionMetric
  title: string
  description: string
  total: number
  unit: string
  rows: DashboardAttentionRow[]
  page: number
  page_size: number
  total_rows: number
  total_pages: number
  has_next: boolean
  has_previous: boolean
}

export interface ThreeWItem {
  project_id: string
  application_name?: string
  pending_stage: string
  pending_with: string
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

export type SecurityInsightMetric = 'requests' | 'applications' | 'vulnerabilities' | 'severity' | 'remediation' | 'compliance'
export type SecurityInsightDetail = Omit<DashboardAttentionOut, 'metric' | 'rows'> & {
  metric: SecurityInsightMetric
  rows: (DashboardAttentionRow & { application_url?: string | null })[]
}

export interface SecurityDastDashboard {
  total_requests: number
  scan_coverage: number
  vulnerability_trends: Record<string, number>
  compliance_status: Record<string, number>
}

export interface SuppressionDashboard {
  open_qualityops_suppression_requests: number
  open_suppressions: number
  critical_high_risk_exceptions: number
  fortify_suppressed_findings: number
  fortify_suppressed_severity_distribution: Record<string, number>
  status_breakdown: Record<string, number>
}

export type FortifySuppressedSeverity = 'Critical' | 'High' | 'Medium' | 'Low'

export interface FortifySuppressionDetailRow {
  key: string
  type: 'SAST' | 'DAST'
  request_id: string
  application_name: string
  application_version: string
  department?: string | null
  severity: FortifySuppressedSeverity
  suppressed_count: number
  suppressed_total: number
  imported_at?: string | null
  route: string
}

export interface FortifySuppressionDetailOut {
  metric: string
  title: string
  description: string
  total: number
  unit: string
  rows: FortifySuppressionDetailRow[]
  page: number
  page_size: number
  total_rows: number
  total_pages: number
  has_next: boolean
  has_previous: boolean
}

// ---------------- Test Management (Project Management / Test Repository / Test Execution) ----------------
// See backend models.TestProject's header comment for the full design --
// one Project per Application, a folder tree of Test Cases under it, Test
// Plans grouping Test Cycles, and Test Cycles that record a Pass/Fail/
// Blocked/NA/Retest Passed result per test case run.
//
// 2026-08 "Test Management Revamp": testcase content/steps now live in
// immutable TestCaseVersion/TestCaseVersionStep records instead of being
// mutated in place -- TestCaseOut's own status/version/content fields are a
// mirror of whichever version is "current" (its in-progress draft, if any,
// else its approved baseline). See constants.ts's TEST_CASE_STATUSES (5
// values) and TEST_CYCLE_STATUSES (7 values) for the current vocabularies.
export interface TestProjectOut {
  id: number
  project_key: string
  name: string
  application_master_id?: number | null
  department?: string | null
  description?: string | null
  is_active: boolean
  owner_id?: number | null
  owner_name?: string | null
  created_by_id?: number | null
  created_at: string
  pending_is_active?: boolean | null
  pending_requested_by_id?: number | null
  pending_requested_by_name?: string | null
  pending_requested_at?: string | null
  is_archived: boolean
  archived_by_id?: number | null
  archived_by_name?: string | null
  archived_at?: string | null
  archived_reason?: string | null
  // 2026-08 Test Approval Workflow refactor (APR-001) -- project-level
  // default assignment targets; routing/visibility only, not an
  // authorization gate (see TestCaseVersionOut.assigned_* fields).
  default_reviewer_id?: number | null
  default_reviewer_name?: string | null
  default_qa_lead_id?: number | null
  default_qa_lead_name?: string | null
  // 2026-08 "view-only access to department/user" CR -- True when the
  // CURRENT viewer can only see this project via a TestProjectViewGrant,
  // not their own department or an unrestricted QA/Admin role. Computed
  // per-request server-side (routers/test_projects.py); defaults false.
  view_only?: boolean
  // Viewer-specific marker returned when a user/department View Access
  // grant explicitly includes the signed-in user.
  shared_with_you?: boolean
}

export interface TestProjectSummaryCountsOut {
  project_id: number
  test_case_count: number
  cycle_count: number
}

// 2026-08 "view-only access to department/user" CR -- mirrors backend
// schemas.TestProjectViewGrantOut. Exactly one of department/user_id is set
// per row.
export interface TestProjectViewGrantOut {
  id: number
  project_id: number
  department?: string | null
  user_id?: number | null
  user_name?: string | null
  granted_by_id?: number | null
  granted_by_name?: string | null
  created_at: string
}

// Request body for POST /api/test-projects -- mirrors backend TestProjectCreate.
export interface TestProjectCreateIn {
  project_key: string
  name: string
  application_master_id?: number | null
  department?: string | null
  description?: string | null
  owner_id?: number | null
  default_reviewer_id?: number | null
  default_qa_lead_id?: number | null
}

// Request body for PATCH /api/test-projects/{id} -- mirrors backend TestProjectUpdate.
// All fields optional/partial; explicit null clears default_reviewer_id/default_qa_lead_id.
export interface TestProjectUpdateIn {
  name?: string
  application_master_id?: number | null
  department?: string | null
  description?: string | null
  is_active?: boolean
  owner_id?: number | null
  default_reviewer_id?: number | null
  default_qa_lead_id?: number | null
}

// SRS PRJ-005/GOV-001 -- project-scoped membership, separate from the
// app-wide Role enum (see constants.ts TEST_PROJECT_ROLES).
// SRS PRJ-005/GOV-001 -- advisory permission summary for the signed-in user
// on one Test Project; see routers/test_projects.py::get_my_project_access.
// Every mutating endpoint still enforces these same rules server-side
// regardless of what the UI does with this.
export interface TestProjectMyAccessOut {
  project_id: number
  project_role?: string | null
  is_member: boolean
  can_author_repository: boolean
  can_review_repository: boolean
  // 2026-08 Test Approval Workflow refactor -- Stage 2 (QA Lead final
  // approve/reject) gate, strictly narrower than can_review_repository:
  // Project Lead/Owner project roles or system QA_LEAD/Admin only, no
  // non-member fallback. A plain "Reviewer" project role does NOT satisfy
  // this even though it satisfies can_review_repository.
  can_give_final_approval: boolean
  can_execute: boolean
  can_manage_execution_governance: boolean
}

export interface TestProjectMemberOut {
  id: number
  project_id: number
  user_id: number
  user_name?: string | null
  user_email?: string | null
  project_role: string
  added_by_id?: number | null
  added_by_name?: string | null
  added_at: string
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
  tags: string[]
  status: string
  version?: string
  current_approved_version_id?: number | null
  current_draft_version_id?: number | null
  current_draft_author_id?: number | null
  current_draft_author_name?: string | null
  // GOV-002 gap fix -- see backend schemas.TestCaseOut's matching comment.
  current_draft_submitted_by_id?: number | null
  current_draft_reviewed_by_id?: number | null
  // "show submitted by as well" -- see backend schemas.TestCaseOut's matching comment.
  current_draft_submitted_by_name?: string | null
  // "Add Recommended By once recommended" -- see backend schemas.TestCaseOut's matching comment.
  current_draft_reviewed_by_name?: string | null
  created_by_id?: number | null
  created_by_name?: string | null
  created_at: string
  updated_at: string
  checked_out_by_id?: number | null
  checked_out_by_name?: string | null
  // 2026-08 "Recycle Bin" requirement -- see backend schemas.TestCaseOut's matching comment.
  is_deleted?: boolean
  deleted_by_name?: string | null
  deleted_at?: string | null
  checked_out_at?: string | null
  steps: TestStepOut[]
  // Also present on the PAG-005 list schema below (which has no `steps` at
  // all) -- see schemas.TestCaseOut's matching comment.
  steps_count: number
  // 2026-08 Test Approval Workflow refactor -- who the case is currently
  // "Pending with" (APR-006/section 9), bridged through current_draft_version;
  // null when the case isn't awaiting anyone (Draft with no submission, or
  // a terminal Approved/Rejected/Archived state).
  pending_with_user_id?: number | null
  pending_with_user_name?: string | null
  pending_since?: string | null
}

// PAG-005 lightweight list schema -- mirrors backend schemas.TestCaseListOut.
export interface TestCaseListOut {
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
  priority?: string | null
  tags: string[]
  status: string
  version?: string
  current_approved_version_id?: number | null
  current_draft_version_id?: number | null
  current_draft_author_id?: number | null
  current_draft_author_name?: string | null
  // GOV-002 gap fix -- see backend schemas.TestCaseOut's matching comment.
  current_draft_submitted_by_id?: number | null
  current_draft_reviewed_by_id?: number | null
  // "show submitted by as well" -- see backend schemas.TestCaseOut's matching comment.
  current_draft_submitted_by_name?: string | null
  // "Add Recommended By once recommended" -- see backend schemas.TestCaseOut's matching comment.
  current_draft_reviewed_by_name?: string | null
  created_by_id?: number | null
  created_by_name?: string | null
  created_at: string
  updated_at: string
  checked_out_by_id?: number | null
  checked_out_by_name?: string | null
  // 2026-08 "Recycle Bin" requirement -- see backend schemas.TestCaseOut's matching comment.
  is_deleted?: boolean
  deleted_by_name?: string | null
  deleted_at?: string | null
  checked_out_at?: string | null
  steps_count: number
  pending_with_user_id?: number | null
  pending_with_user_name?: string | null
  pending_since?: string | null
}

// Mirrors backend schemas.TestCaseSummaryOut -- see its own docstring for
// why this exists (the folder tree/tag dropdown/stat bar all need
// project-wide aggregates the paginated list above can no longer provide).
export interface TestCaseSummaryOut {
  total: number
  unfiled_count: number
  folder_counts: Record<number, number>
  approved_count: number
  in_review_count: number
  review_completed_count: number
  critical_count: number
  tags: string[]
  archived_count: number
  recycle_bin_count: number
  // Reported directly: "Testcases count and all should be updated based on
  // folder" -- scoped to whatever folder_id was passed to GET .../summary
  // (see backend routers/test_repository.py::get_test_case_summary); equal
  // to total/approved_count/in_review_count/critical_count above when no
  // folder_id was passed (the "All test cases" view). Power the "Current
  // view" stat cards only -- every other field above stays project-wide,
  // powering the sidebar's fixed per-folder badges.
  scoped_total: number
  scoped_approved_count: number
  scoped_in_review_count: number
  scoped_critical_count: number
}

export type TestCaseVersionStepOut = TestStepIn & { id: number; version_id: number }

// One immutable-once-Approved snapshot of a testcase's full content (VER-001).
export interface TestCaseVersionOut {
  id: number
  test_case_id: number
  version: string
  version_major: number
  version_minor: number
  status: string
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
  author_id?: number | null
  author_name?: string | null
  created_at: string
  submitted_by_id?: number | null
  submitted_by_name?: string | null
  submitted_at?: string | null
  submit_note?: string | null
  // Stage 1 (Reviewer) decision -- set on RECOMMEND or a Stage-1 RETURN.
  reviewed_by_id?: number | null
  reviewed_by_name?: string | null
  reviewed_at?: string | null
  review_comments?: string | null
  // Stage 2 (QA Lead) decision -- set on APPROVE, REJECT, or a Stage-2 RETURN.
  qa_lead_decided_by_id?: number | null
  qa_lead_decided_by_name?: string | null
  qa_lead_decided_at?: string | null
  qa_lead_decision_comments?: string | null
  // APR-001 -- per-item assignment override of the project's default_reviewer/
  // default_qa_lead; routing/visibility only, not an authorization gate.
  assigned_reviewer_id?: number | null
  assigned_reviewer_name?: string | null
  assigned_qa_lead_id?: number | null
  assigned_qa_lead_name?: string | null
  pending_with_user_id?: number | null
  pending_with_user_name?: string | null
  source_version_id?: number | null
  steps: TestCaseVersionStepOut[]
}

// Request body for PATCH /api/test-cases/{id}/approvers.
export interface TestCaseReassignApproversIn {
  assigned_reviewer_id?: number | null
  assigned_qa_lead_id?: number | null
}

// Request body for POST /api/test-cases/{id}/review (and bulk variants).
// Stage 1 (In Review, gated by can_review_repository): RECOMMEND | RETURN
// Stage 2 (Review Completed, gated by can_give_final_approval): APPROVE | RETURN | REJECT
export type TestCaseReviewDecision = "RECOMMEND" | "APPROVE" | "RETURN" | "REJECT"
export interface TestCaseReviewIn {
  decision: TestCaseReviewDecision
  comments?: string | null
}

// Request body for POST /api/projects/{id}/test-cases/bulk-recommend.
export interface TestCaseBulkRecommendIn {
  ids: number[]
  comments?: string | null
}

// Lighter-weight row for version history lists (VER-005) -- no steps.
export interface TestCaseVersionSummary {
  id: number
  test_case_id: number
  version: string
  version_major: number
  version_minor: number
  status: string
  author_id?: number | null
  author_name?: string | null
  created_at: string
  submitted_at?: string | null
  reviewed_by_name?: string | null
  reviewed_at?: string | null
}

export interface TestCaseVersionCompareOut {
  left: TestCaseVersionOut
  right: TestCaseVersionOut
  field_diffs: Record<string, { left: unknown; right: unknown }>
  step_diffs: Record<string, { left: { step_text?: string | null; expected_result?: string | null } | null; right: { step_text?: string | null; expected_result?: string | null } | null }>
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
  linked_request_type?: string | null
  linked_request_id?: number | null
  linked_request_key?: string | null
  cycle_type?: string | null
  environment?: string | null
  build?: string | null
  owner_id?: number | null
  owner_name?: string | null
  created_by_id?: number | null
  created_at: string
  // Reported directly: "Create Test Cycle Folder ... Under this folder
  // create test cycle." null/undefined means Unfiled.
  folder_id?: number | null
  folder_name?: string | null
}

// Reported directly: "Create Test Cycle Folder, in which I can give access
// department based or user level, same behaviour like project has." A
// folder with any access_grants is RESTRICTED to those departments/users
// (plus the project owner, this folder's creator, and the QA Lead Group/
// Admin) -- the opposite of TestProjectViewGrantOut below, which only ever
// widens visibility. Empty access_grants means unrestricted.
export interface TestCycleFolderAccessOut {
  id: number
  folder_id: number
  department?: string | null
  user_id?: number | null
  user_name?: string | null
  granted_by_id?: number | null
  granted_by_name?: string | null
  created_at: string
}

export interface TestCycleFolderOut {
  id: number
  project_id: number
  name: string
  created_by_id?: number | null
  created_by_name?: string | null
  created_at: string
  access_grants: TestCycleFolderAccessOut[]
  cycle_count: number
}

export interface TestCycleFolderListOut {
  folders: TestCycleFolderOut[]
  unfiled_count: number
  total: number
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
  // SRS CYC-004 -- the exact TestCaseVersion this slot is pinned to, frozen
  // once any attempt exists. is_pinned_stale flags when the testcase's
  // current approved version has since moved on (CYC-006 upgrade affordance
  // while still unexecuted).
  pinned_version_id?: number | null
  pinned_version_label?: string | null
  is_pinned_stale: boolean
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
  // Scenario 1 self-remove fix -- see backend schemas.TestExecutionOut's matching comment.
  added_by_id?: number | null
  added_by_name?: string | null
  run_count: number
  // SRS EXE-007 optimistic concurrency -- send back as expected_run_version
  // on the next save; a 409 means someone else recorded a newer attempt
  // first and the slot must be refreshed before retrying.
  run_version: number
  created_at: string
  // Full attempt-by-attempt history, oldest first. These columns above
  // always mirror runs[runs.length - 1] once at least one attempt exists.
  runs?: TestExecutionRunOut[]
  // Governed Defect(s) (defects.py, not the free-text per-attempt
  // TestRunDefect above) linked to this slot via Defect.execution_id. Used
  // together with `runs` (for prior-Fail history) to lock/gate status
  // changes client-side -- see constants.ts's executionStatusGate, used by
  // both TestExecution.tsx and MyExecutions.tsx. The backend enforces the
  // same rule regardless (test_execution.py's _execution_status_gate) --
  // this is only for disabling the option and explaining why before the
  // user even submits.
  linked_defects?: LinkedGovernedDefectRef[]
}

export interface MyExecutionOut {
  project: TestProjectOut
  cycle: TestCycleOut
  execution: TestExecutionOut
}

// Mirrors backend schemas.DefectLinkableExecutionOut -- the batch
// GET /api/test-execution/executions/blocked-or-failed response Defects.tsx
// uses to build its "pick a Failed/Blocked execution" pickers, replacing the
// old per-project cycles + per-cycle executions fan-out. Same shape as
// Defects.tsx's own pre-existing local `ExecutionContext` interface, so that
// interface can simply become an alias for this instead of a separately
// re-derived type.
export interface DefectLinkableExecutionOut {
  project: TestProjectOut
  cycle: TestCycleOut
  execution: TestExecutionOut
}

// Mirrors backend schemas.TestExecutionSummaryOut -- see its own docstring
// (the progress bar/assignment stat/tab bars TestExecution.tsx's cycle
// detail view needs project-wide aggregates for, now that the main
// execution list is paginated).
export interface TestExecutionSummaryOut {
  total: number
  status_counts: Record<string, number>
  executed_count: number
  assigned_count: number
  unassigned_count: number
  mine_count: number
  total_run_count: number
}

export interface LinkedGovernedDefectRef {
  id: number
  defect_key: string
  status: string
}

// ---------------- Test Management Reporting (SRS section 11) ----------------
export interface ReportFilterRef {
  project_id?: number | null
  cycle_id?: number | null
  status?: string | null
  test_case_id?: number | null
  requirement?: string | null
}
export interface ReportCountRow { key: string; count: number; filters: ReportFilterRef }
export interface ReportStatusCountRow { status: string; count: number; filters: ReportFilterRef }

export interface RepositoryHealthOut {
  project_id: number
  project_key: string
  population_note: string
  total_cases: number
  by_status: ReportCountRow[]
  by_module: ReportCountRow[]
  by_priority: ReportCountRow[]
  by_test_type: ReportCountRow[]
  by_owner: ReportCountRow[]
  average_age_days: number
  never_executed_count: number
}

export interface CycleProgressOut {
  cycle_id: number
  cycle_key: string
  cycle_status: string
  population_note: string
  total_items: number
  by_status: ReportStatusCountRow[]
  assigned_count: number
  unassigned_count: number
  completion_pct: number
  is_locked: boolean
}

export interface DefectQualityOut {
  project_id: number
  project_key: string
  population_note: string
  total_defect_links: number
  by_module: ReportCountRow[]
  by_status: ReportCountRow[]
  retest_success_rate_pct: number
}

export interface DefectExecutionLinkOut {
  id: number
  execution_id: number
  cycle_id?: number | null
  cycle_key?: string | null
  project_id?: number | null
  test_case_key?: string | null
  status?: string | null
}

export interface DefectOut {
  id: number
  defect_key: string
  title: string
  description: string
  status: string
  qa_request_id: number
  qa_request_key?: string | null
  cycle_id?: number | null
  cycle_key?: string | null
  project_id?: number | null
  // 2026-08 -- reported directly: "During assigning defect, department
  // should be auto populated based on linked request or Failed / Blocked
  // Test Execution." Mirrors backend models.Defect.project_department --
  // the linked Test Cycle's own Project.department, null whenever no
  // execution/cycle is linked. See Defects.tsx's TransitionModal.
  project_department?: string | null
  primary_test_case_id?: number | null
  test_case_key?: string | null
  execution_id?: number | null
  linked_test_case_ids: number[]
  linked_test_case_keys: string[]
  // Additional executions this same governed defect has also been traced
  // to, beyond its primary one above -- see the "Link existing defect"
  // picker (TestExecution.tsx), widened to offer already-linked defects too.
  execution_links: DefectExecutionLinkOut[]
  application_name: string
  module_feature: string
  environment: string
  severity: string
  priority: string
  steps_to_reproduce: string
  expected_result: string
  actual_result: string
  reporter_id: number
  reporter_name?: string | null
  reported_at: string
  assignee_id?: number | null
  assignee_name?: string | null
  assigned_team?: string | null
  assigned_by_id?: number | null
  assigned_by_name?: string | null
  assigned_at?: string | null
  // 2026-08 -- reported directly: the "Remarks" typed while transitioning a
  // defect to Assigned was captured by the backend (models.Defect.
  // assignment_remarks) but never exposed on this type, so it was never
  // rendered anywhere. See Defects.tsx's Workflow Details section.
  assignment_remarks?: string | null
  retest_tester_id?: number | null
  device_details?: string | null
  build_version?: string | null
  api_endpoint?: string | null
  request_response_details?: string | null
  log_details?: string | null
  related_cr_number?: string | null
  external_defect_id?: string | null
  remarks?: string | null
  labels?: string | null
  resolution_type?: string | null
  resolution_summary?: string | null
  root_cause?: string | null
  fix_details?: string | null
  fixed_build_version?: string | null
  resolved_at?: string | null
  retest_result?: string | null
  retest_at?: string | null
  tested_build_version?: string | null
  retest_actual_result?: string | null
  retest_remarks?: string | null
  reopen_reason?: string | null
  reopen_count: number
  deferral_reason?: string | null
  deferral_approved_by?: string | null
  target_release?: string | null
  expected_resolution_date?: string | null
  rejection_reason?: string | null
  not_a_defect_reason?: string | null
  duplicate_of_id?: number | null
  duplicate_of_key?: string | null
  closure_remarks?: string | null
  closed_at?: string | null
  created_at: string
  updated_at: string
}

// SRS 7.2 pagination rollout -- lightweight list schema for `GET /api/defects`
// (PAG-005); Defects.tsx fetches the full `DefectOut` via `GET /{id}` only
// when a row is actually opened (PAG-006).
export interface DefectListOut {
  id: number
  defect_key: string
  title: string
  status: string
  qa_request_id: number
  qa_request_key?: string | null
  cycle_id?: number | null
  cycle_key?: string | null
  project_id?: number | null
  test_case_key?: string | null
  execution_id?: number | null
  application_name: string
  module_feature: string
  environment: string
  severity: string
  priority: string
  reporter_id: number
  reporter_name?: string | null
  reported_at: string
  assignee_id?: number | null
  assignee_name?: string | null
  assigned_team?: string | null
  target_release?: string | null
  expected_resolution_date?: string | null
  reopen_count: number
  closed_at?: string | null
  created_at: string
  updated_at: string
}

export interface DefectDashboardOut {
  total: number
  open: number
  closed: number
  reopened: number
  deferred: number
  attention_count: number
  mine_count: number
  unlinked_count: number
  retest_count: number
  by_status: Record<string, number>
  by_severity: Record<string, number>
  by_priority: Record<string, number>
  by_application: Record<string, number>
  by_assignee: Record<string, number>
  by_ageing: Record<string, number>
  closure_trend: Record<string, number>
}

export interface VersionImpactItemOut {
  cycle_id: number
  cycle_key: string
  cycle_status: string
  stale_item_count: number
  upgradeable_count: number
  permanently_pinned_count: number
  filters: ReportFilterRef
}
export interface VersionImpactOut {
  project_id: number
  project_key: string
  population_note: string
  cycles_with_stale_items: number
  total_items: number
  returned_items: number
  items: VersionImpactItemOut[]
}

export interface CycleStatusCountRow { status: string; count: number }
export interface CycleTrendPointOut { month: string; count: number }
export interface ProjectOwnershipRow { owner: string; project_count: number }
export interface ProjectPortfolioOut {
  population_note: string
  active_project_count: number
  inactive_project_count: number
  archived_project_count: number
  cycle_count: number
  cycles_by_status: CycleStatusCountRow[]
  cycle_creation_trend: CycleTrendPointOut[]
  ownership: ProjectOwnershipRow[]
}

// One row in the logged-in user's Pending Approvals feed -- see
// backend/app/routers/pending_approvals.py's own module docstring for
// exactly how "awaiting this user" is worked out per category (Application
// Name Application Owner/SM tiers, Functional/SAST/DAST/Performance SM/
// Department Head/Readiness, Suppression SM/Department Head/Security Team,
// QA Clearance QA Lead/Executive , Test Project activation). Not tied to
// any single entity's own Out type -- built up from many different tables
// on the backend, so this is its own flat shape.
export interface PendingApprovalItem {
  category: string
  entity_type: string
  entity_id: number
  display_id?: string | null
  parent_request_id?: string | null
  parent_path?: string | null
  // Reported directly: "Parent Section should be Project Name, the Folder
  // wise testcase segregation" -- parent_label distinguishes what kind of
  // parent parent_request_id actually is (e.g. "Parent QA Request" vs
  // "Test Project"), null defaults to the QA-Request wording. folder_name
  // is a second-level grouping within that parent (Test Repository folder
  // a pending test case lives in) -- always null for every other category.
  parent_label?: string | null
  folder_name?: string | null
  title: string
  status: string
  status_label: string
  department?: string | null
  submitted_by?: string | null
  submitted_at?: string | null
  path: string
}

export interface PendingApprovalPage extends PageOut<PendingApprovalItem> {
  category_counts: Record<string, number>
}
