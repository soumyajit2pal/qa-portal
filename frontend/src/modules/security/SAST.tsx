import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, RepeatableGroupInput, RepeatableGroupField, RepeatableGroupRow, TableColumn, DetailSection, DetailField, RequestDocuments } from '../../components/Common'
import { ApplicationNameBanner } from '../../components/ApplicationNameBanner'
import ConfirmModal from '../../components/ConfirmModal'
import UserAssignSelect from '../../components/UserAssignSelect'
import { SEVERITIES, PRIORITIES, SAST_DAST_EDITABLE_STATUSES, SAST_DAST_STATUS_LABELS, hasRole } from '../../constants'
import { SASTOut, SASTComponentOut, ChecklistItemOut, UserOut, WalkthroughOut, ApprovalActionOut } from '../../types'

// One "SAST component" = one repository, with its own branch/commit/tech
// stack/build number -- the "+" adds a whole new one of these (not just
// another URL), since a project can have several repos each needing their
// own full set of details. Same shape as QARequests.tsx's wizard SAST step.
const SAST_COMPONENT_FIELDS: RepeatableGroupField[] = [
  { key: 'repository_url', label: 'Repository URL' },
  { key: 'git_branch', label: 'Branch' },
  { key: 'commit_id', label: 'Commit ID' },
  { key: 'technology_stack', label: 'Tech Stack' },
  { key: 'build_number', label: 'Build Number' },
]

