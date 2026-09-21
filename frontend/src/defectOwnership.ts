import type { DefectOut, UserOption } from './types'

const TERMINAL_STATUSES = new Set(['Closed', 'Rejected', 'Duplicate', 'Not a Defect', 'Change Request Raised'])
const QA_STAGES = new Set(['Ready for QA', 'QA Testing', 'Resolved', 'Retest', 'Not a Defect Review'])

type OwnershipKind = 'triage' | 'resolver' | 'qa' | 'business' | 'release' | 'last-actor'

export interface DefectStageOwnership {
  ownerId: number | null
  ownerName: string | null
  departmentLabel: string
  heading: 'Responsible now' | 'Last responsible owner'
  kind: OwnershipKind
}

function departmentsFor(user?: UserOption): string[] {
  if (!user) return []
  if (user.departments?.length) return user.departments
  return user.department ? [user.department] : []
}

/**
 * Resolve ownership from the workflow stage, rather than from the original
 * developer assignment. Terminal records use the actor who made the final
 * transition, which also handles QA, business and production closure paths.
 */
export function defectStageOwnership(defect: DefectOut, users: UserOption[]): DefectStageOwnership {
  const terminal = TERMINAL_STATUSES.has(defect.status)
  const history = defect.workflow_state?.history || []
  const finalEvent = terminal
    ? [...history].reverse().find((entry) => entry?.to === defect.status && (entry.user_id || entry.user_name))
    : undefined

  let kind: OwnershipKind = 'resolver'
  let ownerId: number | null = null
  let recordedName: string | null = null

  if (finalEvent) {
    kind = 'last-actor'
    ownerId = Number(finalEvent.user_id) || null
    recordedName = typeof finalEvent.user_name === 'string' ? finalEvent.user_name : null
  } else if (defect.status === 'New') {
    kind = 'triage'
  } else if (defect.status === 'Business Acceptance') {
    kind = 'business'
    ownerId = defect.workflow_state?.business_owner_id || null
  } else if (['Ready for Release', 'Production Verification'].includes(defect.status)) {
    kind = 'release'
    ownerId = defect.workflow_state?.release_owner_id || null
  } else if (QA_STAGES.has(defect.status) || ['Not a Defect', 'Change Request Raised'].includes(defect.status)) {
    kind = 'qa'
    ownerId = defect.retest_tester_id || null
  } else if (defect.status === 'Closed') {
    // Legacy records and early modern records may not have workflow history.
    // Infer the final verifier from the configured path without ever falling
    // back to the original developer merely because the defect is closed.
    if (defect.workflow_stages?.includes('Production Verification')) {
      kind = 'release'
      ownerId = defect.workflow_state?.release_owner_id || null
    } else if (defect.workflow_stages?.includes('Business Acceptance')) {
      kind = 'business'
      ownerId = defect.workflow_state?.business_owner_id || null
    } else {
      kind = 'qa'
      ownerId = defect.retest_tester_id || null
    }
  } else {
    ownerId = defect.assignee_id || null
  }

  const owner = users.find((candidate) => candidate.id === ownerId)
  const ownerDepartments = departmentsFor(owner)
  const ownerName = owner?.full_name
    || recordedName
    || (ownerId === defect.assignee_id ? defect.assignee_name || null : null)
    || (kind === 'triage' ? 'QA triage team' : null)
  const fallbackDepartment = kind === 'triage' ? 'QA team'
    : kind === 'qa' ? 'QA team'
    : kind === 'business' ? 'Business acceptance team'
    : kind === 'release' ? 'Release team'
    : ownerId === defect.assignee_id ? defect.assigned_team || 'Department not assigned'
    : 'Owner department unavailable'

  return {
    ownerId,
    ownerName,
    departmentLabel: ownerDepartments.length ? ownerDepartments.join(', ') : fallbackDepartment,
    heading: terminal ? 'Last responsible owner' : 'Responsible now',
    kind,
  }
}
