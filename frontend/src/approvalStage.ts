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
