import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader } from '../components/Common'
import { SEVERITIES, hasRole } from '../constants'

// Standalone SAST request creation is DISABLED per request -- a SAST request
// can now only come into being by including "SAST" in a QA Request's request
// types (see backend routers/qa_requests.py::_sync_linked_security_requests),
// which creates it with just application_name/project_name/cr_number/risk
// populated. This modal is therefore edit-only now: it fills in the rest of
// the mandatory details (repository URL, branch, commit ID, tech stack,
// build number) on that auto-created request before the security team picks
// it up -- see canEditDetails in SASTDetail below.
function SASTFormModal({ onClose, onSaved, editing }) {
  const [form, setForm] = useState({
    application_name: editing.application_name || '', project_name: editing.project_name || '',
    cr_number: editing.cr_number || '', build_number: editing.build_number || '',
    repository_url: editing.repository_url || '', git_branch: editing.git_branch || '',
    commit_id: editing.commit_id || '', technology_stack: editing.technology_stack || '',
    risk_category: editing.risk_category || 'Medium', hash_value: editing.hash_value || '',
  })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const saved = await api.put(`/api/sast-requests/${editing.id}`, form)
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${editing.request_id}`} onClose={onClose} wide>
      {editing?.qa_request && (
        <p className="muted small" style={{ marginTop: -8 }}>
          Auto-created from QA Request {editing.qa_request.request_id} — fill in the real
          details below before the security team picks this up.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Application Name *"><input required value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
          <Field label="Project Name"><input value={form.project_name} onChange={(e) => set('project_name', e.target.value)} /></Field>
          <Field label="CR Number"><input value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
          <Field label="Build Number"><input value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
          <Field label="Repository URL"><input value={form.repository_url} onChange={(e) => set('repository_url', e.target.value)} /></Field>
          <Field label="Git Branch"><input value={form.git_branch} onChange={(e) => set('git_branch', e.target.value)} /></Field>
          <Field label="Commit ID"><input value={form.commit_id} onChange={(e) => set('commit_id', e.target.value)} /></Field>
          <Field label="Technology Stack"><input value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
          <Field label="Risk Category">
            <select value={form.risk_category} onChange={(e) => set('risk_category', e.target.value)}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="SHA256/MD5 Hash"><input value={form.hash_value} onChange={(e) => set('hash_value', e.target.value)} /></Field>
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

function SASTDetail({ req, onClose, onChanged }) {
  const { user } = useAuth()
  const [error, setError] = useState(null)
  const [finding, setFinding] = useState({ issue_id: '', severity: 'Medium', description: '' })
  const [editing, setEditing] = useState(false)

  async function decide(decision) {
    try { onChanged(await api.post(`/api/sast-requests/${req.id}/decision`, { decision })) }
    catch (err) { setError(err) }
  }
  async function addFinding(e) {
    e.preventDefault()
    try {
      await api.post(`/api/sast-requests/${req.id}/findings`, finding)
      const fresh = await api.get('/api/sast-requests')
      onChanged(fresh.find((r) => r.id === req.id))
      setFinding({ issue_id: '', severity: 'Medium', description: '' })
    } catch (err) { setError(err) }
  }
  async function close() {
    try { onChanged(await api.post(`/api/sast-requests/${req.id}/close`, {})) } catch (err) { setError(err) }
  }

  const canDecide = hasRole(user, 'SECURITY_ANALYST', 'APPLICATION_OWNER')
  const canEditDetails = (req.requester_id === user.id || hasRole(user, 'SECURITY_ANALYST'))
    && req.status === 'Requested'

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>Status:</strong> <Badge status={req.status} /></div>
        <div><strong>Risk:</strong> {req.risk_category}</div>
        <div><strong>Build:</strong> {req.build_number || '—'}</div>
        <div><strong>Branch/Commit:</strong> {req.git_branch || '—'} / {req.commit_id || '—'}</div>
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
        <SASTFormModal
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

export default function SAST() {
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setRows(await api.get('/api/sast-requests')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="SAST Requests" count={rows.length}
        subtitle="Static Application Security Testing requests, from submission through findings and report sign-off. Raised via a QA Request (include SAST in its request types) -- not created standalone here."
      />
      <Card>
        <Table rowKey="id" onRowClick={setSelected} columns={[
          { key: 'request_id', header: 'Request ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'build_number', header: 'Build' },
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
      {selected && <SASTDetail req={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} />}
    </div>
  )
}
