import React, { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader } from '../components/Common'
import { SEVERITIES, SUPPRESSION_STATUS_LABELS, hasRole } from '../constants'
import { SASTOut, DASTOut, SuppressionOut, CombinedSecurityRequest } from '../types'

interface SuppressionItemForm {
  issue_id: string
  severity: string
  description: string
  justification: string
}

const EMPTY_ITEM: SuppressionItemForm = { issue_id: '', severity: 'Medium', description: '', justification: '' }
const EMPTY_FORM = {
  scan_type: 'SAST', sast_request_id: null as number | null, dast_request_id: null as number | null,
  application_name: '', department: '', application_owner: '',
  risk_assessment: '', items: [{ ...EMPTY_ITEM }] as SuppressionItemForm[],
}
type SuppressionForm = typeof EMPTY_FORM

// Searchable "Request ID" autosuggest -- covers BOTH SAST and DAST requests
// together (each tagged with its _kind) so the requester doesn't have to
// pick a scan type before searching; selecting a match hands the full record
// back to the caller, which derives scan type from it and auto-populates
// Application Name / Department / Owner.
function RequestIdSearch({ requests, selected, onSelect, onClear }: {
  requests: CombinedSecurityRequest[]
  selected: CombinedSecurityRequest | null
  onSelect: (r: CombinedSecurityRequest) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  if (selected) {
    const label = (selected as any).application_name || (selected as any).application_url
    return (
      <div className="searchable-select">
        <div className="searchable-select-trigger" style={{ cursor: 'default' }}>
          <span>
            <span className={`badge ${selected._kind === 'SAST' ? 'badge-blue' : 'badge-yellow'}`} style={{ marginRight: 8 }}>{selected._kind}</span>
            {selected.request_id} — {label}
          </span>
          <button type="button" className="btn btn-sm" onClick={onClear}>Change</button>
        </div>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const matches = (q
    ? requests.filter((r) => r.request_id.toLowerCase().includes(q)
        || ((r as any).application_name || (r as any).application_url || '').toLowerCase().includes(q))
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
                  {r.request_id} — {(r as any).application_name || (r as any).application_url}
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

function NewSuppressionModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: SuppressionOut) => void }) {
  const [form, setForm] = useState<SuppressionForm>(EMPTY_FORM)
  const [selectedRef, setSelectedRef] = useState<CombinedSecurityRequest | null>(null)
  const [sastRequests, setSastRequests] = useState<SASTOut[]>([])
  const [dastRequests, setDastRequests] = useState<DASTOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof SuppressionForm>(k: K, v: SuppressionForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  useEffect(() => {
    Promise.all([api.get<SASTOut[]>('/api/sast-requests'), api.get<DASTOut[]>('/api/dast-requests')])
      .then(([sast, dast]) => { setSastRequests(sast); setDastRequests(dast) })
      .catch(() => { /* autosuggest is a convenience -- fields stay manually editable if this fails */ })
  }, [])

  // Searched together, not one-scan-type-at-a-time -- tag each so scan type
  // can be derived from whichever one gets picked, and the badge/label knows
  // which it was.
  const combinedRequests: CombinedSecurityRequest[] = [
    ...sastRequests.map((r) => ({ ...r, _kind: 'SAST' as const })),
    ...dastRequests.map((r) => ({ ...r, _kind: 'DAST' as const })),
  ]

  function selectRequest(r: CombinedSecurityRequest) {
    setSelectedRef(r)
    const label = r._kind === 'SAST' ? (r as SASTOut).application_name : (r as DASTOut).application_url
    setForm((f) => ({
      ...f,
      scan_type: r._kind,
      application_name: label || '',
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

  function setItem<K extends keyof SuppressionItemForm>(idx: number, k: K, v: SuppressionItemForm[K]) {
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, [k]: v } : it)) }))
  }
  function addItem() { setForm((f) => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] })) }
  function removeItem(idx: number) { setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try { onCreated(await api.post<SuppressionOut>('/api/suppressions', form)) }
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

function SuppressionDetail({ sup, onClose, onChanged }: { sup: SuppressionOut; onClose: () => void; onChanged: (s: SuppressionOut) => void }) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [comments, setComments] = useState('')
  const [busy, setBusy] = useState(false)

  async function act(step: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try {
      const updated = await api.post<SuppressionOut>(`/api/suppressions/${sup.id}/${step}`, extra || {})
      onChanged(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const isRequester = sup.created_by_id === user?.id || hasRole(user, 'ADMIN')
  const status = sup.status
  // SM/Department Head approvals are department-scoped -- see the comment in
  // QARequests.tsx. Security Team verification is NOT department-scoped
  // (it's the QA/security side receiving the request).
  const sameDept = !!user?.department && user.department === sup.department

  const canSubmit = isRequester && status === 'Draft'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD'].includes(status)
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canSecurityDecide = hasRole(user, 'SECURITY_ANALYST') && status === 'SECURITY_TEAM_VERIFICATION'

  return (
    <Modal title={`${sup.suppression_id} — ${sup.application_name}`} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>Status:</strong> <Badge status={status} /> <span className="muted small">{SUPPRESSION_STATUS_LABELS[status] || status}</span></div>
        <div><strong>Scan Type:</strong> {sup.scan_type}</div>
        <div><strong>Department:</strong> {sup.department || '—'}</div>
        <div><strong>Application Owner:</strong> {sup.application_owner || '—'}</div>
        <div><strong>SM Decision:</strong> {sup.sm_decision || 'Pending'}</div>
        <div><strong>Dept Head Decision:</strong> {sup.dept_head_decision || 'Pending'}</div>
        <div><strong>Security Team Decision:</strong> {sup.security_decision || 'Pending'}</div>
      </div>

      <div className="section-title">Findings ({sup.items.length})</div>
      <Table rowKey="id" columns={[
        { key: 'issue_id', header: 'Issue ID', render: (i) => i.issue_id || '—' },
        { key: 'severity', header: 'Severity' },
        { key: 'description', header: 'Description', render: (i) => i.description || '—' },
        { key: 'justification', header: 'Justification', render: (i) => i.justification || '—' },
      ]} rows={sup.items} />

      <p style={{ marginTop: 14 }}><strong>Risk Assessment:</strong> {sup.risk_assessment || '—'}</p>

      <div className="section-title">Workflow Actions</div>
      <Field label="Comments (used by the next action below)">
        <input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional comments..." />
      </Field>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canSubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('submit')}>Submit for SM Approval</button>}
        {canResubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('resubmit')}>Re-submit</button>}
        {canSMDecide && (
          <>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('sm-decision', { decision: 'Approved', comments })}>Approve (assign to Dept Head)</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => act('sm-decision', { decision: 'Returned', comments })}>Return to Requester</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('sm-decision', { decision: 'Rejected', comments })}>Reject</button>
          </>
        )}
        {canDeptHeadDecide && (
          <>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('dept-head-decision', { decision: 'Approved', comments })}>Approve (Department Head)</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => act('dept-head-decision', { decision: 'Returned', comments })}>Return to Requester</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('dept-head-decision', { decision: 'Rejected', comments })}>Reject</button>
          </>
        )}
        {canSecurityDecide && (
          <>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('security-team-decision', { decision: 'Accepted', comments })}>Accept (mark Done)</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('security-team-decision', { decision: 'Rejected', comments })}>Reject</button>
          </>
        )}
      </div>
    </Modal>
  )
}

