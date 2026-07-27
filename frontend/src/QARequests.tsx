import React, { useEffect, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '@qa-portal/shared/api'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, RepeatableGroupInput, RepeatableGroupField, RepeatableGroupRow, RepeatableRows, DetailSection, DetailField } from '@qa-portal/shared/components/Common'
import {
  REQUEST_TYPES, PRIORITIES, RISK_RATINGS, ENVIRONMENTS,
  DEFAULT_CHECKLIST_ITEMS, CONDITIONAL_CHECKLIST_ITEMS, FUNCTIONAL_BUCKET_TYPES,
  GATEWAY_STATUSES, GATEWAY_STATUS_LABELS, GATEWAY_EDITABLE_STATUSES, GATEWAY_CANCELLABLE_STATUSES,
  QA_STATUS_LABELS, SAST_DAST_STATUS_LABELS, AUTOMATION_STATUS_LABELS, PERFORMANCE_STATUS_LABELS,
  PERFORMANCE_REQUEST_TYPES, CHANGE_TYPES, DEFAULT_PERFORMANCE_CHECKLIST_ITEMS,
  DEFAULT_AUTOMATION_CHECKLIST_ITEMS, hasRole,
} from '@qa-portal/shared/constants'
import { IconCheckCircle } from '@qa-portal/shared/components/Icons'
import { QARequestOut, UserOut, ChecklistItemOut, QARequestDocumentOut, ApprovalActionOut } from '@qa-portal/shared/types'

// One "SAST component" = one repository, with its own branch/commit/tech
// stack/build number -- the "+" on the SAST step adds a whole new one of
// these (not just another URL), since a project can have several repos each
// needing their own full set of details.
const SAST_COMPONENT_FIELDS: RepeatableGroupField[] = [
  { key: 'repository_url', label: 'Repository URL' },
  { key: 'git_branch', label: 'Branch' },
  { key: 'commit_id', label: 'Commit ID' },
  { key: 'technology_stack', label: 'Tech Stack' },
  { key: 'build_number', label: 'Build Number' },
]
function blankSastComponent(): RepeatableGroupRow {
  return { repository_url: '', git_branch: '', commit_id: '', technology_stack: '', build_number: '' }
}

// One "DAST target" = one URL to scan, with its own environment/auth
// requirement/credentials -- the "+" adds a whole new target, since a
// project can have more than one URL to test. Test Credentials only shows
// (and only matters) once that target's own Authentication Required is
// ticked. No target_release field -- Target Release Date is already
// collected once, on the QA Request itself (see the "details" step above).
interface DastComponent {
  application_url: string
  environment: string
  authentication_required: boolean
  test_credentials: string
}
function blankDastComponent(): DastComponent {
  return { application_url: '', environment: '', authentication_required: false, test_credentials: '' }
}

const EMPTY_FORM = {
  department: '', application_name: '', application_owner: '', cr_number: '',
  project_name: '', change_type: 'New', vendor_si_partner: '', technology_stack: '',
  release_version: '', build_number: '', environment: 'SIT', target_promotion_environment: 'UAT',
  request_types: [] as string[],
  request_type_other: '',
  target_release_date: '', remarks: '', checked_items: [] as string[],
  // Classification (Priority + Risk Rating/Category) is now collected
  // independently per request type -- see the new 'functional' step and the
  // top of each of the sast/dast/automation/performance steps below --
  // instead of once, shared, here on "Application & Change Details" (e.g.
  // Automation Testing might be Low priority while Performance Testing on
  // the same QA Request is High). Field names below match the backend
  // schemas.QARequestCreate classification fields exactly.
  functional_priority: 'Medium', functional_risk_rating: 'Medium',
  sast_priority: 'Medium', sast_risk_category: 'Medium',
  dast_priority: 'Medium', dast_risk_category: 'Medium',
  automation_priority: 'Medium', automation_risk_category: 'Medium',
  performance_priority: 'Medium', performance_risk_category: 'Medium',
  // Shown only while "SAST" is ticked -- seeds the auto-created SAST request
  // at raise time instead of leaving it for later on the SAST module page.
  // Each entry is one full SAST component (repo + branch + commit + tech
  // stack + build number) -- the "+" adds another whole component, since a
  // project can have more than one repository to scan.
  sast_components: [blankSastComponent()] as RepeatableGroupRow[],
  // Shown only while "DAST" is ticked -- same idea, for the auto-created DAST
  // request. Each entry is one full DAST target (URL + environment + auth +
  // credentials) -- the "+" adds another whole target.
  dast_components: [blankDastComponent()] as DastComponent[],
  // Shown only while "Performance Testing" is ticked -- just the Annexure
  // VIII request type (Load/Stress/Spike Testing), which has no gateway
  // equivalent. change_type/vendor_si_partner/technology_stack/
  // release_version/build_number/target_promotion_environment are NOT
  // collected again here -- they're already collected once above, on
  // "Application & Change Details", and are delegated straight from there
  // when the Performance request is created (see backend
  // routers/qa_requests.py::_sync_linked_child_requests). Hash Value has no
  // gateway equivalent and is simply filled in later on the Performance
  // request's own page, once raised.
  performance_request_types: [] as string[],
  // Requester's own self-declaration against the 19-item "L1: Pre-Testing
  // Readiness Checklist" (DEFAULT_PERFORMANCE_CHECKLIST_ITEMS) -- seeds the
  // auto-created Performance request's checklist at raise time (same
  // pattern as checked_items/automation_checked_items above).
  performance_checked_items: [] as string[],
  // Shown only while "Automation Testing" is ticked -- requester's own
  // self-declaration against DEFAULT_AUTOMATION_CHECKLIST_ITEMS, seeds the
  // auto-created Automation request's own readiness checklist at raise time
  // (same pattern as checked_items above, for Functional's checklist).
  automation_checked_items: [] as string[],
}
type QARequestForm = typeof EMPTY_FORM

