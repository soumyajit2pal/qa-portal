import { DEFECT_REASSIGNABLE_STATUSES, hasDepartment, hasWorkspaceMembership, hasWorkspaceRole, isViewOnly } from './constants'
import type { RoleBearer } from './constants'
import { defectResolverDepartment } from './defectOwnership'
import type { DefectOut, UserOption } from './types'

export interface DefectAssignmentContext {
  defect: DefectOut
  responsibility_kind: string
  responsibility_owner_id: number | null
  responsibility_owner_name: string | null
  resolver_department_source: string
  suggested_resolver_id: number | null
  can_reassign: boolean
  can_recover: boolean
  routing_recovery_needed: boolean
  reassignment_candidates: UserOption[]
  recovery_departments: string[]
  recovery_candidates: UserOption[]
}

export function canRecoverDefectRouting(defect: DefectOut, user?: RoleBearer | null): boolean {
  if (!user || isViewOnly(user) || !defect.assignee_id || !DEFECT_REASSIGNABLE_STATUSES.includes(defect.status)) return false
  if (!hasWorkspaceMembership(user, defect.qa_workspace_id)) return false
  if (user.roles?.includes('ADMIN')) return true
  if (hasWorkspaceRole(user, 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA')) return true
  const trusted = !!defect.workflow_state?.resolver_department
    || !!defect.workflow_state?.history?.some(event => event.to === 'Triaged' && event.assigned_team)
  return trusted && hasDepartment(user, defectResolverDepartment(defect))
    && !!user.roles?.some(role => ['DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM'].includes(role))
}
