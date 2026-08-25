import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, RequestDocuments, ApprovalDecisionButtons } from '../../components/Common'
import {
  CERTIFICATE_TYPES, SIGNOFF_TESTING_TYPES, RISK_TIERS, DEPLOYMENT_ENVIRONMENTS, hasRole, hasDepartment,
  SIGNOFF_EDITABLE_STATUSES, QA_DEPARTMENT, SIGNOFF_STATUS_LABELS, SIGNOFF_PENDING_WITH,
  QA_LEAD_GROUP_ROLES, validTargetPromotionOptions, validEnvironmentPromotion,
} from '../../constants'
import { SignOffOut, UserOut, FunctionalOut, FunctionalListOut, PageOut, ApprovalActionOut } from '../../types'
import JiraActivity, { AuthenticatedMarkdown } from '../../components/JiraActivity'
import JiraRichTextField from '../../components/JiraRichTextField'
import ClearableSearchInput from '../../components/ClearableSearchInput'

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
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
  if (!form.residual_risk_notes.trim()) return 'Remarks are required.'
  return null
}

// Searchable "Testing Request ID" autosuggest over Functional Testing
// Requests -- same pattern as Suppression.tsx's SAST/DAST RequestIdSearch.
// Selecting a match hands the full FunctionalOut record back to the caller,
// which derives every auto-populated certificate field from it (see
// NewSignOffModal::applyRequest below).
function TestingRequestIdSearch({ requests, selected, onSelect, onClear }: {
  requests: FunctionalListOut[]
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
    // SIGNOFF_ELIGIBLE_STATUSES filtering now happens server-side via
    // PAG-001's multi-value `status` param, instead of fetching every
    // Functional Testing Request and filtering client-side. page_size=100
    // is the same "good enough for a picker, not exhaustive" compatibility
    // cap used by the other pickers built on top of a paginated endpoint
    // (see QARequests/index.tsx's own openRequest comment for the pattern).
    const statusQuery = SIGNOFF_ELIGIBLE_STATUSES.map((s) => `status=${encodeURIComponent(s)}`).join('&')
    api.get<PageOut<FunctionalListOut>>(`/api/functional-requests?${statusQuery}&page_size=100`)
      .then((p) => setEligibleRequests(p.items))
      .catch(setError)
  }, [presetRequest, applyRequest])

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
      applyRequest(full)
    } catch (err) {
      setError(err)
    } finally {
      setSelecting(false)
    }
  }, [applyRequest])

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
    if (!selectedRequest) { setError('Pick a Testing Request ID first -- Application Name, Owner and CR Number/EPIC Number are derived from it.'); return }
    if (!hasRole(user, 'ADMIN') && !hasDepartment(user, QA_DEPARTMENT)) {
      setError(`QA Clearance is restricted to the ${QA_DEPARTMENT} department.`)
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
      })
      // Best-effort: the certificate itself is already created at this point,
      // so a failed upload shouldn't block onCreated -- surface the error but
      // still hand back the created certificate (its own Documents tab, via
      // RequestDocuments in SignOffDetail below, can always retry the upload).
      // Screenshots pasted into Exit Criteria/Open Defect/Residual Risk are
      // never embedded inline (same as every other JiraRichTextField in the
      // app) -- they're combined with the explicitly-picked Supporting
      // Documents and uploaded together here.
      const allFiles = [...files, ...exitCriteriaImages, ...openDefectImages, ...residualRiskImages]
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
      <form onSubmit={submit}>
        <Field label="Testing Request ID *">
          {presetRequest ? (
            <div className="searchable-select">
              <div className="searchable-select-trigger" style={{ cursor: 'default' }}>
                <span>{presetRequest.request_id} — {presetRequest.application_name || '—'}</span>
              </div>
            </div>
          ) : (
            <TestingRequestIdSearch requests={eligibleRequests} selected={selectedRequest} onSelect={selectEligibleRequest} onClear={clearSelection} />
          )}
        </Field>
        <div className="form-row">
          <Field label="Application Name *"><input required disabled value={form.application_name} onChange={() => {}} /></Field>
          <Field label="Application Owner *"><input required disabled value={form.application_owner} onChange={() => {}} /></Field>
          <Field label="QA Approval Department *"><input required disabled value={form.department || QA_DEPARTMENT} onChange={() => {}} /></Field>
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
            <select required value={form.testing_type} onChange={(e) => set('testing_type', e.target.value)}>
              {SIGNOFF_TESTING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
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
        <Field label="Exit Criteria Validation Notes *"><JiraRichTextField value={form.exit_criteria_notes} onChange={(value) => set('exit_criteria_notes', value)} onImagesChange={setExitCriteriaImages} ariaLabel="Exit Criteria Validation Notes" placeholder="Document validation performed against the exit criteria…" /></Field>
        <Field label="Open Defect Review Summary *"><JiraRichTextField value={form.open_defect_summary} onChange={(value) => set('open_defect_summary', value)} onImagesChange={setOpenDefectImages} ariaLabel="Open Defect Review Summary" placeholder="Summarize open defects, severity, ownership and disposition…" /></Field>
        <Field label="Remarks *"><JiraRichTextField value={form.residual_risk_notes} onChange={(value) => set('residual_risk_notes', value)} onImagesChange={setResidualRiskImages} ariaLabel="Remarks" placeholder="Add remarks…" /></Field>
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
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [exitCriteriaImages, setExitCriteriaImages] = useState<File[]>([])
  const [openDefectImages, setOpenDefectImages] = useState<File[]>([])
  const [residualRiskImages, setResidualRiskImages] = useState<File[]>([])
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
      })
      // Same best-effort convention as NewSignOffModal above -- the edit
      // itself already succeeded, so a failed image upload shouldn't block
      // handing back the saved certificate.
      const images = [...exitCriteriaImages, ...openDefectImages, ...residualRiskImages]
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
        <Field label="Exit Criteria Validation Notes *"><JiraRichTextField value={form.exit_criteria_notes} onChange={(value) => set('exit_criteria_notes', value)} onImagesChange={setExitCriteriaImages} ariaLabel="Exit Criteria Validation Notes" placeholder="Document validation performed against the exit criteria…" /></Field>
        <Field label="Open Defect Review Summary *"><JiraRichTextField value={form.open_defect_summary} onChange={(value) => set('open_defect_summary', value)} onImagesChange={setOpenDefectImages} ariaLabel="Open Defect Review Summary" placeholder="Summarize open defects, severity, ownership and disposition…" /></Field>
        <Field label="Remarks *"><JiraRichTextField value={form.residual_risk_notes} onChange={(value) => set('residual_risk_notes', value)} onImagesChange={setResidualRiskImages} ariaLabel="Remarks" placeholder="Add remarks…" /></Field>
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

  const isRequester = item.requester_id === user?.id || hasRole(user, 'ADMIN')
  const status = item.status
  const isAdmin = hasRole(user, 'ADMIN')
  const isQADepartment = hasDepartment(user, QA_DEPARTMENT) || isAdmin

  const canSubmit = isRequester && status === 'DRAFT'
  // SM_REJECTED ("Rejected by QA Lead" here) included alongside RETURNED_BY_*
  // -- reported directly, a rejected certificate is now reopenable (edit +
  // resubmit) instead of a dead end.
  // RETURNED_BY_REQUESTER (2026-08) added -- reported directly: "qa edit
  // the required requested thing, but how to submit !! there is no such
  // submit !!" -- SIGNOFF_EDITABLE_STATUSES already let the QA Engineer
  // edit a certificate in this status (routers/signoff.py::update_signoff),
  // but this button's own status list was never updated to match, so there
  // was genuinely no way to submit the edit -- editing worked, resubmitting
  // didn't. resubmit_signoff (backend) already accepts this status and
  // routes it to SM_APPROVAL_PENDING (QA Lead), same as a reopen.
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPT_HEAD_COE', 'RETURNED_BY_REQUESTER'].includes(status)
  const resubmitLabel = (status === 'SM_REJECTED' || status === 'RETURNED_BY_REQUESTER') ? 'Reopen Certificate' : 'Re-submit'
  // Reported directly: a person who raised this certificate but also
  // separately holds QA Lead/Executive  must not be able to approve
  // their own certificate -- someone else holding that role must decide it
  // instead. Admin still bypasses (matches the backend's
  // require_not_requester, which enforces the same check server-side).
  const isSelfApproval = item.requester_id === user?.id && !isAdmin
  const isPriorStageApprover = item.reviewed_by_id === user?.id && !isAdmin
  // Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on this QA Lead
  // checkpoint, same as Admin -- see ORACLE_MIGRATION_2026-07.md section 59.
  const canQALeadDecide = hasRole(user, ...QA_LEAD_GROUP_ROLES) && status === 'SM_APPROVAL_PENDING' && isQADepartment && !isSelfApproval
  // Reported directly ("Executive also Chief Manager and AGM only") while
  // verifying this checkpoint's role set -- this was missing CHIEF_MANAGER_QA
  // entirely (only checked AGM_QA), even though the backend's
  // executive_coe_decision (signoff.py) already require_roles()'d both. A
  // Chief Manager - QA account couldn't even see these buttons; now fixed to
  // match the backend exactly.
  const canExecutiveCoeDecide = hasRole(user, 'CHIEF_MANAGER_QA', 'AGM_QA') && status === 'DEPT_HEAD_QA_APPROVAL_PENDING' && isQADepartment && !isSelfApproval && !isPriorStageApprover
  const awaitingIndependentExecutive = status === 'DEPT_HEAD_QA_APPROVAL_PENDING' && isPriorStageApprover
  // Reported directly: "only the assigned person can update" -- once the
  // certificate has moved past the requester, document control passes
  // exclusively to whoever it's actually sitting with now, matching the
  // backend's own (now-exclusive) _can_upload_documents (signoff.py).
  const canManageDocuments = isAdmin || (
    ['DRAFT', 'SUBMITTED', 'RETURNED_BY_SM', 'SM_REJECTED', 'RETURNED_BY_DEPT_HEAD_COE', 'RETURNED_BY_REQUESTER'].includes(status) ? isRequester :
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
      const signature = recordedSignature(item)
      if (signature) byStage.set(signature.stage, signature)
    }
    return Array.from(byStage.values())
  }, [history])

  return (
    <Modal title={item.certificate_id} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>Application:</strong> {item.application_name}</div>
        <div><strong>Status:</strong> <Badge status={item.status} label={SIGNOFF_STATUS_LABELS[item.status] || item.status} /></div>
        <div><strong>Testing Request ID:</strong> {item.testing_request_id || '—'}</div>
        <div><strong>CR Number/EPIC Number:</strong> {item.change_request_ids || '—'}</div>
        <div><strong>Change Description:</strong> {item.change_description || '—'}</div>
        <div><strong>Application Owner:</strong> {item.application_owner || '—'}</div>
        <div><strong>Request Department:</strong> {item.request_department || '—'}</div>
        <div><strong>QA Approval Department:</strong> {item.department || QA_DEPARTMENT}</div>
        <div><strong>Requested By (QA Team):</strong> {userName(users, item.requester_id) || '—'}</div>
        <div><strong>Approved By (QA Lead):</strong> {userName(users, item.reviewed_by_id) || '—'}</div>
        <div><strong>Approved By (Executive):</strong> {userName(users, item.approved_by_id) || '—'}</div>
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
        <div><strong>Exit Criteria Validation Notes:</strong>{item.exit_criteria_notes ? <AuthenticatedMarkdown value={item.exit_criteria_notes} basePath={`/api/signoffs/${item.id}/documents`} /> : '—'}</div>
        <div><strong>Open Defect Review Summary:</strong>{item.open_defect_summary ? <AuthenticatedMarkdown value={item.open_defect_summary} basePath={`/api/signoffs/${item.id}/documents`} /> : '—'}</div>
        <div><strong>Remarks:</strong>{item.residual_risk_notes ? <AuthenticatedMarkdown value={item.residual_risk_notes} basePath={`/api/signoffs/${item.id}/documents`} /> : '—'}</div>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '10px 0 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Reported directly: "'Export PDF' is too much generic, once
            certificate issue it should be like download certificate." It's
            only actually a finished certificate once Issued -- before that
            this is exporting an in-progress draft, so the generic label
            stays for every earlier status and only flips (label + styling)
            once the real thing exists to download. Same export endpoint
            either way, just the label/emphasis changes. */}
        <button
          className={item.status === 'ISSUED' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
          disabled={!!busyAction}
          onClick={downloadCertificate}
        >
          {busyAction === 'download' ? 'Downloading…' : item.status === 'ISSUED' ? 'Download Certificate' : 'Export PDF'}
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
      {awaitingIndependentExecutive && (
        <div className="alert alert-info signoff-independent-approval" role="status">
          <strong>Your QA Lead e-signature is already recorded.</strong>
          <span>Final Executive approval must be completed by another eligible Chief Manager QA or AGM QA. No additional signature or decision is required from you at this stage.</span>
        </div>
      )}

      {signatures.length > 0 && <>
        <div className="section-title">Electronic Signatures</div>
        <div className="signoff-signature-list">
          {signatures.map((signature) => <article className="signoff-signature-card" key={signature.signatureId}>
            <header><span>✓</span><div><small>{signature.stage}</small><strong>Electronically signed</strong></div></header>
            <div className={`signoff-signature-mark signature-style-${signature.style}`}>{signature.signer}</div>
            <dl><div><dt>Signer</dt><dd>{signature.signer}</dd></div><div><dt>Signed at</dt><dd>{formatDateTimeIST(signature.appliedAt)}</dd></div><div className="signature-id"><dt>Signature ID</dt><dd><code>{signature.signatureId}</code></dd></div></dl>
            <p>{signature.intent}</p>
          </article>)}
        </div>
      </>}

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
    try { setRows(await api.get<SignOffOut[]>('/api/signoffs')) } catch (err) { setError(err) }
  }, [])

  async function downloadCertificate(row: SignOffOut) {
    setError(null)
    setDownloadingId(row.id)
    try {
      await api.downloadFile(`/api/signoffs/${row.id}/export`, `${row.certificate_id}.pdf`)
    } catch (err) { setError(err) } finally { setDownloadingId(null) }
  }
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

  const departments = useMemo(() => Array.from(new Set(rows.map((row) => row.request_department).filter((value): value is string => !!value))).sort((a, b) => a.localeCompare(b)), [rows])
  const visibleRows = useMemo(() => departmentFilter ? rows.filter((row) => row.request_department === departmentFilter) : rows, [rows, departmentFilter])

  // 2026-08 -- reported directly: "'Request Sign Off' button is not
  // enable[d] for QA lead ... in sign off ... section" -- widened from
  // QA_ENGINEER-only to also include the QA Lead group, matching the
  // backend's now-widened POST /api/signoffs role gate (signoff.py's
  // create_signoff), so a QA Lead can raise a certificate themselves (e.g.
  // on behalf of a request whose assigned tester isn't available).
  const canCreate = hasRole(user, 'ADMIN')
    || (hasRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA') && hasDepartment(user, QA_DEPARTMENT))

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="QA Clearance Certificates" count={rows.length}
        subtitle="COE - Quality Assurance clearance certificates: raised by QA, approved by the QA Lead, then issued after Executive approval."
        actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Clearance Certificate</button>}
      />
      <Card>
        <div className="signoff-register-toolbar">
          <div><strong>Certificate Register</strong><span>{visibleRows.length} of {rows.length} certificates</span></div>
          <label><span>Request Department</span><select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option value="">All departments</option>{departments.map((department) => <option key={department} value={department}>{department}</option>)}</select></label>
        </div>
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
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
                {r.status === 'ISSUED' && (
                  <button type="button" className="btn btn-sm btn-primary" disabled={downloadingId === r.id} onClick={(e) => { e.stopPropagation(); downloadCertificate(r) }}>
                    {downloadingId === r.id ? 'Downloading…' : 'Download'}
                  </button>
                )}
              </span>
            ),
            filterValue: (r) => r.certificate_id,
          },
          { key: 'application_name', header: 'Application' },
          { key: 'change_description', header: 'Change Description', render: (r) => (
            <span className="truncate-cell" title={r.change_description || ''}>{r.change_description || '—'}</span>
          ), filterValue: (r) => r.change_description || '' },
          { key: 'request_department', header: 'Department', render: (r) => r.request_department || '—' },
          { key: 'requester_id', header: 'Requested By', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
          { key: 'reviewed_by_id', header: 'Reviewed By', render: (r) => userName(users, r.reviewed_by_id) || '—', filterValue: (r) => userName(users, r.reviewed_by_id) || '' },
          { key: 'approved_by_id', header: 'Approved By', render: (r) => userName(users, r.approved_by_id) || '—', filterValue: (r) => userName(users, r.approved_by_id) || '' },
          { key: 'certificate_type', header: 'Type' },
          { key: 'testing_type', header: 'Testing Type' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} label={SIGNOFF_STATUS_LABELS[r.status] || r.status} /> },
          { key: 'pending_with', header: 'Pending With', render: (r) => SIGNOFF_PENDING_WITH[r.status] || '—', filterValue: (r) => SIGNOFF_PENDING_WITH[r.status] || '' },
        ]} rows={visibleRows} />
      </Card>
      {showNew && <NewSignOffModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <SignOffDetail item={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} />}
    </div>
  )
}
