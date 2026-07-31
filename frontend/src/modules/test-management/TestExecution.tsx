import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import { hasRole, TEST_CYCLE_STATUSES, TEST_EXECUTION_STATUSES } from '../../constants'
import { TestProjectOut, TestCaseOut, TestCycleOut, TestExecutionOut } from '../../types'

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
  const candidates = useMemo(() => allCases.filter((c) => !existingCaseIds.has(c.id)), [allCases, existingCaseIds])
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
      {candidates.length === 0 ? (
        <p className="muted small">Every test case in this project is already in this cycle.</p>
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
    if (!window.confirm('Remove this test case from the cycle?')) return
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
          <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>Remove from Cycle</button>
        </div>
      </form>
    </Modal>
  )
}

export default function TestExecution() {
  const { user } = useAuth()
  const canExec = hasRole(user, ...CAN_EXEC_ROLES)
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

  useEffect(() => {
    api.get<TestProjectOut[]>('/api/test-projects').then((p) => {
      setProjects(p)
      if (p.length && !projectId) setProjectId(p[0].id)
    }).catch(setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  useEffect(() => { if (cycleId) loadExecutions(cycleId); else setExecutions([]) }, [cycleId, loadExecutions])

  const existingCaseIds = useMemo(() => new Set(executions.map((e) => e.test_case_id)), [executions])
  const summary = useMemo(() => {
    const counts: Record<string, number> = {}
    executions.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1 })
    return counts
  }, [executions])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Test Execution" count={executions.length}
        subtitle="Run Test Cases against Test Cycles and record Pass/Fail/Blocked/NA/Retest Passed results."
        actions={(
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : '')}>
              {projects.length === 0 && <option value="">No Test Projects yet</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_key} -- {p.name}</option>)}
            </select>
            {canExec && projectId && (
              <button className="btn" onClick={() => setShowNewCycle(true)}>+ Cycle</button>
            )}
          </div>
        )}
      />
      {projectId && (
        <Card
          title="Test Cycle"
          right={(
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={cycleId} onChange={(e) => setCycleId(e.target.value ? Number(e.target.value) : '')}>
                {cycles.length === 0 && <option value="">No cycles yet</option>}
                {cycles.map((c) => <option key={c.id} value={c.id}>{c.cycle_key} -- {c.name} ({c.status})</option>)}
              </select>
              {canExec && cycleId && (
                <button className="btn btn-sm" onClick={() => setShowAddCases(true)}>+ Add Test Cases</button>
              )}
            </div>
          )}
        >
          {cycleId ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {TEST_EXECUTION_STATUSES.map((s) => (
                  <span key={s} className="muted small">{s}: <strong>{summary[s] || 0}</strong></span>
                ))}
              </div>
              <Table
                rowKey="id"
                onRowClick={(e) => canExec && setEditingExecution(e)}
                columns={[
                  { key: 'test_case', header: 'Test Case ID', render: (e) => e.test_case?.test_case_key || `#${e.test_case_id}`, filterValue: (e) => e.test_case?.test_case_key || String(e.test_case_id) },
                  { key: 'scenario', header: 'Scenario', render: (e) => e.test_case?.test_scenario || '—', filterValue: (e) => e.test_case?.test_scenario || '' },
                  { key: 'status', header: 'Result', render: (e) => <Badge status={e.status} /> },
                  { key: 'defect_id', header: 'Defect ID', render: (e) => e.defect_id || '—' },
                  { key: 'executed_at', header: 'Executed', render: (e) => (e.executed_at ? new Date(e.executed_at).toLocaleString() : '—') },
                ]}
                rows={executions}
              />
            </>
          ) : (
            <p className="muted small">Create a Test Cycle to start recording results.</p>
          )}
        </Card>
      )}
      {showNewCycle && projectId && (
        <NewCycleModal
          projectId={projectId}
          onClose={() => setShowNewCycle(false)}
          onCreated={(c) => { setCycles((prev) => [c, ...prev]); setCycleId(c.id); setShowNewCycle(false) }}
        />
      )}
      {showAddCases && cycleId && (
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
    </div>
  )
}
