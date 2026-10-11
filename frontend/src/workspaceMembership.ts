import type { QAWorkspaceOut } from './types'

export function hasOtherActiveWorkspace(
  userId: number,
  excludedWorkspaceId: number,
  workspaces: QAWorkspaceOut[],
): boolean {
  return workspaces.some((workspace) => workspace.id !== excludedWorkspaceId
    && workspace.is_active
    && workspace.members.some((member) => member.user_id === userId && member.is_active))
}
