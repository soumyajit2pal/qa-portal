import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { formatDateIST } from '../../time'
import { Badge, Card, ErrorText, Field, Modal, Table } from '../../components/Common'
import JiraActivity, { AuthenticatedMarkdown } from '../../components/JiraActivity'
import JiraRichTextField from '../../components/JiraRichTextField'
import SearchableSelect from '../../components/SearchableSelect'
import UserAssignSelect from '../../components/UserAssignSelect'
import {
  ApprovalActionOut, DefectDashboardOut, DefectLinkableExecutionOut, DefectListOut, DefectOut, DepartmentOut,
  PageOut, QARequestListOut, RequestDocumentOut, UserOut, TestProjectMyAccessOut,
} from '../../types'
import { useAuth } from '../../context/AuthContext'
import { ENVIRONMENTS, DEFECT_REASSIGNABLE_STATUSES, QA_DEPARTMENT, hasRole, hasDepartment, canReassign, userDepartments } from '../../constants'
import { usePaginatedList } from '../../hooks/usePaginatedList'

const STATUSES = ['New', 'Triaged', 'Assigned', 'In Progress', 'Resolved', 'Retest', 'Reopened', 'Deferred', 'Rejected', 'Duplicate', 'Not a Defect', 'Closed']
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low']
const PRIORITIES = ['P1 – Immediate', 'P2 – High', 'P3 – Medium', 'P4 – Low']
const RESOLUTION_TYPES = ['Fixed', 'Configuration Changed', 'Data Corrected', 'Code Change', 'Environment Issue Resolved', 'Cannot Reproduce', 'Working as Designed', 'Other']
// 2026-08 -- reported directly, with a full defect lifecycle diagram: New
// now passes through an explicit "Triaged" checkpoint before any
// disposition (mirrors routers/defects.py's own TRANSITIONS -- see that
// dict's comment for the two follow-up decisions from the same report:
// no separate "Won't Fix" status, and Reopened still goes to Assigned
// first rather than straight to In Progress).
const TRANSITIONS: Record<string, string[]> = {
  New: ['Triaged'],
  Triaged: ['Assigned', 'Rejected', 'Duplicate', 'Not a Defect', 'Deferred'],
  Assigned: ['In Progress', 'Rejected', 'Duplicate', 'Not a Defect', 'Deferred'],
  'In Progress': ['Resolved', 'Rejected', 'Duplicate', 'Deferred'],
  Resolved: ['Retest'], Retest: ['Closed', 'Reopened'], Reopened: ['Assigned'],
  Deferred: ['Assigned'], Closed: ['Reopened'], Rejected: ['Reopened'], Duplicate: [], 'Not a Defect': [],
}

// 2026-08 -- was a locally-defined interface; now just an alias for the
// batch endpoint's own response shape (types.ts's DefectLinkableExecutionOut,
// mirroring backend schemas.py) so every existing `ExecutionContext` usage
// below needs no further changes.
type ExecutionContext = DefectLinkableExecutionOut

// CreateDefectModal and EditDefectModal both stage an explicit "+ Add
// evidence" file picker alongside whichever screenshots were pasted into
// their JiraRichTextField fields, then upload everything together right
// after the defect record itself is created/saved (the /attachments
// endpoint needs a real defect id, which doesn't exist until that call
// returns) -- with identical "record already exists, retry the upload or
// continue without it" recovery semantics either way. This hook is the one
// place that shared shape lives, instead of being duplicated between the
// two modals below. The per-field image arrays (descriptionImages,
// stepsImages, etc.) stay owned by each modal, one useState per
// JiraRichTextField's onImagesChange -- that's parallel structure, not
// copy-paste duplication, so it isn't folded in here.
function useStagedEvidence(opts: { uploadPath: (defectId: number) => string; verb: 'created' | 'updated'; continueHint: string }) {
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([])

  function addEvidenceFiles(list: FileList | null) {
    if (!list?.length) return
    setEvidenceFiles((current) => [...current, ...Array.from(list)])
  }
  function removeEvidenceFile(index: number) {
    setEvidenceFiles((current) => current.filter((_, i) => i !== index))
  }

  async function attach(
    defect: DefectOut, fieldImages: File[][],
    onDone: (defect: DefectOut) => void, onFailed: (err: Error) => void,
  ) {
    const files = [...fieldImages.flat(), ...evidenceFiles]
    if (!files.length) { onDone(defect); return }
    try {
      await api.uploadFormFiles(opts.uploadPath(defect.id), {}, files)
      onDone(defect)
    } catch (err) {
      onFailed(new Error(
        `${defect.defect_key} was ${opts.verb}, but evidence could not be attached` +
        `${err instanceof Error ? `: ${err.message}` : ''}. Retry, or continue without it -- ${opts.continueHint}`,
      ))
    }
  }

  return { evidenceFiles, addEvidenceFiles, removeEvidenceFile, attach }
}