// Standalone SAST request creation is DISABLED per request -- a SAST request
// can now only come into being by including "SAST" in a QA Request's request
// types (see backend routers/qa_requests.py::_sync_linked_security_requests),
// which creates it with just application_name/epic_number/cr_number/risk
// populated. This modal is therefore edit-only now: it fills in the rest of
// the mandatory details (repository URL, branch, commit ID, tech stack,
// build number) on that auto-created request before the security team picks
// it up -- see canEditDetails in SASTDetail below.
function SASTFormModal({ onClose, onSaved, editing }: { onClose: () => void; onSaved: (s: SASTOut) => void; editing: SASTOut }) {
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'ADMIN')
  // editing.components is already one real row per repository (see
  // models.SASTComponent) -- just drop the `id` for local editing state,
  // RepeatableGroupInput doesn't need it.
  function toRows(components: SASTComponentOut[]): RepeatableGroupRow[] {
    return components.length > 0
      ? components.map((c) => ({
          repository_url: c.repository_url || '', git_branch: c.git_branch || '', commit_id: c.commit_id || '',
          technology_stack: c.technology_stack || '', build_number: c.build_number || '',
        }))
      : [{ repository_url: '', git_branch: '', commit_id: '', technology_stack: '', build_number: '' }]
  }
  const [form, setForm] = useState({
    application_name: editing.application_name || '', epic_number: editing.epic_number || '',
    cr_number: editing.cr_number || '',
    components: toRows(editing.components),
    risk_category: editing.risk_category || 'Medium', priority: editing.priority || 'Medium',
    hash_value: editing.hash_value || '',
  })
  // Lets the requester revisit their Security Readiness checklist
  // self-declaration from here too -- same pattern as Performance.tsx's
  // PerformanceFormModal checkedItems.
  const [checkedItems, setCheckedItems] = useState<string[]>(
    editing.checklist_items.filter((c) => c.requester_checked).map((c) => c.item)
  )
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }
  function toggleChecked(item: string) {
    setCheckedItems((items) => (items.includes(item) ? items.filter((i) => i !== item) : [...items, item]))
  }

  function formError(): string | null {
    const missing: string[] = []
    if (!form.application_name.trim()) missing.push('Application Name')
    if (!form.epic_number.trim()) missing.push('Epic Number')
    if (!form.cr_number.trim()) missing.push('CR Number')
    const incomplete = form.components.some((c) => SAST_COMPONENT_FIELDS.some((f) => !c[f.key]?.trim()))
    if (incomplete) missing.push('Repository Details (every field, for every repository row)')
    return missing.length > 0 ? `Please fill in: ${missing.join(', ')}` : null
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const err = formError()
    if (err) { setError(err); return }
    setBusy(true)
    setError(null)
    try {
      const { components, ...rest } = form
      const payload = {
        ...rest,
        checked_items: checkedItems,
        // Sent as a real array -- one entry per repository -- and replaces
        // this request's entire set of repository rows server-side (see
        // update_sast in routers/sast_dast.py), rather than being joined
        // into 5 comma-separated columns.
        components: components.map((c) => ({
          repository_url: c.repository_url.trim(),
          git_branch: c.git_branch.trim(),
          commit_id: c.commit_id.trim(),
          technology_stack: c.technology_stack.trim(),
          build_number: c.build_number.trim(),
        })),
      }
      const saved = await api.put<SASTOut>(`/api/sast-requests/${editing.id}`, payload)
      onSaved(saved)
    } catch (err2) { setError(err2) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${editing.request_id}`} onClose={onClose} wide>
      {editing?.qa_request && (
        <p className="muted small" style={{ marginTop: -8 }}>
          Auto-created from QA Request {editing.qa_request.request_id} — fill in the real
          details below before the security team picks this up.
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
            <Field label="Epic Number *"><input required disabled={!isAdmin} value={form.epic_number} onChange={(e) => set('epic_number', e.target.value)} /></Field>
            <Field label="CR Number *"><input required disabled={!isAdmin} value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Classification &amp; Hash</div>
          <div className="form-row">
            <Field label="Risk Category *">
              <select value={form.risk_category} onChange={(e) => set('risk_category', e.target.value)}>
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Priority *">
              <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                {PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="SHA256/MD5 Hash"><input value={form.hash_value} onChange={(e) => set('hash_value', e.target.value)} /></Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Repository Details *</div>
          <RepeatableGroupInput
            required
            fields={SAST_COMPONENT_FIELDS}
            rows={form.components}
            onChange={(v) => set('components', v)}
          />
          <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
            Click "+" to add another repository (its own branch, commit ID, tech stack and build number)
            if this project spans more than one.
          </p>
        </div>

        {editing.checklist_items.length > 0 && (
          <div className="form-section">
            <div className="form-section-title">Security Readiness Checklist — Self-Declaration</div>
            <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
              Update what's already in place. This is your own declaration for reference only -- Security
              independently verifies every item during Security Readiness.
            </p>
            {editing.checklist_items.map((c) => (
              <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                <input type="checkbox" checked={checkedItems.includes(c.item)} onChange={() => toggleChecked(c.item)} />
                <span>
                  {c.item} {c.owner && <span className="muted small">({c.owner})</span>}{' '}
                  {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
                </span>
                {c.is_complete && <span className="badge badge-green" style={{ marginLeft: 'auto' }}>Verified</span>}
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

// One real row per repository (see models.SASTComponent) -- no more
// splitting comma-joined columns back apart to display these.
const SAST_COMPONENT_COLUMNS: TableColumn<SASTComponentOut>[] = [
  { key: 'repository_url', header: 'Repository URL', render: (c) => c.repository_url || '—' },
  { key: 'git_branch', header: 'Branch', render: (c) => c.git_branch || '—' },
  { key: 'commit_id', header: 'Commit ID', render: (c) => c.commit_id || '—' },
  { key: 'technology_stack', header: 'Tech Stack', render: (c) => c.technology_stack || '—' },
  { key: 'build_number', header: 'Build Number', render: (c) => c.build_number || '—' },
]

function SASTDetail({ req, onClose, onChanged, securityAnalysts, users }: {
  req: SASTOut; onClose: () => void; onChanged: (s: SASTOut) => void; securityAnalysts: UserOut[]; users: UserOut[]
}) {
  const { user } = useAuth()
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState<unknown>(null)
  const [finding, setFinding] = useState({ issue_id: '', severity: 'Medium', description: '' })
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [selectedLead, setSelectedLead] = useState('')
  // Whether the "require Department Head re-approval on return" popup (see
  // canReadinessDecide below) is open -- an always-visible checkbox next to
  // "Readiness Failed" was easy to miss, so this is now asked as a pop-up at
  // the moment of failing readiness instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [checklist, setChecklist] = useState<ChecklistItemOut[]>(req.checklist_items || [])
  useEffect(() => { setChecklist(req.checklist_items || []) }, [req])
  // Complete Scan (at Scanning) and the Rescan decision (at Rescan) both ask
  // the same "were any findings identified?" confirmation before branching --
  // this tracks which of the two triggered the pop-up currently showing (or
  // null when it's closed).
  const [scanConfirmAction, setScanConfirmAction] = useState<null | 'complete-scan' | 'rescan-decision'>(null)

  const load = useCallback(async () => {
    try {
      const [wt, hist] = await Promise.all([
        api.get<WalkthroughOut[]>(`/api/sast-requests/${req.id}/walkthroughs`),
        api.get<ApprovalActionOut[]>(`/api/sast-requests/${req.id}/history`),
      ])
      setWalkthroughs(wt); setHistory(hist)
    } catch (err) { setError(err) }
  }, [req.id])

  useEffect(() => { load() }, [load])

  async function toggleChecklistItem(item: ChecklistItemOut) {
    setError(null)
    try {
      const saved = await api.put<ChecklistItemOut>(`/api/sast-requests/${req.id}/checklist/${item.id}`, { is_complete: !item.is_complete })
      setChecklist((rows) => rows.map((r) => (r.id === saved.id ? saved : r)))
    } catch (err) { setError(err) }
  }

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try { onChanged(await api.post<SASTOut>(`/api/sast-requests/${req.id}/${action}`, extra || {})) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }
  // Answers the "were any findings identified?" pop-up -- Yes (no findings)
  // fast-tracks toward Security Complete/Report Ready/Closed on the backend
  // (see _auto_close_if_clean); No switches straight to the Findings tab so
  // they can be logged, matching the requested "navigate to the Findings
  // tab" behaviour for both Complete Scan and a failed Rescan.
  async function answerScanConfirm(noFindings: boolean) {
    const action = scanConfirmAction
    setScanConfirmAction(null)
    if (!action) return
    if (action === 'complete-scan') {
      await act('complete-scan', { no_findings: noFindings, comments })
    } else {
      await act('rescan-decision', { decision: noFindings ? 'Passed' : 'Failed', comments })
    }
    if (!noFindings) setTab('findings')
  }
  async function addFinding(e: React.FormEvent) {
    e.preventDefault()
    try {
      await api.post(`/api/sast-requests/${req.id}/findings`, finding)
      const fresh = await api.get<SASTOut[]>('/api/sast-requests')
      const updated = fresh.find((r) => r.id === req.id)
      if (updated) onChanged(updated)
      setFinding({ issue_id: '', severity: 'Medium', description: '' })
    } catch (err) { setError(err) }
  }
  async function resolveFinding(findingId: number) {
    try {
      await api.post(`/api/sast-requests/${req.id}/findings/${findingId}/resolve`, {})
      const fresh = await api.get<SASTOut[]>('/api/sast-requests')
      const updated = fresh.find((r) => r.id === req.id)
      if (updated) onChanged(updated)
    } catch (err) { setError(err) }
  }

  // After an SM approves/rejects this request's Application Name (see
  // ApplicationNameBanner below) -- same "refetch the list, find this one"
  // pattern as addFinding/resolveFinding above, since there's no single-item
  // GET endpoint for a SAST request.
  async function reloadAfterApplicationNameDecision() {
    const fresh = await api.get<SASTOut[]>('/api/sast-requests')
    const updated = fresh.find((r) => r.id === req.id)
    if (updated) onChanged(updated)
  }

  const isRequester = req.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = req.status
  // Department-scoped, same as QA Request's SM/Dept Head steps -- see the
  // comment in QARequests.tsx. Doesn't apply to the QA-side steps below.
  const sameDept = !!user?.department && user.department === req.department

  // Edit access mirrors the backend's own _can_edit_details exactly (see
  // update_sast): the requester (or admin) may edit while it's Draft or
  // sitting with them after a return (RETURNED_BY_SM/
  // RETURNED_BY_DEPARTMENT_HEAD/RETURNED_BY_SECURITY_LEAD) -- returning a
  // request hands it back to the requester to fix and resubmit, so the
  // reviewer who returned it doesn't also keep edit access. Separately, the
  // SM/Department Head may edit while the request is genuinely pending
  // *their own* decision (SM_APPROVAL_PENDING/
  // DEPARTMENT_HEAD_APPROVAL_PENDING) -- fix something, then decide -- but
  // that access disappears the moment they've approved/returned/rejected;
  // it never extends past Department Head's own decision into Security's
  // post-approval readiness stage.
  const canEditDetails = hasRole(user, 'ADMIN')
    || (isRequester && ['DRAFT', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status))
    || (hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && sameDept)
    || (hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDept)
  // Blocks Sign/Approve on both the SM and Department Head decision panels
  // below while this request's Application Name is still PENDING/REJECTED
  // (not yet APPROVED) -- see ApplicationNameBanner.
  const applicationNameBlocking = !!req.application_master_status && req.application_master_status !== 'APPROVED'
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status)
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canStartReadiness = hasRole(user, 'SECURITY_ANALYST', 'QA_LEAD') && status === 'SECURITY_LEAD_ASSIGNED'
  const canReadinessDecide = hasRole(user, 'QA_LEAD', 'SECURITY_ANALYST') && status === 'SECURITY_READINESS'
  const canVerifyChecklist = hasRole(user, 'QA_LEAD', 'SECURITY_ANALYST', 'BUSINESS_ANALYST') && status === 'SECURITY_READINESS'
  const pendingChecklistItems = checklist.filter((c) => c.is_mandatory && !c.is_complete)
  // Mandatory checklist items must be self-declared ready BEFORE Submit is
  // even allowed (see routers/sast_dast.py::_require_checklist_ready) --
  // distinct from pendingChecklistItems above, which gates Security
  // Readiness's own independent verification instead.
  const pendingSelfDeclare = checklist.filter((c) => c.is_mandatory && !c.requester_checked)
  const canStartConfiguration = hasRole(user, 'SECURITY_ANALYST') && status === 'PLANNING'
  const canStartScan = hasRole(user, 'SECURITY_ANALYST') && status === 'CONFIGURATION'
  // Findings can be logged while still scanning, and -- this is the bit that
  // was missing -- after Complete Scan answers "findings identified", which
  // moves the request to Finding Validation rather than leaving it at
  // Scanning. Answering "no findings" instead skips straight past Finding
  // Validation to Security Complete (see _complete_scan), so this naturally
  // stays blocked once that's confirmed -- no separate check needed.
  const canAddFinding = hasRole(user, 'SECURITY_ANALYST') && ['SCANNING', 'FINDING_VALIDATION'].includes(status)
  const canCompleteScan = hasRole(user, 'SECURITY_ANALYST') && status === 'SCANNING'
  const canValidateFindings = hasRole(user, 'SECURITY_ANALYST') && status === 'FINDING_VALIDATION'
  const canAssignToRequester = hasRole(user, 'SECURITY_ANALYST') && status === 'REMEDIATION'
  const canMarkFixed = (isRequester || hasRole(user, 'SECURITY_ANALYST')) && status === 'WAITING_FOR_FIX'
  const canRescanDecide = hasRole(user, 'SECURITY_ANALYST') && status === 'RESCAN'
  const canMarkReportReady = hasRole(user, 'SECURITY_ANALYST') && status === 'SECURITY_COMPLETE'
  // Report Ready -> Closed. Usually reached automatically as part of the
  // Complete Scan/Rescan "no findings" confirmation, but this manual action
  // covers the case where that auto-chain stopped at Report Ready's
  // suppression gate and the analyst needs to finish the last hop themselves
  // once the linked suppression(s) are Done.
  const canCloseRequest = hasRole(user, 'SECURITY_ANALYST') && status === 'REPORT_READY'

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'checklist', 'repository', 'findings', 'walkthroughs', 'documents', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'findings' ? `Findings (${req.findings.length})`
              : t === 'checklist' && pendingChecklistItems.length > 0 ? `Checklist (${pendingChecklistItems.length} pending)`
              : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
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
            {/* For clear reporting/visibility -- whether any Suppression / False
                Positive request has ever been raised against this SAST request,
                and if so, which one(s) (see backend models.SASTRequest.suppressions). */}
            <DetailField label="Suppression Requested?">{req.suppressions.length > 0 ? 'Yes' : 'No'}</DetailField>
            {req.suppressions.length > 0 && (
              <DetailField label="Suppression ID">{req.suppressions.map((s) => s.suppression_id).join(', ')}</DetailField>
            )}
            <DetailField label="Created">{new Date(req.created_at).toLocaleString()}</DetailField>
            <DetailField label="Last Updated">{new Date(req.updated_at).toLocaleString()}</DetailField>
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Epic Number">{req.epic_number || '—'}</DetailField>
            <DetailField label="CR Number">{req.cr_number || '—'}</DetailField>
            <DetailField label="Department">{req.department || '—'}</DetailField>
            <DetailField label="Application Owner">{req.application_owner || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Environment & Hash">
            <DetailField label="Deployment Environment">{req.environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
            <DetailField label="Hash Value">{req.hash_value || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
            <DetailField label="Assigned To">{userName(users, req.security_lead_id) || '—'}</DetailField>
          </DetailSection>

          {req.qa_request && (
            <p className="muted small">Linked from QA Request {req.qa_request.request_id}.</p>
          )}

          <div className="section-title">Workflow Actions</div>
          <div className="actions-panel">
            <Field label="Comments (used by the next action below)">
              <input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional comments..." />
            </Field>
            <div style={{ display: 'flex', gap: 8, margin: '10px 0 0', flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/sast-requests/${req.id}/export`, `${req.request_id}.pdf`)}>
                Export PDF
              </button>
              {canEditDetails && <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(true)}>Edit Details</button>}
              {canSubmit && (
                <button className="btn btn-primary btn-sm" disabled={busy || pendingSelfDeclare.length > 0}
                        onClick={() => act('submit')}>
                  Submit for SM Approval
                </button>
              )}
              {canSubmit && pendingSelfDeclare.length > 0 && (
                <p className="muted small" style={{ color: 'var(--danger, #c0392b)', width: '100%' }}>
                  {pendingSelfDeclare.length} mandatory Security Readiness checklist item(s) not yet
                  self-declared ready — see Edit Details.
                </p>
              )}
              {canResubmit && (
                <button className="btn btn-primary btn-sm"
                        disabled={busy || (status === 'RETURNED_BY_SM' && pendingSelfDeclare.length > 0)}
                        onClick={() => act('resubmit')}>
                  Re-submit
                </button>
              )}
              {canResubmit && status === 'RETURNED_BY_SM' && pendingSelfDeclare.length > 0 && (
                <p className="muted small" style={{ color: 'var(--danger, #c0392b)', width: '100%' }}>
                  {pendingSelfDeclare.length} mandatory Security Readiness checklist item(s) not yet
                  self-declared ready — see Edit Details.
                </p>
              )}

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
                  extraReady={!!selectedLead}
                  signBlocked={applicationNameBlocking}
                  signBlockedMessage="This request's Application Name is not yet approved by SM."
                  extraControlLabel="Assign Security Lead"
                  extraControl={
                    <UserAssignSelect
                      value={selectedLead}
                      onChange={setSelectedLead}
                      users={securityAnalysts}
                      placeholder="Assign Security Lead..."
                      style={{ width: "100%" }}
                    />
                  }
                  onApprove={(signed) => act('department-head-decision', { decision: 'Approved', security_lead_id: Number(selectedLead), comments: signed })}
                  onReturn={() => act('department-head-decision', { decision: 'Returned', comments })}
                  onReject={() => act('department-head-decision', { decision: 'Rejected', comments })}
                />
              )}
              {canStartReadiness && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-readiness')}>Start Security Readiness</button>}
              {canReadinessDecide && (
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
              {canReadinessDecide && pendingChecklistItems.length > 0 && (
                <p className="muted small" style={{ color: 'var(--danger, #c0392b)', width: '100%' }}>
                  {pendingChecklistItems.length} mandatory Security Readiness checklist item(s) still incomplete —
                  see the Checklist tab.
                </p>
              )}
              {canStartConfiguration && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-configuration')}>Start Configuration</button>}
              {canStartScan && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-scan')}>Start Scan</button>}
              {canCompleteScan && <button className="btn btn-sm" disabled={busy} onClick={() => setScanConfirmAction('complete-scan')}>Complete Scan</button>}
              {canValidateFindings && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('validate-findings')}>Validate Findings</button>}
              {canAssignToRequester && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('assign-to-requester')}>Assign to Requester</button>}
              {canMarkFixed && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('mark-fixed')}>Mark Fixed (send to Rescan)</button>}
              {canRescanDecide && (
                <button className="btn btn-sm" disabled={busy} onClick={() => setScanConfirmAction('rescan-decision')}>Rescan Decision</button>
              )}
              {canMarkReportReady && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('mark-report-ready')}>Mark Report Ready</button>}
              {canCloseRequest && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('close')}>Close Request</button>}
            </div>
          </div>

          {editing && (
            <SASTFormModal
              editing={req}
              onClose={() => setEditing(false)}
              onSaved={(saved) => { setEditing(false); onChanged(saved) }}
            />
          )}

          {scanConfirmAction && (
            <ConfirmModal
              title={scanConfirmAction === 'complete-scan' ? 'Complete Scan' : 'Rescan Decision'}
              message="Are you sure no security findings were identified during the scan?"
              confirmLabel="Yes, no findings"
              cancelLabel="No, findings identified"
              busy={busy}
              onConfirm={() => answerScanConfirm(true)}
              onCancel={() => answerScanConfirm(false)}
            />
          )}
        </div>
      )}

      {tab === 'checklist' && (
        <div>
          <p className="muted small">Security Readiness pre-scan checklist — verified by the assigned Security Lead (or QA Lead) before Planning can begin.</p>
          <p className="muted small">
            <strong>Requester declared</strong> is the requester's own self-declaration (reference
            only). <strong>Verified</strong> is the binding, independent verification — ticking a
            requester-declared item does NOT auto-approve it here.
          </p>
          {status !== 'SECURITY_READINESS' && (
            <p className="muted small">Verification is locked outside the Security Readiness stage (current status: {SAST_DAST_STATUS_LABELS[status] || status}).</p>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontWeight: 600, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ flex: 1 }}>Item</span>
            <span style={{ width: 130, textAlign: 'center' }}>Requester declared</span>
            <span style={{ width: 130, textAlign: 'center' }}>Verified</span>
          </div>
          {checklist.length === 0 && <p className="muted small">No checklist items found.</p>}
          {checklist.map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ flex: 1 }}>
                {c.item} {c.owner && <span className="muted small">({c.owner})</span>}{' '}
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
                      ? 'Only verifiable by QA Lead / Security Analyst / Business Analyst during Security Readiness'
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

      {tab === 'repository' && (
        <div>
          <Table rowKey="id" columns={SAST_COMPONENT_COLUMNS} rows={req.components} />
        </div>
      )}

      {tab === 'findings' && (
        <div>
          <Table rowKey="id" columns={[
            { key: 'issue_id', header: 'Issue ID' },
            { key: 'severity', header: 'Severity' },
            { key: 'description', header: 'Description' },
            { key: 'status', header: 'Status' },
            { key: 'actions', header: '', filterable: false, render: (f) => (
              f.status === 'Open' && hasRole(user, 'SECURITY_ANALYST') ? (
                <button className="btn btn-sm" onClick={() => resolveFinding(f.id)}>Mark Fixed</button>
              ) : null
            ) },
          ]} rows={req.findings} />
          {canAddFinding && (
            <form onSubmit={addFinding} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input placeholder="Issue ID" value={finding.issue_id} onChange={(e) => setFinding((f) => ({ ...f, issue_id: e.target.value }))} />
              <select value={finding.severity} onChange={(e) => setFinding((f) => ({ ...f, severity: e.target.value }))}>
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input placeholder="Description" value={finding.description} onChange={(e) => setFinding((f) => ({ ...f, description: e.target.value }))} />
              <button className="btn btn-sm">Log Finding</button>
            </form>
          )}
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
          <AddWalkthrough reqId={req.id} onAdded={load} />
        </div>
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/sast-requests" reqId={req.id} />}

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
      await api.post(`/api/sast-requests/${reqId}/walkthroughs`, { conducted_by, participants, notes })
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

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

export default function SAST() {
  const [rows, setRows] = useState<SASTOut[]>([])
  const [selected, setSelected] = useState<SASTOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const securityAnalysts = users.filter((u) => (u.roles || []).includes('SECURITY_ANALYST'))
  const [searchParams, setSearchParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setRows(await api.get<SASTOut[]>('/api/sast-requests')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    // Full user list -- not just security analysts -- so both the Security
    // Lead assignment dropdown and the "Requester" field on the detail view
    // can resolve names from a single fetch.
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names/dropdown just stay empty */ })
  }, [])

  // Deep-link support -- see the matching effect in Functional.tsx for the
  // full reasoning; the gateway's "Linked Requests" table opens a specific
  // SAST request here via `?open=<request_id>`.
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
        title="SAST Requests" count={rows.length}
        subtitle="Static Application Security Testing requests, from submission through findings and report sign-off. Raised via a QA Request (include SAST in its request types) -- not created standalone here."
      />
      <Card>
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
          { key: 'request_id', header: 'Request ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'requester_id', header: 'Requester', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
          { key: 'security_lead_id', header: 'Assigned To', render: (r) => userName(users, r.security_lead_id) || '—', filterValue: (r) => userName(users, r.security_lead_id) || '' },
          { key: 'priority', header: 'Priority', render: (r) => r.priority || '—' },
          { key: 'risk_category', header: 'Risk' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          { key: 'findings', header: 'Findings', render: (r) => r.findings.length, filterValue: (r) => String(r.findings.length) },
          { key: 'source', header: 'Source', render: (r) => (
            r.qa_request ? (
              <span className="badge badge-blue" title="Auto-created from a QA Request">
                Linked · {r.qa_request.request_id}
              </span>
            ) : <span className="badge badge-gray">Standalone (legacy)</span>
          ), filterValue: (r) => r.qa_request ? `Linked ${r.qa_request.request_id}` : 'Standalone legacy' },
          { key: 'created_at', header: 'Created', render: (r) => new Date(r.created_at).toLocaleString() },
          { key: 'updated_at', header: 'Updated', render: (r) => new Date(r.updated_at).toLocaleString() },
        ]} rows={rows} />
      </Card>
      {selected && (
        <SASTDetail
          req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }}
          securityAnalysts={securityAnalysts} users={users}
        />
      )}
    </div>
  )
}
