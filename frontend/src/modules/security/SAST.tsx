import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, ReadinessPassError, PageHeader, ApprovalDecisionButtons, TableColumn, DetailSection, DetailField, RequestDocuments, ChecklistEvidence, useChecklistDocuments, applicationNameAwareStatusLabel, suppressionAwareStatusLabel } from '../../components/Common'
import SastRepositoryDetails, { SAST_COMPONENT_FIELDS, SastRepositoryRow } from '../../components/SastRepositoryDetails'
import UserAssignSelect from '../../components/UserAssignSelect'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import RoleGroupLink from '../../components/RoleGroupLink'
import RequestDelegation from '../../components/RequestDelegation'
import { SEVERITIES, PRIORITIES, SAST_DAST_STATUS_LABELS, SAST_DAST_PENDING_WITH, SAST_DAST_ANALYST_REASSIGNABLE_STATUSES, SUPPRESSION_TERMINAL_STATUSES, hasRole, hasDepartment, canManageReadinessEvidence, QA_DEPARTMENT } from '../../constants'
import { SASTOut, SASTListOut, SASTComponentOut, ChecklistItemOut, UserOut, ApprovalActionOut, SecurityScanResultOut, SecurityScanSummaryOut, RequestDocumentOut } from '../../types'
import { usePaginatedList } from '../../hooks/usePaginatedList'
import { SecurityScanDialog, SecurityScanResults, LinkSuppressionModal } from './SecurityScan'

