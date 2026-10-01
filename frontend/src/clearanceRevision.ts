export function isImmutableClearanceStatus(status: string): boolean {
  return ['ISSUED', 'ISSUED_UNDER_REVIEW', 'SM_REJECTED', 'DEPT_HEAD_COE_REJECTED', 'SUPERSEDED', 'VOIDED'].includes(status)
}

export function canCreateClearanceRevision(input: {
  status: string
  canCreateRevision?: boolean
  revisionActorAllowed?: boolean
  viewOnly: boolean
  supersededById?: number | null
  sourceRequestStatus?: string | null
  sourceStatusResolved?: boolean
}): boolean {
  return !input.viewOnly
    // The action capability is computed from the locked backend workflow
    // rules. Missing or stale responses must fail closed; the remaining
    // client checks are defense-in-depth and keep the UI explanatory.
    && input.canCreateRevision === true
    && ['ISSUED', 'ISSUED_UNDER_REVIEW', 'SM_REJECTED', 'DEPT_HEAD_COE_REJECTED'].includes(input.status)
    && !input.supersededById
    && input.sourceStatusResolved !== false
    && !['EXECUTION_IN_PROGRESS', 'DEFECT_RAISED', 'WAITING_FOR_FIX', 'RETESTING']
      .includes(input.sourceRequestStatus || '')
    // Actor authorization is deliberately server-owned. It is based on the
    // live Functional assignment and certificate workspace, neither of which
    // may be reconstructed safely from the frozen certificate snapshot.
    && input.revisionActorAllowed === true
}
