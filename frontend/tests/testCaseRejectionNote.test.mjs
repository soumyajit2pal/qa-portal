import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const source = await readFile(new URL('../src/testCaseRejectionNote.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
})
const { testCaseRejectionNote } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

test('QA rejection names the reviewer and QA stage', () => {
  assert.match(testCaseRejectionNote({ current_draft_reviewed_by_id: 2, current_draft_reviewed_by_name: 'qa2' }), /^Rejected by qa2 \(QA\)/)
})
test('QA Lead rejection uses the final decision actor rather than the recommender', () => {
  assert.match(testCaseRejectionNote({
    current_draft_reviewed_by_id: 2, current_draft_reviewed_by_name: 'qa2',
    current_draft_qa_lead_decided_by_id: 3, current_draft_qa_lead_decided_by_name: 'lead1',
  }), /^Rejected by lead1 \(QA Lead\)/)
})
test('missing decision data does not invent an actor or stage', () => {
  assert.equal(testCaseRejectionNote({}), 'Rejected -- clone to create a new Draft test case.')
  assert.match(testCaseRejectionNote({ current_draft_qa_lead_decided_by_id: 3 }), /^Rejected by QA Lead --/)
})
