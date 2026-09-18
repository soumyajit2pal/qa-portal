import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
const source = fs.readFileSync(new URL('../src/workspaceTransition.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
function setup() {
  const storage = new Map(), events = []
  const context = { exports: {}, Date, JSON,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { dispatchEvent: event => events.push(event) },
  }
  vm.runInNewContext(code, context)
  return { api: context.exports, storage, events }
}
test('begin shows destination without leaving a reload marker before success', () => {
  const { api, events, storage } = setup()
  api.beginWorkspaceTransition('DBD - IT')
  assert.equal(events[0].detail.name, 'DBD - IT')
  assert.equal(events[0].detail.phase, 'switching')
  assert.equal(storage.size, 0)
})
test('successful preference update can continue across reload and finish cleanly', () => {
  const { api, events, storage } = setup()
  api.persistWorkspaceTransition('Quality Assurance')
  assert.equal(api.readWorkspaceTransition().name, 'Quality Assurance')
  assert.equal(api.readWorkspaceTransition().phase, 'opening')
  api.endWorkspaceTransition()
  assert.equal(storage.size, 0)
  assert.equal(events.at(-1).detail, null)
})
test('expired and malformed reload markers do not block the portal', () => {
  const { api, storage } = setup()
  storage.set('qa_workspace_transition', '{broken')
  assert.equal(api.readWorkspaceTransition(), null)
  storage.set('qa_workspace_transition', JSON.stringify({ name: 'Old workspace', phase: 'opening', startedAt: Date.now() - 121000 }))
  assert.equal(api.readWorkspaceTransition(), null)
})
