import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, WorkflowDecisionPanel, RequestDocuments } from '../../components/Common'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import { SEVERITIES, SUPPRESSION_STATUS_LABELS, SUPPRESSION_PENDING_WITH, SUPPRESSION_TERMINAL_STATUSES, SAST_DAST_PRE_SCANNING_STATUSES, SAST_DAST_COMPLETED_STATUSES, hasRole, hasDepartment } from '../../constants'
import { SASTListOut, DASTListOut, SASTOut, DASTOut, SuppressionOut, CombinedSecurityRequest, UserOut, ApprovalActionOut, PageOut } from '../../types'
import ClearableSearchInput from '../../components/ClearableSearchInput'

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
      <ClearableSearchInput
        placeholder="Search SAST or DAST Request ID or application..."
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onClear={() => { setQuery(''); setOpen(true) }}
        clearLabel="Clear security request search"
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

function NewSuppressionModal({ onClose, onCreated, initialRequest }: {
  onClose: () => void; onCreated: (s: SuppressionOut) => void
  // 2026-08 "Findings Validation" requirement doc, section 4.4 Action
  // Buttons -- "Initiate Suppression Request" from a SAST/DAST request's own
  // Findings tab (see SecurityScan.tsx) should land here pre-linked to that
  // exact request, not on a blank picker the analyst has to search again.
  initialRequest?: { kind: 'SAST' | 'DAST'; id: number }
}) {
  const { user } = useAuth()
  const [form, setForm] = useState<SuppressionForm>(EMPTY_FORM)
  const [selectedRef, setSelectedRef] = useState<CombinedSecurityRequest | null>(null)
  const [sastRequests, setSastRequests] = useState<SASTListOut[]>([])
  const [dastRequests, setDastRequests] = useState<DASTListOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof SuppressionForm>(k: K, v: SuppressionForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  useEffect(() => {
    // Picker candidates only -- fetches the lightweight PAG-005 list shape,
    // large page_size since this is a client-side-filtered autosuggest, not
    // a paginated table (see inScope/hasReachedScanning/isNotYetCompleted
    // below). Only ever used for the manual "Change"/search picker now --
    // see the separate direct-fetch effect below for the initialRequest
    // (deep-linked) case.
    Promise.all([
      api.get<PageOut<SASTListOut>>('/api/sast-requests?page_size=100'),
      api.get<PageOut<DASTListOut>>('/api/dast-requests?page_size=100'),
    ])
      .then(([sast, dast]) => { setSastRequests(sast.items); setDastRequests(dast.items) })
      .catch(() => { /* autosuggest is a convenience -- fields stay manually editable if this fails */ })
  }, [])

  // Reported directly: "requester created suppression request from here,
  // still it is not linked ... once request created from here, this should
  // be automatically linked." The previous approach fetched the first 100
  // SAST/DAST rows (above) and matched `initialRequest.id` against that
  // page client-side -- if the exact request wasn't among those 100 rows,
  // the match silently failed and the SAST/DAST Request ID field was left
  // empty, so the eventual suppression either couldn't be submitted (the
  // field is mandatory) or the requester had to notice and re-select it
  // manually. Fetching the exact record directly by id instead removes any
  // chance of that -- no pagination, no client-side search, always finds
  // it (as long as it still exists and the requester can still see it,
  // which the backend re-checks anyway on submit).
  useEffect(() => {
    if (!initialRequest) return
    const apiBase = initialRequest.kind === 'SAST' ? '/api/sast-requests' : '/api/dast-requests'
    api.get<SASTOut | DASTOut>(`${apiBase}/${initialRequest.id}`)
      .then((r) => selectRequest({
        id: r.id, request_id: r.request_id, status: r.status,
        application_master_status: r.application_master_status,
        requester_id: r.requester_id, security_lead_id: r.security_lead_id,
        priority: r.priority, risk_category: r.risk_category,
        application_name: r.application_name,
        department: r.department, application_owner: r.application_owner,
        findings_count: 0, has_open_suppression: false,
        qa_request: r.qa_request, created_at: r.created_at, updated_at: r.updated_at,
        _kind: initialRequest.kind,
      }))
      .catch((err) => setError(err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reported directly: "suppression requests CAN ONLY be raised by
  // requester, so this should be enable for requester, not QA team." This
  // used to also allow anyone in the same department (mirroring the
  // SM/Department Head decision scoping elsewhere) -- which let a Security
  // Analyst/QA team member raise a suppression against someone else's
  // SAST/DAST request. Narrowed to exactly the requester (the backend's
  // create_suppression now enforces the same thing server-side, so this is
  // purely to keep the picker from offering a request that would just 403
  // on submit). An Admin isn't scoped -- they can see everything, same as
  // their override elsewhere.
  function inScope(r: SASTListOut | DASTListOut): boolean {
    if (hasRole(user, 'ADMIN')) return true
    return r.requester_id === user?.id
  }

  // A suppression is a decision about a *finding* -- there's nothing to
  // suppress yet while the linked request hasn't even started scanning, so
  // it's excluded from the picker entirely (mirrors the backend's
  // _require_linked_request check in routers/suppression.py).
  function hasReachedScanning(r: SASTListOut | DASTListOut): boolean {
    return !SAST_DAST_PRE_SCANNING_STATUSES.includes(r.status)
  }

  // The other end of the window -- once a SAST/DAST request has been
  // declared Security Complete (or later), it's finalized, so a new
  // suppression can no longer be raised against it either (same backend
  // check, mirrored here so it never even shows up as a choice).
  function isNotYetCompleted(r: SASTListOut | DASTListOut): boolean {
    return !SAST_DAST_COMPLETED_STATUSES.includes(r.status)
  }

  // Searched together, not one-scan-type-at-a-time -- tag each so scan type
  // can be derived from whichever one gets picked, and the badge/label knows
  // which it was.
  const combinedRequests: CombinedSecurityRequest[] = [
    ...sastRequests.filter(inScope).filter(hasReachedScanning).filter(isNotYetCompleted).map((r) => ({ ...r, _kind: 'SAST' as const })),
    ...dastRequests.filter(inScope).filter(hasReachedScanning).filter(isNotYetCompleted).map((r) => ({ ...r, _kind: 'DAST' as const })),
  ]

  function selectRequest(r: CombinedSecurityRequest) {
    setSelectedRef(r)
    // Both SAST and DAST list rows carry application_name (delegated from
    // the QA Request gateway) -- previously DAST used targets[0].application_url
    // instead, but targets isn't part of the lightweight PAG-005 list schema
    // (see DASTListOut), and application_name is already what DAST.tsx's own
    // list table displays for the same row, so this is consistent.
    const label = r.application_name
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

// 2026-08, reported directly: "if supression request then link that
// request with that sast request, which should be linkable. and give
// option to link and delink supression request from sast request and
// supression both." -- lets the requester (or Admin) re-point an already-
// raised suppression at a *different* SAST/DAST request any time it hasn't
// reached a terminal outcome yet (mirrors backend's relink_suppression --
// SUPPRESSION_TERMINAL_STATUSES gate, same eligibility filters as the New
// Suppression Request picker above). "Delink" is deliberately not a
// separate action -- a suppression must always point at exactly one
// SAST/DAST request, so delinking is just picking a different one here.
function RelinkSuppressionModal({ sup, onClose, onRelinked }: {
  sup: SuppressionOut
  onClose: () => void
  onRelinked: (s: SuppressionOut) => void
}) {
  const { user } = useAuth()
  const [selectedRef, setSelectedRef] = useState<CombinedSecurityRequest | null>(null)
  const [sastRequests, setSastRequests] = useState<SASTListOut[]>([])
  const [dastRequests, setDastRequests] = useState<DASTListOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([
      api.get<PageOut<SASTListOut>>('/api/sast-requests?page_size=100'),
      api.get<PageOut<DASTListOut>>('/api/dast-requests?page_size=100'),
    ])
      .then(([sast, dast]) => { setSastRequests(sast.items); setDastRequests(dast.items) })
      .catch(() => { /* picker is a convenience -- fails closed with an empty list */ })
  }, [])

  // Same eligibility window as the New Suppression Request picker above
  // (requester's own requests, or Admin unrestricted; Scanning-or-later;
  // not yet Security Complete) -- mirrors the backend's own
  // _require_linked_request/_require_requester_of_linked, re-checked
  // server-side on submit regardless.
  function inScope(r: SASTListOut | DASTListOut): boolean {
    if (hasRole(user, 'ADMIN')) return true
    return r.requester_id === user?.id
  }
  function hasReachedScanning(r: SASTListOut | DASTListOut): boolean {
    return !SAST_DAST_PRE_SCANNING_STATUSES.includes(r.status)
  }
  function isNotYetCompleted(r: SASTListOut | DASTListOut): boolean {
    return !SAST_DAST_COMPLETED_STATUSES.includes(r.status)
  }

  const combinedRequests: CombinedSecurityRequest[] = [
    ...sastRequests.filter(inScope).filter(hasReachedScanning).filter(isNotYetCompleted).map((r) => ({ ...r, _kind: 'SAST' as const })),
    ...dastRequests.filter(inScope).filter(hasReachedScanning).filter(isNotYetCompleted).map((r) => ({ ...r, _kind: 'DAST' as const })),
  ]

  async function submit() {
    if (!selectedRef) { setError(new Error('Select a SAST/DAST Request ID to relink to.')); return }
    setBusy(true)
    setError(null)
    try {
      const updated = await api.post<SuppressionOut>(`/api/suppressions/${sup.id}/relink`, {
        sast_request_id: selectedRef._kind === 'SAST' ? selectedRef.id : null,
        dast_request_id: selectedRef._kind === 'DAST' ? selectedRef.id : null,
      })
      onRelinked(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Relink ${sup.suppression_id}`} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose>
      <p className="muted small">
        Currently linked to {sup.scan_type} request {sup.linked_request?.request_id || '—'}. Pick a
        different SAST/DAST request below to relink this suppression to it — application details will
        be re-derived from the new link.
      </p>
      <Field label="SAST / DAST Request ID *">
        <RequestIdSearch requests={combinedRequests} selected={selectedRef} onSelect={setSelectedRef} onClear={() => setSelectedRef(null)} />
      </Field>
      <ErrorText error={error} />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy || !selectedRef} onClick={submit}>{busy ? 'Relinking...' : 'Relink'}</button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

function SuppressionDetail({ sup, onClose, onChanged, users }: { sup: SuppressionOut; onClose: () => void; onChanged: (s: SuppressionOut) => void; users: UserOut[] }) {
  const { user } = useAuth()
  const [tab, setTab] = useState<'overview' | 'documents' | 'history'>('overview')
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [comments, setComments] = useState('')
  // Whether the "require Department Head re-approval on return" popup (see
  // canSecurityDecide below) is open -- an always-visible checkbox next to
  // "Return to Requester" was easy to miss, so this is now asked as a pop-up
  // at the moment of returning it instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false)
  const [showRelink, setShowRelink] = useState(false)
  const [busy, setBusy] = useState(false)

  const loadExtras = useCallback(async () => {
    try {
      setHistory(await api.get<ApprovalActionOut[]>(`/api/suppressions/${sup.id}/history`))
    } catch (err) { setError(err) }
  }, [sup.id])
  useEffect(() => { loadExtras() }, [loadExtras])

  async function act(step: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusy(true)
    try {
      const updated = await api.post<SuppressionOut>(`/api/suppressions/${sup.id}/${step}`, extra || {})
      onChanged(updated)
      setComments('')
      await loadExtras()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const isRequester = sup.created_by_id === user?.id || hasRole(user, 'ADMIN')
  const status = sup.status
  // SM/Department Head approvals are department-scoped -- see the comment in
  // QARequests.tsx. Security Team verification is NOT department-scoped
  // (it's the QA/security side receiving the request).
  const sameDept = hasDepartment(user, sup.department)

  // "give option to link and delink supression request from sast request
  // and supression both" -- reachable any time this suppression hasn't
  // reached a terminal outcome yet (mirrors backend's relink_suppression
  // gate exactly: SUPPRESSION_TERMINAL_STATUSES, not just Draft).
  const canRelink = isRequester && !SUPPRESSION_TERMINAL_STATUSES.includes(status)
  const canSubmit = isRequester && status === 'Draft'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_TEAM'].includes(status)
  // Reported directly: a person who raised this request but also separately
  // holds SM/Department Head for the same department must not be able to
  // approve their own request -- someone else holding that role must decide
  // it instead. Admin still bypasses (matches the backend's
  // require_not_requester, which enforces the same check server-side using
  // created_by_id, the field this module raises requests under).
  const isSelfApproval = sup.created_by_id === user?.id && !hasRole(user, 'ADMIN')
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN')) && !isSelfApproval
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || hasRole(user, 'ADMIN')) && !isSelfApproval
  const canSecurityDecide = hasRole(user, 'SECURITY_ANALYST') && status === 'SECURITY_TEAM_VERIFICATION'
  // Document and Evidence Access Control Based on Workflow Stage: exactly 3
  // upload stages, then a hard lock -- (1) the requester while it's Draft/
  // Returned-by-*, (2) the SM only while SM_APPROVAL_PENDING, (3) the
  // Department Head only while DEPARTMENT_HEAD_APPROVAL_PENDING. Every
  // status after Department Head approval (including
  // SECURITY_TEAM_VERIFICATION, previously a Security-Analyst upload
  // window) is locked for everyone but Admin -- mirrors the backend's own
  // (now-simplified) _can_upload_documents exactly.
  const canManageDocuments = hasRole(user, 'ADMIN') || (
    ['Draft', 'RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_TEAM'].includes(status) ? isRequester :
    status === 'SM_APPROVAL_PENDING' ? canSMDecide :
    status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' ? canDeptHeadDecide :
    false
  )

  return (
    <Modal title={`${sup.suppression_id} — ${sup.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" className={tab === 'documents' ? 'active' : ''} onClick={() => setTab('documents')}>Documents</button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Activity</button>
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
          <div className="grid grid-2">
            <div><strong>Status:</strong> <Badge status={status} /> <span className="muted small">{SUPPRESSION_STATUS_LABELS[status] || status}</span></div>
            <div><strong>Scan Type:</strong> {sup.scan_type}</div>
            <div>
              <strong>{sup.scan_type} Request ID:</strong> {sup.linked_request?.request_id || '—'}
              {canRelink && (
                <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => setShowRelink(true)}>
                  Relink
                </button>
              )}
            </div>
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
                onReturn={(actionNote) => act('sm-decision', { decision: 'Returned', comments: actionNote })}
                onReject={(actionNote) => act('sm-decision', { decision: 'Rejected', comments: actionNote })}
              />
            )}
            {canDeptHeadDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={busy}
                approveLabel="Approve (Department Head)"
                onApprove={(signed) => act('dept-head-decision', { decision: 'Approved', comments: signed })}
                onReturn={(actionNote) => act('dept-head-decision', { decision: 'Returned', comments: actionNote })}
                onReject={(actionNote) => act('dept-head-decision', { decision: 'Rejected', comments: actionNote })}
              />
            )}
            {canSecurityDecide && (
              <WorkflowDecisionPanel busy={busy} title="Security verification decision" options={[
                { key: 'accept', label: 'Accept & mark done', description: 'Complete the suppression workflow', tone: 'approve', onClick: () => act('security-team-decision', { decision: 'Accepted', comments }) },
                { key: 'return', label: 'Return to Requester', description: 'Send back for corrections and resubmission', tone: 'return', onClick: () => setShowReapprovalConfirm(true) },
                { key: 'reject', label: 'Reject', description: 'Stop and close this approval path', tone: 'reject', onClick: () => act('security-team-decision', { decision: 'Rejected', comments }) },
              ]} />
            )}
            {showReapprovalConfirm && (
              <ConfirmModal
                title="Return to Requester"
                message="Require Department Head re-approval when this suppression request is returned to the requester?"
                confirmLabel="Yes, require re-approval"
                cancelLabel="No, skip re-approval"
                busy={busy}
                onConfirm={() => {
                  setShowReapprovalConfirm(false)
                  act('security-team-decision', { decision: 'Returned', comments, require_dept_head_reapproval: true })
                }}
                onCancel={() => {
                  setShowReapprovalConfirm(false)
                  act('security-team-decision', { decision: 'Returned', comments, require_dept_head_reapproval: false })
                }}
              />
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <JiraActivity entityType="SUPPRESSION" entityId={sup.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/suppressions" reqId={sup.id} canManage={canManageDocuments} />}

      {showRelink && (
        <RelinkSuppressionModal
          sup={sup}
          onClose={() => setShowRelink(false)}
          onRelinked={(updated) => { setShowRelink(false); onChanged(updated) }}
        />
      )}
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
  const { user } = useAuth()
  const navigate = useNavigate()
  const [rows, setRows] = useState<SuppressionOut[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<SuppressionOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setRows(await api.get<SuppressionOut[]>('/api/suppressions')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names just stay empty */ })
  }, [])

  // Same "?open=<suppression_id>" deep-link pattern as Functional/SAST/DAST/
  // Performance (see e.g. Functional.tsx) -- lets the topbar search box and
  // the Linked Requests table jump straight to a specific suppression's
  // detail drawer instead of just landing on this list.
  useEffect(() => {
    const openId = searchParams.get('open')
    if (!openId || rows.length === 0) return
    const match = rows.find((r) => r.suppression_id === openId)
    if (match) setSelected(match)
    setSearchParams((p) => { p.delete('open'); return p }, { replace: true })
  }, [rows, searchParams, setSearchParams])

  // "Initiate Suppression Request" (SecurityScan.tsx, findings tab) links
  // here as `?new=1&scan_type=SAST&request_id=123` -- opens the New
  // Suppression modal pre-linked to that exact request instead of a blank
  // picker. Doesn't wait on `rows` (unlike `?open=` above) since it's not
  // looking anything up from this page's own list.
  const [newRequestPrefill, setNewRequestPrefill] = useState<{ kind: 'SAST' | 'DAST'; id: number } | undefined>()
  useEffect(() => {
    if (searchParams.get('new') !== '1') return
    const kind = searchParams.get('scan_type')
    const id = Number(searchParams.get('request_id'))
    if ((kind === 'SAST' || kind === 'DAST') && id) setNewRequestPrefill({ kind, id })
    setShowNew(true)
    setSearchParams((p) => { p.delete('new'); p.delete('scan_type'); p.delete('request_id'); return p }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reported directly: "Initiate Suppression Request should be from
  // requester side, not QA side." Section 120 already locked this down at
  // the backend (_require_requester_of_linked) and inside the picker
  // (inScope, requester_id === user.id) -- a Security Analyst/QA team
  // member could open this modal but would just find nothing selectable.
  // The entry-point button itself was still shown to everyone, though (the
  // comment it replaces was stale -- it predates that fix). Only
  // REQUESTER/BUSINESS_ANALYST can ever raise the QA Request a SAST/DAST
  // request is born from (see qa_requests.py's create_request/submit_request
  // require_roles), so anyone without one of those two roles can never
  // legitimately be a `requester_id` on a SAST/DAST request -- same
  // role gate, reused here instead of a bespoke one. Admin still bypasses.
  const canInitiateSuppression = hasRole(user, 'REQUESTER', 'BUSINESS_ANALYST', 'ADMIN')

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Suppression / False Positive Register" count={rows.length}
        subtitle="Exception requests for SAST/DAST findings -- Requester raises it, then Draft -> SM -> Department Head -> Security Team verification -> Done."
        actions={canInitiateSuppression ? (
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Suppression Request</button>
        ) : undefined}
      />
      <Card>
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
          { key: 'suppression_id', header: 'ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'created_by_id', header: 'Requester', render: (r) => userName(users, r.created_by_id) || '—', filterValue: (r) => userName(users, r.created_by_id) || '' },
          { key: 'scan_type', header: 'Scan Type' },
          { key: 'linked_request', header: 'Linked Request', render: (r) => r.linked_request?.request_id || '—', filterValue: (r) => r.linked_request?.request_id || '' },
          { key: 'findings', header: 'Findings', render: (r) => r.items.length, filterValue: (r) => String(r.items.length) },
          { key: 'severity', header: 'Worst Severity', render: (r) => worstSeverity(r.items) || '—', filterValue: (r) => worstSeverity(r.items) || '' },
          { key: 'status', header: 'Status', render: (r) => (
            <>
              <Badge status={r.status} /> <span className="muted small">{SUPPRESSION_STATUS_LABELS[r.status] || ''}</span>
            </>
          ), filterValue: (r) => `${r.status} ${SUPPRESSION_STATUS_LABELS[r.status] || ''}` },
          { key: 'pending_with', header: 'Pending With', render: (r) => SUPPRESSION_PENDING_WITH[r.status] || '—', filterValue: (r) => SUPPRESSION_PENDING_WITH[r.status] || '' },
        ]} rows={rows} />
      </Card>
      {showNew && (
        <NewSuppressionModal
          initialRequest={newRequestPrefill}
          onClose={() => { setShowNew(false); setNewRequestPrefill(undefined) }}
          onCreated={(created) => {
            setShowNew(false)
            load()
            // Reported directly: "once request created from here, this
            // should be automatically linked" -- besides guaranteeing the
            // link itself (NewSuppressionModal's direct-fetch effect
            // above), jump straight back to the originating SAST/DAST
            // request when this creation came from its own Findings tab
            // ("Initiate Suppression Request"), so the requester sees it
            // reflected immediately (Overview's "Suppression Requested?"
            // flips to Yes, and the Findings tab's Initiate Suppression
            // Request button disables) instead of having to go find it
            // themselves. Manual creation (from this module's own "+ New
            // Suppression Request", no prefill) stays here as before.
            if (newRequestPrefill && created.linked_request) {
              navigate(`${newRequestPrefill.kind === 'SAST' ? '/sast' : '/dast'}?open=${created.linked_request.request_id}`)
            }
            setNewRequestPrefill(undefined)
          }}
        />
      )}
      {selected && <SuppressionDetail sup={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} />}
    </div>
  )
}
