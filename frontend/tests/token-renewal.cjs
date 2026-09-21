const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

const workspaceContext = {
  exports: {},
  Date,
  JSON,
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  window: { dispatchEvent: () => {} },
  CustomEvent: class {},
}
vm.runInNewContext(
  compile(fs.readFileSync(path.join(__dirname, '..', 'src', 'workspaceTransition.ts'), 'utf8')),
  workspaceContext,
)

const apiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.ts'), 'utf8')
  // Imported helpers relevant to this harness are injected below. Other
  // helpers are not executed by the session request under test.
  .replace(/^import .*$/gm, '')
  .replace(/import\.meta\.env\.VITE_API_BASE_URL/g, "''")
  .replace(/import\.meta\.env\.PROD/g, 'false')
const apiCode = compile(apiSource)

function storage(initial = {}) {
  const values = new Map(Object.entries(initial))
  const removed = []
  const written = []
  return {
    values,
    removed,
    written,
    getItem(key) { return values.get(key) ?? null },
    removeItem(key) { removed.push(key); values.delete(key) },
    setItem(key, value) { written.push([key, value]); values.set(key, value) },
  }
}

function harness({ activeWorkspace = '' } = {}) {
  const localStorage = storage({
    qa_portal_token: 'legacy-local-token',
    ...(activeWorkspace ? { active_workspace_id: activeWorkspace } : {}),
  })
  const sessionStorage = storage({ qa_portal_token: 'legacy-session-token' })
  const calls = []
  const context = {
    exports: {},
    console,
    AbortController,
    DOMException,
    document: { cookie: '__Host-QAP-CSRF=csrf-value' },
    sessionStorage,
    localStorage,
    isWorkspaceSelectionStorageChange: workspaceContext.exports.isWorkspaceSelectionStorageChange,
    selectedWorkspaceStorageId: workspaceContext.exports.selectedWorkspaceStorageId,
    window: {
      setTimeout,
      clearTimeout,
      addEventListener: () => {},
      dispatchEvent: () => {},
    },
    fetch: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        json: async () => ({ ok: true }),
      }
    },
  }
  vm.runInNewContext(apiCode, context)
  return { api: context.exports, calls, localStorage, sessionStorage }
}

test('cookie-session requests include CSRF and workspace scope without a bearer token', async () => {
  const { api, calls } = harness({ activeWorkspace: '27' })
  await api.api.post('/api/auth/logout')

  assert.equal(calls.length, 1)
  const [{ url, options }] = calls
  assert.equal(url, '/api/auth/logout')
  assert.equal(options.method, 'POST')
  assert.equal(options.credentials, 'include')
  assert.equal(options.headers['X-CSRF-Token'], 'csrf-value')
  assert.equal(options.headers['X-Workspace-ID'], '27')
  assert.equal(options.headers.Authorization, undefined)
})

test('legacy token compatibility code only removes browser-stored credentials', () => {
  const { api, localStorage, sessionStorage } = harness()

  assert.equal(localStorage.values.has('qa_portal_token'), false)
  assert.equal(sessionStorage.values.has('qa_portal_token'), false)
  localStorage.values.set('qa_portal_token', 'reintroduced-local-token')
  sessionStorage.values.set('qa_portal_token', 'reintroduced-session-token')

  api.setToken('ignored-legacy-token')

  assert.equal(localStorage.values.has('qa_portal_token'), false)
  assert.equal(sessionStorage.values.has('qa_portal_token'), false)
  assert.equal(localStorage.written.length, 0)
  assert.equal(sessionStorage.written.length, 0)
})
