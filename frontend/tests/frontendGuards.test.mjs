import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

const { approvalDirectoryRequest } = await loadTypeScriptModule('../src/approvalStage.ts')
const { internalNavigationPath, requestTarget } = await loadTypeScriptModule('../src/requestNavigation.ts')
const { isWorkspaceSelectionStorageChange, selectedWorkspaceStorageId } = await loadTypeScriptModule('../src/workspaceTransition.ts')
const { fetchAllPages, paginatedPath } = await loadTypeScriptModule('../src/pagination.ts')
const { createLatestRequestGate } = await loadTypeScriptModule('../src/latestRequest.ts')
const { isKeyboardActivationKey } = await loadTypeScriptModule('../src/keyboard.ts')
const { shouldActivateTableRow } = await loadTypeScriptModule('../src/tableInteraction.ts')
const { boundedRetryDelay } = await loadTypeScriptModule('../src/retryPolicy.ts')
const { isActivityReadOnly } = await loadTypeScriptModule('../src/activityAccess.ts')

test('testcase approver badges use the record-specific eligibility endpoint', () => {
  const stageOne = approvalDirectoryRequest({
    status: 'Recommendation Pending',
    context: { origin_workspace_id: 17 },
    fallbackWorkspaceId: 99,
    testCaseId: 42,
  })
  assert.equal(stageOne.path, '/api/test-projects/eligible-users?roles=QA_ENGINEER&test_case_id=42')
  assert.doesNotMatch(stageOne.path, /workspace_id=/)

  const stageTwo = approvalDirectoryRequest({
    status: 'QA Lead Approval Pending',
    context: { origin_workspace_id: 17 },
    fallbackWorkspaceId: 99,
    testCaseId: 42,
  })
  assert.deepEqual(stageTwo.roles, ['QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA'])
  assert.match(stageTwo.path, /roles=QA_LEAD%2CCHIEF_MANAGER_QA%2CAGM_QA/)
})

test('generic approver badges prefer record workspace, including origin workspace', () => {
  const directory = approvalDirectoryRequest({
    status: 'Recommendation Pending',
    context: { origin_workspace_id: 17 },
    fallbackWorkspaceId: 99,
  })
  assert.match(directory.path, /^\/api\/auth\/user-options\?/)
  assert.match(directory.path, /workspace_id=17/)
})

test('navigation normalization accepts canonical portal paths only', () => {
  assert.equal(
    internalNavigationPath('/test-execution?project=7&cycle=9#result'),
    '/test-execution?project=7&cycle=9#result',
  )
  for (const unsafe of [
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example/steal',
    '/%2f%2fevil.example/steal',
    '/%5c%5cevil.example/steal',
    '/safe\nunsafe',
    'relative/path',
  ]) {
    assert.equal(internalNavigationPath(unsafe), null, unsafe)
    assert.equal(requestTarget(unsafe), null, unsafe)
  }
})

test('workspace storage changes are detected without reacting to unrelated or duplicate writes', () => {
  assert.equal(isWorkspaceSelectionStorageChange({ key: 'active_workspace_id', oldValue: '1', newValue: '2' }), true)
  assert.equal(isWorkspaceSelectionStorageChange({ key: 'qa_active_workspace_id', oldValue: '1', newValue: null }), true)
  assert.equal(isWorkspaceSelectionStorageChange({ key: 'active_workspace_id', oldValue: '2', newValue: '2' }), false)
  assert.equal(isWorkspaceSelectionStorageChange({ key: 'qa_session_logout', oldValue: null, newValue: '1' }), false)
})

test('every transport can resolve the same canonical workspace header', () => {
  const values = new Map([['active_workspace_id', '12'], ['qa_active_workspace_id', '4']])
  const storage = { getItem: (key) => values.get(key) || null }
  assert.equal(selectedWorkspaceStorageId(storage), '12')
  values.delete('active_workspace_id')
  assert.equal(selectedWorkspaceStorageId(storage), '4')
})

test('exhaustive picker pagination preserves repeated filters and reads every page', async () => {
  assert.equal(
    paginatedPath('/api/items?status=A&status=B&page=9&page_size=5', 2),
    '/api/items?status=A&status=B&page=2&page_size=100',
  )
  const requested = []
  const items = await fetchAllPages(async (path) => {
    requested.push(path)
    const page = requested.length
    return { items: [page], page, total_pages: 3, has_next: page < 3 }
  }, '/api/items?include_inactive=true')
  assert.deepEqual(items, [1, 2, 3])
  assert.deepEqual(requested, [
    '/api/items?include_inactive=true&page=1&page_size=100',
    '/api/items?include_inactive=true&page=2&page_size=100',
    '/api/items?include_inactive=true&page=3&page_size=100',
  ])
})

