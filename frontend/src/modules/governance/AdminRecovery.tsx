import React, { useEffect, useRef, useState } from 'react'
import './AdminRecovery.css'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { useRequestNavigation } from '../../hooks/useRequestNavigation'
import { Card, ErrorText, Field, Modal, Table, WarningNotice, type TableColumn } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import MultiSelect from '../../components/MultiSelect'
import MultiUserAssignSelect from '../../components/MultiUserAssignSelect'
import UserAssignSelect from '../../components/UserAssignSelect'
import { formatDateTimeIST } from '../../time'

type RecordOption = { id: number; key: string; name: string }
type Project = RecordOption & { application: string | null; active: boolean }
type RequestOption = { id: number; key: string; application: string; status: string }
type Owner = { id: number; name: string }
type RequestContext = { key: string; status: string; application: string; actions: string[]; message: string; multiple_owners: boolean; owners: Owner[]; hold_owners: Owner[] }
type Preview = {
  source?: Project; destination?: Project; counts?: Record<string, number>;
  records?: Record<string, string[]>; warnings: string[]; blockers: string[];
  request_key?: string; application?: string; from_status?: string; to_status?: string;
  action?: string; owner_ids?: number[]; changes?: Record<string, unknown>;
}
export type RecoveryJob = { id: number; recovery_key: string; kind: string; status: string; reason: string; actor_name: string; created_at: string; applied_at: string | null; reversed_at: string | null; preview: Preview; changes?: { table: string; id: number; record: string; before: Record<string, unknown>; after: Record<string, unknown> }[]; can_reverse: boolean }
const ACTIONS: Record<string, string> = {
  RETURN_TO_REQUESTER: 'Return to requester for correction', REASSIGN_OWNER: 'Recover responsible owner',
  REVIEW_READINESS: 'Return to fresh QA review', INTERNAL_HOLD: 'Open internal hold',
}
const REQUEST_TYPES = ['FUNCTIONAL', 'SAST', 'DAST', 'PERFORMANCE', 'SUPPRESSION']
const REQUEST_PATHS: Record<string, string> = { FUNCTIONAL: '/functional-requests', SAST: '/sast', DAST: '/dast', PERFORMANCE: '/performance', SUPPRESSION: '/suppression' }
const optionLabel = (row: RecordOption) => `${row.key} — ${row.name}`

function RecoveryImpact({ job }: { job: RecoveryJob }) {
  const p = job.preview
  const labels: Record<string, string> = { project_id: 'Project', folder_id: 'Folder', status: 'Stage', application_name: 'Application', assigned_tester_ids: 'Testers', qa_lead_id: 'QA lead', security_lead_id: 'Security lead', security_analyst_id: 'Analyst', engineer_id: 'QA lead', is_complete: 'QA verified', approved_by_id: 'Verified by', approved_at: 'Verified at', needs_dept_head_reapproval: 'Department Head reapproval' }
  const describe = (values: Record<string, unknown>) => Object.entries(values).map(([key, value]) => `${labels[key] || key}: ${value === null ? 'Not set' : String(value)}`).join(' · ')
  return <div className="recovery-impact">
    <p><strong>{job.recovery_key}</strong> · {job.status}</p>
    {p.source && p.destination && <p><strong>{p.source.key} — {p.source.name}</strong> → <strong>{p.destination.key} — {p.destination.name}</strong></p>}
    {p.request_key && <p><strong>{p.request_key}</strong> · {p.application}<br />{p.from_status} → {p.to_status}</p>}
    {p.counts && <dl className="recovery-counts">{Object.entries(p.counts).map(([key, count]) => <div key={key}><dt>{key}</dt><dd>{count}</dd></div>)}</dl>}
    {p.records && Object.entries(p.records).map(([key, values]) => values.length > 0 && <details key={key}><summary>{key} · {values.length}</summary><p>{values.join(', ')}</p></details>)}
    {p.owner_ids && p.owner_ids.length > 0 && <p>Selected owner IDs: {p.owner_ids.join(', ')}</p>}
    {p.warnings.map((message, i) => <WarningNotice key={i} compact title="Recovery impact">{message}</WarningNotice>)}
    {p.blockers.length > 0 && <WarningNotice title="Resolve these items before applying" role="alert"><ul>{p.blockers.map((message, i) => <li key={i}>{message}</li>)}</ul></WarningNotice>}
    <p><strong>Reason:</strong> {job.reason}</p>
    {!!job.changes?.length && <details><summary>Recorded corrections · {job.changes.length}</summary><Table rows={job.changes.map(row => ({ ...row, key: `${row.table}:${row.id}` }))} rowKey="key" tableId="recovery-recorded-changes" columns={[
      { key: 'record', header: 'Record' }, { key: 'before', header: 'Before', render: row => describe(row.before) },
      { key: 'after', header: 'After', render: row => describe(row.after) },
    ]} /></details>}
  </div>
}

