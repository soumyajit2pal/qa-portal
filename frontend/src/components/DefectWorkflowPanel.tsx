import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useDefectSubmissionConfirmation } from '../defectSubmission'
import { DefectOut, UserOut, DepartmentOut, RequestDocumentOut } from '../types'
import { useAuth } from '../context/AuthContext'
import { ENVIRONMENTS, isViewOnly, hasWorkflowRole } from '../constants'
import { ErrorText, Field } from './Common'
import UserAssignSelect from './UserAssignSelect'
import JiraRichTextField from './JiraRichTextField'
import { MarkdownComment } from './JiraActivity'

export default function DefectWorkflowPanel({ defect, users, departments, onChanged }: {
  defect: DefectOut; users: UserOut[]; departments: DepartmentOut[]; onChanged: (d: DefectOut) => void
}) {
  const { confirmDefectSubmission, confirmationModal } = useDefectSubmissionConfirmation()
  const { user } = useAuth()
  const [choice, setChoice] = useState('')
  const actionForm = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (choice) actionForm.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [choice])
  const [data, setData] = useState<Record<string, any>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [fieldImages, setFieldImages] = useState<Record<string, File[]>>({})
  const uploaded = useRef(new Map<File, RequestDocumentOut>())
  const [editorVersion, setEditorVersion] = useState(0)
  const attachmentsPath = `/api/defects/${defect.id}/attachments`
  const isTransition = !!choice && !['assess', 'occurrence', 'block', 'unblock'].includes(choice)
  const requiresReference = ['Ready for QA', 'Production Verification', 'occurrence', 'Reopened', 'Accept Risk'].includes(choice)
    || (isTransition && ['QA Testing', 'Business Acceptance', 'Production Verification'].includes(defect.status))
  const pendingFiles = Array.from(new Set([...files, ...Object.values(fieldImages).flat()]))
  const actionTitle = ({ occurrence: 'Record in another environment', assess: 'Assess production impact', block: 'Mark blocked', unblock: 'Clear blocker' } as Record<string, string>)[choice] || choice

  const workflow = defect.workflow!
  const state = defect.workflow_state || {}
  const roles = user?.roles || []
  const manager = hasWorkflowRole(user, 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')
  const canTriage = manager || roles.includes('QA_ENGINEER')
  const resolver = defect.assignee_id === user?.id
  const qa = defect.retest_tester_id === user?.id
  const business = state.business_owner_id === user?.id
  const release = state.release_owner_id === user?.id
  const reporter = defect.reporter_id === user?.id
  const viewOnly = isViewOnly(user)
  const participant = manager || resolver || qa || business || release || reporter
  const verification = isTransition && ['QA Testing', 'Business Acceptance', 'Production Verification'].includes(defect.status)
  const forward = isTransition && !['Reopened', 'Deferred', 'Duplicate', 'Rejected', 'Not a Defect', 'Accept Risk'].includes(choice)
  const productionImpactLocked = defect.environment === 'Production'
    || state.occurrences?.some(occurrence => occurrence.environment === 'Production')
    || ['Ready for Release', 'Production Verification'].includes(defect.status)
  const field = (key: string, label: string, required = true, type = 'text') => <Field label={label + (required ? ' *' : '')}><input disabled={busy} type={type} required={required} value={data[key] || ''} onChange={e => setData({ ...data, [key]: e.target.value })} /></Field>
  const [candidates, setCandidates] = useState<Record<string, UserOut[]>>({})
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [candidateError, setCandidateError] = useState<unknown>(null)
  useEffect(() => {
    if (!choice) return
    let active = true
    setCandidates({}); setLoadingCandidates(true); setCandidateError(null)
    api.get<Record<string, UserOut[]>>(`/api/defects/${defect.id}/workflow-candidates?department=${encodeURIComponent(data.assigned_team || '')}`)
      .then(result => {
        if (!active) return
        setCandidates(result)
        setData(current => {
          const next = { ...current }
          for (const [field, eligible] of Object.entries(result)) {
            if (next[field] && !eligible.some(candidate => candidate.id === Number(next[field]))) next[field] = null
          }
          return next
        })
      })
      .catch(err => { if (active) setCandidateError(err) })
      .finally(() => { if (active) setLoadingCandidates(false) })
    return () => { active = false }
  }, [choice, defect.id, data.assigned_team])
  const owner = (key: string, label: string) => <Field label={label + ' *'}><UserAssignSelect disabled={busy || loadingCandidates || (key === 'assignee_id' && !data.assigned_team)} value={data[key] ? String(data[key]) : ''} onChange={v => setData({ ...data, [key]: v ? Number(v) : null })} users={candidates[key] || []} placeholder={loadingCandidates ? 'Loading eligible users…' : `Select ${label.toLowerCase()}`} /></Field>

  function richField(key: string, label: string, placeholder: string, required = true) {
    return <Field label={`${label}${required ? ' *' : ''}`}><JiraRichTextField key={`${editorVersion}-${key}`} value={data[key] || ''} disabled={busy}
      onChange={value => setData(current => ({ ...current, [key]: value }))}
      onImagesChange={images => setFieldImages(current => ({ ...current, [key]: images }))}
      ariaLabel={label} placeholder={placeholder} /></Field>
  }
  function select(value: string) {
    if (busy) return
    setChoice(value); setError(null); setFiles([]); setFieldImages({}); setEditorVersion(v => v + 1); setUploadStatus('')
    setData({ production_impact: productionImpactLocked ? 'Affected' : state.production_impact || 'Unknown', build: state.deployed_build || defect.build_version || '', environment: workflow.qa_environment, assigned_team: defect.assigned_team || defect.project_department || '', release_owner_id: state.release_owner_id, business_owner_id: state.business_owner_id })
  }
  const permitted = (defect.workflow_transitions || []).filter(target => {
    if (target === 'Accept Risk') return roles.includes('ADMIN') || roles.includes('APPLICATION_OWNER')
    if (target === 'Triaged') return canTriage
    if (['In Progress', 'Ready for QA'].includes(target)) return manager || resolver
    if (target === 'Deferred') return manager || roles.includes('APPLICATION_OWNER')
    if (['Duplicate', 'Rejected', 'Not a Defect'].includes(target)) return manager || resolver || reporter
    if (defect.status === 'Closed') return manager || reporter
    if (target === 'QA Testing' || ['QA Testing', 'Ready for QA'].includes(defect.status)) return manager || qa
    if (defect.status === 'Business Acceptance') return manager || business
    if (['Ready for Release', 'Production Verification'].includes(defect.status)) return manager || release
    return manager || resolver || reporter
  })
  const closed = ['Closed', 'Rejected', 'Duplicate', 'Not a Defect'].includes(defect.status)
  const impact = state.production_impact || 'Unknown'
  const productionRequired = defect.workflow_stages?.includes('Production Verification')
  const primaryTarget = (defect.workflow_transitions || [])[0]
  const stageIndex = (defect.workflow_stages || []).indexOf(defect.status)
  const actionLabels: Record<string, string> = {
    Triaged: 'Triage & assign owner', 'In Progress': 'Start work', 'Ready for QA': 'Send fix to QA',
    'QA Testing': 'Start QA testing', 'Business Acceptance': 'Send for business acceptance',
    'Ready for Release': 'Approve for release', 'Production Verification': 'Record deployment',
    Closed: 'Verify & close defect', Reopened: 'Reopen defect',
  }
  const guidance: Record<string, string> = {
    New: 'Assess the impact and assign a resolver so investigation can begin.',
    Triaged: 'The resolver is assigned. Start work when investigation or the fix begins.',
    'In Progress': 'Document the root cause and fix, then hand the tested build to a QA owner.',
    'Ready for QA': 'The fix is ready. The QA owner can start validating the submitted build.',
    'QA Testing': 'Record the tested build, observed result and evidence. Confirm regression testing before passing.',
    'Business Acceptance': 'The business owner validates the fixed build against the agreed requirements.',
    'Ready for Release': 'The release owner deploys the approved fix and records the production build and reference.',
    'Production Verification': 'Verify the deployed fix in production and attach evidence before closing.',
    Closed: 'This defect is closed. Review the recorded evidence and decisions below.',
    Reopened: 'The defect needs more work. Investigate the failed verification and prepare a new fix.',
    Deferred: 'Work is deferred. Review the recorded reason and resume when ready.',
    Rejected: 'This report was rejected. Review the decision below before reopening.',
    'Not a Defect': 'The behavior was assessed as expected. Review the requirements decision below.',
    Duplicate: 'This issue is tracked by another defect. Review the linked canonical defect below.',
  }
  const ownerId = defect.status === 'Business Acceptance' ? state.business_owner_id
    : ['Ready for Release', 'Production Verification'].includes(defect.status) ? state.release_owner_id
    : ['Ready for QA', 'QA Testing'].includes(defect.status) ? defect.retest_tester_id : defect.assignee_id
  const ownerName = users.find(person => person.id === ownerId)?.full_name || (ownerId === defect.assignee_id ? defect.assignee_name : null)
  const stageHelp: Record<string, string> = { New: 'Report', Triaged: 'Assess & assign', 'In Progress': 'Investigate & fix', 'Ready for QA': 'QA handoff', 'QA Testing': 'Test & verify', 'Business Acceptance': 'Business sign-off', 'Ready for Release': 'Release approval', 'Production Verification': 'Verify live fix', Closed: 'Complete' }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null)
    if (busy) return
    if (['assess', 'Triaged'].includes(choice) && !['Unknown', 'Unaffected', 'Affected'].includes(data.production_impact)) {
      setError(new Error('Select a valid production impact')); return
    }
    if (!(data.remarks || '').trim()) { setError(new Error('Enter the observed result or decision rationale')); return }
    if (choice === 'Ready for QA' && (!(data.root_cause || '').trim() || !(data.fix_details || '').trim())) { setError(new Error('Root cause and fix details are required')); return }
    if (requiresReference && !(data.reference || '').trim() && !pendingFiles.length) { setError(new Error('Upload supporting evidence or enter an evidence / deployment reference')); return }
    if (!(await confirmDefectSubmission())) return
    setBusy(true)
    const action = ['occurrence', 'assess', 'block', 'unblock'].includes(choice) ? choice : 'transition'
    try {
      for (const [index, file] of pendingFiles.entries()) {
        if (uploaded.current.has(file)) continue
        setUploadStatus(`Uploading evidence ${index + 1} of ${pendingFiles.length}…`)
        const documents = await api.uploadFormFiles<RequestDocumentOut[]>(attachmentsPath, {}, [file])
        if (!documents[0]) throw new Error('Evidence upload did not return a document. The action was not saved.')
        uploaded.current.set(file, documents[0])
      }
      setUploadStatus('Saving workflow action…')
      const updated = await api.post<DefectOut>(`/api/defects/${defect.id}/workflow-action`, {
        ...data, evidence_document_ids: pendingFiles.map(file => uploaded.current.get(file)!.id), action, status: action === 'transition' ? choice : undefined, revision: defect.workflow_revision,
      })
      setChoice(''); onChanged(updated)
    } catch (e) { setError(e) } finally { setBusy(false); setUploadStatus('') }
  }
  return <section className="workflow-panel">
    {confirmationModal}
    <header className="defect-workflow-heading"><div><span className="workflow-action-eyebrow">RESOLUTION WORKFLOW</span><h3>{state.blocked ? 'Work is blocked' : defect.status}</h3><p>{guidance[defect.status] || 'Review the current decision and choose an available action.'}</p></div><div className="defect-workflow-owner"><span>{closed ? 'Last responsible owner' : 'Responsible now'}</span><strong>{ownerName || 'Not assigned yet'}</strong><small>{defect.status === 'New' ? 'QA team to triage' : 'Current stage owner'}</small></div></header>
    <ol className="workflow-stages defect-workflow-path" aria-label="Defect resolution stages">{defect.workflow_stages?.map((stage, index) => <li key={stage} className={stageIndex >= 0 && index < stageIndex ? 'completed' : ''} aria-current={stage === defect.status ? 'step' : undefined}><span className="defect-stage-number">{stageIndex >= 0 && index < stageIndex ? '✓' : index + 1}</span><div><strong>{stage}</strong><small>{stageHelp[stage] || stage}</small></div></li>)}</ol>
    <div className="defect-workflow-context">
      <section className={`defect-impact-card impact-${impact.toLowerCase()}`}><span className="workflow-action-eyebrow">PRODUCTION IMPACT</span><h4>{impact === 'Affected' ? 'Production is affected' : impact === 'Unaffected' ? 'Production is not affected' : 'Impact needs assessment'}</h4><p>{impact === 'Unknown' ? 'QA must assess whether the issue affects production before verification can be completed.' : productionRequired ? 'Release and production verification are required before closure.' : 'Close after the required QA' + (workflow.business_acceptance ? ' and business' : '') + ' verification passes.'}</p>{workflow.production_for_all && <small>Workspace policy requires production verification for every fix.</small>}{!viewOnly && canTriage && !closed && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => select('assess')}>{impact === 'Unknown' ? 'Assess production impact' : 'Review production impact'}</button>}</section>
      <section className="defect-verification-card"><span className="workflow-action-eyebrow">REQUIRED CHECKS</span><h4>Before this defect can close</h4><ul><li>QA verification in <strong>{workflow.qa_environment}</strong></li>{workflow.business_acceptance && <li>Business acceptance in <strong>{workflow.business_environment}</strong></li>}{productionRequired && <li>Deployment & verification in <strong>Production</strong></li>}{impact === 'Unknown' && <li>Confirm production impact to determine the release path</li>}</ul></section>
    </div>
    {state.blocked && <div className="defect-workflow-blocker" role="status"><strong>Blocked: {state.blocked.reason}</strong><span>Review by {state.blocked.review_date}. Clear the blocker before moving forward.</span></div>}
    {!viewOnly && <div className="defect-workflow-next"><div><span className="workflow-action-eyebrow">{closed ? 'FOLLOW-UP' : 'NEXT ACTION'}</span><strong>{state.blocked ? 'Resolve the blocker to continue' : primaryTarget ? (actionLabels[primaryTarget] || primaryTarget) : 'No further workflow action'}</strong>{primaryTarget && !permitted.includes(primaryTarget) && !state.blocked && <small>This step is available to the authorized stage owner or QA lead.</small>}</div><div className="workflow-actions">
      {!state.blocked && primaryTarget && permitted.includes(primaryTarget) && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => select(primaryTarget)}>{actionLabels[primaryTarget] || primaryTarget} →</button>}
      {!closed && (manager || resolver || qa || business || release) && <button type="button" className="btn" disabled={busy} onClick={() => select(state.blocked ? 'unblock' : 'block')}>{state.blocked ? 'Clear blocker' : 'Report a blocker'}</button>}
      {!state.blocked && permitted.filter(target => target !== primaryTarget).length > 0 && <details className="defect-workflow-other"><summary>Other outcomes</summary><div>{permitted.filter(target => target !== primaryTarget).map(target => <button type="button" className="btn btn-sm" disabled={busy} key={target} onClick={() => select(target)}>{actionLabels[target] || target}</button>)}</div></details>}
    </div></div>}
    <details className="defect-environment-details"><summary>Where has this defect been observed? <span>{state.occurrences?.length || 0} environment record(s)</span></summary><p>These are reported occurrences. Verification results are recorded separately in the activity history.</p><div className="defect-environment-records">{state.occurrences?.map((e, i) => <article key={i}><header><strong>{e.environment}</strong><span>Build: {e.build || 'Not recorded'}</span></header><MarkdownComment value={e.remarks || 'No reproduction notes recorded.'} /></article>)}</div>{!viewOnly && !closed && participant && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => select('occurrence')}>+ Record another affected environment</button>}</details>
    {choice && <form ref={actionForm} onSubmit={submit} className="workflow-action-form workflow-action-redesign">
      <header className="workflow-action-heading"><div><span className="workflow-action-eyebrow">WORKFLOW ACTION</span><h4>{actionTitle}</h4><p>{choice === 'Ready for QA' ? 'Document the fix, select the QA owner, and provide the build and evidence for verification.' : 'Record the details and supporting evidence for this decision.'}</p></div><span className="workflow-current-stage">From {defect.status}</span></header>
      {(['Triaged', 'assess', 'Ready for QA', 'occurrence', 'Production Verification', 'Ready for Release', 'Deferred', 'block', 'Duplicate', 'Business Acceptance'].includes(choice) || verification) && <fieldset disabled={busy} className="workflow-action-fieldset"><legend>{choice === 'assess' ? 'Does this issue affect the live production system?' : 'Assignment and build details'}</legend><div className="workflow-fields">
      {['Triaged', 'assess'].includes(choice) && <Field label="Production impact *"><select value={data.production_impact} onChange={e => setData({ ...data, production_impact: e.target.value })}>{['Unknown', 'Unaffected', 'Affected'].map(x => <option key={x} value={x} disabled={!!productionImpactLocked && x !== 'Affected'}>{x === 'Unknown' ? 'Unknown — assessment pending' : x === 'Affected' ? 'Affected — production needs this fix' : 'Unaffected — issue is limited to test environments'}</option>)}</select></Field>}
      {['Triaged', 'assess'].includes(choice) && productionImpactLocked && <p className="muted small">Production impact must remain Affected because this defect was reported in Production or production delivery is already underway. Production verification is required before closure.</p>}
      {choice === 'Triaged' && <><Field label="Assigned department *"><select required value={data.assigned_team} onChange={e => { setCandidates({}); setData({ ...data, assigned_team: e.target.value, assignee_id: null }) }}><option value="">Select department</option>{departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}</select></Field>{owner('assignee_id', 'Resolver')}{workflow.business_acceptance && owner('business_owner_id', 'Business acceptance owner')}</>}
      {choice === 'Ready for QA' && owner('retest_tester_id', 'QA tester')}
      {choice === 'occurrence' && <Field label="Affected environment *"><select value={data.environment} onChange={e => setData({ ...data, environment: e.target.value })}>{ENVIRONMENTS.map(x => <option key={x}>{x}</option>)}</select></Field>}
      {(['Ready for QA', 'Production Verification', 'occurrence'].includes(choice) || verification) && field('build', verification ? 'Tested build' : 'Deployed / affected build')}
      {choice === 'Business Acceptance' && <p>Business verification uses the same fixed build. Deploy that build to {workflow.business_environment} before starting acceptance.</p>}
      {['Ready for Release', 'Deferred'].includes(choice) && field('target_release', 'Target release')}
      {choice === 'Ready for Release' && owner('release_owner_id', 'Release owner')}
      {['Deferred', 'block'].includes(choice) && field('review_date', 'Review date', true, 'date')}
      {choice === 'Duplicate' && field('duplicate_defect_id', 'Canonical defect numeric ID', true, 'number')}
      </div></fieldset>}
      <section className="workflow-action-narrative">
        {choice === 'Ready for QA' && <>
          {richField('root_cause', 'Root cause', 'Explain why the defect occurred. Include relevant technical findings…')}
          {richField('fix_details', 'Fix details', 'Describe the changes made and what QA should verify…')}
        </>}
        {richField('remarks', choice === 'Ready for QA' ? 'QA handoff notes' : 'Observed result / decision rationale', choice === 'Ready for QA' ? 'Describe the expected behavior, testing scope, and any important conditions…' : 'Describe what you observed and why this action is appropriate…')}
      </section>
      <section className="workflow-evidence-section"><h5>Supporting evidence</h5><p>Upload screenshots, logs or documents. You can also paste screenshots into the editors above.</p>
        <label className="workflow-evidence-upload"><strong>Add evidence files</strong><span>Choose one or more files to attach to this action</span><input aria-label="Upload workflow evidence" type="file" multiple disabled={busy} onChange={e => { const added = Array.from(e.target.files || []); setFiles(current => [...current, ...added]); e.target.value = '' }} /></label>
        {files.length > 0 && <ul className="workflow-evidence-files">{files.map((file, index) => <li key={`${file.name}-${index}`}><span><strong>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB{uploaded.current.has(file) ? ' · Uploaded' : ' · Ready to upload'}</small></span><button type="button" className="btn btn-sm" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>}
        {Object.values(fieldImages).flat().length > 0 && <p className="muted small">{Object.values(fieldImages).flat().length} inline screenshot(s) will also be attached.</p>}
        {requiresReference && richField('reference', 'Evidence notes / deployment reference', 'Add a change ID, deployment reference, test result link, or explain the attached evidence…', false)}
        {requiresReference && <p className="muted small">Provide an attachment or an evidence reference before saving.</p>}
      </section>
      {defect.status === 'QA Testing' && forward && <label className="workflow-regression-check"><input disabled={busy} type="checkbox" required checked={!!data.regression_confirmed} onChange={e => setData({ ...data, regression_confirmed: e.target.checked })} /> Confirmation and applicable regression testing passed</label>}
      <ErrorText error={candidateError || error} /><div className="workflow-action-footer"><span role="status">{uploadStatus || 'Review before submitting. Submitted action details cannot be edited.'}</span><div className="workflow-actions"><button className="btn btn-primary" disabled={busy || loadingCandidates || !!candidateError}>{busy ? 'Saving…' : 'Save action'}</button><button type="button" className="btn" disabled={busy} onClick={() => setChoice('')}>Cancel</button></div></div>
    </form>}

  </section>
}
