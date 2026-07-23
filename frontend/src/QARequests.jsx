import React, { useEffect, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText } from '../components/Common'
import {
  REQUEST_TYPES, PRIORITIES, RISK_RATINGS, ENVIRONMENTS,
  QA_STATUSES, QA_STATUS_LABELS, QA_TERMINAL_STATUSES,
} from '../constants'

const EMPTY_FORM = {
  department: '', application_name: '', application_owner: '', cr_number: '',
  project_name: '', release_version: '', environment: 'SIT', request_types: [],
  request_type_other: '', priority: 'Medium', risk_rating: 'Medium',
  target_release_date: '', remarks: '',
}

function NewRequestModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [files, setFiles] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })) }
  function toggleType(t) {
    setForm((f) => ({
      ...f,
      request_types: f.request_types.includes(t) ? f.request_types.filter((x) => x !== t) : [...f.request_types, t],
    }))
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = { ...form, target_release_date: form.target_release_date || null }
      const created = await api.post('/api/qa-requests', payload)
      if (files.length > 0) {
        // Uploaded after creation so files can be stored under the request's
        // own request_id folder (backend/app/uploads/<request_id>/...).
        await api.uploadFiles(`/api/qa-requests/${created.id}/documents`, files)
      }
      onCreated(created)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Raise QA Request" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Application Name *"><input required value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
          <Field label="Application Owner"><input value={form.application_owner} onChange={(e) => set('application_owner', e.target.value)} /></Field>
          <Field label="Department"><input value={form.department} onChange={(e) => set('department', e.target.value)} /></Field>
          <Field label="CR Number"><input value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
          <Field label="Project Name"><input value={form.project_name} onChange={(e) => set('project_name', e.target.value)} /></Field>
          <Field label="Release Version"><input value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
          <Field label="Environment">
            <select value={form.environment} onChange={(e) => set('environment', e.target.value)}>
              {ENVIRONMENTS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Target Release Date"><input type="date" value={form.target_release_date} onChange={(e) => set('target_release_date', e.target.value)} /></Field>
          <Field label="Priority">
            <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Risk Rating">
            <select value={form.risk_rating} onChange={(e) => set('risk_rating', e.target.value)}>
              {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Request Type">
          <div className="checkbox-list" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {REQUEST_TYPES.map((t) => (
              <label key={t}>
                <input type="checkbox" checked={form.request_types.includes(t)} onChange={() => toggleType(t)} /> {t}
              </label>
            ))}
          </div>
          {form.request_types.includes('Others') && (
            <input
              placeholder="Please specify other request type"
              value={form.request_type_other}
              onChange={(e) => set('request_type_other', e.target.value)}
              style={{ marginTop: 8 }}
            />
          )}
        </Field>
        <Field label="Supporting Documents Upload">
          <input
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files))}
          />
          {files.length > 0 && (
            <p className="muted small" style={{ marginTop: 4 }}>
              {files.length} file{files.length > 1 ? 's' : ''} selected: {files.map((f) => f.name).join(', ')}
            </p>
          )}
        </Field>
        <Field label="Remarks"><textarea value={form.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
        <p className="muted small" style={{ marginTop: -4 }}>
          Submitting will also create the "Ready for Testing" readiness checklist for this request —
          you'll land on it (and can attach more documents) right after submitting.
        </p>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Submitting...' : 'Submit Request'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function userName(users, id) {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

function RequestDetail({ req, onClose, onChanged, users }) {
  const { user } = useAuth()
  const [tab, setTab] = useState('overview')
  const [checklist, setChecklist] = useState([])
  const [walkthroughs, setWalkthroughs] = useState([])
  const [documents, setDocuments] = useState([])
  const [history, setHistory] = useState([])
  const [error, setError] = useState(null)
  const [comments, setComments] = useState('')
  const [selectedQALead, setSelectedQALead] = useState('')
  const [selectedTesters, setSelectedTesters] = useState([])
  const [busyAction, setBusyAction] = useState(null)

  const load = useCallback(async () => {
    try {
      const [cl, wt, docs, hist] = await Promise.all([
        api.get(`/api/qa-requests/${req.id}/checklist`),
        api.get(`/api/qa-requests/${req.id}/walkthroughs`),
        api.get(`/api/qa-requests/${req.id}/documents`),
        api.get(`/api/qa-requests/${req.id}/history`),
      ])
      setChecklist(cl); setWalkthroughs(wt); setDocuments(docs); setHistory(hist)
    } catch (err) { setError(err) }
  }, [req.id])

  useEffect(() => { load() }, [load])

  async function act(action, extra) {
    setError(null)
    setBusyAction(action)
    try {
      const updated = await api.post(`/api/qa-requests/${req.id}/${action}`, extra || {})
      onChanged(updated)
      load()
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  async function toggleChecklistItem(item) {
    setError(null)
    try {
      await api.put(`/api/qa-requests/${req.id}/checklist/${item.id}`, { is_complete: !item.is_complete })
      load()
    } catch (err) { setError(err) }
  }

  const qaLeads = users.filter((u) => u.role === 'QA_LEAD')
  const testers = users.filter((u) => u.role === 'QA_ENGINEER')

  const isAdmin = user.role === 'ADMIN'
  const isRequester = (req.requester_id === user.id) || isAdmin
  const isAssignedQALead = (req.qa_lead_id === user.id) || isAdmin
  const isRequesterVerifier = isRequester || user.role === 'APPLICATION_OWNER'

  const status = req.status
  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_EXECUTIVE', 'RETURNED_BY_QA_LEAD'].includes(status)
  const canExecutiveDecide = ['PROJECT_MANAGER', 'ADMIN'].includes(user.role) && status === 'EXECUTIVE_APPROVAL_PENDING'
  const canStartReadiness = ['QA_LEAD', 'ADMIN'].includes(user.role) && isAssignedQALead && status === 'QA_LEAD_ASSIGNED'
  const canReadinessDecide = ['QA_LEAD', 'ADMIN'].includes(user.role) && status === 'READINESS_VERIFICATION'
  const canBeginPlanning = ['QA_LEAD', 'ADMIN'].includes(user.role) && status === 'QA_ACTIVITY_INITIATED'
  const canAssignTester = ['QA_LEAD', 'ADMIN'].includes(user.role) && status === 'PLANNING'
  const canStartTestDesign = ['QA_LEAD', 'QA_ENGINEER', 'ADMIN'].includes(user.role) && status === 'TESTER_ASSIGNED'
  const canStartExecution = ['QA_LEAD', 'QA_ENGINEER', 'ADMIN'].includes(user.role) && status === 'TEST_DESIGN'
  const canRaiseDefect = ['QA_LEAD', 'QA_ENGINEER', 'ADMIN'].includes(user.role) && status === 'EXECUTION_IN_PROGRESS'
  const canMarkWaitingForFix = ['QA_LEAD', 'QA_ENGINEER', 'ADMIN'].includes(user.role) && status === 'DEFECT_RAISED'
  const canStartRetest = ['QA_LEAD', 'QA_ENGINEER', 'ADMIN'].includes(user.role) && status === 'WAITING_FOR_FIX'
  const canStartRegression = ['QA_LEAD', 'QA_ENGINEER', 'ADMIN'].includes(user.role) && status === 'RETESTING'
  const canCompleteQA = ['QA_LEAD', 'QA_ENGINEER', 'ADMIN'].includes(user.role)
    && ['EXECUTION_IN_PROGRESS', 'RETESTING', 'REGRESSION_TESTING'].includes(status)
  const canRequestSignoff = ['QA_LEAD', 'ADMIN'].includes(user.role) && status === 'QA_COMPLETED'
  const canConfirmSignoff = ['QA_LEAD', 'ADMIN'].includes(user.role) && status === 'QA_SIGNOFF_PENDING'
  const canRequesterDecide = isRequesterVerifier && status === 'REQUESTER_VERIFICATION'
  const canCancel = isRequester && !QA_TERMINAL_STATUSES.includes(status) && status !== 'CLOSED'

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'checklist', 'walkthroughs', 'documents', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
          <div className="grid grid-2">
            <div><strong>Status:</strong> <Badge status={req.status} /></div>
            <div><strong>Priority / Risk:</strong> {req.priority} / {req.risk_rating}</div>
            <div><strong>Department:</strong> {req.department || '—'}</div>
            <div><strong>CR Number:</strong> {req.cr_number || '—'}</div>
            <div><strong>Project:</strong> {req.project_name || '—'}</div>
            <div><strong>Environment:</strong> {req.environment || '—'}</div>
            <div><strong>Release:</strong> {req.release_version || '—'}</div>
            <div><strong>Target Release Date:</strong> {req.target_release_date || '—'}</div>
            <div><strong>Request Type(s):</strong> {req.request_types || '—'}{req.request_type_other ? ` (${req.request_type_other})` : ''}</div>
            <div><strong>Executive:</strong> {userName(users, req.executive_id) || '—'}</div>
            <div><strong>QA Lead:</strong> {userName(users, req.qa_lead_id) || '—'}</div>
            <div><strong>Assigned Tester(s):</strong> {
              req.assigned_tester_ids
                ? req.assigned_tester_ids.split(',').map((id) => userName(users, Number(id)) || id).join(', ')
                : '—'
            }</div>
          </div>
          {req.remarks && <p><strong>Remarks:</strong> {req.remarks}</p>}

          <div className="section-title">Workflow Actions</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {canSubmit && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('submit')}>Submit for Executive Approval</button>
            )}
            {canResubmit && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('resubmit')}>Re-submit</button>
            )}

            {canExecutiveDecide && (
              <>
                <select value={selectedQALead} onChange={(e) => setSelectedQALead(e.target.value)} style={{ minWidth: 180 }}>
                  <option value="">Assign QA Lead...</option>
                  {qaLeads.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
                <button className="btn btn-success btn-sm" disabled={!selectedQALead || busyAction}
                        onClick={() => act('executive-decision', { decision: 'Approved', qa_lead_id: Number(selectedQALead), comments })}>
                  Approve
                </button>
                <button className="btn btn-sm" disabled={busyAction}
                        onClick={() => act('executive-decision', { decision: 'Returned', comments })}>Return to Requester</button>
                <button className="btn btn-danger btn-sm" disabled={busyAction}
                        onClick={() => act('executive-decision', { decision: 'Rejected', comments })}>Reject</button>
              </>
            )}

            {canStartReadiness && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('start-readiness-verification')}>
                Start Readiness Verification
              </button>
            )}
            {canReadinessDecide && (
              <>
                <button className="btn btn-success btn-sm" disabled={busyAction}
                        onClick={() => act('readiness-decision', { decision: 'Passed', comments })}>Readiness Passed</button>
                <button className="btn btn-danger btn-sm" disabled={busyAction}
                        onClick={() => act('readiness-decision', { decision: 'Failed', comments })}>Readiness Failed</button>
              </>
            )}

            {canBeginPlanning && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('begin-planning')}>Begin Planning</button>
            )}
            {canAssignTester && (
              <>
                <select multiple value={selectedTesters} onChange={(e) => setSelectedTesters(Array.from(e.target.selectedOptions, (o) => o.value))} style={{ minWidth: 180 }}>
                  {testers.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" disabled={selectedTesters.length === 0 || busyAction}
                        onClick={() => act('assign-tester', { tester_ids: selectedTesters.map(Number) })}>Assign Tester(s)</button>
              </>
            )}
            {canStartTestDesign && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('start-test-design')}>Start Test Design</button>
            )}
            {canStartExecution && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('start-execution')}>Start Execution</button>
            )}

            {canRaiseDefect && (
              <button className="btn btn-danger btn-sm" disabled={busyAction} onClick={() => act('raise-defect', { comments })}>Raise Defect</button>
            )}
            {canMarkWaitingForFix && (
              <button className="btn btn-sm" disabled={busyAction} onClick={() => act('mark-waiting-for-fix', { comments })}>Mark Waiting For Fix</button>
            )}
            {canStartRetest && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('start-retesting', { comments })}>Start Retesting</button>
            )}
            {canStartRegression && (
              <button className="btn btn-sm" disabled={busyAction} onClick={() => act('start-regression', { comments })}>Start Regression Testing</button>
            )}
            {canCompleteQA && (
              <button className="btn btn-success btn-sm" disabled={busyAction} onClick={() => act('complete-qa', { comments })}>Mark QA Completed</button>
            )}

            {canRequestSignoff && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('request-signoff')}>Request Sign-off</button>
            )}
            {canConfirmSignoff && (
              <button className="btn btn-success btn-sm" disabled={busyAction} onClick={() => act('confirm-signoff', { comments })}>Confirm Sign-off</button>
            )}

            {canRequesterDecide && (
              <>
                <button className="btn btn-success btn-sm" disabled={busyAction}
                        onClick={() => act('requester-decision', { decision: 'Accepted', comments })}>Accept &amp; Close</button>
                <button className="btn btn-danger btn-sm" disabled={busyAction}
                        onClick={() => act('requester-decision', { decision: 'ChangesRequired', comments })}>Changes Required</button>
              </>
            )}

            {canCancel && (
              <button className="btn btn-danger btn-sm" disabled={busyAction} onClick={() => act('cancel')}>Cancel Request</button>
            )}
            {!canSubmit && !canResubmit && !canExecutiveDecide && !canStartReadiness && !canReadinessDecide
              && !canBeginPlanning && !canAssignTester && !canStartTestDesign && !canStartExecution
              && !canRaiseDefect && !canMarkWaitingForFix && !canStartRetest && !canStartRegression
              && !canCompleteQA && !canRequestSignoff && !canConfirmSignoff && !canRequesterDecide && !canCancel && (
              <span className="muted small">No actions available for your role at this stage.</span>
            )}
          </div>
          {(canExecutiveDecide || canReadinessDecide || canRaiseDefect || canMarkWaitingForFix || canStartRetest
            || canStartRegression || canCompleteQA || canConfirmSignoff || canRequesterDecide) && (
            <input placeholder="Comments (optional)" value={comments} onChange={(e) => setComments(e.target.value)}
                   style={{ marginTop: 8, width: '100%', padding: 8, border: '1px solid var(--border)', borderRadius: 6 }} />
          )}
        </div>
      )}

      {tab === 'checklist' && (
        <div>
          <p className="muted small">"Ready for Testing" gate — all mandatory items must be complete before Testing Initiation.</p>
          {checklist.map((c) => (
            <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <input type="checkbox" checked={c.is_complete} onChange={() => toggleChecklistItem(c)} />
              <span style={{ flex: 1 }}>{c.item} <span className="muted small">({c.owner})</span></span>
              {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
            </label>
          ))}
        </div>
      )}

      {tab === 'walkthroughs' && (
        <div>
          <Table
            rowKey="id"
            columns={[
              { key: 'session_date', header: 'Date', render: (r) => new Date(r.session_date).toLocaleString() },
              { key: 'conducted_by', header: 'Conducted By' },
              { key: 'participants', header: 'Participants' },
              { key: 'qa_acknowledged_at', header: 'QA Acknowledged', render: (r) => r.qa_acknowledged_at ? 'Yes' : 'No' },
            ]}
            rows={walkthroughs}
          />
          <AddWalkthrough reqId={req.id} onAdded={load} />
        </div>
      )}

      {tab === 'documents' && (
        <div>
          <Table
            rowKey="id"
            columns={[
              { key: 'file_name', header: 'File' },
              { key: 'file_size', header: 'Size', render: (d) => d.file_size ? `${(d.file_size / 1024).toFixed(1)} KB` : '—' },
              { key: 'uploaded_at', header: 'Uploaded', render: (d) => new Date(d.uploaded_at).toLocaleString() },
              {
                key: 'download', header: '', render: (d) => (
                  <button className="btn btn-sm" onClick={() =>
                    api.downloadFile(`/api/qa-requests/${req.id}/documents/${d.id}/download`, d.file_name)}>
                    Download
                  </button>
                ),
              },
            ]}
            rows={documents}
          />
          <AddDocuments reqId={req.id} onAdded={load} />
        </div>
      )}

      {tab === 'history' && (
        <Table
          rowKey="id"
          columns={[
            { key: 'step_name', header: 'Step' },
            { key: 'decision', header: 'Decision' },
            { key: 'actor_role', header: 'Role' },
            { key: 'comments', header: 'Comments' },
            { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
          ]}
          rows={history}
        />
      )}
    </Modal>
  )
}

