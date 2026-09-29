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

function localWallClock(value?: string | null): number | null {
  if (!value) return null
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/)
  if (!match) return null
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
    Number((match[7] || '').slice(0, 3).padEnd(3, '0')),
  )
}

function qaOwnerId(defect: DefectOut): number | null {
  const explicitOwner = Number(defect.workflow_state?.qa_owner_id) || null
  if (explicitOwner) return explicitOwner

  // Compatibility for records reassigned by the old generic endpoint. It
  // overwrote assignee_id after the QA handoff instead of changing the QA
  // owner field, producing exactly the mismatch visible in the detail view.
  const handoff = [...(defect.workflow_state?.history || [])].reverse().find((entry) =>
    ['Resolved', 'Ready for QA', 'Not a Defect Review'].includes(String(entry?.to || '')),
  )
  const assignedAt = localWallClock(defect.assigned_at)
  const handedOffAt = localWallClock(typeof handoff?.at === 'string' ? handoff.at : null)
  if (
    defect.assignee_id
    && defect.retest_tester_id
    && defect.assignee_id !== defect.retest_tester_id
    && assignedAt !== null
    && handedOffAt !== null
    && assignedAt > handedOffAt
  ) return defect.assignee_id

  return defect.retest_tester_id || null
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
    ownerId = qaOwnerId(defect)
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
      ownerId = qaOwnerId(defect)
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
