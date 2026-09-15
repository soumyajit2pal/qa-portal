import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const source = await readFile(new URL('../src/approvalStage.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } })
const { approvalStage } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
test('clearance legacy SM status resolves to QA approvers, while other workflows resolve to SM', () => {
  assert.deepEqual(approvalStage('SM_APPROVAL_PENDING').roles, ['SM'])
  assert.equal(approvalStage('SM_APPROVAL_PENDING').departmentScoped, true)
  const clearance = approvalStage('SM_APPROVAL_PENDING', null, 'signoff')
  assert.deepEqual(clearance.roles, ['QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA'])
  assert.equal(clearance.departmentScoped, false)
})
test('application approval takes precedence over SM approval only for request workflows', () => {
  assert.deepEqual(approvalStage('SM_APPROVAL_PENDING', 'PENDING_APP_OWNER').roles, ['APPLICATION_OWNER'])
  assert.equal(approvalStage('SM_APPROVAL_PENDING', 'PENDING_APP_OWNER', 'signoff').group, 'QA Lead approval')
})
test('executive, department, security and test-case approvals have explicit roles', () => {
  for (const [status, roles] of [
    ['DEPT_HEAD_QA_APPROVAL_PENDING', ['CHIEF_MANAGER_QA', 'AGM_QA']],
    ['DEPARTMENT_HEAD_APPROVAL_PENDING', ['DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM']],
    ['SECURITY_TEAM_VERIFICATION', ['SECURITY_ANALYST']],
    ['QA Lead Approval Pending', ['QA_LEAD']],
    ['Recommendation Pending', ['QA_ENGINEER']],
  ]) assert.deepEqual(approvalStage(status).roles, roles)
})
test('completed, draft and non-approval badges do not advertise an approver action', () => {
  for (const status of ['ISSUED', 'Approved', 'CLOSED', 'DRAFT', 'Execution In Progress', 'Rejected', null]) assert.deepEqual(approvalStage(status).roles, [])
})
