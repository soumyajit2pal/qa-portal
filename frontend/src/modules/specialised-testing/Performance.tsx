import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, DetailSection, DetailField, RequestDocuments, ChecklistEvidence, applicationNameAwareStatusLabel } from '../../components/Common'
import UserAssignSelect from '../../components/UserAssignSelect'
import MultiUserAssignSelect from '../../components/MultiUserAssignSelect'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import { IconCheckCircle } from '../../components/Icons'
import {
  PRIORITIES, RISK_RATINGS, ENVIRONMENTS, PERFORMANCE_EDITABLE_STATUSES,
  PERFORMANCE_REQUEST_TYPES, CHANGE_TYPES, hasRole, canManageReadinessEvidence,
  QA_DEPARTMENT, PERFORMANCE_PENDING_WITH,
} from '../../constants'
import { PerformanceOut, PerformanceChecklistItemOut, UserOut, ApprovalActionOut } from '../../types'

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
    application_name: editing.application_name || '', epic_number: editing.epic_number || '',
    cr_number: editing.cr_number || '', environment: editing.environment || 'UAT',
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
          Application Name, Epic Number and CR Number are locked once this request has been raised --
          only an Administrator can change them.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title">Identity{!isAdmin ? ' (Admin-only)' : ''}</div>
          <div className="form-row">
            <Field label="Application Name *"><input required disabled={!isAdmin} value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
            <Field label="Epic Number"><input disabled={!isAdmin} value={form.epic_number} onChange={(e) => set('epic_number', e.target.value)} /></Field>
            <Field label="CR Number"><input disabled={!isAdmin} value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Test Basics</div>
          <div className="form-row">
            <Field label="Environment">
              <select value={form.environment} onChange={(e) => set('environment', e.target.value)}>
                {ENVIRONMENTS.map((e_) => <option key={e_} value={e_}>{e_}</option>)}
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
            {editing.checklist_items.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
                  <input type="checkbox" checked={checkedItems.includes(c.item)} onChange={() => toggleChecked(c.item)} />
                  <span>
                    {c.item} {c.data_required && <span className="muted small">({c.data_required})</span>}{' '}
                    {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
                  </span>
                </label>
                {c.is_complete && <span className="badge badge-green">QA verified</span>}
                <ChecklistEvidence apiBase="/api/performance-requests" reqId={editing.id} itemId={c.id}
                  canManage={canManageReadinessEvidence(editing.status)}
                  required={c.is_mandatory || c.requester_checked} />
              </div>
            ))}
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

