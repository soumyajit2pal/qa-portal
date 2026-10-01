export interface FunctionalWorkflowActorInput {
  userId?: number | null
  requesterId?: number | null
  assignedTesterIds?: string | null
  viewOnly?: boolean
  isQaLeadGroup: boolean
  isQaEngineer: boolean
}

export interface FunctionalWorkflowActors {
  isRequester: boolean
  isQaLeadGroup: boolean
  isAssignedTester: boolean
}

function assignedTesterIds(value?: string | null): Set<number> {
  return new Set(
    (value || '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => /^\d+$/.test(item))
      .map(Number),
  )
}

/**
 * Resolve operational Functional actors without inheriting System Admin.
 * The caller supplies workspace-scoped QA role checks; tester authority also
 * requires the live request assignment, matching the backend workflow gates.
 */
export function functionalWorkflowActors(
  input: FunctionalWorkflowActorInput,
): FunctionalWorkflowActors {
  const isRequester = !input.viewOnly
    && input.userId != null
    && input.requesterId === input.userId
  const isAssignedTester = input.isQaEngineer
    && input.userId != null
    && assignedTesterIds(input.assignedTesterIds).has(input.userId)
  return {
    isRequester,
    isQaLeadGroup: input.isQaLeadGroup,
    isAssignedTester,
  }
}

export interface FunctionalClearanceCapabilityInput extends FunctionalWorkflowActors {
  status: string
  hasLinkedCycle: boolean
  hasOpenLinkedCycle: boolean
  hasLinkedCertificate: boolean
  certificateRequesterFallback?: boolean
}

/** Presentation capabilities; locked backend mutations remain authoritative. */
export function functionalClearanceCapabilities(
  input: FunctionalClearanceCapabilityInput,
) {
  const canManageClearance = input.isAssignedTester || input.isQaLeadGroup
  const canDecideClearanceChange = canManageClearance
    || input.certificateRequesterFallback === true
  return {
    canCompleteQA: input.isAssignedTester
      && ['EXECUTION_IN_PROGRESS', 'RETESTING'].includes(input.status)
      && input.hasLinkedCycle
      && !input.hasOpenLinkedCycle,
    canRequestSignoff: canManageClearance
      && input.status === 'QA_COMPLETED'
      && !input.hasLinkedCertificate,
    canReviewClearanceChanges: canDecideClearanceChange
      && input.status === 'QA_CHANGE_REVIEW',
    canRequesterDecide: input.isRequester
      && input.status === 'REQUESTER_VERIFICATION',
  }
}
