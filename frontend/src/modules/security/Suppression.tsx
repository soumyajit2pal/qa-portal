import WorkflowStatusBadge from '../../components/WorkflowStatusBadge'
import { useRequestNavigation, useViewerManagedDeepLinks } from '../../hooks/useRequestNavigation'
import React, { useEffect, useState, useCallback, useRef } from 'react'
import {useSearchParams} from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, WorkflowDecisionPanel, RequestDocuments } from '../../components/Common'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import { SEVERITIES, SUPPRESSION_STATUS_LABELS, SUPPRESSION_PENDING_WITH, SUPPRESSION_REQUESTER_CONTROLLED_STATUSES, SAST_DAST_PRE_SCANNING_STATUSES, SAST_DAST_COMPLETED_STATUSES, QA_REQUEST_CREATOR_ROLES, hasWorkflowRole as hasRole, hasDepartment, isViewOnly } from '../../constants'
import {
  SASTListOut, DASTListOut, SASTOut, DASTOut, SuppressionOut,
  CombinedSecurityRequest, UserOption, ApprovalActionOut,
  SuppressionApprovalDepartmentOption, SuppressionApprovalDepartmentOptionsOut,
} from '../../types'
import ClearableSearchInput from '../../components/ClearableSearchInput'
import InfoModal from '../../components/InfoModal'
import { isKeyboardActivationKey } from '../../keyboard'
import { formatDateTimeIST } from '../../time'
import SuppressionDepartmentApprovalRouting from './SuppressionDepartmentApprovalRouting'

