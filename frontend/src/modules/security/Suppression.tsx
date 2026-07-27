import React, { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '@qa-portal/shared/api'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, RequestDocuments } from '@qa-portal/shared/components/Common'
import { SEVERITIES, SUPPRESSION_STATUS_LABELS, hasRole } from '@qa-portal/shared/constants'
import { SASTOut, DASTOut, SuppressionOut, CombinedSecurityRequest, UserOut, WalkthroughOut, ApprovalActionOut } from '@qa-portal/shared/types'

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

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
  const { user } = useAuth()
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

  // The Request ID autosuggest should only ever offer SAST/DAST requests the
  // requester could plausibly be raising a suppression against -- either one
  // they raised themselves, or one from their own department (mirrors the
  // same-department scoping already used for SM/Department Head decisions
  // elsewhere in the app). An Admin isn't scoped -- they can see everything,
  // same as their override elsewhere.
  function inScope(r: SASTOut | DASTOut): boolean {
    if (hasRole(user, 'ADMIN')) return true
    return r.requester_id === user?.id || (!!user?.department && r.department === user.department)
  }

  // Searched together, not one-scan-type-at-a-time -- tag each so scan type
  // can be derived from whichever one gets picked, and the badge/label knows
  // which it was.
  const combinedRequests: CombinedSecurityRequest[] = [
    ...sastRequests.filter(inScope).map((r) => ({ ...r, _kind: 'SAST' as const })),
    ...dastRequests.filter(inScope).map((r) => ({ ...r, _kind: 'DAST' as const })),
  ]

  function selectRequest(r: CombinedSecurityRequest) {
    setSelectedRef(r)
    const label = r._kind === 'SAST' ? (r as SASTOut).application_name : (r as DASTOut).targets?.[0]?.application_url
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
    // Every field is mandatory now, including the link itself -- there is no
    // more "standalone finding" fallback, so this is the one thing native
    // HTML5 required validation can't catch (RequestIdSearch isn't a plain
    // input/select).
    if (!selectedRef) { setError(new Error('Select a SAST/DAST Request ID above before submitting.')); return }
    setBusy(true)
    setError(null)
    try { onCreated(await api.post<SuppressionOut>('/api/suppressions', form)) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Suppression / False Positive Request" onClose={onClose} wide>
      {/* Scoped redesign (larger fonts, card-style sections) -- see the
          `.suppression-form` rules in index.css, which share the same "modern
          card wizard" language as the QA Request wizard's `.qa-wizard` scope
          without touching either's shared base classes globally. */}
      <div className="suppression-form">
        <form onSubmit={submit}>
          <div className="form-section">
            <div className="form-section-title">Linked SAST / DAST Request</div>
            <Field label="SAST / DAST Request ID *">
              <RequestIdSearch requests={combinedRequests} selected={selectedRef} onSelect={selectRequest} onClear={clearRequest} />
            </Field>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Only showing SAST/DAST requests you raised, or from your own department. Selecting one
              auto-fills the application details below.
            </p>
          </div>

          <div className="form-section">
            <div className="form-section-title">Application Details</div>
            <div className="form-row">
              <Field label="Scan Type *">
                <select required value={form.scan_type} disabled>
                  <option value="SAST">SAST</option><option value="DAST">DAST</option>
                </select>
              </Field>
              <Field label="Application Name *">
                <input required value={form.application_name} disabled />
              </Field>
              <Field label="Application Owner *">
                <input required value={form.application_owner} disabled />
              </Field>
              <Field label="Department *">
                <input required value={form.department} disabled />
              </Field>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Findings to Suppress</div>
            <p className="muted small" style={{ margin: '-6px 0 12px' }}>
              One scan can cover several vulnerabilities — add a row per finding.
            </p>
            {form.items.map((item, idx) => (
              <div key={idx} className="card" style={{ padding: 14, marginBottom: 12 }}>
                <div className="form-row" style={{ marginBottom: 8 }}>
                  <Field label="Issue ID *"><input required value={item.issue_id} onChange={(e) => setItem(idx, 'issue_id', e.target.value)} /></Field>
                  <Field label="Severity *">
                    <select required value={item.severity} onChange={(e) => setItem(idx, 'severity', e.target.value)}>
                      {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="Issue Description *"><textarea required value={item.description} onChange={(e) => setItem(idx, 'description', e.target.value)} /></Field>
                <Field label="Justification *"><textarea required value={item.justification} onChange={(e) => setItem(idx, 'justification', e.target.value)} /></Field>
                {form.items.length > 1 && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => removeItem(idx)} style={{ marginTop: 8 }}>Remove Finding</button>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={addItem}>+ Add Another Finding</button>
          </div>

          <div className="form-section">
            <div className="form-section-title">Risk Assessment</div>
            <Field label="Risk Assessment &amp; Acknowledgement (overall) *">
              <textarea required value={form.risk_assessment} onChange={(e) => set('risk_assessment', e.target.value)} />
            </Field>
          </div>

          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Submitting...' : 'Submit Request'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </Modal>
  )
}

function SuppressionDetail({ sup, onClose, onChanged, users }: { sup: SuppressionOut; onClose: () => void; onChanged: (s: SuppressionOut) => void; users: UserOut[] }) {
  const { user } = useAuth()
  const [tab, setTab] = useState<'overview' | 'walkthroughs' | 'documents' | 'history'>('overview')
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [comments, setComments] = useState('')
  const [requireDeptHeadReapproval, setRequireDeptHeadReapproval] = useState(false)
  const [busy, setBusy] = useState(false)

  const loadExtras = useCallback(async () => {
    try {
      const [wt, hist] = await Promise.all([
        api.get<WalkthroughOut[]>(`/api/suppressions/${sup.id}/walkthroughs`),
        api.get<ApprovalActionOut[]>(`/api/suppressions/${sup.id}/history`),
      ])
      setWalkthroughs(wt); setHistory(hist)
    } catch (err) { setError(err) }
  }, [sup.id])
  useEffect(() => { loadExtras() }, [loadExtras])

  async function act(step: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try {
      const updated = await api.post<SuppressionOut>(`/api/suppressions/${sup.id}/${step}`, extra || {})
      onChanged(updated)
      loadExtras()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const isRequester = sup.created_by_id === user?.id || hasRole(user, 'ADMIN')
  const status = sup.status
  // SM/Department Head approvals are department-scoped -- see the comment in
  // QARequests.tsx. Security Team verification is NOT department-scoped
  // (it's the QA/security side receiving the request).
  const sameDept = !!user?.department && user.department === sup.department

  const canSubmit = isRequester && status === 'Draft'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_TEAM'].includes(status)
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN'))
  const canSecurityDecide = hasRole(user, 'SECURITY_ANALYST') && status === 'SECURITY_TEAM_VERIFICATION'

  return (
    <Modal title={`${sup.suppression_id} — ${sup.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" className={tab === 'walkthroughs' ? 'active' : ''} onClick={() => setTab('walkthroughs')}>Walkthroughs</button>
        <button type="button" className={tab === 'documents' ? 'active' : ''} onClick={() => setTab('documents')}>Documents</button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button>
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
          <div className="grid grid-2">
            <div><strong>Status:</strong> <Badge status={status} /> <span className="muted small">{SUPPRESSION_STATUS_LABELS[status] || status}</span></div>
            <div><strong>Scan Type:</strong> {sup.scan_type}</div>
            <div><strong>Requester:</strong> {userName(users, sup.created_by_id) || '—'}</div>
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
            <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/suppressions/${sup.id}/export`, `${sup.suppression_id}.pdf`)}>
              Export PDF
            </button>
            {canSubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('submit')}>Submit for SM Approval</button>}
            {canResubmit && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('resubmit')}>Re-submit</button>}
            {canSMDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={busy}
                approveLabel="Approve (assign to Dept Head)"
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
                approveLabel="Approve (Department Head)"
                onApprove={(signed) => act('dept-head-decision', { decision: 'Approved', comments: signed })}
                onReturn={() => act('dept-head-decision', { decision: 'Returned', comments })}
                onReject={() => act('dept-head-decision', { decision: 'Rejected', comments })}
              />
            )}
            {canSecurityDecide && (
              <>
                <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act('security-team-decision', { decision: 'Accepted', comments })}>Accept (mark Done)</button>
                <button className="btn btn-sm" disabled={busy}
                        onClick={() => act('security-team-decision', { decision: 'Returned', comments, require_dept_head_reapproval: requireDeptHeadReapproval })}>
                  Return to Requester
                </button>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('security-team-decision', { decision: 'Rejected', comments })}>Reject</button>
                <label className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={requireDeptHeadReapproval}
                         onChange={(e) => setRequireDeptHeadReapproval(e.target.checked)} />
                  Require Department Head re-approval on return
                </label>
              </>
            )}
          </div>
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
          <AddWalkthrough reqId={sup.id} onAdded={loadExtras} />
        </div>
      )}

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

      {tab === 'documents' && <RequestDocuments apiBase="/api/suppressions" reqId={sup.id} />}
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
      await api.post(`/api/suppressions/${reqId}/walkthroughs`, { conducted_by, participants, notes })
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
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try { setRows(await api.get<SuppressionOut[]>('/api/suppressions')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names just stay empty */ })
  }, [])

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
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
          { key: 'suppression_id', header: 'ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'created_by_id', header: 'Requester', render: (r) => userName(users, r.created_by_id) || '—', filterValue: (r) => userName(users, r.created_by_id) || '' },
          { key: 'scan_type', header: 'Scan Type' },
          { key: 'findings', header: 'Findings', render: (r) => r.items.length, filterValue: (r) => String(r.items.length) },
          { key: 'severity', header: 'Worst Severity', render: (r) => worstSeverity(r.items) || '—', filterValue: (r) => worstSeverity(r.items) || '' },
          { key: 'status', header: 'Status', render: (r) => (
            <>
              <Badge status={r.status} /> <span className="muted small">{SUPPRESSION_STATUS_LABELS[r.status] || ''}</span>
            </>
          ), filterValue: (r) => `${r.status} ${SUPPRESSION_STATUS_LABELS[r.status] || ''}` },
        ]} rows={rows} />
      </Card>
      {showNew && <NewSuppressionModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <SuppressionDetail sup={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} />}
    </div>
  )
}
