import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants, webcrypto } from 'node:crypto'
import test from 'node:test'
import ts from 'typescript'

const { outputText } = ts.transpileModule(await readFile(new URL('../src/loginEncryption.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
})
const { encryptLogin } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
globalThis.window = { crypto: webcrypto }
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })
const key = { algorithm: 'RSA-OAEP-256+A256GCM', key_id: 'a'.repeat(64),
  public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), challenge: 'signed-challenge', expires_in: 120 }

test('browser encryption decrypts using RSA-OAEP SHA-256 and authenticated AES-GCM', async () => {
  const value = await encryptLogin(key, 'requester', 'test-password')
  assert.doesNotMatch(JSON.stringify(value), /requester|test-password/)
  const aes = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(value.wrapped_key, 'base64'))
  const cipher = Buffer.from(value.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', aes, Buffer.from(value.iv, 'base64'))
  decipher.setAAD(Buffer.from(value.challenge)); decipher.setAuthTag(cipher.subarray(-16))
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()])
  assert.deepEqual(JSON.parse(plain), { username: 'requester', password: 'test-password' })
})

test('fresh random keys and IVs produce different ciphertext for repeated credentials', async () => {
  const first = await encryptLogin(key, 'requester', 'test-password')
  const second = await encryptLogin(key, 'requester', 'test-password')
  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ciphertext, second.ciphertext)
  assert.notEqual(first.wrapped_key, second.wrapped_key)
})

async function moduleUrl(path) {
  const { outputText } = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  })
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
}
const encryptionUrl = await moduleUrl('../src/loginEncryption.ts')
const uploadUrl = await moduleUrl('../src/qaDocumentUpload.ts')
let apiSource = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')
apiSource = apiSource.replace("'./loginEncryption'", JSON.stringify(encryptionUrl))
  .replace("'./qaDocumentUpload'", JSON.stringify(uploadUrl))
  .replaceAll('import.meta.env', '({ PROD: true, VITE_API_BASE_URL: "" })')
const apiCode = ts.transpileModule(apiSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText
const { api } = await import(`data:text/javascript;base64,${Buffer.from(apiCode).toString('base64')}`)
globalThis.sessionStorage = { getItem: () => null }
globalThis.localStorage = { getItem: () => null }
Object.assign(window, { setTimeout, clearTimeout, location: { protocol: 'https:' } })

function decrypt(value) {
  const aes = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(value.wrapped_key, 'base64'))
  const cipher = Buffer.from(value.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', aes, Buffer.from(value.iv, 'base64'))
  decipher.setAAD(Buffer.from(value.challenge)); decipher.setAuthTag(cipher.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]))
}

test('create and reset requests contain only encrypted passwords and get independent challenges', async () => {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options })
    return Response.json(url.endsWith('/login-key') ? key : { id: 123 })
  }
  await Promise.all([
    api.createUser({ username: 'test1', full_name: 'Test', roles: ['QA_ENGINEER'], login_type: 'STANDARD', password: 'valid-password' }),
    api.resetUserPassword(123, 'changed-password'),
  ])
  assert.equal(calls.filter(c => c.url.endsWith('/login-key')).length, 2)
  const mutations = calls.filter(c => c.method === 'POST')
  assert.equal(mutations.length, 2)
  for (const call of mutations) {
    assert.doesNotMatch(call.body, /valid-password|changed-password|"password":|"new_password":/)
    const payload = JSON.parse(call.body)
    const create = call.url === '/api/auth/users'
    assert.deepEqual(decrypt(payload.encrypted_password), {
      username: create ? 'create-user:test1' : 'reset-password:123',
      password: create ? 'valid-password' : 'changed-password',
    })
  }
})

test('LDAP creation omits passwords and does not fetch encryption material', async () => {
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return Response.json({ id: 123 }) }
  await api.createUser({ username: 'ldap1', login_type: 'LDAP', password: 'discard-this-password' })
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].body), { username: 'ldap1', login_type: 'LDAP' })
})

test('unavailable browser encryption never falls back to sending plaintext', async () => {
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return Response.json(key) }
  window.crypto = undefined
  try {
    await assert.rejects(api.createUser({ username: 'test1', login_type: 'STANDARD', password: 'valid-password' }), /encryption is unavailable/)
    assert.equal(calls.filter(c => c.method === 'POST').length, 0)
  } finally { window.crypto = webcrypto }
})
