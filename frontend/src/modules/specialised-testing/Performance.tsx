import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, WorkflowDecisionPanel, DetailSection, DetailField, RequestDocuments, ChecklistEvidence, useChecklistDocuments, applicationNameAwareStatusLabel } from '../../components/Common'
import UserAssignSelect from '../../components/UserAssignSelect'
import MultiUserAssignSelect from '../../components/MultiUserAssignSelect'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import { IconCheckCircle } from '../../components/Icons'
import RoleGroupLink from '../../components/RoleGroupLink'
import {
  PRIORITIES, RISK_RATINGS, ENVIRONMENTS, DEPLOYMENT_ENVIRONMENTS,
  PERFORMANCE_REQUEST_TYPES, CHANGE_TYPES, hasRole, hasDepartment, canManageReadinessEvidence,
  QA_DEPARTMENT, PERFORMANCE_PENDING_WITH, QA_EXECUTION_GROUP_ROLE,
  PERFORMANCE_TESTER_REASSIGNABLE_STATUSES,
} from '../../constants'
import { PerformanceOut, PerformanceListOut, PerformanceChecklistItemOut, UserOut, ApprovalActionOut } from '../../types'
import { usePaginatedList } from '../../hooks/usePaginatedList'

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

// Standalone creation is DISABLED -- a Performance request can only come into
// being by including "Performance Testing" in a QA Request's request types
// (see backend routers/qa_requests.py::_sync_linked_child_requests).
function PerformanceFormModal({ onClose, onSaved, editing }: {
  onClose: () => void; onSaved: (p: PerformanceOut) => void; editing: PerformanceOut
}) {
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'ADMIN')
  const [form, setForm] = useState({
    application_name: editing.application_name || '',
    cr_number: editing.cr_number || editing.epic_number || '', environment: editing.environment || 'UAT',
    risk_category: editing.risk_category || 'Medium', priority: editing.priority || 'Medium',
    request_type: (editing.request_type || '').split(',').filter(Boolean) as string[],
    change_type: editing.change_type || '', vendor_si_partner: editing.vendor_si_partner || '',
    technology_stack: editing.technology_stack || '', release_version: editing.release_version || '',
    build_number: editing.build_number || '',
    target_promotion_environment: editing.target_promotion_environment || '',
  })
  // Lets the requester revisit their readiness-checklist self-declaration
  // from here too -- previously the only place to tick these was the QA
  // Request wizard at intake time, with no way back in even while this
  // request was sitting in the requester's own hands (e.g. Draft or
  // returned for changes).
  const [checkedItems, setCheckedItems] = useState<string[]>(
    editing.checklist_items.filter((c) => c.requester_checked).map((c) => c.item)
  )
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments('/api/performance-requests', editing.id)
  // Same identity check as the detail view's isRequester/canSMDecide/
  // canDeptHeadDecide -- this modal only opens via canEditDetails, but the
  // checklist evidence controls inside it need their own explicit check.
  const isRequesterModal = editing.requester_id === user?.id || isAdmin
  const sameDeptModal = hasDepartment(user, editing.department)
  const canSMDecideModal = hasRole(user, 'SM') && editing.status === 'SM_APPROVAL_PENDING' && sameDeptModal
  const canDeptHeadDecideModal = hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && editing.status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDeptModal
  const canManageEvidenceModal = isAdmin || (
    editing.status === 'SM_APPROVAL_PENDING' ? canSMDecideModal :
    editing.status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecideModal :
    isRequesterModal
  )
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }
  function toggleReqType(t: string) {
    setForm((f) => ({
      ...f,
      request_type: f.request_type.includes(t) ? f.request_type.filter((x) => x !== t) : [...f.request_type, t],
    }))
  }
  function toggleChecked(item: string) {
    setCheckedItems((items) => (items.includes(item) ? items.filter((i) => i !== item) : [...items, item]))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const { request_type, ...rest } = form
      const payload = { ...rest, request_type: request_type.join(','), checked_items: checkedItems }
      const saved = await api.put<PerformanceOut>(`/api/performance-requests/${editing.id}`, payload)
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${editing.request_id}`} onClose={onClose} wide>
      {editing?.qa_request && (
        <p className="muted small" style={{ marginTop: -8 }}>
          Auto-created from QA Request {editing.qa_request.request_id} — fill in the real
          details below before QA picks this up.
        </p>
      )}
      {!isAdmin && (
        <p className="muted small" style={{ marginTop: -4 }}>
          Application Name and CR Number/EPIC Number are locked once this request has been raised --
          only an Administrator can change them.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-section">
          {/* <div className="form-section-title">Identity{!isAdmin ? ' (Admin-only)' : ''}</div> */}
          <div className="form-row">
            <Field label="Application Name *"><input required disabled={!isAdmin} value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
            <Field label="CR Number/EPIC Number"><input disabled={!isAdmin} value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Test Basics</div>
          <div className="form-row">
            {/* Same DEPLOYMENT_ENVIRONMENTS reasoning as DetailsStep.tsx's
                own Deployment Environment field -- this is that same field
                for the Performance Edit modal, paired with Target Promotion
                Environment further down this form. */}
            <Field label="Environment">
              <select value={form.environment} onChange={(e) => set('environment', e.target.value)}>
                {DEPLOYMENT_ENVIRONMENTS.map((e_) => <option key={e_} value={e_}>{e_}</option>)}
              </select>
            </Field>
            <Field label="Risk Category">
              <select value={form.risk_category} onChange={(e) => set('risk_category', e.target.value)}>
                {RISK_RATINGS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                {PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Annexure VIII Details</div>
          <div className="chip-select">
            {PERFORMANCE_REQUEST_TYPES.map((t) => {
              const active = form.request_type.includes(t)
              return (
                <label key={t} className={`chip-toggle ${active ? 'active' : ''}`}>
                  <input type="checkbox" checked={active} onChange={() => toggleReqType(t)} />
                  <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
                  {t}
                </label>
              )
            })}
          </div>
          <div className="form-row" style={{ marginTop: 10 }}>
            <Field label="Change Type">
              <select value={form.change_type} onChange={(e) => set('change_type', e.target.value)}>
                <option value="">Select...</option>
                {CHANGE_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Vendor / SI Partner"><input value={form.vendor_si_partner} onChange={(e) => set('vendor_si_partner', e.target.value)} /></Field>
            <Field label="Technology Stack"><input value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
            <Field label="Release Version"><input value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
            <Field label="Build Number"><input value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
            <Field label="Target Promotion Environment">
              <select value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
                <option value="">Select...</option>
                {ENVIRONMENTS.filter((e_) => e_ !== 'Dev' && e_ !== 'SIT').map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          </div>
        </div>

        {editing.checklist_items.length > 0 && (
          <div className="form-section">
            <div className="form-section-title">
              Pre-Testing Readiness Checklist — Self-Declaration
            </div>
            <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
              Update what's already in place. This is your own declaration for reference only -- QA
              independently verifies every mandatory item during Readiness.
            </p>
            {/* Reported directly: "Attach Evidence is not uniform
                everywhere. On edit details it should be like while creating
                the request." -- reuses the same grid-table layout as the QA
                Request wizard's ReadinessChecklistSection.tsx. */}
            <div className="security-checklist-table" role="group" aria-label="Performance readiness checklist">
              <div className="security-checklist-header" aria-hidden="true">
                <span>Ready</span>
                <span>Readiness criterion</span>
                <span>Supporting evidence</span>
              </div>
              {editing.checklist_items.map((c) => {
                const checked = checkedItems.includes(c.item)
                const checkboxId = `performance-edit-checklist-${c.id}`
                return (
                  <div className={`security-checklist-row ${checked ? 'is-checked' : ''}`} key={c.id}>
                    <div className="security-checklist-check">
                      <input id={checkboxId} type="checkbox" checked={checked} onChange={() => toggleChecked(c.item)} />
                    </div>
                    <label className="security-checklist-criterion" htmlFor={checkboxId}>
                      <span>
                        <strong>{c.item}</strong>
                        {c.data_required && <span className="muted small">({c.data_required})</span>}
                        {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
                        {c.is_complete && <span className="badge badge-green">QA verified</span>}
                      </span>
                    </label>
                    <ChecklistEvidence apiBase="/api/performance-requests" reqId={editing.id} itemId={c.id}
                      canManage={canManageReadinessEvidence(editing.status, canManageEvidenceModal)}
                      required={c.is_mandatory || c.requester_checked}
                      documents={documentsByItem[c.id] || []}
                      onReload={reloadEvidence}
                      checked={checked} />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Changes'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Derived from PERFORMANCE_PENDING_WITH (constants.ts) -- the same table
// that already drives the list's "Pending With" column and is itself kept
// in exact sync with performance.py's require_roles()/
// _require_performance_execution_owner() gates -- rather than re-deriving
// its own status list. Only labels naming an actual role-holding group get
// a RoleGroupLink; "Requester" and "--" both resolve to null.
function assignedGroupFor(
  status: string,
  applicationMasterStatus?: string | null,
  department?: string | null,
): { role: string | string[]; label: string; department?: string | null } | null {
  // Reported directly (Application Owner group link): while status is still
  // SM_APPROVAL_PENDING but the Application Name is awaiting the
  // Application Owner (applicationNameAwareStatusLabel, same as the Status
  // badge override), the work is with the Application Owner, not the SM --
  // checked first since this is a sub-state of SM_APPROVAL_PENDING, not its
  // own status value. `department` scopes RoleGroupLink's member list, since
  // Application Owner is department-enforced server-side (require_same_department
  // in decide_app_owner_name).
  if (applicationNameAwareStatusLabel(status, applicationMasterStatus)) {
    return { role: 'APPLICATION_OWNER', label: 'Application Owner', department }
  }
  const pendingWith = PERFORMANCE_PENDING_WITH[status]
  // Reported directly: "SM mapping should be based on department level. but
  // SM group details showing those are from different department." SM and
  // Department Head are BOTH department-scoped roles enforced server-side
  // (require_same_department, performance.py) exactly like Application
  // Owner above -- `department` was missing here, so RoleGroupLink showed
  // every SM/Department Head in the system instead of just the ones who
  // could actually act on this request.
  if (pendingWith === 'SM') return { role: 'SM', label: 'SM', department }
  if (pendingWith === 'Department Head') {
    return { role: ['DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM'], label: 'Department Head', department }
  }
  // Reported directly: this "QA Lead group members" list should only show
  // literal QA_LEAD role holders -- Chief Manager - QA / AGM - QA act on
  // this work via their own separate Executive bypass (isAssignedQALead
  // below), not by being members of the QA Lead group.
  if (pendingWith === 'QA Lead') return { role: 'QA_LEAD', label: 'QA Lead' }
  // "QA" covers ENVIRONMENT_SETUP/SCRIPT_DEVELOPMENT/BASELINE/LOAD_TEST_EXECUTION
  // -- limited to QA_ENGINEER only (reported directly) -- "Assigned Tester(s)"
  // elsewhere on the page names the specific individual, this names the
  // execution-team group accountable for the stage; QA_LEAD has its own
  // separate group above instead of also appearing here.
  if (pendingWith === 'QA') return { role: QA_EXECUTION_GROUP_ROLE, label: 'QA' }
  return null
}

function PerformanceDetail({ req, onClose, onChanged, users }: {
  req: PerformanceOut; onClose: () => void; onChanged: (p: PerformanceOut) => void; users: UserOut[]
}) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [selectedQALead, setSelectedQALead] = useState('')
  const [selectedTesters, setSelectedTesters] = useState<string[]>([])
  // 2026-08 Reassignment CR -- a reason is mandatory when this is a genuine
  // reassignment (not the very first tester assignment); the backend
  // enforces this too (reassignment.require_reason), this is just the UI
  // half. Reset once the assignment actually changes (i.e. on success).
  const [reassignReason, setReassignReason] = useState('')
  useEffect(() => { setReassignReason('') }, [req.id, req.assigned_tester_ids])
  // Whether the "require Department Head re-approval on return" popup (see
  // canCompleteReadiness below) is open -- an always-visible checkbox next to
  // "Readiness Failed" was easy to miss, so this is now asked as a pop-up at
  // the moment of failing readiness instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'overview' | 'checklist' | 'documents' | 'history'>('overview')
  const [checklist, setChecklist] = useState<PerformanceChecklistItemOut[]>(req.checklist_items || [])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  useEffect(() => { setChecklist(req.checklist_items || []) }, [req])
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments('/api/performance-requests', req.id)

  const loadExtras = useCallback(async () => {
    try {
      setHistory(await api.get<ApprovalActionOut[]>(`/api/performance-requests/${req.id}/history`))
    } catch (err) { setError(err) }
  }, [req.id])
  useEffect(() => { loadExtras() }, [loadExtras])

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try {
      onChanged(await api.post<PerformanceOut>(`/api/performance-requests/${req.id}/${action}`, extra || {}))
      setComments('')
      await loadExtras()
    }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function toggleChecklistItem(item: PerformanceChecklistItemOut) {
    setError(null)
    try {
      const saved = await api.put<PerformanceChecklistItemOut>(
        `/api/performance-requests/${req.id}/checklist/${item.id}`, { is_complete: !item.is_complete }
      )
      setChecklist((rows) => rows.map((r) => (r.id === saved.id ? saved : r)))
    } catch (err) { setError(err) }
  }

  const pendingChecklistItems = checklist.filter((c) => c.is_mandatory && !c.is_complete)

  const isRequester = req.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = req.status
  const sameDept = hasDepartment(user, req.department)
  const isAdmin = hasRole(user, 'ADMIN')
  // Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on every QA-Lead-
  // gated action, same as Admin, without being listed as "QA Lead group"
  // members (display-only concern, see assignedGroupFor above). See
  // ORACLE_MIGRATION_2026-07.md section 59.
  const isAssignedQALead = isAdmin || hasRole(user, 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')
  const assignedTesterIds = new Set((req.assigned_tester_ids || '').split(',').filter(Boolean).map(Number))
  const isAssignedTester = isAdmin || (hasRole(user, 'QA_ENGINEER') && !!user?.id && assignedTesterIds.has(user.id))
  const isExecutionOwner = isAssignedQALead || isAssignedTester
  const qaLeads = users.filter((u) => u.is_active && hasDepartment(u, QA_DEPARTMENT) && (u.roles || []).includes('QA_LEAD'))
  const testers = users.filter((u) => u.is_active && hasDepartment(u, QA_DEPARTMENT) && (u.roles || []).includes('QA_ENGINEER'))

  // Edit access -- see the matching (and more detailed) comment in
  // SAST.tsx's canEditDetails for the full reasoning; same rule here.
  // SM_REJECTED included alongside the RETURNED_BY_* statuses -- reported
  // directly, a rejected request is now reopenable (edit + resubmit)
  // instead of a dead end.
  const canEditDetails = hasRole(user, 'ADMIN')
    || (isRequester && ['DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER'].includes(status))
    || (hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && sameDept)
    || (hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDept)
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER'].includes(status)
  const resubmitLabel = status === 'SM_REJECTED' ? 'Reopen Request' : 'Re-submit'
  // Blocks Sign/Approve on both the SM and Department Head decision panels
  // below while this request's Application Name is still PENDING/REJECTED
  // (not yet APPROVED) -- see RequestDetail.tsx's ApplicationNameBanner
  // (moved there from this page -- see the "must be at master request
  // level, not on individual request level of childs" report).
  const applicationNameBlocking = !!req.application_master_status && req.application_master_status !== 'APPROVED'
  // Tier-aware -- names the actual holdup instead of always claiming "your
  // decision above". The actual decision now happens on the master QA
  // Request page, not "above" on this page at all -- see
  // RequestDetail.tsx's ApplicationNameBanner.
  const smApplicationNameBlockedMessage =
    req.application_master_status === 'PENDING_APP_OWNER'
      ? "This request's Application Name is still pending Application Owner approval -- it needs to be decided there before you can approve this request."
      : req.application_master_status === 'REJECTED'
      ? "This request's Application Name was rejected -- the requester needs to pick a different name before this request can be approved."
      : "Application Name is still pending your decision -- decide it from this request's QA Request page before approving this request."
  // Reported directly: a person who raised this request but also separately
  // holds SM/Department Head for the same department must not be able to
  // approve their own request -- someone else holding that role must decide
  // it instead. Admin still bypasses (matches the backend's
  // require_not_requester, which enforces the same check server-side).
  const isSelfApproval = req.requester_id === user?.id && !hasRole(user, 'ADMIN')
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN')) && !isSelfApproval
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN')) && !isSelfApproval
  // Reported directly: "only the assigned person can update" -- once the
  // request has moved past the requester, evidence control passes
  // exclusively to whoever it's actually sitting with now, matching the
  // backend's own (now-exclusive) _can_upload_documents.
  const evidenceOwner = isAdmin || (
    status === 'SM_APPROVAL_PENDING' ? canSMDecide :
    status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecide :
    isRequester
  )
  // Document and Evidence Access Control Based on Workflow Stage: exactly 3
  // upload stages, then a hard lock -- (1) the requester while it's Draft/
  // Submitted/Returned-by-*/Rejected/back for final verification, (2) the
  // SM only while SM_APPROVAL_PENDING, (3) the Department Head only while
  // DEPARTMENT_HEAD_APPROVAL_PENDING. Every post-readiness engineer/tester
  // status after Department Head approval is locked for everyone but Admin
  // -- mirrors the backend's own (now-simplified) _can_upload_documents
  // exactly. Used for the general Documents tab; evidenceOwner above
  // covers the same 3 stages for checklist evidence.
  const canManageDocuments = isAdmin || (
    ['DRAFT', 'SUBMITTED', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER', 'REQUESTER_VERIFICATION'].includes(status) ? isRequester :
    status === 'SM_APPROVAL_PENDING' ? canSMDecide :
    status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecide :
    false
  )
  // Reported directly: canEditDetails below lets the SM/Department Head
  // themselves open Edit Details while the request sits at their own
  // decision -- if they untick a mandatory Readiness checklist item there,
  // Sign/Approve must be blocked the exact same way the QA Request wizard
  // already blocks Submit/Raise for the same reason (see
  // QARequests/RequestDetail.tsx's own pendingMandatory, and the matching
  // pendingSelfDeclare already used for Submit/Resubmit in SAST.tsx/
  // DAST.tsx -- same name/shape here for consistency).
  const pendingSelfDeclare = checklist.filter((c) => c.is_mandatory && !c.requester_checked)
  const canStartReadiness = isAssignedQALead && status === 'ENGINEER_ASSIGNED'
  const canCompleteReadiness = isAssignedQALead && status === 'READINESS'
  const canCompleteFeasibility = isAssignedQALead && status === 'FEASIBILITY'
  // 2026-08 -- reported directly: "once assigned there are no other option
  // to reassign the tester or modify the tester. give qa lead to reassign as
  // well as the current assign people can reasign to another qa member."
  // Widened the same way as Functional.tsx's canAssignTester: QA Lead group
  // OR any currently-assigned tester, across the full
  // PERFORMANCE_TESTER_REASSIGNABLE_STATUSES window (Planning onward) --
  // not just while status is exactly PLANNING. The backend
  // (performance.py's complete-planning) enforces the same window/authors;
  // this only decides whether the button renders. Calling it while status
  // is still PLANNING is the initial assignment (advances to
  // ENVIRONMENT_SETUP); any later status is a pure reassignment that leaves
  // status untouched -- see isInitialPerformanceTesterAssignment below.
  const isInitialPerformanceTesterAssignment = status === 'PLANNING'
  // 2026-08 Reassignment CR, reported directly: "Reassignment shall be
  // permitted to: the current assignee, the Department Head of the
  // department to which the current assignee belongs, or Admin users." --
  // then, reported directly again: QA_LEAD is required to keep reassignment
  // rights too, restoring parity with isAssignedQALead (which already gates
  // the first assignment). Mirrors performance.py's
  // _require_can_reassign_performance_tester exactly.
  const isQADepartmentHead = isAdmin || (hasRole(user, 'CHIEF_MANAGER_QA', 'AGM_QA') && hasDepartment(user, QA_DEPARTMENT))
  const canReassignPerformanceTester = isAssignedTester || isQADepartmentHead || hasRole(user, 'QA_LEAD')
  const canCompletePlanning =
    (isInitialPerformanceTesterAssignment ? isAssignedQALead || isAssignedTester : canReassignPerformanceTester) &&
    PERFORMANCE_TESTER_REASSIGNABLE_STATUSES.includes(status)
  const currentTesterIds = (req.assigned_tester_ids || '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b)
  const nextTesterIds = selectedTesters.map(Number).sort((a, b) => a - b)
  const testerAssignmentChanged = currentTesterIds.length !== nextTesterIds.length || currentTesterIds.some((id, index) => id !== nextTesterIds[index])
  const canCompleteEnvSetup = isExecutionOwner && status === 'ENVIRONMENT_SETUP'
  const canCompleteScriptDev = isExecutionOwner && status === 'SCRIPT_DEVELOPMENT'
  const canCompleteBaseline = isExecutionOwner && status === 'BASELINE'
  const canCompleteLoadTest = isExecutionOwner && status === 'LOAD_TEST_EXECUTION'
  const canResultAnalysisDecide = isAssignedQALead && status === 'RESULT_ANALYSIS'
  const canCompleteDefectFixRetest = isExecutionOwner && status === 'DEFECT_FIX_RETEST'
  const canCompleteReport = isAssignedQALead && status === 'REPORT'
  const canSignOff = isAssignedQALead && status === 'SIGNOFF_PENDING'
  const canRequesterDecide = isRequester && status === 'REQUESTER_VERIFICATION'
  const canVerifyChecklist = isAssignedQALead && status === 'READINESS'

  // Pre-fill the picker with the currently-assigned tester(s) when this is a
  // reassignment (not the first-ever assignment) -- same reasoning as
  // Functional.tsx's matching effect.
  useEffect(() => {
    if (canCompletePlanning && !isInitialPerformanceTesterAssignment) {
      setSelectedTesters((req.assigned_tester_ids || '').split(',').filter(Boolean))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.id, req.assigned_tester_ids, isInitialPerformanceTesterAssignment])

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <ErrorText error={error} />

      <div className="tabs">
        <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" className={tab === 'checklist' ? 'active' : ''} onClick={() => setTab('checklist')}>
          Checklist
        </button>
        <button type="button" className={tab === 'documents' ? 'active' : ''} onClick={() => setTab('documents')}>Documents</button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Activity</button>
      </div>

      {tab === 'overview' && (
        <>
          <DetailSection title="Status">
            <DetailField label="Status">
              <Badge status={status} label={applicationNameAwareStatusLabel(status, req.application_master_status)} />
              {req.needs_dept_head_reapproval && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                  Department Head re-approval required after changes
                </span>
              )}
            </DetailField>
            <DetailField label="Priority">{req.priority || '—'}</DetailField>
            <DetailField label="Risk Category">{req.risk_category || '—'}</DetailField>
            <DetailField label="Created">{new Date(req.created_at).toLocaleString()}</DetailField>
            <DetailField label="Last Updated">{new Date(req.updated_at).toLocaleString()}</DetailField>
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Application Name">
              {req.application_name || '—'}
              {req.application_master_status === 'PENDING_APP_OWNER' && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                  Application Owner Approval Pending
                </span>
              )}
              {req.application_master_status === 'PENDING_SM' && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                  Pending SM Approval
                </span>
              )}
              {req.application_master_status === 'REJECTED' && (
                <span className="badge badge-red" style={{ marginLeft: 8 }}>
                  Rejected — pick a different name
                </span>
              )}
            </DetailField>
            <DetailField label="CR Number/EPIC Number">{req.cr_number || req.epic_number || '—'}</DetailField>
            <DetailField label="Department">{req.department || '—'}</DetailField>
            <DetailField label="Application Owner">{req.application_owner || '—'}</DetailField>
            <DetailField label="Change Type">{req.change_type || '—'}</DetailField>
            <DetailField label="Request Type">{req.request_type || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Test Parameters & Environment">
            <DetailField label="Environment">{req.environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Release & Vendor">
            <DetailField label="Release Version">{req.release_version || '—'}</DetailField>
            <DetailField label="Build Number">{req.build_number || '—'}</DetailField>
            <DetailField label="Vendor / SI Partner">{req.vendor_si_partner || '—'}</DetailField>
            <DetailField label="Technology Stack">{req.technology_stack || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
            <DetailField label="Assigned Group">{(() => {
              const assigned = assignedGroupFor(req.status, req.application_master_status, req.department)
              return assigned ? <RoleGroupLink users={users} role={assigned.role} label={assigned.label} department={assigned.department} /> : '—'
            })()}</DetailField>
            <DetailField label="Assigned QA Tester(s)">
              {req.assigned_tester_ids
                ? req.assigned_tester_ids.split(',').map((id) => userName(users, Number(id)) || id).join(', ')
                : '—'}
            </DetailField>
          </DetailSection>

          {req.qa_request && <p className="muted small">Linked from QA Request {req.qa_request.request_id}.</p>}

          {/* Reported directly: canEditDetails below lets the SM/Department
              Head themselves open Edit Details while the request sits at
              their own decision -- if they untick a mandatory Pre-Testing
              Readiness checklist item there, Sign/Approve must be blocked
              the exact same way the QA Request wizard already blocks
              Submit/Raise for the same reason (see
              QARequests/RequestDetail.tsx's own pendingMandatory). */}
          {(canSMDecide || canDeptHeadDecide) && pendingSelfDeclare.length > 0 && (
            <div style={{ marginTop: 8, marginBottom: 8, background: '#fffaeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', color: '#92400e', fontSize: 13 }}>
              <strong>Cannot Sign/Approve yet</strong> — the following mandatory Pre-Testing Readiness checklist item(s)
              must be self-declared ready first (Edit Details):
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {pendingSelfDeclare.map((c) => <li key={c.item}>{c.item}</li>)}
              </ul>
            </div>
          )}

          <div className="actions-panel">
          {canCompleteReadiness && pendingChecklistItems.length > 0 && (
            <p className="muted small" style={{ color: 'var(--danger, #c0392b)' }}>
              {pendingChecklistItems.length} mandatory pre-testing readiness checklist item(s) still incomplete —
              see the Readiness Checklist tab. These must all be ticked complete before Readiness can advance.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, margin: '10px 0', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/performance-requests/${req.id}/export`, `${req.request_id}.pdf`)}>
              Export PDF
            </button>
            {canEditDetails && <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(true)}>Edit Details</button>}
            {canSubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('submit')}>Submit for SM Approval</button>}
            {canResubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('resubmit')}>{resubmitLabel}</button>}
            {canSMDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={busy}
                signBlocked={applicationNameBlocking || pendingSelfDeclare.length > 0}
                signBlockedMessage={
                  applicationNameBlocking
                    ? smApplicationNameBlockedMessage
                    : pendingSelfDeclare.length > 0
                    ? 'Mandatory Pre-Testing Readiness checklist item(s) are not self-declared ready -- see the notice above.'
                    : undefined
                }
                onApprove={(signed) => act('sm-decision', { decision: 'Approved', comments: signed })}
                onReturn={(actionNote) => act('sm-decision', { decision: 'Returned', comments: actionNote })}
                onReject={(actionNote) => act('sm-decision', { decision: 'Rejected', comments: actionNote })}
              />
            )}
            {canDeptHeadDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={busy}
                signBlocked={applicationNameBlocking || pendingSelfDeclare.length > 0}
                signBlockedMessage={
                  applicationNameBlocking
                    ? "This request's Application Name is not yet approved by SM."
                    : pendingSelfDeclare.length > 0
                    ? 'Mandatory Pre-Testing Readiness checklist item(s) are not self-declared ready -- see the notice above.'
                    : undefined
                }
                extraControlLabel="Assign to group"
                extraControl={<RoleGroupLink users={users} role="QA_LEAD" label="QA Lead" />}
                extraReady
                onApprove={(signed) => act('department-head-decision', { decision: 'Approved', comments: signed })}
                onReturn={(actionNote) => act('department-head-decision', { decision: 'Returned', comments: actionNote })}
                onReject={(actionNote) => act('department-head-decision', { decision: 'Rejected', comments: actionNote })}
              />
            )}
            {canStartReadiness && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-readiness')}>Start Readiness</button>}
            {canCompleteReadiness && (
              <>
                <button className="btn btn-success btn-sm" disabled={busy || pendingChecklistItems.length > 0}
                        onClick={() => act('readiness-decision', { decision: 'Passed', comments })}>
                  Readiness Passed
                </button>
                <button className="btn btn-danger btn-sm" disabled={busy}
                        onClick={() => setShowReapprovalConfirm(true)}>
                  Readiness Failed
                </button>
              </>
            )}
            {showReapprovalConfirm && (
              <ConfirmModal
                title="Readiness Failed"
                message="Require Department Head re-approval when this request is returned to the requester?"
                confirmLabel="Yes, require re-approval"
                cancelLabel="No, skip re-approval"
                busy={busy}
                onConfirm={() => {
                  setShowReapprovalConfirm(false)
                  act('readiness-decision', { decision: 'Failed', comments, require_dept_head_reapproval: true })
                }}
                onCancel={() => {
                  setShowReapprovalConfirm(false)
                  act('readiness-decision', { decision: 'Failed', comments, require_dept_head_reapproval: false })
                }}
              />
            )}
            {canCompleteFeasibility && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-feasibility')}>Complete Feasibility</button>}
            {canCompletePlanning && (
              <>
                <MultiUserAssignSelect
                  value={selectedTesters}
                  onChange={setSelectedTesters}
                  users={testers}
                  placeholder={
                    isInitialPerformanceTesterAssignment
                      ? 'Assign QA Tester(s)...'
                      : 'Reassign QA Tester(s)...'
                  }
                  disabled={busy}
                  style={{ minWidth: 260 }}
                />
                {!isInitialPerformanceTesterAssignment && (
                  <input
                    className="reassign-reason-input"
                    style={{ minWidth: 220 }}
                    placeholder="Reason for reassignment *"
                    value={reassignReason}
                    onChange={(e) => setReassignReason(e.target.value)}
                    disabled={busy}
                  />
                )}
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || selectedTesters.length === 0 || (!isInitialPerformanceTesterAssignment && (!testerAssignmentChanged || !reassignReason.trim()))}
                  onClick={() => act('complete-planning', {
                    tester_ids: selectedTesters.map(Number),
                    ...(isInitialPerformanceTesterAssignment ? {} : { reason: reassignReason.trim() }),
                  })}
                >
                  {isInitialPerformanceTesterAssignment
                    ? 'Assign Tester(s) & Complete Planning'
                    : 'Reassign Tester(s)'}
                </button>
              </>
            )}
            {canCompleteEnvSetup && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-environment-setup')}>Complete Environment Setup</button>}
            {canCompleteScriptDev && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-script-development')}>Complete Script Development</button>}
            {canCompleteBaseline && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-baseline')}>Complete Baseline</button>}
            {canCompleteLoadTest && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-load-test')}>Complete Load Test Execution</button>}
            {canResultAnalysisDecide && (
              <WorkflowDecisionPanel busy={busy} title="Result analysis decision" options={[
                { key: 'pass', label: 'Result Analysis Passed', description: 'Accept results and continue the workflow', tone: 'approve', onClick: () => act('result-analysis-decision', { decision: 'Passed', comments }) },
                { key: 'fail', label: 'Result Analysis Failed', description: 'Record failure and start corrective action', tone: 'reject', onClick: () => act('result-analysis-decision', { decision: 'Failed', comments }) },
              ]} />
            )}
            {canCompleteDefectFixRetest && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-defect-fix-retest')}>Complete Defect / Fix / Retest</button>}
            {canCompleteReport && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-report')}>Complete Report</button>}
            {canSignOff && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('sign-off')}>Sign Off</button>}
            {canRequesterDecide && (
              <WorkflowDecisionPanel busy={busy} title="Requester verification decision" options={[
                { key: 'accept', label: 'Accept & Close', description: 'Confirm the result and complete the request', tone: 'approve', onClick: () => act('requester-decision', { decision: 'Accepted', comments }) },
                { key: 'changes', label: 'Request Changes', description: 'Return the request for additional work', tone: 'return', onClick: () => act('requester-decision', { decision: 'ChangesRequired', comments }) },
              ]} />
            )}
          </div>
          </div>
        </>
      )}

      {tab === 'checklist' && (
        <div>
          <p className="muted small">L1: Pre-Testing Readiness Checklist (Annexure VIII) — all mandatory items must be complete before this request can move past Readiness.</p>
          <p className="muted small">
            <strong>Requester declared</strong> is the requester's own self-declaration at raise-time (reference
            only). <strong>QA verified</strong> is the binding, independent verification — ticking a
            requester-declared item does NOT auto-approve it here.
          </p>
          {status !== 'READINESS' && (
            <p className="muted small">QA verification is locked outside the Readiness stage (current status: {status}).</p>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontWeight: 600, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ flex: 1 }}>Item</span>
            <span style={{ width: 130, textAlign: 'center' }}>Requester declared</span>
            <span style={{ width: 130, textAlign: 'center' }}>QA verified</span>
            <span style={{ width: 230, textAlign: 'center' }}>Evidence</span>
          </div>
          {checklist.length === 0 && <p className="muted small">No checklist items found.</p>}
          {checklist.map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ flex: 1 }}>
                {c.item} <span className="muted small">({c.data_required})</span>{' '}
                {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
              </span>
              <span style={{ width: 130, textAlign: 'center' }}>
                {c.requester_checked
                  ? <span className="badge badge-blue">Declared</span>
                  : <span className="muted small">Not ticked</span>}
              </span>
              <span style={{ width: 130, textAlign: 'center' }}>
                <input
                  type="checkbox" checked={c.is_complete}
                  disabled={
                    !canVerifyChecklist ||
                    (!c.requester_checked && !c.is_complete)
                  }
                  title={
                    !canVerifyChecklist
                      ? 'Only verifiable by QA Lead / QA Engineer / Business Analyst during Readiness'
                      : (!c.requester_checked && !c.is_complete)
                        ? 'The requester has not self-declared this item ready yet -- cannot verify it until they tick it'
                        : ''
                  }
                  onChange={() => toggleChecklistItem(c)}
                />
              </span>
              <ChecklistEvidence apiBase="/api/performance-requests" reqId={req.id} itemId={c.id}
                canManage={canManageReadinessEvidence(req.status, evidenceOwner)}
                required={c.is_mandatory || c.requester_checked}
                documents={documentsByItem[c.id] || []}
                onReload={reloadEvidence}
                checked={c.requester_checked} />
            </div>
          ))}
        </div>
      )}

      {tab === 'history' && (
        <JiraActivity entityType="PERFORMANCE" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/performance-requests" reqId={req.id} canManage={canManageDocuments} />}

      {editing && (
        <PerformanceFormModal editing={req} onClose={() => setEditing(false)} onSaved={(saved) => { setEditing(false); onChanged(saved); setChecklist(saved.checklist_items || []) }} />
      )}
    </Modal>
  )
}