// Mandatory text fields on the "Application & Change Details" / "Release &
// Environment" steps (everything marked "(*)" in the QA Request field spec).
// The select-type mandatory fields (Change Type, Deployment Environment,
// Target Promotion Environment, Priority, Risk Rating) never need a separate
// check here -- their dropdowns always default to a real (non-blank) value,
// so they can't be left empty through the UI.
const REQUIRED_DETAIL_FIELDS: { key: keyof QARequestForm; label: string }[] = [
  { key: 'application_name', label: 'Application Name' },
  { key: 'application_owner', label: 'Application Owner' },
  { key: 'cr_number', label: 'Change Request ID(s)' },
  { key: 'project_name', label: 'Project Name' },
  { key: 'technology_stack', label: 'Technology Stack' },
  { key: 'release_version', label: 'Release Version / Hash Value' },
  { key: 'build_number', label: 'Build Number / Hash Value' },
]

// Because each wizard step's fields are unmounted once you move to another
// step, the browser's native `required` attribute can't catch a missing
// field from an earlier step at final-submit time -- these two checks run
// explicitly instead (both before advancing past the relevant step, and
// again as a final safety check right before submit).
function detailsStepError(f: QARequestForm): string | null {
  const missing = REQUIRED_DETAIL_FIELDS.filter(({ key }) => !String(f[key] || '').trim())
  return missing.length > 0 ? `Please fill in: ${missing.map((m) => m.label).join(', ')}` : null
}
function typeStepError(f: QARequestForm): string | null {
  return f.request_types.length === 0 ? 'Select at least one Request Type.' : null
}

// Every field of every SAST component is mandatory -- each row added via the
// "+" (RepeatableGroupInput) is a full repository/branch/commit/tech
// stack/build number set, and every one of those rows must be complete.
// Skipped once the linked SAST request already exists (existingSast), or
// once SAST isn't even a selected request type -- in the latter case there's
// no "sast" step in the wizard at all (see buildSteps), so this must bail
// out *before* checking the (still-blank, irrelevant) sast_components rows.
// Without this check, calling this from submit()'s safety net on a
// DAST-only request would wrongly flag the untouched blank SAST row as
// incomplete, then try to jump to a "sast" step that doesn't exist --
// steps.findIndex returns -1, stepIndex becomes -1, and the next render
// crashes on `steps[-1].key` (blank screen, no API call ever fires).
function sastStepError(f: QARequestForm, existingSast: boolean): string | null {
  if (existingSast || !f.request_types.includes('SAST')) return null
  const incomplete = f.sast_components.some((c) => SAST_COMPONENT_FIELDS.some((field) => !c[field.key]?.trim()))
  return incomplete
    ? 'Please fill in every field (Repository URL, Branch, Commit ID, Tech Stack, Build Number) for each repository row.'
    : null
}

// Test Credentials is only mandatory on a target that has its own
// Authentication Required ticked -- otherwise there's nothing to fill in
// (the field isn't even shown). Skipped once the linked DAST request
// already exists (existingDast), or once DAST isn't a selected request
// type -- same "sast" step crash reasoning as above, mirrored for "dast".
function dastStepError(f: QARequestForm, existingDast: boolean): string | null {
  if (existingDast || !f.request_types.includes('DAST')) return null
  const missingCreds = f.dast_components.some((c) => c.authentication_required && !c.test_credentials.trim())
  return missingCreds
    ? 'Test Credentials is required for any target with Authentication Required ticked.'
    : null
}

// The QA Request form is split into a wizard (rather than one long scrolling
// page) -- a fixed first/last pair of steps, plus a dedicated page per
// request type that needs its own extra details (SAST/DAST/Performance).
interface WizardStep { key: string; label: string }

function buildSteps(requestTypes: string[]): WizardStep[] {
  const steps: WizardStep[] = [
    { key: 'details', label: 'Application & Change Details' },
    { key: 'type', label: 'Request Type' },
  ]
  // Functional/Sanity/Regression/UAT Support share one combined Functional
  // Testing Request -- this step is where it gets its own independent
  // Priority + Risk Rating (see models.FunctionalRequest), same idea as the
  // Priority/Risk Category fields added to the top of the sast/dast/
  // automation/performance steps below.
  if (requestTypes.some((t) => FUNCTIONAL_BUCKET_TYPES.includes(t))) steps.push({ key: 'functional', label: 'Functional QA Classification' })
  if (requestTypes.includes('SAST')) steps.push({ key: 'sast', label: 'SAST Details' })
  if (requestTypes.includes('DAST')) steps.push({ key: 'dast', label: 'DAST Details' })
  if (requestTypes.includes('Performance Testing')) steps.push({ key: 'performance', label: 'Performance Testing' })
  if (requestTypes.includes('Automation Testing')) steps.push({ key: 'automation', label: 'Automation Readiness Checklist' })
  // This checklist is Functional Testing's own "Ready for Testing" readiness
  // checklist (with a couple of items conditionally relevant to SAST/DAST --
  // see CONDITIONAL_CHECKLIST_ITEMS/isItemRelevant below) -- so, like the
  // SAST/DAST/Performance/Automation steps above, it should only appear when
  // one of those request types is actually selected, not unconditionally.
  if (requestTypes.some((t) => FUNCTIONAL_BUCKET_TYPES.includes(t)) || requestTypes.includes('SAST') || requestTypes.includes('DAST')) {
    steps.push({ key: 'checklist', label: 'Readiness Checklist' })
  }
  steps.push({ key: 'documents', label: 'Documents & Review' })
  return steps
}

