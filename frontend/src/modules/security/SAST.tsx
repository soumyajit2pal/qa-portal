import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, RepeatableGroupInput, RepeatableGroupField, RepeatableGroupRow, TableColumn, DetailSection, DetailField, RequestDocuments, ChecklistEvidence, useChecklistDocuments, applicationNameAwareStatusLabel } from '../../components/Common'
import UserAssignSelect from '../../components/UserAssignSelect'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import { SEVERITIES, PRIORITIES, SAST_DAST_STATUS_LABELS, SAST_DAST_PENDING_WITH, hasRole, canManageReadinessEvidence, QA_DEPARTMENT } from '../../constants'
import { SASTOut, SASTComponentOut, ChecklistItemOut, UserOut, ApprovalActionOut } from '../../types'

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
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments('/api/sast-requests', editing.id)
  // Same identity check as the detail view's isRequester/canSMDecide/
  // canDeptHeadDecide -- this modal only opens via that same gate, but the
  // checklist evidence controls inside it need their own explicit check.
  const isRequesterModal = editing.requester_id === user?.id || isAdmin
  const sameDeptModal = !!user?.department && user.department === editing.department
  const canSMDecideModal = hasRole(user, 'SM') && editing.status === 'SM_APPROVAL_PENDING' && sameDeptModal
  const canDeptHeadDecideModal = hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && editing.status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDeptModal
  const canManageEvidenceModal = isAdmin || (
    editing.status === 'SM_APPROVAL_PENDING' ? canSMDecideModal :
    editing.status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecideModal :
    isRequesterModal
  )
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
            {/* Reported directly: "Attach Evidence is not uniform
                everywhere. On edit details it should be like while creating
                the request." -- reuses the same grid-table layout as the QA
                Request wizard's ReadinessChecklistSection.tsx. */}
            <div className="security-checklist-table" role="group" aria-label="SAST readiness checklist">
              <div className="security-checklist-header" aria-hidden="true">
                <span>Ready</span>
                <span>Readiness criterion</span>
                <span>Supporting evidence</span>
              </div>
              {editing.checklist_items.map((c) => {
                const checked = checkedItems.includes(c.item)
                const checkboxId = `sast-edit-checklist-${c.id}`
                return (
                  <div className={`security-checklist-row ${checked ? 'is-checked' : ''}`} key={c.id}>
                    <div className="security-checklist-check">
                      <input id={checkboxId} type="checkbox" checked={checked} onChange={() => toggleChecked(c.item)} />
                    </div>
                    <label className="security-checklist-criterion" htmlFor={checkboxId}>
                      <span>
                        <strong>{c.item}</strong>
                        {c.owner && <span className="muted small">({c.owner})</span>}
                        {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
                        {c.is_complete && <span className="badge badge-green">Verified</span>}
                      </span>
                    </label>
                    <ChecklistEvidence apiBase="/api/sast-requests" reqId={editing.id} itemId={c.id}
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

// One real row per repository (see models.SASTComponent) -- no more
// splitting comma-joined columns back apart to display these.
const SAST_COMPONENT_COLUMNS: TableColumn<SASTComponentOut>[] = [
  { key: 'repository_url', header: 'Repository URL', render: (c) => c.repository_url || '—' },
  { key: 'git_branch', header: 'Branch', render: (c) => c.git_branch || '—' },
  { key: 'commit_id', header: 'Commit ID', render: (c) => c.commit_id || '—' },
  { key: 'technology_stack', header: 'Tech Stack', render: (c) => c.technology_stack || '—' },
  { key: 'build_number', header: 'Build Number', render: (c) => c.build_number || '—' },
]

function SASTDetail({ req, onClose, onChanged, users }: {
  req: SASTOut; onClose: () => void; onChanged: (s: SASTOut) => void; users: UserOut[]
}) {
  const { user } = useAuth()
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState<unknown>(null)
  const [finding, setFinding] = useState({ issue_id: '', severity: 'Medium', description: '' })
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [selectedQALead, setSelectedQALead] = useState('')
  const [selectedAnalyst, setSelectedAnalyst] = useState('')
  // Whether the "require Department Head re-approval on return" popup (see
  // canReadinessDecide below) is open -- an always-visible checkbox next to
  // "Readiness Failed" was easy to miss, so this is now asked as a pop-up at
  // the moment of failing readiness instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [checklist, setChecklist] = useState<ChecklistItemOut[]>(req.checklist_items || [])
  useEffect(() => { setChecklist(req.checklist_items || []) }, [req])
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments('/api/sast-requests', req.id)
  // Complete Scan (at Scanning) and the Rescan decision (at Rescan) both ask
  // the same "were any findings identified?" confirmation before branching --
  // this tracks which of the two triggered the pop-up currently showing (or
  // null when it's closed).
  const [scanConfirmAction, setScanConfirmAction] = useState<null | 'complete-scan' | 'rescan-decision'>(null)

  const load = useCallback(async () => {
    try {
      setHistory(await api.get<ApprovalActionOut[]>(`/api/sast-requests/${req.id}/history`))
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
    try {
      onChanged(await api.post<SASTOut>(`/api/sast-requests/${req.id}/${action}`, extra || {}))
      setComments('')
      await load()
    }
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

  const isAdmin = hasRole(user, 'ADMIN')
  const isRequester = req.requester_id === user?.id || isAdmin
  const status = req.status
  const sameDept = !!user?.department && user.department === req.department
  const isAssignedQALead = isAdmin || (hasRole(user, 'QA_LEAD') && req.security_lead_id === user?.id)
  const isAssignedAnalyst = isAdmin || (hasRole(user, 'SECURITY_ANALYST') && req.security_analyst_id === user?.id)
  const qaLeads = users.filter((u) => u.is_active && u.department === QA_DEPARTMENT && (u.roles || []).includes('QA_LEAD'))
  const securityAnalysts = users.filter((u) => u.is_active && u.department === QA_DEPARTMENT && (u.roles || []).includes('SECURITY_ANALYST'))

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
  // SM_REJECTED included alongside the RETURNED_BY_* statuses -- reported
  // directly, a rejected request is now reopenable (edit + resubmit)
  // instead of a dead end.
  const canEditDetails = hasRole(user, 'ADMIN')
    || (isRequester && ['DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status))
    || (hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && sameDept)
    || (hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDept)
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
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status)
  const resubmitLabel = status === 'SM_REJECTED' ? 'Reopen Request' : 'Re-submit'
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
  // Submitted/Returned-by-*/Rejected, (2) the SM only while
  // SM_APPROVAL_PENDING, (3) the Department Head only while
  // DEPARTMENT_HEAD_APPROVAL_PENDING. Every post-readiness Security status
  // after Department Head approval (including WAITING_FOR_FIX) is locked
  // for everyone but Admin -- mirrors the backend's own (now-simplified)
  // _can_upload_documents exactly. Used for the general Documents tab;
  // evidenceOwner above covers the same 3 stages for checklist evidence.
  const canManageDocuments = isAdmin || (
    ['DRAFT', 'SUBMITTED', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status) ? isRequester :
    status === 'SM_APPROVAL_PENDING' ? canSMDecide :
    status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecide :
    false
  )
  const canStartReadiness = isAssignedQALead && status === 'SECURITY_LEAD_ASSIGNED'
  const canReadinessDecide = isAssignedQALead && status === 'SECURITY_READINESS'
  const canVerifyChecklist = isAssignedQALead && status === 'SECURITY_READINESS'
  const pendingChecklistItems = checklist.filter((c) => c.is_mandatory && !c.is_complete)
  // Mandatory checklist items must be self-declared ready BEFORE Submit is
  // even allowed (see routers/sast_dast.py::_require_checklist_ready) --
  // distinct from pendingChecklistItems above, which gates Security
  // Readiness's own independent verification instead.
  const pendingSelfDeclare = checklist.filter((c) => c.is_mandatory && !c.requester_checked)
  const canAssignSecurityAnalyst = isAssignedQALead && status === 'PLANNING'
  const canStartScan = isAssignedAnalyst && status === 'CONFIGURATION'
  // Findings can be logged while still scanning, and -- this is the bit that
  // was missing -- after Complete Scan answers "findings identified", which
  // moves the request to Finding Validation rather than leaving it at
  // Scanning. Answering "no findings" instead skips straight past Finding
  // Validation to Security Complete (see _complete_scan), so this naturally
  // stays blocked once that's confirmed -- no separate check needed.
  const canAddFinding = isAssignedAnalyst && ['SCANNING', 'FINDING_VALIDATION'].includes(status)
  const canCompleteScan = isAssignedAnalyst && status === 'SCANNING'
  const canValidateFindings = isAssignedAnalyst && status === 'FINDING_VALIDATION'
  const canAssignToRequester = isAssignedAnalyst && status === 'REMEDIATION'
  const canMarkFixed = (isRequester || isAssignedAnalyst) && status === 'WAITING_FOR_FIX'
  const canRescanDecide = isAssignedAnalyst && status === 'RESCAN'
  const canMarkReportReady = isAssignedAnalyst && status === 'SECURITY_COMPLETE'
  // Report Ready -> Closed. Usually reached automatically as part of the
  // Complete Scan/Rescan "no findings" confirmation, but this manual action
  // covers the case where that auto-chain stopped at Report Ready's
  // suppression gate and the analyst needs to finish the last hop themselves
  // once the linked suppression(s) are Done.
  const canCloseRequest = isAssignedAnalyst && status === 'REPORT_READY'

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'checklist', 'repository', 'findings', 'documents', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'findings' ? `Findings (${req.findings.length})`
              : t === 'history' ? 'Activity' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
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
            {/* Reported directly: this was previously only visible in the modal's
                own title bar, with no field for it in the body -- easy to miss,
                especially for the App Owner/SM who need to actually review it
                before deciding the name itself (the decision itself is made from
                the master QA Request page -- see RequestDetail.tsx's
                ApplicationNameBanner). */}
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
          </DetailSection>

          <DetailSection title="Environment & Hash">
            <DetailField label="Deployment Environment">{req.environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
            <DetailField label="Hash Value">{req.hash_value || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
            <DetailField label="Assigned QA Lead">{userName(users, req.security_lead_id) || 'Not assigned'}</DetailField>
            <DetailField label="Assigned Security Analyst">{userName(users, req.security_analyst_id) || 'Not assigned'}</DetailField>
          </DetailSection>

          {req.qa_request && (
            <p className="muted small">Linked from QA Request {req.qa_request.request_id}.</p>
          )}

          {/* Reported directly: canEditDetails above lets the SM/Department
              Head themselves open Edit Details while the request sits at
              their own decision -- if they untick a mandatory Security
              Readiness checklist item there, Sign/Approve must be blocked
              the exact same way the QA Request wizard already blocks
              Submit/Raise for the same reason (see
              QARequests/RequestDetail.tsx's own pendingMandatory). */}
          {(canSMDecide || canDeptHeadDecide) && pendingSelfDeclare.length > 0 && (
            <div style={{ marginTop: 8, marginBottom: 8, background: '#fffaeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', color: '#92400e', fontSize: 13 }}>
              <strong>Cannot Sign/Approve yet</strong> — the following mandatory Security Readiness checklist item(s)
              must be self-declared ready first (Edit Details):
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {pendingSelfDeclare.map((c) => <li key={c.item}>{c.item}</li>)}
              </ul>
            </div>
          )}

          <div className="section-title">Workflow Actions</div>
          <div className="actions-panel">
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
                        disabled={busy || (['RETURNED_BY_SM', 'SM_REJECTED'].includes(status) && pendingSelfDeclare.length > 0)}
                        onClick={() => act('resubmit')}>
                  {resubmitLabel}
                </button>
              )}
              {canResubmit && ['RETURNED_BY_SM', 'SM_REJECTED'].includes(status) && pendingSelfDeclare.length > 0 && (
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
                  signBlocked={applicationNameBlocking || pendingSelfDeclare.length > 0}
                  signBlockedMessage={
                    applicationNameBlocking
                      ? smApplicationNameBlockedMessage
                      : pendingSelfDeclare.length > 0
                      ? 'Mandatory Security Readiness checklist item(s) are not self-declared ready -- see the notice above.'
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
                      ? 'Mandatory Security Readiness checklist item(s) are not self-declared ready -- see the notice above.'
                      : undefined
                  }
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
                  onReturn={(actionNote) => act('department-head-decision', { decision: 'Returned', comments: actionNote })}
                  onReject={(actionNote) => act('department-head-decision', { decision: 'Rejected', comments: actionNote })}
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
              {canAssignSecurityAnalyst && (
                <>
                  <UserAssignSelect
                    value={selectedAnalyst}
                    onChange={setSelectedAnalyst}
                    users={securityAnalysts}
                    placeholder="Select Security Analyst..."
                    disabled={busy}
                    style={{ minWidth: 260 }}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy || !selectedAnalyst}
                    onClick={() => act('assign-security-analyst', { security_analyst_id: Number(selectedAnalyst) })}
                  >
                    Assign Security Analyst
                  </button>
                </>
              )}
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
          <p className="muted small">Security Readiness pre-scan checklist — verified by the central Security or QA team before Planning can begin.</p>
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
            <span style={{ width: 230, textAlign: 'center' }}>Evidence</span>
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
                  disabled={
                    !canVerifyChecklist ||
                    (!c.requester_checked && !c.is_complete)
                  }
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
              <ChecklistEvidence apiBase="/api/sast-requests" reqId={req.id} itemId={c.id}
                canManage={canManageReadinessEvidence(req.status, evidenceOwner)}
                required={c.is_mandatory || c.requester_checked}
                documents={documentsByItem[c.id] || []}
                onReload={reloadEvidence}
                checked={c.requester_checked} />
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

      {tab === 'documents' && <RequestDocuments apiBase="/api/sast-requests" reqId={req.id} canManage={canManageDocuments} />}

      {tab === 'history' && (
        <JiraActivity entityType="SAST" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}
    </Modal>
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
          { key: 'security_lead_id', header: 'Assigned QA Lead', render: (r) => userName(users, r.security_lead_id) || 'Not assigned', filterValue: (r) => userName(users, r.security_lead_id) || '' },
          { key: 'priority', header: 'Priority', render: (r) => r.priority || '—' },
          { key: 'risk_category', header: 'Risk' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} label={applicationNameAwareStatusLabel(r.status, r.application_master_status)} /> },
          { key: 'pending_with', header: 'Pending With', render: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? 'Application Owner' : (SAST_DAST_PENDING_WITH[r.status] || '—'), filterValue: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? 'Application Owner' : (SAST_DAST_PENDING_WITH[r.status] || '') },
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
          users={users}
        />
      )}
    </div>
  )
}
