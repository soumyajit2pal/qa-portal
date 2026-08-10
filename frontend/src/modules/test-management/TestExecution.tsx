import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import { hasRole, QA_DEPARTMENT, TEST_EXECUTION_STATUSES, TEST_CYCLE_LOCKED_STATUSES, executionStatusGate } from '../../constants'
import { TestProjectOut, TestCaseOut, TestCaseListOut, TestCycleOut, TestExecutionOut, TestExecutionSummaryOut, TestExecutionRunOut, TestRunDefectOut, ApprovalActionOut, RequestDocumentOut, UserOut, PageOut, QARequestListOut, TestProjectMyAccessOut, DefectListOut } from '../../types'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity, { MarkdownComment } from '../../components/JiraActivity'
import JiraRichTextField from '../../components/JiraRichTextField'
import UserAssignSelect from '../../components/UserAssignSelect'
import LinkedDefects from '../../components/LinkedDefects'
import { usePaginatedList } from '../../hooks/usePaginatedList'

// Test Execution module -- Test Cycles under a selected Test Project, each
// holding one result row (Pass/Fail/Blocked/NA/Retest Passed) per test case
// added to it. QA Engineer + QA Lead both execute (Admin bypasses).
const CAN_EXEC_ROLES = ['QA_ENGINEER', 'QA_LEAD', 'CHEIF_MANAGER_QA']

