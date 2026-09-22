import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useDefectSubmissionConfirmation } from '../defectSubmission'
import { DefectListOut, DefectOut, UserOption, UserOut, DepartmentOut, RequestDocumentOut } from '../types'
import { useAuth } from '../context/AuthContext'
import { ENVIRONMENTS, isViewOnly, hasWorkflowRole } from '../constants'
import { ErrorText, Field } from './Common'
import UserAssignSelect from './UserAssignSelect'
import SearchableSelect from './SearchableSelect'
import JiraRichTextField from './JiraRichTextField'
import { MarkdownComment } from './JiraActivity'
import { defectStageOwnership } from '../defectOwnership'

export const DEFECT_WORKFLOW_ACTION_LABELS: Record<string, string> = {
  Triaged: 'Triage & assign owner', 'In Progress': 'Start work', 'Ready for QA': 'Send fix to QA',
  'QA Testing': 'Start QA testing', 'Business Acceptance': 'Send for business acceptance',
  'Ready for Release': 'Approve for release', 'Production Verification': 'Record deployment',
  Closed: 'Verify & close defect', Reopened: 'Reopen defect',
  Deferred: 'Defer defect', Duplicate: 'Mark as duplicate', Rejected: 'Reject defect',
  'Not a Defect Review': 'Propose Not a Defect', 'Not a Defect': 'Confirm Not a Defect',
  'Change Request Raised': 'Close as Enhancement / CR', 'Accept Risk': 'Accept risk & close',
  assess: 'Review production impact', occurrence: 'Record affected environment',
  block: 'Report a blocker', unblock: 'Clear blocker',
}

export const DEFECT_WORKFLOW_ACTION_DESCRIPTIONS: Record<string, string> = {
  Triaged: 'Assess impact and assign the defect to a resolver.',
  'In Progress': 'Begin investigation and active resolution work.',
  'Ready for QA': 'Submit the fix, build, and evidence for QA verification.',
  'QA Testing': 'Start independent QA verification of the submitted fix.',
  'Business Acceptance': 'Route the verified build for business sign-off.',
  'Ready for Release': 'Approve the verified fix for release.',
  'Production Verification': 'Record deployment and verify the production build.',
  Closed: 'Complete verification and close the defect.',
  Reopened: 'Return the defect to active work with supporting evidence.',
  Deferred: 'Postpone work with approval and a target review date.',
  Duplicate: 'Link this report to the defect that already tracks the issue.',
  Rejected: 'Reject this report with a documented reason and evidence.',
  'Not a Defect Review': 'Send the developer rationale to an independent QA reviewer.',
  'Not a Defect': 'Confirm the reviewed Not a Defect outcome.',
  'Change Request Raised': 'Convert the requirement gap to a referenced CR or enhancement.',
  'Accept Risk': 'Close through an authorized, documented risk decision.',
  assess: 'Confirm whether the issue affects the live production system.',
  occurrence: 'Add another environment and build where this defect was observed.',
  block: 'Pause progress and record the blocker owner and review date.',
  unblock: 'Clear the current blocker and resume workflow actions.',
}