function PerformanceDetail({ req, onClose, onChanged, users }: {
  req: PerformanceOut; onClose: () => void; onChanged: (p: PerformanceOut) => void; users: UserOut[]
}) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [selectedQALead, setSelectedQALead] = useState('')
  const [selectedTesters, setSelectedTesters] = useState<string[]>([])
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
  const sameDept = !!user?.department && user.department === req.department
  const isAdmin = hasRole(user, 'ADMIN')
  const isAssignedQALead = isAdmin || (hasRole(user, 'QA_LEAD') && req.engineer_id === user?.id)
  const assignedTesterIds = new Set((req.assigned_tester_ids || '').split(',').filter(Boolean).map(Number))
  const isAssignedTester = isAdmin || (hasRole(user, 'QA_ENGINEER') && !!user?.id && assignedTesterIds.has(user.id))
  const isExecutionOwner = isAssignedQALead || isAssignedTester
  const qaLeads = users.filter((u) => u.is_active && u.department === QA_DEPARTMENT && (u.roles || []).includes('QA_LEAD'))
  const testers = users.filter((u) => u.is_active && u.department === QA_DEPARTMENT && (u.roles || []).includes('QA_ENGINEER'))

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
  const canStartReadiness = isAssignedQALead && status === 'ENGINEER_ASSIGNED'
  const canCompleteReadiness = isAssignedQALead && status === 'READINESS'
  const canCompleteFeasibility = isAssignedQALead && status === 'FEASIBILITY'
  const canCompletePlanning = isAssignedQALead && status === 'PLANNING'
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

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <ErrorText error={error} />

      <div className="tabs">
        <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" className={tab === 'checklist' ? 'active' : ''} onClick={() => setTab('checklist')}>
          Checklist {pendingChecklistItems.length > 0 && `(${pendingChecklistItems.length} pending)`}
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
            <DetailField label="Epic Number">{req.epic_number || '—'}</DetailField>
            <DetailField label="CR Number">{req.cr_number || '—'}</DetailField>
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
            <DetailField label="Assigned QA Lead">{userName(users, req.engineer_id) || 'Not assigned'}</DetailField>
            <DetailField label="Assigned QA Tester(s)">
              {req.assigned_tester_ids
                ? req.assigned_tester_ids.split(',').map((id) => userName(users, Number(id)) || id).join(', ')
                : '—'}
            </DetailField>
          </DetailSection>

          {req.qa_request && <p className="muted small">Linked from QA Request {req.qa_request.request_id}.</p>}

          <div className="actions-panel">
          <Field label="Action note (optional)">
            <input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Attached only to the next workflow action" />
          </Field>
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
                signBlocked={applicationNameBlocking}
                signBlockedMessage={smApplicationNameBlockedMessage}
                onApprove={(signed) => act('sm-decision', { decision: 'Approved', comments: signed })}
                onReturn={() => act('sm-decision', { decision: 'Returned', comments })}
                onReject={() => act('sm-decision', { decision: 'Rejected', comments })}
              />
            )}
            {canDeptHeadDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={busy}
                signBlocked={applicationNameBlocking}
                signBlockedMessage="This request's Application Name is not yet approved by SM."
                extraControlLabel="Assign IT-QA QA Lead"
                extraControl={
                  <UserAssignSelect
                    value={selectedQALead}
                    onChange={setSelectedQALead}
                    users={qaLeads}
                    placeholder="Select QA Lead..."
                    disabled={busy}
                    style={{ minWidth: 260 }}
                  />
                }
                extraReady={!!selectedQALead}
                onApprove={(signed) => act('department-head-decision', { decision: 'Approved', comments: signed, qa_lead_id: Number(selectedQALead) })}
                onReturn={() => act('department-head-decision', { decision: 'Returned', comments })}
                onReject={() => act('department-head-decision', { decision: 'Rejected', comments })}
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
                  placeholder="Assign QA Tester(s)..."
                  disabled={busy}
                  style={{ minWidth: 260 }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || selectedTesters.length === 0}
                  onClick={() => act('complete-planning', { tester_ids: selectedTesters.map(Number) })}
                >
                  Assign Tester(s) &amp; Complete Planning
                </button>
              </>
            )}
            {canCompleteEnvSetup && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-environment-setup')}>Complete Environment Setup</button>}
            {canCompleteScriptDev && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-script-development')}>Complete Script Development</button>}
            {canCompleteBaseline && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-baseline')}>Complete Baseline</button>}
            {canCompleteLoadTest && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-load-test')}>Complete Load Test Execution</button>}
            {canResultAnalysisDecide && (
              <>
                <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('result-analysis-decision', { decision: 'Passed', comments })}>Result Analysis Passed</button>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('result-analysis-decision', { decision: 'Failed', comments })}>Result Analysis Failed</button>
              </>
            )}
            {canCompleteDefectFixRetest && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-defect-fix-retest')}>Complete Defect / Fix / Retest</button>}
            {canCompleteReport && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-report')}>Complete Report</button>}
            {canSignOff && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('sign-off')}>Sign Off</button>}
            {canRequesterDecide && (
              <>
                <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('requester-decision', { decision: 'Accepted', comments })}>Accept &amp; Close</button>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('requester-decision', { decision: 'ChangesRequired', comments })}>Request Changes</button>
              </>
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
                canManage={canManageReadinessEvidence(req.status)}
                required={c.is_mandatory || c.requester_checked} />
            </div>
          ))}
        </div>
      )}

      {tab === 'history' && (
        <JiraActivity entityType="PERFORMANCE" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/performance-requests" reqId={req.id} />}

      {editing && (
        <PerformanceFormModal editing={req} onClose={() => setEditing(false)} onSaved={(saved) => { setEditing(false); onChanged(saved); setChecklist(saved.checklist_items || []) }} />
      )}
    </Modal>
  )
}

export default function Performance() {
  const [rows, setRows] = useState<PerformanceOut[]>([])
  const [selected, setSelected] = useState<PerformanceOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setRows(await api.get<PerformanceOut[]>('/api/performance-requests')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    // Full user list -- not just QA Engineer/Lead -- so both the Assign
    // Requester and readiness-starter fields can
    // resolve names from a single fetch.
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names/dropdown just stay empty */ })
  }, [])

  // Deep-link support -- see the matching effect in Functional.tsx for the
  // full reasoning; the gateway's "Linked Requests" table opens a specific
  // Performance request here via `?open=<request_id>`.
  useEffect(() => {
    const openId = searchParams.get('open')
    if (!openId || rows.length === 0) return
    const match = rows.find((r) => r.request_id === openId)
    if (match) setSelected(match)
    setSearchParams((p) => { p.delete('open'); return p }, { replace: true })
  }, [rows, searchParams, setSearchParams])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Performance Testing Requests" count={rows.length}
        subtitle="Load/performance testing requests, from submission through baseline, load test execution, and sign-off. Raised via a QA Request (include Performance Testing in its request types) -- not created standalone here."
      />
      <Card>
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
          { key: 'request_id', header: 'Request ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'requester_id', header: 'Requester', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
          { key: 'engineer_id', header: 'Assigned QA Lead', render: (r) => userName(users, r.engineer_id) || 'Not assigned', filterValue: (r) => userName(users, r.engineer_id) || '' },
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
        <PerformanceDetail req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} />
      )}
    </div>
  )
}
