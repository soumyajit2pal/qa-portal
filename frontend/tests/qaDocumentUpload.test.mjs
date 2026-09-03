import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/qaDocumentUpload.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
})
const { QA_DOCUMENT_MAX_BYTES, qaDocumentSizeError, isQaEvidenceUpload } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

test('accepts multiple files at the 10 MB boundary independently', () => {
  assert.equal(qaDocumentSizeError([
    { name: 'a.pdf', size: QA_DOCUMENT_MAX_BYTES },
    { name: 'b.pdf', size: QA_DOCUMENT_MAX_BYTES },
  ]), null)
})

test('rejects a mixed batch containing a file one byte over 10 MB', () => {
  assert.match(qaDocumentSizeError([
    { name: 'valid.pdf', size: 100 },
    { name: 'oversized.pdf', size: QA_DOCUMENT_MAX_BYTES + 1 },
  ]), /"oversized.pdf" exceeds the 10 MB limit/)
})

test('applies only to QA Request checklist evidence', () => {
  assert.equal(isQaEvidenceUpload('/api/qa-requests/42/checklist-evidence/functional/0/documents'), true)
  assert.equal(isQaEvidenceUpload('/api/qa-requests/42/documents'), false)
  assert.equal(isQaEvidenceUpload('/api/document-portal/upload'), false)
  assert.equal(isQaEvidenceUpload('/api/sast-requests/42/documents'), false)
})