export function availableDefectWorkflowActions(defect: DefectOut, user?: UserOut | null): string[] {
  if (!defect.workflow || !user || isViewOnly(user)) return []
  const state = defect.workflow_state || {}
  const roles = user.roles || []
  const manager = hasWorkflowRole(user, 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')
  const canTriage = manager || roles.includes('QA_ENGINEER')
  const resolver = defect.assignee_id === user.id
  const qa = defect.retest_tester_id === user.id
  const business = state.business_owner_id === user.id
  const release = state.release_owner_id === user.id
  const reporter = defect.reporter_id === user.id
  const participant = manager || resolver || qa || business || release || reporter
  const permitted = (defect.workflow_transitions || []).filter(target => {
    if (target === 'Accept Risk') return roles.includes('ADMIN') || roles.includes('APPLICATION_OWNER')
    if (target === 'Triaged') return canTriage
    if (['In Progress', 'Ready for QA'].includes(target)) return manager || resolver
    if (target === 'Deferred') return manager || roles.includes('APPLICATION_OWNER')
    if (target === 'Not a Defect Review') return resolver
    if (target === 'Not a Defect') return defect.status === 'Not a Defect Review' && (manager || qa)
    if (target === 'Change Request Raised') return defect.status === 'Not a Defect Review' && (manager || qa)
    if (target === 'Reopened' && defect.status === 'Not a Defect Review') return manager || qa
    if (['Duplicate', 'Rejected'].includes(target)) return manager || resolver || reporter
    if (defect.status === 'Closed') return manager || reporter
    if (target === 'QA Testing' || ['QA Testing', 'Ready for QA'].includes(defect.status)) return manager || qa
    if (defect.status === 'Business Acceptance') return manager || business
    if (['Ready for Release', 'Production Verification'].includes(defect.status)) return manager || release
    return manager || resolver || reporter
  })
  const closed = ['Closed', 'Rejected', 'Duplicate', 'Not a Defect', 'Change Request Raised'].includes(defect.status)
  const canManageBlocker = !closed && (manager || resolver || qa || business || release)
  if (state.blocked) return canManageBlocker ? ['unblock'] : []
  const primaryTarget = (defect.workflow_transitions || [])[0]
  return Array.from(new Set([
    ...(primaryTarget && permitted.includes(primaryTarget) ? [primaryTarget] : []),
    ...permitted.filter(target => target !== primaryTarget),
    ...(canTriage && !closed ? ['assess'] : []),
    ...(participant && !closed ? ['occurrence'] : []),
    ...(canManageBlocker ? ['block'] : []),
  ]))
}

export default function DefectWorkflowPanel({ defect, defects, users, departments, onChanged, showActionPicker = true, requestedAction, onRequestedActionChange }: {
  defect: DefectOut; defects: DefectListOut[]; users: UserOption[]; departments: DepartmentOut[]; onChanged: (d: DefectOut) => void
  showActionPicker?: boolean; requestedAction?: string; onRequestedActionChange?: (action: string) => void
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
  const requiresReference = ['Ready for QA', 'Production Verification', 'occurrence', 'Accept Risk', 'Not a Defect Review', 'Reopened'].includes(choice)
    || (choice === 'Not a Defect' && data.resolution_type === 'Documentation Updated')
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
  const forward = isTransition && !['Reopened', 'Deferred', 'Duplicate', 'Rejected', 'Not a Defect Review', 'Not a Defect', 'Change Request Raised', 'Accept Risk'].includes(choice)
  const productionImpactLocked = defect.environment === 'Production'
    || state.occurrences?.some(occurrence => occurrence.environment === 'Production')
    || ['Ready for Release', 'Production Verification'].includes(defect.status)
  const field = (key: string, label: string, required = true, type = 'text') => <Field label={label + (required ? ' *' : '')}><input disabled={busy} type={type} required={required} value={data[key] || ''} onChange={e => setData({ ...data, [key]: e.target.value })} /></Field>
  const [candidates, setCandidates] = useState<Record<string, UserOption[]>>({})
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [candidateError, setCandidateError] = useState<unknown>(null)
  useEffect(() => {
    if (!choice) return
    let active = true
    setCandidates({}); setLoadingCandidates(true); setCandidateError(null)
    api.get<Record<string, UserOption[]>>(`/api/defects/${defect.id}/workflow-candidates?department=${encodeURIComponent(data.assigned_team || '')}`)
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
  const canonicalDefects = defects.filter((candidate) => candidate.id !== defect.id && candidate.status !== 'Duplicate')
  const canonicalDefectOptions = canonicalDefects.map((candidate) => ({
    value: String(candidate.id),
    label: `${candidate.defect_key} · ${candidate.title} · ${candidate.status} · ${candidate.application_name}`,
  }))
  const selectedCanonicalDefect = canonicalDefects.find((candidate) => candidate.id === Number(data.duplicate_defect_id))

  function richField(key: string, label: string, placeholder: string, required = true) {
    return <Field label={`${label}${required ? ' *' : ''}`}><JiraRichTextField key={`${editorVersion}-${key}`} value={data[key] || ''} disabled={busy}
      onChange={value => setData(current => ({ ...current, [key]: value }))}
      onImagesChange={images => setFieldImages(current => ({ ...current, [key]: images }))}
      ariaLabel={label} placeholder={placeholder} /></Field>
  }
  function select(value: string) {
    if (busy) return
    setChoice(value); setError(null); setFiles([]); setFieldImages({}); setEditorVersion(v => v + 1); setUploadStatus('')
    setData({ production_impact: productionImpactLocked ? 'Affected' : state.production_impact || 'Unknown', build: state.deployed_build || defect.build_version || '', environment: workflow.qa_environment, assigned_team: defect.assigned_team || defect.project_department || '', release_owner_id: state.release_owner_id, business_owner_id: state.business_owner_id, ...(value === 'Not a Defect' ? { resolution_type: 'Working as Designed' } : {}) })
  }
  function chooseAction(value: string) {
    select(value)
    onRequestedActionChange?.(value)
  }
  function clearAction() {
    if (busy) return
    setChoice('')
    onRequestedActionChange?.('')
  }
  useEffect(() => {
    if (requestedAction === undefined || requestedAction === choice) return
    if (requestedAction) select(requestedAction)
    else setChoice('')
  }, [requestedAction, defect.id])
  const permitted = (defect.workflow_transitions || []).filter(target => {
    if (target === 'Accept Risk') return roles.includes('ADMIN') || roles.includes('APPLICATION_OWNER')
    if (target === 'Triaged') return canTriage
    if (['In Progress', 'Ready for QA'].includes(target)) return manager || resolver
    if (target === 'Deferred') return manager || roles.includes('APPLICATION_OWNER')
    if (target === 'Not a Defect Review') return resolver
    if (target === 'Not a Defect') return defect.status === 'Not a Defect Review' && (manager || qa)
    if (target === 'Change Request Raised') return defect.status === 'Not a Defect Review' && (manager || qa)
    if (target === 'Reopened' && defect.status === 'Not a Defect Review') return manager || qa
    if (['Duplicate', 'Rejected'].includes(target)) return manager || resolver || reporter
    if (defect.status === 'Closed') return manager || reporter
    if (target === 'QA Testing' || ['QA Testing', 'Ready for QA'].includes(defect.status)) return manager || qa
    if (defect.status === 'Business Acceptance') return manager || business
    if (['Ready for Release', 'Production Verification'].includes(defect.status)) return manager || release
    return manager || resolver || reporter
  })
  const closed = ['Closed', 'Rejected', 'Duplicate', 'Not a Defect', 'Change Request Raised'].includes(defect.status)
  const impact = state.production_impact || 'Unknown'
  const productionRequired = defect.workflow_stages?.includes('Production Verification')
  const primaryTarget = (defect.workflow_transitions || [])[0]
  const stageIndex = (defect.workflow_stages || []).indexOf(defect.status)
  const actionLabels = DEFECT_WORKFLOW_ACTION_LABELS
  const actionDescriptions = DEFECT_WORKFLOW_ACTION_DESCRIPTIONS
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
    'Not a Defect Review': 'The developer proposed that the behavior is expected. QA reviews comments, evidence and requirements, then accepts, reopens, or converts the requirement gap to a Change Request.',
    'Not a Defect': 'QA accepted the proposal with a recorded classification. Review the evidence and decision below.',
    'Change Request Raised': 'QA found a requirement gap and recorded the related Change Request or enhancement reference.',
    Duplicate: 'This issue is tracked by another defect. Review the linked canonical defect below.',
  }
  const stageOwnership = defectStageOwnership(defect, users)
  const stageHelp: Record<string, string> = { New: 'Report', Triaged: 'Assess & assign', 'In Progress': 'Investigate & fix', 'Not a Defect Review': 'Independent QA triage', 'Not a Defect': 'QA-confirmed outcome', 'Change Request Raised': 'Enhancement recorded', 'Ready for QA': 'QA handoff', 'QA Testing': 'Test & verify', 'Business Acceptance': 'Business sign-off', 'Ready for Release': 'Release approval', 'Production Verification': 'Verify live fix', Closed: 'Complete' }
  const availableActions = availableDefectWorkflowActions(defect, user)
  const recommendedAction = availableActions.find(target => target === primaryTarget)
    || (state.blocked ? availableActions[0] : undefined)
  const alternativeActions = availableActions.filter(target => target !== recommendedAction)
  const submitActionLabel = ({
    assess: 'Save impact assessment', occurrence: 'Save environment record', block: 'Confirm blocker', unblock: 'Clear blocker',
  } as Record<string, string>)[choice] || actionLabels[choice] || 'Save action'
  const actionChoice = (target: string, featured = false) => {
    const isSelected = choice === target
    const isCaution = ['Rejected', 'Reopened', 'Deferred', 'block'].includes(target)
    return <button type="button" className={`defect-action-choice${featured ? ' recommended featured' : ''}${isSelected ? ' selected' : ''}${isCaution ? ' caution' : ''}`} disabled={busy} aria-pressed={isSelected} key={target} onClick={() => chooseAction(target)}>
      <span className="defect-action-choice-marker" aria-hidden="true">{isSelected ? '✓' : featured ? '→' : ''}</span>
      <span className="defect-action-choice-copy">
        <span className="defect-action-choice-top"><strong>{actionLabels[target] || target}</strong>{featured && <em>Recommended next step</em>}</span>
        <small>{actionDescriptions[target] || 'Record this workflow decision with its supporting rationale.'}</small>
      </span>
      <span className="defect-action-choice-cta">{isSelected ? 'Selected' : featured ? 'Continue' : 'Choose'}<span aria-hidden="true">→</span></span>
    </button>
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null)
    if (busy) return
    if (['assess', 'Triaged'].includes(choice) && !['Unknown', 'Unaffected', 'Affected'].includes(data.production_impact)) {
      setError(new Error('Select a valid production impact')); return
    }
    if (!(data.remarks || '').trim()) { setError(new Error('Enter the observed result or decision rationale')); return }
    if (choice === 'Duplicate' && !data.duplicate_defect_id) { setError(new Error('Select the canonical defect')); return }
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
      setChoice(''); onRequestedActionChange?.(''); onChanged(updated)
    } catch (e) { setError(e) } finally { setBusy(false); setUploadStatus('') }
  }
  return <section className="workflow-panel">
    {confirmationModal}
    <header className="defect-workflow-heading"><div><span className="workflow-action-eyebrow">RESOLUTION WORKFLOW</span><h3>{state.blocked ? 'Work is blocked' : defect.status}</h3><p>{guidance[defect.status] || 'Review the current decision and choose an available action.'}</p></div><div className="defect-workflow-owner"><span>{stageOwnership.heading}</span><strong>{stageOwnership.ownerName || 'Not assigned yet'}</strong><small>{stageOwnership.departmentLabel}</small></div></header>
    <ol className="workflow-stages defect-workflow-path" aria-label="Defect resolution stages">{defect.workflow_stages?.map((stage, index) => <li key={stage} className={stageIndex >= 0 && index < stageIndex ? 'completed' : ''} aria-current={stage === defect.status ? 'step' : undefined}><span className="defect-stage-number">{stageIndex >= 0 && index < stageIndex ? '✓' : index + 1}</span><div><strong>{stage}</strong><small>{stageHelp[stage] || stage}</small></div></li>)}</ol>
    <div className="defect-workflow-context">
      <section className={`defect-impact-card impact-${impact.toLowerCase()}`}><span className="workflow-action-eyebrow">PRODUCTION IMPACT</span><h4>{impact === 'Affected' ? 'Production is affected' : impact === 'Unaffected' ? 'Production is not affected' : 'Impact needs assessment'}</h4><p>{impact === 'Unknown' ? 'QA must assess whether the issue affects production before verification can be completed.' : productionRequired ? 'Release and production verification are required before closure.' : 'Close after the required QA' + (workflow.business_acceptance ? ' and business' : '') + ' verification passes.'}</p>{workflow.production_for_all && <small>Workspace policy requires production verification for every fix.</small>}{showActionPicker && !viewOnly && canTriage && !closed && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => chooseAction('assess')}>{impact === 'Unknown' ? 'Assess production impact' : 'Review production impact'}</button>}</section>
      <section className="defect-verification-card"><span className="workflow-action-eyebrow">REQUIRED CHECKS</span><h4>Before this defect can close</h4><ul><li>QA verification in <strong>{workflow.qa_environment}</strong></li>{workflow.business_acceptance && <li>Business acceptance in <strong>{workflow.business_environment}</strong></li>}{productionRequired && <li>Deployment & verification in <strong>Production</strong></li>}{impact === 'Unknown' && <li>Confirm production impact to determine the release path</li>}</ul></section>
    </div>
    {state.blocked && <div className="defect-workflow-blocker" role="status"><strong>Blocked: {state.blocked.reason}</strong><span>Review by {state.blocked.review_date}. Clear the blocker before moving forward.</span></div>}
    {!viewOnly && showActionPicker && <section className="defect-action-picker" aria-labelledby="defect-action-picker-title">
      <header className="defect-action-picker-heading"><div><span className="workflow-action-eyebrow">{closed ? 'FOLLOW-UP ACTIONS' : 'CHOOSE NEXT ACTION'}</span><h4 id="defect-action-picker-title">{state.blocked ? 'Resolve the blocker to continue' : 'What do you want to do?'}</h4><p>Select an action to review its required information before submitting.</p></div><span className="defect-action-count">{availableActions.length} available</span></header>
      {primaryTarget && !permitted.includes(primaryTarget) && !state.blocked && <div className="defect-action-waiting" role="status"><strong>Next required step: {actionLabels[primaryTarget] || primaryTarget}</strong><span>Waiting for the authorized stage owner or QA lead. Your available actions are shown below.</span></div>}
      {availableActions.length > 0 ? <div className="defect-action-selector">
        {recommendedAction && <section className="defect-action-recommended" aria-label="Recommended next action">
          <span className="defect-action-section-label">Primary path</span>
          {actionChoice(recommendedAction, true)}
        </section>}
        {alternativeActions.length > 0 && <section className="defect-action-alternatives" aria-label="Other valid workflow outcomes">
          <header><div><strong>Other valid outcomes</strong><span>Use these when the recommended path does not match the actual result.</span></div><small>{alternativeActions.length}</small></header>
          <div className="defect-action-grid">{alternativeActions.map(target => actionChoice(target))}</div>
        </section>}
      </div> : <p className="defect-action-empty">No workflow action is available for your role at this stage.</p>}
      {choice && <div className="defect-action-selection" role="status"><span aria-hidden="true">✓</span><div><strong>{actionLabels[choice] || actionTitle}</strong><small>Selected. Complete the required details below, then confirm the action.</small></div><button type="button" disabled={busy} onClick={clearAction}>Change</button></div>}
    </section>}
    <details className="defect-environment-details"><summary>Where has this defect been observed? <span>{state.occurrences?.length || 0} environment record(s)</span></summary><p>These are reported occurrences. Verification results are recorded separately in the activity history.</p><div className="defect-environment-records">{state.occurrences?.map((e, i) => <article key={i}><header><strong>{e.environment}</strong><span>Build: {e.build || 'Not recorded'}</span></header><MarkdownComment value={e.remarks || 'No reproduction notes recorded.'} /></article>)}</div>{showActionPicker && !viewOnly && !closed && participant && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => chooseAction('occurrence')}>+ Record another affected environment</button>}</details>
    {choice && <form ref={actionForm} onSubmit={submit} className="workflow-action-form workflow-action-redesign">
      <header className="workflow-action-heading"><div><span className="workflow-action-eyebrow">ACTION DETAILS</span><h4>{actionTitle}</h4><p>{choice === 'Ready for QA' ? 'Document the fix, select the QA owner, and provide the build and evidence for verification.' : 'Record the details and supporting evidence for this decision.'}</p></div><div className="workflow-action-heading-meta"><span className="workflow-current-stage">From {defect.status}</span><button type="button" disabled={busy} onClick={clearAction} aria-label="Close selected action">×</button></div></header>
      {(['Triaged', 'assess', 'Ready for QA', 'Not a Defect Review', 'Change Request Raised', 'occurrence', 'Production Verification', 'Ready for Release', 'Deferred', 'block', 'Duplicate', 'Business Acceptance'].includes(choice) || verification) && <fieldset disabled={busy} className="workflow-action-fieldset"><legend>{choice === 'assess' ? 'Does this issue affect the live production system?' : 'Assignment and build details'}</legend><div className="workflow-fields">
      {['Triaged', 'assess'].includes(choice) && <Field label="Production impact *"><select value={data.production_impact} onChange={e => setData({ ...data, production_impact: e.target.value })}>{['Unknown', 'Unaffected', 'Affected'].map(x => <option key={x} value={x} disabled={!!productionImpactLocked && x !== 'Affected'}>{x === 'Unknown' ? 'Unknown — assessment pending' : x === 'Affected' ? 'Affected — production needs this fix' : 'Unaffected — issue is limited to test environments'}</option>)}</select></Field>}
      {['Triaged', 'assess'].includes(choice) && productionImpactLocked && <p className="muted small">Production impact must remain Affected because this defect was reported in Production or production delivery is already underway. Production verification is required before closure.</p>}
      {choice === 'Triaged' && <><Field label="Assigned department *"><select required value={data.assigned_team} onChange={e => { setCandidates({}); setData({ ...data, assigned_team: e.target.value, assignee_id: null }) }}><option value="">Select department</option>{departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}</select></Field>{owner('assignee_id', 'Resolver')}{workflow.business_acceptance && owner('business_owner_id', 'Business acceptance owner')}</>}
      {choice === 'Ready for QA' && owner('retest_tester_id', 'QA tester')}
      {choice === 'Not a Defect Review' && owner('retest_tester_id', 'QA reviewer')}
      {choice === 'occurrence' && <Field label="Affected environment *"><select value={data.environment} onChange={e => setData({ ...data, environment: e.target.value })}>{ENVIRONMENTS.map(x => <option key={x}>{x}</option>)}</select></Field>}
      {(['Ready for QA', 'Production Verification', 'occurrence'].includes(choice) || verification) && field('build', verification ? 'Tested build' : 'Deployed / affected build')}
      {choice === 'Business Acceptance' && <p>Business verification uses the same fixed build. Deploy that build to {workflow.business_environment} before starting acceptance.</p>}
      {['Ready for Release', 'Deferred'].includes(choice) && field('target_release', 'Target release')}
      {choice === 'Ready for Release' && owner('release_owner_id', 'Release owner')}
      {['Deferred', 'block'].includes(choice) && field('review_date', 'Review date', true, 'date')}
      {choice === 'Duplicate' && <Field label="Canonical defect *"><SearchableSelect value={data.duplicate_defect_id ? String(data.duplicate_defect_id) : ''} onChange={value => setData({ ...data, duplicate_defect_id: value ? Number(value) : null })} options={canonicalDefectOptions} ariaLabel="Canonical defect" placeholder="Search by defect key, title, status, or application…" />{selectedCanonicalDefect && <small className="muted">Selected: {selectedCanonicalDefect.defect_key} · {selectedCanonicalDefect.status} · {selectedCanonicalDefect.application_name}</small>}</Field>}
      {choice === 'Change Request Raised' && field('related_cr_number', 'Change Request / enhancement reference')}
      </div></fieldset>}
      <section className="workflow-action-narrative">
        {choice === 'Ready for QA' && <>
          {richField('root_cause', 'Root cause', 'Explain why the defect occurred. Include relevant technical findings…')}
          {richField('fix_details', 'Fix details', 'Describe the changes made and what QA should verify…')}
        </>}
        {choice === 'Not a Defect' && <Field label="QA classification *"><select required value={data.resolution_type || ''} onChange={e => setData({ ...data, resolution_type: e.target.value })}><option value="">Select classification</option>{['Working as Designed', 'Requirement Misunderstanding', 'Environment Issue Resolved', 'Test Data Issue', 'Configuration Issue', 'Documentation Updated'].map(value => <option key={value}>{value}</option>)}</select></Field>}
        {richField('remarks', choice === 'Ready for QA' ? 'QA handoff notes' : choice === 'Change Request Raised' ? 'QA enhancement decision' : 'Observed result / decision rationale', choice === 'Ready for QA' ? 'Describe the expected behavior, testing scope, and any important conditions…' : choice === 'Change Request Raised' ? 'Explain the requirement gap, triage participants, and why a Change Request is the correct outcome…' : 'Describe what you observed and why this action is appropriate…')}
      </section>
      <section className="workflow-evidence-section"><h5>Supporting evidence</h5><p>Upload screenshots, logs or documents. You can also paste screenshots into the editors above.</p>
        <label className="workflow-evidence-upload"><strong>Add evidence files</strong><span>Choose one or more files to attach to this action</span><input aria-label="Upload workflow evidence" type="file" multiple disabled={busy} onChange={e => { const added = Array.from(e.target.files || []); setFiles(current => [...current, ...added]); e.target.value = '' }} /></label>
        {files.length > 0 && <ul className="workflow-evidence-files">{files.map((file, index) => <li key={`${file.name}-${index}`}><span><strong>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB{uploaded.current.has(file) ? ' · Uploaded' : ' · Ready to upload'}</small></span><button type="button" className="btn btn-sm" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>}
        {Object.values(fieldImages).flat().length > 0 && <p className="muted small">{Object.values(fieldImages).flat().length} inline screenshot(s) will also be attached.</p>}
        {requiresReference && richField('reference', 'Evidence notes / deployment reference', 'Add a change ID, deployment reference, test result link, or explain the attached evidence…', false)}
        {requiresReference && <p className="muted small">Provide an attachment or an evidence reference before saving.</p>}
      </section>
      {defect.status === 'QA Testing' && forward && <label className="workflow-regression-check"><input disabled={busy} type="checkbox" required checked={!!data.regression_confirmed} onChange={e => setData({ ...data, regression_confirmed: e.target.checked })} /> Confirmation and applicable regression testing passed</label>}
      <ErrorText error={candidateError || error} /><div className="workflow-action-footer"><span role="status">{uploadStatus || 'Review before submitting. Submitted action details cannot be edited.'}</span><div className="workflow-actions"><button className="btn btn-primary" disabled={busy || loadingCandidates || !!candidateError}>{busy ? 'Saving…' : submitActionLabel}</button><button type="button" className="btn" disabled={busy} onClick={clearAction}>Cancel</button></div></div>
    </form>}

  </section>
}
