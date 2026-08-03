import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import { hasRole, TEST_CYCLE_STATUSES, TEST_EXECUTION_STATUSES } from '../../constants'
import { TestProjectOut, TestCaseOut, TestCycleOut, TestExecutionOut, ApprovalActionOut, RequestDocumentOut } from '../../types'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity, { MarkdownComment } from '../../components/JiraActivity'
import JiraRichTextField from '../../components/JiraRichTextField'

// Test Execution module -- Test Cycles under a selected Test Project, each
// holding one result row (Pass/Fail/Blocked/NA/Retest Passed) per test case
// added to it. QA Engineer + QA Lead both execute (Admin bypasses).
const CAN_EXEC_ROLES = ['QA_ENGINEER', 'QA_LEAD']

function NewCycleModal({ projectId, onClose, onCreated }: {
  projectId: number
  onClose: () => void
  onCreated: (c: TestCycleOut) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Cycle name cannot be blank')); return }
    setBusy(true); setError(null)
    try {
      const created = await api.post<TestCycleOut>(`/api/test-execution/projects/${projectId}/cycles`, {
        name: name.trim(), description: description || null,
        start_date: startDate || null, end_date: endDate || null,
      })
      onCreated(created)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Test Cycle" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Cycle Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
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
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating...' : 'Create Cycle'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function AddCasesModal({ cycleId, allCases, existingCaseIds, onClose, onAdded }: {
  cycleId: number
  allCases: TestCaseOut[]
  existingCaseIds: Set<number>
  onClose: () => void
  onAdded: (execs: TestExecutionOut[]) => void
}) {
  const candidates = useMemo(() => allCases.filter((c) => c.status === 'Active' && !existingCaseIds.has(c.id)), [allCases, existingCaseIds])
  const awaitingApproval = useMemo(() => allCases.filter((c) => c.status !== 'Active' && !existingCaseIds.has(c.id)), [allCases, existingCaseIds])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function submit() {
    if (selected.size === 0) { setError(new Error('Pick at least one test case')); return }
    setBusy(true); setError(null)
    try {
      const execs = await api.post<TestExecutionOut[]>(`/api/test-execution/cycles/${cycleId}/executions`, {
        test_case_ids: Array.from(selected),
      })
      onAdded(execs)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="Add Test Cases to Cycle" onClose={onClose} wide>
      {awaitingApproval.length > 0 && (
        <div className="info-banner"><strong>{awaitingApproval.length} testcase{awaitingApproval.length !== 1 ? 's are' : ' is'} unavailable.</strong> QA Lead verification and approval is required before cycle assignment.</div>
      )}
      {candidates.length === 0 ? (
        <p className="muted small">There are no approved testcases available to add. Approve pending testcases in the Test Repository first.</p>
      ) : (
        <table className="simple-table">
          <thead><tr><th /><th>Test Case ID</th><th>Scenario</th><th>Type</th><th>Priority</th></tr></thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.id}>
                <td><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} /></td>
                <td>{c.test_case_key}</td>
                <td>{c.test_scenario || '—'}</td>
                <td>{c.test_type || '—'}</td>
                <td>{c.priority || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

function ExecutionResultImages({ executionId, readOnly }: { executionId: number; readOnly: boolean }) {
  const { user } = useAuth()
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([])
  const [urls, setUrls] = useState<Record<number, string>>({})
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let active = true
    const createdUrls: string[] = []
    async function load() {
      try {
        const docs = await api.get<RequestDocumentOut[]>(`/api/test-execution/executions/${executionId}/result-images`)
        if (!active) return
        setDocuments(docs)
        const loaded = await Promise.all(docs.map(async (document) => {
          const blob = await api.getBlob(`/api/test-execution/executions/${executionId}/result-images/${document.id}/download`)
          const url = URL.createObjectURL(blob)
          createdUrls.push(url)
          return [document.id, url] as const
        }))
        if (active) setUrls(Object.fromEntries(loaded))
      } catch (err) { if (active) setError(err) }
    }
    load()
    return () => { active = false; createdUrls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [executionId])

  async function remove(document: RequestDocumentOut) {
    try {
      setError(null)
      await api.del(`/api/test-execution/executions/${executionId}/result-images/${document.id}`)
      if (urls[document.id]) URL.revokeObjectURL(urls[document.id])
      setDocuments((current) => current.filter((item) => item.id !== document.id))
      setUrls((current) => { const next = { ...current }; delete next[document.id]; return next })
    } catch (err) { setError(err) }
  }

  if (documents.length === 0 && !error) return null
  return (
    <div className="execution-result-images">
      <div className="execution-result-images-title">Saved screenshots <span>{documents.length}</span></div>
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

function RecordResultModal({ execution, readOnly, onClose, onSaved, onRemoved }: {
  execution: TestExecutionOut
  readOnly: boolean
  onClose: () => void
  onSaved: (e: TestExecutionOut) => void
  onRemoved: (id: number) => void
}) {
  const [status, setStatus] = useState(execution.status)
  const [actualResult, setActualResult] = useState(execution.actual_result || '')
  const [artifacts, setArtifacts] = useState(execution.test_run_artifacts || '')
  const [defectId, setDefectId] = useState(execution.defect_id || '')
  const [resultImages, setResultImages] = useState<File[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const saved = await api.uploadFormFiles<TestExecutionOut>(
        `/api/test-execution/executions/${execution.id}/rich-result`,
        { status, actual_result: actualResult, test_run_artifacts: artifacts, defect_id: defectId },
        resultImages,
      )
      onSaved(saved)
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
  return (
    <Modal title={`Record Result -- ${tc?.test_case_key || `Test Case #${execution.test_case_id}`}`} onClose={onClose} wide>
      {tc && (
        <div className="tm-execution-case-summary">
          <div className="tm-execution-case-heading">
            <div><small>Test case definition</small><h4>{tc.test_case_key}</h4></div>
            <Badge status={tc.status} />
          </div>
          <div className="tm-case-detail-grid">
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
      <form onSubmit={submit}>
        <div className="tm-execution-result-heading"><h4>Execution Result</h4>{readOnly && <span>Read only</span>}</div>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={readOnly}>
            {TEST_EXECUTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Actual Result">
          {readOnly ? (
            actualResult ? <MarkdownComment value={actualResult} /> : <span className="muted small">No actual result recorded.</span>
          ) : (
            <JiraRichTextField value={actualResult} onChange={setActualResult} onImagesChange={setResultImages} />
          )}
        </Field>
        <ExecutionResultImages executionId={execution.id} readOnly={readOnly} />
        <Field label="Test Run Artifacts">
          <input value={artifacts} onChange={(e) => setArtifacts(e.target.value)} placeholder="Link, filename, or reference" disabled={readOnly} />
        </Field>
        <Field label="Defect ID (if any)">
          <input value={defectId} onChange={(e) => setDefectId(e.target.value)} disabled={readOnly} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          {!readOnly && <button className="btn btn-primary" disabled={busy || actualResult.length > 10000}>{busy ? 'Saving...' : 'Save Result'}</button>}
          <button type="button" className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && <button type="button" className="btn btn-danger" onClick={() => setConfirmRemove(true)} disabled={busy}>Remove from Cycle</button>}
        </div>
      </form>
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

export default function TestExecution() {
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const canExec = hasRole(user, ...CAN_EXEC_ROLES)
  const canDeleteCycle = hasRole(user, 'QA_LEAD')
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [projectId, setProjectId] = useState<number | ''>('')
  const [cycles, setCycles] = useState<TestCycleOut[]>([])
  const [cycleId, setCycleId] = useState<number | ''>('')
  const [cases, setCases] = useState<TestCaseOut[]>([])
  const [executions, setExecutions] = useState<TestExecutionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [showNewCycle, setShowNewCycle] = useState(false)
  const [showAddCases, setShowAddCases] = useState(false)
  const [editingExecution, setEditingExecution] = useState<TestExecutionOut | null>(null)
  const [resultFilter, setResultFilter] = useState('')
  const [cycleToDelete, setCycleToDelete] = useState<TestCycleOut | null>(null)
  const [deletingCycle, setDeletingCycle] = useState(false)
  const [cycleActivity, setCycleActivity] = useState<ApprovalActionOut[]>([])

  useEffect(() => {
    api.get<TestProjectOut[]>('/api/test-projects?include_inactive=true').then((p) => {
      setProjects(p)
      const requested = Number(searchParams.get('project'))
      if (p.length && !projectId) setProjectId(p.some((x) => x.id === requested) ? requested : p[0].id)
    }).catch(setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const loadCycles = useCallback(async (pid: number) => {
    try {
      const [c, cs] = await Promise.all([
        api.get<TestCycleOut[]>(`/api/test-execution/projects/${pid}/cycles`),
        api.get<TestCaseOut[]>(`/api/test-repository/projects/${pid}/test-cases`),
      ])
      setCycles(c); setCases(cs)
      setCycleId(c.length ? c[0].id : '')
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => { if (projectId) loadCycles(projectId) }, [projectId, loadCycles])

  const loadExecutions = useCallback(async (cid: number) => {
    try {
      const e = await api.get<TestExecutionOut[]>(`/api/test-execution/cycles/${cid}/executions`)
      setExecutions(e)
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    if (cycleId) {
      loadExecutions(cycleId)
      api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => setCycleActivity([]))
    } else { setExecutions([]); setCycleActivity([]) }
  }, [cycleId, loadExecutions])

  const existingCaseIds = useMemo(() => new Set(executions.map((e) => e.test_case_id)), [executions])
  const summary = useMemo(() => {
    const counts: Record<string, number> = {}
    executions.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1 })
    return counts
  }, [executions])
  const filteredExecutions = resultFilter ? executions.filter((e) => e.status === resultFilter) : executions
  const executedCount = executions.filter((e) => e.status !== 'Not Executed').length
  const passCount = (summary.Pass || 0) + (summary['Retest Passed'] || 0)
  const passRate = executedCount ? Math.round((passCount / executedCount) * 100) : 0
  const selectedCycle = cycles.find((c) => c.id === cycleId)
  const selectedProject = projects.find((project) => project.id === projectId)
  const projectIsActive = !!selectedProject?.is_active

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
      setExecutions([])
      setCycleToDelete(null)
    } catch (err) { setError(err); setCycleToDelete(null) } finally { setDeletingCycle(false) }
  }

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        title="Test Execution" count={executions.length}
        subtitle="Plan test cycles, execute step-by-step, capture evidence, and connect failures to defects."
        actions={(
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : '')}>
              {projects.length === 0 && <option value="">No Test Projects yet</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_key} -- {p.name}{p.is_active ? '' : ' [Inactive]'}</option>)}
            </select>
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
        <div className="tm-workspace tm-execution-workspace">
          <aside className="tm-tree-panel tm-cycle-panel">
            <div className="tm-panel-label">Test cycles <em>{cycles.length}</em></div>
            <div className="tm-cycle-list">
              {cycles.map((cycle) => (
                <div className="tm-cycle-row" key={cycle.id}>
                  <button className={cycleId === cycle.id ? 'active' : ''} onClick={() => setCycleId(cycle.id)}>
                    <span><strong>{cycle.name}</strong><small>{cycle.cycle_key}</small></span><Badge status={cycle.status} />
                  </button>
                  {canDeleteCycle && projectIsActive && <button className="tm-cycle-delete" title="Delete test cycle" aria-label={`Delete ${cycle.name}`} onClick={() => setCycleToDelete(cycle)}>×</button>}
                </div>
              ))}
              {cycles.length === 0 && <p>No cycles created yet.</p>}
            </div>
            {canExec && projectIsActive && <button className="tm-tree-add" onClick={() => setShowNewCycle(true)}>+ Create cycle</button>}
          </aside>
          <section className="tm-main-panel">
          {cycleId ? (
            <>
              <div className="tm-cycle-header">
                <div><span>{selectedCycle?.cycle_key}</span><h3>{selectedCycle?.name}</h3><p>{selectedCycle?.description || 'Execute and monitor the selected test set.'}</p></div>
                {canExec && projectIsActive && <button className="btn btn-primary" onClick={() => setShowAddCases(true)}>+ Add test cases</button>}
              </div>
              <div className="tm-execution-summary">
                <div><small>Progress</small><strong>{executedCount}<span> / {executions.length}</span></strong><i><b style={{ width: `${executions.length ? (executedCount / executions.length) * 100 : 0}%` }} /></i></div>
                <div><small>Pass rate</small><strong>{passRate}%</strong><span>{passCount} passed</span></div>
                <div><small>Failed</small><strong className="danger">{summary.Fail || 0}</strong><span>Needs attention</span></div>
                <div><small>Blocked</small><strong className="warning">{summary.Blocked || 0}</strong><span>Waiting on dependency</span></div>
              </div>
              <div className="tm-result-tabs">
                <button className={!resultFilter ? 'active' : ''} onClick={() => setResultFilter('')}>All <span>{executions.length}</span></button>
                {TEST_EXECUTION_STATUSES.map((s) => <button key={s} className={resultFilter === s ? 'active' : ''} onClick={() => setResultFilter(s)}>{s} <span>{summary[s] || 0}</span></button>)}
              </div>
              <Table<TestExecutionOut>
                rowKey="id"
                onRowClick={setEditingExecution}
                columns={[
                  { key: 'test_case', header: 'Test Case ID', render: (e) => e.test_case?.test_case_key || `#${e.test_case_id}`, filterValue: (e) => e.test_case?.test_case_key || String(e.test_case_id) },
                  { key: 'mapping', header: 'Epic / CR / Story', render: (e) => <span className="tm-hierarchy-cell"><strong>{e.test_case?.epic_id || '—'}</strong><small>{[e.test_case?.cr_number, e.test_case?.user_story_id].filter(Boolean).join(' · ') || 'No CR / story'}</small></span>, filterValue: (e) => `${e.test_case?.epic_id || ''} ${e.test_case?.cr_number || ''} ${e.test_case?.user_story_id || ''}` },
                  { key: 'scenario', header: 'Scenario', render: (e) => e.test_case?.test_scenario || '—', filterValue: (e) => e.test_case?.test_scenario || '' },
                  { key: 'status', header: 'Result', render: (e) => <Badge status={e.status} /> },
                  { key: 'defect_id', header: 'Defect ID', render: (e) => e.defect_id || '—' },
                  { key: 'executed_at', header: 'Executed', render: (e) => (e.executed_at ? new Date(e.executed_at).toLocaleString() : '—') },
                ]}
                rows={filteredExecutions}
              />
              <JiraActivity entityType="TEST_CYCLE" entityId={Number(cycleId)} items={cycleActivity} onPosted={(item) => setCycleActivity((prev) => [...prev, item])} />
            </>
          ) : (
            <div className="tm-empty"><strong>Select or create a test cycle</strong><span>Cycles group test cases for a release, sprint, or regression run.</span></div>
          )}
          </section>
        </div>
      )}
      {showNewCycle && projectId && projectIsActive && (
        <NewCycleModal
          projectId={projectId}
          onClose={() => setShowNewCycle(false)}
          onCreated={(c) => { setCycles((prev) => [c, ...prev]); setCycleId(c.id); setShowNewCycle(false) }}
        />
      )}
      {showAddCases && cycleId && projectIsActive && (
        <AddCasesModal
          cycleId={cycleId}
          allCases={cases}
          existingCaseIds={existingCaseIds}
          onClose={() => setShowAddCases(false)}
          onAdded={(execs) => { setExecutions((prev) => [...prev, ...execs]); setShowAddCases(false) }}
        />
      )}
      {editingExecution && (
        <RecordResultModal
          execution={editingExecution}
          readOnly={!canExec || !projectIsActive}
          onClose={() => setEditingExecution(null)}
          onSaved={(e) => { setExecutions((prev) => prev.map((x) => (x.id === e.id ? e : x))); setEditingExecution(null) }}
          onRemoved={(id) => { setExecutions((prev) => prev.filter((x) => x.id !== id)); setEditingExecution(null) }}
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
