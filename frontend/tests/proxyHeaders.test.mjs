import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
const source = readFileSync(new URL('../proxyHeaders.ts', import.meta.url), 'utf8')
const context = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context)
function headers(remoteAddress, encrypted = false) {
  const values = new Map([['Forwarded', 'for=spoofed'], ['X-Forwarded-For', '1.2.3.4'], ['X-Real-IP', '1.2.3.4']])
  context.exports.setClientProxyHeaders({ removeHeader: key => values.delete(key), setHeader: (key, value) => values.set(key, value) }, { socket: { remoteAddress, encrypted } })
  return values
}
test('forwards the socket client and replaces forged headers', () => {
  const result = headers('192.168.10.25', true)
  assert.equal(result.get('X-Forwarded-For'), '192.168.10.25')
  assert.equal(result.get('X-Real-IP'), '192.168.10.25')
  assert.equal(result.get('X-Forwarded-Proto'), 'https')
  assert.equal(result.has('Forwarded'), false)
})
test('normalizes mapped IPv4 and preserves IPv6', () => {
  assert.equal(headers('::ffff:192.168.10.25').get('X-Real-IP'), '192.168.10.25')
  assert.equal(headers('2001:db8::12').get('X-Real-IP'), '2001:db8::12')
  assert.equal(headers('127.0.0.1').get('X-Real-IP'), '127.0.0.1')
})
test('missing socket information never falls back to spoofed input', () => {
  const result = headers(undefined)
  assert.equal(result.has('X-Forwarded-For'), false)
  assert.equal(result.has('X-Real-IP'), false)
})
