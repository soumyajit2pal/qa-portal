export interface ClearanceSecurityRequestRef {
  request_id?: string | null
  status?: string | null
}

export interface ClearanceParentRequest {
  request_types?: string | null
  linked_sast_requests: ClearanceSecurityRequestRef[]
  linked_dast_requests: ClearanceSecurityRequestRef[]
}

// A final Department Head rejection ends that linked security workstream.
// It must not hold up the Functional QA Clearance indefinitely. Reopenable
// or still-active states (including SM_REJECTED and REPORT_READY) continue
// to block until their workflow reaches a final outcome.
export const SECURITY_STATUSES_SATISFYING_CLEARANCE = [
  'CLOSED',
  'DEPARTMENT_HEAD_REJECTED',
] as const

const SECURITY_CLEARANCE_COMPLETE = new Set<string>(SECURITY_STATUSES_SATISFYING_CLEARANCE)

export function linkedSecurityClearanceBlockers(parent: ClearanceParentRequest): string[] {
  const selected = new Set(
    (parent.request_types || '')
      .split(',')
      .map(value => value.trim().toUpperCase())
      .filter(Boolean),
  )
  const blockers: string[] = []

  for (const [kind, siblings] of [
    ['SAST', parent.linked_sast_requests],
    ['DAST', parent.linked_dast_requests],
  ] as const) {
    if (selected.has(kind) && siblings.length === 0) {
      blockers.push(`${kind} child request missing`)
    }
    for (const sibling of siblings) {
      const status = (sibling.status || '').trim().toUpperCase()
      if (!SECURITY_CLEARANCE_COMPLETE.has(status)) {
        blockers.push(`${kind} ${sibling.request_id || '(no ID)'} (${sibling.status || 'no status'})`)
      }
    }
  }

  return blockers
}
