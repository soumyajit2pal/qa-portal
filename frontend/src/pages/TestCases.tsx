import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText } from '../components/Common'
import { TEST_TYPES, PRIORITIES, hasRole } from '../constants'
import { TestCaseOut, TestCaseVersionOut } from '../types'

const EMPTY = {
  epic_id: '', feature_id: '', user_story_id: '', test_type: 'Functional', module_name: '',
  project_name: '', test_scenario: '', precondition: '', description: '', steps: '',
  expected_result: '', priority: 'Medium',
}
type TestCaseForm = typeof EMPTY

function NewTestCaseModal({ onClose, onCreated }: { onClose: () => void; onCreated: (tc: TestCaseOut) => void }) {
  const [form, setForm] = useState<TestCaseForm>(EMPTY)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof TestCaseForm>(k: K, v: TestCaseForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<TestCaseOut>('/api/test-cases', form)
      onCreated(created)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Test Case" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Test Scenario *"><input required value={form.test_scenario} onChange={(e) => set('test_scenario', e.target.value)} /></Field>
          <Field label="Module Name"><input value={form.module_name} onChange={(e) => set('module_name', e.target.value)} /></Field>
          <Field label="Project Name"><input value={form.project_name} onChange={(e) => set('project_name', e.target.value)} /></Field>
          <Field label="Test Type">
            <select value={form.test_type} onChange={(e) => set('test_type', e.target.value)}>
              {TEST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Epic ID"><input value={form.epic_id} onChange={(e) => set('epic_id', e.target.value)} /></Field>
          <Field label="Feature ID"><input value={form.feature_id} onChange={(e) => set('feature_id', e.target.value)} /></Field>
          <Field label="User Story ID"><input value={form.user_story_id} onChange={(e) => set('user_story_id', e.target.value)} /></Field>
          <Field label="Priority">
            <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Pre-condition"><textarea value={form.precondition} onChange={(e) => set('precondition', e.target.value)} /></Field>
        <Field label="Test Case Description"><textarea value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Steps"><textarea value={form.steps} onChange={(e) => set('steps', e.target.value)} /></Field>
        <Field label="Expected Result"><textarea value={form.expected_result} onChange={(e) => set('expected_result', e.target.value)} /></Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Test Case'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function TestCaseDetail({ tc, onClose, onChanged }: { tc: TestCaseOut; onClose: () => void; onChanged: (tc: TestCaseOut) => void }) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [versions, setVersions] = useState<TestCaseVersionOut[]>([])

  useEffect(() => {
    api.get<TestCaseVersionOut[]>(`/api/test-cases/${tc.id}/versions`).then(setVersions).catch(setError)
  }, [tc.id])

  async function review(decision: string) {
    try {
      const updated = await api.post<TestCaseOut>(`/api/test-cases/${tc.id}/review`, { decision })
      onChanged(updated)
    } catch (err) { setError(err) }
  }

  async function archive() {
    try {
      const updated = await api.post<TestCaseOut>(`/api/test-cases/${tc.id}/archive`, {})
      onChanged(updated)
    } catch (err) { setError(err) }
  }

  return (
    <Modal title={`${tc.test_case_id} — v${tc.version}`} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>Scenario:</strong> {tc.test_scenario}</div>
        <div><strong>Status:</strong> <Badge status={tc.status} /> &nbsp; <strong>Review:</strong> <Badge status={tc.review_status} /></div>
        <div><strong>Module:</strong> {tc.module_name || '—'}</div>
        <div><strong>Project:</strong> {tc.project_name || '—'}</div>
        <div><strong>Priority:</strong> {tc.priority || '—'}</div>
        <div><strong>Defect ID:</strong> {tc.defect_id || '—'}</div>
      </div>
      <p><strong>Steps:</strong> {tc.steps || '—'}</p>
      <p><strong>Expected Result:</strong> {tc.expected_result || '—'}</p>
      {hasRole(user, 'QA_LEAD') && tc.review_status !== 'Approved' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-success btn-sm" onClick={() => review('Approved')}>Approve (QA Lead)</button>
          <button className="btn btn-danger btn-sm" onClick={() => review('Returned')}>Return for Rework</button>
        </div>
      )}
      {hasRole(user, 'QA_LEAD') && !tc.is_archived && (
        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={archive}>Archive Version</button>
      )}
      <div className="section-title">Version History ({versions.length})</div>
      <ul className="small muted">
        {versions.map((v) => <li key={v.version}>v{v.version} — {new Date(v.archived_at).toLocaleString()}</li>)}
        {versions.length === 0 && <li>No prior versions.</li>}
      </ul>
    </Modal>
  )
}

export default function TestCases() {
  const { user } = useAuth()
  const [rows, setRows] = useState<TestCaseOut[]>([])
  const [project, setProject] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<TestCaseOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (project) qs.set('project_name', project)
      setRows(await api.get<TestCaseOut[]>(`/api/test-cases?${qs.toString()}`))
    } catch (err) { setError(err) }
  }, [project])

  useEffect(() => { load() }, [load])

  const canAuthor = hasRole(user, 'QA_ENGINEER', 'QA_LEAD', 'BUSINESS_ANALYST')

  return (
    <div>
      <ErrorText error={error} />
      <div className="toolbar">
        <input placeholder="Filter by project..." value={project} onChange={(e) => setProject(e.target.value)} />
        <div className="spacer" />
        {canAuthor && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Test Case</button>}
      </div>
      <Card title={`Test Case Repository (${rows.length})`}>
        <Table
          rowKey="id"
          onRowClick={setSelected}
          columns={[
            { key: 'test_case_id', header: 'ID' },
            { key: 'test_scenario', header: 'Scenario' },
            { key: 'module_name', header: 'Module' },
            { key: 'test_type', header: 'Type' },
            { key: 'priority', header: 'Priority' },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
            { key: 'review_status', header: 'Review', render: (r) => <Badge status={r.review_status} /> },
            { key: 'version', header: 'Ver.' },
          ]}
          rows={rows}
        />
      </Card>
      {showNew && <NewTestCaseModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <TestCaseDetail tc={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} />}
    </div>
  )
}
