import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, ReadinessPassError, PageHeader, ApprovalDecisionButtons, RepeatableRows, TableColumn, DetailSection, DetailField, RequestDocuments, ChecklistEvidence, useChecklistDocuments, applicationNameAwareStatusLabel, suppressionAwareStatusLabel } from '../../components/Common'
import UserAssignSelect from '../../components/UserAssignSelect'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import RoleGroupLink from '../../components/RoleGroupLink'
import RequestDelegation from '../../components/RequestDelegation'
import { SEVERITIES, PRIORITIES, ENVIRONMENTS, SAST_DAST_STATUS_LABELS, SAST_DAST_PENDING_WITH, SAST_DAST_ANALYST_REASSIGNABLE_STATUSES, SUPPRESSION_TERMINAL_STATUSES, hasRole, hasDepartment, canManageReadinessEvidence, QA_DEPARTMENT } from '../../constants'
import { DASTOut, DASTListOut, DASTTargetOut, ChecklistItemOut, UserOut, ApprovalActionOut, SecurityScanResultOut, SecurityScanSummaryOut, RequestDocumentOut } from '../../types'
import { usePaginatedList } from '../../hooks/usePaginatedList'
import { SecurityScanDialog, SecurityScanResults, LinkSuppressionModal } from './SecurityScan'

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

// One real row per scan target (see models.DASTTarget) -- no more splitting
// newline-joined columns back apart to display these. Credentials is
// sensitive -- the API only ever populates a target's test_credentials for
// the requester or a security analyst/admin (see _dast_out in
// routers/sast_dast.py); every other viewer gets it blanked out
// server-side, so it naturally shows as "—" here for anyone unauthorized.
const DAST_TARGET_COLUMNS: TableColumn<DASTTargetOut>[] = [
  { key: 'application_url', header: 'Application URL', render: (t) => t.application_url || '—' },
  { key: 'environment', header: 'Environment', render: (t) => t.environment || '—' },
  { key: 'authentication_required', header: 'Auth Required', render: (t) => t.authentication_required || '—' },
  { key: 'test_credentials', header: 'Credentials', render: (t) => t.test_credentials || '—' },
]

// One "DAST target" = one URL to scan, with its own environment/auth
// requirement/credentials -- the "+" adds a whole new target. Test
// Credentials only shows once that target's own Authentication Required is
// ticked. No Target Release field -- Target Release Date is already
// collected once, on the QA Request itself (shown read-only below).
interface DastTargetRow {
  application_url: string
  environment: string
  authentication_required: boolean
  test_credentials: string
}
function blankDastTarget(): DastTargetRow {
  return { application_url: '', environment: '', authentication_required: false, test_credentials: '' }
}

