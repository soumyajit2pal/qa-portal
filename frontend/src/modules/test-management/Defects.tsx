import DefectWorkflowDiagram from '../../components/DefectWorkflowDiagram'
import LinkDefectRequest from '../../components/LinkDefectRequest'
import DefectWorkflowPanel from '../../components/DefectWorkflowPanel'
import { useRequestNavigation } from '../../hooks/useRequestNavigation'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {useSearchParams} from 'react-router-dom'
import { api } from '../../api'
import { useDefectSubmissionConfirmation } from '../../defectSubmission'
import { formatDateIST } from '../../time'
import { Badge, Card, ErrorText, Field, Modal, Table } from '../../components/Common'
import JiraActivity, { AuthenticatedMarkdown } from '../../components/JiraActivity'
import JiraRichTextField from '../../components/JiraRichTextField'
import SearchableSelect from '../../components/SearchableSelect'
import UserAssignSelect from '../../components/UserAssignSelect'
import {
  ApplicationMasterOut, ApprovalActionOut, DefectDashboardOut, DefectLinkableExecutionOut, DefectListOut, DefectOut, DepartmentOut,
  PageOut, QARequestListOut, QARequestOut, QAWorkspaceOut, RequestDocumentOut, UserOut,
} from '../../types'
import { useAuth } from '../../context/AuthContext'
import { ENVIRONMENTS, DEFECT_REASSIGNABLE_STATUSES, QA_REQUEST_CREATOR_ROLES, hasWorkflowRole as hasRole, hasDepartment, hasWorkspaceMembership, hasWorkspaceRole, canReassign, userDepartments, isSelectableUser, isViewOnly } from '../../constants'
import { usePaginatedList } from '../../hooks/usePaginatedList'

const STATUSES = ['Ready for QA', 'QA Testing', 'Business Acceptance', 'Ready for Release', 'Production Verification', 'New', 'Triaged', 'In Progress', 'Resolved', 'Retest', 'Reopened', 'Deferred', 'Rejected', 'Duplicate', 'Not a Defect', 'Closed']
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low']
const PRIORITIES = ['P1 – Immediate', 'P2 – High', 'P3 – Medium', 'P4 – Low']
const RESOLUTION_TYPES = ['Fixed', 'Configuration Changed', 'Data Corrected', 'Code Change', 'Environment Issue Resolved', 'Cannot Reproduce', 'Working as Designed', 'Other']
// 2026-08 -- reported directly, with a full defect lifecycle diagram: New
// now passes through an explicit "Triaged" checkpoint before any
// disposition (mirrors routers/defects.py's own TRANSITIONS -- see that
// dict's comment for the related disposition decisions). Triage captures
// ownership, so Assigned is retained only as a legacy backend state.
const TRANSITIONS: Record<string, string[]> = {
  New: ['Triaged'],
  Triaged: ['In Progress', 'Rejected', 'Duplicate', 'Not a Defect', 'Deferred'],
  Assigned: ['In Progress', 'Rejected', 'Duplicate', 'Not a Defect', 'Deferred'],
  'In Progress': ['Resolved', 'Rejected', 'Duplicate', 'Not a Defect', 'Deferred'],
  Resolved: ['Retest'], Retest: ['Closed', 'Reopened'], Reopened: ['In Progress'],
  Deferred: ['In Progress'], Closed: ['Reopened'], Rejected: ['Reopened'], Duplicate: [], 'Not a Defect': ['Reopened'],
}

function defectTransitionLabel(status: string) {
  if (status === 'Triaged') return 'Triage & assign'
  if (status === 'Resolved') return 'Resolve & assign retest'
  if (status === 'In Progress') return 'Start work'
  return status
}

function defectTransitionDescription(current: string, target: string) {
  if (target === 'Triaged') return 'Review, prioritize, and select the working owner'
  if (target === 'Resolved') return 'Record the resolution and select the QA retest owner'
  if (target === 'In Progress') return `Begin active work from ${current}`
  return `Move from ${current} to ${target}`
}

function defectTransitionGuidance(target: string) {
  if (target === 'Resolved') return {
    title: 'Resolution record and QA handoff',
    text: 'Record what was fixed, why it failed, the applied change and fixed build. Select the QA owner who will independently validate the fix.',
  }
  if (target === 'Retest') return {
    title: 'Begin validation',
    text: 'This confirms that QA has started validating the submitted fix. Add an optional note only when the retest needs context.',
  }
  if (target === 'Closed') return {
    title: 'Retest evidence and closure decision',
    text: 'Confirm the build that QA tested, record the observed result and retest notes, then add the final closure summary. These values become part of the audit record.',
  }
  if (target === 'Reopened') return {
    title: 'Reverse the previous decision',
    text: 'Explain why the defect must return to active work and attach evidence supporting the failed retest or the reconsidered decision.',
  }
  return null
}

// 2026-08 -- was a locally-defined interface; now just an alias for the
// batch endpoint's own response shape (types.ts's DefectLinkableExecutionOut,
// mirroring backend schemas.py) so every existing `ExecutionContext` usage
// below needs no further changes.
type ExecutionContext = DefectLinkableExecutionOut

type DefectTraceRow = {
  trace_key: string
  execution_id: number
  cycle_id?: number | null
  cycle_key?: string | null
  project_id?: number | null
  test_case_key?: string | null
  status?: string | null
  relationship: 'Primary' | 'Additional'
}

function defectTraceRows(defect: DefectOut): DefectTraceRow[] {
  const rows: DefectTraceRow[] = []
  if (defect.execution_id) {
    rows.push({
      trace_key: `primary-${defect.execution_id}`,
      execution_id: defect.execution_id,
      cycle_id: defect.cycle_id,
      cycle_key: defect.cycle_key,
      project_id: defect.project_id,
      test_case_key: defect.test_case_key,
      status: defect.execution_status,
      relationship: 'Primary',
    })
  }
  defect.execution_links.forEach((link) => rows.push({
    trace_key: `additional-${link.id}`,
    execution_id: link.execution_id,
    cycle_id: link.cycle_id,
    cycle_key: link.cycle_key,
    project_id: link.project_id,
    test_case_key: link.test_case_key,
    status: link.status,
    relationship: 'Additional',
  }))
  return rows
}