function CreateDefectModal({ contexts, requests, initialExecutionId, standalone = false, onClose, onCreated }: {
  contexts: ExecutionContext[]
  requests: QARequestListOut[]
  initialExecutionId?: number
  standalone?: boolean
  onClose: () => void
  onCreated: (defect: DefectOut) => void
}) {
  const initial = standalone ? undefined : (contexts.find((row) => row.execution.id === initialExecutionId) || contexts[0])
  const [executionId, setExecutionId] = useState(initial ? String(initial.execution.id) : '')
  const selected = contexts.find((row) => String(row.execution.id) === executionId)
  // 2026-08 -- reported directly: "if defect open from 'report defect from
  // execution', currently showing all request id, ... it should be filter
  // based on request linked with that test cycle." Find the QA Request whose
  // own linked_functional_requests/linked_sast_requests/linked_dast_requests/
  // linked_performance_requests actually contains the child request the
  // selected execution's Test Cycle is linked to (TestCycle.linked_request_
  // type/linked_request_id). Simplified per follow-up feedback ("no need of
  // textbox, just auto populate the linked request id, nothing others") --
  // when found, it's auto-populated as a locked, read-only value (same
  // pattern as the read-only Application field beside it) instead of being
  // offered as a pre-selected but still-editable dropdown option.
  function findLinkedRequest(row: ExecutionContext | undefined): QARequestListOut | undefined {
    if (!row?.cycle.linked_request_type || !row.cycle.linked_request_id) return undefined
    return requests.find((request) => {
      const groups = [
        ...request.linked_functional_requests.map((child) => ['Functional', child.id] as const),
        ...request.linked_sast_requests.map((child) => ['SAST', child.id] as const),
        ...request.linked_dast_requests.map((child) => ['DAST', child.id] as const),
        ...request.linked_performance_requests.map((child) => ['Performance', child.id] as const),
      ]
      return groups.some(([type, id]) => type === row.cycle.linked_request_type && id === row.cycle.linked_request_id)
    })
  }
  const linkedRequest = findLinkedRequest(selected)
  const [requestId, setRequestId] = useState(linkedRequest ? String(linkedRequest.id) : '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [moduleFeature, setModuleFeature] = useState(initial?.execution.test_case?.module_name || '')
  const [environment, setEnvironment] = useState(ENVIRONMENTS.includes(initial?.cycle.environment || '') ? initial?.cycle.environment || '' : '')
  const [severity, setSeverity] = useState('Medium')
  const [priority, setPriority] = useState('P3 – Medium')
  const [steps, setSteps] = useState('')
  const [expected, setExpected] = useState(initial?.execution.test_case?.description || '')
  const [actual, setActual] = useState(initial?.execution.actual_result || '')
  const [build, setBuild] = useState(initial?.cycle.build || '')
  const [externalId, setExternalId] = useState('')
  const [labels, setLabels] = useState('')
  const [relatedCaseIds, setRelatedCaseIds] = useState<Set<number>>(new Set())
  // Screenshots pasted/uploaded into the three rich-text fields below are
  // never embedded inline in the markdown (see JiraRichTextField/
  // RichTextEditor.tsx -- same as Test Execution's Actual Result field);
  // they're tracked here and, alongside anything picked via the explicit
  // "+ Add evidence" picker, uploaded as defect attachments right after
  // creation succeeds (the /attachments endpoint needs a real defect id,
  // which doesn't exist until the POST below returns).
  const [descriptionImages, setDescriptionImages] = useState<File[]>([])
  const [stepsImages, setStepsImages] = useState<File[]>([])
  const [actualImages, setActualImages] = useState<File[]>([])
  const [expectedImages, setExpectedImages] = useState<File[]>([])
  const { evidenceFiles, addEvidenceFiles, removeEvidenceFile, attach } = useStagedEvidence({
    uploadPath: (id) => `/api/defects/${id}/attachments`,
    verb: 'created',
    continueHint: 'you can always add evidence from the defect detail view.',
  })
  // Set once the defect itself has been created -- if the follow-up
  // attachment upload then fails, we must NOT resubmit the create call
  // (would create a duplicate defect); instead the form switches into a
  // "retry attaching evidence / continue without it" state against this
  // already-created record.
  const [createdDefect, setCreatedDefect] = useState<DefectOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!selected) return
    setRelatedCaseIds(new Set())
    setModuleFeature(selected.execution.test_case?.module_name || '')
    setEnvironment(ENVIRONMENTS.includes(selected.cycle.environment || '') ? selected.cycle.environment || '' : '')
    setExpected(selected.execution.test_case?.description || '')
    setActual(selected.execution.actual_result || '')
    setBuild(selected.cycle.build || '')
    // Re-derive against the NEWLY selected execution's own Test Cycle --
    // previously this only ever updated requestId when a linked request was
    // found, leaving a stale selection from the prior execution in place
    // when the new one had no traceable link at all.
    const nextLinked = findLinkedRequest(selected)
    setRequestId(nextLinked ? String(nextLinked.id) : '')
  }, [executionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // The defect record itself already exists by the time this can fail --
  // surface that as a recoverable attachment failure, not a failed defect
  // creation, and let the user retry the upload or move on without it
  // rather than silently losing the evidence or resubmitting a duplicate
  // defect (see useStagedEvidence above).
  function attachStagedEvidence(defect: DefectOut) {
    return attach(defect, [descriptionImages, stepsImages, actualImages, expectedImages], onCreated, (err) => { setError(err); setBusy(false) })
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (createdDefect) { setBusy(true); setError(null); await attachStagedEvidence(createdDefect); return }
    if (!requestId || (!standalone && !selected)) { setError(new Error(standalone ? 'Select a QA Request' : 'Select a failed/blocked execution and QA Request')); return }
    if (!description.trim()) { setError(new Error('Description is required')); return }
    if (!steps.trim() || !actual.trim() || !expected.trim()) { setError(new Error('Steps to Reproduce, Actual Result, and Expected Result are required')); return }
    setBusy(true); setError(null)
    try {
      const created = await api.post<DefectOut>('/api/defects', {
        title, description, qa_request_id: Number(requestId),
        cycle_id: selected?.cycle.id || null, test_case_id: selected?.execution.test_case_id || null,
        execution_id: selected?.execution.id || null,
        test_case_ids: selected ? Array.from(relatedCaseIds) : [],
        module_feature: moduleFeature, environment, severity, priority,
        steps_to_reproduce: steps, expected_result: expected, actual_result: actual,
        build_version: build || null,
        external_defect_id: externalId || null, labels: labels || null,
      })
      setCreatedDefect(created)
      await attachStagedEvidence(created)
    } catch (err) { setError(err); setBusy(false) }
  }

  const requestOptions = requests
    .filter((request) => request.request_id)
    .map((request) => ({ value: String(request.id), label: `${request.request_id} · ${request.application_name}` }))
  const relatedCases = selected
    ? Array.from(new Map(
      contexts
        .filter((row) => row.project.id === selected.project.id && row.execution.test_case_id !== selected.execution.test_case_id)
        .map((row) => [row.execution.test_case_id, row.execution.test_case] as const),
    ).entries())
    : []

  return <Modal title={standalone ? 'Open Defect' : 'Report Defect from Execution'} onClose={onClose} wide>
    <form onSubmit={submit} className="defect-form">
      <div className="defect-trace-banner"><strong>{standalone ? 'Open now, link later' : 'Execution traceability'}</strong><span>{standalone ? 'The defect will be created against the QA Request and can later be linked to a Failed/Blocked execution from the defect or Test Cycle.' : 'Only Failed or Blocked executions are available. Request, cycle, testcase, application, reporter, and date are recorded automatically.'}</span></div>
      {!standalone && <Field label="Failed / Blocked Test Execution *"><SearchableSelect value={executionId} onChange={setExecutionId} placeholder="Select execution…" options={contexts.map((row) => ({ value: String(row.execution.id), label: `${row.cycle.cycle_key} · ${row.execution.test_case?.test_case_key || row.execution.test_case_id} · ${row.execution.status}` }))} /></Field>}
      <div className="grid grid-2">
        <Field label="QA Request ID *">
          {!standalone && linkedRequest
            ? <input readOnly value={`${linkedRequest.request_id} · ${linkedRequest.application_name}`} />
            : <SearchableSelect value={requestId} onChange={setRequestId} placeholder="Select QA Request…" options={requestOptions} />}
        </Field>
        <Field label="Application"><input readOnly value={requests.find((request) => String(request.id) === requestId)?.application_name || ''} /></Field>
      </div>
      <Field label="Defect Title *"><input required disabled={!!createdDefect} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Description *"><JiraRichTextField value={description} onChange={setDescription} onImagesChange={setDescriptionImages} disabled={!!createdDefect} ariaLabel="Description" placeholder="Describe the defect…" /></Field>
      <div className="grid grid-2">
        <Field label="Module / Feature *"><input required disabled={!!createdDefect} value={moduleFeature} onChange={(e) => setModuleFeature(e.target.value)} /></Field>
        <Field label="Environment *"><select required value={environment} onChange={(e) => setEnvironment(e.target.value)}><option value="" disabled>Select environment…</option>{ENVIRONMENTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
        <Field label="Severity *"><select value={severity} onChange={(e) => setSeverity(e.target.value)}>{SEVERITIES.map((value) => <option key={value}>{value}</option>)}</select></Field>
        <Field label="Priority *"><select value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select></Field>
      </div>
      {selected && <Field label="Other affected Test Cases (optional)">
        <div className="defect-case-picker">
          <div className="defect-case-picker-head">
            <span>Select any additional failed or blocked testcases affected by the same defect.</span>
            <strong>{relatedCaseIds.size} selected</strong>
          </div>
          {relatedCases.length > 0
            ? <div className="defect-case-picker-list" role="group" aria-label="Other affected testcases">
              {relatedCases.map(([id, testCase]) => {
                const checked = relatedCaseIds.has(id)
                return <label key={id} className={checked ? 'selected' : ''}>
                  <input type="checkbox" checked={checked} onChange={() => setRelatedCaseIds((current) => {
                    const next = new Set(current)
                    if (next.has(id)) next.delete(id); else next.add(id)
                    return next
                  })} />
                  <span className="defect-case-check" aria-hidden="true">✓</span>
                  <span className="defect-case-copy">
                    <strong>{testCase?.test_case_key || `#${id}`}</strong>
                    <small>{testCase?.test_scenario || testCase?.description || 'No testcase description available.'}</small>
                  </span>
                  <span className="defect-case-state">{checked ? 'Selected' : 'Select'}</span>
                </label>
              })}
            </div>
            : <div className="defect-case-picker-empty">
              <span aria-hidden="true">✓</span>
              <div><strong>No additional testcases</strong><small>No other failed or blocked testcases are available in this project.</small></div>
            </div>}
        </div>
      </Field>}
      <div className="grid grid-2">
        <Field label="Build / Release"><input value={build} onChange={(e) => setBuild(e.target.value)} /></Field>
        <Field label="External Defect ID"><input value={externalId} onChange={(e) => setExternalId(e.target.value)} /></Field>
      </div>
      <Field label="Labels / Tags"><input value={labels} onChange={(e) => setLabels(e.target.value)} /></Field>
      <div className="defect-form-section">
        <div className="defect-form-section-heading"><span>✓</span><div><strong>Reproduction evidence</strong><small>Record the observable sequence in execution order. Paste or upload screenshots directly into any field below.</small></div></div>
        <Field label="Steps to Reproduce *"><JiraRichTextField value={steps} onChange={setSteps} onImagesChange={setStepsImages} disabled={!!createdDefect} ariaLabel="Steps to Reproduce" placeholder="Describe the exact steps needed to reproduce the defect…" /></Field>
        <Field label="Actual Result *"><JiraRichTextField value={actual} onChange={setActual} onImagesChange={setActualImages} disabled={!!createdDefect} ariaLabel="Actual Result" placeholder="Describe what actually happened…" /></Field>
        <Field label="Expected Result *"><JiraRichTextField value={expected} onChange={setExpected} onImagesChange={setExpectedImages} disabled={!!createdDefect} ariaLabel="Expected Result" placeholder="Describe the expected behaviour…" /></Field>
      </div>
      <div className="defect-form-section defect-evidence">
        <div><h4>Evidence & Attachments <span>{descriptionImages.length + stepsImages.length + actualImages.length + expectedImages.length + evidenceFiles.length}</span></h4>
          <label className="btn btn-sm">+ Add evidence<input type="file" multiple hidden disabled={!!createdDefect} onChange={(e) => addEvidenceFiles(e.target.files)} /></label>
        </div>
        {evidenceFiles.length > 0 && <div className="defect-files">{evidenceFiles.map((file, index) => <button type="button" key={`${file.name}-${index}`} disabled={!!createdDefect} onClick={() => removeEvidenceFile(index)}>{file.name} ✕</button>)}</div>}
        <p className="muted small">Screenshots pasted into Steps/Actual/Expected above are attached automatically -- use this to add anything else (logs, recordings, additional screenshots).</p>
      </div>
      <ErrorText error={error} title={createdDefect ? `${createdDefect.defect_key} was created` : 'Defect could not be created'} />
      <div className="modal-actions">
        {createdDefect
          ? <><button className="btn btn-primary" disabled={busy}>{busy ? 'Attaching…' : 'Retry attaching evidence'}</button><button type="button" className="btn" disabled={busy} onClick={() => onCreated(createdDefect)}>Continue without evidence</button></>
          : <><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : standalone ? 'Open Defect' : 'Report Defect'}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></>}
      </div>
    </form>
  </Modal>
}

