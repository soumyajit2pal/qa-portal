import type { TestCaseOut } from './types'

export function testCaseRejectionNote(record: Pick<TestCaseOut,
  'current_draft_reviewed_by_id' | 'current_draft_reviewed_by_name'
  | 'current_draft_qa_lead_decided_by_id' | 'current_draft_qa_lead_decided_by_name'
>): string {
  const leadDecision = record.current_draft_qa_lead_decided_by_id != null
  const stage = leadDecision ? 'QA Lead' : record.current_draft_reviewed_by_id != null ? 'QA' : null
  const name = leadDecision
    ? record.current_draft_qa_lead_decided_by_name
    : record.current_draft_reviewed_by_name
  const actor = name ? `${name}${stage ? ` (${stage})` : ''}` : stage
  return `Rejected${actor ? ` by ${actor}` : ''} -- clone to create a new Draft test case.`
}
