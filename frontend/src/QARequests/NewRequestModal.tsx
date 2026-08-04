import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Modal, ErrorText } from '../components/Common'
import ConfirmModal from '../components/ConfirmModal'
import { IconCheckCircle } from '../components/Icons'
import { QARequestOut } from '../types'
import { EMPTY_FORM, QARequestForm, blankSastComponent, blankDastComponent } from './types'
import { buildSteps } from './buildSteps'
import { detailsStepError, typeStepError, sastStepError, dastStepError } from './validation'
import { GatewayPreview, gatewayStageIndex } from './GatewayPreview'
import { DetailsStep } from './steps/DetailsStep'
import { TypeStep } from './steps/TypeStep'
import { FunctionalStep } from './steps/FunctionalStep'
import { SastStep } from './steps/SastStep'
import { DastStep } from './steps/DastStep'
import { PerformanceStep } from './steps/PerformanceStep'
import { DocumentsStep } from './steps/DocumentsStep'
import { EvidenceKind, evidenceKey } from './steps/ChecklistEvidencePicker'

interface NewRequestModalProps {
  onClose: () => void
  onCreated: (req: QARequestOut) => void
  editing?: QARequestOut
}

// Builds the wizard's initial form state -- blank for a brand-new request,
// or pre-filled from an existing (still-Draft) request being edited. Kept
// as its own function (rather than inline in useState) purely to keep the
// component below shorter and easier to scan.
function buildInitialForm(editing: QARequestOut | undefined, department: string): QARequestForm {
  if (!editing) return { ...EMPTY_FORM, department }
  return {
    department: editing.department || department,
    application_name: editing.application_name || '',
    application_owner: editing.application_owner || '',
    cr_number: editing.cr_number || '',
    epic_number: editing.epic_number || '',
    change_type: editing.change_type || 'New',
    vendor_si_partner: editing.vendor_si_partner || '',
    technology_stack: editing.technology_stack || '',
    release_version: editing.release_version || '',
    build_number: editing.build_number || '',
    environment: editing.environment || 'SIT',
    target_promotion_environment: editing.target_promotion_environment || 'UAT',
    request_types: editing.request_types ? editing.request_types.split(',') : [],
    request_type_other: editing.request_type_other || '',
    // Prefer the linked child request's own live value (the source of truth
    // once it's been raised) -- fall back to whatever was staged on this
    // still-Draft gateway's draft_classification (see
    // models.QARequest.draft_classification), then finally 'Medium'.
    functional_priority: editing.linked_functional_requests?.[0]?.priority || editing.draft_classification?.functional_priority || 'Medium',
    functional_risk_rating: editing.linked_functional_requests?.[0]?.risk_rating || editing.draft_classification?.functional_risk_rating || 'Medium',
    sast_priority: editing.linked_sast_requests?.[0]?.priority || editing.draft_classification?.sast_priority || 'Medium',
    sast_risk_category: editing.linked_sast_requests?.[0]?.risk_category || editing.draft_classification?.sast_risk_category || 'Medium',
    // No live-value fallback here (unlike sast_priority/sast_risk_category
    // above) -- LinkedRequestRef is a deliberately minimal cross-reference
    // schema shared across all 5 linked-request types and doesn't carry
    // hash_value, and this field is only ever rendered while the SAST step
    // is still editable (existingSast === false) anyway, so the staged Draft
    // value is the only one that matters here.
    sast_hash_value: editing.draft_classification?.sast_hash_value || '',
    dast_priority: editing.linked_dast_requests?.[0]?.priority || editing.draft_classification?.dast_priority || 'Medium',
    dast_risk_category: editing.linked_dast_requests?.[0]?.risk_category || editing.draft_classification?.dast_risk_category || 'Medium',
    // Reported directly: these two previously read from draft_classification
    // like every field above -- but the backend only ever sweeps functional_/
    // sast_/dast_-prefixed fields into draft_classification (see
    // routers/qa_requests.py::create_request/edit_request); performance_*
    // fields are swept into draft_performance instead (its own dict, purely
    // because its sweep runs first and pops them out before
    // classification_details' sweep ever sees them). Reading the wrong dict
    // here meant reopening a still-Draft request with Performance Testing
    // selected silently lost its previously-picked Priority/Risk Category.
    performance_priority: editing.linked_performance_requests?.[0]?.priority || editing.draft_performance?.performance_priority || 'Medium',
    performance_risk_category: editing.linked_performance_requests?.[0]?.risk_category || editing.draft_performance?.performance_risk_category || 'Medium',
    // No live-value fallback here -- LinkedRequestRef is deliberately minimal
    // (see sast_hash_value's comment above) and doesn't carry environment;
    // only matters while the Performance step is still editable anyway
    // (existingPerformance === false), so the staged Draft value is the only
    // one that matters here.
    performance_environment: editing.draft_performance?.performance_environment || 'UAT',
    target_release_date: editing.target_release_date || '',
    remarks: editing.remarks || '',
    // Pre-fill from the requester's previously-saved self-declaration ticks,
    // staged on this still-Draft gateway (see models.QARequest.draft_child_
    // details). Always empty once this request has actually been raised (a
    // linked request then exists, and further edits happen on its own Edit
    // Details instead).
    checked_items: editing.draft_checked_items || [],
    // SAST/DAST detail fields aren't stored as columns on the gateway --
    // they were staged on draft_child_details when this Draft was last saved
    // (see models.QARequest.draft_sast_components/draft_dast_components).
    // Once a SAST/DAST request already exists, these are moot anyway, since
    // further edits happen on that request's own page -- but while still
    // Draft, re-opening Edit Request must show what was actually typed in,
    // not blank rows.
    sast_components: editing.draft_sast_components?.length
      ? editing.draft_sast_components.map((c) => ({
          repository_url: c.repository_url || '', git_branch: c.git_branch || '', commit_id: c.commit_id || '',
          technology_stack: c.technology_stack || '', build_number: c.build_number || '',
        }))
      : [blankSastComponent()],
    sast_checked_items: editing.draft_sast_checked_items || [],
    dast_components: editing.draft_dast_components?.length
      ? editing.draft_dast_components.map((c) => ({
          application_url: c.application_url || '', environment: c.environment || '',
          authentication_required: (c.authentication_required || '').trim().toLowerCase() === 'yes',
          test_credentials: c.test_credentials || '',
        }))
      : [blankDastComponent()],
    dast_checked_items: editing.draft_dast_checked_items || [],
    performance_request_types: (editing.draft_performance?.performance_request_type || '').split(',').filter(Boolean),
    performance_checked_items: editing.draft_performance_checked_items || [],
  }
}

