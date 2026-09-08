const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync('src/api.ts', 'utf8')
  .replace(/^import .*qaDocumentUpload.*$/m, '')
  .replace(/import\.meta\.env\.VITE_API_BASE_URL/g, "''")
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function harness() {
  let now = 1_800_000_000_000
  const storage = new Map(), listeners = new Map(), intervals = []
  const calls = [], pending = []
  const context = {
    exports: {}, console, AbortController, DOMException, Event, atob,
    Date: class extends Date { static now() { return now } },
    sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    localStorage: { removeItem() {} },
    document: { visibilityState: 'visible' },
    window: {
      setTimeout: () => 1, clearTimeout() {},
      setInterval: fn => { intervals.push(fn); return 1 }, clearInterval() {},
      addEventListener: (name,fn) => listeners.set(name,fn), removeEventListener: name => listeners.delete(name),
      dispatchEvent: event => listeners.get(event.type)?.(event),
    },
    fetch: (...args) => { calls.push(args); return new Promise(resolve => pending.push(resolve)) },
  }
  vm.runInNewContext(code, context)
  const token = (seconds, suffix='') => 'header.' + Buffer.from(JSON.stringify({iat: now/1000-30, exp: now/1000+seconds})).toString('base64url') + '.sig' + suffix
  return { api: context.exports, calls, pending, intervals, token, advance: ms => { now += ms }, stored: () => storage.get('qa_portal_token') }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
;(async () => {
  const h = harness(), old = h.token(10)
  h.api.setToken(old)
  const stop = h.api.startTokenRenewal()
  h.intervals[0](); h.intervals[0]()
  assert.equal(h.calls.length, 1, 'concurrent renewal must be single flight')
  const next = h.token(1800, 'new')
  h.pending.shift()({ok:true,status:200,json:async()=>({access_token:next})})
  await flush()
  assert.equal(h.stored(), next)
  stop()

  const logout = harness()
  logout.api.setToken(logout.token(10)); logout.api.startTokenRenewal()
  logout.api.setToken(null)
  logout.pending.shift()({ok:true,status:200,json:async()=>({access_token:'late'})})
  await flush()
  assert.equal(logout.stored(), undefined, 'late renewal must not undo logout')

  const idle = harness()
  idle.api.setToken(idle.token(90)); idle.api.startTokenRenewal()
  idle.advance(85_000); idle.intervals[0]()
  assert.equal(idle.calls.length, 0, 'timer must not renew an idle session')

  const outage = harness(), original = outage.token(10)
  outage.api.setToken(original); outage.api.startTokenRenewal()
  outage.pending.shift()({ok:false,status:503})
  await flush()
  assert.equal(outage.stored(), original, 'transient outage must preserve credentials')
  console.log('4 token renewal browser scenarios passed')
})().catch(error => { console.error(error); process.exitCode=1 })
