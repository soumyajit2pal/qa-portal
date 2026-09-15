import React from 'react'
import { DefectWorkflowPolicy } from '../types'

export default function DefectWorkflowDiagram({ policy, workspaceName, productionAffected = false, draft = false }: {
  policy: DefectWorkflowPolicy; workspaceName?: string; productionAffected?: boolean; draft?: boolean
}) {
  const productionRequired = policy.production_for_all || productionAffected
  const stages = [
    { name: 'New', detail: 'Report the defect' },
    { name: 'Triaged', detail: 'Assign owner · assess production impact' },
    { name: 'In Progress', detail: 'Investigate and fix' },
    { name: 'Ready for QA', detail: 'Deploy fix · assign QA owner' },
    { name: 'QA Testing', detail: policy.qa_environment },
    ...(policy.business_acceptance ? [{ name: 'Business Acceptance', detail: policy.business_environment }] : []),
  ]
  return <figure className="defect-flow-diagram">
    <figcaption><strong>{draft ? 'Workflow preview' : 'Workflow for this defect'}</strong><span>{workspaceName ? `${workspaceName} · ` : ''}{draft ? 'Draft settings' : `Published version ${policy.version}`}</span></figcaption>
    <ol className="defect-flow-track" aria-label="Required workflow stages">
      {stages.map((stage, index) => <li key={stage.name} className={stage.name === 'Triaged' ? 'defect-flow-triage' : ''}>
        <span className="defect-flow-number" aria-hidden="true">{index + 1}</span><strong>{stage.name}</strong><small>{stage.detail}</small>
      </li>)}
    </ol>
    <div className="defect-flow-decision"><span aria-hidden="true">↓</span><strong>Required verification passed</strong><small>{productionRequired ? (policy.production_for_all ? 'Workspace policy requires production verification for every fix' : 'Reported in Production — production verification required') : 'Closure path depends on production impact assessed at triage'}</small></div>
    <div className={`defect-flow-branches ${productionRequired ? 'defect-flow-single' : ''}`}>
      {!productionRequired && <section className="defect-flow-branch"><h5>Production unaffected</h5><div className="defect-flow-closed">Closed — Fixed</div><p>Verified in the tested build.</p></section>}
      <section className="defect-flow-branch"><h5>{productionRequired ? 'Production verification required' : 'Production affected'}</h5><ol className="defect-flow-release" aria-label="Production closure path"><li>Ready for Release</li><li>Production Verification<small>After successful deployment</small></li><li className="defect-flow-closed">Closed — Fixed</li></ol></section>
    </div>
    <div className="defect-flow-return"><strong>↶ Verification fails</strong><span>Reopened → In Progress → new fix and verification</span></div>
    <p className="defect-flow-note">Unknown production impact must be assessed before completing verification. Blocked defects stay at their current stage. Triage can also lead to deferral or an authorized disposition.</p>
  </figure>
}
