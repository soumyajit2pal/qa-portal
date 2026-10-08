import WorkflowStatusBadge from '../../components/WorkflowStatusBadge'
import { useViewerManagedDeepLinks } from '../../hooks/useRequestNavigation'
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { resolveRequestId } from '../../requestNavigation'
import { formatDateIST, formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, RequestDocuments, ApprovalDecisionButtons } from '../../components/Common'
import {
  SAST_DAST_STATUS_LABELS, CERTIFICATE_TYPES, RISK_TIERS, DEPLOYMENT_ENVIRONMENTS, hasWorkflowRole as hasRole, hasWorkspaceRole,
  isViewOnly,
  SIGNOFF_EDITABLE_STATUSES, SIGNOFF_STATUS_LABELS, SIGNOFF_PENDING_WITH,
  QA_LEAD_GROUP_ROLES, validTargetPromotionOptions, validEnvironmentPromotion,
} from '../../constants'
import { SignOffOut, UserOption, FunctionalOut, FunctionalListOut, QARequestOut, PageOut, ApprovalActionOut } from '../../types'
import JiraActivity, { AuthenticatedMarkdown } from '../../components/JiraActivity'
import ConfirmModal from '../../components/ConfirmModal'
import JiraRichTextField from '../../components/JiraRichTextField'
import ClearableSearchInput from '../../components/ClearableSearchInput'
import { isKeyboardActivationKey } from '../../keyboard'
import { linkedSecurityClearanceBlockers } from '../../clearanceEligibility'
import { canCreateClearanceRevision, isImmutableClearanceStatus } from '../../clearanceRevision'
import { canCreateClearanceForRequest } from '../../clearanceCreation'
import './SignOff.css'