export function NewRequestModal({ onClose, onCreated, editing }: NewRequestModalProps) {
  const { user } = useAuth()
  // Department is always the requester's own profile department -- it is
  // set/enforced server-side regardless of what's submitted here, so this
  // field is pre-filled and locked (not user-editable per request).
  const [form, setForm] = useState<QARequestForm>(() => buildInitialForm(editing, user?.department || ''))
  // Once the linked SAST/DAST/Performance request already exists
  // (created on an earlier save), further edits to its details happen on
  // that request's own page -- the wizard step below only collects them up
  // front, before they're first raised.
  const existingSast = !!editing?.linked_sast_requests?.length
  const existingDast = !!editing?.linked_dast_requests?.length
  const existingPerformance = !!editing?.linked_performance_requests?.length
  const [files, setFiles] = useState<File[]>([])
  const [checklistEvidence, setChecklistEvidence] = useState<Record<string, File[]>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  // This form can hold several steps' worth of typed-but-not-yet-saved
  // details -- preventBackdropClose already stops an accidental backdrop
  // click from silently throwing all of that away, but the header's own
  // "Close" button (rendered by Modal itself, wired straight to whatever
  // onClose it's given) and this wizard's own footer "Cancel" button both
  // still called onClose directly, with no such guard -- reported directly
  // as still losing the form with no confirmation. Both now route through
  // requestClose() below instead.
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const steps = buildSteps(form.request_types)
  useEffect(() => {
    // Clamp both ends -- e.g. if a request type gets unticked and the wizard
    // was sitting on a step that no longer exists, or (belt-and-braces) if
    // stepIndex ever ends up negative.
    if (stepIndex > steps.length - 1) setStepIndex(steps.length - 1)
    else if (stepIndex < 0) setStepIndex(0)
  }, [steps.length, stepIndex])
  const step = steps[stepIndex]
  if (!step) return null

  function set<K extends keyof QARequestForm>(k: K, v: QARequestForm[K]) { setForm((f) => ({ ...f, [k]: v })) }
  function evidenceFiles(kind: EvidenceKind, itemIndex: number): File[] {
    return checklistEvidence[evidenceKey(kind, itemIndex)] || []
  }
  function setEvidenceFiles(kind: EvidenceKind, itemIndex: number, nextFiles: File[]) {
    setChecklistEvidence((current) => ({ ...current, [evidenceKey(kind, itemIndex)]: nextFiles }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // Final safety net -- catches a mandatory field left blank on a step the
    // wizard has since navigated away from (and so isn't in the DOM for the
    // browser's own `required` check to see at this point).
    // goToStep guards against findIndex ever returning -1 (step not present
    // in the current wizard) -- setStepIndex(-1) would make `steps[stepIndex]`
    // undefined on the next render and crash the whole modal (blank screen,
    // before the API is ever called). Belt-and-braces on top of
    // sastStepError/dastStepError already bailing out when that request
    // type isn't selected in the first place.
    function goToStep(key: string) {
      const idx = steps.findIndex((s) => s.key === key)
      if (idx >= 0) setStepIndex(idx)
    }
    const detailsErr = detailsStepError(form)
    if (detailsErr) {
      setError(new Error(detailsErr))
      goToStep('details')
      return
    }
    const typeErr = typeStepError(form)
    if (typeErr) {
      setError(new Error(typeErr))
      goToStep('type')
      return
    }
    const sastErr = sastStepError(form, existingSast)
    if (sastErr) {
      setError(new Error(sastErr))
      goToStep('sast')
      return
    }
    const dastErr = dastStepError(form, existingDast)
    if (dastErr) {
      setError(new Error(dastErr))
      goToStep('dast')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { performance_request_types, sast_components, dast_components, ...rest } = form
      const payload = {
        ...rest,
        target_release_date: form.target_release_date || null,
        performance_request_type: performance_request_types.join(','),
        // Sent as real arrays now -- one entry per repository/target row --
        // rather than joined into a single comma/newline-separated string
        // per field. The backend stores each as its own DB row (see
        // models.SASTComponent/DASTTarget) instead of packing several
        // values into one column.
        sast_components: sast_components.map((c) => ({
          repository_url: c.repository_url.trim(),
          git_branch: c.git_branch.trim(),
          commit_id: c.commit_id.trim(),
          technology_stack: c.technology_stack.trim(),
          build_number: c.build_number.trim(),
        })),
        dast_components: dast_components.map((c) => ({
          application_url: c.application_url.trim(),
          environment: c.environment.trim(),
          authentication_required: c.authentication_required ? 'Yes' : 'No',
          test_credentials: c.test_credentials.trim(),
        })),
      }
      const saved = editing
        ? await api.put<QARequestOut>(`/api/qa-requests/${editing.id}`, payload)
        : await api.post<QARequestOut>('/api/qa-requests', payload)
      if (files.length > 0) {
        // Uploaded after creation so files can be stored under the request's
        // own request_id folder (backend/app/uploads/<request_id>/...).
        await api.uploadFiles(`/api/qa-requests/${saved.id}/documents`, files)
      }
      await Promise.all(Object.entries(checklistEvidence).map(async ([key, evidence]) => {
        if (evidence.length === 0) return
        const [kind, itemIndex] = key.split(':')
        await api.uploadFiles(
          `/api/qa-requests/${saved.id}/checklist-evidence/${kind}/${itemIndex}/documents`,
          evidence,
        )
      }))
      onCreated(saved)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const isLastStep = stepIndex === steps.length - 1
  const isFirstStep = stepIndex === 0

  // Header "Close" and footer "Cancel" both call this instead of onClose
  // directly now -- see the confirmDiscard state comment above.
  function requestClose() {
    setConfirmDiscard(true)
  }

  function goNext() {
    // Every *StepError() below returns a plain string, and validation.ts's
    // messages are fixed literals -- so hitting the same unmet requirement
    // twice in a row (e.g. clicking Next again without having actually fixed
    // it) produces a string that's === to the error already sitting in
    // state. React's setState bails out of re-rendering entirely when the
    // new value is === the current one, which meant ErrorText's popup (whose
    // own "Close" button only clears its *local* visible state, not this
    // component's `error`) never got a fresh `error` prop to react to --
    // Next looked completely dead: no popup, no navigation, no feedback at
    // all. Wrapping each message in `new Error(...)` gives every call a
    // distinct object reference, so the state update (and re-render) always
    // goes through, even when the underlying text is identical.
    if (step.key === 'details') {
      const err = detailsStepError(form)
      if (err) { setError(new Error(err)); return }
    }
    if (step.key === 'type') {
      const err = typeStepError(form)
      if (err) { setError(new Error(err)); return }
    }
    if (step.key === 'sast') {
      const err = sastStepError(form, existingSast)
      if (err) { setError(new Error(err)); return }
    }
    if (step.key === 'dast') {
      const err = dastStepError(form, existingDast)
      if (err) { setError(new Error(err)); return }
    }
    setError(null)
    setStepIndex((i) => i + 1)
  }

  return (
    <Modal
      title={editing ? `Edit Draft — ${editing.application_name}` : 'Raise QA Request'}
      onClose={requestClose}
      wide
      variant="dialog"
      // This form can hold several steps' worth of typed-but-not-yet-saved
      // details -- an accidental click on the dimmed backdrop must never be
      // able to silently throw all of that away. Only the header's "Close"
      // button or the footer's "Cancel"/"Save" buttons below can close it.
      preventBackdropClose
    >
      {/* Scoping wrapper -- every rule below keyed off `.qa-wizard` in index.css
          is intentionally scoped to just this wizard. `.form-section`,
          `.form-field`, `.chip-toggle`, `.checklist-row` and `.wizard-steps`/
          `.wizard-step-btn` are shared classes reused by many other pages'
          forms, so redesigning them globally would have changed every other
          page too. This wrapper lets the QA Request form get bigger fonts and
          a card-style layout without touching anyone else. */}
      <div className="qa-wizard">
        {/* Only show the gateway lifecycle preview once there's real progress to
            show (i.e. editing something already submitted) -- for a brand-new
            Draft it always sits at step 1 regardless of how far along the form
            wizard below is, so showing both together for a new request was
            confusing (two "stepper" bars stacked on top of each other). */}
        {editing && <GatewayPreview activeIndex={gatewayStageIndex(editing.status)} />}

        {/* Wizard step indicator -- split into pages rather than one long
            scrolling form; a dedicated page is added per selected request type
            (SAST/DAST/Performance) that needs its own extra details. Steps can
            be clicked directly, not just walked linearly. Its own component
            (not `.tabs`) so long labels wrapping to a second line never breaks
            the underline alignment. A slim progress bar above the pills gives
            an at-a-glance sense of overall completion. */}
        <p className="muted small qa-wizard-stepcount">
          Step {stepIndex + 1} of {steps.length}
        </p>
        <div className="qa-wizard-progress">
          <div className="qa-wizard-progress-fill" style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} />
        </div>
        <div className="wizard-steps">
          {steps.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className={`wizard-step-btn ${i === stepIndex ? 'active' : i < stepIndex ? 'done' : ''}`}
              onClick={() => setStepIndex(i)}
            >
              <span className="step-num">{i < stepIndex ? <IconCheckCircle width={11} height={11} strokeWidth={3} /> : i + 1}</span>
              {s.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit}>
          {step.key === 'details' && <DetailsStep form={form} set={set} />}
          {step.key === 'functional' && <FunctionalStep form={form} set={set} draftRequestId={editing?.id} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles} />}
          {step.key === 'type' && <TypeStep form={form} set={set} />}
          {step.key === 'sast' && <SastStep form={form} set={set} existingSast={existingSast} draftRequestId={editing?.id} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles} />}
          {step.key === 'dast' && <DastStep form={form} set={set} existingDast={existingDast} draftRequestId={editing?.id} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles} />}
          {step.key === 'performance' && <PerformanceStep form={form} set={set} existingPerformance={existingPerformance} draftRequestId={editing?.id} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles} />}
          {step.key === 'documents' && (
            <DocumentsStep form={form} set={set} editing={editing} files={files} setFiles={setFiles} />
          )}

          {/* Sticky footer -- stays visible at the bottom of the modal while
              scrolling a long step's content (e.g. DAST's target list plus
              its checklist), so Back/Next/Save/Cancel and any validation
              error are never scrolled out of view. */}
          <div className="qa-wizard-footer">
            <ErrorText error={error} />
            <div style={{ display: 'flex', gap: 10 }}>
              {!isFirstStep && (
                <button type="button" className="btn" onClick={() => setStepIndex((i) => i - 1)}>&larr; Back</button>
              )}
              {!isLastStep && (
                <button type="button" className="btn btn-primary" onClick={goNext}>Next &rarr;</button>
              )}
              {isLastStep && (
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? 'Saving...' : (editing ? 'Save Changes' : 'Save Draft')}
                </button>
              )}
              <button type="button" className="btn" onClick={requestClose}>Cancel</button>
            </div>
          </div>
        </form>
      </div>
      {confirmDiscard && (
        <ConfirmModal
          title={editing ? 'Discard these changes?' : 'Discard this QA Request?'}
          message={
            <div style={{ fontSize: 13.5 }}>
              {editing
                ? 'Any changes made in this form will be lost.'
                : 'Any details you’ve entered on this form -- across every step -- will be lost.'}
            </div>
          }
          confirmLabel="Discard"
          cancelLabel="Keep Editing"
          destructive
          onConfirm={() => { setConfirmDiscard(false); onClose() }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </Modal>
  )
}
