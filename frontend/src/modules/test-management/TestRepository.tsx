import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import { hasRole, TEST_CASE_TYPES, TEST_CASE_STATUSES, TEST_CASE_PRIORITIES } from '../../constants'
import { TestProjectOut, TestFolderOut, TestCaseOut, TestStepIn, TestCaseImportResult } from '../../types'

// Test Repository module -- folder tree + test case authoring/import, under
// a selected Test Project. QA Engineer + QA Lead both author (create/edit/
// import/delete); everyone with portal access can browse/read (Admin
// bypasses the author gate automatically via hasRole).
const CAN_AUTHOR_ROLES = ['QA_ENGINEER', 'QA_LEAD']
const UNFILED = '__unfiled__'

function emptyStep(stepNo: number): TestStepIn {
  return { step_no: stepNo, step_text: '', expected_result: '' }
}

function NewFolderModal({ projectId, folders, onClose, onCreated }: {
  projectId: number
  folders: TestFolderOut[]
  onClose: () => void
  onCreated: (f: TestFolderOut) => void
}) {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Folder name cannot be blank')); return }
    setBusy(true); setError(null)
    try {
      const created = await api.post<TestFolderOut>(`/api/test-repository/projects/${projectId}/folders`, {
        name: name.trim(), parent_id: parentId || null,
      })
      onCreated(created)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Folder" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Parent Folder">
          <select value={parentId} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">-- Top level --</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        <Field label="Folder Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating...' : 'Create Folder'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function ImportModal({ projectId, folders, folderId, onClose, onImported }: {
  projectId: number
  folders: TestFolderOut[]
  folderId: number | ''
  onClose: () => void
  onImported: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [targetFolder, setTargetFolder] = useState<number | ''>(folderId)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TestCaseImportResult | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { setError(new Error('Choose an .xlsx file first')); return }
    setBusy(true); setError(null)
    try {
      const res = await api.uploadForm<TestCaseImportResult>(
        `/api/test-repository/projects/${projectId}/import-xlsx`,
        { file, folder_id: targetFolder ? String(targetFolder) : undefined }
      )
      setResult(res)
      onImported()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="Import Test Cases from Excel" onClose={onClose}>
      {!result ? (
        <form onSubmit={submit}>
          <p className="muted small">
            Use the standard "Test Cases - Template" xlsx format -- one row per test step,
            with Epic ID / Feature ID / Test Scenario / Priority etc. filled in only on each
            test case's first row. Rows already carrying a Status/Actual Result are captured
            as an initial run under an auto-created "Imported from Excel" cycle.
          </p>
          <Field label="Target Folder">
            <select value={targetFolder} onChange={(e) => setTargetFolder(e.target.value ? Number(e.target.value) : '')}>
              <option value="">-- Unfiled --</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Excel File (.xlsx) *">
            <input type="file" accept=".xlsx" required onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </Field>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Importing...' : 'Import'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      ) : (
        <div>
          <p><strong>{result.created_test_cases}</strong> test case(s) created.</p>
          <p><strong>{result.imported_executions}</strong> already-recorded result(s) imported.</p>
          {result.skipped_rows > 0 && <p><strong>{result.skipped_rows}</strong> row(s) skipped.</p>}
          {result.errors.length > 0 && (
            <ul>{result.errors.map((e, i) => <li key={i} className="muted small">{e}</li>)}</ul>
          )}
          <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 10 }}>Done</button>
        </div>
      )}
    </Modal>
  )
}

function StepsEditor({ steps, onChange }: { steps: TestStepIn[]; onChange: (s: TestStepIn[]) => void }) {
  function update(i: number, field: keyof TestStepIn, value: string) {
    const next = steps.slice()
    next[i] = { ...next[i], [field]: value }
    onChange(next)
  }
  function add() { onChange([...steps, emptyStep(steps.length + 1)]) }
  function remove(i: number) {
    const next = steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step_no: idx + 1 }))
    onChange(next)
  }
  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
          <span className="muted small" style={{ paddingTop: 8 }}>{i + 1}.</span>
          <textarea placeholder="Step" value={s.step_text || ''} onChange={(e) => update(i, 'step_text', e.target.value)} style={{ flex: 1 }} />
          <textarea placeholder="Expected Result" value={s.expected_result || ''} onChange={(e) => update(i, 'expected_result', e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" onClick={() => remove(i)}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={add}>+ Add Step</button>
    </div>
  )
}

