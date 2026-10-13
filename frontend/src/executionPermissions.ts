import { canReassign, hasWorkflowRole, hasWorkspaceRole, isViewOnly, type RoleBearer } from './constants'

const EXECUTION_ROLES = ['QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA']
const QA_LEAD_ROLES = ['QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA']

export function canUnlinkExecutionDefect(user: RoleBearer | null | undefined, linkerId: number | null | undefined, writableScope: boolean): boolean {
  return writableScope && !!user && !isViewOnly(user) && hasWorkflowRole(user, ...EXECUTION_ROLES)
    && (linkerId === user.id || hasWorkflowRole(user, ...QA_LEAD_ROLES))
}

export function canChangeCycleOwner(user: RoleBearer | null | undefined, ownerId?: number | null, ownerDepartments?: string[]): boolean {
  return !!user && !isViewOnly(user) && hasWorkflowRole(user, ...EXECUTION_ROLES)
    && (!ownerId || canReassign(user, ownerId, ownerDepartments)
    || hasWorkspaceRole(user, 'CHIEF_MANAGER_QA', 'AGM_QA'))
}

export function executionRemovalEligibility(user: RoleBearer | null | undefined, execution: { run_count?: number; added_by_id?: number | null }, canManageGovernance: boolean): { eligible: boolean; reason?: string } {
  if (!user || isViewOnly(user) || !hasWorkflowRole(user, ...EXECUTION_ROLES)) return { eligible: false, reason: 'QA execution access is required.' }
  if (execution.run_count) return { eligible: false, reason: 'This testcase has recorded execution history and must remain in the cycle.' }
  if (canManageGovernance && hasWorkflowRole(user, ...QA_LEAD_ROLES)) return { eligible: true }
  if (execution.added_by_id === user.id) return { eligible: true }
  return { eligible: false, reason: 'Only the QA Lead Group or the person who added this testcase can remove it before execution.' }
}
