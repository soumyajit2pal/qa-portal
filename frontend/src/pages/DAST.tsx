import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader } from '../components/Common'
import { SEVERITIES, ENVIRONMENTS, SAST_DAST_EDITABLE_STATUSES, SAST_DAST_STATUS_LABELS, hasRole } from '../constants'
import { DASTOut } from '../types'

// Standalone DAST request creation is DISABLED per request -- a DAST request
// can now only come into being by including "DAST" in a QA Request's request
// types (see backend routers/qa_requests.py::_sync_linked_security_requests),
// which creates it with a placeholder application_url. This modal is
// therefore edit-only now: it fills in the real target URL / environment /
// credentials on that auto-created request -- see canEditDetails in
// DASTDetail below.
function DASTFormModal({ onClose, onSaved, editing }: { onClose: () => void; onSaved: (d: DASTOut) => void; editing: DASTOut }) {
  const [form, setForm] = useState({
    application_url: editing.application_url || '', environment: editing.environment || 'UAT',
    authentication_required: editing.authentication_required || false,
    test_credentials: '', target_release: editing.target_release || '',
    risk_category: editing.risk_category || 'Medium',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const saved = await api.put<DASTOut>(`/api/dast-requests/${editing.id}`, form)
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
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Application URL *"><input required value={form.application_url} onChange={(e) => set('application_url', e.target.value)} /></Field>
          <Field label="Environment">
            <select value={form.environment} onChange={(e) => set('environment', e.target.value)}>
              {ENVIRONMENTS.map((e_) => <option key={e_} value={e_}>{e_}</option>)}
            </select>
          </Field>
          <Field label="Target Release"><input value={form.target_release} onChange={(e) => set('target_release', e.target.value)} /></Field>
          <Field label="Risk Category">
            <select value={form.risk_category} onChange={(e) => set('risk_category', e.target.value)}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Authentication Required">
            <select value={form.authentication_required ? 'yes' : 'no'} onChange={(e) => set('authentication_required', e.target.value === 'yes')}>
              <option value="no">No</option><option value="yes">Yes</option>
            </select>
          </Field>
          <Field label="Test Credentials"><input value={form.test_credentials} onChange={(e) => set('test_credentials', e.target.value)} /></Field>
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

function DASTDetail({ req, onClose, onChanged }: { req: DASTOut; onClose: () => void; onChanged: (d: DASTOut) => void }) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [finding, setFinding] = useState({ issue_id: '', severity: 'Medium', description: '' })
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState('')
  const [busy, setBusy] = useState(false)

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

  const isRequester = req.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = req.status

  const canEditDetails = (isRequester || hasRole(user, 'SECURITY_ANALYST')) && SAST_DAST_EDITABLE_STATUSES.includes(status)
  const canSubmit = isRequester && status === 'Requested'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD'].includes(status)
  // Department-scoped, same as QA Request's SM/Dept Head steps -- see the
  // comment in QARequests.tsx. Doesn't apply to the QA-side steps below.
  const sameDept = !!user?.department && user.department === req.department
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canReadinessDecide = hasRole(user, 'QA_LEAD', 'SECURITY_ANALYST') && status === 'READINESS_CHECK'
  const canStartScan = hasRole(user, 'SECURITY_ANALYST') && status === 'Allocated'
  const canMarkFixed = (isRequester || hasRole(user, 'SECURITY_ANALYST')) && status === 'WAITING_FOR_FIX'
  const canAddFinding = hasRole(user, 'SECURITY_ANALYST') && status === 'Scanning'
  const canMarkSecurityComplete = hasRole(user, 'SECURITY_ANALYST') && status === 'Scanning'
  const canMarkReportReady = hasRole(user, 'SECURITY_ANALYST') && status === 'SECURITY_COMPLETE'

  return (
    <Modal title={`${req.request_id}`} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>URL:</strong> {req.application_url}</div>
        <div><strong>Status:</strong> <Badge status={status} /> <span className="muted small">{SAST_DAST_STATUS_LABELS[status] || status}</span></div>
        <div><strong>Environment:</strong> {req.environment}</div>
        <div><strong>Risk:</strong> {req.risk_category}</div>
      </div>
      {req.qa_request && (
        <p className="muted small">Linked from QA Request {req.qa_request.request_id}.</p>
      )}

      <div className="section-title">Workflow Actions</div>
      <Field label="Comments (used by the next action below)">
        <input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional comments..." />
      </Field>
      <div style={{ display: 'flex', gap: 8, margin: '10px 0', flexWrap: 'wrap' }}>
        {canEditDetails && <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(true)}>Edit Details</button>}
        {canSubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('submit')}>Submit for SM Approval</button>}
        {canResubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('resubmit')}>Re-submit</button>}

        {canSMDecide && (
          <>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('sm-decision', { decision: 'Approved', comments })}>Approve</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => act('sm-decision', { decision: 'Returned', comments })}>Return to Requester</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('sm-decision', { decision: 'Rejected', comments })}>Reject</button>
          </>
        )}
        {canDeptHeadDecide && (
          <>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('department-head-decision', { decision: 'Approved', comments })}>Approve</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => act('department-head-decision', { decision: 'Returned', comments })}>Return to Requester</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('department-head-decision', { decision: 'Rejected', comments })}>Reject</button>
          </>
        )}
        {canReadinessDecide && (
          <>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('readiness-decision', { decision: 'Passed', comments })}>Readiness Passed</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('readiness-decision', { decision: 'Failed', comments })}>Readiness Failed</button>
          </>
        )}
        {canStartScan && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('start-scan')}>Start Scan</button>}
        {canMarkFixed && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('mark-fixed')}>Mark Fixed (Rescan)</button>}
        {canMarkSecurityComplete && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('mark-security-complete')}>Mark Security Complete</button>}
        {canMarkReportReady && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('mark-report-ready')}>Mark Report Ready</button>}
      </div>

      {editing && (
        <DASTFormModal
          editing={req}
          onClose={() => setEditing(false)}
          onSaved={(saved) => { setEditing(false); onChanged(saved) }}
        />
      )}
      <div className="section-title">Findings Repository ({req.findings.length})</div>
      <Table rowKey="id" columns={[
        { key: 'issue_id', header: 'Issue ID' },
        { key: 'severity', header: 'Severity' },
        { key: 'description', header: 'Description' },
        { key: 'status', header: 'Status' },
        { key: 'actions', header: '', render: (f) => (
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
          <button className="btn btn-sm">Log Finding (marks Waiting For Fix)</button>
        </form>
      )}
    </Modal>
  )
}

export default function DAST() {
  const [rows, setRows] = useState<DASTOut[]>([])
  const [selected, setSelected] = useState<DASTOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try { setRows(await api.get<DASTOut[]>('/api/dast-requests')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="DAST Requests" count={rows.length}
        subtitle="Dynamic Application Security Testing requests, from submission through findings and report sign-off. Raised via a QA Request (include DAST in its request types) -- not created standalone here."
      />
      <Card>
        <Table rowKey="id" onRowClick={setSelected} columns={[
          { key: 'request_id', header: 'Request ID' },
          { key: 'application_url', header: 'Application URL' },
          { key: 'environment', header: 'Environment' },
          { key: 'risk_category', header: 'Risk' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          { key: 'findings', header: 'Findings', render: (r) => r.findings.length },
          { key: 'source', header: 'Source', render: (r) => (
            r.qa_request ? (
              <span className="badge badge-blue" title="Auto-created from a QA Request">
                Linked · {r.qa_request.request_id}
              </span>
            ) : <span className="badge badge-gray">Standalone (legacy)</span>
          ) },
        ]} rows={rows} />
      </Card>
      {selected && <DASTDetail req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} />}
    </div>
  )
}