function TestCaseModal({ projectId, folders, folderId, existing, onClose, onSaved, onDeleted, canAuthor }: {
  projectId: number
  folders: TestFolderOut[]
  folderId: number | ''
  existing: TestCaseOut | null
  onClose: () => void
  onSaved: (tc: TestCaseOut) => void
  onDeleted: (id: number) => void
  canAuthor: boolean
}) {
  const [testCaseKey, setTestCaseKey] = useState(existing?.test_case_key || '')
  const [folder, setFolder] = useState<number | ''>(existing?.folder_id ?? folderId)
  const [epicId, setEpicId] = useState(existing?.epic_id || '')
  const [featureId, setFeatureId] = useState(existing?.feature_id || '')
  const [userStoryId, setUserStoryId] = useState(existing?.user_story_id || '')
  const [testType, setTestType] = useState(existing?.test_type || TEST_CASE_TYPES[0])
  const [moduleName, setModuleName] = useState(existing?.module_name || '')
  const [scenario, setScenario] = useState(existing?.test_scenario || '')
  const [preCondition, setPreCondition] = useState(existing?.pre_condition || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [priority, setPriority] = useState(existing?.priority || TEST_CASE_PRIORITIES[0])
  const [status, setStatus] = useState(existing?.status || TEST_CASE_STATUSES[0])
  const [steps, setSteps] = useState<TestStepIn[]>(
    existing?.steps.length ? existing.steps.map((s) => ({ step_no: s.step_no, step_text: s.step_text, expected_result: s.expected_result })) : [emptyStep(1)]
  )
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const readOnly = !canAuthor

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const body = {
      test_case_key: testCaseKey.trim() || null,
      folder_id: folder || null,
      epic_id: epicId || null, feature_id: featureId || null, user_story_id: userStoryId || null,
      test_type: testType || null, module_name: moduleName || null, test_scenario: scenario || null,
      pre_condition: preCondition || null, description: description || null,
      priority: priority || null, status,
      steps,
    }
    try {
      const saved = existing
        ? await api.patch<TestCaseOut>(`/api/test-repository/test-cases/${existing.id}`, body)
        : await api.post<TestCaseOut>(`/api/test-repository/projects/${projectId}/test-cases`, body)
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function remove() {
    if (!existing) return
    if (!window.confirm(`Delete test case ${existing.test_case_key}? This cannot be undone.`)) return
    setBusy(true); setError(null)
    try {
      await api.del(`/api/test-repository/test-cases/${existing.id}`)
      onDeleted(existing.id)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={existing ? `Test Case ${existing.test_case_key}` : 'New Test Case'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="grid grid-2">
          <Field label="Test Case ID (leave blank to auto-generate)">
            <input value={testCaseKey} onChange={(e) => setTestCaseKey(e.target.value)} disabled={!!existing || readOnly} />
          </Field>
          <Field label="Folder">
            <select value={folder} onChange={(e) => setFolder(e.target.value ? Number(e.target.value) : '')} disabled={readOnly}>
              <option value="">-- Unfiled --</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Epic ID">
            <input value={epicId} onChange={(e) => setEpicId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Feature ID">
            <input value={featureId} onChange={(e) => setFeatureId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="User Story ID">
            <input value={userStoryId} onChange={(e) => setUserStoryId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Test Type">
            <select value={testType} onChange={(e) => setTestType(e.target.value)} disabled={readOnly}>
              {TEST_CASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Module Name">
            <input value={moduleName} onChange={(e) => setModuleName(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={readOnly}>
              {TEST_CASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={readOnly}>
              {TEST_CASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Test Scenario">
          <input value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Pre-Condition">
          <textarea value={preCondition} onChange={(e) => setPreCondition(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Steps">
          {readOnly ? (
            <table className="simple-table">
              <thead><tr><th>#</th><th>Step</th><th>Expected Result</th></tr></thead>
              <tbody>{steps.map((s, i) => <tr key={i}><td>{i + 1}</td><td>{s.step_text}</td><td>{s.expected_result}</td></tr>)}</tbody>
            </table>
          ) : (
            <StepsEditor steps={steps} onChange={setSteps} />
          )}
        </Field>
        <ErrorText error={error} />
        {!readOnly && (
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            {existing && <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>Delete</button>}
          </div>
        )}
      </form>
    </Modal>
  )
}

export default function TestRepository() {
  const { user } = useAuth()
  const canAuthor = hasRole(user, ...CAN_AUTHOR_ROLES)
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [projectId, setProjectId] = useState<number | ''>('')
  const [folders, setFolders] = useState<TestFolderOut[]>([])
  const [cases, setCases] = useState<TestCaseOut[]>([])
  const [selectedFolder, setSelectedFolder] = useState<number | typeof UNFILED | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingCase, setEditingCase] = useState<TestCaseOut | null | 'new'>(null)

  useEffect(() => {
    api.get<TestProjectOut[]>('/api/test-projects').then((p) => {
      setProjects(p)
      if (p.length && !projectId) setProjectId(p[0].id)
    }).catch(setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadProjectData = useCallback(async (pid: number) => {
    try {
      const [f, c] = await Promise.all([
        api.get<TestFolderOut[]>(`/api/test-repository/projects/${pid}/folders`),
        api.get<TestCaseOut[]>(`/api/test-repository/projects/${pid}/test-cases`),
      ])
      setFolders(f); setCases(c)
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => { if (projectId) loadProjectData(projectId) }, [projectId, loadProjectData])

  const visibleCases = useMemo(() => {
    if (selectedFolder === '') return cases
    if (selectedFolder === UNFILED) return cases.filter((c) => !c.folder_id)
    return cases.filter((c) => c.folder_id === selectedFolder)
  }, [cases, selectedFolder])

  const folderCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    cases.forEach((c) => { if (c.folder_id) counts[c.folder_id] = (counts[c.folder_id] || 0) + 1 })
    return counts
  }, [cases])
  const unfiledCount = cases.filter((c) => !c.folder_id).length

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Test Repository" count={cases.length}
        subtitle="Folder tree of Test Cases under a selected Test Project. Import straight from the standard Excel template."
        actions={(
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value ? Number(e.target.value) : ''); setSelectedFolder('') }}>
              {projects.length === 0 && <option value="">No Test Projects yet</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_key} -- {p.name}</option>)}
            </select>
            {canAuthor && projectId && (
              <>
                <button className="btn" onClick={() => setShowNewFolder(true)}>+ Folder</button>
                <button className="btn" onClick={() => setShowImport(true)}>Import from Excel</button>
                <button className="btn btn-primary" onClick={() => setEditingCase('new')}>+ New Test Case</button>
              </>
            )}
          </div>
        )}
      />
      {projectId && (
        <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
          <Card title="Folders">
            <ul className="plain-list">
              <li>
                <button className={`link-btn ${selectedFolder === '' ? 'active' : ''}`} onClick={() => setSelectedFolder('')}>
                  All Test Cases ({cases.length})
                </button>
              </li>
              <li>
                <button className={`link-btn ${selectedFolder === UNFILED ? 'active' : ''}`} onClick={() => setSelectedFolder(UNFILED)}>
                  Unfiled ({unfiledCount})
                </button>
              </li>
              {folders.map((f) => (
                <li key={f.id} style={{ paddingLeft: f.parent_id ? 16 : 0 }}>
                  <button className={`link-btn ${selectedFolder === f.id ? 'active' : ''}`} onClick={() => setSelectedFolder(f.id)}>
                    {f.name} ({folderCounts[f.id] || 0})
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <Table
              rowKey="id"
              onRowClick={(c) => setEditingCase(c)}
              columns={[
                { key: 'test_case_key', header: 'Test Case ID' },
                { key: 'test_scenario', header: 'Scenario', render: (c) => c.test_scenario || '—' },
                { key: 'test_type', header: 'Type', render: (c) => c.test_type || '—' },
                { key: 'priority', header: 'Priority', render: (c) => c.priority || '—' },
                { key: 'status', header: 'Status', render: (c) => <Badge status={c.status} /> },
                { key: 'steps', header: 'Steps', render: (c) => c.steps.length, filterable: false },
              ]}
              rows={visibleCases}
            />
          </Card>
        </div>
      )}
      {showNewFolder && projectId && (
        <NewFolderModal
          projectId={projectId}
          folders={folders}
          onClose={() => setShowNewFolder(false)}
          onCreated={(f) => { setFolders((prev) => [...prev, f]); setShowNewFolder(false) }}
        />
      )}
      {showImport && projectId && (
        <ImportModal
          projectId={projectId}
          folders={folders}
          folderId={typeof selectedFolder === 'number' ? selectedFolder : ''}
          onClose={() => setShowImport(false)}
          onImported={() => loadProjectData(projectId)}
        />
      )}
      {editingCase && projectId && (
        <TestCaseModal
          projectId={projectId}
          folders={folders}
          folderId={typeof selectedFolder === 'number' ? selectedFolder : ''}
          existing={editingCase === 'new' ? null : editingCase}
          canAuthor={canAuthor}
          onClose={() => setEditingCase(null)}
          onSaved={(tc) => {
            setCases((prev) => {
              const exists = prev.some((c) => c.id === tc.id)
              return exists ? prev.map((c) => (c.id === tc.id ? tc : c)) : [tc, ...prev]
            })
            setEditingCase(null)
          }}
          onDeleted={(id) => { setCases((prev) => prev.filter((c) => c.id !== id)); setEditingCase(null) }}
        />
      )}
    </div>
  )
}
