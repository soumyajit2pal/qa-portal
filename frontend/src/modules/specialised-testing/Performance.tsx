import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, DetailSection, DetailField, RequestDocuments } from '../../components/Common'
import { ApplicationNameBanner } from '../../components/ApplicationNameBanner'
import UserAssignSelect from '../../components/UserAssignSelect'
import ConfirmModal from '../../components/ConfirmModal'
import { IconCheckCircle } from '../../components/Icons'
import {
  PRIORITIES, RISK_RATINGS, ENVIRONMENTS, PERFORMANCE_EDITABLE_STATUSES,
  PERFORMANCE_REQUEST_TYPES, CHANGE_TYPES, hasRole,
} from '../../constants'
import { PerformanceOut, PerformanceChecklistItemOut, UserOut, WalkthroughOut, ApprovalActionOut } from '../../types'

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
    cr_number: editing.cr_number || '', tool_used: editing.tool_used || '',
    target_load: editing.target_load || '', environment: editing.environment || 'UAT',
    risk_category: editing.risk_category || 'Medium', priority: editing.priority || 'Medium',
    request_type: (editing.request_type || '').split(',').filter(Boolean) as string[],
    change_type: editing.change_type || '', vendor_si_partner: editing.vendor_si_partner || '',
    technology_stack: editing.technology_stack || '', release_version: editing.release_version || '',
    build_number: editing.build_number || '', hash_value: editing.hash_value || '',
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
            <Field label="Tool Used"><input placeholder="e.g. JMeter, LoadRunner" value={form.tool_used} onChange={(e) => set('tool_used', e.target.value)} /></Field>
            <Field label="Target Load"><input placeholder="e.g. 500 concurrent users / 200 TPS" value={form.target_load} onChange={(e) => set('target_load', e.target.value)} /></Field>
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
            <Field label="Hash Value"><input value={form.hash_value} onChange={(e) => set('hash_value', e.target.value)} /></Field>
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
              <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                <input type="checkbox" checked={checkedItems.includes(c.item)} onChange={() => toggleChecked(c.item)} />
                <span>
                  {c.item} {c.data_required && <span className="muted small">({c.data_required})</span>}{' '}
                  {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
                </span>
                {c.is_complete && <span className="badge badge-green" style={{ marginLeft: 'auto' }}>QA verified</span>}
              </label>
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

function PerformanceDetail({ req, onClose, onChanged, users, engineers }: {
  req: PerformanceOut; onClose: () => void; onChanged: (p: PerformanceOut) => void; users: UserOut[]; engineers: UserOut[]
}) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [selectedEngineer, setSelectedEngineer] = useState('')
  // Whether the "require Department Head re-approval on return" popup (see
  // canCompleteReadiness below) is open -- an always-visible checkbox next to
  // "Readiness Failed" was easy to miss, so this is now asked as a pop-up at
  // the moment of failing readiness instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'overview' | 'checklist' | 'walkthroughs' | 'documents' | 'history'>('overview')
  const [checklist, setChecklist] = useState<PerformanceChecklistItemOut[]>(req.checklist_items || [])
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  useEffect(() => { setChecklist(req.checklist_items || []) }, [req])

  const loadExtras = useCallback(async () => {
    try {
      const [wt, hist] = await Promise.all([
        api.get<WalkthroughOut[]>(`/api/performance-requests/${req.id}/walkthroughs`),
        api.get<ApprovalActionOut[]>(`/api/performance-requests/${req.id}/history`),
      ])
      setWalkthroughs(wt); setHistory(hist)
    } catch (err) { setError(err) }
  }, [req.id])
  useEffect(() => { loadExtras() }, [loadExtras])

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try { onChanged(await api.post<PerformanceOut>(`/api/performance-requests/${req.id}/${action}`, extra || {})); loadExtras() }
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

  // After an SM approves/rejects this request's Application Name (see
  // ApplicationNameBanner below) -- there's no single-item GET endpoint for
  // a Performance request, so refetch the list and find this one, same
  // pattern as SAST.tsx/DAST.tsx use.
  async function reloadAfterApplicationNameDecision() {
    const fresh = await api.get<PerformanceOut[]>('/api/performance-requests')
    const updated = fresh.find((r) => r.id === req.id)
    if (updated) onChanged(updated)
  }

  const pendingChecklistItems = checklist.filter((c) => c.is_mandatory && !c.is_complete)

  const isRequester = req.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = req.status
  const sameDept = !!user?.department && user.department === req.department

  // Edit access -- see the matching (and more detailed) comment in
  // SAST.tsx's canEditDetails for the full reasoning; same rule here.
  const canEditDetails = hasRole(user, 'ADMIN')
    || (isRequester && ['DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER'].includes(status))
    || (hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && sameDept)
    || (hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDept)
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER'].includes(status)
  // Blocks Sign/Approve on both the SM and Department Head decision panels
  // below while this request's Application Name is still PENDING/REJECTED
  // (not yet APPROVED) -- see ApplicationNameBanner.
  const applicationNameBlocking = !!req.application_master_status && req.application_master_status !== 'APPROVED'
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canStartReadiness = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'ENGINEER_ASSIGNED'
  const canCompleteReadiness = hasRole(user, 'QA_LEAD') && status === 'READINESS'
  const canCompleteFeasibility = hasRole(user, 'QA_LEAD') && status === 'FEASIBILITY'
  const canCompletePlanning = hasRole(user, 'QA_LEAD') && status === 'PLANNING'
  const canCompleteEnvSetup = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'ENVIRONMENT_SETUP'
  const canCompleteScriptDev = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'SCRIPT_DEVELOPMENT'
  const canCompleteBaseline = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'BASELINE'
  const canCompleteLoadTest = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'LOAD_TEST_EXECUTION'
  const canResultAnalysisDecide = hasRole(user, 'QA_LEAD') && status === 'RESULT_ANALYSIS'
  const canCompleteDefectFixRetest = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'DEFECT_FIX_RETEST'
  const canCompleteReport = hasRole(user, 'QA_LEAD') && status === 'REPORT'
  const canSignOff = hasRole(user, 'QA_LEAD') && status === 'SIGNOFF_PENDING'
  const canRequesterDecide = isRequester && status === 'REQUESTER_VERIFICATION'
  const canVerifyChecklist = hasRole(user, 'QA_LEAD', 'QA_ENGINEER', 'BUSINESS_ANALYST') && status === 'READINESS'

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <ErrorText error={error} />

      <div className="tabs">
        <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" className={tab === 'checklist' ? 'active' : ''} onClick={() => setTab('checklist')}>
          Checklist {pendingChecklistItems.length > 0 && `(${pendingChecklistItems.length} pending)`}
        </button>
        <button type="button" className={tab === 'walkthroughs' ? 'active' : ''} onClick={() => setTab('walkthroughs')}>Walkthroughs</button>
        <button type="button" className={tab === 'documents' ? 'active' : ''} onClick={() => setTab('documents')}>Documents</button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button>
      </div>

      {tab === 'overview' && (
        <>
          {(sameDept || hasRole(user, 'ADMIN')) && (
            <ApplicationNameBanner
              applicationMasterId={req.application_master_id}
              applicationMasterStatus={req.application_master_status}
              applicationName={req.application_name}
              onDecided={reloadAfterApplicationNameDecision}
            />
          )}

          <DetailSection title="Status">
            <DetailField label="Status">
              <Badge status={status} />
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
            <DetailField label="Application Name">{req.application_name || '—'}</DetailField>
            <DetailField label="Epic Number">{req.epic_number || '—'}</DetailField>
            <DetailField label="CR Number">{req.cr_number || '—'}</DetailField>
            <DetailField label="Department">{req.department || '—'}</DetailField>
            <DetailField label="Change Type">{req.change_type || '—'}</DetailField>
            <DetailField label="Request Type">{req.request_type || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Test Parameters & Environment">
            <DetailField label="Tool Used">{req.tool_used || '—'}</DetailField>
            <DetailField label="Target Load">{req.target_load || '—'}</DetailField>
            <DetailField label="Environment">{req.environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Release & Vendor">
            <DetailField label="Release Version">{req.release_version || '—'}</DetailField>
            <DetailField label="Build Number">{req.build_number || '—'}</DetailField>
            <DetailField label="Hash Value">{req.hash_value || '—'}</DetailField>
            <DetailField label="Vendor / SI Partner">{req.vendor_si_partner || '—'}</DetailField>
            <DetailField label="Technology Stack">{req.technology_stack || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
            <DetailField label="Assigned Engineer">{userName(users, req.engineer_id) || '—'}</DetailField>
          </DetailSection>

          {req.qa_request && <p className="muted small">Linked from QA Request {req.qa_request.request_id}.</p>}

          <div className="actions-panel">
          <Field label="Comments (used by the next action below)">
            <input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional comments..." />
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
            {canResubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('resubmit')}>Re-submit</button>}
            {canSMDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={busy}
                signBlocked={applicationNameBlocking}
                signBlockedMessage="Application Name is still pending your decision above -- decide it before approving this request."
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
                extraReady={!!selectedEngineer}
                signBlocked={applicationNameBlocking}
                signBlockedMessage="This request's Application Name is not yet approved by SM."
                extraControlLabel="Assign Engineer"
                extraControl={
                  <UserAssignSelect
                    value={selectedEngineer}
                    onChange={setSelectedEngineer}
                    users={engineers}
                    placeholder="Assign Engineer..."
                    style={{ width: "100%" }}
                  />
                }
                onApprove={(signed) => act('department-head-decision', { decision: 'Approved', engineer_id: Number(selectedEngineer), comments: signed })}
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
            {canCompletePlanning && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('complete-planning')}>Complete Planning</button>}
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
                  disabled={!canVerifyChecklist || (!c.requester_checked && !c.is_complete)}
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
            </div>
          ))}
        </div>
      )}

      {tab === 'walkthroughs' && (
        <div>
          <Table
            rowKey="id"
            columns={[
              { key: 'session_date', header: 'Date', render: (r) => new Date(r.session_date).toLocaleString() },
              { key: 'conducted_by', header: 'Conducted By' },
              { key: 'participants', header: 'Participants' },
              { key: 'qa_acknowledged_at', header: 'QA Acknowledged', render: (r) => r.qa_acknowledged_at ? 'Yes' : 'No', filterValue: (r) => r.qa_acknowledged_at ? 'Yes' : 'No' },
            ]}
            rows={walkthroughs}
          />
          <AddWalkthrough reqId={req.id} onAdded={loadExtras} />
        </div>
      )}

      {tab === 'history' && (
        <Table
          rowKey="id"
          columns={[
            { key: 'step_name', header: 'Step' },
            { key: 'decision', header: 'Decision' },
            { key: 'actor_id', header: 'Actor', render: (r) => userName(users, r.actor_id) || '—', filterValue: (r) => userName(users, r.actor_id) || '' },
            { key: 'actor_role', header: 'Role' },
            { key: 'comments', header: 'Comments' },
            { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
          ]}
          rows={history}
        />
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/performance-requests" reqId={req.id} />}

      {editing && (
        <PerformanceFormModal editing={req} onClose={() => setEditing(false)} onSaved={(saved) => { setEditing(false); onChanged(saved); setChecklist(saved.checklist_items || []) }} />
      )}
    </Modal>
  )
}

function AddWalkthrough({ reqId, onAdded }: { reqId: number; onAdded: () => void }) {
  const [conducted_by, setConductedBy] = useState('')
  const [participants, setParticipants] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post(`/api/performance-requests/${reqId}/walkthroughs`, { conducted_by, participants, notes })
      setConductedBy(''); setParticipants(''); setNotes('')
      onAdded()
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input placeholder="Conducted by" value={conducted_by} onChange={(e) => setConductedBy(e.target.value)} />
      <input placeholder="Participants" value={participants} onChange={(e) => setParticipants(e.target.value)} />
      <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button className="btn btn-sm" disabled={busy}>Log Walkthrough Session</button>
    </form>
  )
}

export default function Performance() {
  const [rows, setRows] = useState<PerformanceOut[]>([])
  const [selected, setSelected] = useState<PerformanceOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const engineers = users.filter((u) => (u.roles || []).includes('QA_ENGINEER') || (u.roles || []).includes('QA_LEAD'))
  const [searchParams, setSearchParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setRows(await api.get<PerformanceOut[]>('/api/performance-requests')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    // Full user list -- not just QA Engineer/Lead -- so both the Assign
    // Engineer dropdown and the Requester/Assigned Engineer fields can
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
          { key: 'engineer_id', header: 'Assigned Engineer', render: (r) => userName(users, r.engineer_id) || '—', filterValue: (r) => userName(users, r.engineer_id) || '' },
          { key: 'tool_used', header: 'Tool', render: (r) => r.tool_used || '—' },
          { key: 'priority', header: 'Priority', render: (r) => r.priority || '—' },
          { key: 'risk_category', header: 'Risk' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
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
        <PerformanceDetail req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} engineers={engineers} />
      )}
    </div>
  )
}