export default function AdminRecovery() {
  const { user } = useAuth()
  const navigate = useRequestNavigation()
  const workspace = user?.active_workspace_id
  const [mode, setMode] = useState<'MIGRATION' | 'WORKFLOW' | 'HISTORY'>('MIGRATION')
  const [projects, setProjects] = useState<Project[]>([])
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [whole, setWhole] = useState(true)
  const [scope, setScope] = useState<{ testcases: RecordOption[]; cycles: RecordOption[] }>({ testcases: [], cycles: [] })
  const [cases, setCases] = useState<string[]>([])
  const [cycles, setCycles] = useState<string[]>([])
  const [classification, setClassification] = useState(false)
  const [requestType, setRequestType] = useState('FUNCTIONAL')
  const [requestSearch, setRequestSearch] = useState('')
  const [requests, setRequests] = useState<RequestOption[]>([])
  const [requestId, setRequestId] = useState('')
  const [context, setContext] = useState<RequestContext | null>(null)
  const [action, setAction] = useState('')
  const [owners, setOwners] = useState<string[]>([])
  const [correction, setCorrection] = useState('')
  const [reapproval, setReapproval] = useState(false)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<RecoveryJob | null>(null)
  const [history, setHistory] = useState<RecoveryJob[]>([])
  const [detail, setDetail] = useState<RecoveryJob | null>(null)
  const [reverseReason, setReverseReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  const saving = useRef(false)
  const inputKey = JSON.stringify([workspace, mode, source, target, whole, cases, cycles, classification, requestType, requestId, action, owners, correction, reapproval, reason])
  const currentInputKey = useRef(inputKey)
  currentInputKey.current = inputKey

  function resetPreview() { generation.current++; setPreview(null); setMessage(''); setError(null) }
  function reloadHistory() { return api.getFresh<RecoveryJob[]>('/api/admin-recovery/jobs').then(setHistory) }
  useEffect(() => {
    let current = true
    generation.current++; setPreview(null); setDetail(null); setSource(''); setTarget(''); setRequestId(''); setHistory([]); setProjects([]); setLoading(true)
    Promise.all([api.getFresh<Project[]>('/api/admin-recovery/projects'), api.getFresh<RecoveryJob[]>('/api/admin-recovery/jobs')])
      .then(([p, jobs]) => { if (current) { setProjects(p); setHistory(jobs) } })
      .catch(err => { if (current) setError(err) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; generation.current++ }
  }, [workspace])
  useEffect(() => {
    let current = true
    setScope({ testcases: [], cycles: [] }); setCases([]); setCycles([])
    if (source) api.getFresh<typeof scope>(`/api/admin-recovery/projects/${source}/scope`)
      .then(value => { if (current) setScope(value) }).catch(err => { if (current) setError(err) })
    return () => { current = false }
  }, [source, workspace])
  useEffect(() => {
    let current = true
    if (mode === 'WORKFLOW') api.getFresh<RequestOption[]>(`/api/admin-recovery/requests?request_type=${requestType}&search=${encodeURIComponent(requestSearch)}`)
      .then(value => { if (current) setRequests(value) }).catch(err => { if (current) setError(err) })
    return () => { current = false }
  }, [mode, requestType, requestSearch, workspace])
  useEffect(() => {
    let current = true
    setContext(null); setAction(''); setOwners([])
    if (requestId) api.getFresh<RequestContext>(`/api/admin-recovery/requests/${requestType}/${requestId}/context`)
      .then(value => { if (current) setContext(value) }).catch(err => { if (current) setError(err) })
    return () => { current = false }
  }, [requestId, requestType, workspace])

  const sourceProject = projects.find(row => String(row.id) === source)
  const targetProject = projects.find(row => String(row.id) === target)
  const appChanges = sourceProject && targetProject && sourceProject.application?.trim().toLowerCase() !== targetProject.application?.trim().toLowerCase()
  const ownerOptions = (action === 'INTERNAL_HOLD' ? context?.hold_owners : context?.owners)?.map(row => ({ id: row.id, full_name: row.name, is_active: true, show_in_user_dropdowns: true })) || []
  const needsOwner = action === 'REASSIGN_OWNER' || action === 'INTERNAL_HOLD'
  const needsCorrection = action === 'RETURN_TO_REQUESTER' || action === 'INTERNAL_HOLD'
  const eligible = reason.trim().length >= 5 && (mode === 'MIGRATION'
    ? !!source && !!target && source !== target && (whole || cases.length > 0 || cycles.length > 0) && (!appChanges || classification)
    : !!context && context.actions.includes(action) && (!needsOwner || owners.length > 0) && (!needsCorrection || !!correction.trim()))

  async function makePreview(event: React.FormEvent) {
    event.preventDefault()
    if (saving.current || !eligible) return
    saving.current = true; setBusy(true); setError(null); setMessage(''); setPreview(null)
    const version = ++generation.current, key = inputKey
    const ids = (labels: string[], options: RecordOption[]) => options.filter(row => labels.includes(optionLabel(row))).map(row => row.id)
    const body = mode === 'MIGRATION'
      ? { kind: mode, reason, source_project_id: Number(source), target_project_id: Number(target), whole_project: whole,
          case_ids: whole ? [] : ids(cases, scope.testcases), cycle_ids: whole ? [] : ids(cycles, scope.cycles), classification_correction: classification }
      : { kind: mode, reason, request_type: requestType, request_id: Number(requestId), action,
          owner_ids: needsOwner ? owners.map(Number) : [], requested_correction: needsCorrection ? correction : '', require_dept_head_reapproval: reapproval }
    try {
      const result = await api.post<RecoveryJob>('/api/admin-recovery/preview', body)
      if (version === generation.current && key === currentInputKey.current) setPreview(result)
    } catch (err) { if (version === generation.current) setError(err) }
    finally { saving.current = false; setBusy(false) }
  }
  async function applyPreview() {
    if (saving.current || !preview || preview.status !== 'PREVIEWED' || preview.preview.blockers.length) return
    saving.current = true; setBusy(true); setError(null)
    const job = preview, version = generation.current
    try {
      const result = await api.post<RecoveryJob>(`/api/admin-recovery/jobs/${job.recovery_key}/apply`, {})
      if (version === generation.current) {
        setPreview(result); setMessage(result.kind === 'MIGRATION' ? 'Move completed. The moved records now belong to the destination project only.' : 'Recovery completed. The request remains subject to its normal workflow checks.')
        // A committed receipt remains visible even if the history refresh fails.
        try { await reloadHistory() } catch { setMessage(value => `${value} History refresh is unavailable; reopen this page to reload it.`) }
      }
    } catch (err) { if (version === generation.current) { setError(err); setPreview(null) } }
    finally { saving.current = false; setBusy(false) }
  }
  async function reverseMove() {
    if (saving.current || !detail?.can_reverse || reverseReason.trim().length < 5) return
    saving.current = true; setBusy(true); setError(null)
    try {
      const result = await api.post<RecoveryJob>(`/api/admin-recovery/jobs/${detail.recovery_key}/reverse`, { reason: reverseReason })
      setDetail(result); setReverseReason(''); setMessage('Migration reversed. Records returned to their original project and folders.')
      await reloadHistory()
    } catch (err) { setError(err) } finally { saving.current = false; setBusy(false) }
  }
  const columns: TableColumn<RecoveryJob>[] = [
    { key: 'recovery_key', header: 'Recovery', render: row => <button className="btn btn-link" onClick={() => { setDetail(row); setReverseReason(''); setError(null) }}>{row.recovery_key}</button> },
    { key: 'status', header: 'Status' }, { key: 'kind', header: 'Operation' },
    { key: 'reason', header: 'Reason' }, { key: 'actor_name', header: 'Administrator' },
    { key: 'created_at', header: 'Created', render: row => formatDateTimeIST(row.created_at) },
  ]
  return <div className="admin-recovery">
    <div className="tab-bar" role="tablist" aria-label="Recovery operation">{([['MIGRATION', 'Move project work'], ['WORKFLOW', 'Recover request'], ['HISTORY', 'Recovery history']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={mode === value} className={`tab ${mode === value ? 'active' : ''}`} disabled={busy} onClick={() => { resetPreview(); setMode(value) }}>{label}</button>)}</div>
    <ErrorText error={error} />
    {message && <p role="status">{message}</p>}
    {mode === 'HISTORY' ? <Card title="Recovery history" subtitle="Latest 50 plans in the selected workspace. Each applied job retains its reason, actor and impact."><button className="btn" disabled={busy} onClick={() => { reloadHistory().catch(setError) }}>Refresh history</button><Table columns={columns} rows={history} rowKey="id" tableId="admin-recovery-history" /></Card>
      : <Card title={mode === 'MIGRATION' ? 'Move testing work to another project' : 'Recover request workflow'} subtitle="Review the impact before applying. Every correction is audited.">
        {loading ? <p role="status">Loading recovery tools…</p> : <form onSubmit={makePreview} onChange={resetPreview}>
          <fieldset disabled={busy} className="recovery-fields">
            {mode === 'MIGRATION' ? <>
              <Field label="Source project *"><SearchableSelect ariaLabel="Recovery source project" value={source} onChange={value => { resetPreview(); setSource(value); setClassification(false) }} options={projects.map(row => ({ value: String(row.id), label: `${row.key} — ${row.name} · ${row.application || 'No application'}`, disabled: !row.active }))} /></Field>
              <Field label="Destination project *"><SearchableSelect ariaLabel="Recovery destination project" value={target} onChange={value => { resetPreview(); setTarget(value); setClassification(false) }} options={projects.filter(row => String(row.id) !== source).map(row => ({ value: String(row.id), label: `${row.key} — ${row.name} · ${row.application || 'No application'}`, disabled: !row.active }))} /></Field>
              <label><input type="checkbox" checked={whole} onChange={event => setWhole(event.target.checked)} /> Move all testcases, cycles and folders in the source project</label>
              {!whole && <><Field label="Testcases"><MultiSelect value={cases} onChange={value => { resetPreview(); setCases(value) }} options={scope.testcases.map(optionLabel)} placeholder="Select testcases…" /></Field><Field label="Test cycles"><MultiSelect value={cycles} onChange={value => { resetPreview(); setCycles(value) }} options={scope.cycles.map(optionLabel)} placeholder="Select cycles…" /></Field></>}
              <WarningNotice compact title="Actual relocation">The preview includes related cycles and testcases needed to keep execution history together. Moved records will appear only in the destination project. IDs, attempts, evidence and defect closure are preserved.</WarningNotice>
              {appChanges && <WarningNotice title="Application classification correction"><p>{sourceProject?.application} → {targetProject?.application}</p><label><input type="checkbox" checked={classification} onChange={event => setClassification(event.target.checked)} /> The existing testing was performed for the destination application; this corrects where it was recorded.</label><p>Testing performed against another application requires new testing. Incompatible request links and certificate-protected work will be blocked.</p></WarningNotice>}
            </> : <>
              <Field label="Request type *"><SearchableSelect ariaLabel="Recovery request type" searchable={false} value={requestType} onChange={value => { resetPreview(); setRequestType(value); setRequestId(''); setRequests([]); setRequestSearch('') }} options={REQUEST_TYPES} /></Field>
              <Field label="Request *"><div className="cycle-request-picker"><SearchableSelect ariaLabel="Recovery request" value={requestId} onChange={value => { resetPreview(); setRequestId(value) }} onSearchChange={setRequestSearch} options={requests.map(row => ({ value: String(row.id), label: `${row.key} · ${row.application} · ${row.status}` }))} placeholder="Search request ID or status…" /><button type="button" className="btn" disabled={!requestId || busy} onClick={() => navigate(`${REQUEST_PATHS[requestType]}?openId=${Number(requestId)}`)}>View request</button></div></Field>
              <p className="muted small">The QA gateway keeps its Raised status. Recover the affected Functional, SAST, DAST, Performance or Suppression workflow.</p>
              {context && <p>{context.key} · {context.application} · {context.status}<br />{context.message}</p>}
              <Field label="Recovery action *"><SearchableSelect ariaLabel="Recovery action" searchable={false} value={action} onChange={value => { resetPreview(); setAction(value); setOwners([]) }} options={(context?.actions || []).map(value => ({ value, label: ACTIONS[value] }))} disabled={!context} /></Field>
              {needsOwner && <Field label="Responsible owner *">{context?.multiple_owners && action === 'REASSIGN_OWNER' ? <MultiUserAssignSelect value={owners} onChange={value => { resetPreview(); setOwners(value) }} users={ownerOptions} placeholder="Select eligible owners…" showRoles={false} /> : <UserAssignSelect value={owners[0] || ''} onChange={value => { resetPreview(); setOwners(value ? [value] : []) }} users={ownerOptions} placeholder="Select eligible owner…" showRoles={false} />}</Field>}
              {needsCorrection && <><Field label="Required correction / action *"><textarea value={correction} onChange={event => setCorrection(event.target.value)} maxLength={2000} required /></Field><label><input type="checkbox" checked={reapproval} onChange={event => setReapproval(event.target.checked)} /> Require Department Head reapproval after correction</label></>}
            </>}
            <Field label="Administrative reason *"><textarea value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={2000} required /></Field>
            <button className="btn btn-primary" disabled={!eligible || busy}>{busy ? 'Working…' : 'Preview recovery'}</button>
          </fieldset>
        </form>}
        {preview && <section aria-label="Reviewed recovery preview"><RecoveryImpact job={preview} />{preview.status === 'PREVIEWED' && <button className="btn btn-primary" disabled={busy || preview.preview.blockers.length > 0} onClick={applyPreview}>{busy ? 'Applying…' : preview.kind === 'MIGRATION' ? 'Apply move' : 'Apply recovery'}</button>}</section>}
      </Card>}
    {detail && <Modal title={`Recovery details · ${detail.recovery_key}`} onClose={() => { if (!busy) setDetail(null) }} closeDisabled={busy}>
      <RecoveryImpact job={detail} />
      <p>Administrator: {detail.actor_name} · {formatDateTimeIST(detail.created_at)}</p>
      {detail.can_reverse && <><WarningNotice title="Guarded reversal">Reversal is available only while the affected project records remain unchanged. If work has continued, create a new reviewed migration.</WarningNotice><Field label="Reversal reason *"><textarea value={reverseReason} onChange={event => setReverseReason(event.target.value)} disabled={busy} minLength={5} maxLength={2000} /></Field><button className="btn" disabled={busy || reverseReason.trim().length < 5} onClick={reverseMove}>Reverse unchanged move</button></>}
      <ErrorText error={error} />
    </Modal>}
  </div>
}