test('latest-request gate rejects completions from superseded detail loads', () => {
  const gate = createLatestRequestGate()
  const first = gate.begin()
  const second = gate.begin()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
  gate.invalidate()
  assert.equal(gate.isCurrent(second), false)
})

test('keyboard activation and retry policies cover accessible controls and transient failures', () => {
  assert.equal(isKeyboardActivationKey('Enter'), true)
  assert.equal(isKeyboardActivationKey(' '), true)
  assert.equal(isKeyboardActivationKey('Escape'), false)
  assert.deepEqual([0, 1, 2, 10].map((attempt) => boundedRetryDelay(attempt)), [1_000, 2_000, 4_000, 30_000])
})

test('clickable table rows ignore only nested interactive controls', () => {
  const row = { kind: 'row' }
  const nestedButton = { kind: 'button' }
  const nestedLink = { kind: 'link' }

  assert.equal(shouldActivateTableRow({ closest: () => row }, row), true, 'plain cell content resolves to the row itself')
  assert.equal(shouldActivateTableRow({ closest: () => null }, row), true, 'row background has no closer control')
  assert.equal(shouldActivateTableRow({ closest: () => nestedButton }, row), false, 'button handles its own click')
  assert.equal(shouldActivateTableRow({ closest: () => nestedLink }, row), false, 'link handles its own click')
})

test('activity comments are writable only in the record owning workspace', () => {
  assert.equal(isActivityReadOnly(false, 7, 7), false)
  assert.equal(isActivityReadOnly(false, 8, 7), true)
  assert.equal(isActivityReadOnly(false, null, 7), true)
  assert.equal(isActivityReadOnly(true, 7, 7), true)
  assert.equal(isActivityReadOnly(false, 7, null), false, 'legacy records without ownership keep existing behavior')
})

test('test repository and execution activity pass both server writability and workspace ownership', async () => {
  const repository = await readFile(new URL('../src/modules/test-management/TestRepository.tsx', import.meta.url), 'utf8')
  const execution = await readFile(new URL('../src/modules/test-management/TestExecution.tsx', import.meta.url), 'utf8')
  assert.match(repository, /readOnly=\{!existing\.workspace_writable\}/)
  assert.match(repository, /ownerWorkspaceId=\{existing\.origin_workspace_id \|\| currentProject\.qa_workspace_id\}/)
  assert.match(execution, /readOnly=\{!selectedCycle\?\.workspace_writable\}/)
  assert.match(execution, /ownerWorkspaceId=\{selectedCycle\?\.origin_workspace_id \|\| selectedProject\?\.qa_workspace_id\}/)
})

test('not-a-defect is proposed to an independent QA reviewer before becoming terminal', async () => {
  const legacy = await readFile(new URL('../src/modules/test-management/Defects.tsx', import.meta.url), 'utf8')
  const modern = await readFile(new URL('../src/components/DefectWorkflowPanel.tsx', import.meta.url), 'utf8')

  assert.match(legacy, /'In Progress': \['Resolved', 'Rejected', 'Duplicate', 'Not a Defect Review', 'Deferred'\]/)
  assert.match(legacy, /'Not a Defect Review': \['Not a Defect', 'Change Request Raised', 'Reopened'\]/)
  assert.match(legacy, /Documentation Updated/)
  assert.match(legacy, /Change Request \/ enhancement reference/)
  assert.match(legacy, /QA reviewer \*/)
  assert.match(modern, /target === 'Not a Defect Review'.*return resolver/)
  assert.match(modern, /target === 'Not a Defect'.*manager \|\| qa/)
  assert.match(modern, /target === 'Change Request Raised'.*manager \|\| qa/)
  assert.match(modern, /target === 'Reopened'.*Not a Defect Review.*manager \|\| qa/)
})

test('privileged configuration routes are wrapped in the AdminOnly guard', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  for (const path of ['/admin', '/checklist-config', '/request-type-config']) {
    const route = app.split('\n').find((line) => line.includes(`path="${path}"`))
    assert.match(route || '', /<AdminOnly>/, path)
  }
})