function AddDocuments({ reqId, onAdded }) {
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.uploadFiles(`/api/qa-requests/${reqId}/documents`, files)
      setFiles([])
      onAdded()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files))} />
      <button className="btn btn-sm" disabled={busy || files.length === 0}>
        {busy ? 'Uploading...' : 'Upload'}
      </button>
      <ErrorText error={error} />
    </form>
  )
}

function AddWalkthrough({ reqId, onAdded }) {
  const [conducted_by, setConductedBy] = useState('')
  const [participants, setParticipants] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post(`/api/qa-requests/${reqId}/walkthroughs`, { conducted_by, participants, notes })
      setConductedBy(''); setParticipants(''); setNotes('')
      onAdded()
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input placeholder="Conducted by" value={conducted_by} onChange={(e) => setConductedBy(e.target.value)} />
      <input placeholder="Participants" value={participants} onChange={(e) => setParticipants(e.target.value)} />
      <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button className="btn btn-sm" disabled={busy}>Log Walkthrough Session</button>
    </form>
  )
}

export default function QARequests() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const searchParams = new URLSearchParams(location.search)
  const [requests, setRequests] = useState([])
  const [users, setUsers] = useState([])
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState(searchParams.get('application_name') || '')
  const [showNew, setShowNew] = useState(Boolean(location.state?.openNew))
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (location.state?.openNew) {
      // Clear the nav state so refreshing/back doesn't reopen the modal.
      navigate(location.pathname, { replace: true, state: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (statusFilter) qs.set('status_filter', statusFilter)
      if (search) qs.set('application_name', search)
      const [reqs, us] = await Promise.all([
        api.get(`/api/qa-requests?${qs.toString()}`),
        api.get('/api/auth/users'),
      ])
      setRequests(reqs)
      setUsers(us)
    } catch (err) { setError(err) }
  }, [statusFilter, search])

  useEffect(() => { load() }, [load])

  const canCreate = ['REQUESTER', 'BUSINESS_ANALYST', 'ADMIN'].includes(user.role)

  return (
    <div>
      <ErrorText error={error} />
      <div className="toolbar">
        <input placeholder="Search by application..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {QA_STATUSES.map((s) => (
            <option key={s} value={s}>{QA_STATUS_LABELS[s] || s}</option>
          ))}
        </select>
        <div className="spacer" />
        {canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Raise QA Request</button>}
      </div>

      <Card>
        <Table
          rowKey="id"
          onRowClick={(r) => setSelected(r)}
          columns={[
            { key: 'request_id', header: 'Request ID' },
            { key: 'application_name', header: 'Application' },
            { key: 'project_name', header: 'Project' },
            { key: 'priority', header: 'Priority' },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
            { key: 'target_release_date', header: 'Target Release' },
          ]}
          rows={requests}
        />
      </Card>

      {showNew && (
        <NewRequestModal onClose={() => setShowNew(false)} onCreated={(created) => {
          // Land straight on the new request's detail view (Checklist / Documents
          // tabs) instead of dropping the user back on the bare list.
          setShowNew(false)
          load()
          setSelected(created)
        }} />
      )}
      {selected && (
        <RequestDetail req={selected} users={users} onClose={() => setSelected(null)}
                        onChanged={(updated) => { setSelected(updated); load() }} />
      )}
    </div>
  )
}
