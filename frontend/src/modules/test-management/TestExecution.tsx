import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import { hasRole, QA_DEPARTMENT, TEST_EXECUTION_STATUSES } from '../../constants'
import { TestProjectOut, TestCaseOut, TestCycleOut, TestExecutionOut, TestExecutionRunOut, TestRunDefectOut, ApprovalActionOut, RequestDocumentOut, UserOut } from '../../types'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity, { MarkdownComment } from '../../components/JiraActivity'
import JiraRichTextField from '../../components/JiraRichTextField'
import UserAssignSelect from '../../components/UserAssignSelect'

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

function AddCasesModal({ cycleId, allCases, existingCaseIds, canAssign, runnerCandidates, onClose, onAdded }: {
  cycleId: number
  allCases: TestCaseOut[]
  existingCaseIds: Set<number>
  canAssign: boolean
  runnerCandidates: UserOut[]
  onClose: () => void
  onAdded: (execs: TestExecutionOut[]) => void
}) {
  const candidates = useMemo(() => allCases.filter((c) => c.status === 'Active' && !existingCaseIds.has(c.id)), [allCases, existingCaseIds])
  const awaitingApproval = useMemo(() => allCases.filter((c) => c.status !== 'Active' && !existingCaseIds.has(c.id)), [allCases, existingCaseIds])
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
        <div className="info-banner"><strong>{awaitingApproval.length} testcase{awaitingApproval.length !== 1 ? 's are' : ' is'} unavailable.</strong> QA Lead verification and approval is required before cycle assignment.</div>
      )}
      {canAssign && <div className="tm-add-cases-runner"><div><strong>Assign selected testcases</strong><span>Optional—assign all selected cases to one runner now, then reassign individual rows later.</span></div><UserAssignSelect value={assignedTo} onChange={setAssignedTo} users={runnerCandidates} placeholder="Leave unassigned…" /></div>}
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
              <DefectLinks executionId={executionId} run={run} readOnly={readOnly} onChanged={(defects) => setRuns((current) => current.map((item) => item.id === run.id ? { ...item, defects } : item))} />
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
          status, actual_result: actualResult, test_run_artifacts: artifacts, defect_id: defectId,
          defect_url: defectUrl, defect_title: defectTitle, defect_status: defectStatus, defect_notes: defectNotes,
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
  return (
    <Modal title={`Record Result -- ${tc?.test_case_key || `Test Case #${execution.test_case_id}`}`} onClose={onClose} wide>
      {tc && (
        <div className="tm-execution-case-summary">
          <div className="tm-execution-case-heading">
            <div><small>Test case definition</small><h4>{tc.test_case_key} <span className="badge badge-gray">{`v${tc.version || '1.0'}`}</span></h4></div>
            <Badge status={tc.status} />
          </div>
          <div className="tm-case-detail-grid">
            <TestCaseDetail label="Version">
              <span className="badge badge-gray">{`v${tc.version || '1.0'}`}</span>
              <small style={{ display: 'block', marginTop: 4 }}>Always reflects the current approved definition -- this cycle uses it live, not a copy.</small>
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
      {!execution.assigned_to_id && <div className="info-banner">An IT-QA QA Engineer or QA Lead must assign this testcase before an execution attempt can be recorded.</div>}
      {execution.assigned_to_id && readOnly && <div className="info-banner">Only the assigned runner can record the next attempt. Any IT-QA QA Engineer or QA Lead can reassign the testcase when needed.</div>}
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
              {TEST_EXECUTION_STATUSES.filter((s) => s !== 'Not Executed').map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Actual Result">
            <JiraRichTextField value={actualResult} onChange={setActualResult} onImagesChange={setResultImages} />
          </Field>
          <Field label="Test Run Artifacts">
            <input value={artifacts} onChange={(e) => setArtifacts(e.target.value)} placeholder="Link, filename, or reference" />
          </Field>
          <div className="tm-new-attempt-defect">
            <div className="tm-new-attempt-defect-head"><strong>Link a defect to this attempt</strong><span>Optional · More defects can be linked from Attempt History</span></div>
            <div className="grid grid-2"><Field label="Defect Key"><input value={defectId} onChange={(e) => setDefectId(e.target.value)} placeholder="e.g. JIRA-142" /></Field><Field label="Defect Status"><select value={defectStatus} onChange={(e) => setDefectStatus(e.target.value)}><option>Open</option><option>In Progress</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select></Field></div>
            <Field label="Defect URL"><input type="url" value={defectUrl} onChange={(e) => setDefectUrl(e.target.value)} placeholder="https://jira.example/browse/JIRA-142" /></Field>
            <Field label="Defect Title"><input value={defectTitle} onChange={(e) => setDefectTitle(e.target.value)} placeholder="Short defect summary" /></Field>
            <Field label="Defect Notes"><textarea value={defectNotes} onChange={(e) => setDefectNotes(e.target.value)} /></Field>
          </div>
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

  function review(e: React.FormEvent) {
    e.preventDefault()
    if (!status) { setError(new Error('Select an execution result')); return }
    if (actualResult.length > 10000) { setError(new Error('Actual Result cannot exceed 10,000 characters')); return }
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
        defect_id: defectId || null,
        defect_url: defectUrl || null,
        defect_title: defectTitle || null,
        defect_status: defectId ? defectStatus : null,
        defect_notes: defectNotes || null,
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
    <Modal title={title} onClose={stage === 'executing' ? () => undefined : onClose} variant="dialog" preventBackdropClose wide>
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
          <div className="tm-new-attempt-defect">
            <div className="tm-new-attempt-defect-head"><strong>Link one shared defect</strong><span>Optional · Added to every selected attempt</span></div>
            <div className="grid grid-2"><Field label="Defect Key"><input value={defectId} onChange={(event) => setDefectId(event.target.value)} placeholder="e.g. JIRA-142" /></Field><Field label="Defect Status"><select value={defectStatus} onChange={(event) => setDefectStatus(event.target.value)}><option>Open</option><option>In Progress</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select></Field></div>
            <Field label="Defect URL"><input type="url" value={defectUrl} onChange={(event) => setDefectUrl(event.target.value)} placeholder="https://jira.example/browse/JIRA-142" /></Field>
            <Field label="Defect Title"><input maxLength={255} value={defectTitle} onChange={(event) => setDefectTitle(event.target.value)} placeholder="Short defect summary" /></Field>
            <Field label="Defect Notes"><textarea maxLength={5000} value={defectNotes} onChange={(event) => setDefectNotes(event.target.value)} /></Field>
          </div>
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
    <Modal title={title} onClose={stage === 'removing' ? () => undefined : onClose} variant="dialog" preventBackdropClose>
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
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const canExec = hasRole(user, ...CAN_EXEC_ROLES)
  const canDeleteCycle = hasRole(user, 'QA_LEAD')
  const canManageRunners = hasRole(user, ...CAN_EXEC_ROLES)
    && (user?.roles.includes('ADMIN') || user?.department === QA_DEPARTMENT)
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
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'mine' | 'unassigned'>('all')
  const [cycleToDelete, setCycleToDelete] = useState<TestCycleOut | null>(null)
  const [deletingCycle, setDeletingCycle] = useState(false)
  const [selectedExecutionIds, setSelectedExecutionIds] = useState<Set<number>>(new Set())
  const [showBulkExecution, setShowBulkExecution] = useState(false)
  const [bulkRemoveExecutions, setBulkRemoveExecutions] = useState<TestExecutionOut[] | null>(null)
  const [cycleActivity, setCycleActivity] = useState<ApprovalActionOut[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [exportingCycle, setExportingCycle] = useState(false)

  useEffect(() => {
    api.get<TestProjectOut[]>('/api/test-projects?include_inactive=true').then((p) => {
      setProjects(p)
      const requested = Number(searchParams.get('project'))
      if (p.length && !projectId) setProjectId(p.some((x) => x.id === requested) ? requested : p[0].id)
    }).catch(setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  useEffect(() => {
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(setError)
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
  useEffect(() => {
    if (cycleId) {
      loadExecutions(cycleId)
      api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => setCycleActivity([]))
    } else { setExecutions([]); setCycleActivity([]) }
  }, [cycleId, loadExecutions])
  useEffect(() => {
    setSelectedExecutionIds(new Set())
    setShowBulkExecution(false)
    setBulkRemoveExecutions(null)
  }, [cycleId, projectId])

  const existingCaseIds = useMemo(() => new Set(executions.map((e) => e.test_case_id)), [executions])
  const summary = useMemo(() => {
    const counts: Record<string, number> = {}
    executions.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1 })
    return counts
  }, [executions])
  const filteredExecutions = executions.filter((execution) => (
    (!resultFilter || execution.status === resultFilter)
    && (assignmentFilter === 'all'
      || (assignmentFilter === 'mine' && execution.assigned_to_id === user?.id)
      || (assignmentFilter === 'unassigned' && !execution.assigned_to_id))
  ))
  const executedCount = executions.filter((e) => e.status !== 'Not Executed').length
  const passCount = (summary.Pass || 0) + (summary['Retest Passed'] || 0)
  const passRate = executedCount ? Math.round((passCount / executedCount) * 100) : 0
  const assignedCount = executions.filter((execution) => !!execution.assigned_to_id).length
  const unassignedCount = executions.length - assignedCount
  const myAssignmentCount = executions.filter((execution) => execution.assigned_to_id === user?.id).length
  const totalRunCount = executions.reduce((total, execution) => total + (execution.run_count || execution.runs?.length || 0), 0)
  const selectedCycle = cycles.find((c) => c.id === cycleId)
  const selectedProject = projects.find((project) => project.id === projectId)
  const projectIsActive = !!selectedProject?.is_active
  const runnerCandidates = useMemo(() => users.filter((candidate) => (
    candidate.department === QA_DEPARTMENT
    && candidate.is_active
    && candidate.roles.some((role) => ['QA_ENGINEER', 'QA_LEAD'].includes(role))
  )), [users])
  const canExecuteRow = useCallback((execution: TestExecutionOut) => (
    canExec && projectIsActive
    && (!!user?.roles.includes('ADMIN') || execution.assigned_to_id === user?.id)
  ), [canExec, projectIsActive, user])
  const canSelectRow = useCallback((execution: TestExecutionOut) => (
    canManageRunners || canExecuteRow(execution)
  ), [canExecuteRow, canManageRunners])
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
      setExecutions((current) => current.map((item) => item.id === saved.id ? saved : item))
      setEditingExecution((current) => current?.id === saved.id ? saved : current)
      if (cycleId) api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
    } catch (err) { setError(err) }
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
      setExecutions([])
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

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        title="Test Execution" count={executions.length}
        subtitle="Plan test cycles, execute step-by-step, capture evidence, and connect failures to defects."
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
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={exportCycle} disabled={exportingCycle}>
                    {exportingCycle ? 'Exporting…' : 'Export Lifecycle'}
                  </button>
                  {canExec && projectIsActive && <button className="btn btn-primary" onClick={() => setShowAddCases(true)}>+ Add test cases</button>}
                </div>
              </div>
              <div className="tm-execution-summary">
                <div><small>Progress</small><strong>{executedCount}<span> / {executions.length}</span></strong><i><b style={{ width: `${executions.length ? (executedCount / executions.length) * 100 : 0}%` }} /></i></div>
                <div><small>Pass rate</small><strong>{passRate}%</strong><span>{passCount} passed</span></div>
                <div><small>Failed</small><strong className="danger">{summary.Fail || 0}</strong><span>Needs attention</span></div>
                <div><small>Blocked</small><strong className="warning">{summary.Blocked || 0}</strong><span>Waiting on dependency</span></div>
              </div>
              <div className="tm-runner-summary">
                <div><span>Runner coverage</span><strong>{assignedCount}<small> / {executions.length}</small></strong><em>{unassignedCount ? `${unassignedCount} still unassigned` : 'Every testcase has an owner'}</em></div>
                <div><span>My assignments</span><strong>{myAssignmentCount}</strong><em>Testcases currently assigned to you</em></div>
                <div><span>Total runs</span><strong>{totalRunCount}</strong><em>All attempts retained across this cycle</em></div>
                <div className={unassignedCount ? 'needs-attention' : ''}><span>Unassigned</span><strong>{unassignedCount}</strong><em>{unassignedCount ? 'IT-QA assignment required' : 'No assignment gap'}</em></div>
              </div>
              <div className="tm-assignment-filters">
                <span>Runner view</span>
                <button className={assignmentFilter === 'all' ? 'active' : ''} onClick={() => setAssignmentFilter('all')}>All <em>{executions.length}</em></button>
                <button className={assignmentFilter === 'mine' ? 'active' : ''} onClick={() => setAssignmentFilter('mine')}>Assigned to me <em>{myAssignmentCount}</em></button>
                <button className={assignmentFilter === 'unassigned' ? 'active' : ''} onClick={() => setAssignmentFilter('unassigned')}>Unassigned <em>{unassignedCount}</em></button>
              </div>
              <div className="tm-result-tabs">
                <button className={!resultFilter ? 'active' : ''} onClick={() => setResultFilter('')}>All <span>{executions.length}</span></button>
                {TEST_EXECUTION_STATUSES.map((s) => <button key={s} className={resultFilter === s ? 'active' : ''} onClick={() => setResultFilter(s)}>{s} <span>{summary[s] || 0}</span></button>)}
              </div>
              {canExec && projectIsActive && (
                <div className="tm-bulk-bar" role="region" aria-label="Bulk testcase lifecycle actions">
                  <strong>{selectedExecutionIds.size ? `${selectedExecutionIds.size} testcase${selectedExecutionIds.size !== 1 ? 's' : ''} selected` : 'Select testcases for bulk lifecycle actions'}</strong>
                  <button type="button" className="btn btn-sm" disabled={!selectableExecutions.length} onClick={toggleVisibleExecutions}>{allVisibleSelected ? 'Clear visible' : `Select visible (${selectableExecutions.length})`}</button>
                  {selectedExecutionIds.size > 0 && <button type="button" className="btn btn-sm" onClick={() => setSelectedExecutionIds(new Set())}>Clear selection</button>}
                  <button type="button" className="btn btn-sm btn-primary" disabled={!bulkExecutionEligible} title={selectedExecutionIds.size && !bulkExecutionEligible ? 'Bulk execution requires every selected testcase to be assigned to you' : undefined} onClick={() => setShowBulkExecution(true)}>Bulk execute{selectedExecutionIds.size ? ` (${selectedExecutionIds.size})` : ''}</button>
                  {canManageRunners && <button type="button" className="btn btn-sm btn-danger" disabled={!selectedExecutionIds.size} onClick={() => setBulkRemoveExecutions(selectedExecutions)}>Remove from cycle{selectedExecutionIds.size ? ` (${selectedExecutionIds.size})` : ''}</button>}
                </div>
              )}
              <Table<TestExecutionOut>
                rowKey="id"
                onRowClick={setEditingExecution}
                columns={[
                  { key: 'select', header: <input type="checkbox" aria-label="Select all visible testcases" checked={allVisibleSelected} disabled={!selectableExecutions.length} onChange={toggleVisibleExecutions} onClick={(event) => event.stopPropagation()} />, filterable: false, render: (execution) => <input type="checkbox" aria-label={`Select ${execution.test_case?.test_case_key || `testcase ${execution.test_case_id}`}`} checked={selectedExecutionIds.has(execution.id)} disabled={!canSelectRow(execution)} title={canSelectRow(execution) ? 'Select for bulk lifecycle actions' : execution.assigned_to_id ? `Assigned to ${execution.assigned_to_name || 'another runner'}` : 'Assign a runner before execution'} onChange={() => toggleExecutionSelection(execution.id)} onClick={(event) => event.stopPropagation()} /> },
                  { key: 'test_case', header: 'Test Case', render: (e) => <span className="tm-hierarchy-cell"><strong>{e.test_case?.test_case_key || `#${e.test_case_id}`}</strong><small>{[e.test_case?.module_name, `v${e.test_case?.version || '1.0'}`].filter(Boolean).join(' · ')}</small></span>, filterValue: (e) => `${e.test_case?.test_case_key || e.test_case_id} ${e.test_case?.module_name || ''}` },
                  { key: 'scenario', header: 'Scenario', render: (e) => e.test_case?.test_scenario || '—', filterValue: (e) => e.test_case?.test_scenario || '' },
                  { key: 'assigned_to_name', header: 'Assigned To', render: (e) => canManageRunners && projectIsActive ? <div className="tm-table-assignee" onClick={(event) => event.stopPropagation()}><UserAssignSelect value={e.assigned_to_id ? String(e.assigned_to_id) : ''} onChange={(value) => assignRunner(e, value)} users={runnerCandidates} placeholder="Assign runner…" />{e.assigned_to_id && <button type="button" title="Unassign" onClick={() => assignRunner(e, '')}>×</button>}</div> : <span className={e.assigned_to_name ? '' : 'muted'}>{e.assigned_to_name || 'Unassigned'}</span>, filterValue: (e) => e.assigned_to_name || 'Unassigned' },
                  { key: 'run_count', header: 'Runs', render: (e) => <span className={`tm-run-count ${e.run_count ? 'has-runs' : ''}`}>{e.run_count || 0}</span> },
                  { key: 'status', header: 'Latest Result', render: (e) => <Badge status={e.status} /> },
                  { key: 'defects', header: 'Defects', render: (e) => { const defects = (e.runs || []).flatMap((run) => run.defects || []); return defects.length ? <span className="tm-table-defects">{defects.slice(-2).map((defect) => defect.defect_key).join(', ')}{defects.length > 2 ? ` +${defects.length - 2}` : ''}</span> : '—' }, filterValue: (e) => (e.runs || []).flatMap((run) => run.defects || []).map((defect) => defect.defect_key).join(' ') },
                  { key: 'executed_by_name', header: 'Last Runner', render: (e) => <span className="tm-hierarchy-cell"><strong>{e.executed_by_name || '—'}</strong><small>{e.executed_at ? new Date(e.executed_at).toLocaleString() : 'Not run yet'}</small></span>, filterValue: (e) => e.executed_by_name || '' },
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
          canAssign={canManageRunners}
          runnerCandidates={runnerCandidates}
          onClose={() => setShowAddCases(false)}
          onAdded={(execs) => { setExecutions((prev) => [...prev, ...execs]); setShowAddCases(false) }}
        />
      )}
      {showBulkExecution && cycleId && selectedExecutions.length > 0 && (
        <BulkExecutionModal
          cycleId={Number(cycleId)}
          executions={selectedExecutions}
          onClose={() => { setShowBulkExecution(false); setSelectedExecutionIds(new Set()) }}
          onExecuted={(saved) => {
            const savedById = new Map(saved.map((execution) => [execution.id, execution]))
            setExecutions((current) => current.map((execution) => savedById.get(execution.id) || execution))
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
          onRemoved={(result) => {
            const removedIds = new Set(result.removed_execution_ids)
            setExecutions((current) => current.filter((execution) => !removedIds.has(execution.id)))
            api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
          }}
        />
      )}
      {editingExecution && (
        <RecordResultModal
          execution={editingExecution}
          readOnly={!canExec || !projectIsActive || (!user?.roles.includes('ADMIN') && editingExecution.assigned_to_id !== user?.id)}
          canAssign={canManageRunners && projectIsActive}
          runnerCandidates={runnerCandidates}
          onAssigned={(saved) => {
            setExecutions((current) => current.map((item) => item.id === saved.id ? saved : item))
            setEditingExecution(saved)
            if (cycleId) api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
          }}
          onClose={() => setEditingExecution(null)}
          onSaved={(e) => {
            setExecutions((prev) => prev.map((x) => (x.id === e.id ? e : x)))
            setEditingExecution(null)
            if (cycleId) api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CYCLE&entity_id=${cycleId}`).then(setCycleActivity).catch(() => undefined)
          }}
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
