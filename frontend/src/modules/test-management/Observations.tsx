import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ApprovalActionOut, DefectLinkableExecutionOut, DefectOut, QARequestListOut, RequestDocumentOut, UserOption } from '../../types'
import { useAuth } from '../../context/AuthContext'
import { ENVIRONMENTS, hasWorkflowRole, isViewOnly } from '../../constants'
import { Badge, ErrorText, Field, Modal } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import JiraRichTextField from '../../components/JiraRichTextField'
import JiraActivity, { AuthenticatedMarkdown } from '../../components/JiraActivity'
import RecordNumberLink from '../../components/RecordNumberLink'
import LinkDefectRequest from '../../components/LinkDefectRequest'
import LinkDefectFunctionalRequest from '../../components/LinkDefectFunctionalRequest'
import { WorkSession, useWorkBusy, useWorkState, useWorkView } from '../../components/WorkViews'
import { useRequestNavigation } from '../../hooks/useRequestNavigation'
import { defectEvidenceError, DEFECT_EVIDENCE_EXTENSIONS } from '../../defectEvidence'
import './Observations.css'

export const OBSERVATION_CATEGORIES = ['UI / Usability', 'Improvement', 'Requirement Clarification', 'Documentation', 'Other']
const OUTCOMES = ['Accepted as is', 'Improvement recorded', 'Clarification provided', 'Documentation updated', 'No action required']
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low']
const PRIORITIES = ['P1 – Immediate', 'P2 – High', 'P3 – Medium', 'P4 – Low']

function useExecutionOptions(application: string) {
  const [rows, setRows] = useState<DefectLinkableExecutionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setRows([]); setError(null)
    const timer = application ? window.setTimeout(() => api.get<DefectLinkableExecutionOut[]>(`/api/test-execution/executions/blocked-or-failed?${new URLSearchParams({ include_references: 'true', application_name: application })}`)
      .then(result => { if (active) setRows(result) }).catch(reason => { if (active) setError(reason) }), 250) : undefined
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [application, attempt])
  return { rows, error, retry: () => setAttempt(value => value + 1) }
}

export function CreateObservationModal(props: { requests: QARequestListOut[]; onClose: () => void; onCreated: (record: DefectOut) => void }) {
  return <WorkSession target={{ kind: 'observation', id: 'new' }}><CreateObservationContent {...props} /></WorkSession>
}

