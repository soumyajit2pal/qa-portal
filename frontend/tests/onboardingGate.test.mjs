import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
function block(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) }
const code = block('function isAccessApprovalPending(', 'function isLdapEmailCompletionRequired(')
  + block('function isLdapEmailCompletionRequired(', 'function AccessApprovalPending(')
  + block('function AuthenticatedChrome(', '// Reported directly (twice now)')
  + block('function ProtectedLayout(', 'function LoginRoute(')
  + block('function HelpRoute(', 'function PublicHelp(')
const compiled = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText
function render(user, entry = 'AuthenticatedChrome') {
  const mounted = []
  const component = name => ({ children }) => { mounted.push(name); return React.createElement('div', null, children) }
  const context = {
    React,
    useAuth: () => ({user, loading:false}),
    useLocation: () => ({ pathname: '/test-projects', search: '', hash: '' }),
    isDocumentPortalOnly: () => false,
    uniqueWorkspaceAccess: user => [...(user.workspace_access || user.qa_workspace_access || [])].filter(row => row.is_active),
  }
  for (const name of ['RequestViewer','Layout','DepartmentPrompt','EmailCompletionPrompt','AccessApprovalPending','WorkspaceAccessRequired','PendingApprovalsNotice','DocumentOnlyAccessGuard','Outlet','Help','PublicHelp']) context[name] = component(name)
  vm.createContext(context)
  vm.runInContext(compiled, context)
  renderToStaticMarkup(React.createElement(context[entry], {user}, React.createElement(component('Dashboard'))))
  return mounted
}
const approved = {workspace_access:[{workspace_id:2,workspace_key:'QA',is_active:true}],login_type:'LDAP',roles:['QA_ENGINEER'],email:'qa@example.test',needs_department_selection:false,needs_role_review:false}
test('first LDAP login mounts only department setup, never protected pages', () => {
  assert.deepEqual(render({...approved,needs_department_selection:true,needs_role_review:true}),['DepartmentPrompt'])
})
test('submitted access request mounts only pending approval', () => {
  assert.deepEqual(render({...approved,needs_role_review:true}),['AccessApprovalPending'])
})
test('missing LDAP email mounts only email setup', () => {
  assert.deepEqual(render({...approved,email:''}),['EmailCompletionPrompt'])
})
test('approved and complete user mounts portal and pending notice', () => {
  assert.deepEqual(render(approved),['RequestViewer','Layout','Dashboard','PendingApprovalsNotice'])
})

for (const memberships of [[], [{workspace_id:1,workspace_key:'DEFAULT',is_active:true}], [
  {workspace_id:1,workspace_key:'DEFAULT',is_active:true},
  {workspace_id:2,workspace_key:'QA',is_active:false},
]]) {
  test(`blocks portal mounting without an operational workspace: ${JSON.stringify(memberships)}`, () => {
    assert.deepEqual(render({...approved,workspace_access:memberships}), ['WorkspaceAccessRequired'])
  })
}
test('default-only pending user receives workspace assignment guidance', () => {
  assert.deepEqual(render({...approved,needs_role_review:true,workspace_access:[{workspace_id:1,workspace_key:'DEFAULT',is_active:true}]}), ['WorkspaceAccessRequired'])
})
test('an operational assignment unlocks the portal even if Default remains selected', () => {
  assert.deepEqual(render({...approved,active_workspace_id:1,workspace_access:[{workspace_id:1,workspace_key:'DEFAULT',is_active:true},...approved.workspace_access]}), ['RequestViewer','Layout','Dashboard','PendingApprovalsNotice'])
})
test('legacy membership alias also blocks Default-only access', () => {
  assert.deepEqual(render({...approved,workspace_access:undefined,qa_workspace_access:[{workspace_id:1,workspace_key:'DEFAULT',is_active:true}]}), ['WorkspaceAccessRequired'])
})

test('direct protected URLs and signed-in Help cannot bypass the workspace gate', () => {
  const user = {...approved,workspace_access:[{workspace_id:1,workspace_key:'DEFAULT',is_active:true}]}
  assert.deepEqual(render(user, 'ProtectedLayout'), ['WorkspaceAccessRequired'])
  assert.deepEqual(render(user, 'HelpRoute'), ['WorkspaceAccessRequired'])
})
test('legacy Default name is recognized when the key is absent', () => {
  assert.deepEqual(render({...approved,workspace_access:[{workspace_id:1,workspace_name:'Default Workspace',is_active:true}]}), ['WorkspaceAccessRequired'])
})
