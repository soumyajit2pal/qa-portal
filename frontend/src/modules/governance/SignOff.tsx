import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, RequestDocuments, ApprovalDecisionButtons } from '../../components/Common'
import {
  CERTIFICATE_TYPES, SIGNOFF_TESTING_TYPES, RISK_TIERS, ENVIRONMENTS, hasRole,
  SIGNOFF_EDITABLE_STATUSES, QA_DEPARTMENT, SIGNOFF_STATUS_LABELS, SIGNOFF_PENDING_WITH,
  canSeeQaDepartmentOnlyData,
} from '../../constants'
import { SignOffOut, UserOut, FunctionalOut, ApprovalActionOut } from '../../types'
import JiraActivity, { MarkdownComment } from '../../components/JiraActivity'
import JiraRichTextField from '../../components/JiraRichTextField'
import ClearableSearchInput from '../../components/ClearableSearchInput'

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

// Only Functional Testing Requests that have actually finished QA activity
// are eligible to be picked as the "Testing Request ID" for a new
// certificate -- raising sign-off for a request still mid-execution
// wouldn't make sense.
const SIGNOFF_ELIGIBLE_STATUSES = ['QA_COMPLETED', 'QA_SIGNOFF_PENDING', 'QA_SIGNED_OFF', 'REQUESTER_VERIFICATION', 'CLOSED']

const EMPTY = {
  certificate_type: 'Full Clearance', testing_type: 'Functional', testing_request_id: '',
  change_request_ids: '', application_name: '', application_owner: '', department: '',
  technology_stack: '', risk_tier: 'Tier 3 (Medium)', release_version: '', build_number: '',
  environment_tested: 'UAT', target_promotion_environment: 'Production',
  // Optional on the backend (schemas.SignOffCreate/SignOffUpdate) -- always
  // existed as columns and were already shown on the certificate detail view
  // ("Validity: — to —"), but no form anywhere actually let anyone set them,
  // so every certificate showed blank. Kept as empty strings here (not null)
  // since a <input type="date"> needs a string value; converted to null on
  // submit if left blank -- see submit() below.
  validity_from: '', validity_to: '',
  exit_criteria_notes: '', open_defect_summary: '', residual_risk_notes: '',
}
type SignOffForm = typeof EMPTY

// Shared by both the create and edit forms below.
function validityError(from: string, to: string): string | null {
  if (from && to && to < from) return 'Validity To cannot be before Validity From.'
  return null
}

function richTextRequiredError(form: Pick<SignOffForm, 'exit_criteria_notes' | 'open_defect_summary' | 'residual_risk_notes'>): string | null {
  if (!form.exit_criteria_notes.trim()) return 'Exit Criteria Validation Notes are required.'
  if (!form.open_defect_summary.trim()) return 'Open Defect Review Summary is required.'
  if (!form.residual_risk_notes.trim()) return 'Residual Risk Documentation is required.'
  return null
}