function CreateObservationContent({ requests, onClose, onCreated }: { requests: QARequestListOut[]; onClose: () => void; onCreated: (record: DefectOut) => void }) {
  const work = useWorkView()
  const [form, setForm] = useWorkState('observation.create.form', { title: '', description: '', observation_category: '', application_name: '', module_name: '', module_feature: '', environment: '', qa_request_id: '', execution_id: '' })
  const [files, setFiles] = useWorkState<File[]>('observation.create.files', [])
  const [images, setImages] = useWorkState<File[]>('observation.create.images', [])
  const [created, setCreated] = useWorkState<DefectOut | null>('observation.create.saved', null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const submitting = useRef(false)
  useWorkBusy(busy)
  const executions = useExecutionOptions(form.application_name)
  const set = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }))
  const done = (record: DefectOut) => { work?.clear(); onCreated(record) }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    const allFiles = [...images, ...files]
    const validation = defectEvidenceError(allFiles)
    if (validation) { setError(new Error(validation)); return }
    if (!form.application_name.trim() && !form.qa_request_id) { setError(new Error('Select a QA request or enter the application name.')); return }
    submitting.current = true; setBusy(true); setError(null)
    try {
      let record = created
      if (!record) {
        record = await api.post<DefectOut>('/api/defects/observations', {
          ...form, qa_request_id: form.qa_request_id ? Number(form.qa_request_id) : null,
          execution_id: form.execution_id ? Number(form.execution_id) : null,
          environment: form.environment || null, module_name: form.module_name || null,
          module_feature: form.module_feature || null,
        })
        setCreated(record)
      }
      if (allFiles.length) await api.uploadFormFiles(`/api/defects/${record.id}/attachments`, {}, allFiles)
      done(record)
    } catch (reason) { setError(reason) } finally { submitting.current = false; setBusy(false) }
  }
  return <Modal title="Add Observation" onClose={onClose} closeDisabled={busy} workView wide className="observation-dialog">
    <form onSubmit={save}>
      <p className="observation-intro">Record a suggestion, clarification or finding for review. Confirmed failures can be converted to defects by QA.</p>
      {created && <p role="status">{created.defect_key} is saved. Retry the pending attachments or open the observation.</p>}
      <fieldset disabled={busy || !!created} className="observation-fields">
        <Field label="Title *"><input required maxLength={255} value={form.title} onChange={event => set('title', event.target.value)} placeholder="Describe the observation briefly" /></Field>
        <div className="observation-grid">
          <Field label="Category *"><select required value={form.observation_category} onChange={event => set('observation_category', event.target.value)}><option value="">Select category</option>{OBSERVATION_CATEGORIES.map(value => <option key={value}>{value}</option>)}</select></Field>
          <Field label="QA Request (optional)"><SearchableSelect value={form.qa_request_id} ariaLabel="Observation QA request" onChange={value => {
            const request = requests.find(row => String(row.id) === value)
            setForm(current => ({ ...current, qa_request_id: value, application_name: request?.application_name || current.application_name, module_name: request?.module_name || '', execution_id: '' }))
          }} options={[{ value: '', label: 'No QA request linked' }, ...requests.map(request => ({ value: String(request.id), label: [request.request_id, request.cr_number || request.epic_number, request.application_name, request.module_name].filter(Boolean).join(' · ') }))]} /></Field>
          <Field label="Application *"><input required value={form.application_name} maxLength={150} readOnly={!!form.qa_request_id} onChange={event => setForm(current => ({ ...current, application_name: event.target.value, execution_id: '' }))} /></Field>
          <Field label="Module (optional)"><input maxLength={150} value={form.module_name} onChange={event => set('module_name', event.target.value)} /></Field>
          <Field label="Feature / Area (optional)"><input maxLength={150} value={form.module_feature} onChange={event => set('module_feature', event.target.value)} /></Field>
          <Field label="Environment (optional)"><select value={form.environment} onChange={event => set('environment', event.target.value)}><option value="">Not specified</option>{ENVIRONMENTS.map(value => <option key={value}>{value}</option>)}</select></Field>
        </div>
        <Field label="Test execution (optional)"><SearchableSelect value={form.execution_id} disabled={!form.application_name} ariaLabel="Observation test execution" onChange={value => set('execution_id', value)} options={[{ value: '', label: 'No execution linked' }, ...executions.rows.map(row => ({ value: String(row.execution.id), label: `${row.cycle.cycle_key} · ${row.execution.test_case?.test_case_key || `Execution #${row.execution.id}`} · ${row.execution.status}` }))]} /></Field>
        {!!executions.error && <button type="button" className="btn btn-sm" onClick={executions.retry}>Retry loading executions</button>}
        <Field label="Observation details *"><JiraRichTextField value={form.description} onChange={value => set('description', value)} onImagesChange={setImages} disabled={busy || !!created} ariaLabel="Observation details" placeholder="Explain what you noticed, its context, and any suggested improvement…" /></Field>
        <Field label="Attachments (optional)"><input type="file" multiple accept={DEFECT_EVIDENCE_EXTENSIONS.join(',')} onChange={event => { if (event.target.files) setFiles(current => [...current, ...Array.from(event.target.files!)]); event.target.value = '' }} /></Field>
        {!!files.length && <ul className="observation-files">{files.map((file, index) => <li key={`${index}-${file.name}`}><span>{file.name}</span><button type="button" className="link-btn" onClick={() => setFiles(current => current.filter((_, item) => item !== index))}>Remove</button></li>)}</ul>}
      </fieldset>
      <ErrorText error={error || executions.error} />
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || (!created && (!form.title.trim() || !form.description.trim() || !form.observation_category))}>{busy ? 'Saving…' : created ? 'Retry attachments' : 'Create observation'}</button>{created && <button type="button" className="btn" disabled={busy} onClick={() => done(created)}>Open saved observation</button>}<button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}

export function ObservationDetail({ record, onClose, onChanged }: { record: DefectOut; users?: UserOption[]; onClose: () => void; onChanged: (record: DefectOut) => void }) {
  const { user } = useAuth(), navigate = useRequestNavigation()
  const [tab, setTab] = useWorkState('observation.detail.tab', 'details')
  const [action, setAction] = useWorkState('observation.detail.action', '')
  const [edit, setEdit] = useWorkState('observation.detail.edit', false)
  const [linkExecution, setLinkExecution] = useWorkState('observation.detail.linkExecution', false)
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([]), [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [reload, setReload] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  useWorkBusy(busy)
  const writable = !isViewOnly(user) && (!user?.active_workspace_id || record.qa_workspace_id === user.active_workspace_id)
  const qa = writable && hasWorkflowRole(user, 'QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')
  const canEdit = writable && record.status !== 'Closed' && (qa || record.reporter_id === user?.id)
  useEffect(() => {
    let active = true
    Promise.all([api.getFresh<RequestDocumentOut[]>(`/api/defects/${record.id}/attachments`), api.getFresh<ApprovalActionOut[]>(`/api/approvals?entity_type=DEFECT&entity_id=${record.id}`)])
      .then(([docs, items]) => { if (active) { setDocuments(docs); setActivity(items); setError(null) } }).catch(reason => { if (active) setError(reason) })
    return () => { active = false }
  }, [record.id, record.workflow_revision, reload])
  async function upload(files: FileList | null) {
    if (!files?.length || busy) return
    const validation = defectEvidenceError(Array.from(files))
    if (validation) { setError(new Error(validation)); return }
    setBusy(true)
    try { await api.uploadFormFiles(`/api/defects/${record.id}/attachments`, {}, Array.from(files)); setReload(value => value + 1) }
    catch (reason) { setError(reason) } finally { setBusy(false) }
  }
  return <>
    <Modal title={`${record.defect_key} · ${record.title}`} onClose={onClose} closeDisabled={busy} workView wide className="observation-dialog">
      <div className="observation-heading"><div><span className="observation-badge">Observation</span><Badge status={record.status} /><p>{record.observation_category} · {record.application_name}{record.module_name ? ` · ${record.module_name}` : ''}</p><p className="muted small">Observations are counted separately from defects. QA can convert a confirmed failure to a defect.</p></div>
        {qa && <div className="observation-actions"><button type="button" className="btn" onClick={() => setAction(record.status === 'New' ? 'Under Review' : record.status === 'Under Review' ? 'Closed' : 'New')}>{record.status === 'New' ? 'Start review' : record.status === 'Under Review' ? 'Close observation' : 'Reopen observation'}</button><button type="button" className="btn btn-primary" onClick={() => setAction('convert')}>Convert to Defect</button></div>}
      </div>
      <div className="observation-tabs" role="tablist" aria-label="Observation sections">{[['details', 'Details'], ['links', 'Linked work'], ['activity', 'Activity & history']].map(([key, label]) => <button type="button" key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
      <section hidden={tab !== 'details'}>
        <div className="observation-section-head"><h3>Observation details</h3>{canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit(true)}>Edit observation</button>}</div>
        <AuthenticatedMarkdown value={record.description} basePath={`/api/defects/${record.id}/attachments`} />
        {record.observation_outcome && <div className="observation-outcome"><strong>{record.observation_outcome}</strong><p>{record.closure_remarks}</p></div>}
        <p className="muted small">Reported by {record.reporter_name || 'Unknown'} · Environment: {record.environment} · Feature / Area: {record.module_feature}</p>
        <div className="observation-section-head"><h3>Evidence & attachments ({documents.length})</h3>{writable && (qa || record.reporter_id === user?.id) && <label className="btn btn-sm">{busy ? 'Uploading…' : 'Add attachments'}<input hidden type="file" multiple accept={DEFECT_EVIDENCE_EXTENSIONS.join(',')} disabled={busy} onChange={event => { void upload(event.target.files); event.target.value = '' }} /></label>}</div>
        <div className="defect-files">{documents.map(document => <button type="button" key={document.id} onClick={() => api.downloadFile(`/api/defects/${record.id}/attachments/${document.id}/download`, document.file_name).catch(setError)}>{document.file_name}</button>)}</div>
        {!documents.length && <p className="muted">No attachments added.</p>}
      </section>
      <section hidden={tab !== 'links'}>
        <h3>Linked work</h3>
        <p>{record.qa_request_key || 'No QA Request linked'}</p>
        {canEdit && !record.qa_request_id && <LinkDefectRequest defect={record} onChanged={onChanged} />}
        {canEdit && <LinkDefectFunctionalRequest defect={record} onChanged={onChanged} />}
        <div className="observation-links">{record.functional_requests?.map(request => <RecordNumberLink key={request.id} kind="functional" id={request.id} recordKey={request.request_id} onOpen={() => navigate(`/functional-requests?open=${request.id}`)} />)}</div>
        {record.execution_id && <p><button type="button" className="link-btn" onClick={() => navigate(`/test-execution?project=${record.project_id || ''}&cycle=${record.cycle_id}&execution=${record.execution_id}`)}>{record.cycle_key} · {record.test_case_key}</button></p>}
        {record.execution_links.map(link => <p key={link.id}><button type="button" className="link-btn" onClick={() => navigate(`/test-execution?project=${link.project_id || ''}&cycle=${link.cycle_id}&execution=${link.execution_id}`)}>{link.cycle_key} · {link.test_case_key}</button></p>)}
        {canEdit && <button type="button" className="btn btn-sm" onClick={() => setLinkExecution(true)}>Link test execution</button>}
      </section>
      <section hidden={tab !== 'activity'}><JiraActivity entityType="DEFECT" entityId={record.id} ownerWorkspaceId={record.qa_workspace_id} items={activity} readOnly={!writable} onPosted={item => setActivity(current => [...current, item])} /></section>
      <ErrorText error={error} />{!!error && <button type="button" className="btn btn-sm" onClick={() => setReload(value => value + 1)}>Refresh observation</button>}
    </Modal>
    {!!action && <ObservationActionModal record={record} action={action} onClose={() => setAction('')} onChanged={updated => { setAction(''); onChanged(updated) }} />}
    {edit && <EditObservationModal record={record} onClose={() => setEdit(false)} onChanged={updated => { setEdit(false); onChanged(updated) }} />}
    {linkExecution && <ObservationExecutionModal record={record} onClose={() => setLinkExecution(false)} onChanged={updated => { setLinkExecution(false); onChanged(updated) }} />}
  </>
}

function EditObservationModal({ record, onClose, onChanged }: { record: DefectOut; onClose: () => void; onChanged: (record: DefectOut) => void }) {
  const [form, setForm] = useWorkState('observation.edit', { title: record.title, description: record.description, observation_category: record.observation_category || 'Other' })
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  useWorkBusy(busy)
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(null)
    try { onChanged(await api.patch<DefectOut>(`/api/defects/${record.id}/observation`, { ...form, revision: record.workflow_revision || 0 })) }
    catch (reason) { setError(reason) } finally { setBusy(false) }
  }
  return <Modal title={`Edit ${record.defect_key}`} onClose={onClose} closeDisabled={busy} workView wide><form onSubmit={save}>
    <Field label="Title *"><input required maxLength={255} value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))} /></Field>
    <Field label="Category *"><select value={form.observation_category} onChange={event => setForm(current => ({ ...current, observation_category: event.target.value }))}>{OBSERVATION_CATEGORIES.map(value => <option key={value}>{value}</option>)}</select></Field>
    <Field label="Observation details *"><textarea required rows={8} value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} /></Field>
    <ErrorText error={error} /><div className="modal-actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
  </form></Modal>
}

