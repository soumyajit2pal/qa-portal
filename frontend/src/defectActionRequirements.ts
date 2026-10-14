import type { DefectOut } from './types'

const reasons: Record<string, string> = {
  Reopened: 'Failure observed / reopening reason', Deferred: 'Deferral reason',
  Rejected: 'Rejection reason', 'Not a Defect Review': 'Developer rationale',
  'Not a Defect': 'QA triage decision', 'Change Request Raised': 'QA enhancement decision',
  'Accept Risk': 'Risk acceptance rationale', block: 'Blocker reason', occurrence: 'Reproduction notes',
}

export function defectActionRequirements(defect: Pick<DefectOut, 'status' | 'workflow_state'>,
  action: string, data: Record<string, any> = {}) {
  const transition = !!action && !['assess', 'occurrence', 'block', 'unblock'].includes(action)
  const verification = transition && ['QA Testing', 'Business Acceptance', 'Production Verification'].includes(defect.status)
  const reasonLabel = reasons[action] || (action === 'assess'
    && data.production_impact !== (defect.workflow_state?.production_impact || 'Unknown') ? 'Impact change reason' : null)
  return {
    verification, confirmationRequired: verification && action !== 'Reopened',
    reasonLabel, notesRequired: !!reasonLabel,
    notesLabel: reasonLabel || (verification ? 'Verification notes' : action === 'Ready for QA' ? 'QA handoff notes' : 'Additional notes'),
    requiresReference: ['Ready for QA', 'Production Verification', 'occurrence', 'Accept Risk',
      'Not a Defect Review', 'Reopened', 'Rejected'].includes(action)
      || (action === 'Not a Defect' && data.resolution_type === 'Documentation Updated') || verification,
  }
}