export default function Performance() {
  // SRS 7.2 PAG-006 -- the list only ever holds the lightweight
  // PerformanceListOut shape; opening a request fetches the full
  // PerformanceOut record fresh via GET /api/performance-requests/{id}
  // before PerformanceDetail (which needs every field) is shown.
  const [selected, setSelected] = useState<PerformanceOut | null>(null)
  const [openingId, setOpeningId] = useState<number | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const {
    items: rows, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading, setPage, setPageSize, reload,
  } = usePaginatedList<PerformanceListOut>('/api/performance-requests', {})

  useEffect(() => {
    // Full user list -- not just QA Engineer/Lead -- so both the Assign
    // Requester and readiness-starter fields can
    // resolve names from a single fetch.
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names/dropdown just stay empty */ })
  }, [])

  const openRequest = useCallback(async (idOrRow: number | PerformanceListOut) => {
    const id = typeof idOrRow === 'number' ? idOrRow : idOrRow.id
    setOpeningId(id)
    try {
      setSelected(await api.get<PerformanceOut>(`/api/performance-requests/${id}`))
    } catch (err) { setError(err) } finally { setOpeningId(null) }
  }, [])

  // Deep-link support -- see the matching effect in Functional.tsx for the
  // full reasoning; the gateway's "Linked Requests" table opens a specific
  // Performance request here via `?open=<request_id>`.
  useEffect(() => {
    const openId = searchParams.get('open')
    if (!openId || rows.length === 0) return
    const match = rows.find((r) => r.request_id === openId)
    if (match) openRequest(match.id)
    setSearchParams((p) => { p.delete('open'); return p }, { replace: true })
  }, [rows, searchParams, setSearchParams, openRequest])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Performance Testing Requests" count={total}
        subtitle="Load/performance testing requests, from submission through baseline, load test execution, and sign-off. Raised via a QA Request (include Performance Testing in its request types) -- not created standalone here."
      />
      <Card>
        <Table rowKey="id" onRowClick={(r) => openRequest(r)}
          server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange: setPage, onPageSizeChange: setPageSize, loading }}
          columns={[
          {
            key: 'request_id',
            header: 'Request ID',
            render: (r) => (openingId === r.id ? 'Opening…' : r.request_id),
          },
          { key: 'application_name', header: 'Application' },
          { key: 'requester_id', header: 'Requester', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
          { key: 'engineer_id', header: 'Assigned Group', render: (r) => assignedGroupFor(r.status, r.application_master_status)?.label || '—', filterValue: (r) => assignedGroupFor(r.status, r.application_master_status)?.label || '' },
          { key: 'priority', header: 'Priority', render: (r) => r.priority || '—' },
          { key: 'risk_category', header: 'Risk' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} label={applicationNameAwareStatusLabel(r.status, r.application_master_status)} /> },
          { key: 'pending_with', header: 'Pending With', render: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? 'Application Owner' : (PERFORMANCE_PENDING_WITH[r.status] || '—'), filterValue: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? 'Application Owner' : (PERFORMANCE_PENDING_WITH[r.status] || '') },
          { key: 'source', header: 'Source', render: (r) => (
            r.qa_request ? (
              <span className="badge badge-blue" title="Auto-created from a QA Request">Linked · {r.qa_request.request_id}</span>
            ) : <span className="badge badge-gray">Standalone (legacy)</span>
          ), filterValue: (r) => r.qa_request ? `Linked ${r.qa_request.request_id}` : 'Standalone legacy' },
          { key: 'created_at', header: 'Created', render: (r) => new Date(r.created_at).toLocaleString() },
          { key: 'updated_at', header: 'Updated', render: (r) => new Date(r.updated_at).toLocaleString() },
        ]} rows={rows} />
      </Card>
      {selected && (
        <PerformanceDetail req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); reload() }} users={users} />
      )}
    </div>
  )
}
