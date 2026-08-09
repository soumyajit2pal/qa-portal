import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Table, TableColumn, ErrorText, PageHeader, Badge } from '../../components/Common'
import { TEST_EXECUTION_STATUSES, executionStatusGate } from '../../constants'
import { TestProjectOut, TestCycleOut, TestExecutionOut, TestRunDefectOut } from '../../types'

// SRS EXE-002 -- "the signed-in user's actionable items across authorized
// projects, five per page." Nothing on the backend aggregates this today
// (every existing execution list is scoped to one cycle at a time), so this
// page fans out client-side: active projects -> each project's In Progress
// cycles -> each cycle's executions -> keep only the ones
// assigned to the signed-in user. Reuses the shared Table component purely
// for its built-in 5-per-page pagination/filtering, matching every other
// list in the app rather than hand-rolling another pager here.
interface MyExecutionRow {
  id: number
  execution: TestExecutionOut
  project: TestProjectOut
  cycle: TestCycleOut
}

// A compact, self-contained version of Test Execution's own inline "Run"
// quick-action (that component isn't exported -- see TestExecution.tsx's
// InlineExecutionActions -- so this mirrors its status-button + optimistic
// concurrency behavior rather than reaching across module boundaries for a
// component that was written to be page-local).
function QuickResultActions({ execution, onChanged, onError }: {
  execution: TestExecutionOut
  onChanged: (execution: TestExecutionOut) => void
  onError: (error: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)

  async function saveResult() {
    if (!result) return
    setBusy(true)
    try {
      const saved = await api.patch<TestExecutionOut>(`/api/test-execution/executions/${execution.id}`, {
        status: result, actual_result: null, test_run_artifacts: null, defect_id: null,
        // SRS EXE-007 -- reject the save (409) if someone else already
        // recorded a newer attempt on this exact slot since this row loaded.
        expected_run_version: execution.run_version,
      })
      onChanged(saved)
      setResult('')
      setOpen(false)
    } catch (error) { onError(error) } finally { setBusy(false) }
  }

  return (
    <div className="tm-inline-run" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="tm-play-button" disabled={busy} onClick={() => setOpen((v) => !v)}>
        <span>▶</span> Run
      </button>
      {open && (
        <div className="tm-inline-run-panel">
          <strong>Record new result</strong><small>Creates Attempt #{(execution.run_count || 0) + 1}</small>
          <div className="tm-inline-result-options">
            {TEST_EXECUTION_STATUSES.filter((status) => status !== 'Not Executed').map((status) => {
              const blocked = executionStatusGate(execution.linked_defects, execution.runs, status)
              return <button type="button" key={status} className={result === status ? 'selected' : ''} disabled={!!blocked} title={blocked || undefined} onClick={() => setResult(status)}>{status}</button>
            })}
          </div>
          {result && executionStatusGate(execution.linked_defects, execution.runs, result) && (
            <small className="tm-inline-defect-gate-note">{executionStatusGate(execution.linked_defects, execution.runs, result)}</small>
          )}
          <div className="tm-inline-run-actions">
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!result || busy} onClick={saveResult}>{busy ? 'Saving…' : 'Save result'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// A lightweight defect-link affordance for the latest Fail/Blocked attempt,
// mirroring InlineExecutionActions' own "Link defect" behavior -- lets a
// runner attach a defect key right from this cross-project queue instead of
// having to open the full Test Execution cycle just for that.
function QuickDefectLink({ execution, onChanged, onError }: {
  execution: TestExecutionOut
  onChanged: (execution: TestExecutionOut) => void
  onError: (error: unknown) => void
}) {
  const latestRun = execution.runs?.[execution.runs.length - 1]
  const [open, setOpen] = useState(false)
  const [defectKey, setDefectKey] = useState('')
  const [defectUrl, setDefectUrl] = useState('')
  const [busy, setBusy] = useState(false)
  // A second, separate defect can't be linked to an attempt that already
  // has one -- see TestExecution.tsx's matching latestCanLinkDefect comment
  // for the full reasoning; enforced backend-side regardless.
  if (!latestRun || !['Fail', 'Blocked'].includes(latestRun.status) || latestRun.defects?.length) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!latestRun || !defectKey.trim()) return
    setBusy(true)
    try {
      const defect = await api.post<TestRunDefectOut>(`/api/test-execution/executions/${execution.id}/runs/${latestRun.id}/defects`, {
        defect_key: defectKey.trim(), defect_url: defectUrl.trim() || null, defect_status: 'Open',
      })
      onChanged({ ...execution, runs: (execution.runs || []).map((run) => run.id === latestRun.id ? { ...run, defects: [...(run.defects || []), defect] } : run) })
      setDefectKey(''); setDefectUrl(''); setOpen(false)
    } catch (error) { onError(error) } finally { setBusy(false) }
  }

  return (
    <div className="tm-inline-run" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="tm-link-last-defect" onClick={() => setOpen((v) => !v)}>Link defect</button>
      {open && (
        <form className="tm-inline-defect-panel" onSubmit={submit}>
          <strong>Link to latest {latestRun.status.toLowerCase()} run</strong><small>Attempt #{latestRun.attempt_no} only</small>
          <input required value={defectKey} onChange={(e) => setDefectKey(e.target.value)} placeholder="Defect key, e.g. JIRA-142" />
          <input type="url" value={defectUrl} onChange={(e) => setDefectUrl(e.target.value)} placeholder="Defect URL (optional)" />
          <div className="tm-inline-run-actions">
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-sm btn-danger" disabled={busy}>{busy ? 'Linking…' : 'Link defect'}</button>
          </div>
        </form>
      )}
    </div>
  )
}

export default function MyExecutions() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [rows, setRows] = useState<MyExecutionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [hideCompleted, setHideCompleted] = useState(true)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const projects = await api.get<TestProjectOut[]>('/api/test-projects')
      const activeProjects = projects.filter((p) => p.is_active && !p.is_archived)
      const perProject = await Promise.all(activeProjects.map(async (project) => {
        const cycles = await api.get<TestCycleOut[]>(`/api/test-execution/projects/${project.id}/cycles`)
        const executableCycles = cycles.filter((cycle) => cycle.status === 'In Progress')
        const perCycle = await Promise.all(executableCycles.map(async (cycle) => {
          const executions = await api.get<TestExecutionOut[]>(`/api/test-execution/cycles/${cycle.id}/executions`)
          return executions
            .filter((execution) => execution.assigned_to_id === user.id)
            .map((execution): MyExecutionRow => ({ id: execution.id, execution, project, cycle }))
        }))
        return perCycle.flat()
      }))
      setRows(perProject.flat())
    } catch (err) { setError(err) } finally { setLoading(false) }
  }, [user])
  useEffect(() => { load() }, [load])

  function updateExecution(updated: TestExecutionOut) {
    setRows((prev) => prev.map((row) => row.execution.id === updated.id ? { ...row, execution: updated } : row))
  }

  const visibleRows = useMemo(() => (
    hideCompleted ? rows.filter((row) => !['Pass', 'NA', 'Retest Passed'].includes(row.execution.status)) : rows
  ), [rows, hideCompleted])

  const notExecutedCount = rows.filter((row) => row.execution.status === 'Not Executed').length
  const failedCount = rows.filter((row) => ['Fail', 'Blocked'].includes(row.execution.status)).length

  const columns: TableColumn<MyExecutionRow>[] = [
    { key: 'project', header: 'Project', render: (row) => `${row.project.project_key} · ${row.project.name}`, filterValue: (row) => `${row.project.project_key} ${row.project.name}` },
    { key: 'cycle', header: 'Cycle', render: (row) => (
        <span>{row.cycle.cycle_key} · {row.cycle.name} <Badge status={row.cycle.status} /></span>
      ), filterValue: (row) => `${row.cycle.cycle_key} ${row.cycle.name} ${row.cycle.status}` },
    { key: 'test_case', header: 'Test Case', render: (row) => (
        row.execution.test_case ? `${row.execution.test_case.test_case_key} · ${row.execution.test_case.test_scenario || row.execution.test_case.description || ''}` : `#${row.execution.test_case_id}`
      ), filterValue: (row) => `${row.execution.test_case?.test_case_key || ''} ${row.execution.test_case?.test_scenario || ''}` },
    { key: 'pinned_version_label', header: 'Version', render: (row) => row.execution.pinned_version_label || '—', filterable: false },
    { key: 'status', header: 'Result', render: (row) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge status={row.execution.status} />
          {row.execution.is_pinned_stale && <span className="muted small" title="A newer approved version exists">stale</span>}
        </span>
      ), filterValue: (row) => row.execution.status },
    { key: 'actions', header: '', filterable: false, render: (row) => (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <QuickResultActions execution={row.execution} onChanged={updateExecution} onError={setError} />
          <QuickDefectLink execution={row.execution} onChanged={updateExecution} onError={setError} />
          <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/test-execution?project=${row.project.id}&cycle=${row.cycle.id}`) }}>Open cycle</button>
        </div>
      ) },
  ]

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        title="My Executions" count={visibleRows.length}
        subtitle="Test cases assigned to you for execution, across every project you have access to."
      />
      <div className="toolbar" style={{ marginBottom: 14, gap: 16 }}>
        <div className="tm-project-stats" style={{ flex: 1 }}>
          <div><strong>{rows.length}</strong><span>Assigned to you</span></div>
          <div><strong>{notExecutedCount}</strong><span>Not executed</span></div>
          <div><strong>{failedCount}</strong><span>Fail / Blocked</span></div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={hideCompleted} onChange={(e) => setHideCompleted(e.target.checked)} />
          Hide Pass / NA / Retest Passed
        </label>
      </div>
      {loading ? <p className="muted">Loading your assignments…</p> : (
        <Table columns={columns} rows={visibleRows} rowKey="id" tableId="my-executions" />
      )}
      {!loading && visibleRows.length === 0 && (
        <div className="tm-empty">
          <strong>Nothing to execute right now</strong>
          <span>{rows.length === 0 ? 'No test cases are currently assigned to you across your projects.' : 'Everything currently assigned to you is already Pass, NA, or Retest Passed.'}</span>
        </div>
      )}
    </div>
  )
}
