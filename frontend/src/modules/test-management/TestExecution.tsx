import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import { hasRole, TEST_CYCLE_STATUSES, TEST_EXECUTION_STATUSES } from '../../constants'
import { TestProjectOut, TestCaseOut, TestCycleOut, TestExecutionOut, ApprovalActionOut } from '../../types'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'

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

function RecordResultModal({ execution, onClose, onSaved, onRemoved }: {
  execution: TestExecutionOut
  onClose: () => void
  onSaved: (e: TestExecutionOut) => void
  onRemoved: (id: number) => void
}) {
  const [status, setStatus] = useState(execution.status)
  const [actualResult, setActualResult] = useState(execution.actual_result || '')
  const [artifacts, setArtifacts] = useState(execution.test_run_artifacts || '')
  const [defectId, setDefectId] = useState(execution.defect_id || '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const saved = await api.patch<TestExecutionOut>(`/api/test-execution/executions/${execution.id}`, {
        status, actual_result: actualResult || null,
        test_run_artifacts: artifacts || null, defect_id: defectId || null,
      })
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
        <div style={{ marginBottom: 14 }}>
          <p><strong>Scenario:</strong> {tc.test_scenario || '—'}</p>
          {tc.steps.length > 0 && (
            <table className="simple-table">
              <thead><tr><th>#</th><th>Step</th><th>Expected Result</th></tr></thead>
              <tbody>{tc.steps.map((s, i) => <tr key={s.id}><td>{i + 1}</td><td>{s.step_text}</td><td>{s.expected_result}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
      <form onSubmit={submit}>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {TEST_EXECUTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Actual Result">
          <textarea value={actualResult} onChange={(e) => setActualResult(e.target.value)} />
        </Field>
        <Field label="Test Run Artifacts">
          <input value={artifacts} onChange={(e) => setArtifacts(e.target.value)} placeholder="Link, filename, or reference" />
        </Field>
        <Field label="Defect ID (if any)">
          <input value={defectId} onChange={(e) => setDefectId(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Result'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => setConfirmRemove(true)} disabled={busy}>Remove from Cycle</button>
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
              <Table
                rowKey="id"
                onRowClick={(e) => canExec && projectIsActive && setEditingExecution(e)}
                columns={[
                  { key: 'test_case', header: 'Test Case ID', render: (e) => e.test_case?.test_case_key || `#${e.test_case_id}`, filterValue: (e) => e.test_case?.test_case_key || String(e.test_case_id) },
                  { key: 'mapping', header: 'Epic / Story', render: (e) => <span className="tm-hierarchy-cell"><strong>{e.test_case?.epic_id || '—'}</strong><small>{e.test_case?.user_story_id || 'No story'}</small></span>, filterValue: (e) => `${e.test_case?.epic_id || ''} ${e.test_case?.user_story_id || ''}` },
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