function userName(users: UserOption[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

function ClearanceFact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="clearance-fact"><dt>{label}</dt><dd>{children}</dd></div>
}

function validityLabel(from?: string | null, to?: string | null): string {
  if (from && to) return `${formatDateIST(from)} to ${formatDateIST(to)}`
  if (from) return `From ${formatDateIST(from)}`
  if (to) return `Until ${formatDateIST(to)}`
  return 'Not provided'
}

interface RecordedElectronicSignature {
  signer: string
  appliedAt: string
  signatureId: string
  intent: string
  stage: string
  style: 'professional' | 'classic' | 'handwritten'
}

function recordedSignature(item: ApprovalActionOut): RecordedElectronicSignature | null {
  const match = (item.comments || '').match(/\[Electronic signature \| Signer: (.*?) \| Applied: (.*?) \| Signature ID: (.*?)(?: \| Style: (professional|classic|handwritten))? \| Intent: (.*?)\]/s)
  if (!match) return null
  return { signer: match[1].trim(), appliedAt: match[2].trim(), signatureId: match[3].trim(), style: (match[4] || 'professional') as RecordedElectronicSignature['style'], intent: match[5].trim(), stage: item.step_name || 'Approval' }
}

// Only Functional Testing Requests that have actually finished QA activity
// are eligible to be picked as the "Testing Request ID" for a new
// certificate -- raising sign-off for a request still mid-execution
// wouldn't make sense.
const SIGNOFF_ELIGIBLE_STATUSES = ['QA_COMPLETED', 'QA_SIGNOFF_PENDING']

const EMPTY = {
  certificate_type: 'Full Clearance', testing_type: 'Functional', testing_request_id: '',
  change_request_ids: '', application_name: '', application_owner: '', department: '',
  technology_stack: '', risk_tier: 'Tier 3 (Medium)', release_version: '', build_number: '',
  environment_tested: 'UAT', target_promotion_environment: 'Production',
  // Optional dates use empty strings for date inputs and null on submission.
  validity_from: '', validity_to: '',
  exit_criteria_notes: '', open_defect_summary: '', residual_risk_notes: '',
  known_limitations: '',
  business_acceptance_status: '',
  security_testing_status: '',
  conditional_observations: '',
  conditional_mitigation: '',
  conditional_owner: '',
  conditional_target_date: '',

}
type SignOffForm = typeof EMPTY

type ConditionalField = 'conditional_observations' | 'conditional_mitigation' | 'conditional_owner' | 'conditional_target_date'

function ClearanceRequirements({ certificateType }: { certificateType: string }) {
  if (certificateType === 'Clearance Denied') return null
  return <p className="muted small">Before submission and each approval, {certificateType} requires a Functional Request in QA Completed or QA Clearance Pending, a valid tested environment, completed matching cycles, and execution evidence. {certificateType === 'Full Clearance'
    ? 'Every applicable unique test case must have a latest result of Pass or Retest Passed (NA is allowed), with no open Critical or High defects.'
    : 'Unique test cases whose latest result is Fail, Blocked, or Not Executed, and open defects, require documented conditions, residual-risk remarks, and mitigation. Responsible owner and target date are optional.'}</p>
}

function ConditionalClearanceFields({ form, onChange, onImagesChange }: {
  form: Pick<SignOffForm, ConditionalField>
  onChange: (key: ConditionalField, value: string) => void
  onImagesChange: (key: ConditionalField, images: File[]) => void
}) {
  return <>
    <div className="clearance-form-intro"><span>Conditional clearance</span><h3>Conditions & observations</h3></div>
    <p className="muted small">Required before submission: conditions, residual-risk remarks, and mitigation. Responsible owner and target date are optional. Drafts may be saved while these details are incomplete. Leave observations blank to use linked open defects; when there are none, enter the conditions here. Manual observations replace the generated observations in Section F.</p>
    <Field label="Conditional Clearance Observations"><JiraRichTextField value={form.conditional_observations} onChange={value => onChange('conditional_observations', value)} onImagesChange={images => onImagesChange('conditional_observations', images)} ariaLabel="Conditional Clearance Observations" placeholder="Describe the conditions, affected functionality and business impact, or leave blank to use linked open defects…" /></Field>
    <Field label="Mitigation (required before submission)"><JiraRichTextField value={form.conditional_mitigation} onChange={value => onChange('conditional_mitigation', value)} onImagesChange={images => onImagesChange('conditional_mitigation', images)} ariaLabel="Conditional Clearance Mitigation" placeholder="Describe the workaround, controls and actions covering the conditions above…" /></Field>
    <div className="form-row clearance-form-grid">
      <Field label="Responsible owner (optional)"><input maxLength={150} value={form.conditional_owner} onChange={event => onChange('conditional_owner', event.target.value)} placeholder="Person or team accountable for resolving these conditions" /></Field>
      <Field label="Target date (optional)"><input type="date" value={form.conditional_target_date} onChange={event => onChange('conditional_target_date', event.target.value)} /></Field>
    </div>
  </>
}

// Shared by both the create and edit forms below.
function validityError(from: string, to: string): string | null {
  if (from && to && to < from) return 'Validity To cannot be before Validity From.'
  return null
}

function richTextRequiredError(form: Pick<SignOffForm, 'certificate_type' | 'exit_criteria_notes' | 'open_defect_summary' | 'residual_risk_notes'>): string | null {
  if (!form.exit_criteria_notes.trim()) return 'Testing Scope Completed is required.'

  if (form.certificate_type !== 'Conditional Clearance' && !form.residual_risk_notes.trim()) return 'Remarks are required.'
  return null
}

// Searchable "Testing Request ID" autosuggest over Functional Testing
// Requests -- same pattern as Suppression.tsx's SAST/DAST RequestIdSearch.
// Selecting a match hands the full FunctionalOut record back to the caller,
// which derives every auto-populated certificate field from it (see
// NewSignOffModal::applyRequest below).
function TestingRequestIdSearch({ requests, selected, onSelect, onClear, displayRequestId }: {
  requests: FunctionalListOut[]
  displayRequestId?: string | null
  // The already-fully-loaded selection (PAG-006 -- fetched fresh on select,
  // see NewSignOffModal's onSelect below), not one of the lightweight
  // `requests` rows -- both shapes carry request_id/application_name so the
  // "selected" display below works with either.
  selected: FunctionalOut | null
  onSelect: (r: FunctionalListOut) => void
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
          <span>{displayRequestId || selected.request_id} — {selected.application_name || '—'}</span>
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
          <div className="searchable-select-list" role="listbox" aria-label="Eligible functional testing requests">
            {matches.length === 0 && <div className="searchable-select-empty">No eligible Functional Testing Requests found.</div>}
            {matches.map((r) => (
              <div key={r.id} className="searchable-select-option" role="option" aria-selected={false} tabIndex={0}
                   onClick={() => { onSelect(r); setQuery(''); setOpen(false) }}
                   onKeyDown={(event) => { if (isKeyboardActivationKey(event.key)) { event.preventDefault(); onSelect(r); setQuery(''); setOpen(false) } }}>
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
// Department/CR Number/EPIC Number are derived from it and locked -- never
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
  const [parentRequest, setParentRequest] = useState<QARequestOut | null>(null)
  const [checkingSecurity, setCheckingSecurity] = useState(false)
  const [eligibleRequests, setEligibleRequests] = useState<FunctionalListOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [selecting, setSelecting] = useState(false)
  // Supporting documents picked before the certificate exists yet -- there's
  // no signoff id to upload against until POST /api/signoffs returns one, so
  // these are held here and uploaded right after creation succeeds (see
  // submit() below), same files-then-upload two-step every other module's
  // own Documents tab does post-raise (see Common.tsx::RequestDocuments),
  // just folded into this one form instead of a separate step.
  const [files, setFiles] = useState<File[]>([])
  // Reported directly: pasting a screenshot into these three fields did
  // nothing useful (allowImages was false below, same root cause as the
  // Defect Management module before it was fixed -- see
  // ORACLE_MIGRATION_2026-07.md sections 29-32) except that, with
  // allowImages false, JiraRichTextField doesn't attach its own paste
  // handler at all, so the paste fell through to the browser's raw default
  // contentEditable behaviour instead of being cleanly blocked -- which for
  // an image on the clipboard typically means Chrome/Edge embed it directly
  // as a multi-megabyte base64 <img> in the DOM. That's the most likely
  // cause of "Save Draft Certificate not working" reported alongside it:
  // not a backend bug, but the editor silently becoming enormous/sluggish
  // right before Save was clicked. Enabling proper image support below
  // (event.preventDefault() inside pasteImages, see RichTextEditor.tsx)
  // stops the raw paste from ever reaching the DOM in the first place.
  const [exitCriteriaImages, setExitCriteriaImages] = useState<File[]>([])
  const [openDefectImages, setOpenDefectImages] = useState<File[]>([])
  const [residualRiskImages, setResidualRiskImages] = useState<File[]>([])
  const [additionalImages, setAdditionalImages] = useState<Record<string, File[]>>({})
  function set<K extends keyof SignOffForm>(k: K, v: SignOffForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  const isCreationQALead = hasWorkspaceRole(user, ...QA_LEAD_GROUP_ROLES)
  const isCreationQAEngineer = hasWorkspaceRole(user, 'QA_ENGINEER')
  const canCreateForRequest = useCallback((request: Pick<FunctionalOut, 'assigned_tester_ids'>) => (
    canCreateClearanceForRequest({
      assignedTesterIds: request.assigned_tester_ids,
      userId: user?.id,
      isQaLeadGroup: isCreationQALead,
      isQaEngineer: isCreationQAEngineer,
    })
  ), [isCreationQALead, isCreationQAEngineer, user?.id])

  const applyRequest = useCallback((r: FunctionalOut) => {
    setSelectedRequest(r)
    setForm((f) => ({
      ...f,
      testing_request_id: r.request_id,
      application_name: r.application_name || '',
      application_owner: r.application_owner || '',
      department: r.department || '',
      change_request_ids: r.cr_number || '',
      technology_stack: r.technology_stack || '',
      release_version: r.release_version || '',
      build_number: r.build_number || '',
      // Retain the Functional source link; certificate scope is derived by the API.
      testing_type: 'Functional',
      environment_tested: r.environment || f.environment_tested,
      target_promotion_environment: r.target_promotion_environment || f.target_promotion_environment,
    }))
  }, [])

  useEffect(() => {
    if (presetRequest) {
      if (canCreateForRequest(presetRequest)) applyRequest(presetRequest)
      else setError('Only the QA Lead group in this workspace or a currently assigned QA tester can create this clearance certificate.')
      return
    }
    // Filtering happens server-side, while the picker exhausts the filtered
    // result so an older eligible request is never impossible to select.
    const statusQuery = SIGNOFF_ELIGIBLE_STATUSES.map((s) => `status=${encodeURIComponent(s)}`).join('&')
    api.getAll<FunctionalListOut>(`/api/functional-requests?${statusQuery}`)
      .then(setEligibleRequests)
      .catch(setError)
  }, [presetRequest, applyRequest, canCreateForRequest])

  useEffect(() => {
    const parentId = selectedRequest?.qa_request_id
    setParentRequest(null)
    if (!parentId) { setCheckingSecurity(false); return }
    let active = true
    setCheckingSecurity(true)
    api.get<QARequestOut>(`/api/qa-requests/${parentId}`)
      .then(parent => { if (active) setParentRequest(parent) })
      .catch(err => { if (active) setError(err) })
      .finally(() => { if (active) setCheckingSecurity(false) })
    return () => { active = false }
  }, [selectedRequest?.qa_request_id])

  const testingTypes = [...new Set((parentRequest?.request_types || '').split(',').map(t => t.trim()).filter(Boolean))]
  const certificateRequestId = testingTypes.length > 1 ? parentRequest!.request_id : selectedRequest?.request_id
  const securityBlockers = parentRequest ? linkedSecurityClearanceBlockers(parentRequest) : []
  const actorEligibleRequests = eligibleRequests.filter(canCreateForRequest)
  // Clearance Denied is exempt from evidence/pass eligibility, not from the
  // Functional workflow. Every certificate type uses the same completed or
  // clearance-pending source states and the same actor authorization gate.
  const selectableRequests = actorEligibleRequests.filter(request => SIGNOFF_ELIGIBLE_STATUSES.includes(request.status))

  // PAG-006 -- `eligibleRequests` only ever holds the lightweight
  // FunctionalListOut shape; picking one fetches the full FunctionalOut
  // record fresh (same "fetch full detail on open" pattern as every other
  // paginated list's own detail view) before deriving the certificate's
  // auto-populated fields from it.
  const selectEligibleRequest = useCallback(async (row: FunctionalListOut) => {
    setSelecting(true)
    setError(null)
    try {
      const full = await api.get<FunctionalOut>(`/api/functional-requests/${row.id}`)
      if (!canCreateForRequest(full)) {
        setError('Your assignment or QA authority for this request changed. Refresh before creating the certificate.')
        return
      }
      applyRequest(full)
    } catch (err) {
      setError(err)
    } finally {
      setSelecting(false)
    }
  }, [applyRequest, canCreateForRequest])

  function clearSelection() {
    setSelectedRequest(null)
    setForm((f) => ({ ...f, testing_request_id: '', application_name: '', application_owner: '', department: '', change_request_ids: '' }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // Disabled inputs are skipped by the browser's own `required` validation
    // entirely, so the locked Application Name/Owner/Department/Change
    // Request ID(s) fields need this explicit check instead -- they're only
    // ever filled in via picking a Testing Request above.
    if (!selectedRequest) { setError('Pick a Testing Request ID first -- Application Name, Owner and CR Number/EPIC Number are derived from it.'); return }
    if (!canCreateForRequest(selectedRequest)) {
      setError('Only the QA Lead group in this workspace or a currently assigned QA tester can create this clearance certificate.')
      return
    }
    if (checkingSecurity) { setError('Checking the linked SAST/DAST requests. Please wait.'); return }
    if (securityBlockers.length) {
      setError(`QA Clearance is waiting for active linked SAST/DAST requests to finish: ${securityBlockers.join(', ')}. A final Department Head rejection does not block clearance.`)
      return
    }
    if (!hasWorkspaceRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')) {
      setError('QA Clearance requires a QA permission profile in the active workspace.')
      return
    }
    const validityErr = validityError(form.validity_from, form.validity_to)
    if (validityErr) { setError(validityErr); return }
    const richTextErr = richTextRequiredError(form)
    if (richTextErr) { setError(richTextErr); return }
    // Same Environment Tested/Target Promotion Environment ordering rule as
    // the QA Request wizard's DetailsStep.tsx -- reuses the same shared
    // validEnvironmentPromotion helper rather than a duplicate check. The
    // two selects below already only offer valid Target options and
    // auto-correct on Environment Tested change, so this should never
    // actually trip, but it's the last line of defense before the POST.
    if (!validEnvironmentPromotion(form.environment_tested, form.target_promotion_environment)) {
      setError(`Target Promotion Environment ('${form.target_promotion_environment}') must be later than Environment Tested ('${form.environment_tested}') in the pipeline SIT -> UAT -> Pre-Production -> Production.`)
      return
    }
    setBusy(true)
    try {
      const created = await api.post<SignOffOut>('/api/signoffs', {
        ...form,
        validity_from: form.validity_from || null,
        validity_to: form.validity_to || null,
        conditional_target_date: form.conditional_target_date || null,
      })
      // Best-effort: the certificate itself is already created at this point,
      // so a failed upload shouldn't block onCreated -- surface the error but
      // still hand back the created certificate (its own Documents tab, via
      // RequestDocuments in SignOffDetail below, can always retry the upload).
      // Screenshots pasted into Exit Criteria/Open Defect/Residual Risk are
      // never embedded inline (same as every other JiraRichTextField in the
      // app) -- they're combined with the explicitly-picked Supporting
      // Documents and uploaded together here.
      const allFiles = [...files, ...exitCriteriaImages, ...openDefectImages, ...residualRiskImages, ...Object.values(additionalImages).flat()]
      if (allFiles.length > 0) {
        try { await api.uploadFiles(`/api/signoffs/${created.id}/documents`, allFiles) }
        catch (err) { setError(err) }
      }
      onCreated(created)
    }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New QA Clearance Certificate" onClose={onClose} wide>
      <form className="clearance-form" onSubmit={submit}>
        <div className="clearance-form-intro"><span>01 · Linked scope</span><h3>Choose the completed Functional request</h3><p>The linked request supplies the application, department, and CR / EPIC identity. Active security child requests must finish before clearance can be raised; a final Department Head rejection does not block clearance.</p></div>
        <Field label="Testing Request ID *">
          {presetRequest ? (
            <div className="searchable-select">
              <div className="searchable-select-trigger" style={{ cursor: 'default' }}>
                <span>{certificateRequestId} — {presetRequest.application_name || '—'}</span>
              </div>
            </div>
          ) : (
            <TestingRequestIdSearch displayRequestId={certificateRequestId} requests={selectableRequests} selected={selectedRequest} onSelect={selectEligibleRequest} onClear={clearSelection} />
          )}
        </Field>
        {securityBlockers.length > 0 && <div className="alert alert-warning" role="status">
          QA Clearance is waiting for active linked security requests to finish: {securityBlockers.join(', ')}. A Department Head Rejected request is final and does not block clearance.
        </div>}
        <div className="clearance-form-intro"><span>02 · Certificate details</span><h3>Define the clearance and promotion</h3><p>Confirm the tested build, environment, risk tier, and validity before saving the draft.</p></div>
        <ClearanceRequirements certificateType={form.certificate_type} />
        <div className="form-row clearance-form-grid">
          <Field label="Application Name *"><input required disabled value={form.application_name} onChange={() => {}} /></Field>
          <Field label="Application Owner *"><input required disabled value={form.application_owner} onChange={() => {}} /></Field>
          <Field label="Request Department *"><input required disabled value={form.department} onChange={() => {}} /></Field>
          <Field label="CR Number/EPIC Number *"><input required disabled value={form.change_request_ids} onChange={() => {}} /></Field>
          <Field label="Technology Stack *"><input required value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
          <Field label="Release Version *"><input required value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
          <Field label="Build Number *"><input required value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
          <Field label="Certificate Type *">
            <select required value={form.certificate_type} onChange={(e) => set('certificate_type', e.target.value)}>
              {CERTIFICATE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Testing Type *">
            <input disabled value={testingTypes.join(', ') || form.testing_type} />
          </Field>
          <Field label="Risk Tier *">
            <select required value={form.risk_tier} onChange={(e) => set('risk_tier', e.target.value)}>
              {RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          {/* Reported directly (QA Requests wizard, then extended here to
              every Deployment/Environment-Tested + Target Promotion
              Environment pair): Production should never be selectable as
              the environment being tested/deployed FROM -- it's the
              pipeline's final destination, only ever valid as a Target
              Promotion Environment. See constants.ts's
              DEPLOYMENT_ENVIRONMENTS for the shared list. Target Promotion
              Environment is further restricted (and Environment Tested's own
              onChange snaps it forward) via the same shared
              validTargetPromotionOptions/validEnvironmentPromotion helpers
              the QA Request wizard's DetailsStep.tsx and Functional.tsx's
              Edit Details modal already use -- reused here, not duplicated. */}
          <Field label="Environment Tested *">
            <select required value={form.environment_tested} onChange={(e) => {
              const nextEnv = e.target.value
              set('environment_tested', nextEnv)
              const validTargets = validTargetPromotionOptions(nextEnv)
              if (!validTargets.includes(form.target_promotion_environment)) {
                set('target_promotion_environment', validTargets[0] || '')
              }
            }}>
              {DEPLOYMENT_ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Target Promotion Environment *">
            <select required value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
              {validTargetPromotionOptions(form.environment_tested).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Validity From">
            <input type="date" value={form.validity_from} onChange={(e) => set('validity_from', e.target.value)} />
          </Field>
          <Field label="Validity To">
            <input type="date" min={form.validity_from || undefined} value={form.validity_to} onChange={(e) => set('validity_to', e.target.value)} />
          </Field>
        </div>
        <div className="clearance-form-intro"><span>03 · Assessment</span><h3>Section E · QA Clearance Remarks</h3><p>Record what was tested and the decision rationale. The remaining remarks help reviewers understand any risk or limitation.</p></div>
        <Field label="Testing Scope Completed *"><JiraRichTextField value={form.exit_criteria_notes} onChange={(value) => set('exit_criteria_notes', value)} onImagesChange={setExitCriteriaImages} ariaLabel="Testing Scope Completed" placeholder="Describe the testing scope completed…" /></Field>
        <Field label="Open Risks (if any)"><JiraRichTextField value={form.open_defect_summary} onChange={(value) => set('open_defect_summary', value)} onImagesChange={setOpenDefectImages} ariaLabel="Open Risks (if any)" placeholder="Describe any remaining risks…" /></Field>
        {([
          ['known_limitations', 'Known Limitations'],
          ['business_acceptance_status', 'Business Acceptance Status'],
          ['security_testing_status', 'Security Testing Status'],
        ] as const).map(([key, label]) => <Field key={key} label={label}><JiraRichTextField value={form[key]} onChange={value => set(key, value)} onImagesChange={images => setAdditionalImages(current => ({ ...current, [key]: images }))} ariaLabel={label} placeholder={`Enter ${label.toLowerCase()}…`} /></Field>)}
        <Field label={form.certificate_type === 'Conditional Clearance' ? 'Remarks / residual risk (required before submission)' : 'Remarks *'}><JiraRichTextField value={form.residual_risk_notes} onChange={(value) => set('residual_risk_notes', value)} onImagesChange={setResidualRiskImages} ariaLabel="Remarks" placeholder={form.certificate_type === 'Conditional Clearance' ? 'Describe the residual risk being accepted with these conditions…' : 'Add remarks…'} /></Field>
        {form.certificate_type === 'Conditional Clearance' && <ConditionalClearanceFields form={form} onChange={set} onImagesChange={(key, images) => setAdditionalImages(current => ({ ...current, [key]: images }))} />}
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
          <button className="btn btn-primary" disabled={busy || selecting || checkingSecurity || securityBlockers.length > 0}>{busy ? 'Saving...' : 'Save Draft Certificate'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Edit Details for an already-raised certificate -- reachable by the QA requester
// (requester) while it's Draft or sitting back with them after a QA Lead/
// Executive  return, or by a QA Lead directly while it's sitting at
// their own QA Lead review (legacy status SM_APPROVAL_PENDING; see routers/signoff.py::
// update_signoff for the exact permission windows -- "he will have option
// to modify details" per the requested workflow). Testing Request ID/
// Application Name/Owner/Department/CR Number/EPIC Number stay locked here
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
    known_limitations: item.known_limitations || '',
    business_acceptance_status: item.business_acceptance_status || '',
    security_testing_status: item.security_testing_status || '',
    conditional_observations: item.conditional_observations || '',
    conditional_mitigation: item.conditional_mitigation || '',
    conditional_owner: item.conditional_owner || '',
    conditional_target_date: item.conditional_target_date || '',

  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [exitCriteriaImages, setExitCriteriaImages] = useState<File[]>([])
  const [openDefectImages, setOpenDefectImages] = useState<File[]>([])
  const [residualRiskImages, setResidualRiskImages] = useState<File[]>([])
  const [additionalImages, setAdditionalImages] = useState<Record<string, File[]>>({})
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const validityErr = validityError(form.validity_from, form.validity_to)
    if (validityErr) { setError(validityErr); return }
    const richTextErr = richTextRequiredError(form)
    if (richTextErr) { setError(richTextErr); return }
    // Same shared-method ordering check as NewSignOffModal above.
    if (!validEnvironmentPromotion(form.environment_tested, form.target_promotion_environment)) {
      setError(`Target Promotion Environment ('${form.target_promotion_environment}') must be later than Environment Tested ('${form.environment_tested}') in the pipeline SIT -> UAT -> Pre-Production -> Production.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await api.put<SignOffOut>(`/api/signoffs/${item.id}`, {
        ...form,
        validity_from: form.validity_from || null,
        validity_to: form.validity_to || null,
        conditional_target_date: form.conditional_target_date || null,
      })
      // Same best-effort convention as NewSignOffModal above -- the edit
      // itself already succeeded, so a failed image upload shouldn't block
      // handing back the saved certificate.
      const images = [...exitCriteriaImages, ...openDefectImages, ...residualRiskImages, ...Object.values(additionalImages).flat()]
      if (images.length > 0) {
        try { await api.uploadFiles(`/api/signoffs/${item.id}/documents`, images) }
        catch (err) { setError(err) }
      }
      onSaved(saved)
    }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${item.certificate_id}`} onClose={onClose} wide>
      <form className="clearance-form" onSubmit={submit}>
        <div className="clearance-form-intro"><span>01 · Linked request</span><h3>Request identity</h3><p>These values come from the linked Functional request and stay locked.</p></div>
        <ClearanceRequirements certificateType={form.certificate_type} />
        <div className="form-row clearance-form-grid">
          <Field label="Testing Request ID"><input disabled value={item.certificate_testing_request_id || item.testing_request_id || ''} /></Field>
          <Field label="Application Name"><input disabled value={item.application_name} /></Field>
          <Field label="Application Owner"><input disabled value={item.application_owner || ''} /></Field>
          <Field label="Request Department"><input disabled value={item.request_department || item.department || ''} /></Field>
          <Field label="Approving QA Team"><input disabled value={item.approving_qa_team || 'Not configured'} /></Field>
        </div>
        <div className="clearance-form-intro"><span>02 · Clearance setup</span><h3>Certificate and promotion details</h3></div>
        <div className="form-row clearance-form-grid">
          <Field label="Certificate Type *">
            <select required value={form.certificate_type} onChange={(e) => set('certificate_type', e.target.value)}>
              {CERTIFICATE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Testing Type *">
            <input disabled value={item.certificate_testing_type || item.testing_type} />
          </Field>
          <Field label="Technology Stack"><input value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
          <Field label="Release Version"><input value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
          <Field label="Build Number"><input value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
          <Field label="Risk Tier *">
            <select required value={form.risk_tier} onChange={(e) => set('risk_tier', e.target.value)}>
              {RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          {/* Same DEPLOYMENT_ENVIRONMENTS/validTargetPromotionOptions/
              validEnvironmentPromotion reasoning as the standalone Create
              Certificate form above -- see that field's own comment. */}
          <Field label="Environment Tested *">
            <select required value={form.environment_tested} onChange={(e) => {
              const nextEnv = e.target.value
              set('environment_tested', nextEnv)
              const validTargets = validTargetPromotionOptions(nextEnv)
              if (!validTargets.includes(form.target_promotion_environment)) {
                set('target_promotion_environment', validTargets[0] || '')
              }
            }}>
              {DEPLOYMENT_ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Target Promotion Environment *">
            <select required value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
              {validTargetPromotionOptions(form.environment_tested).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Validity From">
            <input type="date" value={form.validity_from} onChange={(e) => set('validity_from', e.target.value)} />
          </Field>
          <Field label="Validity To">
            <input type="date" min={form.validity_from || undefined} value={form.validity_to} onChange={(e) => set('validity_to', e.target.value)} />
          </Field>
        </div>
        <div className="clearance-form-intro"><span>03 · Assessment</span><h3>Section E · QA Clearance Remarks</h3></div>
        <Field label="Testing Scope Completed *"><JiraRichTextField value={form.exit_criteria_notes} onChange={(value) => set('exit_criteria_notes', value)} onImagesChange={setExitCriteriaImages} ariaLabel="Testing Scope Completed" placeholder="Describe the testing scope completed…" /></Field>
        <Field label="Open Risks (if any)"><JiraRichTextField value={form.open_defect_summary} onChange={(value) => set('open_defect_summary', value)} onImagesChange={setOpenDefectImages} ariaLabel="Open Risks (if any)" placeholder="Describe any remaining risks…" /></Field>
        {([
          ['known_limitations', 'Known Limitations'],
          ['business_acceptance_status', 'Business Acceptance Status'],
          ['security_testing_status', 'Security Testing Status'],
        ] as const).map(([key, label]) => <Field key={key} label={label}><JiraRichTextField value={form[key]} onChange={value => set(key, value)} onImagesChange={images => setAdditionalImages(current => ({ ...current, [key]: images }))} ariaLabel={label} placeholder={`Enter ${label.toLowerCase()}…`} /></Field>)}
        <Field label={form.certificate_type === 'Conditional Clearance' ? 'Remarks / residual risk (required before submission)' : 'Remarks *'}><JiraRichTextField value={form.residual_risk_notes} onChange={(value) => set('residual_risk_notes', value)} onImagesChange={setResidualRiskImages} ariaLabel="Remarks" placeholder={form.certificate_type === 'Conditional Clearance' ? 'Describe the residual risk being accepted with these conditions…' : 'Add remarks…'} /></Field>
        {form.certificate_type === 'Conditional Clearance' && <ConditionalClearanceFields form={form} onChange={set} onImagesChange={(key, images) => setAdditionalImages(current => ({ ...current, [key]: images }))} />}
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Changes'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function CertificateEvidence({ item }: { item: SignOffOut }) {
  const summary = item.certificate_summary
  if (!summary) return <section className="clearance-evidence"><div className="clearance-section-heading"><div><span>Captured results</span><h3>Test evidence</h3></div></div><p className="clearance-empty-note">This earlier certificate has no frozen summary. Capturing current results requires a refresh and full reapproval.</p></section>
  const defectStatuses = ['Fix Pending', 'Not a Defect Review Pending', 'Retest Pending', 'Reopened / Retest Failed', 'Business Acceptance Pending', 'Release Pending', 'Production Verification Pending', 'Blocked', 'Deferred', 'Closed', 'Rejected', 'Duplicate', 'Not a Defect', 'Change Request Raised']
  const activeDefectStatuses = defectStatuses.filter(status => (summary.defects.counts[status] || 0) > 0)
  const openSeverity = summary.severity.reduce((total, row) => total + row.open, 0)
  const passPercent = summary.execution.pass_pct == null ? 'No result' : `${summary.execution.pass_pct}%`
  const uniquePopulation = summary.execution_population_basis === 'unique_testcase_latest'
  const populationLabel = uniquePopulation ? 'Unique test cases' : 'Execution slots (legacy snapshot)'
  const populationDescription = uniquePopulation
    ? 'latest result per unique test case'
    : 'captured before unique-testcase counting'
  const executionSummaryTitle = uniquePopulation
    ? 'QA Unique Test Case Execution Summary'
    : 'QA Test Case Execution Summary (Legacy Slot-Based)'
  return <section className="clearance-evidence" id="clearance-evidence">
    <div className="clearance-section-heading"><div><span>Captured results</span><h3>Test evidence</h3><p>Revision {summary.revision} · captured {formatDateTimeIST(summary.captured_at)}</p></div><span className="clearance-frozen-badge">Snapshot locked</span></div>
    <div className="clearance-evidence-metrics">
      <article><small>{populationLabel}</small><strong>{summary.execution.total}</strong><span>{populationDescription}</span></article>
      <article><small>Pass rate</small><strong>{passPercent}</strong><span>Pass + Retest Passed</span></article>
      <article><small>Defects</small><strong>{summary.defects.total}</strong><span>counted once</span></article>
      <article className={openSeverity ? 'needs-review' : ''}><small>Open defects</small><strong>{openSeverity}</strong><span>{summary.open_critical_high} Critical / High</span></article>
    </div>
    {!uniquePopulation && <div className="clearance-evidence-warning" role="status">This frozen revision uses the earlier execution-slot counting method. Refresh editable evidence to recalculate unique test cases; issued and historical revisions remain unchanged for audit integrity.</div>}
    {summary.open_critical_high > 0 && <div className="clearance-evidence-warning" role="status">Full Clearance is blocked while {summary.open_critical_high} Critical or High defect(s) remain open.</div>}
    <div className="clearance-evidence-panels">
      <details open><summary><span><b>{executionSummaryTitle}</b><small>{uniquePopulation ? 'Latest result per unique test case in the linked test scope' : 'Historical execution-slot results retained exactly as captured'}</small></span><strong>{summary.execution.total} {uniquePopulation ? (summary.execution.total === 1 ? 'unique case' : 'unique cases') : (summary.execution.total === 1 ? 'slot' : 'slots')}</strong></summary>
        <div className="clearance-table-scroll"><table className="workflow-table"><thead><tr><th>{populationLabel}</th>{['Pass', 'Fail', 'Blocked', 'NA', 'Retest Passed', 'Not Executed'].map(status => <th key={status}>{status}</th>)}<th>Pass %</th></tr></thead><tbody><tr><td>{summary.execution.total}</td>{['Pass', 'Fail', 'Blocked', 'NA', 'Retest Passed', 'Not Executed'].map(status => <td key={status}>{summary.execution.counts[status] || 0}</td>)}<td>{summary.execution.pass_pct == null ? 'NA' : `${summary.execution.pass_pct}%`}</td></tr></tbody></table></div>
      </details>
      <details><summary><span><b>QA Defect Status Summary</b><small>Current disposition, with deferred defects still open</small></span><strong>{summary.defects.total} defects</strong></summary>
        <div className="clearance-table-scroll"><table className="workflow-table"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>{activeDefectStatuses.map(status => <tr key={status}><td>{status}{status === 'Deferred' ? ' (Open)' : ''}</td><td>{summary.defects.counts[status] || 0}</td></tr>)}{summary.defects.total === 0 && <tr><td colSpan={2}>No linked defects captured</td></tr>}<tr><th>Total</th><td>{summary.defects.total}</td></tr></tbody></table></div>
      </details>
      <details><summary><span><b>Defect Severity-wise Breakdown</b><small>Open and terminal defects by severity</small></span><strong>{openSeverity} open</strong></summary>
        <div className="clearance-table-scroll"><table className="workflow-table"><thead><tr><th>Severity</th><th>Open</th><th>Closed / terminal</th><th>Total</th></tr></thead><tbody>{summary.severity.map(row => <tr key={row.severity}><td>{row.severity}</td><td>{row.open}</td><td>{row.closed}</td><td>{row.total}</td></tr>)}</tbody></table></div>
      </details>
    </div>
    <section className="clearance-security-assessment" aria-label="Security Testing Assessment">
      <h4>Section D · Security Testing Assessment</h4>
      <p className="muted small">Status at capture. Initial findings total the Security Auditor View across all targets; suppressions total the latest captured scan for each target.</p>
      {summary.security?.length ? <div className="clearance-table-scroll"><table className="workflow-table"><thead><tr><th>Type</th><th>Request ID</th><th>Current status</th><th>Initial total findings</th><th>Current findings</th><th>Suppression count</th><th>Suppression request ID(s)</th></tr></thead><tbody>{summary.security.map(row => <tr key={`${row.type}-${row.request_id}`}><td>{row.type}</td><td>{row.request_id}</td><td>{SAST_DAST_STATUS_LABELS[row.status] || row.status}</td><td>{row.initial_findings ?? 'Not captured'}</td><td>{row.current_findings ?? 'Not captured'}</td><td>{row.suppression_count ?? 'Not captured'}</td><td>{row.suppression_request_ids ? row.suppression_request_ids.join(', ') || 'None' : 'Not captured'}</td></tr>)}</tbody></table></div> : <p className="muted small">No linked security assessment captured.</p>}
      {summary.security?.some(row => row.initial_findings == null || row.current_findings == null || row.suppression_count == null || row.suppression_request_ids == null) && <p className="muted small">Missing scan counts require evidence refresh and full reapproval.</p>}
    </section>
    <details className="clearance-method-note"><summary>How these figures were calculated</summary><p>{summary.population_note}</p><p>The figures remain unchanged until explicitly refreshed. Refreshing invalidates previous approvals and requires the full approval sequence again.</p></details>
  </section>
}

export function SignOffDetail({ item, onClose, onChanged, users }: { item: SignOffOut; onClose: () => void; onChanged: (s: SignOffOut) => void; users: UserOption[] }) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [comments, setComments] = useState('')
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [editing, setEditing] = useState(false)
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const [showRevision, setShowRevision] = useState(false)
  const [revisionReason, setRevisionReason] = useState('')
  const [showTakeover, setShowTakeover] = useState(false)
  const [takeoverReason, setTakeoverReason] = useState('')
  const [takeoverNotice, setTakeoverNotice] = useState('')
  const [detailTab, setDetailTab] = useState('evidence')
  const detailTabs = [['evidence', 'Test evidence'], ['details', 'Certificate details'], ['remarks', 'Remarks & risks'], ['documents', 'Documents'], ['activity', 'Approvals & activity']]
  useEffect(() => {
    setDetailTab('evidence')
    setShowTakeover(false)
    setTakeoverReason('')
    setTakeoverNotice('')
  }, [item.id])

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
      // Mutation responses intentionally serialize viewer capabilities with
      // fail-closed defaults. Refresh through the detail GET so revision
      // permissions are recalculated from the live assignment/workflow for
      // this actor. If only that refresh fails, still publish the successful
      // mutation and make the recovery step explicit so the actor does not
      // accidentally submit the workflow action twice.
      try {
        onChanged(await api.get<SignOffOut>(`/api/signoffs/${item.id}`))
      } catch {
        onChanged(updated)
        setError(new Error('The action was saved, but current permissions could not be refreshed. Close and reopen this certificate before taking another action.'))
      }
      setComments('')
      await load()
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  // Reported directly ("still not working" / "nothing happens") -- this
  // button's onClick used to call api.downloadFile() directly with no
  // await/catch, so any failure (expired session, 404, a backend error)
  // became an unhandled promise rejection: nothing rendered, no error
  // shown, the click just appeared to do nothing. Routed through the same
  // busyAction/error state every other action on this modal already uses,
  // so a failure is now visible instead of silent.
  async function downloadCertificate() {
    setError(null)
    setBusyAction('download')
    try {
      await api.downloadFile(`/api/signoffs/${item.id}/export`, `${item.certificate_id}.pdf`)
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  async function createRevision() {
    const reason = revisionReason.trim()
    if (reason.length < 3) { setError('Enter a revision reason of at least 3 characters.'); return }
    setError(null)
    setBusyAction('revisions')
    try {
      const successor = await api.post<SignOffOut>(`/api/signoffs/${item.id}/revisions`, { reason })
      setShowRevision(false)
      setRevisionReason('')
      onChanged(successor)
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  async function takeOverCertificate() {
    const reason = takeoverReason.trim()
    if (reason.length < 10) {
      setError('Enter a takeover reason of at least 10 characters.')
      return
    }
    setError(null)
    setTakeoverNotice('')
    setBusyAction('qa-lead-group-takeover')
    try {
      const updated = await api.post<SignOffOut>(
        `/api/signoffs/${item.id}/qa-lead-group-takeover`,
        { reason },
      )
      let current = updated
      try {
        current = await api.get<SignOffOut>(`/api/signoffs/${item.id}`)
      } catch {
        setError(new Error('Ownership was transferred, but current permissions could not be refreshed. Close and reopen this certificate before taking another action.'))
      }
      setShowTakeover(false)
      setTakeoverReason('')
      setTakeoverNotice('Certificate ownership transferred to you through the QA Lead Group recovery action. A different eligible QA Lead must approve it after submission.')
      onChanged(current)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setBusyAction(null)
    }
  }

  async function openRelatedCertificate(id: number) {
    setError(null)
    setBusyAction('lineage')
    try { onChanged(await api.get<SignOffOut>(`/api/signoffs/${id}`)) }
    catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  const viewOnly = isViewOnly(user)
  // System administration is not certificate-workflow authority. An Admin
  // may use these owner actions only when they are also the actual QA author;
  // explicit QA approval/revision capabilities remain evaluated separately.
  const isRequester = !viewOnly && item.requester_id === user?.id
  const status = item.status
  const isQADepartment = hasWorkspaceRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')
  const hasCurrentExecutionBasis = item.certificate_summary?.execution_population_basis === 'unique_testcase_latest'
  const requiresPopulationRefresh = !isImmutableClearanceStatus(status) && !hasCurrentExecutionBasis

  const canSubmit = isRequester && status === 'DRAFT' && hasCurrentExecutionBasis
  // Actor-only context is used solely to explain a temporary Retest lock.
  // Rendering the action itself below always requires the backend's full
  // live `can_create_revision` capability.
  const revisionOtherwiseAllowed = !viewOnly
    && item.revision_actor_allowed === true
    && ['ISSUED', 'ISSUED_UNDER_REVIEW', 'SM_REJECTED', 'DEPT_HEAD_COE_REJECTED'].includes(status)
    && !item.superseded_by_id
  const canCreateRevision = canCreateClearanceRevision({
    status,
    canCreateRevision: item.can_create_revision,
    revisionActorAllowed: item.revision_actor_allowed,
    viewOnly,
    supersededById: item.superseded_by_id,
    sourceRequestStatus: item.source_request_status,
    sourceStatusResolved: item.source_request_status != null || !item.testing_request_id,
  })
  const revisionBlockedByRetest = revisionOtherwiseAllowed
    && ['EXECUTION_IN_PROGRESS', 'DEFECT_RAISED', 'WAITING_FOR_FIX', 'RETESTING'].includes(item.source_request_status || '')
  // Rejection is terminal for that certificate. Continuing after either
  // approval-stage rejection creates a linked Draft successor; the rejected
  // predecessor is never edited or resubmitted in place.
  // RETURNED_BY_REQUESTER remains here only so pre-immutable-revision rows
  // can complete their legacy path. New requester changes enter the
  // Functional Request's explicit QA change-review stage first.
  const canResubmit = isRequester && hasCurrentExecutionBasis && ['RETURNED_BY_SM', 'RETURNED_BY_DEPT_HEAD_COE', 'RETURNED_BY_REQUESTER'].includes(status)
  const resubmitLabel = status === 'RETURNED_BY_REQUESTER' ? 'Reopen Certificate' : 'Re-submit'
  // Reported directly: a person who raised this certificate but also
  // separately holds QA Lead/Executive  must not be able to approve
  // their own certificate -- someone else holding that role must decide it.
  // Workflow authority deliberately does not inherit System Admin here.
  const isSelfApproval = item.requester_id === user?.id
  const isPriorStageApprover = item.reviewed_by_id === user?.id
  // Executive roles can also act at this QA Lead checkpoint when they hold
  // active access to the certificate workspace.
  const canQALeadDecide = hasCurrentExecutionBasis && hasRole(user, ...QA_LEAD_GROUP_ROLES) && status === 'SM_APPROVAL_PENDING' && isQADepartment && !isSelfApproval
  // Reported directly ("Executive also Chief Manager and AGM only") while
  // verifying this checkpoint's role set -- this was missing CHIEF_MANAGER_QA
  // entirely (only checked AGM_QA), even though the backend's
  // executive_coe_decision (signoff.py) already require_roles()'d both. A
  // Chief Manager - QA account couldn't even see these buttons; now fixed to
  // match the backend exactly.
  const canExecutiveCoeDecide = hasCurrentExecutionBasis && hasRole(user, 'CHIEF_MANAGER_QA', 'AGM_QA') && status === 'DEPT_HEAD_QA_APPROVAL_PENDING' && isQADepartment && !isSelfApproval && !isPriorStageApprover
  const awaitingIndependentExecutive = status === 'DEPT_HEAD_QA_APPROVAL_PENDING' && isPriorStageApprover
  // Reported directly: "only the assigned person can update" -- once the
  // certificate has moved past the requester, document control passes
  // exclusively to whoever it's actually sitting with now, matching the
  // backend's own (now-exclusive) _can_upload_documents (signoff.py).
  const canManageDocuments = (
    ['DRAFT', 'SUBMITTED', 'RETURNED_BY_SM', 'RETURNED_BY_DEPT_HEAD_COE', 'RETURNED_BY_REQUESTER'].includes(status) ? isRequester :
    status === 'SM_APPROVAL_PENDING' ? canQALeadDecide :
    status === 'DEPT_HEAD_QA_APPROVAL_PENDING' ? canExecutiveCoeDecide :
    false
  )
  // Requester's own editable statuses, or a QA Lead editing during approval.
  // routers/signoff.py::update_signoff.
  const canEditDetails = (isRequester && SIGNOFF_EDITABLE_STATUSES.includes(status))
    || (hasRole(user, ...QA_LEAD_GROUP_ROLES) && status === 'SM_APPROVAL_PENDING' && isQADepartment)
  // Reported directly: "multiple signatures are coming, instead of this
  // what ever latest show" -- a certificate returned and re-signed more
  // than once at the same checkpoint (e.g. QA Lead approves, it's
  // returned, QA Lead approves again after resubmission) left every past
  // signature for that stage on display, not just the one that's actually
  // still valid. `history` comes back ordered oldest-first
  // (routers/signoff.py::signoff_history), so folding into a Map keyed by
  // stage and letting later entries overwrite earlier ones leaves exactly
  // the most recent signature per stage.
  const signatures = useMemo(() => {
    const byStage = new Map<string, RecordedElectronicSignature>()
    for (const item of history) {
      if (item.decision === 'Approval reset') byStage.clear()
      const signature = recordedSignature(item)
      if (signature) byStage.set(signature.stage, signature)
    }
    return Array.from(byStage.values())
  }, [history])

  const stageIndex = ['ISSUED', 'ISSUED_UNDER_REVIEW', 'SUPERSEDED'].includes(status) ? 3 : ['DEPT_HEAD_QA_APPROVAL_PENDING', 'DEPT_HEAD_COE_REJECTED'].includes(status) ? 2 : ['SM_APPROVAL_PENDING', 'SM_REJECTED'].includes(status) ? 1 : 0
  const isRejected = ['SM_REJECTED', 'DEPT_HEAD_COE_REJECTED'].includes(status)
  const isClearanceDenied = item.certificate_type === 'Clearance Denied'
  const stageNames = ['Draft', 'QA Lead', 'Executive', 'Issued']
  const nextStep = status === 'ISSUED' && isClearanceDenied ? 'Clearance denied — requester acknowledgement' : status === 'ISSUED' ? 'Certificate issued' : status === 'ISSUED_UNDER_REVIEW' ? 'Requester changes under QA review' : isRejected ? 'Certificate rejected' : status === 'SUPERSEDED' ? 'Historical certificate' : status === 'VOIDED' ? 'Retired duplicate' : requiresPopulationRefresh ? 'Refresh evidence for unique-testcase counting' : status === 'DRAFT' ? 'Submit for QA Lead review' : status === 'SM_APPROVAL_PENDING' ? 'QA Lead review' : status === 'DEPT_HEAD_QA_APPROVAL_PENDING' ? 'Executive review' : canResubmit ? 'Revise and re-submit the certificate' : SIGNOFF_STATUS_LABELS[status] || status
  const nextStepHint = status === 'ISSUED' && isClearanceDenied ? 'The denial decision is issued, immutable, and downloadable. The linked Functional Request remains with its requester until they acknowledge the outcome and close it.' : status === 'ISSUED' ? 'The signed certificate is immutable. Create a revised certificate if approved content must change.' : status === 'ISSUED_UNDER_REVIEW' ? 'The signed evidence remains immutable and downloadable while QA decides whether to resend it, revise it, or perform re-testing.' : isRejected ? 'This rejection is terminal and immutable. Create a revised certificate to start a fresh approval workflow.' : status === 'SUPERSEDED' ? 'This signed certificate remains immutable and has been replaced by the linked successor.' : status === 'VOIDED' ? 'This unissued legacy duplicate was retained for audit history and cannot be progressed.' : requiresPopulationRefresh ? 'The certificate owner must refresh this legacy snapshot before submission or approval can continue.' : status === 'DRAFT' ? 'Review the captured evidence and remarks before submitting.' : status === 'SM_APPROVAL_PENDING' ? 'An eligible QA Lead must approve, return, or reject this certificate.' : status === 'DEPT_HEAD_QA_APPROVAL_PENDING' ? 'An independent eligible Executive must make the final decision.' : canResubmit ? 'Update the requested details, then restart approval.' : 'Review the decision history and available actions below.'
  const assignedTesters = item.certificate_summary?.assigned_testers
  const conditionalDetails = item.certificate_summary ? item.certificate_summary.certificate_fields : item

  return (
    <Modal title={item.certificate_id} onClose={onClose} wide>
      <div className="clearance-detail">
      <ErrorText error={error} />
      {takeoverNotice && <div className="alert alert-success" role="status">{takeoverNotice}</div>}
      <section className="clearance-hero clearance-overview" aria-label="Certificate overview">
        <div className="clearance-hero-main"><span className="clearance-eyebrow">QA clearance · {item.certificate_type}</span><h2>{item.application_name}</h2><p>{item.change_description || 'Change description not recorded'}</p><div className="clearance-hero-chips"><span>Revision <b>{item.revision_number || 1}</b></span><span>CR / EPIC <b>{item.change_request_ids || '—'}</b></span><span>Request <b>{item.certificate_testing_request_id || item.testing_request_id || '—'}</b></span><span>Build <b>{item.build_number || '—'}</b></span><span>Testing <b>{item.certificate_testing_type || item.testing_type}</b></span><span>Promotion <b>{item.environment_tested || '—'} → {item.target_promotion_environment || '—'}</b></span><span>Validity <b>{validityLabel(item.validity_from, item.validity_to)}</b></span></div></div>
        <div className="clearance-hero-status"><small>Current status</small><WorkflowStatusBadge record={item} workflow="signoff" status={item.status} label={SIGNOFF_STATUS_LABELS[item.status] || item.status} /><span>{SIGNOFF_PENDING_WITH[status] && SIGNOFF_PENDING_WITH[status] !== '—' ? `Pending with ${SIGNOFF_PENDING_WITH[status]}` : item.certificate_date ? `Dated ${item.certificate_date}` : 'See Approvals & activity'}</span></div>
      </section>
      <nav className="clearance-stage-track" aria-label="Approval progress">{stageNames.map((name, index) => <div key={name} aria-current={index === stageIndex ? 'step' : undefined} className={`clearance-stage ${index < stageIndex ? 'is-done' : index === stageIndex ? (isRejected ? 'is-rejected' : 'is-current') : ''}`}><span>{index === stageIndex && isRejected ? '×' : index < stageIndex || ['ISSUED', 'ISSUED_UNDER_REVIEW', 'SUPERSEDED'].includes(status) ? '✓' : index + 1}</span><b>{name}</b></div>)}</nav>
      {(item.supersedes_id || item.superseded_by_id) && <div className="alert alert-info" role="status">
        <strong>Certificate lineage:</strong>{' '}
        {item.supersedes_id && <button type="button" className="btn btn-sm" disabled={!!busyAction} onClick={() => void openRelatedCertificate(item.supersedes_id!)}>Previous: {item.supersedes_certificate_id || `#${item.supersedes_id}`}</button>}
        {item.superseded_by_id && <button type="button" className="btn btn-sm" disabled={!!busyAction} onClick={() => void openRelatedCertificate(item.superseded_by_id!)}>Successor: {item.superseded_by_certificate_id || `#${item.superseded_by_id}`}</button>}
        {item.revision_reason && <span> Reason: {item.revision_reason}</span>}
      </div>}
      {assignedTesters === undefined ? <div className="clearance-tester-warning" role="status"><b>Assigned testers were not captured in this revision.</b><span>To include their names, refresh the evidence and complete approval again.</span></div> : <div className="clearance-tester-line"><span>Assigned tester(s)</span><b>{assignedTesters.map(tester => tester.name).join(', ') || 'Not assigned'}</b></div>}

      <section className="clearance-action-panel" aria-label="Next step and actions">
        <div className="clearance-section-heading"><div><span>Next action</span><h3>{nextStep}</h3><p>{nextStepHint}</p></div></div>
        {!isImmutableClearanceStatus(status) && <ClearanceRequirements certificateType={item.certificate_type} />}
        <div className="clearance-action-row">
          <button className={['ISSUED', 'ISSUED_UNDER_REVIEW', 'SUPERSEDED'].includes(item.status) ? 'btn btn-sm btn-primary' : 'btn btn-sm'} disabled={!!busyAction} onClick={downloadCertificate}>{busyAction === 'download' ? 'Downloading…' : ['ISSUED', 'ISSUED_UNDER_REVIEW', 'SUPERSEDED'].includes(item.status) ? 'Download Certificate' : 'Export PDF'}</button>
          {canEditDetails && <button className="btn btn-sm" disabled={!!busyAction} onClick={() => setEditing(true)}>Edit Details</button>}
          {canSubmit && <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('submit')}>Submit for QA Lead Approval</button>}
          {canResubmit && <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('resubmit')}>{resubmitLabel}</button>}
          {canCreateRevision && <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => setShowRevision(true)}>Create Revised Certificate</button>}
          {item.can_take_over === true && <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => { setError(null); setTakeoverNotice(''); setShowTakeover(true) }}>Take Over as QA Lead Group</button>}
          {isRequester && !isImmutableClearanceStatus(status) && <button className="btn btn-sm" disabled={!!busyAction} onClick={() => setConfirmRefresh(true)}>Refresh evidence & restart approval</button>}
        </div>
        {revisionBlockedByRetest && <div className="alert alert-info" role="status"><strong>Certificate revision is locked while re-testing is in progress.</strong><span>Complete the new re-execution cycle and mark QA Completed before creating the revised certificate.</span></div>}
      </section>
      {confirmRefresh && <ConfirmModal title="Refresh certificate evidence?" message={<p>This captures current linked results and returns the certificate to Draft. Existing approvals and clearance become invalid. QA Lead and Executive must approve the new revision.</p>} confirmLabel="Refresh & require reapproval" onCancel={() => setConfirmRefresh(false)} onConfirm={() => { setConfirmRefresh(false); void act('refresh-summary') }} />}
      {showRevision && <Modal title="Create Revised Certificate" onClose={() => { if (!busyAction) setShowRevision(false) }} variant="dialog" preventBackdropClose closeDisabled={!!busyAction}>
        <p>{isRejected
          ? 'The rejected certificate remains immutable with its rejection decision. A linked Draft revision will capture current evidence and require fresh QA Lead and Executive approval.'
          : 'The signed certificate remains immutable and will be marked Superseded. A new Draft will capture current evidence and require QA Lead and Executive approval.'}</p>
        <Field label="Revision reason (required)"><textarea maxLength={2000} rows={5} value={revisionReason} onChange={event => setRevisionReason(event.target.value)} placeholder="Describe the agreed certificate changes" /></Field>
        <div className="clearance-action-row"><button type="button" className="btn btn-primary" disabled={!!busyAction || revisionReason.trim().length < 3} onClick={() => void createRevision()}>{busyAction === 'revisions' ? 'Creating…' : 'Create Revision'}</button><button type="button" className="btn" disabled={!!busyAction} onClick={() => setShowRevision(false)}>Cancel</button></div>
      </Modal>}
      {showTakeover && <Modal title="Take Over Certificate Ownership" onClose={() => { if (!busyAction) setShowTakeover(false) }} variant="dialog" preventBackdropClose closeDisabled={!!busyAction}>
        <p>This QA Lead Group recovery action is available because the current certificate owner can no longer act. It transfers the editable Draft to you, clears prior approvals, and preserves the certificate evidence and audit history.</p>
        <p>A different eligible QA Lead must approve the certificate after you submit it.</p>
        <Field label="Takeover reason (required)"><textarea maxLength={2000} rows={5} value={takeoverReason} onChange={event => setTakeoverReason(event.target.value)} placeholder="Explain why the current QA author cannot continue" /></Field>
        <ErrorText error={error} />
        <div className="clearance-action-row"><button type="button" className="btn btn-primary" disabled={!!busyAction || takeoverReason.trim().length < 10} onClick={() => void takeOverCertificate()}>{busyAction === 'qa-lead-group-takeover' ? 'Transferring…' : 'Confirm QA Lead Group Takeover'}</button><button type="button" className="btn" disabled={!!busyAction} onClick={() => setShowTakeover(false)}>Cancel</button></div>
      </Modal>}

      {canQALeadDecide && <div className="clearance-decision-buttons"><ApprovalDecisionButtons userName={user?.full_name} comments={comments} busy={!!busyAction} onApprove={(signed) => act('qa-lead-decision', { decision: 'Approved', comments: signed })} onReturn={(actionNote) => act('qa-lead-decision', { decision: 'Returned', comments: actionNote })} onReject={(actionNote) => act('qa-lead-decision', { decision: 'Rejected', comments: actionNote })} /></div>}
      {canExecutiveCoeDecide && <div className="clearance-decision-buttons"><ApprovalDecisionButtons userName={user?.full_name} comments={comments} busy={!!busyAction} approveLabel="Approve & Issue Certificate" onApprove={(signed) => act('executive-coe-decision', { decision: 'Approved', comments: signed })} onReturn={(actionNote) => act('executive-coe-decision', { decision: 'Returned', comments: actionNote })} onReject={(actionNote) => act('executive-coe-decision', { decision: 'Rejected', comments: actionNote })} /></div>}
      {awaitingIndependentExecutive && <div className="alert alert-info signoff-independent-approval" role="status"><strong>Your QA Lead e-signature is already recorded.</strong><span>Final Executive approval must be completed by another eligible Chief Manager QA or AGM QA. No additional signature or decision is required from you at this stage.</span></div>}

      <div className="clearance-tabs" role="tablist" aria-label="Certificate sections">
        {detailTabs.map(([key, label], index) => <button key={key} type="button" role="tab" id={`clearance-tab-${key}`} aria-controls={`clearance-panel-${key}`} aria-selected={detailTab === key} tabIndex={detailTab === key ? 0 : -1} onClick={() => setDetailTab(key)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % detailTabs.length : event.key === 'ArrowLeft' ? (index + detailTabs.length - 1) % detailTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : null
          if (next !== null) { event.preventDefault(); setDetailTab(detailTabs[next][0]); document.getElementById(`clearance-tab-${detailTabs[next][0]}`)?.focus() }
        }}>{label}</button>)}
      </div>
      <div className="clearance-tab-panel" role="tabpanel" id="clearance-panel-evidence" aria-labelledby="clearance-tab-evidence" hidden={detailTab !== 'evidence'} tabIndex={0}>
      <CertificateEvidence item={item} />
      </div>
      <div className="clearance-tab-panel" role="tabpanel" id="clearance-panel-details" aria-labelledby="clearance-tab-details" hidden={detailTab !== 'details'} tabIndex={0}>
      <details open className="clearance-detail-fields"><summary><span><b>Certificate details</b><small>Scope, ownership, environment, and validity</small></span><span>View details</span></summary><div className="clearance-fact-grid">
        <ClearanceFact label="Application owner">{item.application_owner || '—'}</ClearanceFact><ClearanceFact label="Request department">{item.request_department || '—'}</ClearanceFact><ClearanceFact label="Approving QA team">{item.approving_qa_team || 'Not configured'}</ClearanceFact>
        <ClearanceFact label="Requested by (QA team)">{userName(users, item.requester_id) || '—'}</ClearanceFact><ClearanceFact label="Approved by (QA Lead)">{userName(users, item.reviewed_by_id) || '—'}</ClearanceFact><ClearanceFact label="Approved by (Executive)">{userName(users, item.approved_by_id) || '—'}</ClearanceFact>
        <ClearanceFact label="Revision">{item.revision_number || 1}</ClearanceFact><ClearanceFact label="Testing type">{item.certificate_testing_type || item.testing_type}</ClearanceFact><ClearanceFact label="Certificate date">{item.certificate_date || '—'}</ClearanceFact><ClearanceFact label="Vendor / SI partner">{item.vendor_si_partner || '—'}</ClearanceFact><ClearanceFact label="Technology stack">{item.technology_stack || '—'}</ClearanceFact><ClearanceFact label="Release / build">{item.release_version || '—'} / {item.build_number || '—'}</ClearanceFact><ClearanceFact label="Environment tested">{item.environment_tested || '—'}</ClearanceFact><ClearanceFact label="Target promotion">{item.target_promotion_environment || '—'}</ClearanceFact><ClearanceFact label="Risk tier">{item.risk_tier || '—'}</ClearanceFact><ClearanceFact label="Validity">{validityLabel(item.validity_from, item.validity_to)}</ClearanceFact>
      </div></details>
      </div>
      <div className="clearance-tab-panel" role="tabpanel" id="clearance-panel-remarks" aria-labelledby="clearance-tab-remarks" hidden={detailTab !== 'remarks'} tabIndex={0}>
      <section className="clearance-remarks" id="clearance-remarks"><div className="clearance-section-heading"><div><span>Clearance assessment</span><h3>Remarks & risks</h3><p>Scope, risks, business acceptance, and security status</p></div></div><div className="clearance-remark-grid">
        {([
          ['exit_criteria_notes', 'Testing Scope Completed'], ['open_defect_summary', 'Open Risks (if any)'],
          ['known_limitations', 'Known Limitations'], ['business_acceptance_status', 'Business Acceptance Status'],
          ['security_testing_status', 'Security Testing Status'],
          ['residual_risk_notes', 'Remarks'],
        ] as const).map(([key, label]) => <article key={key}><h4>{label}</h4>{item[key] ? <AuthenticatedMarkdown value={item[key]!} basePath={`/api/signoffs/${item.id}/documents`} /> : <span className="muted">Not recorded</span>}</article>)}
      </div></section>

      {item.certificate_type === 'Conditional Clearance' && <section className="clearance-conditional" id="clearance-conditional">
      <div className="clearance-section-heading clearance-conditional-heading"><div><span>Conditional clearance</span><h3>Conditions & observations</h3><p>Only included for conditional certificates</p></div></div>
      <div className="clearance-remark-grid">
        <article><h4>Residual-risk remarks</h4>{conditionalDetails?.residual_risk_notes ? <AuthenticatedMarkdown value={conditionalDetails.residual_risk_notes} basePath={`/api/signoffs/${item.id}/documents`} /> : <span className="muted">Not recorded</span>}</article>
        <article><h4>Mitigation</h4>{conditionalDetails?.conditional_mitigation ? <AuthenticatedMarkdown value={conditionalDetails.conditional_mitigation} basePath={`/api/signoffs/${item.id}/documents`} /> : <span className="muted">Not recorded</span>}</article>
      </div>
      <dl className="clearance-fact-grid"><ClearanceFact label="Responsible owner">{conditionalDetails?.conditional_owner || 'Not recorded'}</ClearanceFact><ClearanceFact label="Target date">{conditionalDetails?.conditional_target_date || 'Not recorded'}</ClearanceFact></dl>
      {(item.certificate_summary ? item.certificate_summary.conditional_observations : item.conditional_observations)?.trim()
        ? <><p className="muted small">User-entered observations</p><AuthenticatedMarkdown value={(item.certificate_summary ? item.certificate_summary.conditional_observations : item.conditional_observations)!} basePath={`/api/signoffs/${item.id}/documents`} /></>
        : <><p className="muted small">Generated from the frozen linked-defect evidence.</p>{item.certificate_summary?.observations?.length ? <Table rows={item.certificate_summary.observations} rowKey="defect_key" columns={[{ key: 'defect_key', header: 'Defect' }, { key: 'functionality', header: 'Functionality' }, { key: 'observation', header: 'Observation' }, { key: 'severity', header: 'Severity' }, { key: 'owner', header: 'Owner' }, { key: 'target_date', header: 'Target date' }]} /> : <p>{item.certificate_summary ? 'No open linked defect observations in the captured evidence.' : 'Refresh summaries to generate observations; full reapproval is required.'}</p>}</>}

      </section>}

      </div>
      <div className="clearance-tab-panel" role="tabpanel" id="clearance-panel-activity" aria-labelledby="clearance-tab-activity" hidden={detailTab !== 'activity'} tabIndex={0}>
      {signatures.length > 0 && <>
        <div className="clearance-section-heading"><div><span>Approval record</span><h3>Electronic signatures</h3><p>Latest recorded signature for each approval stage</p></div></div>
        <div className="signoff-signature-list">
          {signatures.map((signature) => <article className="signoff-signature-card" key={signature.signatureId}>
            <header><span>✓</span><div><small>{signature.stage}</small><strong>Electronically signed</strong></div></header>
            <div className={`signoff-signature-mark signature-style-${signature.style}`}>{signature.signer}</div>
            <dl><div><dt>Signer</dt><dd>{signature.signer}</dd></div><div><dt>Signed at</dt><dd>{formatDateTimeIST(signature.appliedAt)}</dd></div><div className="signature-id"><dt>Signature ID</dt><dd><code>{signature.signatureId}</code></dd></div></dl>
            <p>{signature.intent}</p>
            <Link className="btn btn-sm" to={`/verify-signature?id=${encodeURIComponent(signature.signatureId)}`}>Verify this signature</Link>
          </article>)}
        </div>
      </>}

      <JiraActivity ownerWorkspaceId={item.qa_workspace_id} entityType="SIGNOFF" entityId={item.id} items={history} onPosted={(entry) => setHistory((prev) => [...prev, entry])} />
      </div>
      <div className="clearance-tab-panel" role="tabpanel" id="clearance-panel-documents" aria-labelledby="clearance-tab-documents" hidden={detailTab !== 'documents'} tabIndex={0}>
      <div className="clearance-section-heading"><div><span>Supporting material</span><h3>Documents</h3><p>Evidence and attachments linked to this certificate</p></div></div>
      <RequestDocuments apiBase="/api/signoffs" reqId={item.id} canManage={canManageDocuments} />
      </div>

      {editing && (
        <EditSignOffModal
          item={item}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setEditing(false); onChanged(updated); void load() }}
        />
      )}
      </div>
    </Modal>
  )
}

type SignOffListRow = Pick<SignOffOut, 'id' | 'certificate_id' | 'certificate_type' | 'certificate_testing_type' | 'application_name' | 'change_description' | 'request_department' | 'requester_id' | 'reviewed_by_id' | 'approved_by_id' | 'status' | 'created_at' | 'qa_workspace_id'>
type SignOffPage = PageOut<SignOffListRow> & { departments: string[]; status_counts: Record<string, number> }

export default function SignOff() {
  const viewerManagedDeepLinks = useViewerManagedDeepLinks()
  const { user } = useAuth()
  const [result, setResult] = useState<SignOffPage | null>(null)
  const rows = result?.items || []
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [openingId, setOpeningId] = useState<number | null>(null)
  const loadGeneration = useRef(0)
  const openGeneration = useRef(0)
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<SignOffOut | null>(null)
  const [users, setUsers] = useState<UserOption[]>([])
  const [departmentFilter, setDepartmentFilter] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  // Reported directly ("still not working" / "nothing happens") -- the
  // register's Download button previously called api.downloadFile()
  // directly with no await/catch, so a failure (expired session, 404, a
  // backend error) became a silent unhandled promise rejection instead of
  // anything the user could see. downloadingId also disables the button
  // mid-flight so a slow response can't be double-clicked.
  const [downloadingId, setDownloadingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ page: String(page), page_size: String(pageSize), search, department: departmentFilter })
    try {
      const response = await api.get<SignOffPage>(`/api/signoffs?${qs}`)
      if (generation === loadGeneration.current) setResult(response)
    } catch (err) { if (generation === loadGeneration.current) setError(err) }
    finally { if (generation === loadGeneration.current) setLoading(false) }
  }, [page, pageSize, search, departmentFilter])

  const openCertificate = useCallback(async (id: number) => {
    const generation = ++openGeneration.current
    setOpeningId(id)
    try {
      const detail = await api.get<SignOffOut>(`/api/signoffs/${id}`)
      if (generation === openGeneration.current) setSelected(detail)
    } catch (err) { if (generation === openGeneration.current) setError(err) }
    finally { if (generation === openGeneration.current) setOpeningId(null) }
  }, [])

  async function downloadCertificate(row: SignOffListRow) {
    setError(null)
    setDownloadingId(row.id)
    try {
      await api.downloadFile(`/api/signoffs/${row.id}/export`, `${row.certificate_id}.pdf`)
    } catch (err) { setError(err) } finally { setDownloadingId(null) }
  }
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => { window.clearTimeout(timer); loadGeneration.current++ } }, [load])
  useEffect(() => {
    api.get<UserOption[]>('/api/auth/user-options').then(setUsers).catch(() => { /* names just stay empty */ })
  }, [])

  // Same "?open=<certificate_id>" deep-link pattern as Functional/SAST/DAST/
  // Performance/Suppression -- lets the topbar search box jump straight to a
  // specific sign-off certificate's detail drawer instead of just landing on
  // this list.
  useEffect(() => {
    if (viewerManagedDeepLinks) return
    const recordId = Number(searchParams.get('openId'))
    const openId = searchParams.get('open')
    if (!openId && !(Number.isInteger(recordId) && recordId > 0)) return
    let active = true
    resolveRequestId({ path: '/signoff', identifier: recordId > 0 ? String(recordId) : openId! }, url => api.get(url))
      .then(id => { if (active) return openCertificate(id) }).catch(err => { if (active) setError(err) })
    return () => { active = false }
  }, [searchParams, viewerManagedDeepLinks, openCertificate])

  const departments = result?.departments || []
  const counts = result?.status_counts || {}
  const issuedCount = counts.ISSUED || 0
  const reviewCount = ['SM_APPROVAL_PENDING', 'DEPT_HEAD_QA_APPROVAL_PENDING'].reduce((sum, status) => sum + (counts[status] || 0), 0)
  const actionCount = ['DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPT_HEAD_COE', 'RETURNED_BY_REQUESTER', 'DEPT_HEAD_COE_REJECTED', 'ISSUED_UNDER_REVIEW'].reduce((sum, status) => sum + (counts[status] || 0), 0)

  // 2026-08 -- reported directly: "'Request Sign Off' button is not
  // enable[d] for QA lead ... in sign off ... section" -- widened from
  // QA_ENGINEER-only to also include the QA Lead group, matching the
  // backend's now-widened POST /api/signoffs role gate (signoff.py's
  // create_signoff), so a QA Lead can raise a certificate themselves (e.g.
  // on behalf of a request whose assigned tester isn't available).
  const canCreate = hasWorkspaceRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')

  return (
    <div className="clearance-register">
      <ErrorText error={error} />
      <PageHeader
        title="QA Clearance Certificates" count={result?.total || 0}
        subtitle="Workspace QA clearance certificates: raised by QA, approved by the QA Lead, then issued after Executive approval."
        actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Clearance Certificate</button>}
      />
      <Card>
        <div className="clearance-register-summary" aria-label="Certificate status overview">
          <div><small>Total certificates</small><strong>{result?.total || 0}</strong><span>In selected department scope</span></div>
          <div><small>Awaiting approval</small><strong>{reviewCount}</strong><span>QA Lead or Executive</span></div>
          <div><small>Needs revision / draft</small><strong>{actionCount}</strong><span>Requester action may be needed</span></div>
          <div><small>Issued</small><strong>{issuedCount}</strong><span>Ready to download</span></div>
        </div>
        <div className="signoff-register-toolbar">
          <div><strong>Certificate Register</strong><span>{rows.length} of {result?.total || 0} certificates</span></div>
          <label><span>Request Department</span><select value={departmentFilter} onChange={(event) => { setDepartmentFilter(event.target.value); setPage(1) }}><option value="">All departments</option>{departments.map((department) => <option key={department} value={department}>{department}</option>)}</select></label>
        </div>
        <input aria-label="Search certificates" placeholder="Search certificate, application or request ID…" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} />
        {openingId !== null && <p role="status">Loading certificate…</p>}
        <Table rowKey="id" onRowClick={(r) => void openCertificate(r.id)}
          server={{ page, pageSize, total: result?.total || 0, totalPages: result?.total_pages || 1,
            hasNext: result?.has_next || false, hasPrevious: result?.has_previous || false, loading,
            onPageChange: setPage, onPageSizeChange: size => { setPageSize(size); setPage(1) } }} columns={[
          // Reported directly: "where is download button?" -- it was added
          // as the LAST of 11 columns (see the removed 'download' column
          // this replaced), which on a wide register requires scrolling all
          // the way right to even see, let alone use -- easy to miss
          // entirely, and blank/unlabeled column headers don't help. Moved
          // into the Certificate ID cell instead -- the first column, so
          // it's visible at the register's default (unscrolled) position no
          // matter how many other columns are showing. Still only rendered
          // once Issued (see the original comment on this, preserved
          // below); e.stopPropagation() so clicking Download doesn't also
          // open the row's detail modal underneath it.
          {
            key: 'certificate_id', header: 'Certificate ID',
            render: (r) => (
              <span className="signoff-id-cell">
                <span>{r.certificate_id}</span>
                {['ISSUED', 'ISSUED_UNDER_REVIEW', 'SUPERSEDED'].includes(r.status) && (
                  <button type="button" className="btn btn-sm btn-primary" disabled={downloadingId === r.id} onClick={(e) => { e.stopPropagation(); downloadCertificate(r) }}>
                    {downloadingId === r.id ? 'Downloading…' : 'Download'}
                  </button>
                )}
              </span>
            ),
            filterValue: (r) => r.certificate_id,
          },
          { key: 'status', header: 'Status', render: (r) => <WorkflowStatusBadge record={r} workflow="signoff" status={r.status} label={SIGNOFF_STATUS_LABELS[r.status] || r.status} /> },
          { key: 'application_name', header: 'Application' },
          { key: 'change_description', header: 'Change Description', render: (r) => (
            <span className="truncate-cell" title={r.change_description || ''}>{r.change_description || '—'}</span>
          ), filterValue: (r) => r.change_description || '' },
          { key: 'request_department', header: 'Department', render: (r) => r.request_department || '—' },
          { key: 'requester_id', header: 'Requested By', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
          { key: 'reviewed_by_id', header: 'Reviewed By', render: (r) => userName(users, r.reviewed_by_id) || '—', filterValue: (r) => userName(users, r.reviewed_by_id) || '' },
          { key: 'approved_by_id', header: 'Approved By', render: (r) => userName(users, r.approved_by_id) || '—', filterValue: (r) => userName(users, r.approved_by_id) || '' },
          { key: 'certificate_type', header: 'Type' },
          { key: 'certificate_testing_type', header: 'Testing Type' },
          { key: 'pending_with', header: 'Pending With', render: (r) => SIGNOFF_PENDING_WITH[r.status] || '—', filterValue: (r) => SIGNOFF_PENDING_WITH[r.status] || '' },
        ]} rows={rows} />
      </Card>
      {showNew && <NewSignOffModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <SignOffDetail item={selected} onClose={() => { setSelected(null); setSearchParams(p => { p.delete("open"); p.delete("openId"); return p }, { replace: true }) }} onChanged={(u) => { setSelected(u); load() }} users={users} />}
    </div>
  )
}
