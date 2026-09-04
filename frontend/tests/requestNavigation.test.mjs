import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/requestNavigation.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
})
const { RequestLookupError, requestRoutes, requestTarget, resolveRequestId } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

test('every request module opens the selected database ID without querying a list', async () => {
  for (const path of Object.keys(requestRoutes)) {
    const target = requestTarget(`${path}?open=OLD-DISPLAY-ID&openId=237&fromPending=1`)
    assert.deepEqual(target, { path, identifier: '237' })
    assert.equal(await resolveRequestId(target, () => assert.fail('Should fetch the record directly')), 237)
  }
})

test('numeric open links used by defects and assignments resolve directly', async () => {
  const target = requestTarget('/qa-requests?open=172')
  assert.equal(await resolveRequestId(target, () => assert.fail('Should not load the module list')), 172)
})

test('request navigation leaves module, search, creation and other entity links alone', () => {
  for (const link of ['/sast', '/qa-requests?search=APP', '/qa-requests?cr_number=CR-100',
    '/suppression?new=1&scan_type=SAST&request_id=7', '/defects?open=BUG-7',
    '/test-execution?cycle=7', 'https://elsewhere.invalid/sast?open=7', '//elsewhere.invalid/sast?open=7',
    '/toString?open=7']) {
    assert.equal(requestTarget(link), null, link)
  }
})

test('business-ID lookup finds the exact record beyond the first page', async () => {
  const calls = []
  const id = await resolveRequestId(requestTarget('/functional-requests?open=FQA-12'), async (url) => {
    calls.push(url)
    return calls.length === 1
      ? { items: [{ id: 120, request_id: 'FQA-120' }], has_next: true }
      : { items: [{ id: 12, request_id: 'FQA-12' }], has_next: false }
  })
  assert.equal(id, 12)
  assert.equal(calls.length, 2)
  assert.match(calls[0], /search=FQA-12/)
  assert.match(calls[1], /page=2$/)
})

test('suppression and signoff links use their own business identifiers', async () => {
  assert.equal(await resolveRequestId(requestTarget('/suppression?open=SUP-4'), async () => [
    { id: 1, suppression_id: 'SUP-40' }, { id: 4, suppression_id: 'SUP-4' },
  ]), 4)
  assert.equal(await resolveRequestId(requestTarget('/signoff?open=cert-7'), async () => [
    { id: 7, certificate_id: 'CERT-7' },
  ]), 7)
})

test('missing or inaccessible requests report an error instead of opening a different request', async () => {
  await assert.rejects(resolveRequestId(requestTarget('/sast?open=SAST-12'), async () => ({
    items: [{ id: 120, request_id: 'SAST-120' }], has_next: false,
  })), (error) => error instanceof RequestLookupError && error.identifier === 'SAST-12')
  const denied = new Error('Access denied')
  await assert.rejects(resolveRequestId(requestTarget('/dast?open=DAST-1'), async () => { throw denied }), (error) => error === denied)
})