// Searchable "Testing Request ID" autosuggest over Functional Testing
// Requests -- same pattern as Suppression.tsx's SAST/DAST RequestIdSearch.
// Selecting a match hands the full FunctionalOut record back to the caller,
// which derives every auto-populated certificate field from it (see
// NewSignOffModal::applyRequest below).
function TestingRequestIdSearch({ requests, selected, onSelect, onClear }: {
  requests: FunctionalOut[]
  selected: FunctionalOut | null
  onSelect: (r: FunctionalOut) => void
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
    return (
      <div className="searchable-select">
        <div className="searchable-select-trigger" style={{ cursor: 'default' }}>
          <span>{selected.request_id} — {selected.application_name || '—'}</span>
          <button type="button" className="btn btn-sm" onClick={onClear}>Change</button>
        </div>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const matches = (q
    ? requests.filter((r) => r.request_id.toLowerCase().includes(q)
        || (r.application_name || '').toLowerCase().includes(q))
    : requests
  ).slice(0, 8)

  return (
    <div className="searchable-select" ref={boxRef}>
      <ClearableSearchInput
        placeholder="Search Testing Request ID or application..."
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onClear={() => { setQuery(''); setOpen(true) }}
        clearLabel="Clear Testing Request search"
      />
      {open && (
        <div className="searchable-select-panel">
          <div className="searchable-select-list">
            {matches.length === 0 && <div className="searchable-select-empty">No eligible Functional Testing Requests found.</div>}
            {matches.map((r) => (
              <div key={r.id} className="searchable-select-option"
                   onClick={() => { onSelect(r); setQuery(''); setOpen(false) }}>
                <div>{r.request_id} — {r.application_name || '—'}</div>
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

// `presetRequest`, when given (see functional/Functional.tsx's "Request
// Sign-off" button), locks the Testing Request ID to that specific request
// -- raising sign-off from a request's own page always means the
// certificate is for THAT request, so there's nothing to search/change.
// Without it (the standalone "+ New Sign-off Certificate" button on this
// page), the QA Lead searches for and picks any eligible Functional Testing
// Request via TestingRequestIdSearch above.
//
// Either way, once a Testing Request is selected, Application Name/Owner/
// Department/Change Request ID(s) are derived from it and locked -- never
// independently editable, so the certificate can't drift from the request
// it's actually for.
export function NewSignOffModal({ onClose, onCreated, presetRequest }: {
  onClose: () => void
  onCreated: (s: SignOffOut) => void
  presetRequest?: FunctionalOut
}) {
  const { user } = useAuth()
  const [form, setForm] = useState<SignOffForm>(EMPTY)
  const [selectedRequest, setSelectedRequest] = useState<FunctionalOut | null>(null)
  const [eligibleRequests, setEligibleRequests] = useState<FunctionalOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // Supporting documents picked before the certificate exists yet -- there's
  // no signoff id to upload against until POST /api/signoffs returns one, so
  // these are held here and uploaded right after creation succeeds (see
  // submit() below), same files-then-upload two-step every other module's
  // own Documents tab does post-raise (see Common.tsx::RequestDocuments),
  // just folded into this one form instead of a separate step.
  const [files, setFiles] = useState<File[]>([])
  function set<K extends keyof SignOffForm>(k: K, v: SignOffForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  const applyRequest = useCallback((r: FunctionalOut) => {
    setSelectedRequest(r)
    setForm((f) => ({
      ...f,
      testing_request_id: r.request_id,
      application_name: r.application_name || '',
      application_owner: r.application_owner || '',
      department: QA_DEPARTMENT,
      change_request_ids: r.cr_number || '',
      technology_stack: r.technology_stack || '',
      release_version: r.release_version || '',
      build_number: r.build_number || '',
      // SIGNOFF_TESTING_TYPES is ["Functional", "SAST", "DAST"] -- a
      // certificate raised from a Functional Testing Request is always the
      // "Functional" type.
      testing_type: 'Functional',
      environment_tested: r.environment || f.environment_tested,
      target_promotion_environment: r.target_promotion_environment || f.target_promotion_environment,
    }))
  }, [])

  useEffect(() => {
    if (presetRequest) { applyRequest(presetRequest); return }
    api.get<FunctionalOut[]>('/api/functional-requests')
      .then((rows) => setEligibleRequests(rows.filter((r) => SIGNOFF_ELIGIBLE_STATUSES.includes(r.status))))
      .catch(setError)
  }, [presetRequest, applyRequest])

  function clearSelection() {
    setSelectedRequest(null)
    setForm((f) => ({ ...f, testing_request_id: '', application_name: '', application_owner: '', department: QA_DEPARTMENT, change_request_ids: '' }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // Disabled inputs are skipped by the browser's own `required` validation
    // entirely, so the locked Application Name/Owner/Department/Change
    // Request ID(s) fields need this explicit check instead -- they're only
    // ever filled in via picking a Testing Request above.
    if (!selectedRequest) { setError('Pick a Testing Request ID first -- Application Name, Owner and Change Request ID(s) are derived from it.'); return }
    if (!hasRole(user, 'ADMIN') && user?.department !== QA_DEPARTMENT) {
      setError(`QA Sign-off is restricted to the ${QA_DEPARTMENT} department.`)
      return
    }
    const validityErr = validityError(form.validity_from, form.validity_to)
    if (validityErr) { setError(validityErr); return }
    const richTextErr = richTextRequiredError(form)
    if (richTextErr) { setError(richTextErr); return }
    setBusy(true)
    try {
      const created = await api.post<SignOffOut>('/api/signoffs', {
        ...form,
        validity_from: form.validity_from || null,
        validity_to: form.validity_to || null,
      })
      // Best-effort: the certificate itself is already created at this point,
      // so a failed upload shouldn't block onCreated -- surface the error but
      // still hand back the created certificate (its own Documents tab, via
      // RequestDocuments in SignOffDetail below, can always retry the upload).
      if (files.length > 0) {
        try { await api.uploadFiles(`/api/signoffs/${created.id}/documents`, files) }
        catch (err) { setError(err) }
      }
      onCreated(created)
    }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New QA Sign-off Certificate" onClose={onClose} wide>
      <form onSubmit={submit}>
        <Field label="Testing Request ID *">
          {presetRequest ? (
            <div className="searchable-select">
              <div className="searchable-select-trigger" style={{ cursor: 'default' }}>
                <span>{presetRequest.request_id} — {presetRequest.application_name || '—'}</span>
              </div>
            </div>
          ) : (
            <TestingRequestIdSearch requests={eligibleRequests} selected={selectedRequest} onSelect={applyRequest} onClear={clearSelection} />
          )}
        </Field>
        <div className="form-row">
          <Field label="Application Name *"><input required disabled value={form.application_name} onChange={() => {}} /></Field>
          <Field label="Application Owner *"><input required disabled value={form.application_owner} onChange={() => {}} /></Field>
          <Field label="QA Approval Department *"><input required disabled value={form.department || QA_DEPARTMENT} onChange={() => {}} /></Field>
          <Field label="Change Request ID(s) *"><input required disabled value={form.change_request_ids} onChange={() => {}} /></Field>
          <Field label="Technology Stack *"><input required value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
          <Field label="Release Version *"><input required value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
          <Field label="Build Number *"><input required value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
          <Field label="Certificate Type *">
            <select required value={form.certificate_type} onChange={(e) => set('certificate_type', e.target.value)}>
              {CERTIFICATE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Testing Type *">
            <select required value={form.testing_type} onChange={(e) => set('testing_type', e.target.value)}>
              {SIGNOFF_TESTING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Risk Tier *">
            <select required value={form.risk_tier} onChange={(e) => set('risk_tier', e.target.value)}>
              {RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Environment Tested *">
            <select required value={form.environment_tested} onChange={(e) => set('environment_tested', e.target.value)}>
              {ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Target Promotion Environment *">
            <select required value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
              {ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Validity From">
            <input type="date" value={form.validity_from} onChange={(e) => set('validity_from', e.target.value)} />
          </Field>
          <Field label="Validity To">
            <input type="date" min={form.validity_from || undefined} value={form.validity_to} onChange={(e) => set('validity_to', e.target.value)} />
          </Field>
        </div>
        <Field label="Exit Criteria Validation Notes *"><JiraRichTextField value={form.exit_criteria_notes} onChange={(value) => set('exit_criteria_notes', value)} onImagesChange={() => undefined} allowImages={false} ariaLabel="Exit Criteria Validation Notes" placeholder="Document validation performed against the exit criteria…" /></Field>
        <Field label="Open Defect Review Summary *"><JiraRichTextField value={form.open_defect_summary} onChange={(value) => set('open_defect_summary', value)} onImagesChange={() => undefined} allowImages={false} ariaLabel="Open Defect Review Summary" placeholder="Summarize open defects, severity, ownership and disposition…" /></Field>
        <Field label="Residual Risk Documentation *"><JiraRichTextField value={form.residual_risk_notes} onChange={(value) => set('residual_risk_notes', value)} onImagesChange={() => undefined} allowImages={false} ariaLabel="Residual Risk Documentation" placeholder="Document accepted residual risks, mitigations and ownership…" /></Field>
        <Field label="Supporting Documents">
          <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          {files.length > 0 && (
            <div className="muted small" style={{ marginTop: 4 }}>
              {files.map((f) => f.name).join(', ')}
            </div>
          )}
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Draft Certificate'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Edit Details for an already-raised certificate -- reachable by the QA requester
// (requester) while it's Draft or sitting back with them after a QA Lead/
// Executive COE return, or by a QA Lead directly while it's sitting at
// their own QA Lead review (legacy status SM_APPROVAL_PENDING; see routers/signoff.py::
// update_signoff for the exact permission windows -- "he will have option
// to modify details" per the requested workflow). Testing Request ID/
// Application Name/Owner/Department/Change Request ID(s) stay locked here
// too, same as at creation -- they're derived from the linked Functional
// Testing Request and shouldn't drift from it.
function EditSignOffModal({ item, onClose, onSaved }: { item: SignOffOut; onClose: () => void; onSaved: (s: SignOffOut) => void }) {
  const [form, setForm] = useState({
    certificate_type: item.certificate_type, testing_type: item.testing_type,
    vendor_si_partner: item.vendor_si_partner || '', technology_stack: item.technology_stack || '',
    risk_tier: item.risk_tier || '', release_version: item.release_version || '', build_number: item.build_number || '',
    environment_tested: item.environment_tested || '', target_promotion_environment: item.target_promotion_environment || '',
    validity_from: item.validity_from || '', validity_to: item.validity_to || '',
    exit_criteria_notes: item.exit_criteria_notes || '', open_defect_summary: item.open_defect_summary || '',
    residual_risk_notes: item.residual_risk_notes || '',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const validityErr = validityError(form.validity_from, form.validity_to)
    if (validityErr) { setError(validityErr); return }
    const richTextErr = richTextRequiredError(form)
    if (richTextErr) { setError(richTextErr); return }
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.put<SignOffOut>(`/api/signoffs/${item.id}`, {
        ...form,
        validity_from: form.validity_from || null,
        validity_to: form.validity_to || null,
      }))
    }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${item.certificate_id}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Testing Request ID"><input disabled value={item.testing_request_id || ''} /></Field>
          <Field label="Application Name"><input disabled value={item.application_name} /></Field>
          <Field label="Application Owner"><input disabled value={item.application_owner || ''} /></Field>
          <Field label="QA Approval Department"><input disabled value={item.department || QA_DEPARTMENT} /></Field>
        </div>
        <div className="form-row">
          <Field label="Certificate Type *">
            <select required value={form.certificate_type} onChange={(e) => set('certificate_type', e.target.value)}>
              {CERTIFICATE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Testing Type *">
            <select required value={form.testing_type} onChange={(e) => set('testing_type', e.target.value)}>
              {SIGNOFF_TESTING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Technology Stack"><input value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
          <Field label="Release Version"><input value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
          <Field label="Build Number"><input value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
          <Field label="Risk Tier *">
            <select required value={form.risk_tier} onChange={(e) => set('risk_tier', e.target.value)}>
              {RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Environment Tested *">
            <select required value={form.environment_tested} onChange={(e) => set('environment_tested', e.target.value)}>
              {ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Target Promotion Environment *">
            <select required value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
              {ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Validity From">
            <input type="date" value={form.validity_from} onChange={(e) => set('validity_from', e.target.value)} />
          </Field>
          <Field label="Validity To">
            <input type="date" min={form.validity_from || undefined} value={form.validity_to} onChange={(e) => set('validity_to', e.target.value)} />
          </Field>
        </div>
        <Field label="Exit Criteria Validation Notes *"><JiraRichTextField value={form.exit_criteria_notes} onChange={(value) => set('exit_criteria_notes', value)} onImagesChange={() => undefined} allowImages={false} ariaLabel="Exit Criteria Validation Notes" placeholder="Document validation performed against the exit criteria…" /></Field>
        <Field label="Open Defect Review Summary *"><JiraRichTextField value={form.open_defect_summary} onChange={(value) => set('open_defect_summary', value)} onImagesChange={() => undefined} allowImages={false} ariaLabel="Open Defect Review Summary" placeholder="Summarize open defects, severity, ownership and disposition…" /></Field>
        <Field label="Residual Risk Documentation *"><JiraRichTextField value={form.residual_risk_notes} onChange={(value) => set('residual_risk_notes', value)} onImagesChange={() => undefined} allowImages={false} ariaLabel="Residual Risk Documentation" placeholder="Document accepted residual risks, mitigations and ownership…" /></Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Changes'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function SignOffDetail({ item, onClose, onChanged, users }: { item: SignOffOut; onClose: () => void; onChanged: (s: SignOffOut) => void; users: UserOut[] }) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [comments, setComments] = useState('')
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    try { setHistory(await api.get<ApprovalActionOut[]>(`/api/signoffs/${item.id}/history`)) }
    catch (err) { setError(err) }
  }, [item.id])
  useEffect(() => { load() }, [load])

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusyAction(action)
    try {
      const updated = await api.post<SignOffOut>(`/api/signoffs/${item.id}/${action}`, extra || {})
      onChanged(updated)
      setComments('')
      await load()
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  const isRequester = item.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = item.status
  const isAdmin = hasRole(user, 'ADMIN')
  const isQADepartment = user?.department === QA_DEPARTMENT || isAdmin

  const canSubmit = isRequester && status === 'DRAFT'
  // SM_REJECTED ("Rejected by QA Lead" here) included alongside RETURNED_BY_*
  // -- reported directly, a rejected certificate is now reopenable (edit +
  // resubmit) instead of a dead end.
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPT_HEAD_COE'].includes(status)
  const resubmitLabel = status === 'SM_REJECTED' ? 'Reopen Certificate' : 'Re-submit'
  // Reported directly: a person who raised this certificate but also
  // separately holds QA Lead/Executive COE must not be able to approve
  // their own certificate -- someone else holding that role must decide it
  // instead. Admin still bypasses (matches the backend's
  // require_not_requester, which enforces the same check server-side).
  const isSelfApproval = item.requester_id === user?.id && !isAdmin
  const canQALeadDecide = hasRole(user, 'QA_LEAD') && status === 'SM_APPROVAL_PENDING' && isQADepartment && !isSelfApproval
  const canExecutiveCoeDecide = hasRole(user, 'DEPARTMENT_HEAD_COE_CM', 'DEPARTMENT_HEAD_COE_AGM') && status === 'DEPT_HEAD_COE_APPROVAL_PENDING' && isQADepartment && !isSelfApproval
  // Reported directly: "only the assigned person can update" -- once the
  // certificate has moved past the requester, document control passes
  // exclusively to whoever it's actually sitting with now, matching the
  // backend's own (now-exclusive) _can_upload_documents (signoff.py).
  const canManageDocuments = isAdmin || (
    ['DRAFT', 'SUBMITTED', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPT_HEAD_COE'].includes(status) ? isRequester :
    status === 'SM_APPROVAL_PENDING' ? canQALeadDecide :
    status === 'DEPT_HEAD_COE_APPROVAL_PENDING' ? canExecutiveCoeDecide :
    false
  )
  // Requester's own editable statuses, or a QA Lead editing during approval.
  // routers/signoff.py::update_signoff.
  const canEditDetails = (isRequester && SIGNOFF_EDITABLE_STATUSES.includes(status))
    || (hasRole(user, 'QA_LEAD') && status === 'SM_APPROVAL_PENDING' && isQADepartment)

  return (
    <Modal title={item.certificate_id} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>Application:</strong> {item.application_name}</div>
        <div><strong>Status:</strong> <Badge status={item.status} label={SIGNOFF_STATUS_LABELS[item.status] || item.status} /></div>
        <div><strong>Testing Request ID:</strong> {item.testing_request_id || '—'}</div>
        <div><strong>Change Request ID(s):</strong> {item.change_request_ids || '—'}</div>
        <div><strong>Application Owner:</strong> {item.application_owner || '—'}</div>
        <div><strong>QA Approval Department:</strong> {item.department || QA_DEPARTMENT}</div>
        <div><strong>Requested By (QA Team):</strong> {userName(users, item.requester_id) || '—'}</div>
        <div><strong>Approved By (QA Lead):</strong> {userName(users, item.reviewed_by_id) || '—'}</div>
        <div><strong>Approved By (Executive COE):</strong> {userName(users, item.approved_by_id) || '—'}</div>
        <div><strong>Certificate Type:</strong> {item.certificate_type}</div>
        <div><strong>Testing Type:</strong> {item.testing_type}</div>
        <div><strong>Certificate Date:</strong> {item.certificate_date || '—'}</div>
        <div><strong>Vendor / SI Partner:</strong> {item.vendor_si_partner || '—'}</div>
        <div><strong>Technology Stack:</strong> {item.technology_stack || '—'}</div>
        <div><strong>Release / Build:</strong> {item.release_version || '—'} / {item.build_number || '—'}</div>
        <div><strong>Environment Tested:</strong> {item.environment_tested || '—'}</div>
        <div><strong>Target Promotion:</strong> {item.target_promotion_environment || '—'}</div>
        <div><strong>Risk Tier:</strong> {item.risk_tier || '—'}</div>
        <div><strong>Validity:</strong> {item.validity_from || '—'} to {item.validity_to || '—'}</div>
      </div>

      <div className="section-title">Exit Criteria &amp; Risk</div>
      <div className="grid grid-2">
        <div><strong>Exit Criteria Validation Notes:</strong>{item.exit_criteria_notes ? <MarkdownComment value={item.exit_criteria_notes} /> : '—'}</div>
        <div><strong>Open Defect Review Summary:</strong>{item.open_defect_summary ? <MarkdownComment value={item.open_defect_summary} /> : '—'}</div>
        <div><strong>Residual Risk Documentation:</strong>{item.residual_risk_notes ? <MarkdownComment value={item.residual_risk_notes} /> : '—'}</div>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '10px 0 0', flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/signoffs/${item.id}/export`, `${item.certificate_id}.pdf`)}>
          Export PDF
        </button>
        {canEditDetails && <button className="btn btn-sm" disabled={!!busyAction} onClick={() => setEditing(true)}>Edit Details</button>}
        {canSubmit && <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('submit')}>Submit for QA Lead Approval</button>}
        {canResubmit && <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('resubmit')}>{resubmitLabel}</button>}
      </div>

      {canQALeadDecide && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <ApprovalDecisionButtons
            userName={user?.full_name}
            comments={comments}
            busy={!!busyAction}
            onApprove={(signed) => act('qa-lead-decision', { decision: 'Approved', comments: signed })}
            onReturn={(actionNote) => act('qa-lead-decision', { decision: 'Returned', comments: actionNote })}
            onReject={(actionNote) => act('qa-lead-decision', { decision: 'Rejected', comments: actionNote })}
          />
        </div>
      )}
      {canExecutiveCoeDecide && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <ApprovalDecisionButtons
            userName={user?.full_name}
            comments={comments}
            busy={!!busyAction}
            approveLabel="Approve & Issue Certificate"
            onApprove={(signed) => act('executive-coe-decision', { decision: 'Approved', comments: signed })}
            onReturn={(actionNote) => act('executive-coe-decision', { decision: 'Returned', comments: actionNote })}
            onReject={(actionNote) => act('executive-coe-decision', { decision: 'Rejected', comments: actionNote })}
          />
        </div>
      )}

      <div className="section-title">Documents</div>
      <RequestDocuments apiBase="/api/signoffs" reqId={item.id} canManage={canManageDocuments} />

      <JiraActivity entityType="SIGNOFF" entityId={item.id} items={history} onPosted={(entry) => setHistory((prev) => [...prev, entry])} />

      {editing && (
        <EditSignOffModal
          item={item}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setEditing(false); onChanged(updated) }}
        />
      )}
    </Modal>
  )
}

export default function SignOff() {
  const { user } = useAuth()
  const [rows, setRows] = useState<SignOffOut[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<SignOffOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setRows(await api.get<SignOffOut[]>('/api/signoffs')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names just stay empty */ })
  }, [])

  // Same "?open=<certificate_id>" deep-link pattern as Functional/SAST/DAST/
  // Performance/Suppression -- lets the topbar search box jump straight to a
  // specific sign-off certificate's detail drawer instead of just landing on
  // this list.
  useEffect(() => {
    const openId = searchParams.get('open')
    if (!openId || rows.length === 0) return
    const match = rows.find((r) => r.certificate_id === openId)
    if (match) setSelected(match)
    setSearchParams((p) => { p.delete('open'); return p }, { replace: true })
  }, [rows, searchParams, setSearchParams])

  // Reported directly: "Hide QA Sign Off except IT-QA." Every certificate's
  // own department is hardcoded to QA_DEPARTMENT at creation (see
  // routers/signoff.py::create_signoff), and the list endpoint now scopes to
  // that (see ORACLE_MIGRATION_2026-07.md section 201) -- so anyone outside
  // canSeeQaDepartmentOnlyData would only ever land on a guaranteed-empty
  // page. The nav link is already hidden for them (see Layout.tsx); this is
  // the matching direct-URL guard, same "Access Restricted" pattern already
  // used by Admin.tsx/DepartmentAdmin.tsx.
  if (!canSeeQaDepartmentOnlyData(user)) {
    return (
      <Card title="Access Restricted">
        <p className="muted">QA Sign-off is only available to the {QA_DEPARTMENT} department.</p>
      </Card>
    )
  }

  const canCreate = hasRole(user, 'ADMIN')
    || (hasRole(user, 'QA_ENGINEER') && user?.department === QA_DEPARTMENT)

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="QA Sign-off Certificates" count={rows.length}
        subtitle="IT - QA clearance certificates: raised by QA, approved by the QA Lead, then issued after Executive COE approval."
        actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Sign-off Certificate</button>}
      />
      <Card>
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
          { key: 'certificate_id', header: 'Certificate ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'requester_id', header: 'Requested By', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
          { key: 'reviewed_by_id', header: 'Reviewed By', render: (r) => userName(users, r.reviewed_by_id) || '—', filterValue: (r) => userName(users, r.reviewed_by_id) || '' },
          { key: 'approved_by_id', header: 'Approved By', render: (r) => userName(users, r.approved_by_id) || '—', filterValue: (r) => userName(users, r.approved_by_id) || '' },
          { key: 'certificate_type', header: 'Type' },
          { key: 'testing_type', header: 'Testing Type' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} label={SIGNOFF_STATUS_LABELS[r.status] || r.status} /> },
          { key: 'pending_with', header: 'Pending With', render: (r) => SIGNOFF_PENDING_WITH[r.status] || '—', filterValue: (r) => SIGNOFF_PENDING_WITH[r.status] || '' },
        ]} rows={rows} />
      </Card>
      {showNew && <NewSignOffModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <SignOffDetail item={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} />}
    </div>
  )
}