function CycleModal({ projectId, requests, users, editing, onClose, onSaved }: {
  projectId: number
  requests: QARequestListOut[]
  users: UserOut[]
  editing?: TestCycleOut | null
  onClose: () => void
  onSaved: (c: TestCycleOut) => void
}) {
  const [name, setName] = useState(editing?.name || '')
  const [description, setDescription] = useState(editing?.description || '')
  const [startDate, setStartDate] = useState(editing?.start_date || '')
  const [endDate, setEndDate] = useState(editing?.end_date || '')
  const [linkedRequest, setLinkedRequest] = useState(editing?.linked_request_type && editing.linked_request_id ? `${editing.linked_request_type}:${editing.linked_request_id}` : '')
  // SRS CYC-001 "type, dates, owner, environment and build".
  const [cycleType, setCycleType] = useState(editing?.cycle_type || '')
  const [environment, setEnvironment] = useState(editing?.environment || '')
  const [build, setBuild] = useState(editing?.build || '')
  const [ownerId, setOwnerId] = useState<number | ''>(editing?.owner_id ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Cycle name cannot be blank')); return }
    setBusy(true); setError(null)
    try {
      const payload = {
        name: name.trim(), description: description || null,
        start_date: startDate || null, end_date: endDate || null,
        linked_request_type: linkedRequest ? linkedRequest.split(':')[0] : null,
        linked_request_id: linkedRequest ? Number(linkedRequest.split(':')[1]) : null,
        cycle_type: cycleType || null,
        environment: environment || null, build: build || null,
        owner_id: ownerId || null,
      }
      const saved = editing
        ? await api.patch<TestCycleOut>(`/api/test-execution/cycles/${editing.id}`, payload)
        : await api.post<TestCycleOut>(`/api/test-execution/projects/${projectId}/cycles`, payload)
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={editing ? `Edit ${editing.cycle_key}` : 'New Test Cycle'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Cycle Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-2">
          <Field label="Cycle Type">
            <input value={cycleType} onChange={(e) => setCycleType(e.target.value)} placeholder="Smoke, Functional, Regression, Retest…" />
          </Field>
          <Field label="Environment">
            <input value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="e.g. UAT, Staging" />
          </Field>
          <Field label="Build">
            <input value={build} onChange={(e) => setBuild(e.target.value)} placeholder="e.g. 2026.08.1" />
          </Field>
          <Field label="Owner">
            <SearchableSelect
              value={ownerId === '' ? '' : String(ownerId)}
              onChange={(v) => setOwnerId(v ? Number(v) : '')}
              placeholder="-- Unassigned --"
              options={[{ value: '', label: '-- Unassigned --' }, ...users.filter((u) => u.is_active).map((u) => ({ value: String(u.id), label: u.full_name }))]}
            />
          </Field>
        </div>
        <Field label="Linked Child Request">
          <SearchableSelect value={linkedRequest} onChange={setLinkedRequest} placeholder="Optional — select Functional, SAST, DAST or Performance ID…" options={requests.flatMap((request) => [
            ...request.linked_functional_requests.map((child) => ({ value: `Functional:${child.id}`, label: `${child.request_id} · Functional — ${request.application_name}` })),
            ...request.linked_sast_requests.map((child) => ({ value: `SAST:${child.id}`, label: `${child.request_id} · SAST — ${request.application_name}` })),
            ...request.linked_dast_requests.map((child) => ({ value: `DAST:${child.id}`, label: `${child.request_id} · DAST — ${request.application_name}` })),
            ...request.linked_performance_requests.map((child) => ({ value: `Performance:${child.id}`, label: `${child.request_id} · Performance — ${request.application_name}` })),
          ])} />
          <small className="muted">Link the cycle directly to the testing request it executes.</small>
        </Field>
        <div className="grid grid-2">
          <Field label="Start Date">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="End Date">
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save Changes' : 'Create Cycle'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function CycleStatusControl({ cycle, onChanged, onError }: {
  cycle: TestCycleOut
  onChanged: (c: TestCycleOut) => void
  onError: (err: unknown) => void
}) {
  const [busy, setBusy] = useState(false)
  const [showBlock, setShowBlock] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const [blockingReason, setBlockingReason] = useState('')
  const [remarks, setRemarks] = useState('')
  const [dialogError, setDialogError] = useState<unknown>(null)
  const [completionDefects, setCompletionDefects] = useState<DefectListOut[]>([])
  const [loadingCompletion, setLoadingCompletion] = useState(false)

  useEffect(() => {
    if (!showComplete) return
    setLoadingCompletion(true); setDialogError(null)
    // SRS 7.2 pagination rollout -- /api/defects is now paginated;
    // page_size=100 is a practical ceiling for "defects linked to one Test
    // Cycle" (bounded by the cycle's own case count, not unbounded
    // register-wide growth).
    api.get<PageOut<DefectListOut>>(`/api/defects?cycle_id=${cycle.id}&page_size=100`)
      .then((p) => setCompletionDefects(p.items))
      .catch(setDialogError)
      .finally(() => setLoadingCompletion(false))
  }, [showComplete, cycle.id])

  async function transition(status: string, reason = '', transitionRemarks = '') {
    setBusy(true); setDialogError(null)
    try {
      const saved = await api.patch<TestCycleOut>(`/api/test-execution/cycles/${cycle.id}`, {
        status,
        blocking_reason: reason || null,
        remarks: transitionRemarks || null,
      })
      onChanged(saved)
      setShowBlock(false); setShowComplete(false)
      setBlockingReason(''); setRemarks('')
    } catch (err) {
      if (showBlock || showComplete) setDialogError(err)
      else onError(err)
    } finally { setBusy(false) }
  }

  const actions = cycle.status === 'Draft'
    ? [{ label: 'Mark as Ready', status: 'Ready' }]
    : cycle.status === 'Ready'
      ? [{ label: 'Start Execution', status: 'In Progress' }]
      : cycle.status === 'In Progress'
        ? [{ label: 'Block Execution', status: 'Blocked' }, { label: 'Complete Execution', status: 'Completed' }]
        : cycle.status === 'Blocked'
          ? [{ label: 'Resume Execution', status: 'In Progress' }]
          : []
  const unresolvedStatuses = new Set(['New', 'Assigned', 'In Progress', 'Resolved', 'Retest', 'Reopened'])
  const severeBlockers = completionDefects.filter((defect) => ['Critical', 'High'].includes(defect.severity) && unresolvedStatuses.has(defect.status))
  const residualDefects = completionDefects.filter((defect) => ['Medium', 'Low'].includes(defect.severity) && unresolvedStatuses.has(defect.status))
  const deferredDefects = completionDefects.filter((defect) => defect.status === 'Deferred')
  const severitySummary = ['Critical', 'High', 'Medium', 'Low'].map((severity) => ({ severity, count: completionDefects.filter((defect) => defect.severity === severity).length }))
  const statusSummary = Array.from(new Set(completionDefects.map((defect) => defect.status))).map((status) => ({ status, count: completionDefects.filter((defect) => defect.status === status).length }))

  return (
    <>
      <div className="tm-cycle-status-actions" aria-label={`Available actions for ${cycle.status} cycle`}>
        <Badge status={cycle.status} />
        {actions.map((action) => (
          <button
            key={action.status}
            type="button"
            className={`btn btn-sm ${action.status === 'Completed' ? 'btn-primary' : ''}`}
            disabled={busy}
            onClick={() => {
              if (action.status === 'Blocked') setShowBlock(true)
              else if (action.status === 'Completed') setShowComplete(true)
              else transition(action.status)
            }}
          >
            {busy ? 'Updating…' : action.label}
          </button>
        ))}
      </div>
      {showBlock && (
        <Modal title={`Block ${cycle.cycle_key}?`} onClose={() => setShowBlock(false)} variant="dialog" preventBackdropClose>
          <form onSubmit={(event) => {
            event.preventDefault()
            if (!blockingReason.trim()) { setDialogError(new Error('A blocking reason is required')); return }
            transition('Blocked', blockingReason.trim(), remarks.trim())
          }}>
            <Field label="Blocking Reason *">
              <textarea required rows={3} value={blockingReason} onChange={(event) => setBlockingReason(event.target.value)} placeholder="Describe the issue or dependency stopping execution." />
            </Field>
            <Field label="Remarks (optional)">
              <textarea rows={2} value={remarks} onChange={(event) => setRemarks(event.target.value)} />
            </Field>
            <ErrorText error={dialogError} />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button className="btn btn-primary" disabled={busy || !blockingReason.trim()}>{busy ? 'Blocking…' : 'Block Execution'}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setShowBlock(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
      {showComplete && (
        <Modal title={`Complete ${cycle.cycle_key}?`} onClose={() => setShowComplete(false)} variant="dialog" preventBackdropClose wide>
          <div className="tm-cycle-defect-summary">
            <p>Review all linked defects before completing this Test Cycle. Completion is final.</p>
            {loadingCompletion ? <p className="muted">Loading defect validation…</p> : <>
              <div className="tm-cycle-defect-counts">
                {severitySummary.map((item) => <div key={item.severity}><small>{item.severity}</small><strong>{item.count}</strong></div>)}
              </div>
              <div className="tm-cycle-defect-statuses">{statusSummary.length ? statusSummary.map((item) => <span key={item.status}>{item.status} <b>{item.count}</b></span>) : <span>No linked defects</span>}</div>
              {severeBlockers.length > 0 && <div className="alert alert-error"><strong>Completion blocked</strong><span>Resolve, reject, defer with approval, or close: {severeBlockers.map((defect) => defect.defect_key).join(', ')}</span></div>}
              {residualDefects.length > 0 && <div className="alert alert-warning"><strong>QA Lead approval required</strong><span>{residualDefects.length} open Medium/Low defect(s) require justification and a Target Release before completion.</span></div>}
              {deferredDefects.length > 0 && <div className="tm-cycle-deferred"><strong>Deferred defects ({deferredDefects.length})</strong>{deferredDefects.map((defect) => <span key={defect.id}>{defect.defect_key} · {defect.target_release || 'Target release missing'}</span>)}</div>}
            </>}
            <Field label={residualDefects.length ? 'Completion Justification *' : 'Completion Remarks (optional)'}>
              <textarea rows={3} required={residualDefects.length > 0} value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="Record the completion decision and any accepted residual risk." />
            </Field>
            <ErrorText error={dialogError} />
            <div className="modal-actions"><button type="button" className="btn btn-primary" disabled={busy || loadingCompletion || severeBlockers.length > 0 || (residualDefects.length > 0 && !remarks.trim())} onClick={() => transition('Completed', '', remarks.trim())}>{busy ? 'Completing…' : 'Complete Execution'}</button><button type="button" className="btn" disabled={busy} onClick={() => setShowComplete(false)}>Cancel</button></div>
          </div>
        </Modal>
      )}
    </>
  )
}

function AddCasesModal({ cycleId, allCases, existingCaseIds, canAssign, runnerCandidates, onClose, onAdded }: {
  cycleId: number
  allCases: TestCaseListOut[]
  existingCaseIds: Set<number>
  canAssign: boolean
  runnerCandidates: UserOut[]
  onClose: () => void
  onAdded: (execs: TestExecutionOut[]) => void
}) {
  // SRS CYC-003 "Only approved, non-archived testcase versions... shall be
  // selectable." c.status is TestCase's own mirror -- it shows the
  // in-progress Draft revision (if any) rather than the still-perfectly-
  // selectable Approved baseline underneath it (VER-002), so eligibility is
  // checked against current_approved_version_id (an approval has ever
  // happened) combined with the mirror not currently reading Archived
  // (which only happens when there's no draft override and the approved
  // version itself was archived) -- matches the backend's own check in
  // add_test_cases_to_cycle.
  const isSelectable = (c: TestCaseListOut) => !!c.current_approved_version_id && c.status !== 'Archived'
  const candidates = useMemo(() => allCases.filter((c) => isSelectable(c) && !existingCaseIds.has(c.id)), [allCases, existingCaseIds])
  const awaitingApproval = useMemo(() => allCases.filter((c) => !isSelectable(c) && !existingCaseIds.has(c.id)), [allCases, existingCaseIds])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [assignedTo, setAssignedTo] = useState('')

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const allCandidatesSelected = candidates.length > 0 && candidates.every((testCase) => selected.has(testCase.id))

  function toggleAllCandidates() {
    setSelected((current) => {
      const next = new Set(current)
      if (allCandidatesSelected) candidates.forEach((testCase) => next.delete(testCase.id))
      else candidates.forEach((testCase) => next.add(testCase.id))
      return next
    })
  }

  async function submit() {
    if (selected.size === 0) { setError(new Error('Pick at least one test case')); return }
    setBusy(true); setError(null)
    try {
      const execs = await api.post<TestExecutionOut[]>(`/api/test-execution/cycles/${cycleId}/executions`, {
        test_case_ids: Array.from(selected),
        assigned_to_id: assignedTo ? Number(assignedTo) : null,
      })
      onAdded(execs)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="Add Test Cases to Cycle" onClose={onClose} wide>
      {awaitingApproval.length > 0 && (
        <div className="info-banner"><strong>{awaitingApproval.length} testcase{awaitingApproval.length !== 1 ? 's are' : ' is'} unavailable.</strong> Reviewer recommendation and QA Lead final approval are required before cycle assignment.</div>
      )}
      {canAssign && <div className="tm-add-cases-runner"><div><strong>Assign selected testcases</strong><span>Optional—assign all selected cases to one runner now, then reassign individual rows later.</span></div><UserAssignSelect value={assignedTo} onChange={setAssignedTo} users={runnerCandidates} placeholder="Leave unassigned…" /></div>}
      {candidates.length === 0 ? (
        <p className="muted small">There are no approved testcases available to add. Approve pending testcases in the Test Repository first.</p>
      ) : (
        <>
          <div className="tm-add-cases-selection-bar">
            <div>
              <strong>{selected.size ? `${selected.size} testcase${selected.size !== 1 ? 's' : ''} selected` : 'Select testcases to add'}</strong>
              <span>{candidates.length} approved testcase{candidates.length !== 1 ? 's' : ''} available</span>
            </div>
            <button type="button" className="btn btn-sm" onClick={toggleAllCandidates}>
              {allCandidatesSelected ? 'Clear all' : `Select all (${candidates.length})`}
            </button>
          </div>
          <Table<TestCaseListOut>
            tableId="add-testcases-to-cycle"
            rowKey="id"
            rows={candidates}
            onRowClick={(testCase) => toggle(testCase.id)}
            columns={[
              {
                key: 'selection',
                header: <input type="checkbox" aria-label="Select all eligible testcases" checked={allCandidatesSelected} onChange={toggleAllCandidates} onClick={(event) => event.stopPropagation()} />,
                filterable: false,
                render: (testCase) => <input type="checkbox" aria-label={`Select ${testCase.test_case_key}`} checked={selected.has(testCase.id)} onChange={() => toggle(testCase.id)} onClick={(event) => event.stopPropagation()} />,
              },
              { key: 'test_case_key', header: 'Test Case ID' },
              { key: 'test_scenario', header: 'Scenario', render: (testCase) => testCase.test_scenario || '—' },
              { key: 'test_type', header: 'Type', render: (testCase) => testCase.test_type || '—' },
              { key: 'priority', header: 'Priority', render: (testCase) => testCase.priority || '—' },
              { key: 'module_name', header: 'Module', render: (testCase) => testCase.module_name || '—' },
              { key: 'tags', header: 'Tags', render: (testCase) => testCase.tags?.length ? testCase.tags.join(', ') : '—', filterValue: (testCase) => testCase.tags?.join(' ') || '' },
            ]}
          />
        </>
      )}
      <ErrorText error={error} />
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || candidates.length === 0} onClick={submit}>
          {busy ? 'Adding...' : `Add Selected (${selected.size})`}
        </button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

function TestCaseDetail({ label, value, wide = false, children }: {
  label: string
  value?: React.ReactNode
  wide?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={`tm-case-detail ${wide ? 'tm-case-detail-wide' : ''}`}>
      <small>{label}</small>
      <div>{children ?? value ?? '—'}</div>
    </div>
  )
}

function InlineExecutionActions({ execution, canExecute, onChanged, onLinkExisting, onError }: {
  execution: TestExecutionOut
  canExecute: boolean
  onChanged: (execution: TestExecutionOut) => void
  onLinkExisting: (execution: TestExecutionOut) => void
  onError: (error: unknown) => void
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkingDefect, setLinkingDefect] = useState(false)
  const [defectKey, setDefectKey] = useState('')
  const [defectUrl, setDefectUrl] = useState('')
  const latestRun = execution.runs?.[execution.runs.length - 1]
  // Reported directly: "testcase already failed, and defect also linked,
  // then why again allowing to marked failed" -- clarified to mean a second,
  // separate defect shouldn't be linkable to the same already-linked
  // attempt (recording a fresh Fail on retest is still fine -- that's a new
  // attempt/run, not this one). Backend enforces this regardless (see
  // test_execution.py's _link_defect / defects.py's _link_to_execution) --
  // this just keeps the buttons from being offered once already linked.
  const latestCanLinkDefect = !!latestRun && ['Fail', 'Blocked'].includes(latestRun.status) && !(latestRun.defects?.length)

  async function saveResult() {
    if (!result) return
    setBusy(true)
    try {
      const saved = await api.patch<TestExecutionOut>(`/api/test-execution/executions/${execution.id}`, {
        status: result, actual_result: null, test_run_artifacts: null, defect_id: null,
        // SRS EXE-007 optimistic concurrency -- lets the backend detect and
        // reject a save if someone else already recorded a newer attempt on
        // this exact slot since this row was last loaded into the table.
        expected_run_version: execution.run_version,
      })
      onChanged(saved)
      setResult('')
      setOpen(false)
    } catch (error) { onError(error) } finally { setBusy(false) }
  }

  async function linkDefect(event: React.FormEvent) {
    event.preventDefault()
    if (!latestRun || !defectKey.trim()) return
    setBusy(true)
    try {
      const defect = await api.post<TestRunDefectOut>(`/api/test-execution/executions/${execution.id}/runs/${latestRun.id}/defects`, {
        defect_key: defectKey.trim(), defect_url: defectUrl.trim() || null, defect_status: 'Open',
      })
      onChanged({ ...execution, runs: (execution.runs || []).map((run) => run.id === latestRun.id ? { ...run, defects: [...(run.defects || []), defect] } : run) })
      setDefectKey(''); setDefectUrl(''); setLinkingDefect(false)
    } catch (error) { onError(error) } finally { setBusy(false) }
  }

  return (
    <div className="tm-inline-run" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="tm-play-button" disabled={!canExecute || busy} title={canExecute ? 'Record a result without opening the testcase' : 'Only the assigned runner can execute this testcase'} onClick={() => { setOpen((value) => !value); setLinkingDefect(false) }}><span>▶</span> Run</button>
      {latestCanLinkDefect && canExecute && <button type="button" className="tm-link-last-defect tm-governed-defect" onClick={() => navigate(`/defects?execution=${execution.id}`)}>Raise defect</button>}
      {latestCanLinkDefect && canExecute && <button type="button" className="tm-link-last-defect" onClick={() => onLinkExisting(execution)}>Link existing</button>}
      {latestCanLinkDefect && canExecute && <button type="button" className="tm-link-last-defect" onClick={() => { setLinkingDefect((value) => !value); setOpen(false) }}>Link external</button>}
      {open && <div className="tm-inline-run-panel">
        <strong>Record new result</strong><small>Creates Attempt #{(execution.run_count || 0) + 1}</small>
        <div className="tm-inline-result-options">{TEST_EXECUTION_STATUSES.filter((status) => status !== 'Not Executed').map((status) => {
          const blocked = executionStatusGate(execution.linked_defects, execution.runs, status)
          return <button type="button" key={status} className={result === status ? 'selected' : ''} disabled={!!blocked} title={blocked || undefined} onClick={() => setResult(status)}>{status}</button>
        })}</div>
        {result && executionStatusGate(execution.linked_defects, execution.runs, result) && (
          <small className="tm-inline-defect-gate-note">{executionStatusGate(execution.linked_defects, execution.runs, result)}</small>
        )}
        <div className="tm-inline-run-actions"><button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn btn-sm btn-primary" disabled={!result || busy} onClick={saveResult}>{busy ? 'Saving…' : 'Save result'}</button></div>
      </div>}
      {linkingDefect && latestRun && <form className="tm-inline-defect-panel" onSubmit={linkDefect}>
        <strong>Link to latest {latestRun.status.toLowerCase()} run</strong><small>Attempt #{latestRun.attempt_no} only</small>
        <input required value={defectKey} onChange={(event) => setDefectKey(event.target.value)} placeholder="Defect key, e.g. JIRA-142" />
        <input type="url" value={defectUrl} onChange={(event) => setDefectUrl(event.target.value)} placeholder="Defect URL (optional)" />
        <div className="tm-inline-run-actions"><button type="button" className="btn btn-sm" onClick={() => setLinkingDefect(false)}>Cancel</button><button className="btn btn-sm btn-danger" disabled={busy}>{busy ? 'Linking…' : 'Link external'}</button></div>
      </form>}
    </div>
  )
}

function LinkExistingDefectModal({ execution, onClose, onLinked }: {
  execution: TestExecutionOut; onClose: () => void; onLinked: () => void
}) {
  const [defects, setDefects] = useState<DefectListOut[]>([])
  const [defectId, setDefectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    // SRS 7.2 pagination rollout -- `queue=unlinked` (execution_id IS NULL)
    // plus the explicit non-terminal status list reproduce the previous
    // client-side `!item.execution_id && !['Closed','Rejected',
    // 'Duplicate'].includes(item.status)` filter entirely server-side.
    // page_size=100 is a practical ceiling for this picker, same compromise
    // as Defects.tsx's own duplicate-defect candidate pool.
    const openStatuses = ['New', 'Assigned', 'In Progress', 'Resolved', 'Retest', 'Reopened', 'Deferred']
    const qs = new URLSearchParams({ queue: 'unlinked', page_size: '100' })
    openStatuses.forEach((s) => qs.append('status', s))
    api.get<PageOut<DefectListOut>>(`/api/defects?${qs.toString()}`).then((p) => setDefects(p.items)).catch(setError)
  }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!defectId) return
    setBusy(true); setError(null)
    try {
      await api.post(`/api/defects/${defectId}/link-execution`, { execution_id: execution.id })
      onLinked()
    } catch (err) { setError(err); setBusy(false) }
  }
  return <Modal title="Link existing defect" onClose={onClose} variant="dialog" preventBackdropClose wide>
    <form onSubmit={submit}>
      <div className="defect-trace-banner"><strong>{execution.test_case?.test_case_key} · {execution.status}</strong><span>Select a previously opened, unlinked governed defect. This execution's Cycle, Test Case, and latest attempt will be linked automatically.</span></div>
      <Field label="Unlinked Defect *"><SearchableSelect value={defectId} onChange={setDefectId} placeholder="Select open defect…" options={defects.map((defect) => ({ value: String(defect.id), label: `${defect.defect_key} · ${defect.title} · ${defect.qa_request_key || 'QA Request'}` }))} /></Field>
      {!defects.length && <p className="muted small">No unlinked open defects are available. Use Open Defect in Defect Management first.</p>}
      <ErrorText error={error} title="Defect could not be linked" />
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !defectId}>{busy ? 'Linking…' : 'Link Defect'}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}

// Generic evidence gallery. `basePath` points at either the legacy
// "current attempt" result-images endpoint or a specific historical
// attempt's `/runs/{run_id}/images` endpoint -- both expose the same
// list/download/delete shape, so one component covers both.
function ImageGallery({ basePath, readOnly, emptyText }: { basePath: string; readOnly: boolean; emptyText?: string }) {
  const { user } = useAuth()
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([])
  const [urls, setUrls] = useState<Record<number, string>>({})
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let active = true
    const createdUrls: string[] = []
    async function load() {
      try {
        const docs = await api.get<RequestDocumentOut[]>(basePath)
        if (!active) return
        setDocuments(docs)
        const loaded = await Promise.all(docs.map(async (document) => {
          const blob = await api.getBlob(`${basePath}/${document.id}/download`)
          const url = URL.createObjectURL(blob)
          createdUrls.push(url)
          return [document.id, url] as const
        }))
        if (active) setUrls(Object.fromEntries(loaded))
      } catch (err) { if (active) setError(err) }
    }
    load()
    return () => { active = false; createdUrls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [basePath])

  async function remove(document: RequestDocumentOut) {
    try {
      setError(null)
      await api.del(`${basePath}/${document.id}`)
      if (urls[document.id]) URL.revokeObjectURL(urls[document.id])
      setDocuments((current) => current.filter((item) => item.id !== document.id))
      setUrls((current) => { const next = { ...current }; delete next[document.id]; return next })
    } catch (err) { setError(err) }
  }

  if (documents.length === 0 && !error) return emptyText ? <p className="muted small">{emptyText}</p> : null
  return (
    <div className="execution-result-images">
      <div className="execution-result-images-title">Screenshots <span>{documents.length}</span></div>
      <div className="jira-comment-attachments">
        {documents.map((document) => urls[document.id] && (
          <div className="execution-result-image" key={document.id}>
            <button type="button" className="jira-comment-image" title={`Open ${document.file_name}`} onClick={() => window.open(urls[document.id], '_blank', 'noopener,noreferrer')}>
              <img src={urls[document.id]} alt={document.file_name} /><span>{document.file_name}</span>
            </button>
            {!readOnly && (user?.roles.includes('ADMIN') || document.uploaded_by_id === user?.id) && <button type="button" className="execution-result-image-remove" title="Delete screenshot" onClick={() => remove(document)}>×</button>}
          </div>
        ))}
      </div>
      <ErrorText error={error} title="Screenshot action failed" />
    </div>
  )
}

// Every save records a brand new, immutable attempt rather than overwriting
// the last one -- so a Fail logged with evidence stays on the record even
// after a later run comes back Pass. This lists every attempt (newest
// first), each expandable to its own actual result and its own screenshots.
function DefectLinks({ executionId, run, readOnly, onChanged }: {
  executionId: number
  run: TestExecutionRunOut
  readOnly: boolean
  onChanged: (defects: TestRunDefectOut[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [defectStatus, setDefectStatus] = useState('Open')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [pendingRemove, setPendingRemove] = useState<TestRunDefectOut | null>(null)

  async function link(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim()) { setError(new Error('Defect key is required')); return }
    setBusy(true); setError(null)
    try {
      const created = await api.post<TestRunDefectOut>(`/api/test-execution/executions/${executionId}/runs/${run.id}/defects`, {
        defect_key: key.trim(), defect_url: url.trim() || null, title: title.trim() || null,
        defect_status: defectStatus || null, notes: notes.trim() || null,
      })
      onChanged([...(run.defects || []), created])
      setKey(''); setUrl(''); setTitle(''); setDefectStatus('Open'); setNotes(''); setAdding(false)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function unlink() {
    if (!pendingRemove) return
    setBusy(true); setError(null)
    try {
      await api.del(`/api/test-execution/executions/${executionId}/runs/${run.id}/defects/${pendingRemove.id}`)
      onChanged((run.defects || []).filter((defect) => defect.id !== pendingRemove.id))
      setPendingRemove(null)
    } catch (err) { setError(err); setPendingRemove(null) } finally { setBusy(false) }
  }

  return (
    <div className="tm-defect-links">
      <div className="tm-defect-links-head"><strong>Linked Defects</strong><span>{run.defects?.length || 0}</span>{!readOnly && <button type="button" className="btn btn-sm" onClick={() => setAdding((value) => !value)}>+ Link defect</button>}</div>
      {(run.defects || []).length === 0 && <p className="muted small">No defects linked to this attempt.</p>}
      {(run.defects || []).map((defect) => (
        <div className="tm-defect-link" key={defect.id}>
          <div>
            {defect.defect_url ? <a href={defect.defect_url} target="_blank" rel="noreferrer">{defect.defect_key}</a> : <strong>{defect.defect_key}</strong>}
            <span>{defect.title || 'No title provided'}</span>
            {defect.notes && <small>{defect.notes}</small>}
          </div>
          {defect.defect_status && <Badge status={defect.defect_status} />}
          {!readOnly && <button type="button" className="tm-defect-unlink" title="Unlink defect" onClick={() => setPendingRemove(defect)}>×</button>}
        </div>
      ))}
      {adding && <form className="tm-defect-form" onSubmit={link}>
        <div className="grid grid-2"><Field label="Defect Key *"><input required value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. JIRA-142" /></Field><Field label="Defect Status"><select value={defectStatus} onChange={(e) => setDefectStatus(e.target.value)}><option>Open</option><option>In Progress</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select></Field></div>
        <Field label="Defect URL"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://jira.example/browse/JIRA-142" /></Field>
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short defect summary" /></Field>
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="tm-defect-form-actions"><button className="btn btn-primary btn-sm" disabled={busy}>Link defect</button><button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>Cancel</button></div>
      </form>}
      <ErrorText error={error} title="Defect linking failed" />
      {pendingRemove && <ConfirmModal title="Unlink defect?" message={<p>Remove the link to <strong>{pendingRemove.defect_key}</strong> from Attempt #{run.attempt_no}? The defect itself will not be deleted.</p>} confirmLabel="Unlink defect" cancelLabel="Keep link" destructive busy={busy} onConfirm={unlink} onCancel={() => setPendingRemove(null)} />}
    </div>
  )
}

function AttemptHistory({ executionId, readOnly }: { executionId: number; readOnly: boolean }) {
  const [runs, setRuns] = useState<TestExecutionRunOut[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    api.get<TestExecutionRunOut[]>(`/api/test-execution/executions/${executionId}/runs`)
      .then((r) => { if (!active) return; setRuns(r); if (r.length) setExpandedId(r[r.length - 1].id) })
      .catch((err) => { if (active) setError(err) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [executionId])

  if (loading) return <p className="muted small">Loading attempt history...</p>
  if (error) return <ErrorText error={error} title="Could not load attempt history" />
  if (runs.length === 0) return <p className="muted small">No attempts recorded yet for this test case.</p>

  return (
    <div className="tm-attempt-history">
      <h4 style={{ marginBottom: 8 }}>Attempt History <span className="badge badge-gray">{runs.length}</span></h4>
      {[...runs].reverse().map((run) => (
        <div key={run.id} style={{ border: '1px solid #e2e2e2', borderRadius: 6, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => setExpandedId(expandedId === run.id ? null : run.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          >
            <strong>Attempt #{run.attempt_no}</strong>
            <Badge status={run.status} />
            <span className="muted small">{run.executed_by_name || 'Unknown runner'}</span>
            <span className="muted small">{run.defects?.length || 0} defect{run.defects?.length === 1 ? '' : 's'}</span>
            <span className="muted small" style={{ marginLeft: 'auto' }}>{run.executed_at ? new Date(run.executed_at).toLocaleString() : '—'}</span>
            <span>{expandedId === run.id ? '▾' : '▸'}</span>
          </button>
          {expandedId === run.id && (
            <div style={{ padding: '0 12px 12px' }}>
              {run.actual_result ? <MarkdownComment value={run.actual_result} /> : <p className="muted small">No actual result recorded.</p>}
              {run.test_run_artifacts && <p className="small"><strong>Test Run Artifacts:</strong> {run.test_run_artifacts}</p>}
              <DefectLinks executionId={executionId} run={run} readOnly={readOnly || run.id !== runs[runs.length - 1].id || !['Fail', 'Blocked'].includes(run.status)} onChanged={(defects) => setRuns((current) => current.map((item) => item.id === run.id ? { ...item, defects } : item))} />
              <ImageGallery
                basePath={`/api/test-execution/executions/${executionId}/runs/${run.id}/images`}
                readOnly={readOnly}
                emptyText="No screenshots attached to this attempt."
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// CYC-006 -- upgrades an unexecuted, stale-pinned slot straight to the
// testcase's current Approved version. Fetching the testcase's own
// current_approved_version_id (not exposed on TestExecutionOut directly)
// requires one extra lookup, kept local to this small action rather than
// threading it through every caller.
function VersionUpgradeAction({ execution, onUpgraded }: {
  execution: TestExecutionOut
  onUpgraded: (e: TestExecutionOut) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function upgrade() {
    setBusy(true); setError(null)
    try {
      const testCase = await api.get<TestCaseOut>(`/api/test-repository/test-cases/${execution.test_case_id}`)
      if (!testCase.current_approved_version_id) throw new Error('This testcase no longer has an Approved version')
      const saved = await api.post<TestExecutionOut>(`/api/test-execution/executions/${execution.id}/upgrade-version`, {
        target_version_id: testCase.current_approved_version_id,
      })
      onUpgraded(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={upgrade} disabled={busy} style={{ marginLeft: 8 }}>
        {busy ? 'Upgrading…' : 'Upgrade to latest Approved'}
      </button>
      <ErrorText error={error} />
    </>
  )
}

function RecordResultModal({ execution, readOnly, canAssign, runnerCandidates, onAssigned, onClose, onSaved, onRemoved }: {
  execution: TestExecutionOut
  readOnly: boolean
  canAssign: boolean
  runnerCandidates: UserOut[]
  onAssigned: (execution: TestExecutionOut) => void
  onClose: () => void
  onSaved: (e: TestExecutionOut) => void
  onRemoved: (id: number) => void
}) {
  // Deliberately blank, not pre-filled from execution's mirrored fields --
  // opening this form logs a fresh attempt, it does not edit the last one.
  const [status, setStatus] = useState('')
  const [actualResult, setActualResult] = useState('')
  const [artifacts, setArtifacts] = useState('')
  const [defectId, setDefectId] = useState('')
  const [defectUrl, setDefectUrl] = useState('')
  const [defectTitle, setDefectTitle] = useState('')
  const [defectStatus, setDefectStatus] = useState('Open')
  const [defectNotes, setDefectNotes] = useState('')
  const [resultImages, setResultImages] = useState<File[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!status) { setError(new Error('Select a result for this attempt')); return }
    setBusy(true); setError(null)
    try {
      const saved = await api.uploadFormFiles<TestExecutionOut>(
        `/api/test-execution/executions/${execution.id}/rich-result`,
        {
          status, actual_result: actualResult, test_run_artifacts: artifacts,
          defect_id: ['Fail', 'Blocked'].includes(status) ? defectId : '', defect_url: ['Fail', 'Blocked'].includes(status) ? defectUrl : '',
          defect_title: ['Fail', 'Blocked'].includes(status) ? defectTitle : '', defect_status: ['Fail', 'Blocked'].includes(status) ? defectStatus : '',
          defect_notes: ['Fail', 'Blocked'].includes(status) ? defectNotes : '',
        },
        resultImages,
      )
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function assign(value: string) {
    setBusy(true); setError(null)
    try {
      const saved = await api.patch<TestExecutionOut>(`/api/test-execution/executions/${execution.id}/assign`, {
        assigned_to_id: value ? Number(value) : null,
      })
      onAssigned(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function remove() {
    setBusy(true); setError(null)
    try {
      await api.del(`/api/test-execution/executions/${execution.id}`)
      onRemoved(execution.id)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const tc = execution.test_case
  // Reported directly, as a full spec: while any linked governed defect is
  // still active (not Deferred/Closed), the whole execution is locked --
  // display the defect id(s)/status and the explanatory message up front,
  // not just a disabled option buried in the Result dropdown below. See
  // constants.ts's executionStatusGate / backend's matching
  // _execution_status_gate for where this is actually enforced.
  const activeLinkedDefects = (execution.linked_defects || []).filter((d) => !['Deferred', 'Closed'].includes(d.status))
  const hasPriorFail = (execution.runs || []).some((run) => run.status === 'Fail')
  return (
    <Modal title={`Record Result -- ${tc?.test_case_key || `Test Case #${execution.test_case_id}`}`} onClose={onClose} wide>
      {execution.pinned_version_id && (
        <div className={`info-banner ${execution.is_pinned_stale ? 'warning' : ''}`}>
          This slot is pinned to <strong>v{execution.pinned_version_label}</strong>
          {execution.is_pinned_stale && !execution.run_count ? (
            <> -- a newer Approved version now exists. <VersionUpgradeAction execution={execution} onUpgraded={onSaved} /></>
          ) : execution.is_pinned_stale ? (
            <> -- a newer Approved version now exists, but this slot already has execution history and remains permanently pinned (CYC-006).</>
          ) : (
            <> -- the exact version selected when this testcase was added to the cycle, regardless of later edits.</>
          )}
        </div>
      )}
      {tc && (
        <div className="tm-execution-case-summary">
          <div className="tm-execution-case-heading">
            <div><small>Test case definition</small><h4>{tc.test_case_key} <span className="badge badge-gray">{`v${execution.pinned_version_label || tc.version || '1.0'}`}</span></h4></div>
            <Badge status={tc.status} />
          </div>
          <div className="tm-case-detail-grid">
            <TestCaseDetail label="Pinned Version">
              <span className="badge badge-gray">{`v${execution.pinned_version_label || tc.version || '1.0'}`}</span>
              <small style={{ display: 'block', marginTop: 4 }}>The exact version this cycle slot was pinned to when added -- frozen once any attempt is recorded (SRS CYC-004/CYC-006).</small>
            </TestCaseDetail>
            <TestCaseDetail label="Epic ID" value={tc.epic_id} />
            <TestCaseDetail label="CR Number" value={tc.cr_number} />
            <TestCaseDetail label="Feature ID" value={tc.feature_id} />
            <TestCaseDetail label="User Story ID" value={tc.user_story_id} />
            <TestCaseDetail label="Test Type" value={tc.test_type} />
            <TestCaseDetail label="Module" value={tc.module_name} />
            <TestCaseDetail label="Repository Folder" value={tc.folder_name || 'Unfiled'} />
            <TestCaseDetail label="Priority">
              {tc.priority ? <Badge status={tc.priority} /> : '—'}
            </TestCaseDetail>
            <TestCaseDetail label="Repository Status" value={tc.status} />
            <TestCaseDetail label="Test Scenario" value={tc.test_scenario} wide />
            <TestCaseDetail label="Pre-Condition" value={tc.pre_condition} wide />
            <TestCaseDetail label="Description" value={tc.description} wide />
            <TestCaseDetail label="Created By" value={tc.created_by_name} />
            <TestCaseDetail label="Created At" value={tc.created_at ? new Date(tc.created_at).toLocaleString() : '—'} />
            <TestCaseDetail label="Last Updated" value={tc.updated_at ? new Date(tc.updated_at).toLocaleString() : '—'} />
          </div>
          <div className="tm-execution-steps">
            <h4>Test Steps <span>{tc.steps.length}</span></h4>
          {tc.steps.length > 0 ? (
            <table className="simple-table">
              <thead><tr><th>#</th><th>Step</th><th>Expected Result</th></tr></thead>
              <tbody>{tc.steps.map((s, i) => <tr key={s.id}><td>{s.step_no || i + 1}</td><td>{s.step_text || '—'}</td><td>{s.expected_result || '—'}</td></tr>)}</tbody>
            </table>
          ) : <p className="muted small">No steps are defined for this test case.</p>}
          </div>
        </div>
      )}
      <div className="tm-execution-result-heading"><h4>Execution Result</h4>{readOnly && <span>Read only</span>}</div>
      <div className={`tm-runner-panel ${execution.assigned_to_id ? '' : 'unassigned'}`}>
        <div><small>Assigned runner</small><strong>{execution.assigned_to_name || 'Unassigned'}</strong>{execution.assigned_at && <span>Assigned {new Date(execution.assigned_at).toLocaleString()}{execution.assigned_by_name ? ` by ${execution.assigned_by_name}` : ''}</span>}</div>
        {canAssign && <div className="tm-runner-control"><UserAssignSelect value={execution.assigned_to_id ? String(execution.assigned_to_id) : ''} onChange={assign} users={runnerCandidates} placeholder="Assign QA runner…" disabled={busy} />{execution.assigned_to_id && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => assign('')}>Unassign</button>}</div>}
      </div>
      {!execution.assigned_to_id && <div className="info-banner">A COE - Quality Assurance QA Engineer or QA Lead must assign this testcase before an execution attempt can be recorded.</div>}
      {execution.assigned_to_id && readOnly && <div className="info-banner">Only the assigned runner can record the next attempt. Any COE - Quality Assurance QA Engineer or QA Lead can reassign the testcase when needed.</div>}
      {activeLinkedDefects.length > 0 && (
        <div className="info-banner warning">
          <strong>Locked:</strong> This test case previously failed and has an active linked defect
          {' '}({activeLinkedDefects.map((d) => `${d.defect_key} · ${d.status}`).join(', ')}). The execution
          status cannot be changed until all linked defects are Closed or Deferred.
        </div>
      )}
      {activeLinkedDefects.length === 0 && hasPriorFail && (
        <div className="info-banner">
          The linked defect has been Closed or Deferred. Please retest the test case and select
          {' '}<strong>Retest Passed</strong> if it passes, or <strong>Fail</strong> if it fails again.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 16px' }}>
        <span className="muted small">Latest result:</span>
        <Badge status={execution.status} />
        {execution.executed_at && <span className="muted small">as of {new Date(execution.executed_at).toLocaleString()}</span>}
      </div>
      <AttemptHistory executionId={execution.id} readOnly={readOnly} />
      {!readOnly && (
        <form onSubmit={submit} style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #e2e2e2' }}>
          <h4>Log New Attempt</h4>
          <Field label="Result *">
            <select required value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="" disabled>Select result...</option>
              {TEST_EXECUTION_STATUSES.filter((s) => s !== 'Not Executed').map((s) => {
                const blocked = executionStatusGate(execution.linked_defects, execution.runs, s, defectId)
                return <option key={s} value={s} disabled={!!blocked}>{s}{blocked ? ' (locked)' : ''}</option>
              })}
            </select>
            {status && executionStatusGate(execution.linked_defects, execution.runs, status, defectId) && (
              <small className="tm-inline-defect-gate-note">{executionStatusGate(execution.linked_defects, execution.runs, status, defectId)}</small>
            )}
          </Field>
          <Field label="Actual Result">
            <JiraRichTextField value={actualResult} onChange={setActualResult} onImagesChange={setResultImages} />
          </Field>
          <Field label="Test Run Artifacts">
            <input value={artifacts} onChange={(e) => setArtifacts(e.target.value)} placeholder="Link, filename, or reference" />
          </Field>
          {['Fail', 'Blocked'].includes(status) && <div className="tm-new-attempt-defect">
            <div className="tm-new-attempt-defect-head">
              <strong>Link a defect to this attempt</strong>
              <span>
                {status === 'Fail' && (execution.runs || []).some((run) => run.status === 'Fail')
                  ? 'Required -- reopen the existing defect, link another active one, or reference a newly created one'
                  : 'Optional · More defects can be linked from Attempt History'}
              </span>
            </div>
            <div className="grid grid-2"><Field label="Defect Key"><input value={defectId} onChange={(e) => setDefectId(e.target.value)} placeholder="e.g. JIRA-142" /></Field><Field label="Defect Status"><select value={defectStatus} onChange={(e) => setDefectStatus(e.target.value)}><option>Open</option><option>In Progress</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select></Field></div>
            <Field label="Defect URL"><input type="url" value={defectUrl} onChange={(e) => setDefectUrl(e.target.value)} placeholder="https://jira.example/browse/JIRA-142" /></Field>
            <Field label="Defect Title"><input value={defectTitle} onChange={(e) => setDefectTitle(e.target.value)} placeholder="Short defect summary" /></Field>
            <Field label="Defect Notes"><textarea value={defectNotes} onChange={(e) => setDefectNotes(e.target.value)} /></Field>
          </div>}
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={busy || !status || actualResult.length > 10000}>{busy ? 'Saving...' : 'Save Attempt'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-danger" onClick={() => setConfirmRemove(true)} disabled={busy}>Remove from Cycle</button>
          </div>
        </form>
      )}
      {readOnly && (
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      )}
      {confirmRemove && (
        <ConfirmModal
          title="Remove test case from cycle?"
          message={<p>Remove <strong>{tc?.test_case_key || `Test Case #${execution.test_case_id}`}</strong> and its recorded result from this cycle?</p>}
          confirmLabel="Remove from cycle" cancelLabel="Keep in cycle" destructive busy={busy}
          onConfirm={remove} onCancel={() => setConfirmRemove(false)}
        />
      )}
    </Modal>
  )
}

function BulkExecutionModal({ cycleId, executions, onClose, onExecuted }: {
  cycleId: number
  executions: TestExecutionOut[]
  onClose: () => void
  onExecuted: (executions: TestExecutionOut[]) => void
}) {
  type BulkExecutionStage = 'edit' | 'confirm' | 'executing' | 'success' | 'error'
  const [selectedExecutions] = useState(executions)
  const [stage, setStage] = useState<BulkExecutionStage>('edit')
  const [status, setStatus] = useState('')
  const [actualResult, setActualResult] = useState('')
  const [artifacts, setArtifacts] = useState('')
  const [defectId, setDefectId] = useState('')
  const [defectUrl, setDefectUrl] = useState('')
  const [defectTitle, setDefectTitle] = useState('')
  const [defectStatus, setDefectStatus] = useState('Open')
  const [defectNotes, setDefectNotes] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting to start')

  // Same lock/gate as the single-execution path (executionStatusGate) --
  // checked for the whole selection so a blocked bulk status change is
  // caught before Confirm rather than after the backend rejects it (which
  // still happens regardless, see _execution_status_gate).
  const defectBlocked = selectedExecutions
    .map((execution) => ({ execution, violation: executionStatusGate(execution.linked_defects, execution.runs, status, defectId) }))
    .filter((row): row is { execution: TestExecutionOut; violation: string } => !!row.violation)

  function review(e: React.FormEvent) {
    e.preventDefault()
    if (!status) { setError(new Error('Select an execution result')); return }
    if (actualResult.length > 10000) { setError(new Error('Actual Result cannot exceed 10,000 characters')); return }
    if (defectBlocked.length) {
      setError(new Error(
        `Cannot record '${status}': ` + defectBlocked
          .map((row) => `${row.execution.test_case?.test_case_key || `#${row.execution.test_case_id}`} (${row.violation})`)
          .join('; '),
      ))
      return
    }
    setError(null)
    setStage('confirm')
  }

  async function execute() {
    setError(null)
    setStage('executing')
    setProgress(8)
    setProgressMessage('Validating testcase ownership and readiness…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 62 ? 'Recording retained execution attempts…' : 'Validating the complete selection…')
        return next
      })
    }, 280)
    try {
      const saved = await api.post<TestExecutionOut[]>(`/api/test-execution/cycles/${cycleId}/executions/bulk-result`, {
        execution_ids: selectedExecutions.map((execution) => execution.id),
        status,
        actual_result: actualResult || null,
        test_run_artifacts: artifacts || null,
        defect_id: ['Fail', 'Blocked'].includes(status) ? defectId || null : null,
        defect_url: ['Fail', 'Blocked'].includes(status) ? defectUrl || null : null,
        defect_title: ['Fail', 'Blocked'].includes(status) ? defectTitle || null : null,
        defect_status: ['Fail', 'Blocked'].includes(status) && defectId ? defectStatus : null,
        defect_notes: ['Fail', 'Blocked'].includes(status) ? defectNotes || null : null,
      })
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${saved.length} testcase attempt${saved.length !== 1 ? 's' : ''} recorded as ${status}`)
      onExecuted(saved)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'executing' ? 'Executing selected testcases'
    : stage === 'success' ? 'Bulk execution completed'
      : stage === 'error' ? 'Bulk execution stopped'
        : stage === 'confirm' ? 'Confirm bulk execution'
          : `Bulk execute ${selectedExecutions.length} testcase${selectedExecutions.length !== 1 ? 's' : ''}`
  const preview = selectedExecutions.slice(0, 6).map((execution) => execution.test_case?.test_case_key || `#${execution.test_case_id}`)

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose wide>
      {stage === 'edit' && (
        <form onSubmit={review}>
          <div className="tm-bulk-confirm-count"><strong>{selectedExecutions.length}</strong><span>assigned testcase{selectedExecutions.length !== 1 ? 's' : ''} selected for a new attempt</span></div>
          <Field label="Execution Result *">
            <select required value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="" disabled>Select result…</option>
              {TEST_EXECUTION_STATUSES.filter((item) => item !== 'Not Executed').map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </Field>
          <Field label="Common Actual Result">
            <JiraRichTextField value={actualResult} onChange={setActualResult} onImagesChange={() => undefined} allowImages={false} />
          </Field>
          <Field label="Common Test Run Artifact">
            <input maxLength={255} value={artifacts} onChange={(event) => setArtifacts(event.target.value)} placeholder="Shared link, build number, filename, or reference" />
          </Field>
          {['Fail', 'Blocked'].includes(status) && <div className="tm-new-attempt-defect">
            <div className="tm-new-attempt-defect-head"><strong>Link one shared defect</strong><span>Optional · Added to every selected attempt</span></div>
            <div className="grid grid-2"><Field label="Defect Key"><input value={defectId} onChange={(event) => setDefectId(event.target.value)} placeholder="e.g. JIRA-142" /></Field><Field label="Defect Status"><select value={defectStatus} onChange={(event) => setDefectStatus(event.target.value)}><option>Open</option><option>In Progress</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select></Field></div>
            <Field label="Defect URL"><input type="url" value={defectUrl} onChange={(event) => setDefectUrl(event.target.value)} placeholder="https://jira.example/browse/JIRA-142" /></Field>
            <Field label="Defect Title"><input maxLength={255} value={defectTitle} onChange={(event) => setDefectTitle(event.target.value)} placeholder="Short defect summary" /></Field>
            <Field label="Defect Notes"><textarea maxLength={5000} value={defectNotes} onChange={(event) => setDefectNotes(event.target.value)} /></Field>
          </div>}
          <div className="info-banner">Bulk execution records the same result as a separate retained attempt on every selected testcase. Add testcase-specific screenshots or defects from the individual runner afterward.</div>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary">Review bulk execution</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {stage === 'confirm' && (
        <div className="tm-bulk-confirm">
          <div className="tm-bulk-confirm-count"><strong>{selectedExecutions.length}</strong><span>new attempt{selectedExecutions.length !== 1 ? 's' : ''} will be recorded as {status}</span></div>
          <p>Selected testcases: {preview.join(', ')}{selectedExecutions.length > preview.length ? ` and ${selectedExecutions.length - preview.length} more` : ''}.</p>
          <ul>
            <li>Existing attempts and evidence will remain unchanged.</li>
            <li>The operation is atomic: validation failure means no testcase is updated.</li>
            <li>Only testcases currently assigned to you can be executed together.</li>
          </ul>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={execute}>Confirm and execute</button>
            <button className="btn" onClick={() => setStage('edit')}>Back</button>
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
      {(stage === 'executing' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk execution progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Please keep this dialog open' : 'The new attempts are now visible in this cycle'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>No execution attempt was recorded</strong>
          <p className="muted small">The complete selection remains unchanged because bulk execution is atomic.</p>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk execution stopped progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>Stopped during validation or saving</span><strong>{progress}%</strong></div>
          <div className="tm-operation-error"><strong>Exact reason</strong><p>{errorReason}</p></div>
          <div className="action-error-guidance"><strong>What to do</strong><p>Resolve the listed assignment or approval issue, or select only eligible testcases, then try again.</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={execute}>Try again</button>
            <button className="btn" onClick={() => { setError(null); setStage('edit') }}>Change result</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

interface BulkRemoveResult {
  removed_count: number
  removed_execution_ids: number[]
  removed_test_case_keys: string[]
  removed_attempt_count: number
  removed_evidence_count: number
}

function BulkRemoveModal({ cycleId, cycleKey, executions, onClose, onRemoved }: {
  cycleId: number
  cycleKey: string
  executions: TestExecutionOut[]
  onClose: () => void
  onRemoved: (result: BulkRemoveResult) => void
}) {
  type BulkRemoveStage = 'confirm' | 'removing' | 'success' | 'error'
  const [selectedExecutions] = useState(executions)
  const [stage, setStage] = useState<BulkRemoveStage>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<BulkRemoveResult | null>(null)
  const runCount = selectedExecutions.reduce((total, execution) => total + (execution.run_count || execution.runs?.length || 0), 0)
  const defectCount = selectedExecutions.reduce((total, execution) => total + (execution.runs || []).reduce((runTotal, run) => runTotal + (run.defects?.length || 0), 0), 0)
  const preview = selectedExecutions.slice(0, 6).map((execution) => execution.test_case?.test_case_key || `#${execution.test_case_id}`)

  async function remove() {
    setError(null)
    setStage('removing')
    setProgress(8)
    setProgressMessage('Validating cycle membership and permissions…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 62 ? 'Removing testcase history and evidence…' : 'Preparing the atomic removal…')
        return next
      })
    }, 280)
    try {
      const saved = await api.post<BulkRemoveResult>(`/api/test-execution/cycles/${cycleId}/executions/bulk-remove`, {
        execution_ids: selectedExecutions.map((execution) => execution.id),
      })
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${saved.removed_count} testcase${saved.removed_count !== 1 ? 's' : ''} removed from ${cycleKey}`)
      setResult(saved)
      onRemoved(saved)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'removing' ? 'Removing testcases from cycle'
    : stage === 'success' ? 'Bulk removal completed'
      : stage === 'error' ? 'Bulk removal stopped'
        : `Remove ${selectedExecutions.length} testcase${selectedExecutions.length !== 1 ? 's' : ''} from ${cycleKey}?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <div className="tm-bulk-confirm">
          <div className="tm-bulk-confirm-count"><strong>{selectedExecutions.length}</strong><span>testcase{selectedExecutions.length !== 1 ? 's' : ''} will leave this test cycle</span></div>
          <p>Selected testcases: {preview.join(', ')}{selectedExecutions.length > preview.length ? ` and ${selectedExecutions.length - preview.length} more` : ''}.</p>
          <div className="action-error-dialog" role="alert">
            <div className="action-error-dialog-icon">!</div>
            <div><strong>This permanently removes lifecycle history</strong><span>Removal impact</span><p>{runCount} execution attempt{runCount !== 1 ? 's' : ''}, {defectCount} linked defect{defectCount !== 1 ? 's' : ''}, and all attached execution evidence for these cycle entries will be deleted. Repository testcase definitions are not deleted.</p></div>
          </div>
          <p className="muted small">The database operation is atomic. If validation or saving fails, every selected cycle entry remains unchanged.</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-danger" onClick={remove}>Remove from cycle</button>
            <button className="btn" onClick={onClose}>Keep testcases</button>
          </div>
        </div>
      )}
      {(stage === 'removing' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk removal progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Please keep this dialog open' : `${result?.removed_attempt_count || 0} attempts and ${result?.removed_evidence_count || 0} evidence files removed`}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was removed</strong>
          <p className="muted small">The complete selection remains in the cycle because bulk removal is atomic.</p>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk removal stopped progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>Stopped during validation or saving</span><strong>{progress}%</strong></div>
          <div className="tm-operation-error"><strong>Exact reason</strong><p>{errorReason}</p></div>
          <div className="action-error-guidance"><strong>What to do</strong><p>Confirm that the project is active and every selected testcase still belongs to this cycle, then try again.</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={remove}>Try again</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export default function TestExecution() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  // SRS PRJ-005/GOV-001 -- a project's own membership role can further
  // restrict a QA_ENGINEER/QA_LEAD on THIS specific project, same pattern as
  // TestRepository.tsx's own `myAccess`. Defaults permissive while loading.
  const [myAccess, setMyAccess] = useState<TestProjectMyAccessOut | null>(null)
  const canExec = hasRole(user, ...CAN_EXEC_ROLES) && (myAccess?.can_execute ?? true)
  const canDeleteCycle = hasRole(user, ...CAN_EXEC_ROLES) && (myAccess?.can_manage_execution_governance ?? false)
  const canManageRunners = hasRole(user, ...CAN_EXEC_ROLES)
    && (user?.roles.includes('ADMIN') || user?.department === QA_DEPARTMENT)
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [projectId, setProjectId] = useState<number | ''>('')
  const [cycles, setCycles] = useState<TestCycleOut[]>([])
  const [cycleId, setCycleId] = useState<number | ''>('')
  const [cases, setCases] = useState<TestCaseListOut[]>([])
  // SRS 7.2 pagination rollout -- the folder-tree-style "everything at
  // once" fetch is gone; existingCaseIds and executionSummary now come from
  // their own small dedicated endpoints (see loadExecutionExtras below)
  // instead of being derived from the complete (now paginated) execution
  // list.
  const [existingCaseIds, setExistingCaseIds] = useState<Set<number>>(new Set())
  const [executionSummary, setExecutionSummary] = useState<TestExecutionSummaryOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [showNewCycle, setShowNewCycle] = useState(false)
  const [editingCycle, setEditingCycle] = useState<TestCycleOut | null>(null)
  const [showAddCases, setShowAddCases] = useState(false)
  const [editingExecution, setEditingExecution] = useState<TestExecutionOut | null>(null)
  const [resultFilter, setResultFilter] = useState('')
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'mine' | 'unassigned'>('all')
  const [cycleToDelete, setCycleToDelete] = useState<TestCycleOut | null>(null)
  const [deletingCycle, setDeletingCycle] = useState(false)
  const [selectedExecutionIds, setSelectedExecutionIds] = useState<Set<number>>(new Set())
  const [bulkAssigneeId, setBulkAssigneeId] = useState('')
  const [bulkAssigning, setBulkAssigning] = useState(false)
  const [showBulkExecution, setShowBulkExecution] = useState(false)
  const [bulkRemoveExecutions, setBulkRemoveExecutions] = useState<TestExecutionOut[] | null>(null)
  const [cycleActivity, setCycleActivity] = useState<ApprovalActionOut[]>([])
  const [showActivity, setShowActivity] = useState(false)
  const [cycleSidebarCollapsed, setCycleSidebarCollapsed] = useState(false)
  const [users, setUsers] = useState<UserOut[]>([])
  const [exportingCycle, setExportingCycle] = useState(false)
  const [unlinkingCycleLink, setUnlinkingCycleLink] = useState(false)
  const [qaRequests, setQaRequests] = useState<QARequestListOut[]>([])
  const [linkingExistingExecution, setLinkingExistingExecution] = useState<TestExecutionOut | null>(null)

  useEffect(() => {
    // SRS 7.2 pagination rollout -- /api/test-projects is now wrapped in
    // Page[T] for API-contract consistency (task #82); page_size=100 +
    // .items since this project picker still wants the complete list.
    api.get<PageOut<TestProjectOut>>('/api/test-projects?include_inactive=true&page_size=100').then((page) => {
      const p = page.items
      setProjects(p)
      const requested = Number(searchParams.get('project'))
      if (p.length && !projectId) setProjectId(p.some((x) => x.id === requested) ? requested : p[0].id)
    }).catch(setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  useEffect(() => {
    // Test Management-scoped picker (Cycle owner, runner assignment) -- see
    // constants.TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS on the backend.
    api.get<UserOut[]>('/api/test-projects/eligible-users').then(setUsers).catch(setError)
    // SRS PAG-002 -- /api/qa-requests is now paginated (max page_size 100);
    // this Cycle-creation picker wants "effectively all of them," so it
    // asks for the max size directly rather than one page at a time.
    api.get<PageOut<QARequestListOut>>('/api/qa-requests?page_size=100').then((p) => setQaRequests(p.items)).catch(setError)
  }, [])

  useEffect(() => {
    if (!projectId) { setMyAccess(null); return }
    let active = true
    api.get<TestProjectMyAccessOut>(`/api/test-projects/${projectId}/my-access`)
      .then((access) => { if (active) setMyAccess(access) })
      .catch(() => { if (active) setMyAccess(null) })
    return () => { active = false }
  }, [projectId])

  const loadCycles = useCallback(async (pid: number) => {
    try {
      const [cPage, cs] = await Promise.all([
        // SRS 7.2 pagination rollout -- Page[T] wrapper (task #82);
        // page_size=100 + .items since the cycle sidebar still wants the
        // complete list.
        api.get<PageOut<TestCycleOut>>(`/api/test-execution/projects/${pid}/cycles?page_size=100`),
        // PAG-010 -- the unpaginated candidate-pool endpoint, not the
        // paginated browsing list TestRepository.tsx itself now uses. This
        // modal's "Add test cases to cycle" picker needs every eligible
        // case in the project at once (bulk multi-select), not one page.
        api.get<TestCaseListOut[]>(`/api/test-repository/projects/${pid}/test-cases/all`),
      ])
      const c = cPage.items
      setCycles(c); setCases(cs)
      const requestedCycle = Number(searchParams.get('cycle'))
      setCycleId(c.some((cycle) => cycle.id === requestedCycle) ? requestedCycle : (c.length ? c[0].id : ''))
    } catch (err) { setError(err) }
  }, [searchParams])
  useEffect(() => { if (projectId) loadCycles(projectId) }, [projectId, loadCycles])

  // SRS 7.2 pagination rollout -- the main execution list is now
  // server-paginated/server-filtered (status/assignment become query params
  // instead of an in-browser .filter() over the whole cycle).
  const {
    items: executions, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading: executionsLoading, setPage, setPageSize, reload: reloadExecutions,
  } = usePaginatedList<TestExecutionOut>(
    cycleId ? `/api/test-execution/cycles/${cycleId}/executions` : '',
    {
      status: resultFilter ? [resultFilter] : undefined,
      // Preserves the original ascending-by-id (add order) list order --
      // every other paginated list in this app defaults to newest-first,
      // which would reorder testcases within a cycle unexpectedly here.
      sortOrder: 'asc',
      extra: { assignment: assignmentFilter !== 'all' ? assignmentFilter : undefined },
    },
  )
  const loadExecutionExtras = useCallback(async (cid: number) => {
    try {
      const [ids, summaryData] = await Promise.all([
        api.get<number[]>(`/api/test-execution/cycles/${cid}/executions/case-ids`),
        api.get<TestExecutionSummaryOut>(`/api/test-execution/cycles/${cid}/executions/summary`),
      ])
      setExistingCaseIds(new Set(ids))
      setExecutionSummary(summaryData)
    } catch (err) { setError(err) }
  }, [])
  const refreshExecutions = useCallback(() => {
    reloadExecutions()
    if (cycleId) loadExecutionExtras(cycleId)
  }, [reloadExecutions, loadExecutionExtras, cycleId])
  useEffect(() => {
    if (cycleId) {
      loadExecutionExtras(cycleId)
      api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => setCycleActivity([]))
    } else { setExistingCaseIds(new Set()); setExecutionSummary(null); setCycleActivity([]) }
  }, [cycleId, loadExecutionExtras])
  // Defect traceability deep-link -- fetches the specific execution by id
  // directly (PAG-006-style) rather than searching the loaded page, since
  // the target row may not be on whatever page/filter happens to be active.
  useEffect(() => {
    const requestedExecution = Number(searchParams.get('execution'))
    if (!requestedExecution) return
    let active = true
    api.get<TestExecutionOut>(`/api/test-execution/executions/${requestedExecution}`)
      .then((target) => { if (active) setEditingExecution(target) })
      .catch((err) => { if (active) setError(err) })
    setSearchParams((params) => { params.delete('execution'); return params }, { replace: true })
    return () => { active = false }
  }, [searchParams, setSearchParams])
  // Selection is only ever meaningful against whatever's currently loaded --
  // same reasoning as Test Repository's own equivalent effect.
  useEffect(() => {
    setSelectedExecutionIds(new Set())
  }, [resultFilter, assignmentFilter, page, pageSize])
  useEffect(() => {
    setSelectedExecutionIds(new Set())
    setShowBulkExecution(false)
    setBulkRemoveExecutions(null)
    setShowActivity(false)
  }, [cycleId, projectId])

  // SRS 7.2 pagination rollout -- every one of these used to be computed
  // in-browser from the complete (unpaginated) cycle execution list; now
  // they all come from executionSummary (see loadExecutionExtras above),
  // which stays accurate regardless of which page/status/assignment filter
  // the main list currently has selected. "Visible" now means "on the
  // current page" -- the list itself already IS the filtered/paginated
  // result (status/assignment are server-side query params now), so no
  // separate `filteredExecutions` client-filter step is needed any more.
  const cycleAuditActivity = useMemo(() => cycleActivity.filter((item) => (
    item.decision === 'Commented'
    || ['Cycle', 'Cycle Details', 'Lifecycle', 'Request Link'].includes(item.step_name || '')
  )), [cycleActivity])
  const filteredExecutions = executions
  const executedCount = executionSummary?.executed_count ?? 0
  const passCount = (executionSummary?.status_counts.Pass || 0) + (executionSummary?.status_counts['Retest Passed'] || 0)
  const passRate = executedCount ? Math.round((passCount / executedCount) * 100) : 0
  const assignedCount = executionSummary?.assigned_count ?? 0
  const unassignedCount = executionSummary?.unassigned_count ?? 0
  const myAssignmentCount = executionSummary?.mine_count ?? 0
  const totalRunCount = executionSummary?.total_run_count ?? 0
  const cycleExecutionTotal = executionSummary?.total ?? 0
  const selectedCycle = cycles.find((c) => c.id === cycleId)
  const cycleIsLocked = !!selectedCycle && TEST_CYCLE_LOCKED_STATUSES.includes(selectedCycle.status)
  const cycleIsCompleted = selectedCycle?.status === 'Completed'
  const selectedProject = projects.find((project) => project.id === projectId)
  const projectIsActive = !!selectedProject?.is_active
  const runnerCandidates = useMemo(() => users.filter((candidate) => (
    candidate.department === QA_DEPARTMENT
    && candidate.is_active
    && candidate.roles.some((role) => ['QA_ENGINEER', 'QA_LEAD', 'CHEIF_MANAGER_QA'].includes(role))
  )), [users])
  const canExecuteRow = useCallback((execution: TestExecutionOut) => (
    canExec && projectIsActive && selectedCycle?.status === 'In Progress'
    && (!!user?.roles.includes('ADMIN') || execution.assigned_to_id === user?.id)
  ), [canExec, projectIsActive, selectedCycle?.status, user])
  const canSelectRow = useCallback((execution: TestExecutionOut) => (
    !cycleIsLocked && (canManageRunners || canExecuteRow(execution))
  ), [canExecuteRow, canManageRunners, cycleIsLocked])
  const selectableExecutions = filteredExecutions.filter(canSelectRow)
  const selectedExecutions = executions.filter((execution) => selectedExecutionIds.has(execution.id))
  const bulkExecutionEligible = selectedExecutions.length > 0 && selectedExecutions.every(canExecuteRow)
  const allVisibleSelected = selectableExecutions.length > 0
    && selectableExecutions.every((execution) => selectedExecutionIds.has(execution.id))

  function toggleExecutionSelection(executionId: number) {
    setSelectedExecutionIds((current) => {
      const next = new Set(current)
      if (next.has(executionId)) next.delete(executionId); else next.add(executionId)
      return next
    })
  }

  function toggleVisibleExecutions() {
    setSelectedExecutionIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) selectableExecutions.forEach((execution) => next.delete(execution.id))
      else selectableExecutions.forEach((execution) => next.add(execution.id))
      return next
    })
  }

  async function assignRunner(execution: TestExecutionOut, value: string) {
    setError(null)
    try {
      const saved = await api.patch<TestExecutionOut>(`/api/test-execution/executions/${execution.id}/assign`, {
        assigned_to_id: value ? Number(value) : null,
      })
      refreshExecutions()
      setEditingExecution((current) => current?.id === saved.id ? saved : current)
      if (cycleId) api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
    } catch (err) { setError(err) }
  }

  async function bulkAssignSelected() {
    if (!cycleId || !bulkAssigneeId || selectedExecutionIds.size === 0) return
    setBulkAssigning(true); setError(null)
    try {
      await api.post<TestExecutionOut[]>(`/api/test-execution/cycles/${cycleId}/executions/bulk-assign`, {
        execution_ids: Array.from(selectedExecutionIds),
        assigned_to_id: Number(bulkAssigneeId),
      })
      refreshExecutions()
      setSelectedExecutionIds(new Set())
      api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
    } catch (err) { setError(err) } finally { setBulkAssigning(false) }
  }

  async function deleteCycle() {
    if (!cycleToDelete) return
    const cycle = cycleToDelete
    setError(null)
    setDeletingCycle(true)
    try {
      await api.del(`/api/test-execution/cycles/${cycle.id}`)
      const remaining = cycles.filter((c) => c.id !== cycle.id)
      setCycles(remaining)
      setCycleId(remaining[0]?.id || '')
      setCycleToDelete(null)
    } catch (err) { setError(err); setCycleToDelete(null) } finally { setDeletingCycle(false) }
  }

  async function exportCycle() {
    if (!cycleId || !selectedCycle) return
    setExportingCycle(true); setError(null)
    try {
      await api.downloadFile(
        `/api/test-execution/cycles/${cycleId}/export-xlsx`,
        `${selectedCycle.cycle_key}_test_lifecycle.xlsx`,
      )
    } catch (err) { setError(err) } finally { setExportingCycle(false) }
  }

  async function unlinkCycleRequest() {
    if (!selectedCycle?.linked_request_key) return
    if (!window.confirm(`Unlink ${selectedCycle.linked_request_key} from ${selectedCycle.cycle_key}? Test cases and execution history will remain unchanged.`)) return
    setUnlinkingCycleLink(true); setError(null)
    try {
      const saved = await api.del<TestCycleOut>(`/api/test-execution/cycles/${selectedCycle.id}/request-link`)
      setCycles((current) => current.map((cycle) => cycle.id === saved.id ? saved : cycle))
      api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${selectedCycle.id}`).then(setCycleActivity).catch(() => undefined)
    } catch (err) { setError(err) } finally { setUnlinkingCycleLink(false) }
  }

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        title="Test Execution" count={cycleExecutionTotal}
        subtitle="Organize test cycles, execute step-by-step, capture evidence, and connect failures to defects."
        actions={(
          <div style={{ display: 'flex', gap: 8 }}>
            <SearchableSelect
              value={projectId === '' ? '' : String(projectId)}
              onChange={(v) => setProjectId(v ? Number(v) : '')}
              placeholder={projects.length === 0 ? 'No Test Projects yet' : 'Select a project...'}
              style={{ minWidth: 220 }}
              options={projects.map((p) => ({
                value: String(p.id),
                label: `${p.project_key} -- ${p.name}${p.is_active ? '' : ' [Inactive]'}`,
              }))}
            />
            {canExec && projectId && projectIsActive && (
              <button className="btn" onClick={() => setShowNewCycle(true)}>+ Cycle</button>
            )}
          </div>
        )}
      />
      {projectId && !projectIsActive && (
        <div className="info-banner">This project is inactive. Existing cycles and results are read-only until the project is reactivated.</div>
      )}
      {projectId && (
        <div className={`tm-workspace tm-execution-workspace${cycleSidebarCollapsed ? ' cycle-sidebar-collapsed' : ''}`}>
          <aside className="tm-tree-panel tm-cycle-panel">
            <div className="tm-cycle-sidebar-head">
              {!cycleSidebarCollapsed && <div><small>Execution sets</small><strong>Test Cycles</strong></div>}
              <div className="tm-cycle-sidebar-tools">
                {!cycleSidebarCollapsed && <span>{cycles.length}</span>}
                <button
                  type="button"
                  className="tm-tree-collapse"
                  onClick={() => setCycleSidebarCollapsed((collapsed) => !collapsed)}
                  aria-expanded={!cycleSidebarCollapsed}
                  aria-label={cycleSidebarCollapsed ? 'Expand test cycles' : 'Collapse test cycles'}
                  title={cycleSidebarCollapsed ? 'Expand test cycles' : 'Collapse test cycles'}
                >{cycleSidebarCollapsed ? '›' : '‹'}</button>
              </div>
            </div>
            {!cycleSidebarCollapsed && <div className="tm-cycle-list">
              {cycles.map((cycle) => (
                <div className="tm-cycle-row" key={cycle.id}>
                  <button className={cycleId === cycle.id ? 'active' : ''} onClick={() => setCycleId(cycle.id)}>
                    <span><strong>{cycle.name}</strong><small>{cycle.cycle_key}</small></span><Badge status={cycle.status} />
                  </button>
                  {canDeleteCycle && projectIsActive && !TEST_CYCLE_LOCKED_STATUSES.includes(cycle.status) && <button className="tm-cycle-delete" title="Delete test cycle" aria-label={`Delete ${cycle.name}`} onClick={() => setCycleToDelete(cycle)}>×</button>}
                </div>
              ))}
              {cycles.length === 0 && <p>No cycles created yet.</p>}
            </div>}
            {!cycleSidebarCollapsed && canExec && projectIsActive && <button className="tm-tree-add" onClick={() => setShowNewCycle(true)}>+ Create cycle</button>}
          </aside>
          <section className="tm-main-panel">
          {cycleId ? (
            <>
              <div className="tm-cycle-header tm-cycle-command">
                <div>
                  <span>{selectedCycle?.cycle_key}</span>
                  <h3>{selectedCycle?.name}</h3>
                  <p>{selectedCycle?.description || 'Execute and monitor the selected test set.'}</p>
                  <div className="tm-cycle-meta">
                    {selectedCycle && (canExec && projectIsActive && !cycleIsCompleted ? (
                      <CycleStatusControl cycle={selectedCycle} onChanged={(saved) => {
                        setCycles((current) => current.map((cycle) => cycle.id === saved.id ? saved : cycle))
                        api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${saved.id}`).then(setCycleActivity).catch(() => undefined)
                      }} onError={setError} />
                    ) : (
                      <Badge status={selectedCycle?.status} />
                    ))}
                    {selectedCycle?.cycle_type && <span className="badge badge-gray">{selectedCycle.cycle_type}</span>}
                    {selectedCycle?.environment && <span className="badge badge-gray">{selectedCycle.environment}</span>}
                    {selectedCycle?.build && <span className="badge badge-gray">Build {selectedCycle.build}</span>}
                    {selectedCycle?.owner_name && <span className="badge badge-gray">Owner: {selectedCycle.owner_name}</span>}
                  </div>
                  {selectedCycle?.linked_request_key && <div className="tm-cycle-request-link"><b>Linked {selectedCycle.linked_request_type}</b><strong>{selectedCycle.linked_request_key}</strong>{canExec && projectIsActive && !cycleIsLocked && <button type="button" disabled={unlinkingCycleLink} onClick={unlinkCycleRequest}>{unlinkingCycleLink ? 'Unlinking…' : 'Unlink'}</button>}</div>}
                  {cycleIsLocked && (
                    <div className="info-banner">
                      {selectedCycle?.status === 'Blocked'
                        ? <>This cycle is <strong>Blocked</strong>. Assignment, editing, execution, testcase, defect, evidence, and link changes are disabled until Resume Execution.</>
                        : <>This cycle is <strong>Completed</strong> and read-only. No further changes are allowed.</>}
                    </div>
                  )}
                </div>
                <div className="tm-cycle-command-actions">
                  {canExec && projectIsActive && !cycleIsLocked && <button className="btn" onClick={() => selectedCycle && setEditingCycle(selectedCycle)}>Edit Cycle</button>}
                  <button className="btn" onClick={exportCycle} disabled={exportingCycle}>
                    {exportingCycle ? 'Exporting…' : 'Export Lifecycle'}
                  </button>
                  {canExec && projectIsActive && !cycleIsLocked && <button className="btn btn-primary" onClick={() => setShowAddCases(true)}>+ Add test cases</button>}
                </div>
              </div>
              <div className="tm-execution-kpis">
                <div><small>Progress</small><strong>{executedCount}<span> / {cycleExecutionTotal}</span></strong><i><b style={{ width: `${cycleExecutionTotal ? (executedCount / cycleExecutionTotal) * 100 : 0}%` }} /></i></div>
                <div><small>Pass rate</small><strong>{passRate}%</strong><span>{passCount} passed</span></div>
                <div className={((executionSummary?.status_counts.Fail || 0) || (executionSummary?.status_counts.Blocked || 0)) ? 'needs-attention' : ''}><small>Needs attention</small><strong>{(executionSummary?.status_counts.Fail || 0) + (executionSummary?.status_counts.Blocked || 0)}</strong><span>{executionSummary?.status_counts.Fail || 0} failed · {executionSummary?.status_counts.Blocked || 0} blocked</span></div>
                <div className={unassignedCount ? 'needs-attention' : ''}><small>Assignment</small><strong>{assignedCount}<span> / {cycleExecutionTotal}</span></strong><span>{unassignedCount ? `${unassignedCount} unassigned` : 'Fully assigned'}</span></div>
                <div><small>My queue</small><strong>{myAssignmentCount}</strong><span>Assigned to me</span></div>
                <div><small>Total attempts</small><strong>{totalRunCount}</strong><span>Complete run history</span></div>
              </div>
              <section className="tm-testcase-workbench">
              <div className="tm-workbench-head">
                <div><small>Execution scope</small><h4>Cycle Testcases <span>{total} of {cycleExecutionTotal}</span></h4></div>
                <div className="tm-assignment-filters">
                  <button className={assignmentFilter === 'all' ? 'active' : ''} onClick={() => setAssignmentFilter('all')}>All <em>{cycleExecutionTotal}</em></button>
                  <button className={assignmentFilter === 'mine' ? 'active' : ''} onClick={() => setAssignmentFilter('mine')}>Mine <em>{myAssignmentCount}</em></button>
                  <button className={assignmentFilter === 'unassigned' ? 'active' : ''} onClick={() => setAssignmentFilter('unassigned')}>Unassigned <em>{unassignedCount}</em></button>
                </div>
              </div>
              <div className="tm-result-tabs">
                <button className={!resultFilter ? 'active' : ''} onClick={() => setResultFilter('')}>All <span>{cycleExecutionTotal}</span></button>
                {TEST_EXECUTION_STATUSES.map((s) => <button key={s} className={resultFilter === s ? 'active' : ''} onClick={() => setResultFilter(s)}>{s} <span>{executionSummary?.status_counts[s] || 0}</span></button>)}
              </div>
              {selectedCycle && <LinkedDefects query={`cycle_id=${selectedCycle.id}`} title="Cycle Defects" />}
              {canExec && projectIsActive && !cycleIsLocked && (
                <div className="tm-bulk-bar" role="region" aria-label="Bulk testcase lifecycle actions">
                  <strong>{selectedExecutionIds.size ? `${selectedExecutionIds.size} testcase${selectedExecutionIds.size !== 1 ? 's' : ''} selected` : 'Select rows to assign, execute, or remove in bulk'}</strong>
                  <button type="button" className="btn btn-sm" disabled={!selectableExecutions.length} onClick={toggleVisibleExecutions}>{allVisibleSelected ? 'Clear visible' : `Select visible (${selectableExecutions.length})`}</button>
                  {selectedExecutionIds.size > 0 && <button type="button" className="btn btn-sm" onClick={() => setSelectedExecutionIds(new Set())}>Clear selection</button>}
                  {canManageRunners && selectedExecutionIds.size > 0 && (
                    <div className="tm-bulk-assign-group">
                      <SearchableSelect
                        value={bulkAssigneeId}
                        onChange={setBulkAssigneeId}
                        placeholder="Assign selected to…"
                        options={runnerCandidates.map((runner) => ({ value: String(runner.id), label: runner.full_name }))}
                        style={{ minWidth: 190 }}
                      />
                      <button type="button" className="btn btn-sm" disabled={!selectedExecutionIds.size || !bulkAssigneeId || bulkAssigning} onClick={bulkAssignSelected}>
                        {bulkAssigning ? 'Assigning…' : `Assign (${selectedExecutionIds.size})`}
                      </button>
                    </div>
                  )}
                  <button type="button" className="btn btn-sm btn-primary" disabled={!bulkExecutionEligible} title={selectedExecutionIds.size && !bulkExecutionEligible ? 'Bulk execution requires every selected testcase to be assigned to you' : undefined} onClick={() => setShowBulkExecution(true)}>Bulk execute{selectedExecutionIds.size ? ` (${selectedExecutionIds.size})` : ''}</button>
                  {canManageRunners && <button type="button" className="btn btn-sm btn-danger" disabled={!selectedExecutionIds.size} onClick={() => setBulkRemoveExecutions(selectedExecutions)}>Remove from cycle{selectedExecutionIds.size ? ` (${selectedExecutionIds.size})` : ''}</button>}
                </div>
              )}
              <Table<TestExecutionOut>
                rowKey="id"
                onRowClick={setEditingExecution}
                server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange: setPage, onPageSizeChange: setPageSize, loading: executionsLoading }}
                columns={[
                  { key: 'select', header: <input type="checkbox" aria-label="Select all visible testcases" checked={allVisibleSelected} disabled={!selectableExecutions.length} onChange={toggleVisibleExecutions} onClick={(event) => event.stopPropagation()} />, filterable: false, render: (execution) => <input type="checkbox" aria-label={`Select ${execution.test_case?.test_case_key || `testcase ${execution.test_case_id}`}`} checked={selectedExecutionIds.has(execution.id)} disabled={!canSelectRow(execution)} title={canSelectRow(execution) ? 'Select for bulk lifecycle actions' : execution.assigned_to_id ? `Assigned to ${execution.assigned_to_name || 'another runner'}` : 'Assign a runner before execution'} onChange={() => toggleExecutionSelection(execution.id)} onClick={(event) => event.stopPropagation()} /> },
                  { key: 'test_case', header: 'Test Case', render: (e) => <span className="tm-hierarchy-cell"><strong>{e.test_case?.test_case_key || `#${e.test_case_id}`}</strong><small>{[e.test_case?.module_name, `pinned v${e.pinned_version_label || e.test_case?.version || '1.0'}`].filter(Boolean).join(' · ')}{e.is_pinned_stale && <span className="badge badge-yellow" style={{ marginLeft: 6 }} title="A newer Approved version exists">Stale</span>}</small></span>, filterValue: (e) => `${e.test_case?.test_case_key || e.test_case_id} ${e.test_case?.module_name || ''}` },
                  { key: 'scenario', header: 'Scenario', render: (e) => e.test_case?.test_scenario || '—', filterValue: (e) => e.test_case?.test_scenario || '' },
                  { key: 'assigned_to_name', header: 'Assigned To', render: (e) => canManageRunners && projectIsActive && !cycleIsLocked ? <div className="tm-table-assignee" onClick={(event) => event.stopPropagation()}><UserAssignSelect value={e.assigned_to_id ? String(e.assigned_to_id) : ''} onChange={(value) => assignRunner(e, value)} users={runnerCandidates} placeholder="Assign runner…" />{e.assigned_to_id && <button type="button" title="Unassign" onClick={() => assignRunner(e, '')}>×</button>}</div> : <span className={e.assigned_to_name ? '' : 'muted'}>{e.assigned_to_name || 'Unassigned'}</span>, filterValue: (e) => e.assigned_to_name || 'Unassigned' },
                  { key: 'quick_run', header: 'Actions', filterable: false, render: (execution) => <InlineExecutionActions execution={execution} canExecute={canExecuteRow(execution)} onLinkExisting={setLinkingExistingExecution} onError={setError} onChanged={() => refreshExecutions()} /> },
                  { key: 'run_count', header: 'Runs', render: (e) => <span className={`tm-run-count ${e.run_count ? 'has-runs' : ''}`}>{e.run_count || 0}</span> },
                  { key: 'status', header: 'Latest Result', render: (e) => <Badge status={e.status} /> },
                  { key: 'defects', header: 'Defects', render: (e) => { const defects = (e.runs || []).flatMap((run) => run.defects || []); return defects.length ? <span className="tm-table-defects">{defects.slice(-2).map((defect) => defect.defect_key).join(', ')}{defects.length > 2 ? ` +${defects.length - 2}` : ''}</span> : '—' }, filterValue: (e) => (e.runs || []).flatMap((run) => run.defects || []).map((defect) => defect.defect_key).join(' ') },
                  { key: 'executed_by_name', header: 'Last Runner', render: (e) => <span className="tm-hierarchy-cell"><strong>{e.executed_by_name || '—'}</strong><small>{e.executed_at ? new Date(e.executed_at).toLocaleString() : 'Not run yet'}</small></span>, filterValue: (e) => e.executed_by_name || '' },
                ]}
                rows={filteredExecutions}
              />
              </section>
              <section className={`tm-activity-panel ${showActivity ? 'open' : ''}`}>
                <button type="button" className="tm-activity-toggle" onClick={() => setShowActivity((current) => !current)} aria-expanded={showActivity}>
                  <span><strong>Test Cycle Activity & Audit History</strong><small>Cycle comments, details, request links, and lifecycle changes only</small></span>
                  <em>{cycleAuditActivity.length}</em><b>{showActivity ? 'Hide' : 'Show'}</b>
                </button>
                {showActivity && <JiraActivity entityType="TEST_CYCLE" entityId={Number(cycleId)} items={cycleAuditActivity} onPosted={(item) => setCycleActivity((prev) => [...prev, item])} />}
              </section>
            </>
          ) : (
            <div className="tm-empty"><strong>Select or create a test cycle</strong><span>Cycles group test cases for a release, sprint, or regression run.</span></div>
          )}
          </section>
        </div>
      )}
      {showNewCycle && projectId && projectIsActive && (
        <CycleModal
          projectId={projectId}
          requests={qaRequests}
          users={users}
          onClose={() => setShowNewCycle(false)}
          onSaved={(c) => { setCycles((prev) => [c, ...prev]); setCycleId(c.id); setShowNewCycle(false) }}
        />
      )}
      {linkingExistingExecution && cycleId && <LinkExistingDefectModal execution={linkingExistingExecution} onClose={() => setLinkingExistingExecution(null)} onLinked={() => { refreshExecutions(); setLinkingExistingExecution(null) }} />}
      {editingCycle && projectId && projectIsActive && (
        <CycleModal
          projectId={projectId}
          requests={qaRequests}
          users={users}
          editing={editingCycle}
          onClose={() => setEditingCycle(null)}
          onSaved={(saved) => { setCycles((current) => current.map((cycle) => cycle.id === saved.id ? saved : cycle)); setEditingCycle(null) }}
        />
      )}
      {showAddCases && cycleId && projectIsActive && (
        <AddCasesModal
          cycleId={cycleId}
          allCases={cases}
          existingCaseIds={existingCaseIds}
          canAssign={canManageRunners}
          runnerCandidates={runnerCandidates}
          onClose={() => setShowAddCases(false)}
          onAdded={() => { refreshExecutions(); setShowAddCases(false) }}
        />
      )}
      {showBulkExecution && cycleId && selectedExecutions.length > 0 && (
        <BulkExecutionModal
          cycleId={Number(cycleId)}
          executions={selectedExecutions}
          onClose={() => { setShowBulkExecution(false); setSelectedExecutionIds(new Set()) }}
          onExecuted={() => {
            refreshExecutions()
            api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
          }}
        />
      )}
      {bulkRemoveExecutions && cycleId && selectedCycle && (
        <BulkRemoveModal
          cycleId={Number(cycleId)}
          cycleKey={selectedCycle.cycle_key}
          executions={bulkRemoveExecutions}
          onClose={() => { setBulkRemoveExecutions(null); setSelectedExecutionIds(new Set()) }}
          onRemoved={() => {
            refreshExecutions()
            api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
          }}
        />
      )}
      {editingExecution && (
        <RecordResultModal
          execution={editingExecution}
          readOnly={!canExec || !projectIsActive || cycleIsLocked || (!user?.roles.includes('ADMIN') && editingExecution.assigned_to_id !== user?.id)}
          canAssign={canManageRunners && projectIsActive && !cycleIsLocked}
          runnerCandidates={runnerCandidates}
          onAssigned={(saved) => {
            refreshExecutions()
            setEditingExecution(saved)
            if (cycleId) api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
          }}
          onClose={() => setEditingExecution(null)}
          onSaved={() => {
            refreshExecutions()
            setEditingExecution(null)
            if (cycleId) api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
          }}
          onRemoved={() => { refreshExecutions(); setEditingExecution(null) }}
        />
      )}
      {cycleToDelete && (
        <ConfirmModal
          title="Delete test cycle?"
          message={<div><p>Delete <strong>{cycleToDelete.name}</strong>?</p><p className="muted small">Only an empty cycle can be deleted. Recorded execution evidence will never be removed automatically.</p></div>}
          confirmLabel="Delete cycle" cancelLabel="Keep cycle" destructive busy={deletingCycle}
          onConfirm={deleteCycle} onCancel={() => setCycleToDelete(null)}
        />
      )}
    </div>
  )
}
