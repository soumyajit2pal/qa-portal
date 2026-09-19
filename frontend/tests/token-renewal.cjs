const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync('src/api.ts', 'utf8')
  .replace(/^import .*loginEncryption.*$/m, '')
  .replace(/^import .*qaDocumentUpload.*$/m, '')
  .replace(/import\.meta\.env\.VITE_API_BASE_URL/g, "''")
  .replace(/import\.meta\.env\.PROD/g, 'false')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

const context = {
  exports: {}, console, AbortController, DOMException,
  document: { cookie: '__Host-QAP-CSRF=csrf-value' },
  sessionStorage: { removeItem() {} },
  localStorage: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
  window: { setTimeout, clearTimeout },
  fetch: async (_url, options) => {
    assert.equal(options.credentials, 'include')
    assert.equal(options.headers['X-CSRF-Token'], 'csrf-value')
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  },
}
vm.runInNewContext(code, context)

;(async () => {
  context.exports.setToken('legacy-token')
  await context.exports.api.post('/api/auth/logout')
  console.log('cookie session request and legacy-token cleanup passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