function ObservationActionModal({ record, action, onClose, onChanged }: { record: DefectOut; action: string; onClose: () => void; onChanged: (record: DefectOut) => void }) {
  const convert = action === 'convert'
  const [form, setForm] = useWorkState(`observation.action.${action}`, { reason: '', outcome: '', severity: 'Medium', priority: 'P3 – Medium', environment: ENVIRONMENTS.includes(record.environment) ? record.environment : '', module_feature: record.module_feature === 'General' ? '' : record.module_feature, steps_to_reproduce: '', expected_result: '', actual_result: '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const submitting = useRef(false)
  useWorkBusy(busy)
  const set = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }))
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setError(null)
    try {
      const payload = convert ? { ...form, outcome: undefined } : { status: action, reason: form.reason, outcome: action === 'Closed' ? form.outcome : undefined }
      const updated = await api.post<DefectOut>(`/api/defects/${record.id}/${convert ? 'convert-to-defect' : 'observation-action'}`, { ...payload, revision: record.workflow_revision || 0 })
      setForm(current => ({ ...current, reason: '', outcome: '' })); onChanged(updated)
    } catch (reason) { setError(reason) } finally { submitting.current = false; setBusy(false) }
  }
  return <Modal title={convert ? `Convert ${record.defect_key} to Defect` : `${action === 'New' ? 'Reopen' : action === 'Under Review' ? 'Review' : 'Close'} ${record.defect_key}`} onClose={onClose} closeDisabled={busy} workView wide><form onSubmit={save}>
    {convert && <p>A new DEF number will be assigned. The original OBS number, links, attachments, comments and history will remain available. The defect starts at New.</p>}
    <Field label={convert ? 'Conversion reason *' : action === 'Closed' ? 'Closure reason *' : 'Review / reopen reason *'}><textarea required rows={3} maxLength={4000} value={form.reason} onChange={event => set('reason', event.target.value)} /></Field>
    {!convert && action === 'Closed' && <Field label="Outcome *"><select required value={form.outcome} onChange={event => set('outcome', event.target.value)}><option value="">Select outcome</option>{OUTCOMES.map(value => <option key={value}>{value}</option>)}</select></Field>}
    {convert && <><div className="observation-grid">
      <Field label="Severity *"><select value={form.severity} onChange={event => set('severity', event.target.value)}>{SEVERITIES.map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Priority *"><select value={form.priority} onChange={event => set('priority', event.target.value)}>{PRIORITIES.map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Environment *"><select required value={form.environment} onChange={event => set('environment', event.target.value)}><option value="">Select environment</option>{ENVIRONMENTS.map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Feature / Area *"><input required maxLength={150} value={form.module_feature} onChange={event => set('module_feature', event.target.value)} /></Field>
    </div>{(['steps_to_reproduce', 'expected_result', 'actual_result'] as const).map((key, index) => <Field key={key} label={`${['Steps to reproduce', 'Expected result', 'Actual result'][index]} *`}><textarea required rows={3} value={form[key]} onChange={event => set(key, event.target.value)} /></Field>)}</>}
    <ErrorText error={error} /><div className="modal-actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : convert ? 'Convert to Defect' : 'Confirm'}</button><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
  </form></Modal>
}

function ObservationExecutionModal({ record, onClose, onChanged }: { record: DefectOut; onClose: () => void; onChanged: (record: DefectOut) => void }) {
  const executions = useExecutionOptions(record.application_name)
  const [selected, setSelected] = useWorkState('observation.link.execution', '')
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  useWorkBusy(busy)
  const existing = new Set([record.execution_id, ...record.execution_links.map(link => link.execution_id)])
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy || !selected) return; setBusy(true); setError(null)
    try { const updated = await api.post<DefectOut>(`/api/defects/${record.id}/link-execution`, { execution_id: Number(selected), expected_revision: record.workflow_revision || 0 }); setSelected(''); onChanged(updated) }
    catch (reason) { setError(reason) } finally { setBusy(false) }
  }
  return <Modal title="Link observation to test execution" onClose={onClose} closeDisabled={busy} variant="dialog" compact><form onSubmit={save}>
    <p>Select execution context. Its result and previous attempts will stay unchanged.</p>
    <Field label="Test execution *"><SearchableSelect ariaLabel="Execution to link" value={selected} onChange={setSelected} options={executions.rows.filter(row => !existing.has(row.execution.id)).map(row => ({ value: String(row.execution.id), label: `${row.cycle.cycle_key} · ${row.execution.test_case?.test_case_key || `Execution #${row.execution.id}`} · ${row.execution.status}` }))} /></Field>
    <ErrorText error={error || executions.error} />{!!executions.error && <button type="button" className="btn" onClick={executions.retry}>Retry loading executions</button>}
    <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !selected}>{busy ? 'Linking…' : 'Link execution'}</button><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
  </form></Modal>
}
