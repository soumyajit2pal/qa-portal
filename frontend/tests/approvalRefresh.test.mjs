import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/context/AuthContext.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const refreshUser = async () => {')
const code = source.slice(start, source.indexOf('  const acknowledgeLogin', start))
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
async function refresh(previous, next, failure) {
  const events = []
  const context = {
    user: previous,
    api: { get: async path => { assert.equal(path, '/api/auth/me'); if (failure) throw failure; return next } },
    syncWorkspaceSelection: me => events.push(['workspace', me.active_workspace_id]),
    setUser: me => events.push(['user', me]),
    sessionStorage: { setItem: (key, value) => events.push(['session', key, value]) },
    window: { location: { replace: path => events.push(['navigate', path]) } },
  }
  vm.createContext(context)
  vm.runInContext(compiled + '\nglobalThis.refresh = refreshUser', context)
  try { await context.refresh() } catch (error) { events.push(['error', error.message]) }
  return events
}
const pending = { needs_role_review: true, needs_department_selection: false }
const approved = { needs_role_review: false, needs_department_selection: false, active_workspace_id: 42 }
test('approved account persists workspace before opening a fresh dashboard session', async () => {
  assert.deepEqual(await refresh(pending, approved), [
    ['workspace', 42], ['session', 'qa_approved_session', '1'], ['navigate', '/'],
  ])
})
test('still-pending approval stays on the current screen', async () => {
  assert.deepEqual(await refresh(pending, pending), [['workspace', undefined], ['user', pending]])
})
test('incomplete department setup does not launch the dashboard', async () => {
  const incomplete = { ...approved, needs_department_selection: true }
  assert.deepEqual(await refresh(pending, incomplete), [['workspace', 42], ['user', incomplete]])
})
test('ordinary account refresh does not reload the page', async () => {
  assert.deepEqual(await refresh(approved, approved), [['workspace', 42], ['user', approved]])
})
test('failed approval check neither navigates nor replaces the current user', async () => {
  assert.deepEqual(await refresh(pending, null, new Error('Unavailable')), [['error', 'Unavailable']])
})