// Item is relevant to show in the requester's tick-list unless it's gated
// behind a request type (SAST/DAST readiness) that hasn't been selected.
function isItemRelevant(item: string, requestTypes: string[]): boolean {
  const requiredType = CONDITIONAL_CHECKLIST_ITEMS[item]
  return !requiredType || requestTypes.includes(requiredType)
}

// The QA Request is a pure intake/gateway record -- it has no approval
// workflow of its own (see constants.GATEWAY_STATUSES): Draft -> Submitted
// -> Raised (immediately, once its linked child request(s) exist), or
// Cancelled while still Draft.
const GATEWAY_STAGES = ['Draft', 'Submitted', 'Raised']

function GatewayPreview({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="stepper" style={{ margin: '4px 0 18px' }}>
      {GATEWAY_STAGES.map((label, i) => (
        <React.Fragment key={label}>
          <div className={`step ${i <= activeIndex ? 'filled' : ''}`}>
            <div className="circle">{i + 1}</div>
            <div className="step-label">{label}</div>
          </div>
          {i < GATEWAY_STAGES.length - 1 && <div className={`connector ${i < activeIndex ? 'filled' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  )
}

function gatewayStageIndex(status?: string): number {
  if (!status || status === 'DRAFT') return 0
  if (status === 'SUBMITTED') return 1
  if (status === 'RAISED') return 2
  return 0 // CANCELLED -- shown via the badge instead of the stepper
}

interface NewRequestModalProps {
  onClose: () => void
  onCreated: (req: QARequestOut) => void
  editing?: QARequestOut
  checklist?: ChecklistItemOut[]
}

function NewRequestModal({ onClose, onCreated, editing, checklist }: NewRequestModalProps) {
  const { user } = useAuth()
  // Department is always the requester's own profile department -- it is
  // set/enforced server-side regardless of what's submitted here, so this
  // field is pre-filled and locked (not user-editable per request).
  const [form, setForm] = useState<QARequestForm>(editing ? {
    department: editing.department || user?.department || '',
    application_name: editing.application_name || '',
    application_owner: editing.application_owner || '',
    cr_number: editing.cr_number || '',
    project_name: editing.project_name || '',
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
    dast_priority: editing.linked_dast_requests?.[0]?.priority || editing.draft_classification?.dast_priority || 'Medium',
    dast_risk_category: editing.linked_dast_requests?.[0]?.risk_category || editing.draft_classification?.dast_risk_category || 'Medium',
    automation_priority: editing.linked_automation_requests?.[0]?.priority || editing.draft_classification?.automation_priority || 'Medium',
    automation_risk_category: editing.linked_automation_requests?.[0]?.risk_category || editing.draft_classification?.automation_risk_category || 'Medium',
    performance_priority: editing.linked_performance_requests?.[0]?.priority || editing.draft_classification?.performance_priority || 'Medium',
    performance_risk_category: editing.linked_performance_requests?.[0]?.risk_category || editing.draft_classification?.performance_risk_category || 'Medium',
    target_release_date: editing.target_release_date || '',
    remarks: editing.remarks || '',
    // Pre-fill from the requester's previously-saved self-declaration ticks --
    // prefer draft_checked_items (staged on this still-Draft gateway, see
    // models.QARequest.draft_child_details) since that's the only place they
    // exist before a linked Functional request has ever been created; once
    // one exists, fall back to its checklist's own requester_checked ticks.
    checked_items: editing.draft_checked_items?.length
      ? editing.draft_checked_items
      : (checklist || []).filter((c) => c.requester_checked).map((c) => c.item),
    // SAST/DAST detail fields aren't stored as columns on the gateway -- they
    // were staged on draft_child_details when this Draft was last saved (see
    // models.QARequest.draft_sast_components/draft_dast_components). Once a
    // SAST/DAST request already exists (see existingSast/existingDast below)
    // these are moot anyway, since further edits happen on that request's own
    // page -- but while still Draft, re-opening Edit Request must show what
    // was actually typed in, not blank rows.
    sast_components: editing.draft_sast_components?.length
      ? editing.draft_sast_components.map((c) => ({
          repository_url: c.repository_url || '', git_branch: c.git_branch || '', commit_id: c.commit_id || '',
          technology_stack: c.technology_stack || '', build_number: c.build_number || '',
        }))
      : [blankSastComponent()],
    dast_components: editing.draft_dast_components?.length
      ? editing.draft_dast_components.map((c) => ({
          application_url: c.application_url || '', environment: c.environment || '',
          authentication_required: (c.authentication_required || '').trim().toLowerCase() === 'yes',
          test_credentials: c.test_credentials || '',
        }))
      : [blankDastComponent()],
    performance_request_types: (editing.draft_performance?.performance_request_type || '').split(',').filter(Boolean),
    automation_checked_items: editing.draft_automation_checked_items || [],
    performance_checked_items: editing.draft_performance_checked_items || [],
  } : { ...EMPTY_FORM, department: user?.department || '' })
  // Once the linked SAST/DAST/Performance request already exists (created on
  // an earlier save), further edits to its details happen on that request's
  // own page -- the form below only collects them up front, before they're
  // first raised.
  const existingSast = !!editing?.linked_sast_requests?.length
  const existingDast = !!editing?.linked_dast_requests?.length
  const existingPerformance = !!editing?.linked_performance_requests?.length
  const existingAutomation = !!editing?.linked_automation_requests?.length
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)

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
  function toggleType(t: string) {
    setForm((f) => ({
      ...f,
      request_types: f.request_types.includes(t) ? f.request_types.filter((x) => x !== t) : [...f.request_types, t],
    }))
  }
  function toggleChecked(item: string) {
    setForm((f) => ({
      ...f,
      checked_items: f.checked_items.includes(item) ? f.checked_items.filter((x) => x !== item) : [...f.checked_items, item],
    }))
  }
  function toggleAutomationChecked(item: string) {
    setForm((f) => ({
      ...f,
      automation_checked_items: f.automation_checked_items.includes(item)
        ? f.automation_checked_items.filter((x) => x !== item) : [...f.automation_checked_items, item],
    }))
  }
  function togglePerformanceType(t: string) {
    setForm((f) => ({
      ...f,
      performance_request_types: f.performance_request_types.includes(t)
        ? f.performance_request_types.filter((x) => x !== t) : [...f.performance_request_types, t],
    }))
  }
  function togglePerformanceChecked(item: string) {
    setForm((f) => ({
      ...f,
      performance_checked_items: f.performance_checked_items.includes(item)
        ? f.performance_checked_items.filter((x) => x !== item) : [...f.performance_checked_items, item],
    }))
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
      setError(detailsErr)
      goToStep('details')
      return
    }
    const typeErr = typeStepError(form)
    if (typeErr) {
      setError(typeErr)
      goToStep('type')
      return
    }
    const sastErr = sastStepError(form, existingSast)
    if (sastErr) {
      setError(sastErr)
      goToStep('sast')
      return
    }
    const dastErr = dastStepError(form, existingDast)
    if (dastErr) {
      setError(dastErr)
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
      onCreated(saved)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const isLastStep = stepIndex === steps.length - 1
  const isFirstStep = stepIndex === 0

  function goNext() {
    if (step.key === 'details') {
      const err = detailsStepError(form)
      if (err) { setError(err); return }
    }
    if (step.key === 'type') {
      const err = typeStepError(form)
      if (err) { setError(err); return }
    }
    if (step.key === 'sast') {
      const err = sastStepError(form, existingSast)
      if (err) { setError(err); return }
    }
    if (step.key === 'dast') {
      const err = dastStepError(form, existingDast)
      if (err) { setError(err); return }
    }
    setError(null)
    setStepIndex((i) => i + 1)
  }

  return (
    <Modal title={editing ? `Edit ${editing.request_id}` : 'Raise QA Request'} onClose={onClose} wide variant="dialog">
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
        {step.key === 'details' && (
          <>
            <div className="form-section">
              <div className="form-section-title">Application &amp; Change Details</div>
              <div className="form-row">
                <Field label="Application Name *"><input required value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
                <Field label="Application Owner *"><input required value={form.application_owner} onChange={(e) => set('application_owner', e.target.value)} /></Field>
                <Field label="Department">
                  <input value={form.department || 'Not set on your profile'} disabled />
                  <p className="muted small" style={{ margin: '4px 0 0' }}>
                    Fixed to your registered department. Contact an Administrator to change it.
                  </p>
                </Field>
                <Field label="Change Request ID(s) *"><input required value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
                <Field label="Project Name *"><input required value={form.project_name} onChange={(e) => set('project_name', e.target.value)} /></Field>
                <Field label="Change Type *">
                  <select value={form.change_type} onChange={(e) => set('change_type', e.target.value)}>
                    {CHANGE_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Vendor / SI Partner"><input value={form.vendor_si_partner} onChange={(e) => set('vendor_si_partner', e.target.value)} /></Field>
                <Field label="Technology Stack *"><input required value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-title">Release &amp; Environment</div>
              <div className="form-row">
                <Field label="Release Version / Hash Value *"><input required value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
                <Field label="Build Number / Hash Value *"><input required value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
                <Field label="Deployment Environment *">
                  <select value={form.environment} onChange={(e) => set('environment', e.target.value)}>
                    {ENVIRONMENTS.filter((e_) => e_ !== 'Dev').map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Target Promotion Environment *">
                  <select value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
                    {ENVIRONMENTS.filter((e_) => e_ !== 'Dev' && e_ !== 'SIT').map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Target Release Date"><input type="date" value={form.target_release_date} onChange={(e) => set('target_release_date', e.target.value)} /></Field>
              </div>
            </div>
          </>
        )}

        {step.key === 'functional' && (
          <div className="form-section">
            <div className="form-section-title">Functional QA Classification *</div>
            <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
              Priority and Risk Rating for the combined Functional QA
              request -- independent of whatever Priority/Risk applies to any other request type
              raised alongside it (see the SAST/DAST/Automation/Performance steps, if selected).
            </p>
            <div className="form-row">
              <Field label="Priority *">
                <select value={form.functional_priority} onChange={(e) => set('functional_priority', e.target.value)}>
                  {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
              <Field label="Risk Rating *">
                <select value={form.functional_risk_rating} onChange={(e) => set('functional_risk_rating', e.target.value)}>
                  {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
            </div>
          </div>
        )}

        {step.key === 'type' && (
          <div className="form-section">
            <div className="form-section-title">Request Type *</div>
            <div className="chip-select">
              {REQUEST_TYPES.map((t) => {
                const active = form.request_types.includes(t)
                return (
                  <label key={t} className={`chip-toggle ${active ? 'active' : ''}`}>
                    <input type="checkbox" checked={active} onChange={() => toggleType(t)} />
                    <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
                    {t}
                  </label>
                )
              })}
            </div>
            {form.request_types.includes('Others') && (
              <input
                placeholder="Please specify other request type"
                value={form.request_type_other}
                onChange={(e) => set('request_type_other', e.target.value)}
                style={{ marginTop: 10 }}
              />
            )}
            {form.request_types.length > 0 && (
              <p className="muted small" style={{ marginTop: 10 }}>
                This QA Request is just the intake form — a separate request with its own unique ID and its own
                independent Draft &rarr; SM &rarr; Department Head &rarr; ... lifecycle will be raised for each
                selected type: Functional Testing / Sanity Testing / Regression Testing / UAT Support are combined
                into one Functional Testing Request, while SAST, DAST, Automation Testing and Performance Testing
                each get their own separate request (see the extra page(s) added above for the ones that need more
                detail up front). Every one of these runs its own workflow from here — this gateway record itself
                has no approval step of its own.
              </p>
            )}
          </div>
        )}

        {step.key === 'sast' && (
          <div className="form-section">
            <div className="form-section-title">SAST Details *</div>
            {existingSast ? (
              <p className="muted small" style={{ marginTop: -4 }}>
                The linked SAST request has already been raised — edit these details on its own page
                (SAST Requests) instead of here.
              </p>
            ) : (
              <>
                <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
                  Fills in the auto-created SAST request's details up front, instead of leaving them as
                  placeholders to fill in later.
                </p>
                <div className="form-row">
                  <Field label="Priority *">
                    <select value={form.sast_priority} onChange={(e) => set('sast_priority', e.target.value)}>
                      {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Risk Category *">
                    <select value={form.sast_risk_category} onChange={(e) => set('sast_risk_category', e.target.value)}>
                      {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="Repository Details *">
                  <RepeatableGroupInput
                    required
                    fields={SAST_COMPONENT_FIELDS}
                    rows={form.sast_components}
                    onChange={(v) => set('sast_components', v)}
                  />
                </Field>
                <p className="muted small" style={{ marginTop: 6 }}>
                  Click "+" to add another repository (its own branch, commit ID, tech stack and build
                  number) if this project spans more than one.
                </p>
              </>
            )}
          </div>
        )}

        {step.key === 'dast' && (
          <div className="form-section">
            <div className="form-section-title">DAST Details</div>
            {existingDast ? (
              <p className="muted small" style={{ marginTop: -4 }}>
                The linked DAST request has already been raised — edit these details on its own page
                (DAST Requests) instead of here.
              </p>
            ) : (
              <>
                <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
                  Fills in the auto-created DAST request's details up front, instead of leaving them as
                  placeholders to fill in later.
                </p>
                <p className="muted small" style={{ marginTop: -4, marginBottom: 10 }}>
                  Target Release Date is already set on the "Application &amp; Change Details" step
                  ({form.target_release_date || 'not set'}) — no separate one here.
                </p>
                <div className="form-row">
                  <Field label="Priority">
                    <select value={form.dast_priority} onChange={(e) => set('dast_priority', e.target.value)}>
                      {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Risk Category">
                    <select value={form.dast_risk_category} onChange={(e) => set('dast_risk_category', e.target.value)}>
                      {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="DAST Targets">
                  <RepeatableRows
                    rows={form.dast_components}
                    blankRow={blankDastComponent}
                    onChange={(v) => set('dast_components', v)}
                    renderRow={(row, setField) => (
                      <>
                        <input
                          placeholder="Application URL"
                          value={row.application_url}
                          onChange={(e) => setField('application_url', e.target.value)}
                          style={{ flex: 2, minWidth: 180 }}
                        />
                        <select
                          value={row.environment}
                          onChange={(e) => setField('environment', e.target.value)}
                          style={{ flex: 1, minWidth: 130 }}
                        >
                          <option value="">Same as above</option>
                          {ENVIRONMENTS.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
                          <input
                            type="checkbox"
                            checked={row.authentication_required}
                            onChange={(e) => setField('authentication_required', e.target.checked)}
                          />
                          <span className="small">Auth required</span>
                        </label>
                        {row.authentication_required && (
                          <input
                            required
                            placeholder="Test Credentials *"
                            value={row.test_credentials}
                            onChange={(e) => setField('test_credentials', e.target.value)}
                            style={{ flex: 2, minWidth: 160 }}
                          />
                        )}
                      </>
                    )}
                  />
                </Field>
                <p className="muted small" style={{ marginTop: 6 }}>
                  Click "+" to add another target URL if this project spans more than one.
                </p>
              </>
            )}
          </div>
        )}

        {step.key === 'performance' && (
          <div className="form-section">
            <div className="form-section-title">Performance Testing Details</div>
            <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
              Per Annexure VIII — QA Request Form &amp; Checklist (Performance Testing). Change Type,
              Vendor / SI Partner, Technology Stack, Release Version, Build Number and Target
              Promotion Environment aren't collected again here — they're already captured once on
              "Application &amp; Change Details" and carry straight over to the Performance request.
            </p>
            {existingPerformance ? (
              <p className="muted small">
                The linked Performance request has already been raised — edit any of these details
                (including Hash Value) on its own page (Performance Testing Requests) instead of here.
              </p>
            ) : (
              <>
                <div className="form-row">
                  <Field label="Priority">
                    <select value={form.performance_priority} onChange={(e) => set('performance_priority', e.target.value)}>
                      {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Risk Category">
                    <select value={form.performance_risk_category} onChange={(e) => set('performance_risk_category', e.target.value)}>
                      {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="chip-select">
                  {PERFORMANCE_REQUEST_TYPES.map((t) => {
                    const active = form.performance_request_types.includes(t)
                    return (
                      <label key={t} className={`chip-toggle ${active ? 'active' : ''}`}>
                        <input type="checkbox" checked={active} onChange={() => togglePerformanceType(t)} />
                        <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
                        {t}
                      </label>
                    )
                  })}
                </div>

                <div className="section-title" style={{ marginTop: 16 }}>L1: Pre-Testing Readiness Checklist — Self-Declaration</div>
                <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
                  Tick what's already in place. This is your own declaration for reference only — QA
                  will independently verify every item during Readiness (on the linked Performance
                  Testing Request, once raised).
                </p>
                {DEFAULT_PERFORMANCE_CHECKLIST_ITEMS.map((ci) => {
                  const checked = form.performance_checked_items.includes(ci.item)
                  return (
                    <label key={ci.item} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                      <input type="checkbox" checked={checked} onChange={() => togglePerformanceChecked(ci.item)} />
                      <span>{ci.item} <span className="muted small">({ci.data_required})</span></span>
                    </label>
                  )
                })}
              </>
            )}
          </div>
        )}

        {step.key === 'automation' && (
          <div className="form-section">
            <div className="form-section-title">Automation Readiness Checklist — Self-Declaration</div>
            {existingAutomation ? (
              <p className="muted small">
                The linked Automation Testing request has already been raised — tick off this readiness
                checklist on its own page (Automation Testing Requests) instead of here.
              </p>
            ) : (
              <>
                <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
                  Tick what's already in place. This is your own declaration for reference only — QA will
                  independently verify every mandatory item before Feasibility Assessment can Pass (on the
                  linked Automation Testing Request, once raised).
                </p>
                <div className="form-row">
                  <Field label="Priority">
                    <select value={form.automation_priority} onChange={(e) => set('automation_priority', e.target.value)}>
                      {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Risk Category">
                    <select value={form.automation_risk_category} onChange={(e) => set('automation_risk_category', e.target.value)}>
                      {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                </div>
                {DEFAULT_AUTOMATION_CHECKLIST_ITEMS.map((ci) => {
                  const checked = form.automation_checked_items.includes(ci.item)
                  return (
                    <label key={ci.item} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleAutomationChecked(ci.item)} />
                      <span>
                        {ci.item} {ci.owner && <span className="muted small">({ci.owner})</span>}{' '}
                        {!ci.is_mandatory && <span className="badge badge-gray">Not mandatory</span>}
                      </span>
                    </label>
                  )
                })}
              </>
            )}
          </div>
        )}

        {step.key === 'checklist' && (
          <div className="form-section">
            <div className="form-section-title">Readiness Checklist — Self-Declaration</div>
            <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
              Tick what's already in place. This is your own declaration for reference only — the
              QA Lead will independently verify every item during Readiness Verification (on the linked
              Functional Testing Request, once raised).
            </p>
            {DEFAULT_CHECKLIST_ITEMS.filter((ci) => isItemRelevant(ci.item, form.request_types)).map((ci) => {
              const checked = form.checked_items.includes(ci.item)
              return (
                <label key={ci.item} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleChecked(ci.item)} />
                  <span>{ci.item} <span className="muted small">({ci.owner})</span></span>
                </label>
              )
            })}
          </div>
        )}

        {step.key === 'documents' && (
          <>
            <div className="form-section">
              <div className="form-section-title">Supporting Documents</div>
              <Field label="Upload (multiple files supported)">
                <input
                  type="file"
                  multiple
                  onChange={(e) => setFiles(Array.from(e.target.files || []))}
                />
                {files.length > 0 && (
                  <p className="muted small" style={{ marginTop: 4 }}>
                    {files.length} file{files.length > 1 ? 's' : ''} selected: {files.map((f) => f.name).join(', ')}
                  </p>
                )}
              </Field>
            </div>

            <div className="form-section">
              <div className="form-section-title">Remarks</div>
              <Field label="Additional notes (optional)"><textarea value={form.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
            </div>

            {!editing && (
              <p className="muted small" style={{ marginTop: -4 }}>
                Submitting will raise this request and immediately create whichever linked request(s) your
                selected types call for — you'll land back on this gateway record (with links to each) right after.
              </p>
            )}
          </>
        )}

        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
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
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
      </div>
    </Modal>
  )
}

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

// Priority/Risk is per-request-type now (see models.FunctionalRequest for
// the full reasoning), not a single shared value on the gateway itself --
// mirrors backend routers/reports.py::qa_request_summary's "Type:
// Priority/Risk" breakdown, listing one entry per type actually linked to
// this QA Request.
function classificationSummary(req: QARequestOut): string {
  const f = req.linked_functional_requests?.[0]
  const s = req.linked_sast_requests?.[0]
  const d = req.linked_dast_requests?.[0]
  const a = req.linked_automation_requests?.[0]
  const p = req.linked_performance_requests?.[0]
  const parts = [
    f && `Functional: ${f.priority || '—'} / ${f.risk_rating || '—'}`,
    s && `SAST: ${s.priority || '—'} / ${s.risk_category || '—'}`,
    d && `DAST: ${d.priority || '—'} / ${d.risk_category || '—'}`,
    a && `Automation: ${a.priority || '—'} / ${a.risk_category || '—'}`,
    p && `Performance: ${p.priority || '—'} / ${p.risk_category || '—'}`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('; ') : 'Not yet set — raise the linked request(s) first'
}

interface RequestDetailProps {
  req: QARequestOut
  onClose: () => void
  onChanged: (req: QARequestOut) => void
  users: UserOut[]
}

function RequestDetail({ req, onClose, onChanged, users }: RequestDetailProps) {
  const { user } = useAuth()
  const [tab, setTab] = useState('overview')
  const [documents, setDocuments] = useState<QARequestDocumentOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [editingReq, setEditingReq] = useState(false)

  const load = useCallback(async () => {
    try {
      const [docs, hist] = await Promise.all([
        api.get<QARequestDocumentOut[]>(`/api/qa-requests/${req.id}/documents`),
        api.get<ApprovalActionOut[]>(`/api/qa-requests/${req.id}/history`),
      ])
      setDocuments(docs); setHistory(hist)
    } catch (err) { setError(err) }
  }, [req.id])

  useEffect(() => { load() }, [load])

  async function act(action: string) {
    setError(null)
    setBusyAction(action)
    try {
      const updated = await api.post<QARequestOut>(`/api/qa-requests/${req.id}/${action}`, {})
      onChanged(updated)
      load()
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  const isAdmin = hasRole(user, 'ADMIN')
  const isRequester = (req.requester_id === user?.id) || isAdmin
  const status = req.status

  const canSubmit = isRequester && status === 'DRAFT'
  // Mirrors backend GATEWAY_CANCELLABLE_STATUSES -- the gateway can only be
  // cancelled while still Draft (i.e. before it's ever been raised).
  const canCancel = isRequester && GATEWAY_CANCELLABLE_STATUSES.includes(status)
  // Mirrors backend GATEWAY_EDITABLE_STATUSES.
  const canEditRequest = isRequester && GATEWAY_EDITABLE_STATUSES.includes(status)

  const hasLinked = (req.linked_functional_requests?.length > 0) || (req.linked_sast_requests?.length > 0)
    || (req.linked_dast_requests?.length > 0) || (req.linked_automation_requests?.length > 0)
    || (req.linked_performance_requests?.length > 0)

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'documents', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
          <GatewayPreview activeIndex={gatewayStageIndex(req.status)} />

          <DetailSection title="Status">
            <DetailField label="Status"><Badge status={req.status} /></DetailField>
            <DetailField label="Priority / Risk (per type)">{classificationSummary(req)}</DetailField>
            <DetailField label="Request Type(s)">{req.request_types || '—'}{req.request_type_other ? ` (${req.request_type_other})` : ''}</DetailField>
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Department">{req.department || '—'}</DetailField>
            <DetailField label="Change Request ID(s)">{req.cr_number || '—'}</DetailField>
            <DetailField label="Project">{req.project_name || '—'}</DetailField>
            <DetailField label="Change Type">{req.change_type || '—'}</DetailField>
            <DetailField label="Vendor / SI Partner">{req.vendor_si_partner || '—'}</DetailField>
            <DetailField label="Technology Stack">{req.technology_stack || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Environment & Release">
            <DetailField label="Deployment Environment">{req.environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
            <DetailField label="Release Version / Hash Value">{req.release_version || '—'}</DetailField>
            <DetailField label="Build Number / Hash Value">{req.build_number || '—'}</DetailField>
            <DetailField label="Target Release Date">{req.target_release_date || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
          </DetailSection>

          {hasLinked && (
            <p>
              <strong>Linked Requests:</strong>{' '}
              {(req.linked_functional_requests || []).map((f) => (
                <span key={`func-${f.id}`} className="badge badge-purple" style={{ marginRight: 6 }}>
                  Functional QA {f.request_id} — {QA_STATUS_LABELS[f.status || ''] || f.status}
                </span>
              ))}
              {req.linked_sast_requests.map((s) => (
                <span key={`sast-${s.id}`} className="badge badge-blue" style={{ marginRight: 6 }}>
                  SAST {s.request_id} — {SAST_DAST_STATUS_LABELS[s.status || ''] || s.status}
                </span>
              ))}
              {req.linked_dast_requests.map((d) => (
                <span key={`dast-${d.id}`} className="badge badge-blue" style={{ marginRight: 6 }}>
                  DAST {d.request_id} — {SAST_DAST_STATUS_LABELS[d.status || ''] || d.status}
                </span>
              ))}
              {(req.linked_automation_requests || []).map((a) => (
                <span key={`auto-${a.id}`} className="badge badge-purple" style={{ marginRight: 6 }}>
                  Automation {a.request_id} — {AUTOMATION_STATUS_LABELS[a.status || ''] || a.status}
                </span>
              ))}
              {(req.linked_performance_requests || []).map((p) => (
                <span key={`perf-${p.id}`} className="badge badge-purple" style={{ marginRight: 6 }}>
                  Performance {p.request_id} — {PERFORMANCE_STATUS_LABELS[p.status || ''] || p.status}
                </span>
              ))}
            </p>
          )}
          {status === 'DRAFT' && (
            <p className="muted small">
              Submitting will raise whichever linked request(s) your selected types call for — nothing shows here
              until then.
            </p>
          )}
          {req.remarks && <p><strong>Remarks:</strong> {req.remarks}</p>}

          <div className="actions-panel">
            <div className="section-title" style={{ marginTop: 0 }}>Gateway Actions</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/qa-requests/${req.id}/export`, `${req.request_id}.pdf`)}>
                Export PDF
              </button>
              {canEditRequest && (
                <button className="btn btn-sm" disabled={!!busyAction} onClick={() => setEditingReq(true)}>Edit Request</button>
              )}
              {canSubmit && (
                <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('submit')}>Submit / Raise</button>
              )}
              {canCancel && (
                <button className="btn btn-danger btn-sm" disabled={!!busyAction} onClick={() => act('cancel')}>Cancel Request</button>
              )}
              {!canEditRequest && !canSubmit && !canCancel && (
                <span className="muted small">
                  No gateway actions available — this request has been {(GATEWAY_STATUS_LABELS[status] || status).toLowerCase()}.
                  {hasLinked && ' Manage progress on each linked request\'s own page from here.'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <div>
          <Table
            rowKey="id"
            columns={[
              { key: 'file_name', header: 'File' },
              { key: 'file_size', header: 'Size', render: (d) => d.file_size ? `${(d.file_size / 1024).toFixed(1)} KB` : '—' },
              { key: 'uploaded_at', header: 'Uploaded', render: (d) => new Date(d.uploaded_at).toLocaleString() },
              {
                key: 'download', header: '', filterable: false, render: (d) => (
                  <button className="btn btn-sm" onClick={() =>
                    api.downloadFile(`/api/qa-requests/${req.id}/documents/${d.id}/download`, d.file_name)}>
                    Download
                  </button>
                ),
              },
            ]}
            rows={documents}
          />
          <AddDocuments reqId={req.id} onAdded={load} />
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

      {editingReq && (
        <NewRequestModal
          editing={req}
          onClose={() => setEditingReq(false)}
          onCreated={(updated) => { setEditingReq(false); onChanged(updated); load() }}
        />
      )}
    </Modal>
  )
}

function AddDocuments({ reqId, onAdded }: { reqId: number; onAdded: () => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.uploadFiles(`/api/qa-requests/${reqId}/documents`, files)
      setFiles([])
      onAdded()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} />
      <button className="btn btn-sm" disabled={busy || files.length === 0}>
        {busy ? 'Uploading...' : 'Upload'}
      </button>
      <ErrorText error={error} />
    </form>
  )
}

export default function QARequests() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const searchParams = new URLSearchParams(location.search)
  const [requests, setRequests] = useState<QARequestOut[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState(searchParams.get('search') || searchParams.get('application_name') || '')
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<QARequestOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    // Reacts to location.state on every navigation to this route -- not just
    // on first mount -- so the topbar's "+ New QA request" button (which
    // navigates here with { state: { openNew: true } }) also works when the
    // user is already sitting on the QA Requests page (no remount happens
    // in that case, so a useState initializer alone would miss it).
    const state = location.state as { openNew?: boolean } | null
    if (state?.openNew) {
      setShowNew(true)
      // Clear the nav state so refreshing/back/clicking the button again doesn't get stuck.
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location.state, location.pathname, navigate])

  useEffect(() => {
    // Same "no remount on this route" issue as the openNew effect above --
    // the topbar search box (components/Layout.tsx) navigates to
    // `/qa-requests?search=...` from anywhere in the app, including while
    // already sitting on this page. `search`'s useState initializer only
    // reads the URL once, on first mount, so a second search typed into the
    // topbar while already here updated the URL but never reached this
    // page's `search` state -- the list just kept showing the previous (or
    // no) filter. Re-syncing on every `location.search` change fixes that.
    setSearch(new URLSearchParams(location.search).get('search') || new URLSearchParams(location.search).get('application_name') || '')
  }, [location.search])

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (statusFilter) qs.set('status_filter', statusFilter)
      if (search) qs.set('search', search)
      const [reqs, us] = await Promise.all([
        api.get<QARequestOut[]>(`/api/qa-requests?${qs.toString()}`),
        api.get<UserOut[]>('/api/auth/users'),
      ])
      setRequests(reqs)
      setUsers(us)
    } catch (err) { setError(err) }
  }, [statusFilter, search])

  useEffect(() => { load() }, [load])

  const canCreate = hasRole(user, 'REQUESTER', 'BUSINESS_ANALYST')

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="QA Requests" count={requests.length}
        subtitle="The intake gateway — raise a request here, then track progress on each linked Functional/SAST/DAST/Automation/Performance request from its own page."
        actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Raise QA Request</button>}
      />
      <div className="toolbar">
        <input placeholder="Search by request ID, application, or project..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {GATEWAY_STATUSES.map((s) => (
            <option key={s} value={s}>{GATEWAY_STATUS_LABELS[s] || s}</option>
          ))}
        </select>
      </div>

      <Card>
        <Table
          rowKey="id"
          onRowClick={(r) => setSelected(r)}
          columns={[
            { key: 'request_id', header: 'Request ID' },
            { key: 'application_name', header: 'Application' },
            { key: 'project_name', header: 'Project' },
            { key: 'requester_id', header: 'Requester', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
            { key: 'priority', header: 'Priority / Risk (per type)', render: (r) => (
              <span className="truncate-cell" title={classificationSummary(r)}>{classificationSummary(r)}</span>
            ), filterValue: (r) => classificationSummary(r) },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
            { key: 'target_release_date', header: 'Target Release' },
          ]}
          rows={requests}
        />
      </Card>

      {showNew && (
        <NewRequestModal onClose={() => setShowNew(false)} onCreated={(created) => {
          // Land straight on the new request's detail view instead of
          // dropping the user back on the bare list.
          setShowNew(false)
          load()
          setSelected(created)
        }} />
      )}
      {selected && (
        <RequestDetail req={selected} users={users} onClose={() => setSelected(null)}
                        onChanged={(updated) => { setSelected(updated); load() }} />
      )}
    </div>
  )
}
