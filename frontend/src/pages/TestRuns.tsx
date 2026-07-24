import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, MetricCard } from '../components/Common'
import { RUN_TYPES, EXECUTION_STATUSES, hasRole } from '../constants'
import { TestCaseOut, TestRunOut, TestRunCaseOut, TestRunMetricsOut } from '../types'

function NewRunModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: TestRunOut) => void }) {
  const [form, setForm] = useState({ project: '', application: '', release: '', run_type: 'Release-wise', start_date: '', end_date: '' })
  const [caseIds, setCaseIds] = useState<string[]>([])
  const [allCases, setAllCases] = useState<TestCaseOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.get<TestCaseOut[]>('/api/test-cases').then(setAllCases).catch(setError) }, [])
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<TestRunOut>('/api/test-runs', { ...form, test_case_ids: caseIds.map(Number) })
      onCreated(created)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="Create Test Run" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Project"><input value={form.project} onChange={(e) => set('project', e.target.value)} /></Field>
          <Field label="Application"><input value={form.application} onChange={(e) => set('application', e.target.value)} /></Field>
          <Field label="Release"><input value={form.release} onChange={(e) => set('release', e.target.value)} /></Field>
          <Field label="Run Type">
            <select value={form.run_type} onChange={(e) => set('run_type', e.target.value)}>
              {RUN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Start Date"><input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
          <Field label="End Date"><input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} /></Field>
        </div>
        <Field label="Test Cases to include">
          <select multiple size={6} value={caseIds} onChange={(e) => setCaseIds(Array.from(e.target.selectedOptions, (o) => o.value))}>
            {allCases.map((tc) => <option key={tc.id} value={tc.id}>{tc.test_case_id} — {tc.test_scenario}</option>)}
          </select>
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating...' : 'Create Test Run'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function RunDetail({ run, onClose, onChanged }: { run: TestRunOut; onClose: () => void; onChanged: (r: TestRunOut) => void }) {
  const [metrics, setMetrics] = useState<TestRunMetricsOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  const loadMetrics = useCallback(() => {
    api.get<TestRunMetricsOut>(`/api/test-runs/${run.id}/metrics`).then(setMetrics).catch(setError)
  }, [run.id])

  useEffect(() => { loadMetrics() }, [loadMetrics])

  async function updateCase(rc: TestRunCaseOut, execution_status: string) {
    try {
      await api.put(`/api/test-runs/${run.id}/cases/${rc.id}`, {
        execution_status, actual_result: rc.actual_result || '', defect_id: rc.defect_id || '',
      })
      const fresh = await api.get<TestRunOut>(`/api/test-runs/${run.id}`)
      onChanged(fresh)
      loadMetrics()
    } catch (err) { setError(err) }
  }

  return (
    <Modal title={`${run.test_run_id} — ${run.project || ''}`} onClose={onClose} wide>
      <ErrorText error={error} />
      {metrics && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <MetricCard label="Total Cases" value={metrics.total_cases} />
          <MetricCard label="Executed" value={metrics.executed_cases} />
          <MetricCard label="Pass %" value={`${metrics.pass_percentage}%`} />
          <MetricCard label="Defect Density" value={metrics.defect_density} />
        </div>
      )}
      <Table
        rowKey="id"
        columns={[
          { key: 'test_case_id', header: 'Test Case' },
          {
            key: 'execution_status', header: 'Status',
            render: (rc) => (
              <select value={rc.execution_status} onChange={(e) => updateCase(rc, e.target.value)}>
                {EXECUTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ),
          },
          { key: 'defect_id', header: 'Defect ID' },
        ]}
        rows={run.cases}
      />
    </Modal>
  )
}

export default function TestRuns() {
  const { user } = useAuth()
  const [rows, setRows] = useState<TestRunOut[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<TestRunOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try { setRows(await api.get<TestRunOut[]>('/api/test-runs')) } catch (err) { setError(err) }
  }, [])

  useEffect(() => { load() }, [load])

  const canCreate = hasRole(user, 'QA_ENGINEER', 'QA_LEAD')

  return (
    <div>
      <ErrorText error={error} />
      <div className="toolbar">
        <div className="spacer" />
        {canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Create Test Run</button>}
      </div>
      <Card title={`Test Runs (${rows.length})`}>
        <Table
          rowKey="id"
          onRowClick={setSelected}
          columns={[
            { key: 'test_run_id', header: 'Run ID' },
            { key: 'project', header: 'Project' },
            { key: 'application', header: 'Application' },
            { key: 'run_type', header: 'Type' },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
            { key: 'cases', header: 'Cases', render: (r) => r.cases.length },
          ]}
          rows={rows}
        />
      </Card>
      {showNew && <NewRunModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <RunDetail run={selected} onClose={() => setSelected(null)} onChanged={(u) => setSelected(u)} />}
    </div>
  )
}