function worstSeverity(items: { severity: string }[]): string | null {
  const order = ['Critical', 'High', 'Medium', 'Low', 'Informational']
  let worst: string | null = null
  for (const it of items || []) {
    if (worst === null || order.indexOf(it.severity) < order.indexOf(worst)) worst = it.severity
  }
  return worst
}

export default function Suppression() {
  const [rows, setRows] = useState<SuppressionOut[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<SuppressionOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try { setRows(await api.get<SuppressionOut[]>('/api/suppressions')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  // Anyone can raise a suppression request now (Application Owner step was
  // removed from the flow entirely) -- see backend routers/suppression.py
  // create_suppression, which just requires get_current_user.

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Suppression / False Positive Register" count={rows.length}
        subtitle="Exception requests for SAST/DAST findings -- Requester raises it, then Draft -> SM -> Department Head -> Security Team verification -> Done."
        actions={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Suppression Request</button>}
      />
      <Card>
        <Table rowKey="id" onRowClick={setSelected} columns={[
          { key: 'suppression_id', header: 'ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'scan_type', header: 'Scan Type' },
          { key: 'findings', header: 'Findings', render: (r) => r.items.length },
          { key: 'severity', header: 'Worst Severity', render: (r) => worstSeverity(r.items) || '—' },
          { key: 'status', header: 'Status', render: (r) => (
            <>
              <Badge status={r.status} /> <span className="muted small">{SUPPRESSION_STATUS_LABELS[r.status] || ''}</span>
            </>
          ) },
        ]} rows={rows} />
      </Card>
      {showNew && <NewSuppressionModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <SuppressionDetail sup={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} />}
    </div>
  )
}
