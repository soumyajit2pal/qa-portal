export interface FunctionalPendingOwnerRecord {
  requester_id?: number | null
}

export interface PendingOwnerUser {
  id: number
  full_name: string
}

/**
 * Keeps the workflow role visible while naming its concrete requester. Other
 * workflow labels intentionally remain group labels because their stages can
 * have multiple assigned or eligible actors.
 */
export function functionalPendingWithLabel(
  record: FunctionalPendingOwnerRecord,
  pendingGroup: string | null | undefined,
  users: PendingOwnerUser[],
): string {
  const group = pendingGroup?.trim() || '—'
  if (group === '—' || group === '--') return '—'

  if (group !== 'Requester' || !record.requester_id) return group

  const requesterName = users
    .find((user) => user.id === record.requester_id)
    ?.full_name.trim()
  return requesterName ? `${group} — ${requesterName}` : group
}