function TransitionModal({ defect, target, users, departments, requestDepartment, defects, hasEvidence, onClose, onChanged }: {
  defect: DefectOut; target: string; users: UserOut[]; departments: DepartmentOut[]; requestDepartment?: string | null; defects: DefectListOut[]
  hasEvidence: boolean
  onClose: () => void; onChanged: (defect: DefectOut) => void
}) {

  const autoDepartment = defect.project_department || requestDepartment || ''
  const [values, setValues] = useState<Record<string, any>>(
    target === 'Assigned' ? { assigned_team: autoDepartment || defect.assigned_team || '' } : {},
  )

  const [imageValues, setImageValues] = useState<Record<string, File[]>>({})
  const setImages = (key: string) => (files: File[]) => setImageValues((current) => ({ ...current, [key]: files }))

  const [savedDefect, setSavedDefect] = useState<DefectOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const set = (key: string, value: any) => setValues((current) => ({ ...current, [key]: value }))

  const departmentUsers = values.assigned_team
    ? users.filter((user) => user.is_active && hasDepartment(user, values.assigned_team))
    : []

  function validateRichFields(): string | null {
    const need = (key: string, label: string) => (!values[key] || !String(values[key]).trim()) ? `${label} is required` : null
    if (target === 'Resolved') return need('resolution_summary', 'Resolution Summary') || need('root_cause', 'Root Cause') || need('fix_details', 'Fix Details')
    if (target === 'Closed') return need('actual_result', 'Retest Actual Result') || need('retest_remarks', 'Retest Remarks') || need('closure_remarks', 'Closure Remarks')
    if (target === 'Reopened') return need('reopen_reason', 'Reopening Reason')
    if (target === 'Deferred') return need('deferral_reason', 'Deferral Reason')
    if (target === 'Rejected') return need('rejection_reason', 'Rejection Reason')
    if (target === 'Not a Defect') return need('not_a_defect_reason', 'Reason')
    return null
  }

  async function attachStagedEvidence(saved: DefectOut) {
    const files = Object.values(imageValues).flat()
    if (!files.length) { onChanged(saved); return }
    try {
      await api.uploadFormFiles(`/api/defects/${saved.id}/attachments`, {}, files)
      onChanged(saved)
    } catch (err) {
      setError(new Error(
        `${saved.defect_key} was updated to ${target}, but evidence could not be attached` +
        `${err instanceof Error ? `: ${err.message}` : ''}. Retry, or continue without it -- ` +
        'you can always add evidence from Evidence & Attachments in the defect detail view.',
      ))
      setBusy(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (savedDefect) { setBusy(true); setError(null); await attachStagedEvidence(savedDefect); return }
    const validationError = validateRichFields()
    if (validationError) { setError(new Error(validationError)); return }
    const stagedFiles = Object.values(imageValues).flat()
    if (['Rejected', 'Reopened'].includes(target) && !hasEvidence && !stagedFiles.length) {
      setError(new Error(`Supporting evidence is required before ${target === 'Rejected' ? 'rejecting' : 'reopening'} a defect`))
      return
    }
    setBusy(true); setError(null)
    try {
      // Rejection/reopening evidence is a server-side precondition, so
      // upload staged screenshots before requesting the transition.
      if (['Rejected', 'Reopened'].includes(target) && stagedFiles.length) {
        await api.uploadFormFiles(`/api/defects/${defect.id}/attachments`, {}, stagedFiles)
      }
      const saved = await api.post<DefectOut>(`/api/defects/${defect.id}/transition`, { status: target, ...values })
      if (['Rejected', 'Reopened'].includes(target)) { onChanged(saved); return }
      setSavedDefect(saved)
      await attachStagedEvidence(saved)
    } catch (err) { setError(err); setBusy(false) }
  }
  return <Modal title={`${target} ${defect.defect_key}?`} onClose={onClose} variant="dialog" preventBackdropClose wide>
    <form onSubmit={submit}>
      <div className="defect-transition-summary"><Badge status={defect.status} /><span>→</span><Badge status={target} /></div>
      <fieldset disabled={!!savedDefect} className="defect-transition-fieldset">
      {target === 'Assigned' && <>{defect.assignee_name && <p className="defect-assignment-current">Currently assigned to <strong>{defect.assignee_name}</strong>{defect.assigned_team ? ` (${defect.assigned_team})` : ''}.</p>}<Field label="Department *"><SearchableSelect value={values.assigned_team || ''} onChange={(value) => { set('assigned_team', value); set('assignee_id', null) }} placeholder="Select department…" options={departments.map((department) => ({ value: department.name, label: department.name }))} /></Field><Field label="Assignee *"><UserAssignSelect value={values.assignee_id ? String(values.assignee_id) : ''} onChange={(value) => set('assignee_id', value ? Number(value) : null)} users={departmentUsers} placeholder={values.assigned_team ? 'Select responsible user…' : 'Select a department first…'} disabled={!values.assigned_team} /></Field>{autoDepartment && <p className="defect-assignment-default">Defaulted from {defect.project_department ? 'the linked Failed / Blocked Test Execution\'s project' : 'the linked QA Request'}: <strong>{autoDepartment}</strong></p>}<Field label="Remarks"><JiraRichTextField value={values.remarks || ''} onChange={(v) => set('remarks', v)} onImagesChange={setImages('remarks')} disabled={!!savedDefect} ariaLabel="Remarks" placeholder="Optional note for the assignee…" /></Field></>}
      {target === 'Resolved' && <><Field label="Resolution Type *"><select required value={values.resolution_type || ''} onChange={(e) => set('resolution_type', e.target.value)}><option value="">Select…</option>{RESOLUTION_TYPES.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Resolution Summary *"><JiraRichTextField value={values.resolution_summary || ''} onChange={(v) => set('resolution_summary', v)} onImagesChange={setImages('resolution_summary')} disabled={!!savedDefect} ariaLabel="Resolution Summary" placeholder="Summarize the fix…" /></Field><Field label="Root Cause *"><JiraRichTextField value={values.root_cause || ''} onChange={(v) => set('root_cause', v)} onImagesChange={setImages('root_cause')} disabled={!!savedDefect} ariaLabel="Root Cause" placeholder="Describe the root cause…" /></Field><Field label="Fix Details *"><JiraRichTextField value={values.fix_details || ''} onChange={(v) => set('fix_details', v)} onImagesChange={setImages('fix_details')} disabled={!!savedDefect} ariaLabel="Fix Details" placeholder="Describe the fix that was applied…" /></Field><Field label="Fixed Build / Release *"><input required value={values.fixed_build_version || ''} onChange={(e) => set('fixed_build_version', e.target.value)} /></Field></>}
      {target === 'Closed' && <><Field label="Tested Build Version *"><input required value={values.tested_build_version || ''} onChange={(e) => set('tested_build_version', e.target.value)} /></Field><Field label="Retest Actual Result *"><JiraRichTextField value={values.actual_result || ''} onChange={(v) => set('actual_result', v)} onImagesChange={setImages('actual_result')} disabled={!!savedDefect} ariaLabel="Retest Actual Result" placeholder="Describe the retest outcome…" /></Field><Field label="Retest Remarks *"><JiraRichTextField value={values.retest_remarks || ''} onChange={(v) => set('retest_remarks', v)} onImagesChange={setImages('retest_remarks')} disabled={!!savedDefect} ariaLabel="Retest Remarks" /></Field><Field label="Closure Remarks *"><JiraRichTextField value={values.closure_remarks || ''} onChange={(v) => set('closure_remarks', v)} onImagesChange={setImages('closure_remarks')} disabled={!!savedDefect} ariaLabel="Closure Remarks" /></Field></>}
      {target === 'Reopened' && <><Field label="Reopening Reason *"><JiraRichTextField value={values.reopen_reason || ''} onChange={(v) => set('reopen_reason', v)} onImagesChange={setImages('reopen_reason')} disabled={!!savedDefect} ariaLabel="Reopening Reason" placeholder="Explain the new evidence or why the rejection decision must be reconsidered." /></Field><p className="muted small">Supporting evidence is mandatory. Use an existing attachment or paste/upload evidence above.</p></>}
      {target === 'Deferred' && <><Field label="Deferral Reason *"><JiraRichTextField value={values.deferral_reason || ''} onChange={(v) => set('deferral_reason', v)} onImagesChange={setImages('deferral_reason')} disabled={!!savedDefect} ariaLabel="Deferral Reason" /></Field><div className="grid grid-2"><Field label="Approved By *"><input required value={values.deferral_approved_by || ''} onChange={(e) => set('deferral_approved_by', e.target.value)} /></Field><Field label="Target Release *"><input required value={values.target_release || ''} onChange={(e) => set('target_release', e.target.value)} /></Field></div><Field label="Expected Resolution Date *"><input required type="date" value={values.expected_resolution_date || ''} onChange={(e) => set('expected_resolution_date', e.target.value)} /></Field></>}
      {target === 'Rejected' && <><Field label="Rejection Reason *"><JiraRichTextField value={values.rejection_reason || ''} onChange={(v) => set('rejection_reason', v)} onImagesChange={setImages('rejection_reason')} disabled={!!savedDefect} ariaLabel="Rejection Reason" placeholder="Give a valid rejection reason and paste or upload supporting evidence." /></Field><p className="muted small">Supporting evidence is mandatory. Use an existing attachment or paste/upload evidence above.</p></>}
      {target === 'Duplicate' && <Field label="Original Defect ID *"><SearchableSelect value={values.duplicate_defect_id ? String(values.duplicate_defect_id) : ''} onChange={(value) => set('duplicate_defect_id', value ? Number(value) : null)} placeholder="Select original defect…" options={defects.filter((item) => item.id !== defect.id).map((item) => ({ value: String(item.id), label: `${item.defect_key} · ${item.title}` }))} /></Field>}
      {target === 'Not a Defect' && <Field label="Discussion & Requirements Confirmation *"><JiraRichTextField value={values.not_a_defect_reason || ''} onChange={(v) => set('not_a_defect_reason', v)} onImagesChange={setImages('not_a_defect_reason')} disabled={!!savedDefect} ariaLabel="Discussion and Requirements Confirmation" placeholder="Record the discussion with the Developer/Dev Lead and confirmation against requirements…" /></Field>}
      {!['Assigned', 'Resolved', 'Closed', 'Reopened', 'Deferred', 'Rejected', 'Duplicate', 'Not a Defect'].includes(target) && <Field label="Remarks"><JiraRichTextField value={values.remarks || ''} onChange={(v) => set('remarks', v)} onImagesChange={setImages('remarks')} disabled={!!savedDefect} ariaLabel="Remarks" /></Field>}
      </fieldset>
      <ErrorText error={error} title={savedDefect ? `${savedDefect.defect_key} was updated` : 'Defect workflow action failed'} />
      <div className="modal-actions">
        {savedDefect
          ? <><button className="btn btn-primary" disabled={busy}>{busy ? 'Attaching…' : 'Retry attaching evidence'}</button><button type="button" className="btn" disabled={busy} onClick={() => onChanged(savedDefect)}>Continue without evidence</button></>
          : <><button className={`btn ${['Rejected', 'Duplicate', 'Not a Defect'].includes(target) ? 'btn-danger' : 'btn-primary'}`} disabled={busy || (target === 'Assigned' && (!values.assignee_id || !values.assigned_team))}>{busy ? 'Updating…' : target}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></>}
      </div>
    </form>
  </Modal>
}

// 2026-08 Reassignment Requirement -- transition_defect's "Assigned" step
// (see TransitionModal above) is only reachable from New/Reopened/Deferred,
// so once a defect is In Progress/Resolved/Retest/Reopened/Deferred there
// was previously no way to change who it's assigned to at all. This hits
// the dedicated POST /{id}/reassign endpoint instead -- it changes only the
// assignee, leaving status/history untouched, and requires a reason.
function ReassignDefectModal({ defect, users, onClose, onChanged }: {
  defect: DefectOut; users: UserOut[]
  onClose: () => void; onChanged: (defect: DefectOut) => void
}) {
  const [assigneeId, setAssigneeId] = useState<number | ''>('')
  const [assignedTeam, setAssignedTeam] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const currentAssignee = users.find((u) => u.id === defect.assignee_id)
  const teammateDepartments = userDepartments(currentAssignee)
  const eligibleDepartments = Array.from(new Set([
    ...(teammateDepartments.length ? teammateDepartments : (defect.assigned_team ? [defect.assigned_team] : [])),
    QA_DEPARTMENT,
  ]))
  const eligibleUsers = users.filter((candidate) => candidate.is_active
    && userDepartments(candidate).some((department) => eligibleDepartments.includes(department)))

  function selectAssignee(value: string) {
    const selectedUser = users.find((candidate) => String(candidate.id) === value)
    setAssigneeId(value ? Number(value) : '')
    if (!selectedUser) { setAssignedTeam(''); return }
    const selectedDepartments = userDepartments(selectedUser)
    const destination = selectedDepartments.includes(QA_DEPARTMENT)
      ? QA_DEPARTMENT
      : eligibleDepartments.find((department) => selectedDepartments.includes(department)) || ''
    setAssignedTeam(destination)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!assigneeId || !reason.trim()) return
    setBusy(true); setError(null)
    try {
      const saved = await api.post<DefectOut>(`/api/defects/${defect.id}/reassign`, {
        assignee_id: assigneeId, assigned_team: assignedTeam || null, reason: reason.trim(),
      })
      onChanged(saved)
    } catch (err) { setError(err); setBusy(false) }
  }

  return <Modal title={`Reassign ${defect.defect_key}`} onClose={onClose} variant="dialog" preventBackdropClose>
    <form onSubmit={submit}>
      <p className="defect-assignment-current">Currently assigned to <strong>{defect.assignee_name || 'Unassigned'}</strong>{defect.assigned_team ? ` (${defect.assigned_team})` : ''}.</p>
      <Field label="Eligible reassignment teams">
        <div className="defect-reassignment-scope">
          {eligibleDepartments.map((department) => <span key={department} className={department === QA_DEPARTMENT ? 'qa' : ''}>{department === QA_DEPARTMENT ? 'QA team' : department}</span>)}
        </div>
      </Field>
      <Field label="New Assignee *"><UserAssignSelect value={assigneeId ? String(assigneeId) : ''} onChange={selectAssignee} users={eligibleUsers} placeholder="Search teammates or QA members…" /></Field>
      {assignedTeam && <p className="muted small defect-reassignment-destination">The defect will be routed to <strong>{assignedTeam}</strong>.</p>}
      <Field label="Reassignment reason *"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required -- why is this defect being reassigned?" /></Field>
      <ErrorText error={error} title="Defect could not be reassigned" />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy || !assigneeId || !reason.trim()}>{busy ? 'Reassigning…' : 'Reassign'}</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </form>
  </Modal>
}

function LinkExecutionModal({ defect, contexts, onClose, onChanged }: {
  defect: DefectOut; contexts: ExecutionContext[]; onClose: () => void; onChanged: (defect: DefectOut) => void
}) {
  const [executionId, setExecutionId] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!executionId) return
    setBusy(true); setError(null)
    try { onChanged(await api.post<DefectOut>(`/api/defects/${defect.id}/link-execution`, { execution_id: Number(executionId) })) }
    catch (err) { setError(err); setBusy(false) }
  }
  return <Modal title={`Link ${defect.defect_key} to execution`} onClose={onClose} variant="dialog" preventBackdropClose wide>
    <form onSubmit={submit}>
      <div className="defect-trace-banner"><strong>Failed / Blocked executions only</strong><span>The selected Test Cycle, Test Case, execution attempt, and runner will become part of this defect's governed traceability.</span></div>
      <Field label="Test Cycle / Test Case / Execution *"><SearchableSelect value={executionId} onChange={setExecutionId} placeholder="Select Failed or Blocked execution…" options={contexts.map((row) => ({ value: String(row.execution.id), label: `${row.cycle.cycle_key} · ${row.execution.test_case?.test_case_key || row.execution.test_case_id} · ${row.execution.status}` }))} /></Field>
      <ErrorText error={error} title="Defect could not be linked" />
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !executionId}>{busy ? 'Linking…' : 'Link Defect'}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}

