export interface ClearanceCreationActorInput {
  assignedTesterIds?: string | null
  userId?: number | null
  isQaLeadGroup: boolean
  isQaEngineer: boolean
}

/**
 * Client-side presentation gate for starting a certificate from a Functional
 * request. The mutation endpoint remains authoritative and re-evaluates the
 * same rule against locked, live assignment data.
 */
export function canCreateClearanceForRequest(input: ClearanceCreationActorInput): boolean {
  // System administration is deliberately not workflow authority. An
  // Administrator who also holds an operational QA role passes through the
  // corresponding QA Lead/current-tester branch below.
  if (input.isQaLeadGroup) return true
  if (!input.isQaEngineer || input.userId == null) return false

  return (input.assignedTesterIds || '')
    .split(',')
    .map((value) => value.trim())
    .some((value) => /^\d+$/.test(value) && Number(value) === input.userId)
}
