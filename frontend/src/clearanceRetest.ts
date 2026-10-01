export interface ClearanceRetestCycle {
  id: number
  status: string
  environment?: string | null
  reexecution_of_cycle_id?: number | null
  reexecution_successor_cycle_id?: number | null
}

function normalizedEnvironment(value?: string | null): string {
  return (value || '').trim().toLowerCase()
}

/**
 * Return only the latest completed cycle in each lineage, then apply the
 * held certificate's environment. Lineage is resolved before environment
 * filtering so an older UAT parent cannot become eligible merely because
 * its newer successor was executed in a different environment.
 */
export function clearanceRetestLineageLeaves<T extends ClearanceRetestCycle>(cycles: T[]): T[] {
  const supersededCycleIds = new Set<number>()
  for (const cycle of cycles) {
    if (typeof cycle.reexecution_of_cycle_id === 'number') {
      supersededCycleIds.add(cycle.reexecution_of_cycle_id)
    }
    if (typeof cycle.reexecution_successor_cycle_id === 'number') {
      supersededCycleIds.add(cycle.id)
    }
  }

  return cycles.filter((cycle) => (
    cycle.status === 'Completed'
    && !supersededCycleIds.has(cycle.id)
  ))
}

export function eligibleClearanceRetestCycles<T extends ClearanceRetestCycle>(
  cycles: T[],
  certificateEnvironment?: string | null,
): T[] {
  const environment = normalizedEnvironment(certificateEnvironment)
  if (!environment) return []
  return clearanceRetestLineageLeaves(cycles).filter(
    (cycle) => normalizedEnvironment(cycle.environment) === environment,
  )
}

/** The original QA certificate author is only a deadlock-recovery fallback. */
export function isLegacyCertificateRequesterFallback(input: {
  assignedTesterIds?: string | null
  certificateRequesterId?: number | null
  userId?: number | null
}): boolean {
  const hasAssignedTester = (input.assignedTesterIds || '')
    .split(',')
    .some((value) => Number.isInteger(Number(value)) && Number(value) > 0)
  return !hasAssignedTester
    && input.certificateRequesterId != null
    && input.certificateRequesterId === input.userId
}
