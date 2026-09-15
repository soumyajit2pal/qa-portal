import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
function block(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) }
const code = block('function isAccessApprovalPending(', 'function isWorkspaceAccessMissing(')
  + block('function isLdapEmailCompletionRequired(', 'function AccessApprovalPending(')
  + block('function AuthenticatedChrome(', '// Reported directly (twice now)')
const compiled = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText
function render(user) {
  const mounted = []
  const component = name => ({ children }) => { mounted.push(name); return React.createElement('div', null, children) }
  const context = { React }
  for (const name of ['RequestViewer','Layout','DepartmentPrompt','EmailCompletionPrompt','AccessApprovalPending','PendingApprovalsNotice']) context[name] = component(name)
  vm.createContext(context)
  vm.runInContext(compiled, context)
  renderToStaticMarkup(React.createElement(context.AuthenticatedChrome, {user}, React.createElement(component('Dashboard'))))
  return mounted
}
const approved = {login_type:'LDAP',roles:['QA_ENGINEER'],email:'qa@example.test',needs_department_selection:false,needs_role_review:false}
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
