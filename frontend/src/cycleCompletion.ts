export const REQUIRED_LINKED_REQUEST_COMPLETION_STATUS = 'EXECUTION_IN_PROGRESS'

export interface CycleCompletionRequestContext {
  linked_request_id?: number | null
  linked_request_key?: string | null
  linked_request_status?: string | null
}

export interface CycleCompletionRequestGate {
  linked: boolean
  allowed: boolean
  currentStatus: string | null
}

/**
 * UI alignment for the server-owned Test Cycle completion rule. A linked
 * cycle fails closed unless the response carries the exact canonical status;
 * standalone cycles have no linked QA Request prerequisite.
 */
export function cycleCompletionRequestGate(cycle: CycleCompletionRequestContext): CycleCompletionRequestGate {
  const linked = cycle.linked_request_id != null || !!cycle.linked_request_key
  const currentStatus = cycle.linked_request_status ?? null
  return {
    linked,
    allowed: !linked || currentStatus === REQUIRED_LINKED_REQUEST_COMPLETION_STATUS,
    currentStatus,
  }
}
