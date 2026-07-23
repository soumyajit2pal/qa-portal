import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader } from '../components/Common'
import { SEVERITIES, ENVIRONMENTS, hasRole } from '../constants'

// Standalone DAST request creation is DISABLED per request -- a DAST request
// can now only come into being by including "DAST" in a QA Request's request
// types (see backend routers/qa_requests.py::_sync_linked_security_requests),
// which creates it with a placeholder application_url. This modal is
// therefore edit-only now: it fills in the real target URL / environment /
// credentials on that auto-created request -- see canEditDetails in
// DASTDetail below.
function DASTFormModal({ onClose, onSaved, editing }) {
  const [form, setForm] = useState({
    application_url: editing.application_url || '', environment: editing.environment || 'UAT',
    authentication_required: editing.authentication_required || false,
    test_credentials: editing.test_credentials || '', target_release: editing.target_release || '',
    risk_category: editing.risk_category || 'Medium',
  })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const saved = await api.put(`/api/dast-requests/${editing.id}`, form)
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
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : (editing ? 'Save Changes' : 'Submit Request')}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function DASTDetail({ req, onClose, onChanged }) {
  const { user } = useAuth()
  const [error, setError] = useState(null)
  const [finding, setFinding] = useState({ issue_id: '', severity: 'Medium', description: '' })
  const [editing, setEditing] = useState(false)

  async function decide(decision) {
    try { onChanged(await api.post(`/api/dast-requests/${req.id}/decision`, { decision })) } catch (err) { setError(err) }
  }
  async function addFinding(e) {
    e.preventDefault()
    try {
      await api.post(`/api/dast-requests/${req.id}/findings`, finding)
      const fresh = await api.get('/api/dast-requests')
      onChanged(fresh.find((r) => r.id === req.id))
      setFinding({ issue_id: '', severity: 'Medium', description: '' })
    } catch (err) { setError(err) }
  }
  async function close() {
    try { onChanged(await api.post(`/api/dast-requests/${req.id}/close`, {})) } catch (err) { setError(err) }
  }

  const canDecide = hasRole(user, 'SECURITY_ANALYST', 'APPLICATION_OWNER')
  const canEditDetails = (req.requester_id === user.id || hasRole(user, 'SECURITY_ANALYST'))
    && req.status === 'Requested'

  return (
    <Modal title={`${req.request_id}`} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>URL:</strong> {req.application_url}</div>
        <div><strong>Status:</strong> <Badge status={req.status} /></div>
        <div><strong>Environment:</strong> {req.environment}</div>
        <div><strong>Risk:</strong> {req.risk_category}</div>
      </div>
      {req.qa_request && (
        <p className="muted small">Linked from QA Request {req.qa_request.request_id}.</p>
      )}
      <div style={{ display: 'flex', gap: 8, margin: '10px 0', flexWrap: 'wrap' }}>
        {canEditDetails && <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit Details</button>}
        {canDecide && !['Report Ready', 'Closed'].includes(req.status) && (
          <>
            <button className="btn btn-success btn-sm" onClick={() => decide('Approved')}>Approve / Progress</button>
            <button className="btn btn-danger btn-sm" onClick={() => decide('Rejected')}>Reject</button>
          </>
        )}
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
      ]} rows={req.findings} />
      {hasRole(user, 'SECURITY_ANALYST') && (
        <form onSubmit={addFinding} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input placeholder="Issue ID" value={finding.issue_id} onChange={(e) => setFinding((f) => ({ ...f, issue_id: e.target.value }))} />
          <select value={finding.severity} onChange={(e) => setFinding((f) => ({ ...f, severity: e.target.value }))}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input placeholder="Description" value={finding.description} onChange={(e) => setFinding((f) => ({ ...f, description: e.target.value }))} />
          <button className="btn btn-sm">Add Finding</button>
          {req.status !== 'Report Ready' && <button type="button" className="btn btn-sm" onClick={close}>Mark Report Ready</button>}
        </form>
      )}
    </Modal>
  )
}

export default function DAST() {
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setRows(await api.get('/api/dast-requests')) } catch (err) { setError(err) }
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
