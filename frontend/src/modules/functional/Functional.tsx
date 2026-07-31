import React, { useEffect, useState, useCallback } from 'react'
import { api } from '@qa-portal/shared/api'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, ApprovalDecisionButtons, DetailSection, DetailField, RequestDocuments } from '@qa-portal/shared/components/Common'
import UserAssignSelect from '@qa-portal/shared/components/UserAssignSelect'
import {
  QA_STATUSES, QA_STATUS_LABELS, PRIORITIES, RISK_RATINGS, ENVIRONMENTS, CHANGE_TYPES,
  promotionEnvironmentOptions, promotionEnvironmentError,
  FUNCTIONAL_EDITABLE_STATUSES, hasRole,
} from '@qa-portal/shared/constants'
import { FunctionalOut, UserOut, ChecklistItemOut, WalkthroughOut, ApprovalActionOut } from '@qa-portal/shared/types'

// Priority/Risk Rating are real columns on FunctionalRequest itself. Every
// other field here (Application Name, Project Name, CR Number, Change Type,
// Deployment Environment, Target Promotion Environment, Release Version,
// Build Number, Target Release Date) is otherwise delegated (read-only) from
// the parent QA Request -- update_functional (backend) writes those straight
// through to the linked QA Request instead, since the QA Request gateway
// itself can no longer be edited once it's left Draft (see
// GATEWAY_EDITABLE_STATUSES) -- this is the only place left to fix one of
// them after that point. Application Name/Project Name/CR Number identify
// *which* request this actually is, so -- once raised -- only an Admin can
// change them (backend-enforced too, see update_functional's
// _ADMIN_ONLY_FIELDS); everyone else sees them locked. Department stays
// read-only everywhere (fixed to the requester's own profile).
function FunctionalFormModal({ onClose, onSaved, editing }: {
  onClose: () => void; onSaved: (f: FunctionalOut) => void; editing: FunctionalOut
}) {
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'ADMIN')
  const [form, setForm] = useState({
    priority: editing.priority || 'Medium', risk_rating: editing.risk_rating || 'Medium',
    application_name: editing.application_name || '',
    project_name: editing.project_name || '', cr_number: editing.cr_number || '',
    change_type: editing.change_type || 'New', environment: editing.environment || 'SIT',
    target_promotion_environment: editing.target_promotion_environment || 'UAT',
    release_version: editing.release_version || '', build_number: editing.build_number || '',
    target_release_date: editing.target_release_date || '',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const promotionErr = promotionEnvironmentError(form.environment, form.target_promotion_environment)
    if (promotionErr) { setError(promotionErr); return }
    setBusy(true)
    try {
      const saved = await api.put<FunctionalOut>(`/api/functional-requests/${editing.id}`, {
        ...form, target_release_date: form.target_release_date || null,
      })
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${editing.request_id}`} onClose={onClose} wide>
      {editing?.qa_request && (
        <p className="muted small" style={{ marginTop: -8 }}>
          Auto-created from QA Request {editing.qa_request.request_id} -- changes below (other than
          Priority/Risk Rating) are saved back onto that QA Request, since it can no longer be edited
          directly once raised.
        </p>
      )}
      {!isAdmin && (
        <p className="muted small" style={{ marginTop: -4 }}>
          Application Name, Project Name and Change Request ID(s) are locked once this request has been
          raised -- only an Administrator can change them.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title">Identity{!isAdmin ? ' (Admin-only)' : ''}</div>
          <div className="form-row">
            <Field label="Application Name"><input disabled={!isAdmin} value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
            <Field label="Project Name"><input disabled={!isAdmin} value={form.project_name} onChange={(e) => set('project_name', e.target.value)} /></Field>
            <Field label="Change Request ID(s)"><input disabled={!isAdmin} value={form.cr_number} onChange={(e) => set('cr_number', e.target.value)} /></Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Classification</div>
          <div className="form-row">
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
          <div className="form-section-title">Change &amp; Environment</div>
          <div className="form-row">
            <Field label="Change Type">
              <select value={form.change_type} onChange={(e) => set('change_type', e.target.value)}>
                {CHANGE_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Deployment Environment">
              <select value={form.environment} onChange={(e) => {
                const newEnv = e.target.value
                setForm((f) => {
                  const validTargets = promotionEnvironmentOptions(newEnv)
                  const target = validTargets.includes(f.target_promotion_environment) ? f.target_promotion_environment : (validTargets[0] || '')
                  return { ...f, environment: newEnv, target_promotion_environment: target }
                })
              }}>
                {ENVIRONMENTS.filter((e_) => e_ !== 'Dev').map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Target Promotion Environment">
              <select value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
                {promotionEnvironmentOptions(form.environment).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Release Version / Hash Value"><input value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
            <Field label="Build Number / Hash Value"><input value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
            <Field label="Target Release Date"><input type="date" value={form.target_release_date} onChange={(e) => set('target_release_date', e.target.value)} /></Field>
          </div>
        </div>

        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Changes'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Compact "what happens after submit" preview -- mirrors the real lifecycle
// order (see backend app/constants.py QAStatus docstring): Draft -> SM ->
// Department Head -> QA -> Sign-off.
const LIFECYCLE_STAGES = ['Draft', 'SM Approval', 'Dept. Head Approval', 'QA Activity', 'Sign-off', 'Closed']

function LifecyclePreview({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="stepper" style={{ margin: '4px 0 18px' }}>
      {LIFECYCLE_STAGES.map((label, i) => (
        <React.Fragment key={label}>
          <div className={`step ${i <= activeIndex ? 'filled' : ''}`}>
            <div className="circle">{i + 1}</div>
            <div className="step-label">{label}</div>
          </div>
          {i < LIFECYCLE_STAGES.length - 1 && <div className={`connector ${i < activeIndex ? 'filled' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  )
}

function lifecycleStageIndex(status?: string): number {
  if (!status || status === 'DRAFT') return 0
  if (['SUBMITTED', 'SM_APPROVAL_PENDING', 'RETURNED_BY_SM'].includes(status)) return 1
  if (['DEPARTMENT_HEAD_APPROVAL_PENDING', 'RETURNED_BY_DEPARTMENT_HEAD'].includes(status)) return 2
  if (['QA_LEAD_ASSIGNED', 'READINESS_VERIFICATION', 'RETURNED_BY_QA_LEAD', 'QA_ACTIVITY_INITIATED',
       'PLANNING', 'TESTER_ASSIGNED', 'TEST_DESIGN', 'EXECUTION_IN_PROGRESS', 'DEFECT_RAISED',
       'WAITING_FOR_FIX', 'RETESTING', 'REGRESSION_TESTING', 'QA_COMPLETED'].includes(status)) return 3
  if (['QA_SIGNOFF_PENDING', 'QA_SIGNED_OFF', 'REQUESTER_VERIFICATION'].includes(status)) return 4
  if (['CLOSED', 'CANCELLED', 'SM_REJECTED', 'DEPARTMENT_HEAD_REJECTED'].includes(status)) return 5
  return 0
}

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

interface FunctionalDetailProps {
  req: FunctionalOut
  onClose: () => void
  onChanged: (req: FunctionalOut) => void
  users: UserOut[]
}

function FunctionalDetail({ req, onClose, onChanged, users }: FunctionalDetailProps) {
  const { user } = useAuth()
  const [tab, setTab] = useState('overview')
  const [checklist, setChecklist] = useState<ChecklistItemOut[]>([])
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [comments, setComments] = useState('')
  const [selectedQALead, setSelectedQALead] = useState('')
  const [selectedTesters, setSelectedTesters] = useState<string[]>([])
  const [requireDeptHeadReapproval, setRequireDeptHeadReapproval] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [editingDetails, setEditingDetails] = useState(false)

  const load = useCallback(async () => {
    try {
      const [cl, wt, hist] = await Promise.all([
        api.get<ChecklistItemOut[]>(`/api/functional-requests/${req.id}/checklist`),
        api.get<WalkthroughOut[]>(`/api/functional-requests/${req.id}/walkthroughs`),
        api.get<ApprovalActionOut[]>(`/api/functional-requests/${req.id}/history`),
      ])
      setChecklist(cl); setWalkthroughs(wt); setHistory(hist)
    } catch (err) { setError(err) }
  }, [req.id])

  useEffect(() => { load() }, [load])

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null)
    setBusyAction(action)
    try {
      const updated = await api.post<FunctionalOut>(`/api/functional-requests/${req.id}/${action}`, extra || {})
      onChanged(updated)
      load()
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  async function toggleChecklistItem(item: ChecklistItemOut) {
    setError(null)
    try {
      await api.put(`/api/functional-requests/${req.id}/checklist/${item.id}`, { is_complete: !item.is_complete })
      load()
    } catch (err) { setError(err) }
  }

  const qaLeads = users.filter((u) => (u.roles || []).includes('QA_LEAD'))
  const testers = users.filter((u) => (u.roles || []).includes('QA_ENGINEER'))

  const isAdmin = hasRole(user, 'ADMIN')
  const isRequester = (req.requester_id === user?.id) || isAdmin
  const isAssignedQALead = (req.qa_lead_id === user?.id) || isAdmin
  const isRequesterVerifier = isRequester || hasRole(user, 'APPLICATION_OWNER')

  const status = req.status

  const canVerifyChecklist = hasRole(user, 'QA_LEAD', 'QA_ENGINEER', 'BUSINESS_ANALYST')
    && status === 'READINESS_VERIFICATION'

  const canSubmit = isRequester && status === 'DRAFT'
  const canResubmit = isRequester && ['RETURNED_BY_SM', 'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD'].includes(status)
  // SM/Department Head approvals are department-scoped -- a stakeholder can
  // only act on requests raised from their own department (enforced
  // server-side too; this just keeps the buttons from appearing for a
  // mismatch instead of surfacing a 403 after clicking). Doesn't apply to
  // the QA-side steps below, since QA is the team receiving the request.
  const sameDept = !!user?.department && user.department === req.department
  const canSMDecide = hasRole(user, 'SM') && status === 'SM_APPROVAL_PENDING' && (sameDept || isAdmin)
  const canDepartmentHeadDecide = hasRole(user, 'DEPARTMENT_HEAD') && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING' && (sameDept || isAdmin)
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
  // Mirrors backend FUNCTIONAL_EDITABLE_STATUSES -- same requester-or-QA role
  // gate as SAST/DAST/Automation/Performance's own Edit Details.
  const canEditDetails = (isRequester || hasRole(user, 'QA_LEAD', 'QA_ENGINEER')) && FUNCTIONAL_EDITABLE_STATUSES.includes(status)

  return (
    <Modal title={`${req.request_id} — ${req.application_name || ''}`} onClose={onClose} wide>
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
          <LifecyclePreview activeIndex={lifecycleStageIndex(req.status)} />

          <DetailSection title="Status">
            <DetailField label="Status">
              <Badge status={req.status} />
              {req.needs_dept_head_reapproval && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                  Department Head re-approval required after changes
                </span>
              )}
            </DetailField>
            <DetailField label="Priority / Risk">{req.priority || '—'} / {req.risk_rating || '—'}</DetailField>
            <DetailField label="Request Type(s)">{req.request_types || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Application Name">{req.application_name || '—'}</DetailField>
            <DetailField label="Project">{req.project_name || '—'}</DetailField>
            <DetailField label="Change Request ID(s)">{req.cr_number || '—'}</DetailField>
            <DetailField label="Change Type">{req.change_type || '—'}</DetailField>
            <DetailField label="Department">{req.department || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Environment & Release">
            <DetailField label="Deployment Environment">{req.environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
            <DetailField label="Release Version / Hash Value">{req.release_version || '—'}</DetailField>
            <DetailField label="Build Number / Hash Value">{req.build_number || '—'}</DetailField>
            <DetailField label="Target Release Date">{req.target_release_date || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
            <DetailField label="Department Head">{userName(users, req.department_head_id) || '—'}</DetailField>
            <DetailField label="QA Lead">{userName(users, req.qa_lead_id) || '—'}</DetailField>
            <DetailField label="Assigned Tester(s)">{
              req.assigned_tester_ids
                ? req.assigned_tester_ids.split(',').map((id) => userName(users, Number(id)) || id).join(', ')
                : '—'
            }</DetailField>
          </DetailSection>

          {req.qa_request && (
            <p className="muted small">
              Raised alongside QA Request <strong>{req.qa_request.request_id}</strong> — see that request for
              supporting documents and any other linked SAST/DAST/Automation/Performance requests.
            </p>
          )}

          <div className="section-title">Workflow Actions</div>
          <div className="actions-panel">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/functional-requests/${req.id}/export`, `${req.request_id}.pdf`)}>
              Export PDF
            </button>
            {canEditDetails && (
              <button className="btn btn-sm" disabled={!!busyAction} onClick={() => setEditingDetails(true)}>Edit Details</button>
            )}
            {canSubmit && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('submit')}>Submit for SM Approval</button>
            )}
            {canResubmit && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('resubmit')}>Re-submit</button>
            )}

            {canSMDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={!!busyAction}
                onApprove={(signed) => act('sm-decision', { decision: 'Approved', comments: signed })}
                onReturn={() => act('sm-decision', { decision: 'Returned', comments })}
                onReject={() => act('sm-decision', { decision: 'Rejected', comments })}
              />
            )}

            {canDepartmentHeadDecide && (
              <ApprovalDecisionButtons
                userName={user?.full_name}
                comments={comments}
                busy={!!busyAction}
                extraReady={!!selectedQALead}
                extraControl={
                  <UserAssignSelect
                    value={selectedQALead}
                    onChange={setSelectedQALead}
                    users={qaLeads}
                    placeholder="Assign QA Lead..."
                    style={{ minWidth: 220 }}
                  />
                }
                onApprove={(signed) => act('department-head-decision', { decision: 'Approved', qa_lead_id: Number(selectedQALead), comments: signed })}
                onReturn={() => act('department-head-decision', { decision: 'Returned', comments })}
                onReject={() => act('department-head-decision', { decision: 'Rejected', comments })}
              />
            )}

            {canStartReadiness && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('start-readiness-verification')}>
                Start Readiness Verification
              </button>
            )}
            {canReadinessDecide && (
              <>
                <button className="btn btn-success btn-sm" disabled={!!busyAction}
                        onClick={() => act('readiness-decision', { decision: 'Passed', comments })}>Readiness Passed</button>
                <button className="btn btn-danger btn-sm" disabled={!!busyAction}
                        onClick={() => act('readiness-decision', { decision: 'Failed', comments, require_dept_head_reapproval: requireDeptHeadReapproval })}>
                  Readiness Failed
                </button>
                <label className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={requireDeptHeadReapproval}
                         onChange={(e) => setRequireDeptHeadReapproval(e.target.checked)} />
                  Require Department Head re-approval on return
                </label>
              </>
            )}

            {canBeginPlanning && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('begin-planning')}>Begin Planning</button>
            )}
            {canAssignTester && (
              <>
                <select multiple value={selectedTesters} onChange={(e) => setSelectedTesters(Array.from(e.target.selectedOptions, (o) => o.value))} style={{ minWidth: 180 }}>
                  {testers.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" disabled={selectedTesters.length === 0 || !!busyAction}
                        onClick={() => act('assign-tester', { tester_ids: selectedTesters.map(Number) })}>Assign Tester(s)</button>
              </>
            )}
            {canStartTestDesign && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('start-test-design')}>Start Test Design</button>
            )}
            {canStartExecution && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('start-execution')}>Start Execution</button>
            )}

            {canRaiseDefect && (
              <button className="btn btn-danger btn-sm" disabled={!!busyAction} onClick={() => act('raise-defect', { comments })}>Raise Defect</button>
            )}
            {canMarkWaitingForFix && (
              <button className="btn btn-sm" disabled={!!busyAction} onClick={() => act('mark-waiting-for-fix', { comments })}>Mark Waiting For Fix</button>
            )}
            {canStartRetest && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('start-retesting', { comments })}>Start Retesting</button>
            )}
            {canStartRegression && (
              <button className="btn btn-sm" disabled={!!busyAction} onClick={() => act('start-regression', { comments })}>Start Regression Testing</button>
            )}
            {canCompleteQA && (
              <button className="btn btn-success btn-sm" disabled={!!busyAction} onClick={() => act('complete-qa', { comments })}>Mark QA Completed</button>
            )}

            {canRequestSignoff && (
              <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={() => act('request-signoff')}>Request Sign-off</button>
            )}
            {canConfirmSignoff && (
              <button className="btn btn-success btn-sm" disabled={!!busyAction} onClick={() => act('confirm-signoff', { comments })}>Confirm Sign-off</button>
            )}

            {canRequesterDecide && (
              <>
                <button className="btn btn-success btn-sm" disabled={!!busyAction}
                        onClick={() => act('requester-decision', { decision: 'Accepted', comments })}>Accept &amp; Close</button>
                <button className="btn btn-danger btn-sm" disabled={!!busyAction}
                        onClick={() => act('requester-decision', { decision: 'ChangesRequired', comments })}>Changes Required</button>
              </>
            )}

            {!canEditDetails && !canSubmit && !canResubmit && !canSMDecide && !canDepartmentHeadDecide && !canStartReadiness
              && !canReadinessDecide
              && !canBeginPlanning && !canAssignTester && !canStartTestDesign && !canStartExecution
              && !canRaiseDefect && !canMarkWaitingForFix && !canStartRetest && !canStartRegression
              && !canCompleteQA && !canRequestSignoff && !canConfirmSignoff && !canRequesterDecide && (
              <span className="muted small">No actions available for your role at this stage.</span>
            )}
          </div>
          {(canSMDecide || canDepartmentHeadDecide || canReadinessDecide || canRaiseDefect || canMarkWaitingForFix || canStartRetest
            || canStartRegression || canCompleteQA || canConfirmSignoff || canRequesterDecide) && (
            <input placeholder="Comments (optional)" value={comments} onChange={(e) => setComments(e.target.value)}
                   style={{ marginTop: 8, width: '100%', padding: 8, border: '1px solid var(--border)', borderRadius: 6 }} />
          )}
          </div>

          {editingDetails && (
            <FunctionalFormModal editing={req} onClose={() => setEditingDetails(false)}
                                  onSaved={(saved) => { setEditingDetails(false); onChanged(saved) }} />
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
              { key: 'qa_acknowledged_at', header: 'QA Acknowledged', render: (r) => r.qa_acknowledged_at ? 'Yes' : 'No', filterValue: (r) => r.qa_acknowledged_at ? 'Yes' : 'No' },
            ]}
            rows={walkthroughs}
          />
          <AddWalkthrough reqId={req.id} onAdded={load} />
        </div>
      )}

      {tab === 'history' && (
        <Table
          rowKey="id"
          columns={[
            { key: 'step_name', header: 'Step' },
            { key: 'decision', header: 'Decision' },
            { key: 'actor_id', header: 'Actor', render: (r) => userName(users, r.actor_id) || '—', filterValue: (r) => userName(users, r.actor_id) || '' },
            { key: 'actor_role', header: 'Role' },
            { key: 'comments', header: 'Comments' },
            { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
          ]}
          rows={history}
        />
      )}

      {tab === 'documents' && <RequestDocuments apiBase="/api/functional-requests" reqId={req.id} />}
    </Modal>
  )
}

function AddWalkthrough({ reqId, onAdded }: { reqId: number; onAdded: () => void }) {
  const [conducted_by, setConductedBy] = useState('')
  const [participants, setParticipants] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post(`/api/functional-requests/${reqId}/walkthroughs`, { conducted_by, participants, notes })
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

export default function Functional() {
  const [requests, setRequests] = useState<FunctionalOut[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [selected, setSelected] = useState<FunctionalOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      const [reqs, us] = await Promise.all([
        api.get<FunctionalOut[]>('/api/functional-requests'),
        api.get<UserOut[]>('/api/auth/users'),
      ])
      setRequests(statusFilter ? reqs.filter((r) => r.status === statusFilter) : reqs)
      setUsers(us)
    } catch (err) { setError(err) }
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Functional QA Requests" count={requests.length}
        subtitle="Combined Functional Testing, Regression Testing, Sanity Testing and UAT Support workflow --
                   raised via a QA Request (include any of these in its request types), then tracked here
                   through Department Head approval, readiness verification, execution and sign-off."
      />
      <div className="toolbar">
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
            { key: 'application_name', header: 'Application', render: (r) => r.application_name || '—' },
            { key: 'project_name', header: 'Project', render: (r) => r.project_name || '—' },
            { key: 'requester_id', header: 'Requester', render: (r) => userName(users, r.requester_id) || '—', filterValue: (r) => userName(users, r.requester_id) || '' },
            { key: 'qa_lead_id', header: 'QA Lead', render: (r) => userName(users, r.qa_lead_id) || '—', filterValue: (r) => userName(users, r.qa_lead_id) || '' },
            { key: 'priority', header: 'Priority', render: (r) => r.priority || '—' },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
            { key: 'qa_request', header: 'QA Request', render: (r) => r.qa_request ? r.qa_request.request_id : '—', filterValue: (r) => r.qa_request ? r.qa_request.request_id : '' },
          ]}
          rows={requests}
        />
      </Card>

      {selected && (
        <FunctionalDetail req={selected} users={users} onClose={() => setSelected(null)}
                           onChanged={(updated) => { setSelected(updated); load() }} />
      )}
    </div>
  )
}
