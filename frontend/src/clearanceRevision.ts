export function isImmutableClearanceStatus(status: string): boolean {
  return ['ISSUED', 'SM_REJECTED', 'DEPT_HEAD_COE_REJECTED', 'SUPERSEDED', 'VOIDED'].includes(status)
}

export function canCreateClearanceRevision(input: {
  status: string
  requesterId?: number | null
  userId?: number | null
  isAdmin: boolean
  viewOnly: boolean
  supersededById?: number | null
}): boolean {
  return !input.viewOnly
    && ['ISSUED', 'SM_REJECTED', 'DEPT_HEAD_COE_REJECTED'].includes(input.status)
    && !input.supersededById
    && (input.isAdmin || input.requesterId === input.userId)
}
