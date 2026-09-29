interface RecycleCase {
  status: string
  current_approved_version_id?: number | null
  current_draft_author_id?: number | null
  checked_out_by_id?: number | null
  workspace_writable?: boolean
  is_deleted?: boolean
}

export function hasApprovedTestCaseHistory(testCase: RecycleCase): boolean {
  return !!testCase.current_approved_version_id || ['Approved', 'Archived'].includes(testCase.status)
}

export function requiresTestCaseArchive(testCase: RecycleCase): boolean {
  return testCase.status !== 'Rejected' && hasApprovedTestCaseHistory(testCase)
}

// Author-role and active-project checks remain with the action's caller.
export function canRecycleTestCase(testCase: RecycleCase, userId?: number, isAdmin = false): boolean {
  return !!testCase.workspace_writable && !testCase.is_deleted && !requiresTestCaseArchive(testCase)
    && (!testCase.checked_out_by_id || testCase.checked_out_by_id === userId || isAdmin)
    && (!['Returned', 'Returned by QA', 'Returned by QA Lead'].includes(testCase.status)
      || testCase.current_draft_author_id === userId)
}

export function canPurgeTestCase(testCase: RecycleCase): boolean {
  return !!testCase.workspace_writable && !!testCase.is_deleted
    && !hasApprovedTestCaseHistory(testCase) && testCase.status !== 'Rejected'
}