function LinkedTestExecutionsModal({ defect, onClose, onOpen }: {
  defect: DefectOut
  onClose: () => void
  onOpen: (row: DefectTraceRow) => void
}) {
  const [search, setSearch] = useState('')
  const rows = defectTraceRows(defect)
  const query = search.trim().toLowerCase()
  const filtered = query ? rows.filter((row) => [
    row.test_case_key,
    row.cycle_key,
    row.status,
    row.relationship,
    String(row.execution_id),
  ].some((value) => String(value || '').toLowerCase().includes(query))) : rows

  return <Modal title={`Linked test executions · ${defect.defect_key}`} onClose={onClose} variant="dialog" wide>
    <div className="defect-linked-directory-head">
      <div><strong>{rows.length} linked execution{rows.length === 1 ? '' : 's'}</strong><span>Search and open any testcase trace without expanding the defect page.</span></div>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search testcase, cycle, result…" aria-label="Search linked test executions" autoFocus />
    </div>
    <Table<DefectTraceRow>
      rows={filtered}
      rowKey="trace_key"
      pageSize={10}
      tableId="defect-linked-test-executions"
      resetKey={search}
      showColumnControls={false}
      onRowClick={onOpen}
      columns={[
        { key: 'test_case', header: 'Test case', render: (row) => <div className="defect-linked-testcase"><strong>{row.test_case_key || `Execution #${row.execution_id}`}</strong><small>Execution #{row.execution_id}</small></div>, filterValue: (row) => row.test_case_key || String(row.execution_id) },
        { key: 'cycle', header: 'Test cycle', render: (row) => row.cycle_key || '—', filterValue: (row) => row.cycle_key || 'Unspecified' },
        { key: 'result', header: 'Result', render: (row) => row.status ? <Badge status={row.status} /> : <span className="muted">—</span>, filterValue: (row) => row.status || 'Not recorded' },
        { key: 'relationship', header: 'Trace type', render: (row) => <span className={`defect-trace-type ${row.relationship.toLowerCase()}`}>{row.relationship}</span>, filterValue: (row) => row.relationship },
        { key: 'action', header: '', filterable: false, render: (row) => <button type="button" className="btn btn-sm" onClick={(event) => { event.stopPropagation(); onOpen(row) }}>Open</button> },
      ]}
    />
  </Modal>
}

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
  const { confirmDefectSubmission, confirmationModal } = useDefectSubmissionConfirmation()
  const { user } = useAuth()
  const [workflowWorkspaces, setWorkflowWorkspaces] = useState<QAWorkspaceOut[]>([])
  const [workflowLoading, setWorkflowLoading] = useState(true)
  const [workflowError, setWorkflowError] = useState(false)
  const [workflowReload, setWorkflowReload] = useState(0)
  useEffect(() => {
    let active = true
    setWorkflowLoading(true); setWorkflowError(false)
    api.get<QAWorkspaceOut[]>('/api/workspaces').then(rows => { if (active) setWorkflowWorkspaces(rows) })
      .catch(() => { if (active) setWorkflowError(true) })
      .finally(() => { if (active) setWorkflowLoading(false) })
    return () => { active = false }
  }, [workflowReload])
  const [availableDepartments, setAvailableDepartments] = useState<DepartmentOut[]>([])
  useEffect(() => { api.get<DepartmentOut[]>('/api/departments').then(setAvailableDepartments).catch(() => setAvailableDepartments([])) }, [])
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
  const [applicationName, setApplicationName] = useState(initial?.project.application_name || '')
  const [otherApplication, setOtherApplication] = useState(false)
  const [applicationOptions, setApplicationOptions] = useState<ApplicationMasterOut[]>([])
  const [applicationsLoading, setApplicationsLoading] = useState(true)
  const [applicationsError, setApplicationsError] = useState(false)
  const [applicationsReload, setApplicationsReload] = useState(0)
  useEffect(() => {
    let active = true
    setApplicationsLoading(true); setApplicationsError(false)
    api.get<ApplicationMasterOut[]>('/api/application-names')
      .then(rows => { if (active) setApplicationOptions(rows) })
      .catch(() => { if (active) setApplicationsError(true) })
      .finally(() => { if (active) setApplicationsLoading(false) })
    return () => { active = false }
  }, [applicationsReload])
  const [department, setDepartment] = useState(initial?.project.department || user?.department || '')
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
    setApplicationName(selected.project.application_name || '')
    setOtherApplication(false)
    setDepartment(selected.project.department || user?.department || '')
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
    if (!standalone && !selected) { setError(new Error('Select a failed/blocked execution')); return }
    if (!requestId && !selected?.project.application_name && !applicationName.trim()) { setError(new Error('Select an application or choose Other and enter its name')); return }
    if (!description.trim()) { setError(new Error('Description is required')); return }
    if (!steps.trim() || !actual.trim() || !expected.trim()) { setError(new Error('Steps to Reproduce, Actual Result, and Expected Result are required')); return }
    if (!(await confirmDefectSubmission('details'))) return
    setBusy(true); setError(null)
    try {
      const created = await api.post<DefectOut>('/api/defects', {
        title, description, qa_request_id: requestId ? Number(requestId) : null,
        application_name: applicationName.trim() || null, department: department || null,
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

  const workflowWorkspaceId = requests.find(request => String(request.id) === requestId)?.qa_workspace_id
    || selected?.cycle.origin_workspace_id
    || selected?.project.qa_workspace_id
    || Number(localStorage.getItem('active_workspace_id') || localStorage.getItem('qa_active_workspace_id'))
    || user?.active_workspace_id || user?.preferred_workspace_id || user?.preferred_qa_workspace_id
  const workflowWorkspace = workflowWorkspaces.find(workspace => workspace.id === workflowWorkspaceId)

  return <Modal title={standalone ? 'Open Defect' : 'Report Defect from Execution'} onClose={onClose} wide>
    <form onSubmit={submit} className="defect-form">
      {confirmationModal}
      <details className="defect-flow-disclosure">
        <summary>View defect workflow</summary>
        {workflowLoading ? <p role="status">Loading workspace workflow…</p> : workflowError || !workflowWorkspace?.defect_workflow
          ? <p role="status">Workflow preview is unavailable. The workspace policy will still be applied when the defect is created. <button type="button" className="btn btn-sm" onClick={() => setWorkflowReload(value => value + 1)}>Retry preview</button></p>
          : <DefectWorkflowDiagram policy={workflowWorkspace.defect_workflow} workspaceName={workflowWorkspace.name} productionAffected={environment === 'Production'} />}
      </details>
      <div className="defect-trace-banner"><strong>{standalone ? 'Open now, link later' : 'Execution traceability'}</strong><span>{standalone ? 'The defect belongs to your active workspace. Link a QA request now or later if needed.' : 'The defect follows the execution workspace workflow. The QA request link is optional.'}</span></div>
      {!standalone && <Field label="Failed / Blocked Test Execution *"><SearchableSelect value={executionId} onChange={setExecutionId} placeholder="Select execution…" options={contexts.map((row) => ({ value: String(row.execution.id), label: `${row.cycle.cycle_key} · ${row.execution.test_case?.test_case_key || row.execution.test_case_id} · ${row.execution.status}` }))} /></Field>}
      <div className="grid grid-2">
        <Field label="QA Request (optional)">
          <SearchableSelect disabled={!!createdDefect} value={requestId} onChange={setRequestId} placeholder="No QA request linked" options={linkedRequest && !standalone ? requestOptions.filter(option => option.value === String(linkedRequest.id)) : requestOptions} />
          {requestId && <button type="button" className="btn btn-sm" disabled={!!createdDefect} onClick={() => setRequestId('')}>Remove optional link</button>}
        </Field>
        <Field label="Application *">
          {requestId || selected?.project.application_name
            ? <input readOnly value={requests.find(request => String(request.id) === requestId)?.application_name || selected?.project.application_name || ''} />
            : <>
              <SearchableSelect ariaLabel="Application" disabled={!!createdDefect} value={otherApplication ? '__other_application__' : applicationName}
                placeholder={applicationsLoading ? 'Loading applications…' : 'Select application…'}
                options={[...applicationOptions.map(app => ({ value: app.name, label: app.name })), { value: '__other_application__', label: 'Other (enter application name)' }]}
                onChange={value => { setOtherApplication(value === '__other_application__'); setApplicationName(value === '__other_application__' ? '' : value) }} />
              {otherApplication && <input aria-label="Other application name" required maxLength={150} disabled={!!createdDefect} value={applicationName} placeholder="Enter application name" onChange={e => setApplicationName(e.target.value)} style={{ marginTop: 8 }} />}
              {applicationsError && <p className="muted small" role="status">Application list could not be loaded. <button type="button" className="btn btn-sm" disabled={!!createdDefect || applicationsLoading} onClick={() => setApplicationsReload(value => value + 1)}>Retry</button></p>}
            </>}
        </Field>
        {!requestId && <Field label="Department *"><select required disabled={!!createdDefect || !!selected?.project.department} value={selected?.project.department || department} onChange={e => setDepartment(e.target.value)}><option value="">Select department</option>{availableDepartments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}</select></Field>}
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

function TransitionModal({ defect, target, users, departments, requestDepartment, defects, hasEvidence, onEvidenceAttached, onClose, onChanged }: {
  defect: DefectOut; target: string; users: UserOut[]; departments: DepartmentOut[]; requestDepartment?: string | null; defects: DefectListOut[]
  hasEvidence: boolean
  onEvidenceAttached: (documents: RequestDocumentOut[]) => void
  onClose: () => void; onChanged: (defect: DefectOut) => void
}) {
  const { confirmDefectSubmission, confirmationModal } = useDefectSubmissionConfirmation()

  const autoDepartment = defect.project_department || requestDepartment || ''
  const retestUsers = users.filter((user) => isSelectableUser(user) && hasRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA'))
  const suggestedRetestOwner = defect.retest_tester_id || defect.execution_assignee_id || defect.reporter_id
  const [values, setValues] = useState<Record<string, any>>(
    target === 'Triaged'
      ? { assigned_team: autoDepartment || defect.assigned_team || '' }
      : target === 'Resolved'
        ? { retest_tester_id: retestUsers.some((user) => user.id === suggestedRetestOwner) ? suggestedRetestOwner : null }
        : {},
  )

  const [imageValues, setImageValues] = useState<Record<string, File[]>>({})
  const setImages = (key: string) => (files: File[]) => setImageValues((current) => ({ ...current, [key]: files }))
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([])
  const [evidenceUploaded, setEvidenceUploaded] = useState(false)
  const addEvidenceFiles = (files: FileList | null) => {
    if (!files?.length) return
    setEvidenceFiles((current) => [...current, ...Array.from(files)])
  }
  const removeEvidenceFile = (index: number) => {
    setEvidenceFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))
  }

  const [savedDefect, setSavedDefect] = useState<DefectOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const set = (key: string, value: any) => setValues((current) => ({ ...current, [key]: value }))

  const departmentUsers = values.assigned_team
    ? users.filter((user) => isSelectableUser(user) && hasDepartment(user, values.assigned_team))
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
    const files = [...Object.values(imageValues).flat(), ...evidenceFiles]
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
    const stagedFiles = [...Object.values(imageValues).flat(), ...evidenceFiles]
    if (['Rejected', 'Reopened'].includes(target) && !hasEvidence && !evidenceUploaded && !stagedFiles.length) {
      setError(new Error(`Supporting evidence is required before ${target === 'Rejected' ? 'rejecting' : 'reopening'} a defect`))
      return
    }
    if (!(await confirmDefectSubmission())) return
    setBusy(true); setError(null)
    try {
      // Rejection/reopening evidence is a server-side precondition, so
      // upload staged screenshots and explicitly selected files before
      // requesting the transition. Clear them after upload so retrying a
      // failed transition cannot create duplicate attachments.
      if (['Rejected', 'Reopened'].includes(target) && stagedFiles.length && !evidenceUploaded) {
        const attached = await api.uploadFormFiles<RequestDocumentOut[]>(`/api/defects/${defect.id}/attachments`, {}, stagedFiles)
        onEvidenceAttached(attached)
        setEvidenceUploaded(true)
        setImageValues({})
        setEvidenceFiles([])
      }
      const saved = await api.post<DefectOut>(`/api/defects/${defect.id}/transition`, { status: target, ...values })
      if (['Rejected', 'Reopened'].includes(target)) { onChanged(saved); return }
      setSavedDefect(saved)
      await attachStagedEvidence(saved)
    } catch (err) { setError(err); setBusy(false) }
  }
  return <Modal title={`${defectTransitionLabel(target)} · ${defect.defect_key}`} onClose={onClose} variant="dialog" preventBackdropClose wide>
    <form onSubmit={submit}>
      {confirmationModal}
      <div className="defect-transition-summary"><Badge status={defect.status} /><span>→</span><Badge status={target} /></div>
      {defectTransitionGuidance(target) && <div className="defect-transition-guidance"><strong>{defectTransitionGuidance(target)?.title}</strong><span>{defectTransitionGuidance(target)?.text}</span></div>}
      <fieldset disabled={!!savedDefect} className="defect-transition-fieldset">
      {target === 'Triaged' && <>{defect.assignee_name && <p className="defect-assignment-current">Currently assigned to <strong>{defect.assignee_name}</strong>{defect.assigned_team ? ` (${defect.assigned_team})` : ''}.</p>}<Field label="Responsible Department *"><SearchableSelect value={values.assigned_team || ''} onChange={(value) => { set('assigned_team', value); set('assignee_id', null) }} placeholder="Select department…" options={departments.map((department) => ({ value: department.name, label: department.name }))} /></Field><Field label="Working Owner *"><UserAssignSelect value={values.assignee_id ? String(values.assignee_id) : ''} onChange={(value) => set('assignee_id', value ? Number(value) : null)} users={departmentUsers} placeholder={values.assigned_team ? 'Select responsible user…' : 'Select a department first…'} disabled={!values.assigned_team} showRoles /></Field>{autoDepartment && <p className="defect-assignment-default">Defaulted from {defect.project_department ? 'the linked Failed / Blocked Test Execution\'s project' : 'the linked QA Request'}: <strong>{autoDepartment}</strong></p>}<Field label="Triage Remarks"><JiraRichTextField value={values.remarks || ''} onChange={(v) => set('remarks', v)} onImagesChange={setImages('remarks')} disabled={!!savedDefect} ariaLabel="Triage Remarks" placeholder="Optional routing note for the working owner…" /></Field></>}
      {target === 'Resolved' && <><Field label="Resolution Type *"><select required value={values.resolution_type || ''} onChange={(e) => set('resolution_type', e.target.value)}><option value="">Select…</option>{RESOLUTION_TYPES.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Resolution Summary *"><JiraRichTextField value={values.resolution_summary || ''} onChange={(v) => set('resolution_summary', v)} onImagesChange={setImages('resolution_summary')} disabled={!!savedDefect} ariaLabel="Resolution Summary" placeholder="Summarize the fix…" /></Field><Field label="Root Cause *"><JiraRichTextField value={values.root_cause || ''} onChange={(v) => set('root_cause', v)} onImagesChange={setImages('root_cause')} disabled={!!savedDefect} ariaLabel="Root Cause" placeholder="Describe the root cause…" /></Field><Field label="Fix Details *"><JiraRichTextField value={values.fix_details || ''} onChange={(v) => set('fix_details', v)} onImagesChange={setImages('fix_details')} disabled={!!savedDefect} ariaLabel="Fix Details" placeholder="Describe the fix that was applied…" /></Field><Field label="Fixed Build / Release *"><input required value={values.fixed_build_version || ''} onChange={(e) => set('fixed_build_version', e.target.value)} /></Field><Field label="QA Retest Owner *"><UserAssignSelect value={values.retest_tester_id ? String(values.retest_tester_id) : ''} onChange={(value) => set('retest_tester_id', value ? Number(value) : null)} users={retestUsers} placeholder="Select the QA user responsible for retest…" /></Field></>}
      {target === 'Closed' && <><Field label="Build validated by QA *"><input required value={values.tested_build_version || ''} onChange={(e) => set('tested_build_version', e.target.value)} placeholder="Build or release containing the fix" /></Field><Field label="Observed retest result *"><JiraRichTextField value={values.actual_result || ''} onChange={(v) => set('actual_result', v)} onImagesChange={setImages('actual_result')} disabled={!!savedDefect} ariaLabel="Observed retest result" placeholder="Describe what QA observed while validating the fix…" /></Field><Field label="Retest evidence and notes *"><JiraRichTextField value={values.retest_remarks || ''} onChange={(v) => set('retest_remarks', v)} onImagesChange={setImages('retest_remarks')} disabled={!!savedDefect} ariaLabel="Retest evidence and notes" placeholder="Record the validation steps, evidence references, or important conditions…" /></Field><Field label="Closure summary *"><JiraRichTextField value={values.closure_remarks || ''} onChange={(v) => set('closure_remarks', v)} onImagesChange={setImages('closure_remarks')} disabled={!!savedDefect} ariaLabel="Closure summary" placeholder="State why this defect can now be closed…" /></Field></>}
      {target === 'Reopened' && <Field label="Reason for reopening *"><JiraRichTextField value={values.reopen_reason || ''} onChange={(v) => set('reopen_reason', v)} onImagesChange={setImages('reopen_reason')} disabled={!!savedDefect} ariaLabel="Reason for reopening" placeholder="Explain what failed during retest, or what new evidence changes the earlier decision." /></Field>}
      {target === 'Deferred' && <><Field label="Deferral Reason *"><JiraRichTextField value={values.deferral_reason || ''} onChange={(v) => set('deferral_reason', v)} onImagesChange={setImages('deferral_reason')} disabled={!!savedDefect} ariaLabel="Deferral Reason" /></Field><div className="grid grid-2"><Field label="Approved By *"><input required value={values.deferral_approved_by || ''} onChange={(e) => set('deferral_approved_by', e.target.value)} /></Field><Field label="Target Release *"><input required value={values.target_release || ''} onChange={(e) => set('target_release', e.target.value)} /></Field></div><Field label="Expected Resolution Date *"><input required type="date" value={values.expected_resolution_date || ''} onChange={(e) => set('expected_resolution_date', e.target.value)} /></Field></>}
      {target === 'Rejected' && <Field label="Rejection Reason *"><JiraRichTextField value={values.rejection_reason || ''} onChange={(v) => set('rejection_reason', v)} onImagesChange={setImages('rejection_reason')} disabled={!!savedDefect} ariaLabel="Rejection Reason" placeholder="Give a valid rejection reason and paste or upload supporting evidence." /></Field>}
      {target === 'Duplicate' && <Field label="Original Defect ID *"><SearchableSelect value={values.duplicate_defect_id ? String(values.duplicate_defect_id) : ''} onChange={(value) => set('duplicate_defect_id', value ? Number(value) : null)} placeholder="Select canonical defect…" options={defects.filter((item) => item.id !== defect.id && item.status !== 'Duplicate').map((item) => ({ value: String(item.id), label: `${item.defect_key} · ${item.title}` }))} /></Field>}
      {target === 'Not a Defect' && <Field label="Discussion & Requirements Confirmation *"><JiraRichTextField value={values.not_a_defect_reason || ''} onChange={(v) => set('not_a_defect_reason', v)} onImagesChange={setImages('not_a_defect_reason')} disabled={!!savedDefect} ariaLabel="Discussion and Requirements Confirmation" placeholder="Record the discussion with the Developer/Dev Lead and confirmation against requirements…" /></Field>}
      {!['Triaged', 'Assigned', 'Resolved', 'Closed', 'Reopened', 'Deferred', 'Rejected', 'Duplicate', 'Not a Defect'].includes(target) && <Field label="Remarks"><JiraRichTextField value={values.remarks || ''} onChange={(v) => set('remarks', v)} onImagesChange={setImages('remarks')} disabled={!!savedDefect} ariaLabel="Remarks" /></Field>}
      {['Rejected', 'Reopened'].includes(target) && <div className="defect-form-section defect-evidence">
        <div>
          <h4>Supporting Evidence <span>{Object.values(imageValues).flat().length + evidenceFiles.length}</span></h4>
          <label className="btn btn-sm">+ Attach evidence<input type="file" multiple hidden disabled={busy || !!savedDefect} onChange={(event) => { addEvidenceFiles(event.target.files); event.target.value = '' }} /></label>
        </div>
        {evidenceFiles.length > 0 && <div className="defect-files">{evidenceFiles.map((file, index) => <button type="button" key={`${file.name}-${file.size}-${index}`} disabled={busy || !!savedDefect} onClick={() => removeEvidenceFile(index)}>{file.name} ✕</button>)}</div>}
        <p className="muted small">{hasEvidence || evidenceUploaded ? 'Existing evidence is already attached. You may add new files for this decision.' : 'Attach at least one file, or paste/upload an image in the reason field above.'}</p>
      </div>}
      </fieldset>
      <ErrorText error={error} title={savedDefect ? `${savedDefect.defect_key} was updated` : 'Defect workflow action failed'} />
      <div className="modal-actions">
        {savedDefect
          ? <><button className="btn btn-primary" disabled={busy}>{busy ? 'Attaching…' : 'Retry attaching evidence'}</button><button type="button" className="btn" disabled={busy} onClick={() => onChanged(savedDefect)}>Continue without evidence</button></>
          : <><button className={`btn ${['Rejected', 'Duplicate', 'Not a Defect'].includes(target) ? 'btn-danger' : 'btn-primary'}`} disabled={busy || (target === 'Triaged' && (!values.assignee_id || !values.assigned_team)) || (target === 'Resolved' && !values.retest_tester_id)}>{busy ? 'Updating…' : defectTransitionLabel(target)}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></>}
      </div>
    </form>
  </Modal>
}

// Reassignment is an ownership action. It changes the responsible user
// without changing the lifecycle state and requires an audit reason.
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
  const eligibleDepartments = Array.from(new Set(
    teammateDepartments.length ? teammateDepartments : (defect.assigned_team ? [defect.assigned_team] : []),
  ))
  const eligibleUsers = users.filter((candidate) => isSelectableUser(candidate) && candidate.id !== defect.assignee_id
    && (!defect.qa_workspace_id || hasWorkspaceMembership(candidate, defect.qa_workspace_id))
    && (!candidate.roles.includes('ADMIN') || hasDepartment(candidate, defect.department))
    && (hasRole(candidate, 'QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'CHIEF_MANAGER_QA', 'AGM_QA')
      || userDepartments(candidate).some((department) => eligibleDepartments.includes(department))))

  function selectAssignee(value: string) {
    const selectedUser = users.find((candidate) => String(candidate.id) === value)
    setAssigneeId(value ? Number(value) : '')
    if (!selectedUser) { setAssignedTeam(''); return }
    const selectedDepartments = userDepartments(selectedUser)
    const destination = eligibleDepartments.find((department) => selectedDepartments.includes(department))
      || selectedDepartments[0] || ''
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
          {eligibleDepartments.map((department) => <span key={department}>{department}</span>)}
          <span className="qa">QA members in this workspace</span>
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
  const linkedExecutionIds = new Set([
    ...(defect.execution_id ? [defect.execution_id] : []),
    ...defect.execution_links.map((link) => link.execution_id),
  ])
  const eligibleContexts = contexts.filter((row) => !linkedExecutionIds.has(row.execution.id))
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!executionId) return
    setBusy(true); setError(null)
    try { onChanged(await api.post<DefectOut>(`/api/defects/${defect.id}/link-execution`, { execution_id: Number(executionId) })) }
    catch (err) { setError(err); setBusy(false) }
  }
  return <Modal title={`Link ${defect.defect_key} to execution`} onClose={onClose} variant="dialog" preventBackdropClose wide>
    <form onSubmit={submit}>
      <div className="defect-trace-banner"><strong>Link another affected testcase</strong><span>The selected Failed or Blocked execution is added to this defect's traceability. Existing testcase and execution links remain unchanged.</span></div>
      <Field label="Test Cycle / Test Case / Execution *"><SearchableSelect value={executionId} onChange={setExecutionId} placeholder="Select Failed or Blocked execution…" options={eligibleContexts.map((row) => ({ value: String(row.execution.id), label: `${row.cycle.cycle_key} · ${row.execution.test_case?.test_case_key || row.execution.test_case_id} · ${row.execution.status}` }))} /></Field>
      {!eligibleContexts.length && <p className="muted small">This defect is already linked to every eligible Failed or Blocked execution currently available.</p>}
      <ErrorText error={error} title="Defect could not be linked" />
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !executionId}>{busy ? 'Linking…' : 'Link Defect'}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}

// Backend (defects.py::update_defect) only allows editing a defect while it
// is still in "New" status, and only for the reporter or a manager (Admin/
// QA Lead/Chief Manager QA/AGM QA) -- once it's
// Triaged or further along, the workflow actions (TransitionModal above)
// are the only way to add information, matching the audit-trail-driven
// design of the rest of this module. Severity/Priority are further
// restricted to managers only, same as the backend's own check.
function EditDefectModal({ defect, manager, onClose, onChanged }: {
  defect: DefectOut; manager: boolean; onClose: () => void; onChanged: (defect: DefectOut) => void
}) {
  const { confirmDefectSubmission, confirmationModal } = useDefectSubmissionConfirmation()
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
    if (!(await confirmDefectSubmission('details'))) return
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
      {confirmationModal}
      <div className="defect-trace-banner"><strong>Editable while New</strong><span>Once this defect is Assigned or moves further through the workflow, use workflow actions instead -- every later change is captured there with its own audit trail.</span></div>
      <Field label="Defect Title *"><input required disabled={!!savedDefect} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Description *"><JiraRichTextField value={description} onChange={setDescription} onImagesChange={setDescriptionImages} disabled={!!savedDefect} ariaLabel="Description" placeholder="Describe the defect…" /></Field>
      <div className="grid grid-2">
        <Field label="Module / Feature *"><input required disabled={!!savedDefect} value={moduleFeature} onChange={(e) => setModuleFeature(e.target.value)} /></Field>
        <Field label="Environment *"><select required disabled={!!savedDefect || !!defect.workflow} value={environment} onChange={(e) => setEnvironment(e.target.value)}>{ENVIRONMENTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
        <Field label={`Severity ${manager ? '*' : ''}`}>{manager ? <select disabled={!!savedDefect} value={severity} onChange={(e) => setSeverity(e.target.value)}>{SEVERITIES.map((value) => <option key={value}>{value}</option>)}</select> : <input readOnly value={severity} />}</Field>
        <Field label={`Priority ${manager ? '*' : ''}`}>{manager ? <select disabled={!!savedDefect} value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select> : <input readOnly value={priority} />}</Field>
      </div>
      {!manager && <p className="muted small">Only the QA Lead group or an Administrator can change Severity or Priority.</p>}
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

function DefectDetail({ defect, users, departments, requestDepartment, defects, contexts, closeBeforeNavigate = false, onClose, onChanged }: {
  defect: DefectOut; users: UserOut[]; departments: DepartmentOut[]; requestDepartment?: string | null; defects: DefectListOut[]; contexts: ExecutionContext[]; closeBeforeNavigate?: boolean; onClose: () => void; onChanged: (defect: DefectOut) => void
}) {
  const navigate = useRequestNavigation()
  const { user } = useAuth()
  const [transition, setTransition] = useState('')
  const [showReassign, setShowReassign] = useState(false)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [showLinkExecution, setShowLinkExecution] = useState(false)
  const [showLinkedExecutions, setShowLinkedExecutions] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=DEFECT&entity_id=${defect.id}`).then(setActivity).catch(() => setActivity([]))
    api.get<RequestDocumentOut[]>(`/api/defects/${defect.id}/attachments`).then(setDocuments).catch(() => setDocuments([]))
  }, [defect.id, defect.updated_at])
  useEffect(() => {
    if (!actionsOpen) return
    function closeActions(event: MouseEvent) {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false)
    }
    function closeActionsOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setActionsOpen(false)
    }
    document.addEventListener('mousedown', closeActions)
    document.addEventListener('keydown', closeActionsOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeActions)
      document.removeEventListener('keydown', closeActionsOnEscape)
    }
  }, [actionsOpen])
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
  const viewOnly = isViewOnly(user)
  const manager = roles.some((role) => ['ADMIN', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA'].includes(role))
  const canAssign = manager || roles.includes('QA_ENGINEER')
  const applicationOwner = roles.includes('APPLICATION_OWNER')
  const assignee = !viewOnly && defect.assignee_id === user?.id
  const tester = !viewOnly && (
    defect.retest_tester_id === user?.id
    || defect.execution_assignee_id === user?.id
    || defect.reporter_id === user?.id
  )
  // 2026-08 Reassignment Requirement -- "Assigned" (above) is only reachable
  // from New/Reopened/Deferred, so this is the only way to change the
  // assignee once work is already under way. Eligible to the current
  // assignee, the Department Head of the CURRENT ASSIGNEE's own department
  // (looked up from `users`, since a defect's assigned_team can be routed to
  // any active department, not just QA), or Admin.
  const currentAssigneeUser = users.find((u) => u.id === defect.assignee_id)
  const qaUser = !roles.includes('ADMIN') && roles.some((role) =>
    ['QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA'].includes(role))
  const qaDispositionBlocked = defect.assignee_is_requester && qaUser
  const canReassignDefect = !viewOnly && !!defect.assignee_id
    && DEFECT_REASSIGNABLE_STATUSES.includes(defect.status)
    && canReassign(user, defect.assignee_id, currentAssigneeUser?.departments && currentAssigneeUser.departments.length
      ? currentAssigneeUser.departments : currentAssigneeUser?.department)
  const assigneeOrDepartmentHead = !!defect.assignee_id
    && canReassign(user, defect.assignee_id, currentAssigneeUser?.departments && currentAssigneeUser.departments.length
      ? currentAssigneeUser.departments : (currentAssigneeUser?.department || defect.assigned_team))
  const canTouchDefect = !viewOnly && (manager || defect.reporter_id === user?.id || assignee || assigneeOrDepartmentHead || tester)
  const linkedExecutionIds = new Set([
    ...(defect.execution_id ? [defect.execution_id] : []),
    ...defect.execution_links.map((link) => link.execution_id),
  ])
  const hasUnlinkedExecution = contexts.some((row) => !linkedExecutionIds.has(row.execution.id))
  const canLinkExecution = !viewOnly && hasUnlinkedExecution
    && !['Closed', 'Rejected', 'Duplicate', 'Not a Defect'].includes(defect.status)
    && hasRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA', 'SECURITY_ANALYST', ...QA_REQUEST_CREATOR_ROLES, 'APPLICATION_OWNER')
  const allowedTransitions = (viewOnly || defect.workflow) ? [] : (TRANSITIONS[defect.status] || []).filter((target) => {
    // Same actor set already trusted to reject/duplicate a defect -- see
    // routers/defects.py's matching comment on why the Dev Department Head
    // isn't included here (no assignee exists yet at triage time).
    if (target === 'Triaged') return canAssign
    if (target === 'Assigned') return canAssign
    if (['Rejected', 'Duplicate'].includes(target)) return !qaDispositionBlocked
      && (manager || defect.reporter_id === user?.id || assigneeOrDepartmentHead)
    if (target === 'Not a Defect') return defect.assignee_is_requester
      ? !qaDispositionBlocked && assigneeOrDepartmentHead
      : manager || defect.reporter_id === user?.id
    if (target === 'Deferred') return manager || applicationOwner
    if (['In Progress', 'Resolved'].includes(target)) return manager || assignee
    if (['Retest', 'Closed'].includes(target)) return manager || tester
    // Closed and terminal decisions reopen through different ownership
    // paths. Closed is a retest outcome; Rejected and Not a Defect are
    // investigation decisions and can be reconsidered by the same scoped
    // actors who were allowed to make them.
    if (target === 'Reopened') return defect.status === 'Closed'
      ? manager || defect.reporter_id === user?.id
      : ['Rejected', 'Not a Defect'].includes(defect.status)
        ? manager || defect.reporter_id === user?.id || assigneeOrDepartmentHead
        : manager || tester
    return false
  })
  const lifecycle = defect.workflow_stages?.length ? defect.workflow_stages : ['New', 'Triaged', 'In Progress', 'Resolved', 'Retest', 'Closed']
  const terminalOutcomes = ['Rejected', 'Duplicate', 'Not a Defect']
  // Assigned was removed as a lifecycle stage. Existing rows may retain that
  // value until the data migration runs, so present them at the hand-off
  // between triage and active work without restoring a seventh stage.
  const legacyAssigned = defect.status === 'Assigned'
  const lifecycleIndex = legacyAssigned ? lifecycle.indexOf('Triaged') : lifecycle.indexOf(defect.status)
  const retestOwnerName = users.find((candidate) => candidate.id === defect.retest_tester_id)?.full_name
  const hasResolutionRecord = !!(defect.resolution_summary || defect.root_cause || defect.fix_details || defect.resolution_type || defect.fixed_build_version)
  const hasRetestRecord = !!(defect.retest_actual_result || defect.retest_remarks || defect.closure_remarks || defect.retest_result || defect.tested_build_version)
  const hasWorkflowRecord = !!(defect.assignment_remarks || hasResolutionRecord || hasRetestRecord || defect.reopen_reason || defect.deferral_reason || defect.rejection_reason || defect.not_a_defect_reason)
  const canEdit = defect.status === 'New' && (manager || defect.reporter_id === user?.id)
  const showActions = !viewOnly && (canEdit || canLinkExecution || canReassignDefect || allowedTransitions.length > 0)
  const traceRows = defectTraceRows(defect)
  const traceCycleCount = new Set(traceRows.map((row) => row.cycle_id || row.cycle_key).filter(Boolean)).size
  const productionImpact = defect.workflow_state?.production_impact || (defect.environment === 'Production' ? 'Reported in Production' : 'Not assessed')
  const stageOwnerId = defect.status === 'Business Acceptance' ? defect.workflow_state?.business_owner_id
    : ['Ready for Release', 'Production Verification'].includes(defect.status) ? defect.workflow_state?.release_owner_id
    : ['Ready for QA', 'QA Testing', 'Retest'].includes(defect.status) ? defect.retest_tester_id : defect.assignee_id
  const stageOwner = users.find((candidate) => candidate.id === stageOwnerId)?.full_name
    || (stageOwnerId === defect.assignee_id ? defect.assignee_name : null)
  function runAction(action: () => void) {
    setActionsOpen(false)
    action()
  }
  function openTrace(path: string) {
    // When this detail is layered over Test Execution/Repository/QA Request,
    // dismiss it before opening another trace target. Otherwise the new
    // target modal is created underneath this modal and appears not to open.
    if (closeBeforeNavigate) onClose()
    navigate(path)
  }
  return <>
    <Modal title={`${defect.defect_key} · ${defect.title}`} onClose={onClose} wide>
      <div className="defect-detail-hero">
        <div className="defect-detail-summary"><span className="defect-detail-kicker">DEFECT OVERVIEW · {defect.application_name} · {defect.module_feature}</span><div><Badge status={defect.status} /><span className={`defect-severity ${defect.severity.toLowerCase()}`}>{defect.severity} severity</span><span className="defect-priority-pill">{defect.priority}</span>{defect.workflow_state?.blocked && <span className="badge badge-yellow">Blocked</span>}</div></div>
        {showActions && <div className="defect-actions" ref={actionsRef}>
          <button type="button" className="btn btn-primary btn-sm defect-actions-trigger" aria-haspopup="menu" aria-expanded={actionsOpen} onClick={() => setActionsOpen((open) => !open)}>
            Actions <span aria-hidden="true">⌄</span>
          </button>
          {actionsOpen && <div className="defect-actions-menu" role="menu" aria-label={`Actions for ${defect.defect_key}`}>
            {(canEdit || canLinkExecution || canReassignDefect) && <div className="defect-actions-group">
              <span>Issue actions</span>
              {canEdit && <button type="button" role="menuitem" onClick={() => runAction(() => setEditMode(true))}><strong>Edit details</strong><small>Update the defect information</small></button>}
              {canLinkExecution && <button type="button" role="menuitem" onClick={() => runAction(() => setShowLinkExecution(true))}><strong>Link another testcase</strong><small>Add another affected Failed or Blocked execution</small></button>}
              {canReassignDefect && <button type="button" role="menuitem" onClick={() => runAction(() => setShowReassign(true))}><strong>Reassign</strong><small>Change the responsible user</small></button>}
            </div>}
            {allowedTransitions.length > 0 && <div className="defect-actions-group">
              <span>Change status</span>
              {allowedTransitions.map((status) => <button key={status} type="button" role="menuitem" className={status === 'Rejected' ? 'danger' : ''} onClick={() => runAction(() => setTransition(status))}><strong>{defectTransitionLabel(status)}</strong><small>{defectTransitionDescription(defect.status, status)}</small></button>)}
            </div>}
          </div>}
        </div>}
      </div>
      <section className="defect-overview-grid" aria-label="Defect at a glance">
        <div className="defect-overview-fact"><span>Current stage</span><strong>{defect.status}</strong><small>{defect.workflow ? `Workflow version ${defect.workflow.version}` : 'Legacy defect workflow'}</small></div>
        <div className={`defect-overview-fact impact-${productionImpact.toLowerCase().replace(/\s+/g, '-')}`}><span>Production impact</span><strong>{productionImpact === 'Affected' ? 'Production affected' : productionImpact === 'Unaffected' ? 'Production unaffected' : productionImpact}</strong><small>{productionImpact === 'Affected' ? 'Production verification required' : productionImpact === 'Unaffected' ? 'Issue limited to test environments' : 'Review the observation and assessment'}</small></div>
        <div className="defect-overview-fact"><span>Responsible now</span><strong>{stageOwner || 'Not assigned yet'}</strong><small>{defect.assigned_team || 'Department not assigned'}</small></div>
        <div className={`defect-overview-fact ${traceRows.length ? 'trace-linked' : 'trace-missing'}`}><span>Execution trace</span><strong>{traceRows.length ? `${traceRows.length} linked testcase${traceRows.length === 1 ? '' : 's'}` : 'No execution linked'}</strong><small>{traceRows.length ? `Across ${traceCycleCount || 1} test cycle${traceCycleCount === 1 ? '' : 's'}` : 'Link a failed or blocked execution to complete traceability'}</small></div>
      </section>
      {!defect.qa_request_id && !viewOnly && (manager || assignee || defect.reporter_id === user?.id) && !['Closed', 'Duplicate', 'Rejected', 'Not a Defect'].includes(defect.status) && <LinkDefectRequest defect={defect} onChanged={onChanged} />}
      {defect.workflow && <DefectWorkflowPanel key={`${defect.id}-${defect.workflow_revision}`} defect={defect} users={users} departments={departments} onChanged={onChanged} />}
      {!defect.workflow && <div className="defect-lifecycle">
        <div className="defect-lifecycle-track" aria-label="Defect lifecycle">
          {lifecycle.map((stage, index) => <div key={stage} className={`${index === lifecycleIndex ? 'current' : ''} ${lifecycleIndex >= 0 && index < lifecycleIndex ? 'complete' : ''}`}><i>{index < lifecycleIndex ? '✓' : index + 1}</i><span>{stage}</span></div>)}
        </div>
        <div className="defect-lifecycle-outcomes" aria-label="Alternative terminal outcomes">
          {terminalOutcomes.map((status) => <div key={status} className={defect.status === status ? 'current' : ''}><i>{defect.status === status ? '✓' : '×'}</i><span>{status}</span></div>)}
        </div>
        {legacyAssigned && <div className="defect-lifecycle-legacy"><strong>Assigned</strong><span>Owner assigned · ready to start work</span></div>}
        {lifecycleIndex < 0 && !terminalOutcomes.includes(defect.status) && <div className="defect-lifecycle-exception"><strong>{defect.status}</strong><span>Exception workflow state</span></div>}
      </div>}
      <section className="defect-linked-work" aria-label="Linked work">
        <div className="defect-linked-work-head"><div><span className="defect-section-label">TRACEABILITY</span><h4>Linked work</h4></div><small>Open a linked record to follow the defect back to its source.</small></div>
        <div className="defect-trace-grid">
          <div><span>QA request</span>{defect.qa_request_id ? <button type="button" onClick={() => openTrace(`/qa-requests?open=${defect.qa_request_id}`)}>{defect.qa_request_key || `Request #${defect.qa_request_id}`} ↗</button> : <strong>Not linked <small>Optional</small></strong>}</div>
          <div><span>Test cycle</span>{defect.cycle_id && defect.project_id ? <button type="button" onClick={() => openTrace(`/test-execution?project=${defect.project_id}&cycle=${defect.cycle_id}`)}>{defect.cycle_key || `Cycle #${defect.cycle_id}`} ↗</button> : <strong>Not linked</strong>}</div>
          <div><span>Test case</span>{defect.test_case_key ? <button type="button" onClick={() => openTrace(`/test-repository?${defect.project_id ? `project=${defect.project_id}&` : ''}open=${encodeURIComponent(defect.test_case_key!)}`)}>{defect.test_case_key} ↗</button> : <strong>Not linked</strong>}</div>
          <div><span>Test result</span>{defect.execution_id && defect.cycle_id && defect.project_id ? <button type="button" onClick={() => openTrace(`/test-execution?project=${defect.project_id}&cycle=${defect.cycle_id}&execution=${defect.execution_id}`)}>{defect.execution_status || 'Open execution'} ↗</button> : <strong>Not linked</strong>}</div>
        </div>
      </section>
      {/* Keep large trace sets bounded. The former chip row expanded once per
          additional execution and overwhelmed the detail page at realistic
          volumes. This summary remains constant-height; the complete set is
          searchable and paginated in LinkedTestExecutionsModal. */}
      {defect.execution_links.length > 0 && (
        <div className="defect-linked-summary">
          <div className="defect-linked-summary-count"><strong>{traceRows.length}</strong><span>linked<br />testcases</span></div>
          <div className="defect-linked-summary-copy">
            <strong>Test execution coverage</strong>
            <span>Across {traceCycleCount || 1} test cycle{traceCycleCount === 1 ? '' : 's'} · Primary trace and {defect.execution_links.length} additional</span>
            <small>{traceRows.slice(0, 3).map((row) => row.test_case_key || `Execution #${row.execution_id}`).join(' · ')}{traceRows.length > 3 ? ` · +${traceRows.length - 3} more` : ''}</small>
          </div>
          <button type="button" className="btn" onClick={() => setShowLinkedExecutions(true)}>View all linked testcases</button>
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
      {hasWorkflowRecord && <section className="defect-workflow-details">
        <div className="defect-workflow-heading"><div><span className="defect-section-label">Decision record</span><h4>Workflow records</h4></div><span className="defect-readonly-pill">Read-only after submission</span></div>
        <p className="defect-workflow-help">Each card shows the fields captured by that workflow action. Submitted decisions stay read-only to preserve the audit trail; later changes are recorded through the next available workflow action and Activity.</p>
        <div className="defect-workflow-records">
          {defect.assignment_remarks && <article className="defect-workflow-record"><header><div><strong>Triage and assignment</strong><span>Ownership decision</span></div><small>{defect.assigned_by_name || 'Assigned user'}{defect.assigned_at ? ` · ${formatDateIST(defect.assigned_at)}` : ''}</small></header><div className="defect-workflow-content"><strong>Assignment note</strong><AuthenticatedMarkdown value={defect.assignment_remarks} basePath={`/api/defects/${defect.id}/attachments`} /></div></article>}
          {hasResolutionRecord && <article className="defect-workflow-record"><header><div><strong>Resolution submitted</strong><span>Fix record and QA handoff</span></div><small>{defect.resolved_at ? formatDateIST(defect.resolved_at) : 'Resolution record'}</small></header><dl className="defect-workflow-facts"><dt>Resolution type</dt><dd>{defect.resolution_type || '—'}</dd><dt>Fixed build</dt><dd>{defect.fixed_build_version || '—'}</dd><dt>QA retest owner</dt><dd>{retestOwnerName || (defect.retest_tester_id ? `User #${defect.retest_tester_id}` : '—')}</dd></dl>{defect.resolution_summary && <div className="defect-workflow-content"><strong>Resolution summary</strong><AuthenticatedMarkdown value={defect.resolution_summary} basePath={`/api/defects/${defect.id}/attachments`} /></div>}{defect.root_cause && <div className="defect-workflow-content"><strong>Root cause</strong><AuthenticatedMarkdown value={defect.root_cause} basePath={`/api/defects/${defect.id}/attachments`} /></div>}{defect.fix_details && <div className="defect-workflow-content"><strong>Fix details</strong><AuthenticatedMarkdown value={defect.fix_details} basePath={`/api/defects/${defect.id}/attachments`} /></div>}</article>}
          {hasRetestRecord && <article className="defect-workflow-record"><header><div><strong>QA retest and closure</strong><span>Independent validation record</span></div><small>{defect.closed_at ? `Closed ${formatDateIST(defect.closed_at)}` : defect.retest_at ? `Retest started ${formatDateIST(defect.retest_at)}` : 'Retest record'}</small></header><dl className="defect-workflow-facts"><dt>Retest result</dt><dd>{defect.retest_result || '—'}</dd><dt>Build validated</dt><dd>{defect.tested_build_version || '—'}</dd></dl>{defect.retest_actual_result && <div className="defect-workflow-content"><strong>Observed retest result</strong><AuthenticatedMarkdown value={defect.retest_actual_result} basePath={`/api/defects/${defect.id}/attachments`} /></div>}{defect.retest_remarks && <div className="defect-workflow-content"><strong>Retest evidence and notes</strong><AuthenticatedMarkdown value={defect.retest_remarks} basePath={`/api/defects/${defect.id}/attachments`} /></div>}{defect.closure_remarks && <div className="defect-workflow-content"><strong>Closure summary</strong><AuthenticatedMarkdown value={defect.closure_remarks} basePath={`/api/defects/${defect.id}/attachments`} /></div>}</article>}
          {defect.reopen_reason && <article className="defect-workflow-record warning"><header><div><strong>Defect reopened</strong><span>Previous decision reversed</span></div><small>Reopened {defect.reopen_count} time{defect.reopen_count === 1 ? '' : 's'}</small></header><div className="defect-workflow-content"><strong>Reason for reopening</strong><AuthenticatedMarkdown value={defect.reopen_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div></article>}
          {defect.deferral_reason && <article className="defect-workflow-record"><header><div><strong>Work deferred</strong><span>Approved postponement</span></div><small>{defect.target_release ? `Target ${defect.target_release}` : 'Target release not recorded'}</small></header><dl className="defect-workflow-facts"><dt>Approved by</dt><dd>{defect.deferral_approved_by || '—'}</dd><dt>Expected resolution</dt><dd>{defect.expected_resolution_date || '—'}</dd></dl><div className="defect-workflow-content"><strong>Deferral reason</strong><AuthenticatedMarkdown value={defect.deferral_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div></article>}
          {defect.rejection_reason && <article className="defect-workflow-record warning"><header><div><strong>Defect rejected</strong><span>Disposition decision</span></div></header><div className="defect-workflow-content"><strong>Rejection reason</strong><AuthenticatedMarkdown value={defect.rejection_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div></article>}
          {defect.not_a_defect_reason && <article className="defect-workflow-record warning"><header><div><strong>Marked as Not a Defect</strong><span>Requirements decision</span></div></header><div className="defect-workflow-content"><strong>Discussion and confirmation</strong><AuthenticatedMarkdown value={defect.not_a_defect_reason} basePath={`/api/defects/${defect.id}/attachments`} /></div></article>}
        </div>
      </section>}
      <section className="defect-evidence"><div><h4>Evidence & Attachments <span>{documents.length}</span></h4>{canTouchDefect && <label className="btn btn-sm">{uploading ? 'Uploading…' : '+ Add evidence'}<input type="file" multiple hidden disabled={uploading} onChange={(e) => upload(e.target.files)} /></label>}</div>{documents.length ? <div className="defect-files">{documents.map((document) => <button key={document.id} onClick={() => download(document)}>{document.file_name}</button>)}</div> : <p className="muted small">No supporting evidence attached.</p>}<ErrorText error={error} /></section>
      <JiraActivity workflowHistory={defect.workflow ? defect.workflow_state?.history || [] : undefined} entityType="DEFECT" entityId={defect.id} items={activity} onPosted={(item) => setActivity((current) => [...current, item])} />
    </Modal>
    {transition && <TransitionModal defect={defect} target={transition} users={users} departments={departments} requestDepartment={requestDepartment} defects={defects} hasEvidence={documents.length > 0} onEvidenceAttached={(attached) => setDocuments((current) => [...current, ...attached])} onClose={() => setTransition('')} onChanged={(saved) => { setTransition(''); onChanged(saved) }} />}
    {showReassign && <ReassignDefectModal defect={defect} users={users} onClose={() => setShowReassign(false)} onChanged={(saved) => { setShowReassign(false); onChanged(saved) }} />}
    {showLinkExecution && <LinkExecutionModal defect={defect} contexts={contexts} onClose={() => setShowLinkExecution(false)} onChanged={(saved) => { setShowLinkExecution(false); onChanged(saved) }} />}
    {showLinkedExecutions && <LinkedTestExecutionsModal defect={defect} onClose={() => setShowLinkedExecutions(false)} onOpen={(row) => {
      setShowLinkedExecutions(false)
      openTrace(`/test-execution?${row.project_id ? `project=${row.project_id}&` : ''}${row.cycle_id ? `cycle=${row.cycle_id}&` : ''}execution=${row.execution_id}`)
    }} />}
    {editMode && <EditDefectModal defect={defect} manager={manager} onClose={() => setEditMode(false)} onChanged={(saved) => { setEditMode(false); onChanged(saved) }} />}
  </>
}

// Linked defect panels are shown inside QA Request, Test Repository, and Test
// Execution screens. Opening one must preserve the host workspace (including
// its selected project/cycle, filters, pagination, and scroll position), so
// this adapter loads the same governed DefectDetail used by Defect Management
// and renders it as a modal in the current page instead of routing through the
// Defect Management register first.
export function EmbeddedDefectDetail({ defectKey, onClose }: { defectKey: string; onClose: () => void }) {
  const [defect, setDefect] = useState<DefectOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [duplicateCandidates, setDuplicateCandidates] = useState<DefectListOut[]>([])
  const [contexts, setContexts] = useState<ExecutionContext[]>([])
  const [requestDepartment, setRequestDepartment] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setDefect(null)

    async function load() {
      try {
        const opened = await api.get<DefectOut>(`/api/defects/by-key/${encodeURIComponent(defectKey)}`)
        if (!active) return
        setDefect(opened)

        // These collections support the existing edit, assignment,
        // transition, duplicate, and execution-link actions. A failure in a
        // supporting lookup must not prevent the user from viewing the defect.
        const [allUsers, activeDepartments, duplicates, executionContexts, request] = await Promise.all([
          api.get<UserOut[]>('/api/auth/users').catch(() => [] as UserOut[]),
          api.get<DepartmentOut[]>('/api/departments').catch(() => [] as DepartmentOut[]),
          api.get<PageOut<DefectListOut>>('/api/defects?page_size=100').then((page) => page.items).catch(() => [] as DefectListOut[]),
          api.get<DefectLinkableExecutionOut[]>('/api/test-execution/executions/blocked-or-failed').catch(() => [] as DefectLinkableExecutionOut[]),
          opened.qa_request_id ? api.get<QARequestOut>(`/api/qa-requests/${opened.qa_request_id}`).catch(() => null) : Promise.resolve(null),
        ])
        if (!active) return
        setUsers(allUsers)
        setDepartments(activeDepartments)
        setDuplicateCandidates(duplicates)
        setContexts(executionContexts)
        setRequestDepartment(request?.department || null)
      } catch (err) {
        if (active) setError(err)
      } finally {
        if (active) setLoading(false)
      }
    }

    load()
    return () => { active = false }
  }, [defectKey, reloadKey])

  if (loading) return <Modal title={`Opening ${defectKey}`} onClose={onClose} wide>
    <div className="tm-empty"><strong>Loading defect details…</strong><span>The execution workspace will remain open behind this dialog.</span></div>
  </Modal>

  if (!defect) return <Modal title="Unable to open linked defect" onClose={onClose} wide>
    <ErrorText error={error} title={`${defectKey} could not be loaded`} />
    <div className="modal-actions"><button className="btn btn-primary" onClick={() => setReloadKey((value) => value + 1)}>Retry</button><button className="btn" onClick={onClose}>Close</button></div>
  </Modal>

  return <DefectDetail
    defect={defect}
    users={users}
    departments={departments}
    requestDepartment={requestDepartment}
    defects={duplicateCandidates}
    contexts={contexts}
    closeBeforeNavigate
    onClose={onClose}
    onChanged={setDefect}
  />
}

export default function Defects() {
  const { user } = useAuth()
  const navigate = useRequestNavigation()
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
    extra: {
      severity: severity || undefined,
      priority: priority || undefined,
      queue: queue === 'all' ? undefined : queue,
    },
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
        api.get<PageOut<QARequestListOut>>('/api/qa-requests?page_size=100').then((p) => p.items).catch(() => [] as QARequestListOut[]),
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
  const queueDescriptions = {
    all: 'Every defect visible in your workspace and department scope.',
    attention: 'Open critical and high severity defects that need priority review.',
    mine: 'Defects assigned to you or reported by you.',
    unlinked: 'Defects without a primary or additional execution link.',
    retest: 'Fixes waiting for QA, business, or production verification.',
    closed: 'Defects with a recorded closure decision.',
  }
  const hasFilters = !!(search || status || severity || priority)
  const clearFilters = () => { setSearch(''); setStatus(''); setSeverity(''); setPriority('') }
  const ageInDays = (reportedAt: string) => Math.max(0, Math.floor((Date.now() - new Date(reportedAt).getTime()) / 86400000))
  const canCreateDefect = !isViewOnly(user)
    && hasRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA', 'SECURITY_ANALYST', ...QA_REQUEST_CREATOR_ROLES, 'APPLICATION_OWNER')
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
      <div className="defect-command-actions"><button className="btn btn-sm" onClick={() => api.downloadFile('/api/defects/export-xlsx', 'defect-management-register.xlsx')}>Export</button>{canCreateDefect && <><button className="btn btn-sm" onClick={() => setCreateMode('standalone')}>+ New defect</button><button className="btn btn-primary btn-sm" disabled={!contexts.length} onClick={() => setCreateMode('execution')}>+ Report from execution</button></>}</div>
    </header>
    <ErrorText error={error} title="Defect Management could not be loaded" />
    <section className="defect-health-strip" aria-label="Defect overview">
      <div className="primary"><span>Open exposure</span><strong>{dashboard?.open || 0}</strong><small>defects require workflow action</small></div>
      <button type="button" className={`danger ${queue === 'attention' ? 'active' : ''}`} aria-pressed={queue === 'attention'} onClick={() => setQueue('attention')}><span>Needs attention</span><strong>{queueCounts.attention}</strong><small>Open critical or high severity · View queue →</small></button>
      <button type="button" className={`warning ${queue === 'unlinked' ? 'active' : ''}`} aria-pressed={queue === 'unlinked'} onClick={() => setQueue('unlinked')}><span>Execution gaps</span><strong>{queueCounts.unlinked}</strong><small>No execution linked · View queue →</small></button>
      <button type="button" className={`success ${queue === 'retest' ? 'active' : ''}`} aria-pressed={queue === 'retest'} onClick={() => setQueue('retest')}><span>Awaiting verification</span><strong>{queueCounts.retest}</strong><small>QA, business or production · View queue →</small></button>
      <button type="button" className={`neutral ${queue === 'closed' ? 'active' : ''}`} aria-pressed={queue === 'closed'} onClick={() => setQueue('closed')}><span>Closed</span><strong>{dashboard?.closed || 0}</strong><small>{dashboard?.reopened || 0} reopened · {dashboard?.deferred || 0} deferred</small></button>
    </section>
    <section className="defect-workspace-card">
      <nav className="defect-queue-tabs" aria-label="Defect queues">{([['all', 'All defects'], ['attention', 'Needs attention'], ['mine', 'My work'], ['unlinked', 'No execution link'], ['retest', 'Verification queue'], ['closed', 'Closed']] as const).map(([key, label]) => <button type="button" key={key} className={queue === key ? 'active' : ''} aria-current={queue === key ? 'page' : undefined} onClick={() => setQueue(key)}><span>{label}</span><b>{queueCounts[key]}</b></button>)}</nav>
      <div className="defect-register-head"><div><span>DEFECT REGISTER · {queue.replace('-', ' ').toUpperCase()}</span><h3>{total} {total === 1 ? 'record' : 'records'} in this view</h3><p>{queueDescriptions[queue]}</p></div>{dashboard && <div className="defect-register-signals"><span><i className="critical" />Critical {dashboard.by_severity?.Critical || 0}</span><span><i className="high" />High {dashboard.by_severity?.High || 0}</span></div>}</div>
      <div className="defect-toolbar"><label className="defect-search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ID, title, application or module…" /></label><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map((value) => <option key={value}>{value}</option>)}</select><select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">All severities</option>{SEVERITIES.map((value) => <option key={value}>{value}</option>)}</select><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">All priorities</option>{PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select>{hasFilters && <button className="btn btn-sm" onClick={clearFilters}>Clear filters</button>}</div>
      <Table<DefectListOut>
        tableId="defect-management" rowKey="id" rows={defects}
        onRowClick={(defect) => { openDefect(defect.id); setSearchParams({ open: defect.defect_key }) }}
        server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange: setPage, onPageSizeChange: setPageSize, loading: defectsLoading }}
        columns={[
        { key: 'title', header: 'Defect', render: (defect) => <span className="defect-title-cell"><span><button className="link-btn" onClick={(event) => { event.stopPropagation(); openDefect(defect.id) }}>{openingDefectId === defect.id ? 'Opening…' : defect.defect_key}</button><small>{defect.application_name}</small></span><strong>{defect.title}</strong><small>{defect.module_feature}</small></span> },
        { key: 'severity', header: 'Risk', render: (defect) => <span className="defect-risk-cell"><span className={`defect-severity ${defect.severity.toLowerCase()}`}>{defect.severity}</span><small>{defect.priority}</small></span> },
        { key: 'status', header: 'Workflow', render: (defect) => <span className="defect-workflow-cell"><Badge status={defect.status} /><small>{defect.assignee_name || 'Unassigned'}</small><small className="defect-workflow-department">{defect.assigned_team || 'Department not assigned'}</small></span> },
        { key: 'cycle_key', header: 'Traceability', render: (defect) => <span className={`defect-trace-cell ${!defect.execution_id ? 'incomplete' : ''}`}><strong>{defect.qa_request_key || (defect.qa_request_id ? `Request #${defect.qa_request_id}` : 'No QA request linked')}</strong><small>{defect.cycle_key || 'No cycle'} · {defect.test_case_key || 'No testcase'}</small></span> },
        { key: 'reported_at', header: 'Reported / Age', render: (defect) => <span className="defect-age-cell"><strong>{formatDateIST(defect.reported_at)}</strong><small>{ageInDays(defect.reported_at)}d since reported · {defect.reporter_name}</small></span> },
      ]} />
      {!defects.length && <div className="tm-empty"><strong>{dashboard?.total ? 'No defects match this view' : 'No governed defects yet'}</strong><span>{dashboard?.total ? 'Change the queue or clear filters to see more records.' : 'Open a defect now, or report one directly from a Failed/Blocked execution.'}</span></div>}
    </section>
    {createMode && <CreateDefectModal standalone={createMode === 'standalone'} contexts={contexts} requests={requests} initialExecutionId={initialExecutionId} onClose={() => { setCreateMode(''); setSearchParams({}) }} onCreated={(created) => { refreshDefects(); setCreateMode(''); setSelected(created); setSearchParams({ open: created.defect_key }) }} />}
    {selected && <DefectDetail defect={selected} users={users} departments={departments} requestDepartment={requests.find((request) => request.id === selected.qa_request_id)?.department} defects={duplicateCandidates} contexts={contexts} onClose={() => {
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