function userName(users: UserOption[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

function suppressionPendingWith(suppression: SuppressionOut): string {
  if (suppression.status !== 'DEPARTMENT_HEAD_APPROVAL_PENDING') {
    return SUPPRESSION_PENDING_WITH[suppression.status] || '—'
  }
  const departments = (suppression.department_approvals || [])
    .filter((approval) => approval.decision === 'Pending')
    .map((approval) => approval.department_name?.trim())
    .filter((name): name is string => Boolean(name))
  if (!departments.length) return SUPPRESSION_PENDING_WITH[suppression.status] || '—'
  return `${departments.length === 1 ? 'Department Head' : 'Department Heads'}: ${departments.join(', ')}`
}

function departmentApprovalSummary(suppression: SuppressionOut): string {
  const approvals = suppression.department_approvals || []
  if (!approvals.length) return suppression.dept_head_decision || 'Pending'
  const approved = approvals.filter((approval) => approval.decision === 'Approved').length
  if (approvals.every((approval) => approval.decision === 'Approved')) return 'Approved by all required departments'
  if (approvals.some((approval) => approval.decision === 'Rejected')) return 'Rejected'
  if (approvals.some((approval) => approval.decision === 'Returned')) return 'Returned to requester'
  return `${approved} of ${approvals.length} required departments approved`
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
  risk_assessment: '', additional_department_ids: [] as number[], items: [{ ...EMPTY_ITEM }] as SuppressionItemForm[],
}
type SuppressionForm = typeof EMPTY_FORM

function pickerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unable to load options.')
}

function PickerLoadNotice({ label, error, loading, onRetry }: {
  label: string
  error?: unknown
  loading?: boolean
  onRetry: () => void
}) {
  if (loading) return <p className="muted small" role="status">Loading {label}…</p>
  if (!error) return null
  return (
    <div className="execution-cycle-required-warning" role="alert">
      <span>Could not load {label}: {pickerErrorMessage(error)}</span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>Retry</button>
    </div>
  )
}

// Searchable "Request ID" autosuggest -- covers BOTH SAST and DAST requests
// together (each tagged with its _kind) so the requester doesn't have to
// pick a scan type before searching; selecting a match hands the full record
// back to the caller, which derives scan type from it and auto-populates
// Application Name / Department / Owner.
function RequestIdSearch({ requests, selected, onSelect, onClear, loading = false }: {
  requests: CombinedSecurityRequest[]
  selected: CombinedSecurityRequest | null
  onSelect: (r: CombinedSecurityRequest) => void
  onClear: () => void
  loading?: boolean
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
        aria-busy={loading}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onClear={() => { setQuery(''); setOpen(true) }}
        clearLabel="Clear security request search"
      />
      {open && (
        <div className="searchable-select-panel">
          <div className="searchable-select-list" role="listbox" aria-label="Matching SAST and DAST requests">
            {loading && <div className="searchable-select-empty" role="status">Loading SAST/DAST requests…</div>}
            {!loading && matches.length === 0 && <div className="searchable-select-empty">No eligible SAST/DAST requests found.</div>}
            {matches.map((r) => (
              <div key={`${r._kind}-${r.id}`} className="searchable-select-option" role="option" aria-selected={false} tabIndex={0}
                   onClick={() => { onSelect(r); setQuery(''); setOpen(false) }}
                   onKeyDown={(event) => { if (isKeyboardActivationKey(event.key)) { event.preventDefault(); onSelect(r); setQuery(''); setOpen(false) } }}>
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

export function NewSuppressionModal({ onClose, onCreated, initialRequest }: {
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
  const [departments, setDepartments] = useState<SuppressionApprovalDepartmentOption[]>([])
  const [owningDepartmentEligible, setOwningDepartmentEligible] = useState<boolean | null>(null)
  const [requestPickerLoading, setRequestPickerLoading] = useState(true)
  const [requestPickerErrors, setRequestPickerErrors] = useState<{ sast?: unknown; dast?: unknown }>({})
  const [departmentsLoading, setDepartmentsLoading] = useState(false)
  const [departmentsError, setDepartmentsError] = useState<unknown>(null)
  const [needsAdditionalApprovals, setNeedsAdditionalApprovals] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // Keep the shared creation flow open after the POST succeeds and replace
  // the form with the same acknowledgement modal used by QA Requests. This
  // applies to all three entry points (Suppression register, SAST Findings,
  // and DAST Findings) without each parent having to reproduce the notice.
  const [created, setCreated] = useState<SuppressionOut | null>(null)
  const departmentOptionsRequest = useRef(0)
  function set<K extends keyof SuppressionForm>(k: K, v: SuppressionForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  const loadRequestPicker = useCallback(async () => {
    // Picker candidates only -- fetches the lightweight PAG-005 list shape,
    // large page_size since this is a client-side-filtered autosuggest, not
    // a paginated table (see inScope/hasReachedScanning/isNotYetCompleted
    // below). Only ever used for the manual "Change"/search picker now --
    // see the separate direct-fetch effect below for the initialRequest
    // (deep-linked) case.
    setRequestPickerLoading(true)
    const [sast, dast] = await Promise.allSettled([
      api.getAll<SASTListOut>('/api/sast-requests'),
      api.getAll<DASTListOut>('/api/dast-requests'),
    ])
    if (sast.status === 'fulfilled') setSastRequests(sast.value)
    if (dast.status === 'fulfilled') setDastRequests(dast.value)
    setRequestPickerErrors({
      sast: sast.status === 'rejected' ? sast.reason : undefined,
      dast: dast.status === 'rejected' ? dast.reason : undefined,
    })
    setRequestPickerLoading(false)
  }, [])
  useEffect(() => { void loadRequestPicker() }, [loadRequestPicker])

  const loadDepartments = useCallback(async () => {
    const requestVersion = ++departmentOptionsRequest.current
    if (!selectedRef) {
      setDepartments([])
      setOwningDepartmentEligible(null)
      setDepartmentsError(null)
      setDepartmentsLoading(false)
      return
    }
    setDepartmentsLoading(true)
    setDepartmentsError(null)
    setOwningDepartmentEligible(null)
    const parameter = selectedRef._kind === 'SAST' ? 'sast_request_id' : 'dast_request_id'
    try {
      const result = await api.get<SuppressionApprovalDepartmentOptionsOut>(
        `/api/suppressions/approval-department-options?${parameter}=${selectedRef.id}`,
      )
      if (requestVersion !== departmentOptionsRequest.current) return
      setDepartments(result.departments)
      setOwningDepartmentEligible(result.owning_department_eligible)
      const eligibleIds = new Set(result.departments.map((department) => department.id))
      setForm((current) => ({
        ...current,
        additional_department_ids: current.additional_department_ids.filter((id) => eligibleIds.has(id)),
      }))
    } catch (err) {
      if (requestVersion !== departmentOptionsRequest.current) return
      setDepartments([])
      setDepartmentsError(err)
    } finally {
      if (requestVersion === departmentOptionsRequest.current) setDepartmentsLoading(false)
    }
  }, [selectedRef])
  useEffect(() => { void loadDepartments() }, [loadDepartments])

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
    setNeedsAdditionalApprovals(false)
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
      // Approval eligibility is workspace-specific. A different linked scan
      // can route to a different workspace, so never carry old choices into
      // the new context while its eligible subset is being loaded.
      additional_department_ids: [],
    }))
  }

  function clearRequest() {
    setSelectedRef(null)
    setNeedsAdditionalApprovals(false)
    setForm((f) => ({
      ...f,
      sast_request_id: null,
      dast_request_id: null,
      application_name: '',
      department: '',
      application_owner: '',
      additional_department_ids: [],
    }))
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
    if (departmentsLoading) {
      setError(new Error('Wait for the eligible Department Head approval routes to finish loading.'))
      return
    }
    if (departmentsError || owningDepartmentEligible === null) {
      setError(new Error('Eligible approval departments could not be verified. Retry loading them before submitting.'))
      return
    }
    if (!owningDepartmentEligible) {
      setError(new Error(`No eligible Department Head can approve for the owning department '${form.department}' in this workspace.`))
      return
    }
    if (needsAdditionalApprovals && form.additional_department_ids.length === 0) {
      setError(new Error('Select at least one additional department for approval.'))
      return
    }
    setBusy(true)
    setError(null)
    try { setCreated(await api.post<SuppressionOut>('/api/suppressions', form)) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  // Creation deliberately produces a Draft; calling it "raised" here would
  // imply that the approval workflow has already started. The acknowledgement
  // makes the saved state, linked request, and required next action explicit.
  if (created) {
    const linkedRequestId = created.linked_request?.request_id || selectedRef?.request_id || '—'
    const findingCount = created.items.length
    return (
      <InfoModal title="Suppression Request Saved as Draft" onClose={() => onCreated(created)}>
        <p style={{ marginTop: -4 }}>
          <strong>{created.suppression_id}</strong> has been created and linked to{' '}
          <strong>{linkedRequestId}</strong> for <strong>{created.application_name}</strong>.
        </p>
        <p className="muted small">
          {findingCount} {findingCount === 1 ? 'finding is' : 'findings are'} included. This request is still a{' '}
          <strong>Draft</strong> and has not entered the approval workflow yet.
          Open the suppression request and select <strong>Submit for SM Approval</strong> when it is ready.
        </p>
      </InfoModal>
    )
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
              <RequestIdSearch requests={combinedRequests} selected={selectedRef} onSelect={selectRequest} onClear={clearRequest} loading={requestPickerLoading} />
            </Field>
            <PickerLoadNotice label="SAST requests" error={requestPickerErrors.sast} onRetry={() => void loadRequestPicker()} />
            <PickerLoadNotice label="DAST requests" error={requestPickerErrors.dast} onRetry={() => void loadRequestPicker()} />
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Only showing eligible SAST/DAST requests you raised. Selecting one
              auto-fills the application details below.
            </p>
          </div>

          <div className="form-section">
            <div className="form-section-title">Application Details</div>
            <div className="form-row">
              <Field label="Scan Type *">
                <div className="system-select">
                  <select required value={form.scan_type} disabled>
                    <option value="SAST">SAST</option><option value="DAST">DAST</option>
                  </select>
                  <span aria-hidden="true">⌄</span>
                </div>
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
                  <Field label="Issue Group *"><input required value={item.issue_id} onChange={(e) => setItem(idx, 'issue_id', e.target.value)} /></Field>
                  <Field label="Severity *">
                    <div className="system-select">
                      <select required value={item.severity} onChange={(e) => setItem(idx, 'severity', e.target.value)}>
                        {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <span aria-hidden="true">⌄</span>
                    </div>
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

          <SuppressionDepartmentApprovalRouting
            departments={departments}
            owningDepartment={form.department}
            selectedDepartmentIds={form.additional_department_ids}
            requiresAdditionalApprovals={needsAdditionalApprovals}
            onRequirementChange={setNeedsAdditionalApprovals}
            onChange={(departmentIds) => set('additional_department_ids', departmentIds)}
            owningDepartmentEligible={owningDepartmentEligible}
            loading={departmentsLoading}
            error={departmentsError}
            onRetry={() => void loadDepartments()}
          />

          <div className="form-section">
            <div className="form-section-title">Risk Assessment</div>
            <Field label="Risk Assessment &amp; Acknowledgement (overall) *">
              <textarea required value={form.risk_assessment} onChange={(e) => set('risk_assessment', e.target.value)} />
            </Field>
          </div>

          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <button
              className="btn btn-primary"
              disabled={busy || Boolean(selectedRef && (
                departmentsLoading || departmentsError || owningDepartmentEligible !== true
              ))}
            >{busy ? 'Submitting...' : 'Submit Request'}</button>
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
// raised suppression at a *different* SAST/DAST request only while the
// requester owns the next action (Draft or Returned). A relink changes the
// approval context and therefore resets a returned request to Draft on the
// backend. "Delink" is deliberately not a
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
  const [pickerLoading, setPickerLoading] = useState(true)
  const [pickerErrors, setPickerErrors] = useState<{ sast?: unknown; dast?: unknown }>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const loadPicker = useCallback(async () => {
    setPickerLoading(true)
    const [sast, dast] = await Promise.allSettled([
      api.getAll<SASTListOut>('/api/sast-requests'),
      api.getAll<DASTListOut>('/api/dast-requests'),
    ])
    if (sast.status === 'fulfilled') setSastRequests(sast.value)
    if (dast.status === 'fulfilled') setDastRequests(dast.value)
    setPickerErrors({
      sast: sast.status === 'rejected' ? sast.reason : undefined,
      dast: dast.status === 'rejected' ? dast.reason : undefined,
    })
    setPickerLoading(false)
  }, [])
  useEffect(() => { void loadPicker() }, [loadPicker])

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
  function isCurrentLink(r: CombinedSecurityRequest): boolean {
    return r._kind === sup.scan_type
      && (r._kind === 'SAST' ? sup.sast_request_id : sup.dast_request_id) === r.id
  }

  const combinedRequests: CombinedSecurityRequest[] = ([
    ...sastRequests.filter(inScope).filter(hasReachedScanning).filter(isNotYetCompleted).map((r) => ({ ...r, _kind: 'SAST' as const })),
    ...dastRequests.filter(inScope).filter(hasReachedScanning).filter(isNotYetCompleted).map((r) => ({ ...r, _kind: 'DAST' as const })),
  ] as CombinedSecurityRequest[]).filter((request) => !isCurrentLink(request))

  async function submit() {
    if (!selectedRef) { setError(new Error('Select a SAST/DAST Request ID to relink to.')); return }
    if (isCurrentLink(selectedRef)) {
      setError(new Error('This suppression is already linked to the selected SAST/DAST request. Choose a different request.'))
      return
    }
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
        be re-derived from the new link. Relinking clears prior approval progress and returns the
        suppression to Draft so the updated request follows the complete approval workflow.
      </p>
      <Field label="SAST / DAST Request ID *">
        <RequestIdSearch requests={combinedRequests} selected={selectedRef} onSelect={setSelectedRef} onClear={() => setSelectedRef(null)} loading={pickerLoading} />
      </Field>
      <PickerLoadNotice label="SAST requests" error={pickerErrors.sast} onRetry={() => void loadPicker()} />
      <PickerLoadNotice label="DAST requests" error={pickerErrors.dast} onRetry={() => void loadPicker()} />
      <ErrorText error={error} />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy || !selectedRef} onClick={submit}>{busy ? 'Relinking...' : 'Relink'}</button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

function EditSuppressionModal({ sup, onClose, onSaved }: {
  sup: SuppressionOut
  onClose: () => void
  onSaved: (s: SuppressionOut) => void
}) {
  const routingEditable = ['Draft', 'RETURNED_BY_SM'].includes(sup.status)
  const initialAdditionalDepartmentIds = sup.department_approvals
    .filter((approval) => approval.department_name !== sup.department)
    .map((approval) => approval.department_id)
  const [form, setForm] = useState<SuppressionForm>(() => ({
    scan_type: sup.scan_type,
    sast_request_id: sup.sast_request_id ?? null,
    dast_request_id: sup.dast_request_id ?? null,
    application_name: sup.application_name,
    department: sup.department || '',
    application_owner: sup.application_owner || '',
    risk_assessment: sup.risk_assessment || '',
    additional_department_ids: initialAdditionalDepartmentIds,
    items: sup.items.map((item) => ({
      issue_id: item.issue_id || '',
      severity: item.severity || 'Medium',
      description: item.description || '',
      justification: item.justification || '',
    })),
  }))
  const [departments, setDepartments] = useState<SuppressionApprovalDepartmentOption[]>([])
  const [owningDepartmentEligible, setOwningDepartmentEligible] = useState<boolean | null>(
    routingEditable ? null : true,
  )
  const [departmentsLoading, setDepartmentsLoading] = useState(routingEditable)
  const [departmentsError, setDepartmentsError] = useState<unknown>(null)
  const [needsAdditionalApprovals, setNeedsAdditionalApprovals] = useState(
    initialAdditionalDepartmentIds.length > 0,
  )
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const loadDepartments = useCallback(async () => {
    if (!routingEditable) return
    setDepartmentsLoading(true)
    setDepartmentsError(null)
    setOwningDepartmentEligible(null)
    try {
      const result = await api.get<SuppressionApprovalDepartmentOptionsOut>(
        `/api/suppressions/${sup.id}/approval-department-options`,
      )
      setDepartments(result.departments)
      setOwningDepartmentEligible(result.owning_department_eligible)
    }
    catch (err) {
      setDepartments([])
      setDepartmentsError(err)
    }
    finally { setDepartmentsLoading(false) }
  }, [routingEditable, sup.id])
  useEffect(() => { void loadDepartments() }, [loadDepartments])

  const eligibleDepartmentIds = new Set(departments.map((department) => department.id))
  const unavailableSelectedDepartmentIds = owningDepartmentEligible === null
    ? []
    : form.additional_department_ids.filter((departmentId) => !eligibleDepartmentIds.has(departmentId))

  function setItem<K extends keyof SuppressionItemForm>(idx: number, key: K, value: SuppressionItemForm[K]) {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, itemIdx) => itemIdx === idx ? { ...item, [key]: value } : item),
    }))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (routingEditable && departmentsLoading) {
      setError(new Error('Wait for the eligible Department Head approval routes to finish loading.'))
      return
    }
    if (routingEditable && (departmentsError || owningDepartmentEligible === null)) {
      setError(new Error('Eligible approval departments could not be verified. Retry loading them before saving.'))
      return
    }
    if (routingEditable && !owningDepartmentEligible) {
      setError(new Error(`No eligible Department Head can approve for the owning department '${form.department}' in this workspace.`))
      return
    }
    if (routingEditable && unavailableSelectedDepartmentIds.length > 0) {
      setError(new Error('Remove departments marked unavailable before saving the approval route.'))
      return
    }
    if (routingEditable && needsAdditionalApprovals && form.additional_department_ids.length === 0) {
      setError(new Error('Select at least one additional department for approval.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.put<SuppressionOut>(`/api/suppressions/${sup.id}`, form))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Edit ${sup.suppression_id}`} onClose={onClose} wide>
      <div className="suppression-form">
        <form onSubmit={submit}>
          <div className="form-section">
            <div className="form-section-title">Linked Security Request</div>
            <div className="form-row">
              <Field label="Request ID"><input disabled value={sup.linked_request?.request_id || '—'} /></Field>
              <Field label="Scan Type"><input disabled value={form.scan_type} /></Field>
              <Field label="Application Name"><input disabled value={form.application_name} /></Field>
              <Field label="Department"><input disabled value={form.department} /></Field>
            </div>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Use Relink from the Overview tab if the linked SAST/DAST request is incorrect.
            </p>
          </div>

          <SuppressionDepartmentApprovalRouting
            departments={departments}
            owningDepartment={form.department}
            selectedDepartmentIds={form.additional_department_ids}
            requiresAdditionalApprovals={needsAdditionalApprovals}
            onRequirementChange={setNeedsAdditionalApprovals}
            onChange={(departmentIds) => setForm((current) => ({
              ...current,
              additional_department_ids: departmentIds,
            }))}
            owningDepartmentEligible={owningDepartmentEligible}
            loading={departmentsLoading}
            error={departmentsError}
            onRetry={() => void loadDepartments()}
            editable={routingEditable}
            lockedApprovals={sup.department_approvals}
          />

          <div className="form-section">
            <div className="form-section-title">Findings to Suppress</div>
            {form.items.map((item, idx) => (
              <div key={idx} className="card" style={{ padding: 14, marginBottom: 12 }}>
                <div className="form-row" style={{ marginBottom: 8 }}>
                  <Field label="Issue Group *"><input required value={item.issue_id} onChange={(e) => setItem(idx, 'issue_id', e.target.value)} /></Field>
                  <Field label="Severity *">
                    <select required value={item.severity} onChange={(e) => setItem(idx, 'severity', e.target.value)}>
                      {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="Issue Description *"><textarea required value={item.description} onChange={(e) => setItem(idx, 'description', e.target.value)} /></Field>
                <Field label="Justification *"><textarea required value={item.justification} onChange={(e) => setItem(idx, 'justification', e.target.value)} /></Field>
                {form.items.length > 1 && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setForm((current) => ({ ...current, items: current.items.filter((_, itemIdx) => itemIdx !== idx) }))}>
                    Remove Finding
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setForm((current) => ({ ...current, items: [...current.items, { ...EMPTY_ITEM }] }))}>
              + Add Another Finding
            </button>
          </div>

          <div className="form-section">
            <div className="form-section-title">Risk Assessment</div>
            <Field label="Risk Assessment &amp; Acknowledgement *">
              <textarea required value={form.risk_assessment} onChange={(e) => setForm((current) => ({ ...current, risk_assessment: e.target.value }))} />
            </Field>
          </div>

          <ErrorText error={error} />
          <div className="modal-actions">
            <button
              className="btn btn-primary"
              disabled={busy || Boolean(routingEditable && (
                departmentsLoading || departmentsError || owningDepartmentEligible !== true
                || unavailableSelectedDepartmentIds.length > 0
              ))}
            >{busy ? 'Saving…' : 'Save Changes'}</button>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </Modal>
  )
}

export function SuppressionDetail({ sup, onClose, onChanged, users }: { sup: SuppressionOut; onClose: () => void; onChanged: (s: SuppressionOut) => void; users: UserOption[] }) {
  const { user } = useAuth()
  const [tab, setTab] = useState<'overview' | 'documents' | 'history'>('overview')
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [comments, setComments] = useState('')
  const [remarksDecision, setRemarksDecision] = useState<'return' | 'reject' | null>(null)
  const [decisionDepartmentId, setDecisionDepartmentId] = useState<number | null>(null)
  // Whether the "require Department Head re-approval on return" popup (see
  // canSecurityDecide below) is open -- an always-visible checkbox next to
  // "Return to Requester" was easy to miss, so this is now asked as a pop-up
  // at the moment of returning it instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false)
  const [showRelink, setShowRelink] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const refreshInFlight = useRef(false)

  const loadExtras = useCallback(async () => {
    try {
      setHistory(await api.get<ApprovalActionOut[]>(`/api/suppressions/${sup.id}/history`))
    } catch (err) { setError(err) }
  }, [sup.id])
  useEffect(() => { loadExtras() }, [loadExtras])

  const refreshCurrent = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try { onChanged(await api.get<SuppressionOut>(`/api/suppressions/${sup.id}`)) }
    catch (err) { setError(err) }
    finally { refreshInFlight.current = false }
  }, [onChanged, sup.id])
  useEffect(() => {
    // Required Department Heads decide in parallel, often from different
    // browsers. Refresh the open record whenever this tab regains focus so
    // completed rows/actions do not remain stale for the next approver.
    const onFocus = () => { void refreshCurrent() }
    const onVisibility = () => { if (document.visibilityState === 'visible') void refreshCurrent() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshCurrent])

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

  const viewOnly = isViewOnly(user)
  const isRequester = (!viewOnly && sup.created_by_id === user?.id) || hasRole(user, 'ADMIN')
  const status = sup.status
  // SM/Department Head approvals are department-scoped -- see the comment in
  // QARequests.tsx. Security Team verification is NOT department-scoped
  // (it's the QA/security side receiving the request).
  const sameDept = hasDepartment(user, sup.department)

  // Relinking changes both the owning department and the people whose
  // approval is required. Keep it exclusively in requester-controlled
  // stages; the backend resets a relinked returned request to Draft so no
  // approval from the previous link can be carried forward.
  const canRelink = isRequester && SUPPRESSION_REQUESTER_CONTROLLED_STATUSES.includes(status)
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
  const eligibleDepartmentApprovals = (sup.department_approvals || []).filter((approval) => (
    approval.decision === 'Pending'
    && (hasRole(user, 'ADMIN') || hasDepartment(user, approval.department_name))
  ))
  const selectedDepartmentApproval = eligibleDepartmentApprovals.find(
    (approval) => approval.department_id === decisionDepartmentId,
  ) || eligibleDepartmentApprovals[0]
  const isPriorSMChecker = sup.sm_id === user?.id && !user?.roles?.includes('ADMIN')
  const canDeptHeadDecide = hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM')
    && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && eligibleDepartmentApprovals.length > 0 && !isSelfApproval && !isPriorSMChecker
  const isPriorDepartmentChecker = !user?.roles?.includes('ADMIN') && (
    sup.dept_head_id === user?.id
    || (sup.department_approvals || []).some(approval => approval.approver_id === user?.id)
  )
  const canSecurityDecide = hasRole(user, 'SECURITY_ANALYST')
    && status === 'SECURITY_TEAM_VERIFICATION' && !isPriorDepartmentChecker
  // Reviewers decide the submitted version; they never edit it in place.
  // If an SM or any required Department Head needs a correction, Return
  // (whose dialog requires remarks) hands it back to the requester. Admin
  // retains the existing requester override, but only in these same stages.
  const canEditDetails = !viewOnly && isRequester && SUPPRESSION_REQUESTER_CONTROLLED_STATUSES.includes(status)
  // Evidence changes belong to the requester. Reviewers must return the
  // request with remarks instead of mutating the version they are deciding.
  // Preserve the existing System Admin maintenance exception.
  const canManageDocuments = user?.roles?.includes('ADMIN') || (
    !viewOnly && sup.created_by_id === user?.id && SUPPRESSION_REQUESTER_CONTROLLED_STATUSES.includes(status)
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
        <div className="suppression-approval-detail">
          <div className="grid grid-2 suppression-overview-grid">
            <div><strong>Status:</strong> <WorkflowStatusBadge record={sup} status={status} label={SUPPRESSION_STATUS_LABELS[status] || status} /></div>
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
            <div><strong>Overall Department Approval:</strong> {departmentApprovalSummary(sup)}</div>
            <div><strong>Security Team Decision:</strong> {sup.security_decision || 'Pending'}</div>
            <div><strong>Raised At:</strong> {formatDateTimeIST(sup.created_at)}</div>
            <div><strong>Pending With:</strong> {suppressionPendingWith(sup)}</div>
          </div>

          <div className="section-title">Required Department Head Approvals</div>
          <Table rowKey="id" columns={[
            { key: 'department_name', header: 'Department', filterable: false, render: (approval) => approval.department_name || '—' },
            { key: 'decision', header: 'Decision', filterable: false, render: (approval) => <Badge status={approval.decision} /> },
            { key: 'approver_name', header: 'Decided By', filterable: false, render: (approval) => approval.approver_name || '—' },
            { key: 'decided_at', header: 'Decided At', filterable: false, render: (approval) => approval.decided_at ? formatDateTimeIST(approval.decided_at) : '—' },
          ]} rows={sup.department_approvals || []} pageSize={Math.max((sup.department_approvals || []).length, 1)} showColumnControls={false} />

          {status === 'RETURNED_BY_SECURITY_TEAM' && sup.needs_dept_head_reapproval && (
            <div className="execution-cycle-required-warning" role="status">
              <strong>Department Head re-approval required</strong>
              <span>
                Security Team returned this request for correction. After the requester updates and
                re-submits it, the request will go to all required Department Heads before returning to Security Team verification.
              </span>
            </div>
          )}

          <div className="section-title">Findings ({sup.items.length})</div>
          <div className="suppression-findings-review">
            {sup.items.map((finding, index) => (
              <article className="suppression-finding-review" key={finding.id}>
                <header>
                  <div>
                    <small>Finding {index + 1}</small>
                    <strong>{finding.issue_id || 'Issue group not provided'}</strong>
                  </div>
                  <span className="suppression-finding-severity">{finding.severity || '—'}</span>
                </header>
                <div className="suppression-finding-copy-grid">
                  <section>
                    <h3>Description</h3>
                    <p>{finding.description || '—'}</p>
                  </section>
                  <section>
                    <h3>Justification</h3>
                    <p>{finding.justification || '—'}</p>
                  </section>
                </div>
              </article>
            ))}
          </div>

          <section className="suppression-risk-assessment" aria-labelledby="suppression-risk-assessment-title">
            <h3 id="suppression-risk-assessment-title">Risk Assessment &amp; Acknowledgement</h3>
            <p>{sup.risk_assessment || '—'}</p>
          </section>

          <section className="suppression-workflow-section" aria-labelledby="suppression-workflow-title">
            <div className="suppression-workflow-heading">
              <div>
                <span>Decision centre</span>
                <div className="section-title" id="suppression-workflow-title">Workflow Actions</div>
              </div>
              <div className="suppression-workflow-utilities">
                <button type="button" className="btn btn-sm" onClick={() => api.downloadFile(`/api/suppressions/${sup.id}/export`, `${sup.suppression_id}.pdf`)}>
                  Export PDF
                </button>
                {canEditDetails && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing(true)}>Edit Details</button>}
              </div>
            </div>

            {(canSubmit || canResubmit) && (
              <div className="suppression-requester-actions">
                <div>
                  <small>Requester action</small>
                  <strong>{canSubmit ? 'Submit the completed request for approval' : 'Send the corrected request back into approval'}</strong>
                  <span>Confirm that the request details and supporting evidence are complete before continuing.</span>
                </div>
                {canSubmit && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('submit')}>Submit for SM Approval</button>}
                {canResubmit && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('resubmit')}>Re-submit</button>}
              </div>
            )}

            {canSMDecide && (
              <div className="suppression-approval-surface">
                <div className="suppression-workflow-context">
                  <div>
                    <small>Senior manager approval</small>
                    <strong>{sup.department || 'Owning department'}</strong>
                    <span>Approve to route this request to every required Department Head, or return it to the requester with remarks.</span>
                  </div>
                  <Badge status="Pending" />
                </div>
                <div className="suppression-workflow-content">
                  <ApprovalDecisionButtons
                    userName={user?.full_name}
                    comments={comments}
                    busy={busy}
                    approveLabel="Approve"
                    onApprove={(signed) => act('sm-decision', { decision: 'Approved', comments: signed })}
                    onReturn={(actionNote) => act('sm-decision', { decision: 'Returned', comments: actionNote })}
                    onReject={(actionNote) => act('sm-decision', { decision: 'Rejected', comments: actionNote })}
                  />
                </div>
              </div>
            )}

            {canDeptHeadDecide && (
              <div className="suppression-approval-surface">
                <div className="suppression-workflow-context">
                  <div>
                    <small>Reviewing on behalf of</small>
                    <strong>{selectedDepartmentApproval?.department_name || 'Required department'}</strong>
                    <span>Approve, return with remarks, or reject. Request data remains read-only for approving departments.</span>
                  </div>
                  <div className="suppression-workflow-context-control">
                    {eligibleDepartmentApprovals.length > 1 && (
                      <label className="suppression-department-decision-select">
                        <span>Department approval</span>
                        <select
                          value={selectedDepartmentApproval?.department_id || ''}
                          onChange={(event) => setDecisionDepartmentId(Number(event.target.value))}
                        >
                          {eligibleDepartmentApprovals.map((approval) => (
                            <option key={approval.id} value={approval.department_id}>{approval.department_name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <Badge status="Pending" />
                  </div>
                </div>
                <div className="suppression-workflow-content">
                  <ApprovalDecisionButtons
                    userName={user?.full_name}
                    comments={comments}
                    busy={busy}
                    approveLabel="Approve"
                    onApprove={(signed) => act('dept-head-decision', { department_id: selectedDepartmentApproval?.department_id, decision: 'Approved', comments: signed })}
                    onReturn={(actionNote) => act('dept-head-decision', { department_id: selectedDepartmentApproval?.department_id, decision: 'Returned', comments: actionNote })}
                    onReject={(actionNote) => act('dept-head-decision', { department_id: selectedDepartmentApproval?.department_id, decision: 'Rejected', comments: actionNote })}
                  />
                </div>
              </div>
            )}

            {canSecurityDecide && (
              <div className="suppression-approval-surface">
                <div className="suppression-workflow-context">
                  <div>
                    <small>Security verification</small>
                    <strong>Final suppression decision</strong>
                    <span>Review the approved request and choose the final security outcome.</span>
                  </div>
                  <Badge status="Pending" />
                </div>
                <div className="suppression-security-decision">
                  <WorkflowDecisionPanel busy={busy} title="Security verification decision" options={[
                    { key: 'accept', label: 'Accept & mark done', description: 'Complete the suppression workflow', tone: 'approve', onClick: () => act('security-team-decision', { decision: 'Accepted', comments }) },
                    { key: 'return', label: 'Return to Requester', description: 'Send back for corrections and resubmission', tone: 'return', onClick: () => setRemarksDecision('return') },
                    { key: 'reject', label: 'Reject', description: 'Stop and close this approval path', tone: 'reject', onClick: () => setRemarksDecision('reject') },
                  ]} />
                </div>
              </div>
            )}
            {remarksDecision && (
              <Modal
                title={remarksDecision === 'return' ? 'Return to Requester' : 'Reject suppression request'}
                onClose={() => { setRemarksDecision(null); setComments('') }}
                variant="dialog"
                preventBackdropClose
              >
                <Field label="Remarks *">
                  <textarea
                    required
                    rows={4}
                    value={comments}
                    onChange={(event) => setComments(event.target.value)}
                    placeholder={`Explain why this request is being ${remarksDecision === 'return' ? 'returned' : 'rejected'}…`}
                  />
                </Field>
                <div className="modal-actions">
                  <button
                    type="button"
                    className={remarksDecision === 'reject' ? 'btn btn-danger' : 'btn btn-primary'}
                    disabled={busy || !comments.trim()}
                    onClick={() => {
                      if (remarksDecision === 'return') {
                        setRemarksDecision(null)
                        setShowReapprovalConfirm(true)
                      } else {
                        setRemarksDecision(null)
                        act('security-team-decision', { decision: 'Rejected', comments: comments.trim() })
                      }
                    }}
                  >
                    Continue
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => { setRemarksDecision(null); setComments('') }}>Cancel</button>
                </div>
              </Modal>
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
                  act('security-team-decision', { decision: 'Returned', comments: comments.trim(), require_dept_head_reapproval: true })
                }}
                onCancel={() => {
                  setShowReapprovalConfirm(false)
                  act('security-team-decision', { decision: 'Returned', comments: comments.trim(), require_dept_head_reapproval: false })
                }}
              />
            )}
          </section>
        </div>
      )}

      {tab === 'history' && (
        <JiraActivity ownerWorkspaceId={sup.qa_workspace_id} entityType="SUPPRESSION" entityId={sup.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/suppressions" reqId={sup.id} canManage={canManageDocuments} />}

      {showRelink && (
        <RelinkSuppressionModal
          sup={sup}
          onClose={() => setShowRelink(false)}
          onRelinked={(updated) => { setShowRelink(false); onChanged(updated) }}
        />
      )}
      {editing && (
        <EditSuppressionModal
          sup={sup}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setEditing(false); onChanged(updated); loadExtras() }}
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
  const viewerManagedDeepLinks = useViewerManagedDeepLinks()
  const { user } = useAuth()
  const navigate = useRequestNavigation()
  const [rows, setRows] = useState<SuppressionOut[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<SuppressionOut | null>(null)
  const [users, setUsers] = useState<UserOption[]>([])
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const load = useCallback(async () => {
    try { setRows(await api.get<SuppressionOut[]>('/api/suppressions')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const refreshOnFocus = () => { void load() }
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [load])
  useEffect(() => {
    api.get<UserOption[]>('/api/auth/user-options').then(setUsers).catch(() => { /* names just stay empty */ })
  }, [])

  // Same "?open=<suppression_id>" deep-link pattern as Functional/SAST/DAST/
  // Performance (see e.g. Functional.tsx) -- lets the topbar search box and
  // the Linked Requests table jump straight to a specific suppression's
  // detail drawer instead of just landing on this list.
  useEffect(() => {
    if (viewerManagedDeepLinks) return
    const recordId = Number(searchParams.get('openId'))
    const openId = searchParams.get('open')
    if (Number.isInteger(recordId) && recordId > 0) {
      api.get<SuppressionOut>(`/api/suppressions/${recordId}`).then(setSelected).catch(setError)
    } else if (openId) {
      const match = rows.find((r) => r.suppression_id === openId)
      if (!match) return
      setSelected(match)
    } else return
    setSearchParams((p) => { p.delete('open'); p.delete('openId'); return p }, { replace: true })
  }, [rows, searchParams, setSearchParams, viewerManagedDeepLinks])

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
  const canInitiateSuppression = hasRole(user, ...QA_REQUEST_CREATOR_ROLES, 'ADMIN')

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Suppression / False Positive Register" count={rows.length}
        subtitle="Exception requests for SAST/DAST findings -- Requester -> SM -> all required Department Heads -> Security Team verification -> Done."
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
            <WorkflowStatusBadge record={r} status={r.status} label={SUPPRESSION_STATUS_LABELS[r.status] || r.status} />
          ), filterValue: (r) => `${r.status} ${SUPPRESSION_STATUS_LABELS[r.status] || ''}` },
          { key: 'pending_with', header: 'Pending With', render: suppressionPendingWith, filterValue: suppressionPendingWith },
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
            } else {
              // Manual creation from this register should reveal the saved
              // Draft immediately after the acknowledgement so the requester
              // can perform the stated next step without searching for it.
              setSelected(created)
            }
            setNewRequestPrefill(undefined)
          }}
        />
      )}
      {selected && <SuppressionDetail sup={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} />}
    </div>
  )
}
