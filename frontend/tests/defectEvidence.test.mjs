import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const source = await readFile(new URL('../src/defectEvidence.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
})
const { defectEvidenceError, DEFECT_EVIDENCE_EXTENSIONS } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

test('supported video formats are accepted', () => {
  const documents = [{ name: 'evidence.PDF', size: 100 }]
  assert.equal(defectEvidenceError([...documents, { name: 'recording.mp4', size: 100 }]), null)
  assert.equal(defectEvidenceError([{ name: 'recording.mov', size: 100 }, { name: 'recording.webm', size: 100 }, { name: 'recording.avi', size: 100 }]), null)
  assert.match(defectEvidenceError([{ name: 'recording.mkv', size: 100 }]), /not an allowed/)
})
test('file size and batch limits match the server limits', () => {
  assert.equal(defectEvidenceError([{ name: 'log.txt', size: 25 * 1024 * 1024 }]), null)
  assert.match(defectEvidenceError([{ name: 'log.txt', size: 25 * 1024 * 1024 + 1 }]), /25 MB/)
  assert.match(defectEvidenceError(Array(21).fill({ name: 'log.txt', size: 1 })), /20/)
})
test('allowed extensions stay aligned with the backend policy', async () => {
  const server = await readFile(new URL('../../backend/app/upload_limits.py', import.meta.url), 'utf8')
  const block = server.match(/ALLOWED_DOCUMENT_EXTENSIONS = \{([^}]+)\}/)[1]
  const extensions = [...block.matchAll(/"(\.[a-z0-9]+)"/g)].map(match => match[1])
  assert.deepEqual([...DEFECT_EVIDENCE_EXTENSIONS].sort(), extensions.sort())
})
