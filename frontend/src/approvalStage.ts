/** Workflow context is required because clearance reuses the SM status code. */
export function approvalStage(status?: string | null, applicationMasterStatus?: string | null, workflow?: 'signoff') {
  let roles: string[] = []
  let group = ''
  let departmentScoped = false
  if (workflow === 'signoff' && status === 'SM_APPROVAL_PENDING') {
    roles = ['QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA']; group = 'QA Lead approval'
  } else if (status === 'DEPT_HEAD_QA_APPROVAL_PENDING') {
    roles = ['CHIEF_MANAGER_QA', 'AGM_QA']; group = 'Executive approval'
  } else if (status === 'SM_APPROVAL_PENDING') {
    const appOwner = applicationMasterStatus === 'PENDING_APP_OWNER'
    roles = [appOwner ? 'APPLICATION_OWNER' : 'SM']; group = appOwner ? 'Application Owner approval' : 'SM approval'; departmentScoped = true
  } else if (status === 'DEPARTMENT_HEAD_APPROVAL_PENDING') {
    roles = ['DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM']; group = 'Department Head approval'; departmentScoped = true
  } else if (status === 'QA Lead Approval Pending') {
    roles = ['QA_LEAD']; group = 'QA Lead approval'
  } else if (status === 'Recommendation Pending') {
    roles = ['QA_ENGINEER']; group = 'QA recommendation'
  } else if (status === 'SECURITY_TEAM_VERIFICATION') {
    roles = ['SECURITY_ANALYST']; group = 'Security Team verification'
  }
  return { roles, group, departmentScoped }
}

export interface ApprovalDirectoryContext {
  department?: string | null
  qa_workspace_id?: number | null
  origin_workspace_id?: number | null
  requester_id?: number | null
  // Suppression requests expose their requester using created_by_id rather
  // than requester_id. Supporting both keeps the shared approver directory
  // from accidentally listing the maker as an eligible checker.
  created_by_id?: number | null
}

/**
 * Resolve the authoritative approver-directory endpoint for a workflow badge.
 *
 * Test cases are deliberately record-scoped: shared repositories can display a
 * case from another workspace, and testcase maker-checker exclusions depend on
 * its current draft.  The generic user directory cannot answer either question,
 * so testcase badges must use the same endpoint as the repository's Pending
 * With link. Other workflows retain the workspace/department-scoped directory.
 */
export function approvalDirectoryRequest({
  status,
  applicationMasterStatus,
  workflow,
  context,
  fallbackWorkspaceId,
  testCaseId,
}: {
  status?: string | null
  applicationMasterStatus?: string | null
  workflow?: 'signoff'
  context: ApprovalDirectoryContext
  fallbackWorkspaceId?: number | null
  testCaseId?: number | null
}): { path: string; roles: string[]; group: string; departmentScoped: boolean } | null {
  const stage = approvalStage(status, applicationMasterStatus, workflow)
  const roles = testCaseId && status === 'QA Lead Approval Pending'
    ? ['QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA']
    : stage.roles
  if (!roles.length) return null

  if (testCaseId) {
    const query = new URLSearchParams({
      roles: roles.join(','),
      test_case_id: String(testCaseId),
    })
    return { ...stage, roles, path: `/api/test-projects/eligible-users?${query}` }
  }

  const query = new URLSearchParams({
    purpose: 'approver',
    roles: roles.join(','),
    department_scoped: String(stage.departmentScoped),
  })
  const workspaceId = context.qa_workspace_id ?? context.origin_workspace_id ?? fallbackWorkspaceId
  if (workspaceId) query.set('workspace_id', String(workspaceId))
  if (context.department) query.set('department', context.department)
  const requesterId = context.requester_id ?? context.created_by_id
  if (stage.departmentScoped && requesterId) query.set('exclude_id', String(requesterId))
  return { ...stage, roles, path: `/api/auth/user-options?${query}` }
}
