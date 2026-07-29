import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, RepeatableRows, TableColumn, DetailSection, DetailField, RequestDocuments } from '../../components/Common'
import { ApplicationNameBanner } from '../../components/ApplicationNameBanner'
import UserAssignSelect from '../../components/UserAssignSelect'
import { SEVERITIES, PRIORITIES, ENVIRONMENTS, SAST_DAST_EDITABLE_STATUSES, SAST_DAST_STATUS_LABELS, hasRole } from '../../constants'
import { DASTOut, DASTTargetOut, ChecklistItemOut, UserOut, WalkthroughOut, ApprovalActionOut } from '../../types'

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
function DASTFormModal({ onClose, onSaved, editing }: { onClose: () => void; onSaved: (d: DASTOut) => void; editing: DASTOut }) {
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

function DASTDetail({ req, onClose, onChanged, securityAnalysts, users }: {
  req: DASTOut; onClose: () => void; onChanged: (d: DASTOut) => void; securityAnalysts: UserOut[]; users: UserOut[]
}) {
  const { user } = useAuth()
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState<unknown>(null)
  const [finding, setFinding] = useState({ issue_id: '', severity: 'Medium', description: '' })
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [selectedLead, setSelectedLead] = useState('')
  const [requireDeptHeadReapproval, setRequireDeptHeadReapproval] = useState(false)
  const [busy, setBusy] = useState(false)
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [checklist, setChecklist] = useState<ChecklistItemOut[]>(req.checklist_items || [])
  useEffect(() => { setChecklist(req.checklist_items || []) }, [req])

  const load = useCallback(async () => {
    try {
      const [wt, hist] = await Promise.all([
        api.get<WalkthroughOut[]>(`/api/dast-requests/${req.id}/walkthroughs`),
        api.get<ApprovalActionOut[]>(`/api/dast-requests/${req.id}/history`),
      ])
      setWalkthroughs(wt); setHistory(hist)
    } catch (err) { setError(err) }
  }, [req.id])

  useEffect(() => { load() }, [load])

  async function toggleChecklistItem(item: ChecklistItemOut) {
    setError(null)
    try {
      const saved = await api.put<ChecklistItemOut>(`/api/dast-requests/${req.id}/checklist/${item.id}`, { is_complete: !item.is_complete })
      setChecklist((rows) => rows.map((r) => (r.id === saved.id ? saved : r)))
    } catch (err) { setError(err) }
  }

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try { onChanged(await api.post<DASTOut>(`/api/dast-requests/${req.id}/${action}`, extra || {})) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }
  async function addFinding(e: React.FormEvent) {
    e.preventDefault()
    try {
      await api.post(`/api/dast-requests/${req.id}/findings`, finding)
      const fresh = await api.get<DASTOut[]>('/api/dast-requests')
      const updated = fresh.find((r) => r.id === req.id)
      if (updated) onChanged(updated)
      setFinding({ issue_id: '', severity: 'Medium', description: '' })
    } catch (err) { setError(err) }
  }
  async function resolveFinding(findingId: number) {
    try {
      await api.post(`/api/dast-requests/${req.id}/findings/${findingId}/resolve`, {})
      const fresh = await api.get<DASTOut[]>('/api/dast-requests')
      const updated = fresh.find((r) => r.id === req.id)
      if (updated) onChanged(updated)
    } catch (err) { setError(err) }
  }

  // After an SM approves/rejects this request's Application Name (see
  // ApplicationNameBanner below) -- same "refetch the list, find this one"
  // pattern as resolveFinding above, since there's no single-item GET
  // endpoint for a DAST request.
  async function reloadAfterApplicationNameDecision() {
    const fresh = await api.get<DASTOut[]>('/api/dast-requests')
    const updated = fresh.find((r) => r.id === req.id)
    if (updated) onChanged(updated)
  }

  const isRequester = req.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = req.status
  const sameDept = !!user?.department && user.department === req.department

  // Editing is a business-side (requester/SM/Department Head) concern, not
  // Security's -- see the matching backend comment on update_dast. SM/
  // Department Head editing is their own recourse after actually reviewing
  // and returning the request -- while it's still a plain DRAFT (not yet
  // even submitted), only the requester/admin may edit.
  const canEditDetails = (isRequester || hasRole(user, 'ADMIN') || (hasRole(user, 'SM', 'DEPARTMENT_HEAD') && sameDept && status !== 'DRAFT'))
    && SAST_DAST_EDITABLE_STATUSES.includes(status)
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status)
  // Blocks Sign/Approve on both the SM and Department Head decision panels
  // below while this request's Application Name is still PENDING/REJECTED
  // (not yet APPROVED) -- see ApplicationNameBanner.
  const applicationNameBlocking = !!req.application_master_status && req.application_master_status !== 'APPROVED'
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
  const canAddFinding = hasRole(user, 'SECURITY_ANALYST') && status === 'SCANNING'
  const canCompleteScan = hasRole(user, 'SECURITY_ANALYST') && status === 'SCANNING'
  const canValidateFindings = hasRole(user, 'SECURITY_ANALYST') && status === 'FINDING_VALIDATION'
  const canAssignToRequester = hasRole(user, 'SECURITY_ANALYST') && status === 'REMEDIATION'
  const canMarkFixed = (isRequester || hasRole(user, 'SECURITY_ANALYST')) && status === 'WAITING_FOR_FIX'
  const canRescanDecide = hasRole(user, 'SECURITY_ANALYST') && status === 'RESCAN'
  const canMarkReportReady = hasRole(user, 'SECURITY_ANALYST') && status === 'SECURITY_COMPLETE'

  return (
    <Modal title={`${req.request_id}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'checklist', 'targets', 'findings', 'walkthroughs', 'documents', 'history'].map((t) => (
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
            <DetailField label="Created">{new Date(req.created_at).toLocaleString()}</DetailField>
            <DetailField label="Last Updated">{new Date(req.updated_at).toLocaleString()}</DetailField>
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Application">{req.application_name || '—'}</DetailField>
            <DetailField label="Epic Number">{req.epic_number || '—'}</DetailField>
            <DetailField label="CR Number">{req.cr_number || '—'}</DetailField>
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
              <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/dast-requests/${req.id}/export`, `${req.request_id}.pdf`)}>
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
                  extraControl={
                    <UserAssignSelect
                      value={selectedLead}
                      onChange={setSelectedLead}
                      users={securityAnalysts}
                      placeholder="Assign Security Lead..."
                      style={{ minWidth: 220 }}
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
                          onClick={() => act('readiness-decision', { decision: 'Failed', comments, require_dept_head_reapproval: requireDeptHeadReapproval })}>
                    Readiness Failed
                  </button>
                  <label className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={requireDeptHeadReapproval}
                           onChange={(e) => setRequireDeptHeadReapproval(e.target.checked)} />
                    Require Department Head re-approval on return
                  </label>
                </>
              )}
              {canReadinessDecide && pendingChecklistItems.length > 0 && (
                <p className="muted small" style={{ color: 'var(--danger, #c0392b)', width: '100%' }}>
                  {pendingChecklistItems.length} mandatory Security Readiness checklist item(s) still incomplete —
                  see the Checklist tab.
                </p>
              )}
              {canStartConfiguration && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-configuration')}>Start Configuration</button>}
              {canStartScan && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-scan')}>Start Scan</button>}
              {canCompleteScan && <button className="btn btn-sm" disabled={busy} onClick={() => act('complete-scan')}>Complete Scan</button>}
              {canValidateFindings && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('validate-findings')}>Validate Findings</button>}
              {canAssignToRequester && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('assign-to-requester')}>Assign to Requester</button>}
              {canMarkFixed && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('mark-fixed')}>Mark Fixed (send to Rescan)</button>}
              {canRescanDecide && (
                <>
                  <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('rescan-decision', { decision: 'Passed', comments })}>Rescan Passed</button>
                  <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('rescan-decision', { decision: 'Failed', comments })}>Rescan Failed</button>
                </>
              )}
              {canMarkReportReady && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('mark-report-ready')}>Mark Report Ready</button>}
            </div>
          </div>

          {editing && (
            <DASTFormModal
              editing={req}
              onClose={() => setEditing(false)}
              onSaved={(saved) => { setEditing(false); onChanged(saved) }}
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

      {tab === 'targets' && (
        <div>
          <Table rowKey="id" columns={DAST_TARGET_COLUMNS} rows={req.targets} />
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

      {tab === 'documents' && <RequestDocuments apiBase="/api/dast-requests" reqId={req.id} />}

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
      await api.post(`/api/dast-requests/${reqId}/walkthroughs`, { conducted_by, participants, notes })
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

export default function DAST() {
  const [rows, setRows] = useState<DASTOut[]>([])
  const [selected, setSelected] = useState<DASTOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const securityAnalysts = users.filter((u) => (u.roles || []).includes('SECURITY_ANALYST'))

  const load = useCallback(async () => {
    try { setRows(await api.get<DASTOut[]>('/api/dast-requests')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    // Full user list -- not just security analysts -- so both the Security
    // Lead assignment dropdown and the "Requester" field on the detail view
    // can resolve names from a single fetch.
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names/dropdown just stay empty */ })
  }, [])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="DAST Requests" count={rows.length}
        subtitle="Dynamic Application Security Testing requests, from submission through findings and report sign-off. Raised via a QA Request (include DAST in its request types) -- not created standalone here."
      />
      <Card>
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
          { key: 'request_id', header: 'Request ID' },
          { key: 'application_name', header: 'Application', render: (r) => r.application_name || '—' },
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
        <DASTDetail
          req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }}
          securityAnalysts={securityAnalysts} users={users}
        />
      )}
    </div>
  )
}