// Standalone DAST request creation is DISABLED per request -- a DAST request
// can now only come into being by including "DAST" in a QA Request's request
// types (see backend routers/qa_requests.py::_sync_linked_security_requests),
// which creates it with a placeholder application_url. This modal is
// therefore edit-only now: it fills in the real target URL / environment /
// credentials on that auto-created request -- see canEditDetails in
// DASTDetail below.
function DASTFormModal({
  onClose,
  onSaved,
  editing,
  documentsByItem,
  reloadEvidence,
}: {
  onClose: () => void
  onSaved: (d: DASTOut) => void
  editing: DASTOut
  documentsByItem: Record<number, RequestDocumentOut[]>
  reloadEvidence: () => Promise<void>
}) {
  // editing.targets is already one real row per scan target (see
  // models.DASTTarget) -- just convert authentication_required's "Yes"/"No"
  // to a boolean for the checkbox, and drop `id` for local editing state.
  // This modal is only reachable by canEditDetails-authorized users
  // (requester or security analyst/admin), which is exactly who the API
  // returns real test_credentials to -- so it comes through populated here.
  function toRows(targets: DASTTargetOut[]): DastTargetRow[] {
    return targets.length > 0
      ? targets.map((t) => ({
          application_url: t.application_url || '', environment: t.environment || '',
          authentication_required: (t.authentication_required || '').trim().toLowerCase() === 'yes',
          test_credentials: t.test_credentials || '',
        }))
      : [blankDastTarget()]
  }
  const [targets, setTargets] = useState<DastTargetRow[]>(toRows(editing.targets))
  const [riskCategory, setRiskCategory] = useState(editing.risk_category || 'Medium')
  const [priority, setPriority] = useState(editing.priority || 'Medium')
  // Lets the requester revisit their Security Readiness checklist
  // self-declaration from here too -- same pattern as Performance.tsx's
  // PerformanceFormModal checkedItems / SASTFormModal above.
  const [checkedItems, setCheckedItems] = useState<string[]>(
    editing.checklist_items.filter((c) => c.requester_checked).map((c) => c.item)
  )
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // Same identity check as the detail view's isRequester/canSMDecide/
  // canDeptHeadDecide -- this modal only opens via canEditDetails, but the
  // checklist evidence controls inside it need their own explicit check.
  const { user: modalUser } = useAuth()
  const isAdminModal = hasRole(modalUser, 'ADMIN')
  const isActiveDelegateModal = editing.active_delegation?.status === 'ACTIVE' && editing.active_delegation.assigned_to_id === modalUser?.id
  const isRequesterModal = isActiveDelegateModal || isAdminModal || (editing.requester_id === modalUser?.id && !editing.active_delegation)
  const sameDeptModal = hasDepartment(modalUser, editing.department)
  const canSMDecideModal = hasRole(modalUser, 'SM') && editing.status === 'SM_APPROVAL_PENDING' && sameDeptModal
  const canDeptHeadDecideModal = hasRole(modalUser, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && editing.status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDeptModal
  const canManageEvidenceModal = isAdminModal || (
    editing.status === 'SM_APPROVAL_PENDING' ? canSMDecideModal :
    editing.status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecideModal :
    isRequesterModal
  )
  function toggleChecked(item: string) {
    setCheckedItems((items) => (items.includes(item) ? items.filter((i) => i !== item) : [...items, item]))
  }

  // A target with Authentication Required ticked but no Test Credentials is
  // useless to the security team ("with out this how security team will
  // start scan") -- mirrors dastStepError in the QA Request wizard.
  function targetsError(): string | null {
    const missingCreds = targets.some((t) => t.authentication_required && !t.test_credentials.trim())
    return missingCreds
      ? 'Test Credentials is required for any target with Authentication Required ticked.'
      : null
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const err = targetsError()
    if (err) { setError(err); return }
    setBusy(true)
    try {
      const payload = {
        // Sent as a real array -- one entry per target URL -- and replaces
        // this request's entire set of target rows server-side (see
        // update_dast in routers/sast_dast.py), rather than being joined
        // into 4 newline-separated columns.
        targets: targets.map((t) => ({
          application_url: t.application_url.trim(),
          environment: t.environment.trim(),
          authentication_required: t.authentication_required ? 'Yes' : 'No',
          test_credentials: t.test_credentials.trim(),
        })),
        risk_category: riskCategory,
        priority,
        checked_items: checkedItems,
      }
      const saved = await api.put<DASTOut>(`/api/dast-requests/${editing.id}`, payload)
      // Evidence uploads are persisted independently from this form PUT.
      // Refresh the shared parent cache before the modal closes so the
      // Checklist tab immediately renders the saved files.
      await reloadEvidence()
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${editing.request_id}`} onClose={onClose} wide>
      {editing?.qa_request && (
        <p className="muted small" style={{ marginTop: -8 }}>
          Auto-created from QA Request {editing.qa_request.request_id} — the target URL below is a
          placeholder; replace it with the real one before the security team picks this up.
        </p>
      )}
      <p className="muted small" style={{ marginTop: -4 }}>
        Target Release Date: {editing.target_release_date || 'not set'} (set on the QA Request itself —
        no separate one here).
      </p>
      <form onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title">Classification</div>
          <div className="form-row">
            <Field label="Risk Category">
              <select value={riskCategory} onChange={(e) => setRiskCategory(e.target.value)} style={{ maxWidth: 200 }}>
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ maxWidth: 200 }}>
                {PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Targets *</div>
          <RepeatableRows
            rows={targets}
            blankRow={blankDastTarget}
            onChange={setTargets}
            renderRow={(row, setField) => (
              <>
                <input
                  required
                  placeholder="Application URL"
                  value={row.application_url}
                  onChange={(e) => setField('application_url', e.target.value)}
                  style={{ flex: 2, minWidth: 200 }}
                />
                <select
                  value={row.environment}
                  onChange={(e) => setField('environment', e.target.value)}
                  style={{ flex: 1, minWidth: 130 }}
                >
                  <option value="">Select environment...</option>
                  {ENVIRONMENTS.map((e_) => <option key={e_} value={e_}>{e_}</option>)}
                </select>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
                  <input
                    type="checkbox"
                    checked={row.authentication_required}
                    onChange={(e) => setField('authentication_required', e.target.checked)}
                  />
                  <span className="small">Auth required</span>
                </label>
                {row.authentication_required && (
                  <input
                    required
                    placeholder="Test Credentials *"
                    value={row.test_credentials}
                    onChange={(e) => setField('test_credentials', e.target.value)}
                    style={{ flex: 2, minWidth: 160 }}
                  />
                )}
              </>
            )}
          />
          <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
            Click "+" to add another target URL if this project spans more than one.
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
            <div className="security-checklist-table" role="group" aria-label="DAST readiness checklist">
              <div className="security-checklist-header" aria-hidden="true">
                <span>Ready</span>
                <span>Readiness criterion</span>
                <span>Supporting evidence</span>
              </div>
              {editing.checklist_items.map((c) => {
                const checked = checkedItems.includes(c.item)
                const checkboxId = `dast-edit-checklist-${c.id}`
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
                    <ChecklistEvidence apiBase="/api/dast-requests" reqId={editing.id} itemId={c.id}
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

// Derived from SAST_DAST_PENDING_WITH (constants.ts, shared with SAST -- DAST
// mirrors SAST's status/role flow exactly) rather than a hand-rolled status
// list, so this can never drift out of sync with the list's own "Pending
// With" column or the backend require_roles()/_require_assigned_security_analyst()
// gates in sast_dast.py. Only labels naming an actual role-holding group get
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

function DASTDetail({ req, onClose, onChanged, users }: {
  req: DASTOut; onClose: () => void; onChanged: (d: DASTOut) => void; users: UserOut[]
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
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments('/api/dast-requests', req.id)
  const navigate = useNavigate()
  const [showStartScan, setShowStartScan] = useState(false)
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
  // the DAST-side counterpart to Suppression.tsx's own Relink control.
  const [showLinkSuppression, setShowLinkSuppression] = useState(false)
  const [scanError, setScanError] = useState<unknown>(null)
  const [scanNotice, setScanNotice] = useState('')
  const [scanResults, setScanResults] = useState<SecurityScanResultOut[]>([])
  const [scanSummary, setScanSummary] = useState<SecurityScanSummaryOut | null>(null)

  const load = useCallback(async () => {
    try {
      setHistory(await api.get<ApprovalActionOut[]>(`/api/dast-requests/${req.id}/history`))
    } catch (err) { setError(err) }
  }, [req.id])

  useEffect(() => { load() }, [load])
  const loadScan = useCallback(() => {
    api.get<SecurityScanResultOut[]>(`/api/dast-requests/${req.id}/scan-results`).then(setScanResults).catch(() => setScanResults([]))
    api.get<SecurityScanSummaryOut>(`/api/dast-requests/${req.id}/scan-summary`).then(setScanSummary).catch(() => setScanSummary(null))
  }, [req.id])
  useEffect(() => { loadScan() }, [loadScan])
  useEffect(() => { setReassignAnalystReason('') }, [req.id, req.security_analyst_id])

  async function toggleChecklistItem(item: ChecklistItemOut) {
    setError(null)
    try {
      const saved = await api.put<ChecklistItemOut>(`/api/dast-requests/${req.id}/checklist/${item.id}`, { is_complete: !item.is_complete })
      setChecklist((rows) => rows.map((r) => (r.id === saved.id ? saved : r)))
    } catch (err) { setError(err) }
  }

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    const isReadinessPass = action === 'readiness-decision' && extra?.decision === 'Passed'
    if (isReadinessPass) setReadinessPassError(null)
    setBusy(true)
    try {
      const updated = await api.post<DASTOut>(`/api/dast-requests/${req.id}/${action}`, extra || {})
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
      const response = await api.post<{ request: DASTOut; scan_result: SecurityScanResultOut }>(`/api/dast-requests/${req.id}/start-scan`, {
        application_name: applicationName, application_version: applicationVersion,
      })
      onChanged(response.request)
      setShowStartScan(false)
      setTab('findings')
      setScanNotice('Scan validated successfully. Fortify SSC findings were imported and are shown below.')
      await loadScan()
      await load()
    } catch (err) { setScanError(err) } finally { setBusy(false) }
  }
  // 2026-08 "Findings Validation" doc -- Rescan re-imports the latest
  // Fortify SSC results as a brand-new scan record (see backend
  // _rescan_scan/_import_scan_result); it no longer asks a manual
  // Passed/Failed question -- the real findings count drives everything.
  async function rescan(applicationName: string, applicationVersion: string) {
    setBusy(true); setScanError(null)
    try {
      const response = await api.post<{ request: DASTOut; scan_result: SecurityScanResultOut }>(`/api/dast-requests/${req.id}/rescan`, {
        application_name: applicationName, application_version: applicationVersion,
      })
      onChanged(response.request)
      setShowRescan(false)
      loadScan()
      await load()
    } catch (err) { setScanError(err) } finally { setBusy(false) }
  }
  // Reported directly: full "SAST/DAST Request Workflow Requirement" doc
  // pasted with a status-flow diagram -- Mark Scan Complete's own button was
  // retired from the Findings tab in favor of Validate Findings (see
  // canValidateFindings below) -- the backend endpoint (_mark_scan_complete)
  // is left in place, unused, matching this file's existing convention for
  // superseded-but-not-deleted legacy actions.
  async function validateFindings() {
    const updated = await act('validate-findings')
    if (!updated) return
    setTab('findings')
    setScanNotice(updated.status === 'WAITING_FOR_FIX'
      ? 'Findings validated successfully. Open findings were automatically assigned to the requester for remediation.'
      : 'Findings validated successfully. No unresolved finding requires requester action.')
    await loadScan()
  }
  // Deep-links into the Suppression module with this request pre-selected --
  // see Suppression.tsx's newRequestPrefill/NewSuppressionModal initialRequest.
  function initiateSuppression() {
    navigate(`/suppression?new=1&scan_type=DAST&request_id=${req.id}`)
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

  // Edit access -- see the matching (and more detailed) comment in
  // SAST.tsx's canEditDetails for the full reasoning; same rule here.
  // SM_REJECTED included alongside the RETURNED_BY_* statuses -- reported
  // directly, a rejected request is now reopenable (edit + resubmit)
  // instead of a dead end.
  const isActiveDelegate = req.active_delegation?.status === 'ACTIVE' && req.active_delegation.assigned_to_id === user?.id
  const requesterInputEditor = isActiveDelegate || isAdmin || (isRequester && !req.active_delegation)
  const canEditDetails = hasRole(user, 'ADMIN')
    || (requesterInputEditor && ['DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status))
    || (hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && sameDept)
    || (hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && sameDept)
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && !req.active_delegation && ['RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status)
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
  // 2026-08 Reassignment CR -- see SAST.tsx's identical comment for the
  // full reasoning, including the later QA_LEAD carve-out. Mirrors
  // sast_dast.py's _require_can_reassign_security_analyst exactly.
  const isQADepartmentHead = isAdmin || (hasRole(user, 'CHIEF_MANAGER_QA', 'AGM_QA') && hasDepartment(user, QA_DEPARTMENT))
  const canReassignSecurityAnalyst = isAssignedAnalyst || isQADepartmentHead || hasRole(user, 'QA_LEAD')
  const canAssignSecurityAnalyst =
    (isInitialAnalystAssignment ? isAssignedQALead : canReassignSecurityAnalyst) &&
    SAST_DAST_ANALYST_REASSIGNABLE_STATUSES.includes(status)
  const canStartScan = isAssignedAnalyst && status === 'CONFIGURATION'
  // 2026-08 "Findings Validation" doc restoration -- Finding Validation is
  // once again a mandatory, explicit gate rather than a bypassed status.
  // Three separate turn-based gates, mirroring routers/sast_dast.py's
  // rewritten _validate_findings/_assign_to_requester/_rescan_scan exactly:
  // the assigned analyst validates findings from SCANNING, assigns to the
  // requester from REMEDIATION (only reachable once findings were found),
  // and rescans only once genuinely reassigned back (RESCAN).
  const canValidateFindings = isAssignedAnalyst && status === 'SCANNING'
  const canAssignToRequester = isAssignedAnalyst && status === 'REMEDIATION'
  const canRescan = isAssignedAnalyst && status === 'RESCAN'
  // Reported directly: "suppression requests CAN ONLY be raised by
  // requester, so this should be enable for requester, not QA team." --
  // Initiate Suppression Request is the requester's own action. Narrowed to
  // WAITING_FOR_FIX only (2026-08 doc Section 4: "After reviewing the
  // findings, the requester may choose...") -- consistent with the
  // above analyst-side gates now being turn-specific rather than spanning
  // the whole active-scan window.
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
  // Reported directly (bug): "Supression request is now rejected, but
  // still user not able to create supression request." Rejected must NOT
  // block Initiate Suppression Request or _mark_fixed's pending-suppression
  // guard, so this excludes both SUPPRESSION_TERMINAL_STATUSES (Done AND
  // Rejected), not just Done.
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
  // Report Ready -> Closed. Usually reached automatically as part of the
  // Complete Scan/Rescan "no findings" confirmation, but this manual action
  // covers the case where that auto-chain stopped at Report Ready's
  // suppression gate and the analyst needs to finish the last hop themselves
  // once the linked suppression(s) are Done.
  const canCloseRequest = isAssignedAnalyst && status === 'REPORT_READY'

  return (
    <Modal title={`${req.request_id}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'checklist', 'targets', 'findings', 'documents', 'history'].map((t) => (
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
                Positive request has ever been raised against this DAST request,
                and if so, which one(s) (see backend models.DASTRequest.suppressions). */}
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
            {/* Label normalized to "Application Name" (was "Application") to
                match the other 3 request types, and given the same pending/
                rejected badges as SAST/Functional/Performance/the QA Request
                gateway -- previously only visible via the Status section's
                generic badges, disconnected from the actual field. */}
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

          <DetailSection title="Environment & Release">
            <DetailField label="Deployment Environment">{req.deployment_environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
            {/* Target Release Date is collected once, on the QA Request itself --
                shown here as a read-only reference rather than a separate field. */}
            <DetailField label="Target Release Date">{req.target_release_date || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
            <DetailField label="Assigned Group">{(() => {
              const assigned = assignedGroupFor(req.status, req.application_master_status, req.department)
              return assigned ? <RoleGroupLink users={users} role={assigned.role} label={assigned.label} department={assigned.department} /> : '—'
            })()}</DetailField>
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
              <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/dast-requests/${req.id}/export`, `${req.request_id}.pdf`)}>
                Export PDF
              </button>
              {canEditDetails && <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(true)}>Edit Details</button>}
              <RequestDelegation
                targetType="DAST"
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
              {/* Validate Findings / Assign to Requester / Mark Fixed all live
                  in the Findings tab now (SecurityScanResults, section 4.4) --
                  reported directly, see canValidateFindings above. */}
              {canMarkReportReady && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('mark-report-ready')}>Mark Report Ready</button>}
              {canCloseRequest && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('close')}>Close Request</button>}
            </div>
          </div>

          {editing && (
            <DASTFormModal
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
              <ChecklistEvidence apiBase="/api/dast-requests" reqId={req.id} itemId={c.id}
                canManage={canManageReadinessEvidence(req.status, evidenceOwner)}
                required={c.is_mandatory || c.requester_checked}
                documents={documentsByItem[c.id] || []}
                onReload={reloadEvidence}
                checked={c.requester_checked} />
            </div>
          ))}
        </div>
      )}

      {tab === 'targets' && (
        <div>
          <Table rowKey="id" columns={DAST_TARGET_COLUMNS} rows={req.targets} />
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
              Status, backed by req.findings -- DASTFinding rows) is removed
              -- reported directly. It always showed "No records found."
              since manual "Log Finding" entry was removed (findings come
              from the DAST API); SecurityScanResults above is the real,
              live findings view now. */}
          <SecurityScanResults
            kind="DAST"
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

      {tab === 'documents' && <RequestDocuments apiBase="/api/dast-requests" reqId={req.id} canManage={canManageDocuments} />}

      {tab === 'history' && (
        <JiraActivity entityType="DAST" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
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
      {showStartScan && <SecurityScanDialog kind="DAST" initialApplicationName={req.application_name} busy={busy} error={scanError} onClose={() => setShowStartScan(false)} onStart={startScan} />}
      {showRescan && (
        <SecurityScanDialog
          kind="DAST" mode="rescan"
          initialApplicationName={scanResults[0]?.application_name || req.application_name}
          initialApplicationVersion={scanResults[0]?.application_version}
          busy={busy} error={scanError}
          onClose={() => setShowRescan(false)}
          onStart={rescan}
        />
      )}
      {showLinkSuppression && (
        <LinkSuppressionModal
          kind="DAST"
          requestId={req.id}
          requestLabel={req.request_id}
          onClose={() => setShowLinkSuppression(false)}
          onLinked={async () => {
            setShowLinkSuppression(false)
            onChanged(await api.get<DASTOut>(`/api/dast-requests/${req.id}`))
            await load()
          }}
        />
      )}
    </Modal>
  )
}

export default function DAST() {
  // SRS 7.2 PAG-006 -- the list only ever holds the lightweight DASTListOut
  // shape; opening a request fetches the full DASTOut record fresh via
  // GET /api/dast-requests/{id} before DASTDetail (which needs every field,
  // including unmasked test_credentials where authorized) is shown.
  const [selected, setSelected] = useState<DASTOut | null>(null)
  const [openingId, setOpeningId] = useState<number | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const [assignedOnly, setAssignedOnly] = useState(false)

  const {
    items: rows, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading, setPage, setPageSize, reload,
  } = usePaginatedList<DASTListOut>('/api/dast-requests', {
    extra: { assigned_to_me: assignedOnly ? 'true' : undefined },
  })

  useEffect(() => {
    // Full user list -- not just security analysts -- so both the Security
    // Lead assignment dropdown and the "Requester" field on the detail view
    // can resolve names from a single fetch.
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names/dropdown just stay empty */ })
  }, [])

  const openRequest = useCallback(async (idOrRow: number | DASTListOut) => {
    const id = typeof idOrRow === 'number' ? idOrRow : idOrRow.id
    setOpeningId(id)
    try {
      setSelected(await api.get<DASTOut>(`/api/dast-requests/${id}`))
    } catch (err) { setError(err) } finally { setOpeningId(null) }
  }, [])

  // Deep-link support -- see the matching effect in Functional.tsx for the
  // full reasoning; the gateway's "Linked Requests" table opens a specific
  // DAST request here via `?open=<request_id>`.
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
        title="DAST Requests" count={total}
        subtitle="Dynamic Application Security Testing requests, from submission through findings and report clearance. Raised via a QA Request (include DAST in its request types)."
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
          { key: 'application_name', header: 'Application', render: (r) => r.application_name || '—' },
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
        <DASTDetail
          req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); reload() }}
          users={users}
        />
      )}
    </div>
  )
}