// Backend (defects.py::update_defect) only allows editing a defect while it
// is still in "New" status, and only for the reporter or a manager (Admin/
// QA Lead/Chief Manager QA/this defect's Project Lead or Owner) -- once it's
// Assigned or further along, the workflow actions (TransitionModal above)
// are the only way to add information, matching the audit-trail-driven
// design of the rest of this module. Severity/Priority are further
// restricted to managers only, same as the backend's own check.
function EditDefectModal({ defect, manager, onClose, onChanged }: {
  defect: DefectOut; manager: boolean; onClose: () => void; onChanged: (defect: DefectOut) => void
}) {
  const [title, setTitle] = useState(defect.title)
  const [description, setDescription] = useState(defect.description)
  const [moduleFeature, setModuleFeature] = useState(defect.module_feature)
  const [environment, setEnvironment] = useState(defect.environment)
  const [severity, setSeverity] = useState(defect.severity)
  const [priority, setPriority] = useState(defect.priority)
  const [steps, setSteps] = useState(defect.steps_to_reproduce)
  const [actual, setActual] = useState(defect.actual_result)
  const [expected, setExpected] = useState(defect.expected_result)
  const [descriptionImages, setDescriptionImages] = useState<File[]>([])
  const [stepsImages, setStepsImages] = useState<File[]>([])
  const [actualImages, setActualImages] = useState<File[]>([])
  const [expectedImages, setExpectedImages] = useState<File[]>([])
  const { evidenceFiles, addEvidenceFiles, removeEvidenceFile, attach } = useStagedEvidence({
    uploadPath: (id) => `/api/defects/${id}/attachments`,
    verb: 'updated',
    continueHint: 'you can always add evidence from Evidence & Attachments below.',
  })
  const [savedDefect, setSavedDefect] = useState<DefectOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  function attachStagedEvidence(saved: DefectOut) {
    return attach(saved, [descriptionImages, stepsImages, actualImages, expectedImages], onChanged, (err) => { setError(err); setBusy(false) })
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (savedDefect) { setBusy(true); setError(null); await attachStagedEvidence(savedDefect); return }
    if (!title.trim() || !description.trim() || !moduleFeature.trim()) { setError(new Error('Defect Title, Description, and Module/Feature are required')); return }
    if (!steps.trim() || !actual.trim() || !expected.trim()) { setError(new Error('Steps to Reproduce, Actual Result, and Expected Result are required')); return }
    setBusy(true); setError(null)
    try {
      const saved = await api.patch<DefectOut>(`/api/defects/${defect.id}`, {
        title, description, module_feature: moduleFeature, environment,
        ...(manager ? { severity, priority } : {}),
        steps_to_reproduce: steps, expected_result: expected, actual_result: actual,
      })
      setSavedDefect(saved)
      await attachStagedEvidence(saved)
    } catch (err) { setError(err); setBusy(false) }
  }

  return <Modal title={`Edit ${defect.defect_key}`} onClose={onClose} wide>
    <form onSubmit={submit} className="defect-form">
      <div className="defect-trace-banner"><strong>Editable while New</strong><span>Once this defect is Assigned or moves further through the workflow, use workflow actions instead -- every later change is captured there with its own audit trail.</span></div>
      <Field label="Defect Title *"><input required disabled={!!savedDefect} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Description *"><JiraRichTextField value={description} onChange={setDescription} onImagesChange={setDescriptionImages} disabled={!!savedDefect} ariaLabel="Description" placeholder="Describe the defect…" /></Field>
      <div className="grid grid-2">
        <Field label="Module / Feature *"><input required disabled={!!savedDefect} value={moduleFeature} onChange={(e) => setModuleFeature(e.target.value)} /></Field>
        <Field label="Environment *"><select required disabled={!!savedDefect} value={environment} onChange={(e) => setEnvironment(e.target.value)}>{ENVIRONMENTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
        <Field label={`Severity ${manager ? '*' : ''}`}>{manager ? <select disabled={!!savedDefect} value={severity} onChange={(e) => setSeverity(e.target.value)}>{SEVERITIES.map((value) => <option key={value}>{value}</option>)}</select> : <input readOnly value={severity} />}</Field>
        <Field label={`Priority ${manager ? '*' : ''}`}>{manager ? <select disabled={!!savedDefect} value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select> : <input readOnly value={priority} />}</Field>
      </div>
      {!manager && <p className="muted small">Only a QA Lead, Project Lead, or Administrator can change Severity or Priority.</p>}
      <div className="defect-form-section">
        <div className="defect-form-section-heading"><span>✓</span><div><strong>Reproduction evidence</strong><small>Paste or upload screenshots directly into any field below.</small></div></div>
        <Field label="Steps to Reproduce *"><JiraRichTextField value={steps} onChange={setSteps} onImagesChange={setStepsImages} disabled={!!savedDefect} ariaLabel="Steps to Reproduce" placeholder="Describe the exact steps needed to reproduce the defect…" /></Field>
        <Field label="Actual Result *"><JiraRichTextField value={actual} onChange={setActual} onImagesChange={setActualImages} disabled={!!savedDefect} ariaLabel="Actual Result" placeholder="Describe what actually happened…" /></Field>
        <Field label="Expected Result *"><JiraRichTextField value={expected} onChange={setExpected} onImagesChange={setExpectedImages} disabled={!!savedDefect} ariaLabel="Expected Result" placeholder="Describe the expected behaviour…" /></Field>
      </div>
      <div className="defect-form-section defect-evidence">
        <div><h4>Evidence & Attachments <span>{descriptionImages.length + stepsImages.length + actualImages.length + expectedImages.length + evidenceFiles.length}</span></h4>
          <label className="btn btn-sm">+ Add evidence<input type="file" multiple hidden disabled={!!savedDefect} onChange={(e) => addEvidenceFiles(e.target.files)} /></label>
        </div>
        {evidenceFiles.length > 0 && <div className="defect-files">{evidenceFiles.map((file, index) => <button type="button" key={`${file.name}-${index}`} disabled={!!savedDefect} onClick={() => removeEvidenceFile(index)}>{file.name} ✕</button>)}</div>}
        <p className="muted small">Screenshots pasted into Steps/Actual/Expected above are attached automatically -- use this to add anything else.</p>
      </div>
      <ErrorText error={error} title={savedDefect ? `${savedDefect.defect_key} was updated` : 'Defect could not be updated'} />
      <div className="modal-actions">
        {savedDefect
          ? <><button className="btn btn-primary" disabled={busy}>{busy ? 'Attaching…' : 'Retry attaching evidence'}</button><button type="button" className="btn" disabled={busy} onClick={() => onChanged(savedDefect)}>Continue without evidence</button></>
          : <><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save Changes'}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></>}
      </div>
    </form>
  </Modal>
}

function DefectDetail({ defect, users, departments, requestDepartment, defects, contexts, access, onClose, onChanged }: {
  defect: DefectOut; users: UserOut[]; departments: DepartmentOut[]; requestDepartment?: string | null; defects: DefectListOut[]; contexts: ExecutionContext[]; access?: TestProjectMyAccessOut; onClose: () => void; onChanged: (defect: DefectOut) => void
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [transition, setTransition] = useState('')
  const [showReassign, setShowReassign] = useState(false)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [showLinkExecution, setShowLinkExecution] = useState(false)
  const [editMode, setEditMode] = useState(false)
  useEffect(() => {
    api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=DEFECT&entity_id=${defect.id}`).then(setActivity).catch(() => setActivity([]))
    api.get<RequestDocumentOut[]>(`/api/defects/${defect.id}/attachments`).then(setDocuments).catch(() => setDocuments([]))
  }, [defect.id])
  async function upload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true); setError(null)
    try {
      const created = await api.uploadFormFiles<RequestDocumentOut[]>(`/api/defects/${defect.id}/attachments`, {}, Array.from(files))
      setDocuments((current) => [...current, ...created])
    }
    catch (err) { setError(err) } finally { setUploading(false) }
  }
  async function download(document: RequestDocumentOut) {
    const blob = await api.getBlob(`/api/defects/${defect.id}/attachments/${document.id}/download`)
    const url = URL.createObjectURL(blob); const anchor = window.document.createElement('a')
    anchor.href = url; anchor.download = document.file_name; anchor.click(); URL.revokeObjectURL(url)
  }
  const roles = user?.roles || []
  const viewOnly = roles.includes('VIEW_ONLY')
  const manager = roles.some((role) => ['ADMIN', 'QA_LEAD', 'CHIEF_MANAGER_QA'].includes(role)) || !!access?.can_give_final_approval
  const canAssign = manager || roles.includes('QA_ENGINEER')
  const applicationOwner = roles.includes('APPLICATION_OWNER')
  const assignee = !viewOnly && defect.assignee_id === user?.id
  const tester = !viewOnly && (defect.retest_tester_id === user?.id || defect.reporter_id === user?.id)
  // 2026-08 Reassignment Requirement -- "Assigned" (above) is only reachable
  // from New/Reopened/Deferred, so this is the only way to change the
  // assignee once work is already under way. Eligible to the current
  // assignee, the Department Head of the CURRENT ASSIGNEE's own department
  // (looked up from `users`, since a defect's assigned_team can be routed to
  // any active department, not just QA), or Admin.
  const currentAssigneeUser = users.find((u) => u.id === defect.assignee_id)
  const canReassignDefect = !viewOnly && !!defect.assignee_id
    && DEFECT_REASSIGNABLE_STATUSES.includes(defect.status)
    && canReassign(user, defect.assignee_id, currentAssigneeUser?.departments && currentAssigneeUser.departments.length
      ? currentAssigneeUser.departments : currentAssigneeUser?.department)
  const assigneeOrDepartmentHead = !!defect.assignee_id
    && canReassign(user, defect.assignee_id, currentAssigneeUser?.departments && currentAssigneeUser.departments.length
      ? currentAssigneeUser.departments : (currentAssigneeUser?.department || defect.assigned_team))
  const allowedTransitions = viewOnly ? [] : (TRANSITIONS[defect.status] || []).filter((target) => {
    // Same actor set already trusted to reject/duplicate a defect -- see
    // routers/defects.py's matching comment on why the Dev Department Head
    // isn't included here (no assignee exists yet at triage time).
    if (target === 'Triaged') return canAssign || defect.reporter_id === user?.id
    if (target === 'Assigned') return canAssign
    if (['Rejected', 'Duplicate'].includes(target)) return manager || defect.reporter_id === user?.id || assigneeOrDepartmentHead
    if (target === 'Not a Defect') return manager || defect.reporter_id === user?.id
    if (target === 'Deferred') return manager || applicationOwner
    if (['In Progress', 'Resolved'].includes(target)) return manager || assignee
    if (['Retest', 'Closed'].includes(target)) return manager || tester
    // Closed and Rejected reopen through different ownership paths. Closed
    // is a retest outcome; Rejected is an investigation decision and can be
    // reconsidered by the same scoped actors who were allowed to reject it.
    if (target === 'Reopened') return defect.status === 'Closed'
      ? roles.some((role) => ['ADMIN', 'QA_LEAD', 'CHIEF_MANAGER_QA'].includes(role)) || defect.reporter_id === user?.id
      : defect.status === 'Rejected'
        ? manager || defect.reporter_id === user?.id || assigneeOrDepartmentHead
        : manager || tester
    return false
  })
  const lifecycle = ['New', 'Triaged', 'Assigned', 'In Progress', 'Resolved', 'Retest', 'Closed']
  const terminalOutcomes = ['Rejected', 'Not a Defect']
  const lifecycleIndex = lifecycle.indexOf(defect.status)
  return <>
    <Modal title={`${defect.defect_key} · ${defect.title}`} onClose={onClose} wide>
      <div className="defect-detail-hero">
        <div className="defect-detail-summary"><span className="defect-detail-kicker">{defect.application_name} · {defect.module_feature}</span><div><Badge status={defect.status} /><span className={`defect-severity ${defect.severity.toLowerCase()}`}>{defect.severity}</span><span className="defect-priority-pill">{defect.priority}</span>{!defect.execution_id && <span className="badge badge-yellow">Traceability incomplete</span>}</div></div>
        {!viewOnly && <div className="defect-actions">{defect.status === 'New' && (manager || defect.reporter_id === user?.id) && <button className="btn btn-sm" onClick={() => setEditMode(true)}>Edit</button>}{!defect.execution_id && <button className="btn btn-sm btn-primary" disabled={!contexts.length} onClick={() => setShowLinkExecution(true)}>Link to execution</button>}{canReassignDefect && <button className="btn btn-sm" onClick={() => setShowReassign(true)}>Reassign</button>}{allowedTransitions.map((status) => <button key={status} className={`btn btn-sm ${status === 'Rejected' ? 'btn-danger' : status === 'Closed' ? 'btn-primary' : ''}`} onClick={() => setTransition(status)}>{status}</button>)}</div>}
      </div>
      <div className="defect-lifecycle">
        {lifecycle.map((stage, index) => <div key={stage} className={`${index === lifecycleIndex ? 'current' : ''} ${lifecycleIndex >= 0 && index < lifecycleIndex ? 'complete' : ''}`}><i>{index < lifecycleIndex ? '✓' : index + 1}</i><span>{stage}</span></div>)}
        <div className="defect-lifecycle-outcomes" aria-label="Alternative terminal outcomes">
          {terminalOutcomes.map((status) => <div key={status} className={defect.status === status ? 'current' : ''}><i>{defect.status === status ? '✓' : '×'}</i><span>{status}</span></div>)}
        </div>
        {lifecycleIndex < 0 && !terminalOutcomes.includes(defect.status) && <div className="defect-lifecycle-exception"><strong>{defect.status}</strong><span>Exception workflow state</span></div>}
      </div>
      <div className="defect-trace-grid">
        <button onClick={() => navigate(`/qa-requests?open=${defect.qa_request_id}`)}><small>QA Request</small><strong>{defect.qa_request_key || `#${defect.qa_request_id}`}</strong></button>
        <button disabled={!defect.cycle_id || !defect.project_id} onClick={() => defect.cycle_id && defect.project_id && navigate(`/test-execution?project=${defect.project_id}&cycle=${defect.cycle_id}`)}><small>Test Cycle</small><strong>{defect.cycle_key || 'Not linked'}</strong></button>
        <button disabled={!defect.test_case_key} onClick={() => defect.test_case_key && navigate(`/test-repository?${defect.project_id ? `project=${defect.project_id}&` : ''}open=${encodeURIComponent(defect.test_case_key)}`)}><small>Test Case</small><strong>{defect.test_case_key || 'Not linked'}</strong></button>
        <button disabled={!defect.execution_id || !defect.cycle_id || !defect.project_id} onClick={() => defect.execution_id && defect.cycle_id && defect.project_id && navigate(`/test-execution?project=${defect.project_id}&cycle=${defect.cycle_id}&execution=${defect.execution_id}`)}><small>Execution</small><strong>{defect.execution_id ? `#${defect.execution_id}` : 'Not linked'}</strong></button>
      </div>
      {/* Reported directly: "Select a previously opened, unlinked governed
          defect ... instead show linked defect as well" -- the picker now
          also offers a defect already primary-linked elsewhere, adding this
          as an ADDITIONAL trace (see routers/defects.py's
          _link_additional_execution) without disturbing the primary link
          shown in the grid above. Surfaced here so a QA Lead reviewing this
          defect sees every execution it's actually been traced to, not just
          the primary one. */}
      {defect.execution_links.length > 0 && (
        <div className="defect-also-linked">
          <small>Also linked to</small>
          <div className="defect-also-linked-chips">
            {defect.execution_links.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => navigate(`/test-execution?${link.project_id ? `project=${link.project_id}&` : ''}${link.cycle_id ? `cycle=${link.cycle_id}&` : ''}execution=${link.execution_id}`)}
              >
                {link.cycle_key || 'Cycle'} · {link.test_case_key || `execution #${link.execution_id}`}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="defect-detail-grid">
        <div className="defect-detail-main">
          <section><span className="defect-section-label">Issue definition</span><h4>Description</h4><AuthenticatedMarkdown value={defect.description} basePath={`/api/defects/${defect.id}/attachments`} /></section>
          <section><span className="defect-section-label">Reproduction evidence</span><h4>Steps to Reproduce</h4><AuthenticatedMarkdown value={defect.steps_to_reproduce} basePath={`/api/defects/${defect.id}/attachments`} /></section>
          <div className="defect-result-compare"><section className="actual"><h4>Actual Result</h4><AuthenticatedMarkdown value={defect.actual_result} basePath={`/api/defects/${defect.id}/attachments`} /></section><section className="expected"><h4>Expected Result</h4><AuthenticatedMarkdown value={defect.expected_result} basePath={`/api/defects/${defect.id}/attachments`} /></section></div>
        </div>
        <aside className="defect-detail-aside"><section><span className="defect-section-label">Operating context</span><h4>Defect properties</h4><dl><dt>Application</dt><dd>{defect.application_name}</dd><dt>Module / Feature</dt><dd>{defect.module_feature}</dd><dt>Environment</dt><dd>{defect.environment}</dd><dt>Build</dt><dd>{defect.build_version || '—'}</dd><dt>Reporter</dt><dd>{defect.reporter_name}</dd><dt>Assignee</dt><dd>{defect.assignee_name || 'Unassigned'}</dd></dl></section></aside>
      </div>
      {(defect.assignment_remarks || defect.resolution_summary || defect.retest_remarks || defect.reopen_reason || defect.deferral_reason || defect.rejection_reason || defect.not_a_defect_reason) && <section className="defect-workflow-details"><h4>Workflow Details</h4>
        {defect.assignment_remarks && <div className="defect-workflow-item"><strong>Assignment{defect.assigned_by_name ? ` · ${defect.assigned_by_name}` : ''}</strong><AuthenticatedMarkdown value={defect.assignment_remarks} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
        {defect.resolution_summary && <div className="defect-workflow-item"><strong>Resolution</strong><AuthenticatedMarkdown value={defect.resolution_summary} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
        {defect.root_cause && <div className="defect-workflow-item"><strong>Root cause</strong><AuthenticatedMarkdown value={defect.root_cause} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
        {defect.retest_remarks && <div className="defect-workflow-item"><strong>Retest</strong><AuthenticatedMarkdown value={defect.retest_remarks} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
        {defect.reopen_reason && <div className="defect-workflow-item"><strong>Reopened</strong><AuthenticatedMarkdown value={defect.reopen_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
        {defect.deferral_reason && <div className="defect-workflow-item"><strong>Deferred{defect.target_release ? ` · ${defect.target_release}` : ''}</strong><AuthenticatedMarkdown value={defect.deferral_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
        {defect.rejection_reason && <div className="defect-workflow-item"><strong>Rejected</strong><AuthenticatedMarkdown value={defect.rejection_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
        {defect.not_a_defect_reason && <div className="defect-workflow-item"><strong>Not a Defect</strong><AuthenticatedMarkdown value={defect.not_a_defect_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div>}
      </section>}
      <section className="defect-evidence"><div><h4>Evidence & Attachments <span>{documents.length}</span></h4>{!viewOnly && <label className="btn btn-sm">{uploading ? 'Uploading…' : '+ Add evidence'}<input type="file" multiple hidden disabled={uploading} onChange={(e) => upload(e.target.files)} /></label>}</div>{documents.length ? <div className="defect-files">{documents.map((document) => <button key={document.id} onClick={() => download(document)}>{document.file_name}</button>)}</div> : <p className="muted small">No supporting evidence attached.</p>}<ErrorText error={error} /></section>
      <JiraActivity entityType="DEFECT" entityId={defect.id} items={activity} onPosted={(item) => setActivity((current) => [...current, item])} />
    </Modal>
    {transition && <TransitionModal defect={defect} target={transition} users={users} departments={departments} requestDepartment={requestDepartment} defects={defects} hasEvidence={documents.length > 0} onClose={() => setTransition('')} onChanged={(saved) => { setTransition(''); onChanged(saved) }} />}
    {showReassign && <ReassignDefectModal defect={defect} users={users} onClose={() => setShowReassign(false)} onChanged={(saved) => { setShowReassign(false); onChanged(saved) }} />}
    {showLinkExecution && <LinkExecutionModal defect={defect} contexts={contexts} onClose={() => setShowLinkExecution(false)} onChanged={(saved) => { setShowLinkExecution(false); onChanged(saved) }} />}
    {editMode && <EditDefectModal defect={defect} manager={manager} onClose={() => setEditMode(false)} onChanged={(saved) => { setEditMode(false); onChanged(saved) }} />}
  </>
}

export default function Defects() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [dashboard, setDashboard] = useState<DefectDashboardOut | null>(null)
  const [requests, setRequests] = useState<QARequestListOut[]>([])
  const [contexts, setContexts] = useState<ExecutionContext[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [duplicateCandidates, setDuplicateCandidates] = useState<DefectListOut[]>([])
  const [selected, setSelected] = useState<DefectOut | null>(null)
  const [openingDefectId, setOpeningDefectId] = useState<number | null>(null)
  const [createMode, setCreateMode] = useState<'' | 'execution' | 'standalone'>('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [severity, setSeverity] = useState('')
  const [priority, setPriority] = useState('')
  const [queue, setQueue] = useState<'all' | 'attention' | 'mine' | 'unlinked' | 'retest' | 'closed'>('all')
  const [error, setError] = useState<unknown>(null)
  const initialExecutionId = Number(searchParams.get('execution')) || undefined

  // SRS 7.2 pagination rollout -- the register is now server-paginated and
  // server-filtered (search/status/severity/priority/queue all become query
  // params instead of an in-browser .filter() over the whole register). See
  // DefectDashboardOut (loaded below) for the queue-tab/health-strip counts
  // this list can no longer compute on its own from just the current page.
  const {
    items: defects, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading: defectsLoading, setPage, setPageSize, reload: reloadDefects,
  } = usePaginatedList<DefectListOut>('/api/defects', {
    search,
    status: status ? [status] : undefined,
    extra: { severity: severity || undefined, priority: priority || undefined, queue: queue === 'all' ? undefined : queue },
  })

  const loadDashboard = useCallback(() => {
    api.get<DefectDashboardOut>('/api/defects/dashboard').then(setDashboard).catch(setError)
  }, [])
  const refreshDefects = useCallback(() => { reloadDefects(); loadDashboard() }, [reloadDefects, loadDashboard])

  // PAG-006 -- the register only ever holds the lightweight DefectListOut
  // shape; opening a row (by id) or resolving the `?open=<defect_key>`
  // deep-link (Global Search, LinkedDefects.tsx, and this
  // page's own "open what was just created" step) fetches the full
  // DefectOut before showing the detail panel.
  const openDefect = useCallback(async (keyOrId: number | string) => {
    if (typeof keyOrId === 'number') setOpeningDefectId(keyOrId)
    try {
      const path = typeof keyOrId === 'number' ? `/api/defects/${keyOrId}` : `/api/defects/by-key/${encodeURIComponent(keyOrId)}`
      setSelected(await api.get<DefectOut>(path))
    } catch (err) { setError(err) } finally { setOpeningDefectId(null) }
  }, [])

  const load = useCallback(async () => {
    try {
      // Fetches the full active-user directory (every department), not the
      // Test Management IT-QA-only eligible-users list -- a defect can be
      // routed to any department (Development, Infra, etc., picked via the
      // "Department" field below), so the responsible-user picker needs
      // candidates from whichever department is actually selected, not just
      // QA. See TransitionModal's departmentUsers filter, which narrows this
      // full list down to the selected assigned_team at assignment time.
      const [qaRequests, allUsers, activeDepartments, duplicates, executionContexts] = await Promise.all([
        // SRS PAG-002 -- /api/qa-requests is now paginated (max page_size
        // 100); this picker (linking a new defect to its QA Request, and
        // reading the responsible department off one) wants "effectively
        // all of them" rather than one page, so it asks for the max size
        // directly instead of going through hooks/usePaginatedList.
        api.get<PageOut<QARequestListOut>>('/api/qa-requests?page_size=100').then((p) => p.items),
        api.get<UserOut[]>('/api/auth/users'),
        api.get<DepartmentOut[]>('/api/departments'),
        // Candidate pool for TransitionModal's "Original Defect ID" picker
        // (marking a defect Duplicate) -- SearchableSelect has no async/
        // server-search mode, so this is capped at the same page_size=100
        // "effectively all of them" compromise used by the QA Requests
        // picker above, not a true unpaginated PAG-010 candidate set (the
        // defect register has real unbounded growth, unlike Test Cases'
        // folder tree).
        api.get<PageOut<DefectListOut>>('/api/defects?page_size=100').then((p) => p.items),
        // 2026-08 -- reported directly: "if there are 30 project[s] then 30
        // api call[s] ... same for cycles, executions." This single batch
        // call (routers/test_execution.py::list_blocked_failed_executions)
        // replaces what used to be a per-project /my-access + /cycles fan-out
        // followed by a per-cycle /executions fan-out -- see
        // DefectLinkableExecutionOut's own docstring in schemas.py. No
        // /api/test-projects fetch is needed here any more either -- it was
        // only ever used to drive that fan-out.
        api.get<DefectLinkableExecutionOut[]>('/api/test-execution/executions/blocked-or-failed'),
      ])
      setRequests(qaRequests); setUsers(allUsers); setDepartments(activeDepartments); setDuplicateCandidates(duplicates)
      setContexts(executionContexts)
      loadDashboard()
      const openKey = searchParams.get('open')
      if (openKey) openDefect(openKey)
      if (initialExecutionId) setCreateMode('execution')
    } catch (err) { setError(err) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  // 2026-08 -- was an eager Record<projectId, TestProjectMyAccessOut> fetched
  // for EVERY project up front (part of the same N+1 burst above), even
  // though it's only ever consulted for whichever ONE defect is currently
  // open (`access={...}` below). GET /api/test-projects/{id}/my-access's own
  // docstring says it's meant to be called "once per project selection" --
  // TestExecution.tsx/TestRepository.tsx already do exactly that; this now
  // matches them, fetching on demand only when a defect with a project_id is
  // opened, instead of once per project at page load.
  const [selectedAccess, setSelectedAccess] = useState<TestProjectMyAccessOut | undefined>(undefined)
  useEffect(() => {
    if (!selected?.project_id) { setSelectedAccess(undefined); return }
    let cancelled = false
    api.get<TestProjectMyAccessOut>(`/api/test-projects/${selected.project_id}/my-access`)
      .then((access) => { if (!cancelled) setSelectedAccess(access) })
      .catch(() => { if (!cancelled) setSelectedAccess(undefined) })
    return () => { cancelled = true }
  }, [selected?.project_id])

  // Queue-tab/health-strip counts now come straight off the SQL-aggregated
  // DefectDashboardOut (loaded independently of the current queue/search/
  // status/severity/priority filters), not from `.filter().length` over
  // whatever the paginated list happens to hold.
  const queueCounts = {
    all: dashboard?.total || 0,
    attention: dashboard?.attention_count || 0,
    mine: dashboard?.mine_count || 0,
    unlinked: dashboard?.unlinked_count || 0,
    retest: dashboard?.retest_count || 0,
    closed: dashboard?.closed || 0,
  }
  const hasFilters = !!(search || status || severity || priority)
  const clearFilters = () => { setSearch(''); setStatus(''); setSeverity(''); setPriority('') }
  const ageInDays = (reportedAt: string) => Math.max(0, Math.floor((Date.now() - new Date(reportedAt).getTime()) / 86400000))
  function update(saved: DefectOut) { refreshDefects(); setSelected(saved) }

  // 2026-08 -- reported directly: "other than QA team, for others there
  // should not be any option to open any defects" -- then corrected the
  // same day: "defect can be raised by requster, business analyst
  // application owner too so defect management tool should be available
  // for them as well" -- then, further reported directly: "currently
  // Defect management is not available to everyone. make this visible to
  // everyone based on department filter." The role-based page gate that
  // used to live here is retired -- Defect Management is now open to any
  // authenticated user, scoped purely by department (same as every other
  // module's register), matching the backend's own retired
  // DEFECT_MANAGEMENT_ROLES gate on list_defects/defect_dashboard/
  // export_defects/the batch executions endpoint (routers/defects.py,
  // routers/test_execution.py).

  return <div className="tm-page defect-page">
    <header className="defect-command-header">
      <div className="defect-command-copy"><span>TEST CASE MANAGEMENT · DESIGN · ORGANIZE · EXECUTE · TRACE</span><div><h2>Defect Management</h2><b>{dashboard?.total || 0}</b></div><p>Prioritize risk, maintain execution traceability, and move every defect through a governed resolution workflow.</p></div>
      <div className="defect-command-actions"><button className="btn btn-sm" onClick={() => api.downloadFile('/api/defects/export-xlsx', 'defect-management-register.xlsx')}>Export</button><button className="btn btn-sm" disabled={!contexts.length} onClick={() => setCreateMode('standalone')}>+ New defect</button><button className="btn btn-primary btn-sm" disabled={!contexts.length} onClick={() => setCreateMode('execution')}>+ Report from execution</button></div>
    </header>
    <ErrorText error={error} title="Defect Management could not be loaded" />
    <section className="defect-health-strip">
      <div className="primary"><span>Open exposure</span><strong>{dashboard?.open || 0}</strong><small>defects require workflow action</small></div>
      <div className="danger"><span>High attention</span><strong>{queueCounts.attention}</strong><small>critical or high severity</small></div>
      <div className="warning"><span>Traceability gaps</span><strong>{queueCounts.unlinked}</strong><small>not linked to an execution</small></div>
      <div className="success"><span>Resolved / Retest</span><strong>{queueCounts.retest}</strong><small>waiting for validation</small></div>
      <div className="neutral"><span>Closed</span><strong>{dashboard?.closed || 0}</strong><small>{dashboard?.reopened || 0} reopened · {dashboard?.deferred || 0} deferred</small></div>
    </section>
    <section className="defect-workspace-card">
      <nav className="defect-queue-tabs" aria-label="Defect queues">{([['all', 'All defects'], ['attention', 'Needs attention'], ['mine', 'My work'], ['unlinked', 'Unlinked'], ['retest', 'Ready for retest'], ['closed', 'Closed']] as const).map(([key, label]) => <button key={key} className={queue === key ? 'active' : ''} onClick={() => setQueue(key)}><span>{label}</span><b>{queueCounts[key]}</b></button>)}</nav>
      <div className="defect-register-head"><div><span>DEFECT REGISTER</span><h3>{total} {total === 1 ? 'record' : 'records'} in this view</h3></div>{dashboard && <div className="defect-register-signals"><span><i className="critical" />Critical {dashboard.by_severity?.Critical || 0}</span><span><i className="high" />High {dashboard.by_severity?.High || 0}</span></div>}</div>
      <div className="defect-toolbar"><label className="defect-search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ID, title, application or module…" /></label><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map((value) => <option key={value}>{value}</option>)}</select><select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">All severities</option>{SEVERITIES.map((value) => <option key={value}>{value}</option>)}</select><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">All priorities</option>{PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select>{hasFilters && <button className="btn btn-sm" onClick={clearFilters}>Clear filters</button>}</div>
      <Table<DefectListOut>
        tableId="defect-management" rowKey="id" rows={defects}
        onRowClick={(defect) => { openDefect(defect.id); setSearchParams({ open: defect.defect_key }) }}
        server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange: setPage, onPageSizeChange: setPageSize, loading: defectsLoading }}
        columns={[
        { key: 'title', header: 'Defect', render: (defect) => <span className="defect-title-cell"><span><button className="link-btn" onClick={(event) => { event.stopPropagation(); openDefect(defect.id) }}>{openingDefectId === defect.id ? 'Opening…' : defect.defect_key}</button><small>{defect.application_name}</small></span><strong>{defect.title}</strong><small>{defect.module_feature}</small></span> },
        { key: 'severity', header: 'Risk', render: (defect) => <span className="defect-risk-cell"><span className={`defect-severity ${defect.severity.toLowerCase()}`}>{defect.severity}</span><small>{defect.priority}</small></span> },
        { key: 'status', header: 'Workflow', render: (defect) => <span className="defect-workflow-cell"><Badge status={defect.status} /><small>{defect.assignee_name || 'Unassigned'}</small><small className="defect-workflow-department">{defect.assigned_team || 'Department not assigned'}</small></span> },
        { key: 'cycle_key', header: 'Traceability', render: (defect) => <span className={`defect-trace-cell ${!defect.execution_id ? 'incomplete' : ''}`}><strong>{defect.qa_request_key || `Request #${defect.qa_request_id}`}</strong><small>{defect.cycle_key || 'No cycle'} · {defect.test_case_key || 'No testcase'}</small></span> },
        { key: 'reported_at', header: 'Reported / Age', render: (defect) => <span className="defect-age-cell"><strong>{formatDateIST(defect.reported_at)}</strong><small>{ageInDays(defect.reported_at)}d open · {defect.reporter_name}</small></span> },
      ]} />
      {!defects.length && <div className="tm-empty"><strong>{dashboard?.total ? 'No defects match this view' : 'No governed defects yet'}</strong><span>{dashboard?.total ? 'Change the queue or clear filters to see more records.' : 'Open a defect now, or report one directly from a Failed/Blocked execution.'}</span></div>}
    </section>
    {createMode && <CreateDefectModal standalone={createMode === 'standalone'} contexts={contexts} requests={requests} initialExecutionId={initialExecutionId} onClose={() => { setCreateMode(''); setSearchParams({}) }} onCreated={(created) => { refreshDefects(); setCreateMode(''); setSelected(created); setSearchParams({ open: created.defect_key }) }} />}
    {selected && <DefectDetail defect={selected} users={users} departments={departments} requestDepartment={requests.find((request) => request.id === selected.qa_request_id)?.department} defects={duplicateCandidates} contexts={contexts} access={selectedAccess} onClose={() => {
      // 2026-08 -- reported directly: closing a defect opened via a
      // cross-module deep link (e.g. Test Execution's "Cycle Defects"
      // panel, see LinkedDefects.tsx's `returnTo`) used to just clear the
      // `open` param and leave the user sitting on the Defects register,
      // instead of going back to the page they actually came from.
      const returnTo = searchParams.get('return')
      if (returnTo) { navigate(returnTo); return }
      setSelected(null); setSearchParams({})
    }} onChanged={update} />}
  </div>
}
