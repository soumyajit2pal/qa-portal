import React, { useEffect, useState, useCallback } from 'react'
import { api } from '@qa-portal/shared/api'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, RepeatableGroupInput, RepeatableGroupField, RepeatableGroupRow, TableColumn, DetailSection, DetailField, RequestDocuments } from '@qa-portal/shared/components/Common'
import UserAssignSelect from '@qa-portal/shared/components/UserAssignSelect'
import { SEVERITIES, PRIORITIES, SAST_DAST_EDITABLE_STATUSES, SAST_DAST_STATUS_LABELS, hasRole } from '@qa-portal/shared/constants'
import { SASTOut, SASTComponentOut, UserOut, WalkthroughOut, ApprovalActionOut } from '@qa-portal/shared/types'

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
// which creates it with just application_name/project_name/cr_number/risk
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
    application_name: editing.application_name || '', project_name: editing.project_name || '',
    cr_number: editing.cr_number || '',
    components: toRows(editing.components),
    risk_category: editing.risk_category || 'Medium', priority: editing.priority || 'Medium',
    hash_value: editing.hash_value || '',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }

  function formError(): string | null {
    const missing: string[] = []
    if (!form.application_name.trim()) missing.push('Application Name')
    if (!form.project_name.trim()) missing.push('Project Name')
    if (!form.cr_number.trim()) missing.push('CR Number')
    if (!form.hash_value.trim()) missing.push('SHA256/MD5 Hash')
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
          Application Name, Project Name and CR Number are locked once this request has been raised --
          only an Administrator can change them.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title">Identity{!isAdmin ? ' (Admin-only)' : ''}</div>
          <div className="form-row">
            <Field label="Application Name *"><input required disabled={!isAdmin} value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
            <Field label="Project Name *"><input required disabled={!isAdmin} value={form.project_name} onChange={(e) => set('project_name', e.target.value)} /></Field>
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
            <Field label="SHA256/MD5 Hash *"><input required value={form.hash_value} onChange={(e) => set('hash_value', e.target.value)} /></Field>
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
  const [requireDeptHeadReapproval, setRequireDeptHeadReapproval] = useState(false)
  const [busy, setBusy] = useState(false)
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])

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

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try { onChanged(await api.post<SASTOut>(`/api/sast-requests/${req.id}/${action}`, extra || {})) }
    catch (err) { setError(err) } finally { setBusy(false) }
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

  const isRequester = req.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = req.status
  // Department-scoped, same as QA Request's SM/Dept Head steps -- see the
  // comment in QARequests.tsx. Doesn't apply to the QA-side steps below.
  const sameDept = !!user?.department && user.department === req.department

  const canEditDetails = (isRequester || hasRole(user, 'SECURITY_ANALYST')) && SAST_DAST_EDITABLE_STATUSES.includes(status)
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD'].includes(status)
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canStartReadiness = hasRole(user, 'SECURITY_ANALYST', 'QA_LEAD') && status === 'SECURITY_LEAD_ASSIGNED'
  const canReadinessDecide = hasRole(user, 'QA_LEAD', 'SECURITY_ANALYST') && status === 'SECURITY_READINESS'
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
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'repository', 'findings', 'walkthroughs', 'documents', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'findings' ? `Findings (${req.findings.length})` : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
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
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Project">{req.project_name || '—'}</DetailField>
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
              {canSubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('submit')}>Submit for SM Approval</button>}
              {canResubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('resubmit')}>Re-submit</button>}

              {canSMDecide && (
                <ApprovalDecisionButtons
                  userName={user?.full_name}
                  comments={comments}
                  busy={busy}
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
                  <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('readiness-decision', { decision: 'Passed', comments })}>Readiness Passed</button>
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
            <SASTFormModal
              editing={req}
              onClose={() => setEditing(false)}
              onSaved={(saved) => { setEditing(false); onChanged(saved) }}
            />
          )}
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
