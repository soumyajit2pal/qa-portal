import React, { useEffect, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader } from '../components/Common'
import {
  REQUEST_TYPES, PRIORITIES, RISK_RATINGS, ENVIRONMENTS,
  DEFAULT_CHECKLIST_ITEMS, CONDITIONAL_CHECKLIST_ITEMS,
  QA_STATUSES, QA_STATUS_LABELS, QA_EDITABLE_STATUSES, QA_CANCELLABLE_STATUSES, hasRole,
} from '../constants'
import { IconCheckCircle } from '../components/Icons'

const EMPTY_FORM = {
  department: '', application_name: '', application_owner: '', cr_number: '',
  project_name: '', release_version: '', environment: 'SIT', request_types: [],
  request_type_other: '', priority: 'Medium', risk_rating: 'Medium',
  target_release_date: '', remarks: '', checked_items: [],
}

// Item is relevant to show in the requester's tick-list unless it's gated
// behind a request type (SAST/DAST readiness) that hasn't been selected.
function isItemRelevant(item, requestTypes) {
  const requiredType = CONDITIONAL_CHECKLIST_ITEMS[item]
  return !requiredType || requestTypes.includes(requiredType)
}

function NewRequestModal({ onClose, onCreated, editing, checklist }) {
  const { user } = useAuth()
  // Department is always the requester's own profile department -- it is
  // set/enforced server-side regardless of what's submitted here, so this
  // field is pre-filled and locked (not user-editable per request).
  const [form, setForm] = useState(editing ? {
    department: editing.department || user?.department || '',
    application_name: editing.application_name || '',
    application_owner: editing.application_owner || '',
    cr_number: editing.cr_number || '',
    project_name: editing.project_name || '',
    release_version: editing.release_version || '',
    environment: editing.environment || 'SIT',
    request_types: editing.request_types ? editing.request_types.split(',') : [],
    request_type_other: editing.request_type_other || '',
    priority: editing.priority || 'Medium',
    risk_rating: editing.risk_rating || 'Medium',
    target_release_date: editing.target_release_date || '',
    remarks: editing.remarks || '',
    // Pre-fill from the requester's previously-saved self-declaration ticks.
    checked_items: (checklist || []).filter((c) => c.requester_checked).map((c) => c.item),
  } : { ...EMPTY_FORM, department: user?.department || '' })
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
  function toggleChecked(item) {
    setForm((f) => ({
      ...f,
      checked_items: f.checked_items.includes(item) ? f.checked_items.filter((x) => x !== item) : [...f.checked_items, item],
    }))
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = { ...form, target_release_date: form.target_release_date || null }
      const saved = editing
        ? await api.put(`/api/qa-requests/${editing.id}`, payload)
        : await api.post('/api/qa-requests', payload)
      if (files.length > 0) {
        // Uploaded after creation so files can be stored under the request's
        // own request_id folder (backend/app/uploads/<request_id>/...).
        await api.uploadFiles(`/api/qa-requests/${saved.id}/documents`, files)
      }
      onCreated(saved)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const includesSecurity = form.request_types.includes('SAST') || form.request_types.includes('DAST')

  return (
    <Modal title={editing ? `Edit ${editing.request_id}` : 'Raise QA Request'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title">Application &amp; Change Details</div>
          <div className="form-row">
            <Field label="Application Name *"><input required value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
            <Field label="Application Owner"><input value={form.application_owner} onChange={(e) => set('application_owner', e.target.value)} /></Field>
            <Field label="Department">
              <input value={form.department || 'Not set on your profile'} disabled />
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                Fixed to your registered department. Contact an Administrator to change it.
              </p>
            </Field>
            <Field label="CR Number"><input value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
            <Field label="Project Name"><input value={form.project_name} onChange={(e) => set('project_name', e.target.value)} /></Field>
            <Field label="Release Version"><input value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Environment, Timeline &amp; Classification</div>
          <div className="form-row">
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
        </div>

        <div className="form-section">
          <div className="form-section-title">Request Type</div>
          <div className="chip-select">
            {REQUEST_TYPES.map((t) => {
              const active = form.request_types.includes(t)
              return (
                <label key={t} className={`chip-toggle ${active ? 'active' : ''}`}>
                  <input type="checkbox" checked={active} onChange={() => toggleType(t)} />
                  <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
                  {t}
                </label>
              )
            })}
          </div>
          {form.request_types.includes('Others') && (
            <input
              placeholder="Please specify other request type"
              value={form.request_type_other}
              onChange={(e) => set('request_type_other', e.target.value)}
              style={{ marginTop: 10 }}
            />
          )}
          {includesSecurity && (
            <p className="muted small" style={{ marginTop: 10 }}>
              Since {form.request_types.includes('SAST') && form.request_types.includes('DAST') ? 'SAST and DAST are'
                : form.request_types.includes('SAST') ? 'SAST is' : 'DAST is'} selected, a linked SAST/DAST
              request with its own unique ID will be created automatically, and the corresponding readiness
              checklist item(s) will be mandatory before testing can begin.
            </p>
          )}
        </div>

        <div className="form-section">
          <div className="form-section-title">Readiness Checklist — Self-Declaration</div>
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            Tick what's already in place. This is your own declaration for reference only — the
            QA Lead will independently verify every item during Readiness Verification.
          </p>
          {DEFAULT_CHECKLIST_ITEMS.filter((ci) => isItemRelevant(ci.item, form.request_types)).map((ci) => {
            const checked = form.checked_items.includes(ci.item)
            return (
              <label key={ci.item} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                <input type="checkbox" checked={checked} onChange={() => toggleChecked(ci.item)} />
                <span>{ci.item} <span className="muted small">({ci.owner})</span></span>
              </label>
            )
          })}
        </div>

        <div className="form-section">
          <div className="form-section-title">Supporting Documents</div>
          <Field label="Upload (multiple files supported)">
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
        </div>

        <div className="form-section">
          <div className="form-section-title">Remarks</div>
          <Field label="Additional notes (optional)"><textarea value={form.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
        </div>

        {!editing && (
          <p className="muted small" style={{ marginTop: -4 }}>
            Submitting will also create the "Ready for Testing" readiness checklist for this request —
            you'll land on it (and can attach more documents) right after submitting.
          </p>
        )}
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving...' : (editing ? 'Save Changes' : 'Submit Request')}
          </button>
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
  const [editingReq, setEditingReq] = useState(false)

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

  const qaLeads = users.filter((u) => (u.roles || []).includes('QA_LEAD'))
  const testers = users.filter((u) => (u.roles || []).includes('QA_ENGINEER'))

  const isAdmin = hasRole(user, 'ADMIN')
  const isRequester = (req.requester_id === user.id) || isAdmin
  const isAssignedQALead = (req.qa_lead_id === user.id) || isAdmin
  const isRequesterVerifier = isRequester || hasRole(user, 'APPLICATION_OWNER')

  const status = req.status

  // Mirrors backend require_roles(QA_LEAD, QA_ENGINEER, BUSINESS_ANALYST) +
  // status gate on PUT /checklist/{item_id} -- verification is only allowed
  // during Readiness Verification (never while still in Draft or any other
  // stage), and only by these roles. The requester's own self-declaration
  // ticks (made at raise-time, in Draft) are separate and never grant this.
  const canVerifyChecklist = hasRole(user, 'QA_LEAD', 'QA_ENGINEER', 'BUSINESS_ANALYST')
    && status === 'READINESS_VERIFICATION'

  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD'].includes(status)
  const canDepartmentHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING'
  const canStartReadiness = hasRole(user, 'QA_LEAD') && isAssignedQALead && status === 'QA_LEAD_ASSIGNED'
  const canReadinessDecide = hasRole(user, 'QA_LEAD') && status === 'READINESS_VERIFICATION'
  const canBeginPlanning = hasRole(user, 'QA_LEAD') && status === 'QA_ACTIVITY_INITIATED'
  const canAssignTester = hasRole(user, 'QA_LEAD') && status === 'PLANNING'
  const canStartTestDesign = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'TESTER_ASSIGNED'
  const canStartExecution = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'TEST_DESIGN'
  const canRaiseDefect = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'EXECUTION_IN_PROGRESS'
  const canMarkWaitingForFix = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'DEFECT_RAISED'
  const canStartRetest = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'WAITING_FOR_FIX'
  const canStartRegression = hasRole(user, 'QA_LEAD', 'QA_ENGINEER') && status === 'RETESTING'
  const canCompleteQA = hasRole(user, 'QA_LEAD', 'QA_ENGINEER')
    && ['EXECUTION_IN_PROGRESS', 'RETESTING', 'REGRESSION_TESTING'].includes(status)
  const canRequestSignoff = hasRole(user, 'QA_LEAD') && status === 'QA_COMPLETED'
  const canConfirmSignoff = hasRole(user, 'QA_LEAD') && status === 'QA_SIGNOFF_PENDING'
  const canRequesterDecide = isRequesterVerifier && status === 'REQUESTER_VERIFICATION'
  // Mirrors backend QA_REQUEST_CANCELLABLE_STATUSES -- once the Department
  // Head approves and a QA Lead is assigned, the request is committed to QA
  // and the Cancel option is no longer offered at all.
  const canCancel = isRequester && QA_CANCELLABLE_STATUSES.includes(status)
  // Mirrors backend QA_REQUEST_EDITABLE_STATUSES -- the requester (or admin)
  // can edit the request while it's in Draft, or has been returned by the
  // Department Head or by the QA Lead for corrections.
  const canEditRequest = isRequester && QA_EDITABLE_STATUSES.includes(status)

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
            <div><strong>Requester:</strong> {userName(users, req.requester_id) || '—'}</div>
            <div><strong>Department Head:</strong> {userName(users, req.department_head_id) || '—'}</div>
            <div><strong>QA Lead:</strong> {userName(users, req.qa_lead_id) || '—'}</div>
            <div><strong>Assigned Tester(s):</strong> {
              req.assigned_tester_ids
                ? req.assigned_tester_ids.split(',').map((id) => userName(users, Number(id)) || id).join(', ')
                : '—'
            }</div>
          </div>
          {(req.linked_sast_requests?.length > 0 || req.linked_dast_requests?.length > 0) && (
            <p>
              <strong>Linked Security Requests:</strong>{' '}
              {req.linked_sast_requests.map((s) => (
                <span key={`sast-${s.id}`} className="badge badge-blue" style={{ marginRight: 6 }}>
                  SAST {s.request_id} — {s.status}
                </span>
              ))}
              {req.linked_dast_requests.map((d) => (
                <span key={`dast-${d.id}`} className="badge badge-blue" style={{ marginRight: 6 }}>
                  DAST {d.request_id} — {d.status}
                </span>
              ))}
            </p>
          )}
          {req.remarks && <p><strong>Remarks:</strong> {req.remarks}</p>}

          <div className="section-title">Workflow Actions</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {canEditRequest && (
              <button className="btn btn-sm" disabled={busyAction} onClick={() => setEditingReq(true)}>Edit Request</button>
            )}
            {canSubmit && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('submit')}>Submit for Department Head Approval</button>
            )}
            {canResubmit && (
              <button className="btn btn-primary btn-sm" disabled={busyAction} onClick={() => act('resubmit')}>Re-submit</button>
            )}

            {canDepartmentHeadDecide && (
              <>
                <select value={selectedQALead} onChange={(e) => setSelectedQALead(e.target.value)} style={{ minWidth: 180 }}>
                  <option value="">Assign QA Lead...</option>
                  {qaLeads.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
                <button className="btn btn-success btn-sm" disabled={!selectedQALead || busyAction}
                        onClick={() => act('department-head-decision', { decision: 'Approved', qa_lead_id: Number(selectedQALead), comments })}>
                  Approve
                </button>
                <button className="btn btn-sm" disabled={busyAction}
                        onClick={() => act('department-head-decision', { decision: 'Returned', comments })}>Return to Requester</button>
                <button className="btn btn-danger btn-sm" disabled={busyAction}
                        onClick={() => act('department-head-decision', { decision: 'Rejected', comments })}>Reject</button>
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
            {!canEditRequest && !canSubmit && !canResubmit && !canDepartmentHeadDecide && !canStartReadiness
              && !canReadinessDecide
              && !canBeginPlanning && !canAssignTester && !canStartTestDesign && !canStartExecution
              && !canRaiseDefect && !canMarkWaitingForFix && !canStartRetest && !canStartRegression
              && !canCompleteQA && !canRequestSignoff && !canConfirmSignoff && !canRequesterDecide && !canCancel && (
              <span className="muted small">No actions available for your role at this stage.</span>
            )}
          </div>
          {(canDepartmentHeadDecide || canReadinessDecide || canRaiseDefect || canMarkWaitingForFix || canStartRetest
            || canStartRegression || canCompleteQA || canConfirmSignoff || canRequesterDecide) && (
            <input placeholder="Comments (optional)" value={comments} onChange={(e) => setComments(e.target.value)}
                   style={{ marginTop: 8, width: '100%', padding: 8, border: '1px solid var(--border)', borderRadius: 6 }} />
          )}
        </div>
      )}

      {tab === 'checklist' && (
        <div>
          <p className="muted small">"Ready for Testing" gate — all mandatory items must be complete before Testing Initiation.</p>
          <p className="muted small">
            <strong>Requester declared</strong> is the requester's own self-declaration at raise-time (reference
            only). <strong>QA Lead verified</strong> is the binding, independent verification — ticking a
            requester-declared item does NOT auto-approve it here.
          </p>
          {status !== 'READINESS_VERIFICATION' && (
            <p className="muted small">
              QA Lead verification is locked outside the Readiness Verification stage (current status: {QA_STATUS_LABELS[status] || status}).
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontWeight: 600, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ flex: 1 }}>Item</span>
            <span style={{ width: 130, textAlign: 'center' }}>Requester declared</span>
            <span style={{ width: 130, textAlign: 'center' }}>QA Lead verified</span>
          </div>
          {checklist.map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ flex: 1 }}>
                {c.item} <span className="muted small">({c.owner})</span>{' '}
                {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
              </span>
              <span style={{ width: 130, textAlign: 'center' }}>
                {c.requester_checked
                  ? <span className="badge badge-blue">Declared</span>
                  : <span className="muted small">Not ticked</span>}
              </span>
              <span style={{ width: 130, textAlign: 'center' }}>
                <input
                  type="checkbox" checked={c.is_complete}
                  disabled={!canVerifyChecklist}
                  title={canVerifyChecklist ? '' : 'Only verifiable by QA Lead / QA Engineer / Business Analyst during Readiness Verification'}
                  onChange={() => toggleChecklistItem(c)}
                />
              </span>
            </div>
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
            { key: 'actor_id', header: 'Actor', render: (r) => userName(users, r.actor_id) || '—' },
            { key: 'actor_role', header: 'Role' },
            { key: 'comments', header: 'Comments' },
            { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
          ]}
          rows={history}
        />
      )}

      {editingReq && (
        <NewRequestModal
          editing={req}
          checklist={checklist}
          onClose={() => setEditingReq(false)}
          onCreated={(updated) => { setEditingReq(false); onChanged(updated); load() }}
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
  const [search, setSearch] = useState(searchParams.get('search') || searchParams.get('application_name') || '')
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Reacts to location.state on every navigation to this route -- not just
    // on first mount -- so the topbar's "+ New QA request" button (which
    // navigates here with { state: { openNew: true } }) also works when the
    // user is already sitting on the QA Requests page (no remount happens
    // in that case, so a useState initializer alone would miss it).
    if (location.state?.openNew) {
      setShowNew(true)
      // Clear the nav state so refreshing/back/clicking the button again doesn't get stuck.
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location.state, location.pathname, navigate])

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (statusFilter) qs.set('status_filter', statusFilter)
      if (search) qs.set('search', search)
      const [reqs, us] = await Promise.all([
        api.get(`/api/qa-requests?${qs.toString()}`),
        api.get('/api/auth/users'),
      ])
      setRequests(reqs)
      setUsers(us)
    } catch (err) { setError(err) }
  }, [statusFilter, search])

  useEffect(() => { load() }, [load])

  const canCreate = hasRole(user, 'REQUESTER', 'BUSINESS_ANALYST')

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="QA Requests" count={requests.length}
        subtitle="Raise, track and act on QA requests through Department Head approval, readiness verification, execution and sign-off."
        actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Raise QA Request</button>}
      />
      <div className="toolbar">
        <input placeholder="Search by request ID, application, or project..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {QA_STATUSES.map((s) => (
            <option key={s} value={s}>{QA_STATUS_LABELS[s] || s}</option>
          ))}
        </select>
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