// One "SAST component" = one repository, with its own branch/commit/tech
// stack/build number -- the "+" adds a whole new one of these (not just
// another URL), since a project can have several repos each needing their
// own full set of details. Same shape as QARequests.tsx's wizard SAST step.
// Standalone SAST request creation is DISABLED per request -- a SAST request
// can now only come into being by including "SAST" in a QA Request's request
// types (see backend routers/qa_requests.py::_sync_linked_security_requests),
// which creates it with just application_name/cr_number/risk
// populated. This modal is therefore edit-only now: it fills in the rest of
// the mandatory details (repository URL, branch, commit ID, tech stack,
// build number) on that auto-created request before the security team picks
// it up -- see canEditDetails in SASTDetail below.
function SASTFormModal({
  onClose,
  onSaved,
  editing,
  documentsByItem,
  reloadEvidence,
}: {
  onClose: () => void
  onSaved: (s: SASTOut) => void
  editing: SASTOut
  documentsByItem: Record<number, RequestDocumentOut[]>
  reloadEvidence: () => Promise<void>
}) {
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'ADMIN')
  // editing.components is already one real row per repository (see
  // models.SASTComponent) -- just drop the `id` for local editing state,
  // RepeatableGroupInput doesn't need it.
  function toRows(components: SASTComponentOut[]): SastRepositoryRow[] {
    return components.length > 0
      ? components.map((c) => ({
          repository_url: c.repository_url || '', git_branch: c.git_branch || '', commit_id: c.commit_id || '',
          technology_stack: c.technology_stack || '', build_number: c.build_number || '',
        }))
      : [{ repository_url: '', git_branch: '', commit_id: '', technology_stack: '', build_number: '' }]
  }
  const [form, setForm] = useState({
    application_name: editing.application_name || '',
    cr_number: editing.cr_number || editing.epic_number || '',
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
  // Same identity check as the detail view's isRequester/canSMDecide/
  // canDeptHeadDecide -- this modal only opens via that same gate, but the
  // checklist evidence controls inside it need their own explicit check.
  const isActiveDelegateModal = editing.active_delegation?.status === 'ACTIVE' && editing.active_delegation.assigned_to_id === user?.id
  const isRequesterModal = isActiveDelegateModal || isAdmin || (editing.requester_id === user?.id && !editing.active_delegation)
  const sameDeptModal = hasDepartment(user, editing.department)
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
    if (!form.cr_number.trim()) missing.push('CR Number/EPIC Number')
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
      // Evidence uploads are persisted immediately and are not included in
      // the form PUT response. Reconcile the shared cache before closing so
      // the Checklist tab cannot reveal its stale pre-edit file list.
      await reloadEvidence()
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
          Application Name and CR Number/EPIC Number are locked once this request has been raised --
          only an Administrator can change them.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-section">
          {/* <div className="form-section-title">Identity{!isAdmin ? ' (Admin-only)' : ''}</div> */}
          <div className="form-row">
            <Field label="Application Name *"><input required disabled={!isAdmin} value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
            <Field label="CR Number/EPIC Number *"><input required disabled={!isAdmin} value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
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
          </div>
        </div>

        <SastRepositoryDetails
          rows={form.components}
          onChange={(rows) => set('components', rows)}
          hashValue={form.hash_value}
          onHashChange={(value) => set('hash_value', value)}
        />

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

// Reported directly (same bug as Functional's "Assigned Group"): this used
// to hardcode "QA Lead" unconditionally regardless of the request's actual
// status. Maps the real backend status (see routers/sast_dast.py's shared
// status-transition helpers -- SM_APPROVAL_PENDING gated by Role.SM,
// DEPARTMENT_HEAD_APPROVAL_PENDING by Role.DEPARTMENT_HEAD_CM/AGM,
// SECURITY_LEAD_ASSIGNED/SECURITY_READINESS/PLANNING by Role.QA_LEAD, and
// -- unlike Functional -- everything from CONFIGURATION through
// REPORT_READY by Role.SECURITY_ANALYST, not QA Lead) to whichever group is
// genuinely holding the request right now. Returns null for every
// requester-owned/terminal status.
// Derived from SAST_DAST_PENDING_WITH (constants.ts) -- the same table that
// already drives the list's "Pending With" column and is itself kept in
// exact sync with sast_dast.py's require_roles()/_require_assigned_security_analyst()
// gates -- rather than re-deriving its own status list. This also fixes a
// bug in an earlier draft of this helper, which had put WAITING_FOR_FIX
// under Security Analyst: per PENDING_WITH's own comment, that stage is
// "Requester" -- the analyst has handed the finding back for a fix and is
// not the one blocking progress. (Mark Fixed was narrowed to requester-only
// in the follow-up fix below -- see canMarkFixed/sast_dast.py::_mark_fixed
// -- so this is no longer even a partial exception.)
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
  const pendingWith = SAST_DAST_PENDING_WITH[status]
  // Reported directly: "SM mapping should be based on department level. but
  // SM group details showing those are from different department." SM and
  // Department Head are BOTH department-scoped roles enforced server-side
  // (require_same_department, sast_dast.py) exactly like Application Owner
  // above -- `department` was missing here, so RoleGroupLink showed every
  // SM/Department Head in the system instead of just the ones who could
  // actually act on this request.
  if (pendingWith === 'SM') return { role: 'SM', label: 'SM', department }
  if (pendingWith === 'Department Head') {
    return { role: ['DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM'], label: 'Department Head', department }
  }
  // Reported directly: this "QA Lead group members" list should only show
  // literal QA_LEAD role holders -- Chief Manager - QA / AGM - QA act on
  // this work via their own separate Executive bypass (isAssignedQALead
  // below), not by being members of the QA Lead group.
  if (pendingWith === 'QA Lead') return { role: 'QA_LEAD', label: 'QA Lead' }
  if (pendingWith === 'Security Analyst') return { role: 'SECURITY_ANALYST', label: 'Security Analyst' }
  return null
}

function SASTDetail({ req, onClose, onChanged, users }: {
  req: SASTOut; onClose: () => void; onChanged: (s: SASTOut) => void; users: UserOut[]
}) {
  const { user } = useAuth()
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [selectedQALead, setSelectedQALead] = useState('')
  const [selectedAnalyst, setSelectedAnalyst] = useState('')
  // 2026-08 Reassignment CR -- mandatory only when this is a genuine
  // reassignment (status already past the initial PLANNING assignment);
  // backend enforces this too (reassignment.require_reason). Reset once the
  // assignment actually changes (i.e. on success).
  const [reassignAnalystReason, setReassignAnalystReason] = useState('')
  // Whether the "require Department Head re-approval on return" popup (see
  // canReadinessDecide below) is open -- an always-visible checkbox next to
  // "Readiness Failed" was easy to miss, so this is now asked as a pop-up at
  // the moment of failing readiness instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false)
  const [readinessPassError, setReadinessPassError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [checklist, setChecklist] = useState<ChecklistItemOut[]>(req.checklist_items || [])
  useEffect(() => { setChecklist(req.checklist_items || []) }, [req])
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments('/api/sast-requests', req.id)
  const navigate = useNavigate()
  const [showStartScan, setShowStartScan] = useState(false)
  // 2026-08 "Findings Validation" doc -- Rescan reuses SecurityScanDialog in
  // `mode="rescan"`; replaces the old scanConfirmAction/ConfirmModal pair
  // (Complete Scan's and Rescan Decision's shared "were there findings?"
  // self-report pop-up) entirely -- Mark Scan Complete now calls straight
  // through with no confirmation dialog, since the system already knows the
  // answer from the latest imported scan.
  const [showRescan, setShowRescan] = useState(false)
  // Reported directly: "while clicking on Scan or Rescan, give warning
  // message saying are you ready to retrieve the result or are you sure
  // scan has been completed" -- Start Scan/Rescan both import whatever is
  // CURRENTLY sitting in Fortify SSC for that application/version right
  // away, with no separate "is the scan actually done yet" check; clicking
  // too early silently imports a stale or in-progress result. This is a
  // one-question Yes/No gate in front of each -- confirming just advances
  // to the existing SecurityScanDialog (Validate & Start Scan / Rescan)
  // unchanged; declining closes it with nothing started.
  const [showStartScanConfirm, setShowStartScanConfirm] = useState(false)
  const [showRescanConfirm, setShowRescanConfirm] = useState(false)
  // "give option to link and delink supression request from sast request
  // and supression both" -- opens LinkSuppressionModal (SecurityScan.tsx),
  // the SAST-side counterpart to Suppression.tsx's own Relink control.
  const [showLinkSuppression, setShowLinkSuppression] = useState(false)
  const [scanError, setScanError] = useState<unknown>(null)
  const [scanNotice, setScanNotice] = useState('')
  const [scanResults, setScanResults] = useState<SecurityScanResultOut[]>([])
  const [scanSummary, setScanSummary] = useState<SecurityScanSummaryOut | null>(null)

  const load = useCallback(async () => {
    try {
      setHistory(await api.get<ApprovalActionOut[]>(`/api/sast-requests/${req.id}/history`))
    } catch (err) { setError(err) }
  }, [req.id])

  const loadScan = useCallback(() => {
    api.get<SecurityScanResultOut[]>(`/api/sast-requests/${req.id}/scan-results`).then(setScanResults).catch(() => setScanResults([]))
    api.get<SecurityScanSummaryOut>(`/api/sast-requests/${req.id}/scan-summary`).then(setScanSummary).catch(() => setScanSummary(null))
  }, [req.id])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadScan() }, [loadScan])
  useEffect(() => { setReassignAnalystReason('') }, [req.id, req.security_analyst_id])

  async function toggleChecklistItem(item: ChecklistItemOut) {
    setError(null)
    try {
      const saved = await api.put<ChecklistItemOut>(`/api/sast-requests/${req.id}/checklist/${item.id}`, { is_complete: !item.is_complete })
      setChecklist((rows) => rows.map((r) => (r.id === saved.id ? saved : r)))
    } catch (err) { setError(err) }
  }

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    const isReadinessPass = action === 'readiness-decision' && extra?.decision === 'Passed'
    if (isReadinessPass) setReadinessPassError(null)
    setBusy(true)
    try {
      const updated = await api.post<SASTOut>(`/api/sast-requests/${req.id}/${action}`, extra || {})
      onChanged(updated)
      setComments('')
      await load()
      return updated
    }
    catch (err) {
      if (isReadinessPass) setReadinessPassError(err)
      else setError(err)
      return null
    } finally { setBusy(false) }
  }

  async function startScan(applicationName: string, applicationVersion: string) {
    setBusy(true); setScanError(null)
    try {
      const response = await api.post<{ request: SASTOut; scan_result: SecurityScanResultOut }>(`/api/sast-requests/${req.id}/start-scan`, {
        application_name: applicationName, application_version: applicationVersion,
      })
      onChanged(response.request)
      setShowStartScan(false)
      setTab('findings')
      setScanNotice(`Scan validated successfully. Fortify SSC findings were imported and are shown below.`)
      await loadScan()
      await load()
    } catch (err) { setScanError(err) } finally { setBusy(false) }
  }
  // 2026-08 "Findings Validation" doc -- re-imports fresh Fortify SSC
  // results into a NEW scan record (see routers/sast_dast.py::_rescan_scan);
  // status is unchanged by this call, only the scan data refreshes.
  async function rescan(applicationName: string, applicationVersion: string) {
    setBusy(true); setScanError(null)
    try {
      const response = await api.post<{ request: SASTOut; scan_result: SecurityScanResultOut }>(`/api/sast-requests/${req.id}/rescan`, {
        application_name: applicationName, application_version: applicationVersion,
      })
      onChanged(response.request)
      setShowRescan(false)
      loadScan()
      await load()
    } catch (err) { setScanError(err) } finally { setBusy(false) }
  }
  // Reported directly, full requirement doc pasted with a status-flow
  // diagram: Mark Scan Complete's own button was retired from the Findings
  // tab in favor of Validate Findings (see canValidateFindings above) --
  // the backend endpoint (_mark_scan_complete) is left in place, unused,
  // matching this file's existing convention for superseded-but-not-deleted
  // legacy actions.
  async function validateFindings() {
    const updated = await act('validate-findings')
    if (!updated) return
    setTab('findings')
    setScanNotice(updated.status === 'WAITING_FOR_FIX'
      ? 'Findings validated successfully. Open findings were automatically assigned to the requester for remediation.'
      : 'Findings validated successfully. No unresolved finding requires requester action.')
    await loadScan()
  }
  // Deep-links to the Suppression module's own "New Suppression Request"
  // modal, pre-linked to this exact SAST request (see Suppression.tsx's
  // `?new=1&scan_type=...&request_id=...` handling).
  function initiateSuppression() {
    navigate(`/suppression?new=1&scan_type=SAST&request_id=${req.id}`)
  }
  const isAdmin = hasRole(user, 'ADMIN')
  const isRequester = req.requester_id === user?.id || isAdmin
  const status = req.status
  const sameDept = hasDepartment(user, req.department)
  // Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on every QA-Lead-
  // gated action, same as Admin, without being listed as "QA Lead group"
  // members (display-only concern, see assignedGroupFor above). See
  // ORACLE_MIGRATION_2026-07.md section 59.
  const isAssignedQALead = isAdmin || hasRole(user, 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')
  const isAssignedAnalyst = isAdmin || (hasRole(user, 'SECURITY_ANALYST') && req.security_analyst_id === user?.id)
  const qaLeads = users.filter((u) => u.is_active && hasDepartment(u, QA_DEPARTMENT) && (u.roles || []).includes('QA_LEAD'))
  const securityAnalysts = users.filter((u) => u.is_active && hasDepartment(u, QA_DEPARTMENT) && (u.roles || []).includes('SECURITY_ANALYST'))

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
  const isActiveDelegate = req.active_delegation?.status === 'ACTIVE' && req.active_delegation.assigned_to_id === user?.id
  const requesterInputEditor = isActiveDelegate || isAdmin || (isRequester && !req.active_delegation)
  const canEditDetails = hasRole(user, 'ADMIN')
    || (requesterInputEditor && ['DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status))
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
  const canResubmit = isRequester && !req.active_delegation && ['RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status)
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
    requesterInputEditor
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
    ['DRAFT', 'SUBMITTED', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status) ? requesterInputEditor :
    status === 'SM_APPROVAL_PENDING' ? canSMDecide :
    status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecide :
    false
  )
  const canStartReadiness = isAssignedQALead && status === 'SECURITY_LEAD_ASSIGNED'
  const canReadinessDecide = isAssignedQALead && status === 'SECURITY_READINESS'
  const canVerifyChecklist = isAssignedQALead && status === 'SECURITY_READINESS'
  // Mandatory checklist items must be self-declared ready BEFORE Submit is
  // even allowed (see routers/sast_dast.py::_require_checklist_ready) --
  // distinct from Security Readiness's own independent verification.
  const pendingSelfDeclare = checklist.filter((c) => c.is_mandatory && !c.requester_checked)
  const isInitialAnalystAssignment = status === 'PLANNING'
  // 2026-08 Reassignment CR, reported directly: "Everywhere the system
  // provides an Assign option ... it must also provide a Reassign option.
  // Reassignment shall be permitted to: the current assignee, the
  // Department Head of the department to which the current assignee
  // belongs, or Admin users." Previously Assign Security Analyst was
  // single-shot (QA Lead group, PLANNING only, no self-handoff). Now
  // reassignable through the rest of the active-scan window too -- see
  // SAST_DAST_ANALYST_REASSIGNABLE_STATUSES. Then, reported directly again:
  // QA_LEAD is required to keep reassignment rights too, restoring parity
  // with isAssignedQALead (which already gates the first assignment).
  // Mirrors sast_dast.py's _require_can_reassign_security_analyst exactly.
  const isQADepartmentHead = isAdmin || (hasRole(user, 'CHIEF_MANAGER_QA', 'AGM_QA') && hasDepartment(user, QA_DEPARTMENT))
  const canReassignSecurityAnalyst = isAssignedAnalyst || isQADepartmentHead || hasRole(user, 'QA_LEAD')
  const canAssignSecurityAnalyst =
    (isInitialAnalystAssignment ? isAssignedQALead : canReassignSecurityAnalyst) &&
    SAST_DAST_ANALYST_REASSIGNABLE_STATUSES.includes(status)
  const canStartScan = isAssignedAnalyst && status === 'CONFIGURATION'
  // Reported directly, full requirement doc pasted with a status-flow
  // diagram: this session had earlier built a flatter model (Rescan/Mark
  // Scan Complete/Assign to Requester all reachable directly from
  // Scanning). That's superseded here -- Finding Validation is a mandatory,
  // explicit gate again: Scanning -> Validate Findings (canValidateFindings)
  // -> Security Complete or Remediation -> Assign to Requester
  // (canAssignToRequester) -> Waiting For Fix -> Mark Fixed -> Rescan status
  // -> Rescan (canRescan) -> back to Scanning. Each gate now checks the ONE
  // specific status it's valid from, mirroring sast_dast.py's
  // _validate_findings/_assign_to_requester/_rescan_scan exactly, instead
  // of a broad "somewhere in the active-scan window" set.
  const canValidateFindings = isAssignedAnalyst && status === 'SCANNING'
  const canAssignToRequester = isAssignedAnalyst && status === 'REMEDIATION'
  const canRescan = isAssignedAnalyst && status === 'RESCAN'
  // Reported directly: "suppression requests CAN ONLY be raised by
  // requester, so this should be enable for requester, not QA team." --
  // the requester's own action. Narrowed to Waiting For Fix only (was the
  // whole active-scan window under the earlier flatter model) -- the
  // requirement doc's Section 4 frames raising a suppression as one of two
  // things the requester chooses between only once they're actually
  // holding the request ("After reviewing the findings, the requester may
  // choose..." -- Option A: fix, Option B: suppress), not any time during
  // the analyst's own Scanning/Remediation phases.
  //
  // Reported directly (follow-up): "requester delegated, to qa ... Full
  // stand-in for requester" briefly used requesterInputEditor here (like
  // canMarkFixed below), extending suppression-raising to the active
  // delegate too.
  //
  // Reported directly (reversed): "INITIATE SUPPRESSION REQUEST SHOULD BE
  // FROM REQUESTER SIDE, NOT QA SIDE" -- the concrete case was a requester
  // who'd delegated this Waiting For Fix request to a Security Analyst
  // (ordinary "full stand-in" use), and that analyst could then raise a
  // suppression against their own team's finding. Suppression is now
  // carved OUT of delegate stand-in entirely -- uses plain `isRequester`
  // (the literal original requester, or Admin) instead of
  // requesterInputEditor, unlike canMarkFixed below which is still fully
  // delegable. Since the delegate can no longer act here, the original
  // requester is deliberately NOT blocked by !req.active_delegation either
  // (isRequester already ignores delegation status) -- mirrors
  // suppression.py's _require_requester_of_linked exactly.
  const canInitiateSuppression = isRequester && status === 'WAITING_FOR_FIX'
  // Reported directly (follow-up): "why still mark fixed is visible? why
  // you are not going through the codebase and not fixing all and not
  // checking edge cases." Two fixes, mirroring sast_dast.py's _mark_fixed
  // exactly:
  // (1) `isAssignedAnalyst` used to also grant Mark Fixed -- a leftover
  //     from the pre-turn-based design (section 51/52) that no longer
  //     matches "after fix requester will reassign": Mark Fixed is now
  //     strictly the requester's action, same as Rescan/Assign to Requester
  //     are strictly the analyst's (section 130).
  // (2) `req.active_delegation` guard was entirely missing -- once
  //     WAITING_FOR_FIX became delegatable (section 126), a requester who'd
  //     delegated this request out could still Mark Fixed themselves while
  //     the delegate's assignment was still open.
  //
  // Reported directly (another follow-up): "requester delegated, to qa.
  // but as status is Waiting For Fix, in qa side rescan button and all
  // eligble button not visible." Blocking Mark Fixed outright while
  // delegated (as just above) left the delegate with nothing reachable at
  // all -- SAST/DAST has no editable surface during Waiting For Fix
  // (Documents/Checklist are locked solid post-readiness, the edit form is
  // pre-approval-only). Asked directly: delegate should be a full stand-in
  // for the requester, including Mark Fixed itself. Now uses
  // requesterInputEditor (isActiveDelegate OR (isRequester and NOT
  // delegated)) instead of `isRequester && !req.active_delegation` --
  // the delegate can Mark Fixed directly; the original requester is still
  // locked out while someone else holds the delegation. Mirrors
  // sast_dast.py's _mark_fixed exactly, which also auto-closes the
  // delegation once Mark Fixed succeeds.
  const canMarkFixed = requesterInputEditor && status === 'WAITING_FOR_FIX'
  const canMarkReportReady = isAssignedAnalyst && status === 'SECURITY_COMPLETE'
  // Report Ready -> Closed. Usually reached automatically as part of Mark
  // Scan Complete's clean-scan chain, but this manual action covers the case
  // where that auto-chain stopped at Report Ready's suppression gate and the
  // analyst needs to finish the last hop themselves once the linked
  // suppression(s) are Done.
  const canCloseRequest = isAssignedAnalyst && status === 'REPORT_READY'
  // Reported directly (bug): "Supression request is now rejected, but
  // still user not able to create supression request." Excludes both
  // SUPPRESSION_TERMINAL_STATUSES (Done AND Rejected), not just Done --
  // only a genuinely still-open suppression blocks Initiate Suppression
  // Request/Mark Fixed (see SecurityScanResults' own use of this).
  const hasOpenSuppression = (req.suppressions || []).some((s) => !SUPPRESSION_TERMINAL_STATUSES.includes(s.status || ''))
  const openSuppressionIds = (req.suppressions || []).filter((s) => !SUPPRESSION_TERMINAL_STATUSES.includes(s.status || '')).map((s) => s.suppression_id)
  // Reported directly: "for same sast request, even though supression
  // request is present and mark completed, again asking for new supression
  // request and relink." A suppression reaching Done is no longer "open"
  // (hasOpenSuppression above goes false), which used to silently re-enable
  // Initiate/Link Suppression Request -- but per the requirement doc's
  // Section 4, once Approved the requester's next move is to reassign to
  // the analyst (Mark Fixed), not raise a second suppression against the
  // same request. See SecurityScanResults' own use of this.
  const hasDoneSuppression = (req.suppressions || []).some((s) => s.status === 'Done')
  const doneSuppressionIds = (req.suppressions || []).filter((s) => s.status === 'Done').map((s) => s.suppression_id)

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'checklist', 'repository', 'findings', 'documents', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {/* Findings count now comes from the latest Fortify SSC scan
                result, not the old manually-logged req.findings rows --
                that manual "Log Finding" entry point was removed since
                findings come from the SAST/DAST API, which made
                req.findings permanently empty. */}
            {t === 'findings' ? `Findings (${scanResults[0]?.total_count ?? 0})`
              : t === 'history' ? 'Activity' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
          <DetailSection title="Status">
            <DetailField label="Status">
              <Badge status={status} label={applicationNameAwareStatusLabel(status, req.application_master_status) || suppressionAwareStatusLabel(status, hasOpenSuppression)} />
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
              <DetailField label="Suppression ID">
                <span className="suppression-id-links">
                  {req.suppressions.map((s) => (
                    <button key={s.id} type="button" className="suppression-id-link" onClick={() => navigate(`/suppression?open=${encodeURIComponent(s.suppression_id)}`)}>
                      {s.suppression_id}
                    </button>
                  ))}
                </span>
              </DetailField>
            )}
            <DetailField label="Created">{formatDateTimeIST(req.created_at)}</DetailField>
            <DetailField label="Last Updated">{formatDateTimeIST(req.updated_at)}</DetailField>
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
            <DetailField label="CR Number/EPIC Number">{req.cr_number || req.epic_number || '—'}</DetailField>
            <DetailField label="Change Description">{req.change_description || '—'}</DetailField>
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
            <DetailField label="Assigned Group">
              {(() => {
                const assigned = assignedGroupFor(req.status, req.application_master_status, req.department)
                return assigned ? <RoleGroupLink users={users} role={assigned.role} label={assigned.label} department={assigned.department} /> : '—'
              })()}
            </DetailField>
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
              <RequestDelegation
                targetType="SAST"
                request={req}
                users={users}
                disabled={busy}
                onChanged={async (updated) => { onChanged(updated); await load() }}
              />
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
                  extraControlLabel="Assign to group"
                  extraControl={<RoleGroupLink users={users} role="QA_LEAD" label="QA Lead" />}
                  extraReady
                  onApprove={(signed) => act('department-head-decision', { decision: 'Approved', comments: signed })}
                  onReturn={(actionNote) => act('department-head-decision', { decision: 'Returned', comments: actionNote })}
                  onReject={(actionNote) => act('department-head-decision', { decision: 'Rejected', comments: actionNote })}
                />
              )}
              {canStartReadiness && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-readiness')}>Start Security Readiness</button>}
              {canReadinessDecide && (
                <>
                  <button className="btn btn-success btn-sm" disabled={busy}
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
              {canAssignSecurityAnalyst && (
                <>
                  <UserAssignSelect
                    value={selectedAnalyst}
                    onChange={setSelectedAnalyst}
                    users={securityAnalysts}
                    placeholder={isInitialAnalystAssignment ? 'Select Security Analyst...' : 'Reassign Security Analyst...'}
                    disabled={busy}
                    style={{ minWidth: 260 }}
                  />
                  {!isInitialAnalystAssignment && (
                    <input
                      className="reassign-reason-input"
                      style={{ minWidth: 220 }}
                      placeholder="Reason for reassignment *"
                      value={reassignAnalystReason}
                      onChange={(e) => setReassignAnalystReason(e.target.value)}
                      disabled={busy}
                    />
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy || !selectedAnalyst || (!isInitialAnalystAssignment && (Number(selectedAnalyst) === req.security_analyst_id || !reassignAnalystReason.trim()))}
                    onClick={() => act('assign-security-analyst', {
                      security_analyst_id: Number(selectedAnalyst),
                      ...(isInitialAnalystAssignment ? {} : { reason: reassignAnalystReason.trim() }),
                    })}
                  >
                    {isInitialAnalystAssignment ? 'Assign Security Analyst' : 'Reassign Security Analyst'}
                  </button>
                </>
              )}
              {canStartScan && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setShowStartScanConfirm(true)}>Start Scan</button>}
              {/* Rescan / Mark Scan Complete now live in the Findings tab's
                  Scan Summary panel (SecurityScanResults, section 4.4 of the
                  "Findings Validation" doc) instead of here -- they act on
                  the scan data shown right there, and replace the old
                  Complete Scan / Rescan Decision self-report buttons. */}
              {/* Validate Findings / Assign to Requester / Mark Fixed all
                  live in the Findings tab now (SecurityScanResults, section
                  4.4) -- reported directly, see canValidateFindings above. */}
              {canMarkReportReady && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('mark-report-ready')}>Mark Report Ready</button>}
              {canCloseRequest && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('close')}>Close Request</button>}
            </div>
          </div>

          {editing && (
            <SASTFormModal
              editing={req}
              documentsByItem={documentsByItem}
              reloadEvidence={reloadEvidence}
              onClose={() => setEditing(false)}
              onSaved={(saved) => { setEditing(false); onChanged(saved) }}
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
          {scanNotice && (
            <div className="execution-start-notice linked" role="status">
              <strong>Success</strong><span>{scanNotice}</span>
            </div>
          )}
          {/* The old manual findings table (Issue ID/Severity/Description/
              Status, backed by req.findings -- SASTFinding rows) is removed
              -- reported directly. It always showed "No records found."
              since manual "Log Finding" entry was removed (findings come
              from the SAST API); SecurityScanResults above is the real,
              live findings view now. */}
          <SecurityScanResults
            kind="SAST"
            results={scanResults}
            summary={scanSummary}
            canValidateFindings={canValidateFindings}
            canRescan={canRescan}
            canAssignToRequester={canAssignToRequester}
            canInitiateSuppression={canInitiateSuppression}
            canMarkFixed={canMarkFixed}
            busy={busy}
            hasOpenSuppression={hasOpenSuppression}
            openSuppressionIds={openSuppressionIds}
            hasDoneSuppression={hasDoneSuppression}
            doneSuppressionIds={doneSuppressionIds}
            onValidateFindings={validateFindings}
            onRescan={() => setShowRescanConfirm(true)}
            onAssignToRequester={() => act('assign-to-requester')}
            onMarkFixed={() => act('mark-fixed')}
            onInitiateSuppression={initiateSuppression}
            onLinkSuppression={() => setShowLinkSuppression(true)}
          />
        </div>
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/sast-requests" reqId={req.id} canManage={canManageDocuments} />}

      {tab === 'history' && (
        <JiraActivity entityType="SAST" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      <ReadinessPassError error={readinessPassError} />

      {/* Rendered outside every tab-specific block (not just inside
          Overview) -- reported directly: clicking Rescan from the Findings
          tab's SecurityScanResults set showRescan but this dialog used to
          only be mounted while tab === 'overview', so nothing appeared
          until switching tabs. Same fix applies to Start Scan for
          consistency, even though that button itself only lives on
          Overview today. */}
      {/* "give warning message saying are you ready to retrieve the result
          or are you sure scan has been completed" -- one confirm step in
          front of each import dialog; confirming is the only thing that
          sets showStartScan/showRescan, so the actual import can't be
          reached without it. */}
      {showStartScanConfirm && (
        <ConfirmModal
          title="Start Scan"
          message="Has the scan in Fortify SSC finished running? Starting the import now will retrieve whatever results are currently available for this application/version -- if the scan is still in progress, the results may be incomplete."
          confirmLabel="Yes, retrieve results"
          cancelLabel="Not yet"
          onConfirm={() => { setShowStartScanConfirm(false); setScanError(null); setShowStartScan(true) }}
          onCancel={() => setShowStartScanConfirm(false)}
        />
      )}
      {showRescanConfirm && (
        <ConfirmModal
          title="Rescan"
          message="Has the rescan in Fortify SSC finished running? Retrieving results now will import whatever is currently available for this application/version -- if the scan is still in progress, the results may be incomplete."
          confirmLabel="Yes, retrieve results"
          cancelLabel="Not yet"
          onConfirm={() => { setShowRescanConfirm(false); setScanError(null); setShowRescan(true) }}
          onCancel={() => setShowRescanConfirm(false)}
        />
      )}
      {showStartScan && <SecurityScanDialog kind="SAST" initialApplicationName={req.application_name} busy={busy} error={scanError} onClose={() => setShowStartScan(false)} onStart={startScan} />}
      {showRescan && (
        <SecurityScanDialog
          kind="SAST" mode="rescan"
          initialApplicationName={scanResults[0]?.application_name || req.application_name}
          initialApplicationVersion={scanResults[0]?.application_version}
          busy={busy} error={scanError}
          onClose={() => setShowRescan(false)}
          onStart={rescan}
        />
      )}
      {showLinkSuppression && (
        <LinkSuppressionModal
          kind="SAST"
          requestId={req.id}
          requestLabel={req.request_id}
          onClose={() => setShowLinkSuppression(false)}
          onLinked={async () => {
            setShowLinkSuppression(false)
            onChanged(await api.get<SASTOut>(`/api/sast-requests/${req.id}`))
            await load()
          }}
        />
      )}
    </Modal>
  )
}

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

export default function SAST() {
  // SRS 7.2 PAG-006 -- the list only ever holds the lightweight SASTListOut
  // shape; opening a request fetches the full SASTOut record fresh via
  // GET /api/sast-requests/{id} before SASTDetail (which needs every field)
  // is shown.
  const [selected, setSelected] = useState<SASTOut | null>(null)
  const [openingId, setOpeningId] = useState<number | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const [assignedOnly, setAssignedOnly] = useState(false)

  const {
    items: rows, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading, setPage, setPageSize, reload,
  } = usePaginatedList<SASTListOut>('/api/sast-requests', {
    extra: { assigned_to_me: assignedOnly ? 'true' : undefined },
  })

  useEffect(() => {
    // Full user list -- not just security analysts -- so both the Security
    // Lead assignment dropdown and the "Requester" field on the detail view
    // can resolve names from a single fetch.
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names/dropdown just stay empty */ })
  }, [])

  const openRequest = useCallback(async (idOrRow: number | SASTListOut) => {
    const id = typeof idOrRow === 'number' ? idOrRow : idOrRow.id
    setOpeningId(id)
    try {
      setSelected(await api.get<SASTOut>(`/api/sast-requests/${id}`))
    } catch (err) { setError(err) } finally { setOpeningId(null) }
  }, [])

  // Deep-link support -- see the matching effect in Functional.tsx for the
  // full reasoning; the gateway's "Linked Requests" table opens a specific
  // SAST request here via `?open=<request_id>`.
  useEffect(() => {
    const recordId = Number(searchParams.get('openId'))
    const openId = searchParams.get('open')
    if (Number.isInteger(recordId) && recordId > 0) {
      openRequest(recordId)
    } else if (openId) {
      const match = rows.find((r) => r.request_id === openId)
      if (!match) return
      openRequest(match.id)
    } else return
    setSearchParams((p) => { p.delete('open'); p.delete('openId'); return p }, { replace: true })
  }, [rows, searchParams, setSearchParams, openRequest])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="SAST Requests" count={total}
        subtitle="Static Application Security Testing(SAST) requests, from submission through findings and report clearance. Raised via a QA Request (include SAST in its request types)."
      />
      <div className="toolbar module-assignment-toolbar">
        <div className="tabs" style={{ margin: 0 }}>
          <button type="button" className={!assignedOnly ? 'active' : ''} onClick={() => setAssignedOnly(false)}>All Requests</button>
          <button type="button" className={assignedOnly ? 'active' : ''} onClick={() => setAssignedOnly(true)}>My Assigned Work</button>
        </div>
      </div>
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
          { key: 'change_description', header: 'Change Description', render: (r) => (
            <span className="truncate-cell" title={r.change_description || ''}>{r.change_description || '—'}</span>
          ), filterValue: (r) => r.change_description || '' },
          { key: 'requester_id', header: 'Requester', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
          { key: 'security_lead_id', header: 'Assigned Group', render: (r) => assignedGroupFor(r.status, r.application_master_status)?.label || '—', filterValue: (r) => assignedGroupFor(r.status, r.application_master_status)?.label || '' },
          { key: 'priority', header: 'Priority', render: (r) => r.priority || '—' },
          { key: 'risk_category', header: 'Risk' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} label={applicationNameAwareStatusLabel(r.status, r.application_master_status) || suppressionAwareStatusLabel(r.status, r.has_open_suppression)} /> },
          { key: 'pending_with', header: 'Pending With', render: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? 'Application Owner' : (SAST_DAST_PENDING_WITH[r.status] || '—'), filterValue: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? 'Application Owner' : (SAST_DAST_PENDING_WITH[r.status] || '') },
          { key: 'findings', header: 'Findings', render: (r) => r.findings_count, filterValue: (r) => String(r.findings_count) },
          { key: 'source', header: 'Source', render: (r) => (
            r.qa_request ? (
              <span className="badge badge-blue" title="Auto-created from a QA Request">
                Linked · {r.qa_request.request_id}
              </span>
            ) : <span className="badge badge-gray">Standalone (legacy)</span>
          ), filterValue: (r) => r.qa_request ? `Linked ${r.qa_request.request_id}` : 'Standalone legacy' },
          { key: 'created_at', header: 'Created', render: (r) => formatDateTimeIST(r.created_at) },
          { key: 'updated_at', header: 'Updated', render: (r) => formatDateTimeIST(r.updated_at) },
        ]} rows={rows} />
      </Card>
      {selected && (
        <SASTDetail
          req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); reload() }}
          users={users}
        />
      )}
    </div>
  )
}
