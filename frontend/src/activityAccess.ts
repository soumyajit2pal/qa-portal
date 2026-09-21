/** A visible record remains read-only unless it belongs to the selected workspace. */
export function isActivityReadOnly(
  explicitlyReadOnly: boolean,
  selectedWorkspaceId?: number | null,
  ownerWorkspaceId?: number | null,
): boolean {
  return explicitlyReadOnly || (ownerWorkspaceId != null && ownerWorkspaceId !== selectedWorkspaceId)
}
