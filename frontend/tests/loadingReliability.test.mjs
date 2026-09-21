import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function compile(source) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}
const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/import\.meta\.env\.VITE_API_BASE_URL/g, "''").replace(/import\.meta\.env\.PROD/g, "false")
function harness(bodyKind, status = 200) {
  const timers = new Map()
  let next = 0
  let signal
  const context = {
    exports: {}, AbortController, DOMException, console,
    sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null },
    // api.ts imports this helper in production. Imports are removed in this
    // focused VM harness, so provide the no-workspace result explicitly.
    selectedWorkspaceStorageId: () => '',
    window: { setTimeout: fn => { timers.set(++next, fn); return next }, clearTimeout: id => timers.delete(id) },
    fetch: async (_url, opts) => {
      signal = opts.signal
      return { ok: status === 200, status, headers: { get: () => null },
        [bodyKind]: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
      }
    },
  }
  vm.runInNewContext(compile(apiSource) + "\nexports.executeRequest = executeRequest", context)
  return { execute: context.exports.executeRequest, timers, signal: () => signal }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
for (const [bodyKind, status] of [['json', 200], ['blob', 200], ['text', 500]]) {
  test(`deadline remains active while ${bodyKind} body stalls`, async () => {
    const h = harness(bodyKind, status)
    const pending = h.execute('/api/test', { method: 'POST', isBlob: bodyKind === 'blob' })
    const rejected = assert.rejects(pending, error => error.status === 408)
    await flush()
    assert.equal(h.timers.size, 1, 'headers must not clear the deadline')
    h.timers.values().next().value()
    await flush()
    await rejected
    assert.equal(h.signal().aborted, true)
  })
}

test('independent loads publish early and continue after a failed section, with bounded concurrency', async () => {
  const context = { exports: {} }
  vm.runInNewContext(compile(fs.readFileSync(new URL('../src/independentLoads.ts', import.meta.url), 'utf8')), context)
  let release
  const events = []
  const pending = context.exports.runIndependentLoads([
    async () => { events.push('slow-start'); await new Promise(resolve => { release = resolve }); events.push('slow-end') },
    async () => { events.push('failed'); throw new Error('Unavailable') },
    async () => { events.push('summary-ready') },
    async () => { events.push('activity-ready') },
  ])
  await flush()
  assert.deepEqual(events, ['slow-start', 'failed', 'summary-ready', 'activity-ready'])
  release()
  await pending
  assert.equal(events.at(-1), 'slow-end')
})
