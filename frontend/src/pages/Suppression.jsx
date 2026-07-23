import React, { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader } from '../components/Common'
import { SEVERITIES, hasRole } from '../constants'

const EMPTY_ITEM = { issue_id: '', severity: 'Medium', description: '', justification: '' }
const EMPTY_FORM = {
  scan_type: 'SAST', sast_request_id: null, dast_request_id: null,
  application_name: '', department: '', application_owner: '',
  risk_assessment: '', items: [{ ...EMPTY_ITEM }],
}

// Searchable "Request ID" autosuggest -- covers BOTH SAST and DAST requests
// together (each tagged with its _kind) so the requester doesn't have to
// pick a scan type before searching; selecting a match hands the full record
// back to the caller, which derives scan type from it and auto-populates
// Application Name / Department / Owner.
function RequestIdSearch({ requests, selected, onSelect, onClear }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => {
    function onDocClick(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  if (selected) {
    return (
      <div className="searchable-select">
        <div className="searchable-select-trigger" style={{ cursor: 'default' }}>
          <span>
            <span className={`badge ${selected._kind === 'SAST' ? 'badge-blue' : 'badge-yellow'}`} style={{ marginRight: 8 }}>{selected._kind}</span>
            {selected.request_id} — {selected.application_name || selected.application_url}
          </span>
          <button type="button" className="btn btn-sm" onClick={onClear}>Change</button>
        </div>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const matches = (q
    ? requests.filter((r) => r.request_id.toLowerCase().includes(q)
        || (r.application_name || r.application_url || '').toLowerCase().includes(q))
    : requests
  ).slice(0, 8)

  return (
    <div className="searchable-select" ref={boxRef}>
      <input
        placeholder="Search SAST or DAST Request ID or application..."
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
      />
      {open && (
        <div className="searchable-select-panel">
          <div className="searchable-select-list">
            {matches.length === 0 && <div className="searchable-select-empty">No SAST/DAST requests found.</div>}
            {matches.map((r) => (
              <div key={`${r._kind}-${r.id}`} className="searchable-select-option"
                   onClick={() => { onSelect(r); setQuery(''); setOpen(false) }}>
                <div>
                  <span className={`badge ${r._kind === 'SAST' ? 'badge-blue' : 'badge-yellow'}`} style={{ marginRight: 8 }}>{r._kind}</span>
                  {r.request_id} — {r.application_name || r.application_url}
                </div>
                {(r.department || r.application_owner) && (
                  <div className="muted small">{r.application_owner || '—'} &middot; {r.department || '—'}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function NewSuppressionModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [selectedRef, setSelectedRef] = useState(null)
  const [sastRequests, setSastRequests] = useState([])
  const [dastRequests, setDastRequests] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })) }

  useEffect(() => {
    Promise.all([api.get('/api/sast-requests'), api.get('/api/dast-requests')])
      .then(([sast, dast]) => { setSastRequests(sast); setDastRequests(dast) })
      .catch(() => { /* autosuggest is a convenience -- fields stay manually editable if this fails */ })
  }, [])

  // Searched together, not one-scan-type-at-a-time -- tag each so scan type
  // can be derived from whichever one gets picked, and the badge/label knows
  // which it was.
  const combinedRequests = [
    ...sastRequests.map((r) => ({ ...r, _kind: 'SAST' })),
    ...dastRequests.map((r) => ({ ...r, _kind: 'DAST' })),
  ]

  function selectRequest(r) {
    setSelectedRef(r)
    setForm((f) => ({
      ...f,
      scan_type: r._kind,
      application_name: r.application_name || r.application_url || '',
      department: r.department || '',
      application_owner: r.application_owner || '',
      sast_request_id: r._kind === 'SAST' ? r.id : null,
      dast_request_id: r._kind === 'DAST' ? r.id : null,
    }))
  }

  function clearRequest() {
    setSelectedRef(null)
    setForm((f) => ({ ...f, sast_request_id: null, dast_request_id: null, application_name: '', department: '', application_owner: '' }))
  }

  function setItem(idx, k, v) {
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, [k]: v } : it)) }))
  }
  function addItem() { setForm((f) => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] })) }
  function removeItem(idx) { setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) })) }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try { onCreated(await api.post('/api/suppressions', form)) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Suppression / False Positive Request" onClose={onClose} wide>
      <form onSubmit={submit}>
        <Field label="SAST / DAST Request ID *">
          <RequestIdSearch requests={combinedRequests} selected={selectedRef} onSelect={selectRequest} onClear={clearRequest} />
        </Field>

        <div className="form-row" style={{ marginTop: 12 }}>
          <Field label="Scan Type">
            <select value={form.scan_type} disabled={!!selectedRef} onChange={(e) => set('scan_type', e.target.value)}>
              <option value="SAST">SAST</option><option value="DAST">DAST</option>
            </select>
          </Field>
          <Field label="Application Name *">
            <input required value={form.application_name} disabled={!!selectedRef}
                   onChange={(e) => set('application_name', e.target.value)} />
          </Field>
          <Field label="Application Owner">
            <input value={form.application_owner} disabled={!!selectedRef}
                   onChange={(e) => set('application_owner', e.target.value)} />
          </Field>
          <Field label="Department">
            <input value={form.department} disabled={!!selectedRef}
                   onChange={(e) => set('department', e.target.value)} />
          </Field>
        </div>
        {!selectedRef && (
          <p className="muted small" style={{ marginTop: -8 }}>
            Pick a Request ID above to auto-fill Scan Type / Application Name / Owner / Department, or fill them in manually for a standalone finding.
          </p>
        )}

        <div className="form-section-title" style={{ marginTop: 18 }}>
          Findings to Suppress — one scan can cover several vulnerabilities; add a row per finding.
        </div>
        {form.items.map((item, idx) => (
          <div key={idx} className="card" style={{ padding: 12, marginBottom: 10, background: 'var(--bg)' }}>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <Field label="Issue ID"><input value={item.issue_id} onChange={(e) => setItem(idx, 'issue_id', e.target.value)} /></Field>
              <Field label="Severity">
                <select value={item.severity} onChange={(e) => setItem(idx, 'severity', e.target.value)}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Issue Description"><textarea value={item.description} onChange={(e) => setItem(idx, 'description', e.target.value)} /></Field>
            <Field label="Justification"><textarea value={item.justification} onChange={(e) => setItem(idx, 'justification', e.target.value)} /></Field>
            {form.items.length > 1 && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => removeItem(idx)} style={{ marginTop: 4 }}>Remove Finding</button>
            )}
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={addItem} style={{ marginBottom: 16 }}>+ Add Another Finding</button>

        <Field label="Risk Assessment & Acknowledgement (overall)">
          <textarea value={form.risk_assessment} onChange={(e) => set('risk_assessment', e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Submitting...' : 'Submit Request'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function SuppressionDetail({ sup, onClose, onChanged }) {
  const { user } = useAuth()
  const [error, setError] = useState(null)
  const [comments, setComments] = useState('')

  async function decide(step, decision) {
    try {
      const updated = await api.post(`/api/suppressions/${sup.id}/${step}`, { decision, comments })
      onChanged(updated)
    } catch (err) { setError(err) }
  }

  const linkedRequestId = sup.scan_type === 'SAST' ? sup.sast_request_id : sup.dast_request_id

  return (
    <Modal title={`${sup.suppression_id} — ${sup.application_name}`} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>Status:</strong> <Badge status={sup.status} /></div>
        <div><strong>Scan Type:</strong> {sup.scan_type}</div>
        <div><strong>Department:</strong> {sup.department || '—'}</div>
        <div><strong>Application Owner:</strong> {sup.application_owner || '—'}</div>
        <div><strong>App Owner Decision:</strong> {sup.app_owner_decision || 'Pending'}</div>
        <div><strong>Dept Head Decision:</strong> {sup.dept_head_decision || 'Pending'}</div>
      </div>

      <div className="section-title">Findings ({sup.items.length})</div>
      <Table rowKey="id" columns={[
        { key: 'issue_id', header: 'Issue ID', render: (i) => i.issue_id || '—' },
        { key: 'severity', header: 'Severity' },
        { key: 'description', header: 'Description', render: (i) => i.description || '—' },
        { key: 'justification', header: 'Justification', render: (i) => i.justification || '—' },
      ]} rows={sup.items} />

      <p style={{ marginTop: 14 }}><strong>Risk Assessment:</strong> {sup.risk_assessment || '—'}</p>

      {hasRole(user, 'APPLICATION_OWNER') && sup.status === 'Pending Application Owner' && (
        <div>
          <input placeholder="Comments" value={comments} onChange={(e) => setComments(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-success btn-sm" onClick={() => decide('app-owner-decision', 'Approved')}>Approve (Application Owner)</button>
            <button className="btn btn-danger btn-sm" onClick={() => decide('app-owner-decision', 'Rejected')}>Reject</button>
          </div>
        </div>
      )}
      {hasRole(user, 'DEPARTMENT_HEAD') && sup.status === 'Pending Department Head' && (
        <div>
          <input placeholder="Comments" value={comments} onChange={(e) => setComments(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-success btn-sm" onClick={() => decide('dept-head-decision', 'Approved')}>Approve (Department Head, Scale IV+)</button>
            <button className="btn btn-danger btn-sm" onClick={() => decide('dept-head-decision', 'Rejected')}>Reject</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function worstSeverity(items) {
  const order = ['Critical', 'High', 'Medium', 'Low', 'Informational']
  let worst = null
  for (const it of items || []) {
    if (worst === null || order.indexOf(it.severity) < order.indexOf(worst)) worst = it.severity
  }
  return worst
}

export default function Suppression() {
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setRows(await api.get('/api/suppressions')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  const canCreate = hasRole(user, 'SECURITY_ANALYST', 'APPLICATION_OWNER', 'REQUESTER')

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Suppression / False Positive Register" count={rows.length}
        subtitle="Exception requests for SAST/DAST findings, routed through Application Owner and Department Head approval."
        actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Suppression Request</button>}
      />
      <Card>
        <Table rowKey="id" onRowClick={setSelected} columns={[
          { key: 'suppression_id', header: 'ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'scan_type', header: 'Scan Type' },
          { key: 'findings', header: 'Findings', render: (r) => r.items.length },
          { key: 'severity', header: 'Worst Severity', render: (r) => worstSeverity(r.items) || '—' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} rows={rows} />
      </Card>
      {showNew && <NewSuppressionModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <SuppressionDetail sup={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} />}
    </div>
  )
}
