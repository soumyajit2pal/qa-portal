import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import {
  hasRole, TEST_CASE_TYPES, TEST_CASE_STATUSES, TEST_CASE_STATUS_LABELS, TEST_CASE_PENDING_WITH, TEST_CASE_PRIORITIES,
  TEST_CASE_PENDING_DECISION_STATUSES, TEST_CASE_TERMINAL_STATUSES, TEST_CASE_REVIEW_ACTION_LABELS,
  TEST_CASE_REVIEW_MANDATORY_COMMENT_DECISIONS,
} from '../../constants'
import {
  TestProjectOut, TestFolderOut, TestCaseOut, TestStepIn, TestCaseImportResult, ApprovalActionOut,
  TestCaseVersionSummary, TestCaseVersionCompareOut, TestProjectMyAccessOut, TestCaseVersionOut,
  TestCaseReviewDecision, TestCaseReassignApproversIn, TestCaseBulkRecommendIn, UserOut,
} from '../../types'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import ClearableSearchInput from '../../components/ClearableSearchInput'
import LinkedDefects from '../../components/LinkedDefects'

// Test Repository module -- folder tree + test case authoring/import, under
// a selected Test Project. QA Engineer + QA Lead both author (create/edit/
// import/delete); everyone with portal access can browse/read (Admin
// bypasses the author gate automatically via hasRole).
const CAN_AUTHOR_ROLES = ['QA_ENGINEER', 'QA_LEAD', 'CHEIF_MANAGER_QA']
const UNFILED = '__unfiled__'

function emptyStep(stepNo: number): TestStepIn {
  return { step_no: stepNo, step_text: '', expected_result: '' }
}

// Reported directly: "showing Workflow Status Draft, Unavailable until QA
// Lead approval, neither QA lead able to approve" -- the old note only ever
// checked current_approved_version_id, so a brand-new Draft that had NEVER
// been submitted (submit_test_case never called -- see
// routers/test_repository.py::submit_test_case) showed the exact same
// "Unavailable until QA Lead approval" text as one already sitting In
// Review, which reads as "already sent, just waiting" when it actually
// still needs the Author to submit it first (review_test_case correctly
// 400s with "no version currently pending review" until that happens).
// This reflects the case's real status instead of only whether it has ever
// had an approved baseline.
function workflowStatusNote(existing: TestCaseOut | null): string {
  if (!existing) return 'New test cases start in Draft, editable immediately after creation.'
  switch (existing.status) {
    case 'In Review':
      return 'Submitted -- awaiting Reviewer recommendation.'
    case 'Review Completed':
      return "Recommended by Reviewer -- awaiting QA Lead's final decision."
    case 'Returned':
      return 'Returned for correction -- edit and resubmit for review.'
    case 'Rejected':
      return 'Rejected by QA Lead -- edit to start a new draft revision.'
    case 'Approved':
      return 'Approved -- selectable for Test Cycles.'
    case 'Archived':
      return 'Archived -- retained for history, unavailable for new Test Cycles.'
    default: // Draft
      return existing.current_approved_version_id
        ? 'A new Draft revision is in progress; the earlier Approved version stays selectable for Test Cycles.'
        : 'Not yet submitted -- select Start editing, then Submit for review.'
  }
}

// Reported directly: "I selected parent folder as ABC, but sub folder
// created under another folder" -- every folder picker in this file (Parent
// Folder on New Folder, Target Folder on Excel import, Folder on test case
// create/edit and bulk-update) showed just each folder's own bare name, with
// no way to tell two same-named folders in different branches of the tree
// apart (nothing stops creating a folder with a name that already exists
// elsewhere in the project -- see backend routers/test_repository.py::
// create_folder, no uniqueness check). Picking the wrong "ABC" out of two
// identically-labeled options wasn't a bug in the select itself, just an
// inherently ambiguous list -- this builds each folder's full breadcrumb
// path instead (walking parent_id up to the root) so same-named folders in
// different places read as distinct options (e.g. "XYZ / ABC" vs "ABC").
function folderPathLabel(folders: TestFolderOut[], folder: TestFolderOut): string {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const parts: string[] = []
  const seen = new Set<number>()
  let current: TestFolderOut | undefined = folder
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    parts.unshift(current.name)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return parts.join(' / ')
}

interface FolderTreeNode {
  folder: TestFolderOut
  children: FolderTreeNode[]
}

// Reported directly, alongside the picker-ambiguity fix above: "created
// under TESTTTTT/NEWWWWW but showing under different folder, also expand
// and collapse not working." The sidebar tree used to be a single flat
// `folders.map(...)` -- every folder rendered in whatever order the API
// returned them (not grouped under its real parent at all), with only a
// binary 0px/16px indent regardless of true depth, and a "▸"/"└" glyph that
// was static text, not a button -- nothing ever actually expanded or
// collapsed. A sub-folder's row could end up visually far away from its
// real parent's row with nothing connecting them, which is exactly what
// reads as "created under X but showing under a different folder" even
// though parent_id was already correct all along. This builds a real
// parent -> children tree instead, rendered recursively (see
// FolderTreeRows below) so a folder's children always render directly
// beneath it, indented one step further per actual level of depth.
function buildFolderTree(folders: TestFolderOut[]): FolderTreeNode[] {
  const byId = new Map<number, FolderTreeNode>()
  folders.forEach((f) => byId.set(f.id, { folder: f, children: [] }))
  const roots: FolderTreeNode[] = []
  folders.forEach((f) => {
    const node = byId.get(f.id)!
    const parent = f.parent_id ? byId.get(f.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  })
  return roots
}

// Recursive sidebar rows -- one <li> per node, then (if not collapsed) its
// own children rendered one level deeper. `maxDepth` is just a defensive
// circuit-breaker against a hypothetical cyclic parent_id (nothing in the
// backend actually prevents one -- see create_folder -- though normal use
// could never produce one); ordinary trees are nowhere near this deep.
function FolderTreeRows({
  nodes, depth = 0, maxDepth = 40, selectedFolder, onSelect, folderCounts,
  collapsedFolders, onToggleCollapse, canAuthor, canDeleteFolder, projectIsActive,
  onDeleteRequest, onCopyRequest, onMoveRequest, onRenameRequest,
}: {
  nodes: FolderTreeNode[]
  depth?: number
  maxDepth?: number
  selectedFolder: number | typeof UNFILED | ''
  onSelect: (id: number) => void
  folderCounts: Record<number, number>
  collapsedFolders: Set<number>
  onToggleCollapse: (id: number) => void
  canAuthor: boolean
  canDeleteFolder: boolean
  projectIsActive: boolean
  onDeleteRequest: (f: TestFolderOut) => void
  onCopyRequest: (f: TestFolderOut) => void
  onMoveRequest: (f: TestFolderOut) => void
  onRenameRequest: (f: TestFolderOut) => void
}) {
  if (depth > maxDepth) return null
  return (
    <>
      {nodes.map((node) => {
        const { folder: f, children } = node
        const hasChildren = children.length > 0
        const collapsed = collapsedFolders.has(f.id)
        return (
          // Each node's own row, immediately followed (same Fragment, not a
          // separate pass over the sibling list) by its own children --
          // that ordering is the actual fix: a sub-folder now always renders
          // directly beneath its real parent instead of wherever the flat
          // API response order happened to place it.
          <React.Fragment key={f.id}>
            <li style={{ paddingLeft: depth * 16 }}>
              <div className="tm-folder-row">
                {hasChildren ? (
                  <button
                    type="button"
                    className="tm-folder-toggle"
                    aria-label={collapsed ? `Expand ${f.name}` : `Collapse ${f.name}`}
                    aria-expanded={!collapsed}
                    onClick={() => onToggleCollapse(f.id)}
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                ) : (
                  <span className="tm-folder-toggle tm-folder-toggle-leaf">└</span>
                )}
                <button className={`link-btn ${selectedFolder === f.id ? 'active' : ''}`} onClick={() => onSelect(f.id)}>
                  <span className="tm-folder-identity"><strong>{f.name}</strong><small>Created by {f.created_by_name || 'Unknown user'}</small></span>
                  <em>{folderCounts[f.id] || 0}</em>
                </button>
                {(canAuthor || canDeleteFolder) && projectIsActive && (
                  <div className="tm-folder-actions">
                    {canAuthor && (
                      <button type="button" className="tm-folder-action" title="Rename folder" aria-label={`Rename ${f.name}`} onClick={() => onRenameRequest(f)}>✎</button>
                    )}
                    {canAuthor && (
                      <button type="button" className="tm-folder-action" title="Copy folder" aria-label={`Copy ${f.name}`} onClick={() => onCopyRequest(f)}>⧉</button>
                    )}
                    {canAuthor && (
                      <button type="button" className="tm-folder-action" title="Move folder" aria-label={`Move ${f.name}`} onClick={() => onMoveRequest(f)}>⇄</button>
                    )}
                    {canDeleteFolder && (
                      <button type="button" className="tm-folder-action tm-folder-delete" title={`Delete ${f.parent_id ? 'sub-folder' : 'folder'}`} aria-label={`Delete ${f.name}`} onClick={() => onDeleteRequest(f)}>×</button>
                    )}
                  </div>
                )}
              </div>
            </li>
            {hasChildren && !collapsed && (
              <FolderTreeRows
                nodes={children} depth={depth + 1} maxDepth={maxDepth}
                selectedFolder={selectedFolder} onSelect={onSelect} folderCounts={folderCounts}
                collapsedFolders={collapsedFolders} onToggleCollapse={onToggleCollapse}
                canAuthor={canAuthor} canDeleteFolder={canDeleteFolder} projectIsActive={projectIsActive}
                onDeleteRequest={onDeleteRequest} onCopyRequest={onCopyRequest} onMoveRequest={onMoveRequest}
                onRenameRequest={onRenameRequest}
              />
            )}
          </React.Fragment>
        )
      })}
    </>
  )
}

function NewFolderModal({ projectId, folders, onClose, onCreated }: {
  projectId: number
  folders: TestFolderOut[]
  onClose: () => void
  onCreated: (f: TestFolderOut) => void
}) {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Folder name cannot be blank')); return }
    setBusy(true); setError(null)
    try {
      const created = await api.post<TestFolderOut>(`/api/test-repository/projects/${projectId}/folders`, {
        name: name.trim(), parent_id: parentId || null,
      })
      onCreated(created)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Folder" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Parent Folder">
          {/* Searchable -- a project's folder tree only grows over time. */}
          <SearchableSelect
            value={parentId === '' ? '' : String(parentId)}
            onChange={(v) => setParentId(v ? Number(v) : '')}
            placeholder="-- Top level --"
            options={[
              { value: '', label: '-- Top level --' },
              ...folders.map((f) => ({ value: String(f.id), label: folderPathLabel(folders, f) })),
            ]}
          />
        </Field>
        <Field label="Folder Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating...' : 'Create Folder'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Reported directly: "Add functionality of copy the folder and move the
// folder." One modal handles both -- same destination picker either way,
// Copy just adds a required name field for the duplicate. Move's picker
// excludes the folder itself and every one of its own descendants (backend
// move_folder rejects those the same way, but filtering them out of the
// list here means the error never actually gets a chance to happen). Copy
// has no such exclusion: a copy always gets brand-new ids, so "copy into my
// own sub-folder" is a perfectly valid destination.
function FolderMoveCopyModal({ mode, folder, folders, onClose, onDone }: {
  mode: 'move' | 'copy'
  folder: TestFolderOut
  folders: TestFolderOut[]
  onClose: () => void
  onDone: () => void
}) {
  const [parentId, setParentId] = useState<number | ''>(mode === 'move' && folder.parent_id ? folder.parent_id : '')
  const [name, setName] = useState(`${folder.name} (Copy)`)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const excludedIds = useMemo(() => {
    if (mode === 'copy') return new Set<number>()
    const ids = new Set<number>([folder.id])
    let changed = true
    while (changed) {
      changed = false
      folders.forEach((f) => {
        if (f.parent_id != null && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); changed = true }
      })
    }
    return ids
  }, [mode, folder.id, folders])

  const destinationOptions = folders.filter((f) => !excludedIds.has(f.id))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (mode === 'copy' && !name.trim()) { setError(new Error('Folder name cannot be blank')); return }
    setBusy(true); setError(null)
    try {
      if (mode === 'move') {
        await api.post(`/api/test-repository/folders/${folder.id}/move`, { parent_id: parentId || null })
      } else {
        await api.post(`/api/test-repository/folders/${folder.id}/copy`, { parent_id: parentId || null, name: name.trim() })
      }
      onDone()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={mode === 'move' ? `Move "${folder.name}"` : `Copy "${folder.name}"`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Destination">
          <SearchableSelect
            value={parentId === '' ? '' : String(parentId)}
            onChange={(v) => setParentId(v ? Number(v) : '')}
            placeholder="-- Top level --"
            options={[
              { value: '', label: '-- Top level --' },
              ...destinationOptions.map((f) => ({ value: String(f.id), label: folderPathLabel(folders, f) })),
            ]}
          />
        </Field>
        {mode === 'copy' && (
          <Field label="New Folder Name *">
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        {mode === 'copy' && (
          <p className="muted small">
            Every test case inside -- and inside any sub-folders -- is duplicated as a new Draft,
            ready for the author to submit for Reviewer recommendation.
          </p>
        )}
        {mode === 'move' && (
          <p className="muted small">Everything already nested inside this folder moves along with it.</p>
        )}
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? (mode === 'move' ? 'Moving...' : 'Copying...') : (mode === 'move' ? 'Move folder' : 'Copy folder')}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Reported directly: "Once folder is created, folder details should be
// editable." A folder's only real "detail" is its name -- repositioning it
// in the tree already has its own dedicated Move action (see
// FolderMoveCopyModal above), so this stays a single-field rename rather
// than duplicating that picker here too.
function RenameFolderModal({ folder, onClose, onRenamed }: {
  folder: TestFolderOut
  onClose: () => void
  onRenamed: (f: TestFolderOut) => void
}) {
  const [name, setName] = useState(folder.name)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Folder name cannot be blank')); return }
    setBusy(true); setError(null)
    try {
      const updated = await api.patch<TestFolderOut>(`/api/test-repository/folders/${folder.id}`, { name: name.trim() })
      onRenamed(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Rename "${folder.name}"`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Folder Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function ImportModal({ projectId, folders, folderId, onClose, onImported }: {
  projectId: number
  folders: TestFolderOut[]
  folderId: number | ''
  onClose: () => void
  onImported: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [targetFolder, setTargetFolder] = useState<number | ''>(folderId)
  const [error, setError] = useState<unknown>(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)
  const [result, setResult] = useState<TestCaseImportResult | null>(null)
  // Same governed-progress pattern already used for Bulk Approve/Bulk Update
  // (this file) and Bulk Execute/Bulk Removal (TestExecution.tsx) -- reused
  // here rather than just a plain "Importing..." button label, since an
  // Excel import can take a few seconds for a large file and gives no
  // feedback otherwise. The backend import is one atomic request with no
  // real progress events of its own, so -- same as every other reuse of this
  // pattern -- the percentage/message below is a simulated approximation of
  // where the import likely is, not a literal server-reported progress
  // stream; it always completes for real once the response actually comes
  // back (see submit() below).
  const [stage, setStage] = useState<'form' | 'importing'>('form')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Uploading file…')

  async function downloadTemplate() {
    setDownloadingTemplate(true)
    try {
      await api.downloadFile('/api/test-repository/import-template', 'Test Case Import Template.xlsx')
    } catch (err) { setError(err) } finally { setDownloadingTemplate(false) }
  }

  const resultErrors = result?.errors || []
  const primaryFailureReason = result && result.created_test_cases === 0
    ? result.failure_reason || resultErrors[0] || (
      result.skipped_rows > 0
        ? `${result.skipped_rows} populated row${result.skipped_rows !== 1 ? 's were' : ' was'} skipped, but the server did not provide row-level diagnostics. Restart the backend service and import again to receive the exact Excel row and validation reason.`
        : 'No recognizable test-case data was found. Verify that the first worksheet uses the standard headers and that case data starts on row 2.'
    )
    : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { setError(new Error('Choose an .xlsx file first')); return }
    setError(null)
    setStage('importing')
    setProgress(8)
    setProgressMessage('Uploading file…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 60 ? 'Validating rows and creating test cases…' : 'Uploading file…')
        return next
      })
    }, 280)
    try {
      const res = await api.uploadForm<TestCaseImportResult>(
        `/api/test-repository/projects/${projectId}/import-xlsx`,
        { file, folder_id: targetFolder ? String(targetFolder) : undefined }
      )
      const remainingDisplayTime = Math.max(0, 600 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage('Import complete')
      setResult(res)
      onImported()
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('form')
    }
  }

  return (
    <Modal
      title={stage === 'importing' ? 'Importing test cases' : 'Import Test Cases from Excel'}
      onClose={onClose}
      preventBackdropClose={stage === 'importing'}
    >
      {!result ? (
        stage === 'importing' ? (
          <div className="tm-operation-state" aria-live="polite">
            <div className="tm-operation-icon">↻</div>
            <strong>{progressMessage}</strong>
            <div className="tm-progress-track" role="progressbar" aria-label="Excel import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
            <div className="tm-progress-meta"><span>Please keep this dialog open</span><strong>{progress}%</strong></div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="muted small">
              Use the standard "Test Cases - Template" xlsx format -- one row per test step,
              with Epic ID / Feature ID / Test Scenario / Priority etc. filled in only on each
              test case's first row. Imported definitions are saved as Draft; review them and
              explicitly submit them for review afterward. Execution-result columns are not added
              to a cycle until the testcase is approved.
            </p>
            <div className="info-banner">
              Only this exact template is supported for import.{' '}
              <button type="button" className="link-btn" style={{ display: 'inline', padding: 0 }} onClick={downloadTemplate} disabled={downloadingTemplate}>
                {downloadingTemplate ? 'Downloading…' : 'Download the template'}
              </button>
              {' '}before filling it in.
            </div>
            <Field label="Target Folder">
              <SearchableSelect
                value={targetFolder === '' ? '' : String(targetFolder)}
                onChange={(v) => setTargetFolder(v ? Number(v) : '')}
                placeholder="-- Unfiled --"
                options={[
                  { value: '', label: '-- Unfiled --' },
                  ...folders.map((f) => ({ value: String(f.id), label: folderPathLabel(folders, f) })),
                ]}
              />
            </Field>
            <Field label="Excel File (.xlsx) *">
              <input type="file" accept=".xlsx" required onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </Field>
            <ErrorText error={error} />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button className="btn btn-primary">Import</button>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
            </div>
          </form>
        )
      ) : (
        <div className="import-result">
          <div className={`import-result-summary ${resultErrors.length || result.skipped_rows || primaryFailureReason ? 'has-issues' : 'success'}`}>
            <strong>{primaryFailureReason ? 'Import failed' : resultErrors.length || result.skipped_rows ? 'Import completed with issues' : 'Import completed successfully'}</strong>
            <span>{result.created_test_cases} test case{result.created_test_cases !== 1 ? 's' : ''} created · {result.imported_executions} execution result{result.imported_executions !== 1 ? 's' : ''} imported</span>
          </div>
          {result.created_test_cases > 0 && (
            <div className="info-banner"><strong>Saved as Draft.</strong> Review the imported testcases, select them in the repository, then choose <b>Submit for review</b>. They will not enter the Reviewer queue until you submit them.</div>
          )}
          {primaryFailureReason && (
            <div className="import-primary-reason" role="alert">
              <strong>Reason</strong>
              <p>{primaryFailureReason}</p>
            </div>
          )}
          {result.skipped_rows > 0 && (
            <div className="import-issue-count"><strong>{result.skipped_rows}</strong><span>row{result.skipped_rows !== 1 ? 's were' : ' was'} skipped</span></div>
          )}
          {resultErrors.length > 0 && (
            <div className="import-issues" role="alert">
              <strong>{primaryFailureReason ? 'All detected issues' : 'Why some data was not imported'}</strong>
              <ul>{resultErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              <p>Correct the listed rows in Excel and import the file again. Successfully created test cases are not removed.</p>
            </div>
          )}
          <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 10 }}>Done</button>
        </div>
      )}
    </Modal>
  )
}

function StepsEditor({ steps, onChange }: { steps: TestStepIn[]; onChange: (s: TestStepIn[]) => void }) {
  function update(i: number, field: keyof TestStepIn, value: string) {
    const next = steps.slice()
    next[i] = { ...next[i], [field]: value }
    onChange(next)
  }
  function add() { onChange([...steps, emptyStep(steps.length + 1)]) }
  function remove(i: number) {
    const next = steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step_no: idx + 1 }))
    onChange(next)
  }
  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
          <span className="muted small" style={{ paddingTop: 8 }}>{i + 1}.</span>
          <textarea placeholder="Step" value={s.step_text || ''} onChange={(e) => update(i, 'step_text', e.target.value)} style={{ flex: 1 }} />
          <textarea placeholder="Expected Result" value={s.expected_result || ''} onChange={(e) => update(i, 'expected_result', e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" onClick={() => remove(i)}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={add}>+ Add Step</button>
    </div>
  )
}

// Spec section 9 -- every review decision's confirmation must state the
// RESULTING status and WHO owns it next, not just what button was clicked.
function reviewDecisionOutcome(decision: TestCaseReviewDecision): string {
  switch (decision) {
    case 'RECOMMEND':
      return "Moves to Review Completed, awaiting the QA Lead's final decision."
    case 'APPROVE':
      return 'The test case becomes Approved and is immediately available for Test Cycles.'
    case 'RETURN':
      return 'Returns to the Author as Returned -- they must edit and resubmit for review.'
    case 'REJECT':
      return 'Terminal: cannot be executed or added to a Ready cycle. The Author can start a fresh Draft from this content.'
    default:
      return ''
  }
}

// Stage-aware -- at "In Review" only RECOMMEND/RETURN are valid (Reviewer
// tier); at "Review Completed" only APPROVE/RETURN/REJECT are valid (QA Lead
// tier). The caller (the row/detail action buttons below) only ever offers
// the decision that's valid for the case's current status, but the server
// is still the real gate (400/403 on a mismatch).
function TestCaseReviewModal({ testCase, decision, users, defaultQaLeadId, onClose, onReviewed }: {
  testCase: TestCaseOut
  decision: TestCaseReviewDecision
  users: UserOut[]
  defaultQaLeadId?: number | null
  onClose: () => void
  onReviewed: (testCase: TestCaseOut) => void
}) {
  const { user } = useAuth()
  const qaLeadCandidates = useMemo(
    () => users.filter((candidate) => candidate.is_active
      && candidate.id !== testCase.current_draft_author_id
      && candidate.id !== user?.id
      && (candidate.roles.includes('QA_LEAD') || candidate.roles.includes('CHEIF_MANAGER_QA'))),
    [users, testCase.current_draft_author_id, user?.id],
  )
  const [qaLeadId, setQaLeadId] = useState<number | ''>(
    qaLeadCandidates.some((candidate) => candidate.id === defaultQaLeadId) ? defaultQaLeadId! : '',
  )
  const [comments, setComments] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const mandatoryComment = TEST_CASE_REVIEW_MANDATORY_COMMENT_DECISIONS.includes(decision)
  const label = TEST_CASE_REVIEW_ACTION_LABELS[decision] || decision
  const positive = decision === 'APPROVE' || decision === 'RECOMMEND'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (mandatoryComment && !comments.trim()) {
      setError(new Error(decision === 'REJECT'
        ? 'Explain why this test case is being rejected'
        : 'Explain what the Author must change before resubmitting'))
      return
    }
    setBusy(true); setError(null)
    try {
      const reviewed = await api.post<TestCaseOut>(`/api/test-repository/test-cases/${testCase.id}/review`, {
        decision,
        ...(decision === 'RECOMMEND' ? { assigned_qa_lead_id: qaLeadId } : {}),
        comments: comments.trim() || null,
      })
      onReviewed(reviewed)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`${label}?`} onClose={onClose} variant="dialog" preventBackdropClose>
      <form onSubmit={submit}>
        <div className="tm-review-summary">
          <strong>{testCase.test_case_key}</strong>
          <span>{testCase.test_scenario || 'No scenario provided'}</span>
        </div>
        <p><strong>Result:</strong> {reviewDecisionOutcome(decision)}</p>
        {decision === 'RECOMMEND' && (
          <Field label="QA Lead (Stage 2) *">
            <SearchableSelect
              value={qaLeadId === '' ? '' : String(qaLeadId)}
              onChange={(value) => setQaLeadId(value ? Number(value) : '')}
              placeholder="-- Select QA Lead --"
              options={qaLeadCandidates.map((candidate) => ({ value: String(candidate.id), label: candidate.full_name }))}
            />
          </Field>
        )}
        <Field label={mandatoryComment ? 'Reason and required changes *' : 'Comments (optional)'}>
          <textarea
            required={mandatoryComment}
            rows={4}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder={mandatoryComment ? 'Describe exactly what must be corrected…' : 'Add notes for the record…'}
          />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className={`btn ${positive ? 'btn-primary' : 'btn-danger'}`} disabled={busy || (decision === 'RECOMMEND' && !qaLeadId)}>
            {busy ? 'Saving decision…' : label}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function BulkApproveModal({ projectId, selectedIds, onClose, onApproved }: {
  projectId: number
  selectedIds: number[]
  onClose: () => void
  onApproved: (testCases: TestCaseOut[], approvedIds: number[]) => void
}) {
  const [approvalIds] = useState(selectedIds)
  const [comments, setComments] = useState('')
  const [stage, setStage] = useState<'confirm' | 'approving' | 'success' | 'error'>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)

  async function approve(e?: React.FormEvent) {
    e?.preventDefault()
    if (!comments.trim()) {
      setError(new Error('Enter one approval message for the selected testcases'))
      setStage('confirm')
      return
    }
    setError(null)
    setStage('approving')
    setProgress(10)
    setProgressMessage('Validating pending review status…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 60 ? 'Recording the QA Lead approval…' : 'Verifying selected testcases…')
        return next
      })
    }, 280)
    try {
      const approved = await api.post<TestCaseOut[]>(`/api/test-repository/projects/${projectId}/test-cases/bulk-approve`, {
        ids: approvalIds,
        comments: comments.trim(),
      })
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${approved.length} testcase${approved.length !== 1 ? 's' : ''} approved`)
      onApproved(approved, approvalIds)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'approving' ? 'Approving testcases'
    : stage === 'success' ? 'Bulk approval completed'
      : stage === 'error' ? 'Bulk approval failed'
        : `Approve ${approvalIds.length} pending testcase${approvalIds.length !== 1 ? 's' : ''}?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={approve}>
          <div className="tm-bulk-confirm-count"><strong>{approvalIds.length}</strong><span>pending testcase{approvalIds.length !== 1 ? 's' : ''} will be approved</span></div>
          <p>Confirm that the selected definitions and steps have been verified. They will become immediately available for Test Cycles.</p>
          <Field label="Single approval message *">
            <textarea required rows={4} value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Enter the QA Lead's verification and approval message…" />
          </Field>
          <p className="muted small">This one message will be signed by you and recorded in every selected testcase’s activity history.</p>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary">Verify and approve all</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'approving' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk approval progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Approval is being recorded atomically' : 'Approved testcases are now available for cycles'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was approved</strong>
          <p className="muted small">The bulk approval is atomic, so all selected testcases remain pending.</p>
          <div className="tm-operation-error"><strong>Reason</strong><p>{errorReason}</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => approve()}>Try again</button>
            <button className="btn" onClick={() => { setError(null); setStage('confirm') }}>Edit message</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// Stage 1 bulk counterpart to BulkApproveModal above -- Reviewer-tier,
// mirrors its confirm/progress/success/error shape almost exactly, but posts
// to bulk-recommend (only acts on "In Review" rows) and comments are
// optional (RECOMMEND isn't in TEST_CASE_REVIEW_MANDATORY_COMMENT_DECISIONS,
// unlike bulk-approve's own mandatory message).
function BulkRecommendModal({ project, selectedCases, users, onClose, onRecommended }: {
  project: TestProjectOut
  selectedCases: TestCaseOut[]
  users: UserOut[]
  onClose: () => void
  onRecommended: (testCases: TestCaseOut[], recommendedIds: number[]) => void
}) {
  const { user } = useAuth()
  const [recommendCases] = useState(selectedCases)
  const recommendIds = useMemo(() => recommendCases.map((testCase) => testCase.id), [recommendCases])
  const authorIds = useMemo(
    () => new Set(recommendCases.map((testCase) => testCase.current_draft_author_id).filter((id): id is number => id != null)),
    [recommendCases],
  )
  const qaLeadCandidates = useMemo(
    () => users.filter((candidate) => candidate.is_active
      && !authorIds.has(candidate.id)
      && candidate.id !== user?.id
      && (candidate.roles.includes('QA_LEAD') || candidate.roles.includes('CHEIF_MANAGER_QA'))),
    [users, authorIds, user?.id],
  )
  const [qaLeadId, setQaLeadId] = useState<number | ''>(
    qaLeadCandidates.some((candidate) => candidate.id === project.default_qa_lead_id) ? project.default_qa_lead_id! : '',
  )
  const [comments, setComments] = useState('')
  const [stage, setStage] = useState<'confirm' | 'recommending' | 'success' | 'error'>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)

  async function recommend(e?: React.FormEvent) {
    e?.preventDefault()
    setError(null)
    setStage('recommending')
    setProgress(10)
    setProgressMessage('Validating pending review status…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 60 ? 'Recording the Reviewer recommendation…' : 'Verifying selected testcases…')
        return next
      })
    }, 280)
    try {
      const body: TestCaseBulkRecommendIn = { ids: recommendIds, assigned_qa_lead_id: Number(qaLeadId), comments: comments.trim() || null }
      const recommended = await api.post<TestCaseOut[]>(`/api/test-repository/projects/${project.id}/test-cases/bulk-recommend`, body)
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${recommended.length} testcase${recommended.length !== 1 ? 's' : ''} recommended`)
      onRecommended(recommended, recommendIds)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'recommending' ? 'Recommending testcases'
    : stage === 'success' ? 'Bulk recommendation completed'
      : stage === 'error' ? 'Bulk recommendation failed'
        : `Recommend ${recommendIds.length} pending testcase${recommendIds.length !== 1 ? 's' : ''} for approval?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={recommend}>
          <div className="tm-bulk-confirm-count"><strong>{recommendIds.length}</strong><span>pending testcase{recommendIds.length !== 1 ? 's' : ''} will move to Review Completed</span></div>
          <p>Confirm that the selected definitions and steps have been reviewed. They will await the QA Lead's final decision next -- Recommend does not approve or activate them.</p>
          <Field label="QA Lead (Stage 2) *">
            <SearchableSelect
              value={qaLeadId === '' ? '' : String(qaLeadId)}
              onChange={(value) => setQaLeadId(value ? Number(value) : '')}
              placeholder="-- Select QA Lead --"
              options={qaLeadCandidates.map((candidate) => ({ value: String(candidate.id), label: candidate.full_name }))}
            />
          </Field>
          <Field label="Comments (optional)">
            <textarea rows={4} value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional notes for the QA Lead…" />
          </Field>
          <p className="muted small">This message (if any) will be signed by you and recorded in every selected testcase's activity history.</p>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={!qaLeadId}>Recommend all</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'recommending' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk recommend progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Recommendation is being recorded atomically' : 'Recommended testcases now await QA Lead approval'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was recommended</strong>
          <p className="muted small">The bulk recommendation is atomic, so all selected testcases remain pending.</p>
          <div className="tm-operation-error"><strong>Reason</strong><p>{errorReason}</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => recommend()}>Try again</button>
            <button className="btn" onClick={() => { setError(null); setStage('confirm') }}>Edit comments</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// REV-001, bulk form. Reported directly: "i have 100 testcases, so it is
// not possible to do manually edit one by one by author to submit" -- mirrors
// BulkApproveModal's own confirm/progress/success/error shape, just for
// Author's own Submit for review action instead of QA Lead's approval.
function BulkSubmitModal({ project, selectedCases, users, onClose, onSubmitted }: {
  project: TestProjectOut
  selectedCases: TestCaseOut[]
  users: UserOut[]
  onClose: () => void
  onSubmitted: (testCases: TestCaseOut[], submittedIds: number[]) => void
}) {
  const [submitCases] = useState(selectedCases)
  const submitIds = useMemo(() => submitCases.map((testCase) => testCase.id), [submitCases])
  const authorIds = useMemo(
    () => new Set(submitCases.map((testCase) => testCase.current_draft_author_id).filter((id): id is number => id != null)),
    [submitCases],
  )
  const reviewerCandidates = useMemo(
    () => users.filter((candidate) => candidate.is_active && !authorIds.has(candidate.id)),
    [users, authorIds],
  )
  const qaLeadCandidates = useMemo(
    () => users.filter((candidate) => candidate.is_active
      && !authorIds.has(candidate.id)
      && (candidate.roles.includes('QA_LEAD') || candidate.roles.includes('CHEIF_MANAGER_QA'))),
    [users, authorIds],
  )
  const [reviewerId, setReviewerId] = useState<number | ''>(
    reviewerCandidates.some((candidate) => candidate.id === project.default_reviewer_id) ? project.default_reviewer_id! : '',
  )
  const [qaLeadId, setQaLeadId] = useState<number | ''>(
    project.default_qa_lead_id !== reviewerId
      && qaLeadCandidates.some((candidate) => candidate.id === project.default_qa_lead_id) ? project.default_qa_lead_id! : '',
  )
  const [note, setNote] = useState('')
  const [stage, setStage] = useState<'confirm' | 'submitting' | 'success' | 'error'>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (reviewerId && qaLeadId === reviewerId) setQaLeadId('')
  }, [reviewerId, qaLeadId])

  async function doSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    setError(null)
    setStage('submitting')
    setProgress(10)
    setProgressMessage('Validating step completeness…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 60 ? 'Sending to the Reviewer recommendation queue…' : 'Checking each selected testcase…')
        return next
      })
    }, 280)
    try {
      const submitted = await api.post<TestCaseOut[]>(`/api/test-repository/projects/${project.id}/test-cases/bulk-submit`, {
        ids: submitIds,
        assigned_reviewer_id: reviewerId,
        assigned_qa_lead_id: qaLeadId,
        note: note.trim() || null,
      })
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${submitted.length} testcase${submitted.length !== 1 ? 's' : ''} submitted for review`)
      onSubmitted(submitted, submitIds)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'submitting' ? 'Submitting testcases'
    : stage === 'success' ? 'Bulk submit completed'
      : stage === 'error' ? 'Bulk submit failed'
        : `Submit ${submitIds.length} testcase${submitIds.length !== 1 ? 's' : ''} for review?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={doSubmit}>
          <div className="tm-bulk-confirm-count"><strong>{submitIds.length}</strong><span>Draft / Returned testcase{submitIds.length !== 1 ? 's' : ''} will move to In Review</span></div>
          <p>Each one is checked for complete steps (TC-003) before anything is changed -- if any selected testcase isn't ready, none of them are submitted.</p>
          <div className="tm-submit-assignment-grid">
            <Field label="Reviewer (Stage 1) *">
              <SearchableSelect
                value={reviewerId === '' ? '' : String(reviewerId)}
                onChange={(value) => setReviewerId(value ? Number(value) : '')}
                placeholder="-- Select Reviewer --"
                options={reviewerCandidates.map((candidate) => ({ value: String(candidate.id), label: candidate.full_name }))}
              />
            </Field>
            <Field label="QA Lead (Stage 2) *">
              <SearchableSelect
                value={qaLeadId === '' ? '' : String(qaLeadId)}
                onChange={(value) => setQaLeadId(value ? Number(value) : '')}
                placeholder="-- Select QA Lead --"
                options={qaLeadCandidates.filter((candidate) => candidate.id !== reviewerId).map((candidate) => ({ value: String(candidate.id), label: candidate.full_name }))}
              />
            </Field>
          </div>
          <p className="muted small">Assignments control routing and notifications. The testcase author is excluded from Stage 1.</p>
          <Field label="Note for the Reviewer (optional)">
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional context shared on every selected testcase…" />
          </Field>
          <p className="muted small">This note (if any) is recorded in every selected testcase's own activity history.</p>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={!reviewerId || !qaLeadId}>Submit {submitIds.length === 1 ? 'for review' : 'all for review'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'submitting' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk submit progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Submission is being recorded atomically' : 'Submitted testcases now await Reviewer recommendation'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was submitted</strong>
          <p className="muted small">The bulk submit is atomic, so all selected testcases remain unchanged.</p>
          <div className="tm-operation-error"><strong>Reason</strong><p>{errorReason}</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => doSubmit()}>Try again</button>
            <button className="btn" onClick={() => { setError(null); setStage('confirm') }}>Edit note</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// SRS VER-005 -- version history list + compare. Compare is entered by
// picking two versions from this list; the diff itself renders inline
// underneath rather than as a second modal, so the two versions being
// compared stay visible alongside their differences.
function TestCaseVersionsModal({ testCase, versions, onClose }: {
  testCase: TestCaseOut
  versions: TestCaseVersionSummary[]
  onClose: () => void
}) {
  const [compare, setCompare] = useState<{ left: number; right: number }>({
    left: versions[versions.length - 1]?.id || 0,
    right: versions[0]?.id || 0,
  })
  const [diff, setDiff] = useState<TestCaseVersionCompareOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // Stage 1 (Reviewer) and Stage 2 (QA Lead) decisions are two independent
  // fields on the full TestCaseVersionOut record -- the lightweight
  // TestCaseVersionSummary list this modal is given doesn't carry either, so
  // full detail is fetched per version, in parallel, once this modal opens.
  const [details, setDetails] = useState<Record<number, TestCaseVersionOut>>({})

  useEffect(() => {
    let active = true
    Promise.all(versions.map((v) =>
      api.get<TestCaseVersionOut>(`/api/test-repository/test-cases/${testCase.id}/versions/${v.id}`)
        .then((full) => [v.id, full] as const)
        .catch(() => null)
    )).then((results) => {
      if (!active) return
      const next: Record<number, TestCaseVersionOut> = {}
      results.forEach((entry) => { if (entry) next[entry[0]] = entry[1] })
      setDetails(next)
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testCase.id])

  async function runCompare() {
    if (!compare.left || !compare.right || compare.left === compare.right) return
    setBusy(true); setError(null)
    try {
      setDiff(await api.get<TestCaseVersionCompareOut>(
        `/api/test-repository/test-cases/${testCase.id}/versions-compare?left=${compare.left}&right=${compare.right}`
      ))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`${testCase.test_case_key} · Version history`} onClose={onClose} wide>
      <table className="simple-table">
        <thead>
          <tr>
            <th>Version</th><th>Status</th><th>Author</th><th>Created</th><th>Submitted</th>
            <th>Reviewer decision (Stage 1)</th><th>QA Lead decision (Stage 2)</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const full = details[v.id]
            return (
              <tr key={v.id}>
                <td>v{v.version}</td>
                <td><Badge status={v.status} /></td>
                <td>{v.author_name || '—'}</td>
                <td>{new Date(v.created_at).toLocaleString()}</td>
                <td>{v.submitted_at ? new Date(v.submitted_at).toLocaleString() : '—'}</td>
                <td>
                  {full?.reviewed_by_name ? (
                    <span className="tm-workflow-status-field">
                      <strong>{full.reviewed_by_name}</strong>
                      <small>{full.reviewed_at ? new Date(full.reviewed_at).toLocaleString() : ''}{full.review_comments ? ` -- ${full.review_comments}` : ''}</small>
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {full?.qa_lead_decided_by_name ? (
                    <span className="tm-workflow-status-field">
                      <strong>{full.qa_lead_decided_by_name}</strong>
                      <small>{full.qa_lead_decided_at ? new Date(full.qa_lead_decided_at).toLocaleString() : ''}{full.qa_lead_decision_comments ? ` -- ${full.qa_lead_decision_comments}` : ''}</small>
                    </span>
                  ) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {versions.length > 1 && (
        <div className="tm-version-compare">
          <strong>Compare two versions</strong>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={compare.left} onChange={(e) => setCompare((c) => ({ ...c, left: Number(e.target.value) }))}>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} ({v.status})</option>)}
            </select>
            <span>vs</span>
            <select value={compare.right} onChange={(e) => setCompare((c) => ({ ...c, right: Number(e.target.value) }))}>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} ({v.status})</option>)}
            </select>
            <button type="button" className="btn btn-sm" onClick={runCompare} disabled={busy || compare.left === compare.right}>
              {busy ? 'Comparing…' : 'Compare'}
            </button>
          </div>
          <ErrorText error={error} />
          {diff && (
            <div className="tm-version-diff">
              {Object.keys(diff.field_diffs).length === 0 && Object.keys(diff.step_diffs).length === 0 ? (
                <p className="muted small">No field or step differences between these two versions.</p>
              ) : (
                <>
                  {Object.entries(diff.field_diffs).map(([field, values]) => (
                    <div className="tm-diff-row" key={field}>
                      <strong>{field}</strong>
                      <span className="tm-diff-left">{String(values.left ?? '—')}</span>
                      <span className="tm-diff-right">{String(values.right ?? '—')}</span>
                    </div>
                  ))}
                  {Object.entries(diff.step_diffs).map(([stepNo, values]) => (
                    <div className="tm-diff-row" key={`step-${stepNo}`}>
                      <strong>Step {stepNo}</strong>
                      <span className="tm-diff-left">{values.left ? `${values.left.step_text} → ${values.left.expected_result}` : '(removed)'}</span>
                      <span className="tm-diff-right">{values.right ? `${values.right.step_text} → ${values.right.expected_result}` : '(removed)'}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <button className="btn" onClick={onClose} style={{ marginTop: 14 }}>Close</button>
    </Modal>
  )
}

// TC-004 -- QA Lead/Admin override of an existing checkout; requires a
// reason, recorded to the case's own activity history by the backend.
function TestCaseCheckoutOverrideModal({ testCase, onClose, onOverridden }: {
  testCase: TestCaseOut
  onClose: () => void
  onOverridden: (tc: TestCaseOut) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!reason.trim()) { setError(new Error('A reason is required to override an existing checkout')); return }
    setBusy(true); setError(null)
    try {
      onOverridden(await api.post<TestCaseOut>(`/api/test-repository/test-cases/${testCase.id}/checkout-override`, { reason: reason.trim() }))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="Override checkout?" onClose={onClose} variant="dialog" preventBackdropClose>
      <form onSubmit={submit}>
        <p>
          <strong>{testCase.checked_out_by_name}</strong> currently has <strong>{testCase.test_case_key}</strong> checked
          out. Overriding reassigns the checkout to you and records why.
        </p>
        <Field label="Reason *">
          <textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this checkout being overridden?" />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-danger" disabled={busy}>{busy ? 'Overriding…' : 'Override checkout'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// TC-005 -- clone into a brand-new testcase identity at v1.0 Draft, source
// recorded. Defaults to the same project; PRJ-006 cross-project reuse is
// offered via the project picker below.
function TestCaseCloneModal({ testCase, projects, onClose, onCloned }: {
  testCase: TestCaseOut
  projects: TestProjectOut[]
  onClose: () => void
  onCloned: () => void
}) {
  const [targetProject, setTargetProject] = useState<number>(testCase.project_id)
  const [suffix, setSuffix] = useState('(Copy)')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.post(`/api/test-repository/test-cases/${testCase.id}/clone`, {
        project_id: targetProject, name_suffix: suffix.trim() || null,
      })
      onCloned()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Clone ${testCase.test_case_key}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted small">Creates a new, independent test case at v1.0 Draft. Its author must submit it for Reviewer recommendation.</p>
        <Field label="Target Project">
          <SearchableSelect
            value={String(targetProject)}
            onChange={(v) => setTargetProject(Number(v))}
            options={projects.filter((p) => p.is_active).map((p) => ({ value: String(p.id), label: `${p.project_key} -- ${p.name}` }))}
          />
        </Field>
        <Field label="Scenario suffix (optional)">
          <input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="(Copy)" />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Cloning…' : 'Clone test case'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// TC-006 -- archives the approved baseline: preserves versions/cycle
// membership/execution history, blocks new cycle selection.
function TestCaseArchiveModal({ testCase, onClose, onArchived }: {
  testCase: TestCaseOut
  onClose: () => void
  onArchived: (tc: TestCaseOut) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      onArchived(await api.post<TestCaseOut>(`/api/test-repository/test-cases/${testCase.id}/archive`, { reason: reason.trim() || null }))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Archive ${testCase.test_case_key}?`} onClose={onClose} variant="dialog" preventBackdropClose>
      <form onSubmit={submit}>
        <p>Archiving retires the Approved version -- history, cycle membership, and execution results are preserved, but it can no longer be added to new cycles.</p>
        <Field label="Reason (optional)">
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-danger" disabled={busy}>{busy ? 'Archiving…' : 'Archive test case'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function TestCaseModal({ projectId, allProjects, folders, folderId, existing, users, onClose, onSaved, onDeleted, onReviewed, onCheckoutChange, canAuthor, canReview, canGiveFinalApproval }: {
  projectId: number
  allProjects: TestProjectOut[]
  folders: TestFolderOut[]
  folderId: number | ''
  existing: TestCaseOut | null
  users: UserOut[]
  onClose: () => void
  onSaved: (tc: TestCaseOut) => void
  onDeleted: (id: number) => void
  onReviewed: (tc: TestCaseOut) => void
  onCheckoutChange: (tc: TestCaseOut) => void
  canAuthor: boolean
  canReview: boolean
  canGiveFinalApproval: boolean
}) {
  const [folder, setFolder] = useState<number | ''>(existing?.folder_id ?? folderId)
  const [epicId, setEpicId] = useState(existing?.epic_id || '')
  const [crNumber, setCrNumber] = useState(existing?.cr_number || '')
  const [featureId, setFeatureId] = useState(existing?.feature_id || '')
  const [userStoryId, setUserStoryId] = useState(existing?.user_story_id || '')
  const [testType, setTestType] = useState(existing?.test_type || TEST_CASE_TYPES[0])
  const [moduleName, setModuleName] = useState(existing?.module_name || '')
  const [scenario, setScenario] = useState(existing?.test_scenario || '')
  const [preCondition, setPreCondition] = useState(existing?.pre_condition || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [priority, setPriority] = useState(existing?.priority || TEST_CASE_PRIORITIES[0])
  const [tags, setTags] = useState((existing?.tags || []).join(', '))
  const [steps, setSteps] = useState<TestStepIn[]>(
    existing?.steps.length ? existing.steps.map((s) => ({ step_no: s.step_no, step_text: s.step_text, expected_result: s.expected_result })) : [emptyStep(1)]
  )
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reviewDecision, setReviewDecision] = useState<TestCaseReviewDecision | null>(null)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [showSubmit, setShowSubmit] = useState(false)
  const [showOverride, setShowOverride] = useState(false)
  const [showClone, setShowClone] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [versions, setVersions] = useState<TestCaseVersionSummary[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const [compareIds, setCompareIds] = useState<{ left: number; right: number } | null>(null)
  // APR-001 -- per-item override of the project's default_reviewer_id/
  // default_qa_lead_id, fetched from the CURRENT version's own full detail
  // (assigned_reviewer_id/assigned_qa_lead_id live there, not on TestCaseOut
  // itself -- see types.ts TestCaseVersionOut). Project-role authorization
  // and stage assignment are both required to record a workflow decision.
  const [currentVersionDetail, setCurrentVersionDetail] = useState<TestCaseVersionOut | null>(null)
  const [assignReviewerId, setAssignReviewerId] = useState<number | ''>('')
  const [assignQaLeadId, setAssignQaLeadId] = useState<number | ''>('')
  const [assignBusy, setAssignBusy] = useState(false)
  const [assignSaved, setAssignSaved] = useState(false)
  const [assignError, setAssignError] = useState<unknown>(null)
  const { user } = useAuth()
  const currentProject = allProjects.find((project) => project.id === (existing?.project_id ?? projectId))
  // Reported directly: "check in checkout option should be available for
  // testcases, otherwise multiple people can edit at once, if checkout, the
  // testcase is locked for editing by that user." A case someone ELSE
  // checked out is forced read-only here too (not just on the backend,
  // which would otherwise only surface as a 423 on Save) -- lockedByMe
  // leaves editing open as normal. An existing unreserved case is also
  // read-only until Start editing checks it out to the current user.
  const lockedByOther = !!existing?.checked_out_by_id && existing.checked_out_by_id !== user?.id
  const lockedByMe = !!existing?.checked_out_by_id && existing.checked_out_by_id === user?.id
  // Both "In Review" (Stage 1) and "Review Completed" (Stage 2) are pending
  // a decision -- mirrors backend constants.TEST_CASE_PENDING_DECISION_STATUSES.
  const pendingDecisionStatus = !!existing && TEST_CASE_PENDING_DECISION_STATUSES.includes(existing.status)
  const isCurrentDraftAuthor = !!existing && !!user?.id && (
    existing.current_draft_author_id === user.id || currentVersionDetail?.author_id === user.id
  )
  const isAssignedStageActor = !!existing && (
    existing.pending_with_user_id === user?.id || hasRole(user, 'ADMIN')
  )
  const canActOnPendingStage = !isCurrentDraftAuthor && !!existing && (
    (existing.status === 'In Review' && canReview && isAssignedStageActor)
    || (existing.status === 'Review Completed' && canGiveFinalApproval && isAssignedStageActor)
  )
  const pendingLockContext = !pendingDecisionStatus || !existing ? null
    : isCurrentDraftAuthor ? {
      title: 'Maker-checker lock',
      message: 'You authored this testcase version, so you cannot review or approve it yourself. Another authorized reviewer must record the pending decision.',
    }
      : existing.status === 'In Review' && canReview && isAssignedStageActor ? {
        title: 'Reviewer mode — submitted content locked',
        message: 'The submitted testcase is preserved unchanged while you review it. Use the Stage 1 Reviewer decision controls below to recommend it or return it for correction.',
      }
        : existing.status === 'Review Completed' && canGiveFinalApproval && isAssignedStageActor ? {
          title: 'QA Lead approval mode — submitted content locked',
          message: 'The recommended testcase is preserved unchanged while you make the final decision. Use the Stage 2 controls below to approve, return, or reject it.',
        }
          : existing.status === 'In Review' ? {
            title: 'Editing locked — awaiting Reviewer recommendation',
            message: 'The testcase content cannot change while Stage 1 review is pending. Editing reopens only if the Reviewer returns it for correction.',
          }
            : {
              title: 'Editing locked — awaiting QA Lead final decision',
              message: 'The testcase content cannot change while Stage 2 approval is pending. Editing reopens only if the QA Lead returns it for correction.',
            }
  const isTerminalStatus = !!existing && TEST_CASE_TERMINAL_STATUSES.includes(existing.status)
  const readOnly = !canAuthor || lockedByOther || (!!existing && !lockedByMe) || pendingDecisionStatus

  useEffect(() => {
    if (existing) {
      api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CASE&entity_id=${existing.id}`).then(setActivity).catch(() => setActivity([]))
      api.get<TestCaseVersionSummary[]>(`/api/test-repository/test-cases/${existing.id}/versions`).then(setVersions).catch(() => setVersions([]))
    }
  }, [existing])

  // Pre-fill the assignment selects from the CURRENT version's own override
  // (assigned_reviewer_id/assigned_qa_lead_id), falling back to the
  // project's default_reviewer_id/default_qa_lead_id when the item has no
  // override yet (APR-001).
  useEffect(() => {
    const versionId = existing?.current_draft_version_id || existing?.current_approved_version_id
    if (!existing || !versionId) { setCurrentVersionDetail(null); return }
    let active = true
    api.get<TestCaseVersionOut>(`/api/test-repository/test-cases/${existing.id}/versions/${versionId}`)
      .then((detail) => { if (active) setCurrentVersionDetail(detail) })
      .catch(() => { if (active) setCurrentVersionDetail(null) })
    return () => { active = false }
  }, [existing?.id, existing?.current_draft_version_id, existing?.current_approved_version_id])

  useEffect(() => {
    setAssignReviewerId(currentVersionDetail?.assigned_reviewer_id ?? currentProject?.default_reviewer_id ?? '')
    setAssignQaLeadId(currentVersionDetail?.assigned_qa_lead_id ?? currentProject?.default_qa_lead_id ?? '')
    setAssignSaved(false)
  }, [currentVersionDetail, currentProject?.default_reviewer_id, currentProject?.default_qa_lead_id])

  async function saveAssignment() {
    if (!existing) return
    setAssignBusy(true); setAssignError(null); setAssignSaved(false)
    try {
      const body: TestCaseReassignApproversIn = {
        assigned_reviewer_id: assignReviewerId || null,
        assigned_qa_lead_id: assignQaLeadId || null,
      }
      const updated = await api.patch<TestCaseOut>(`/api/test-repository/test-cases/${existing.id}/approvers`, body)
      onCheckoutChange(updated)
      setAssignSaved(true)
    } catch (err) { setAssignError(err) } finally { setAssignBusy(false) }
  }

  async function toggleCheckout() {
    if (!existing) return
    setCheckoutBusy(true); setError(null)
    try {
      const updated = lockedByMe
        ? await api.post<TestCaseOut>(`/api/test-repository/test-cases/${existing.id}/checkin`)
        : await api.post<TestCaseOut>(`/api/test-repository/test-cases/${existing.id}/checkout`)
      onCheckoutChange(updated)
    } catch (err) { setError(err) } finally { setCheckoutBusy(false) }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const body = {
      test_case_key: null,
      folder_id: folder || null,
      epic_id: epicId || null, cr_number: crNumber || null, feature_id: featureId || null, user_story_id: userStoryId || null,
      test_type: testType || null, module_name: moduleName || null, test_scenario: scenario || null,
      pre_condition: preCondition || null, description: description || null,
      priority: priority || null,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      steps,
    }
    try {
      const saved = existing
        ? await api.patch<TestCaseOut>(`/api/test-repository/test-cases/${existing.id}`, body)
        : await api.post<TestCaseOut>(`/api/test-repository/projects/${projectId}/test-cases`, body)
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function remove() {
    if (!existing) return
    setBusy(true); setError(null)
    try {
      await api.del(`/api/test-repository/test-cases/${existing.id}`)
      onDeleted(existing.id)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={existing ? `Test Case ${existing.test_case_key}` : 'New Test Case'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="grid grid-2">
          <Field label="Test Case ID">
            <input value={existing?.test_case_key || 'Generated automatically (for example TQA-TC-01)'} disabled />
          </Field>
          <Field label="Folder">
            <SearchableSelect
              value={folder === '' ? '' : String(folder)}
              onChange={(v) => setFolder(v ? Number(v) : '')}
              disabled={readOnly}
              placeholder="-- Unfiled --"
              options={[
                { value: '', label: '-- Unfiled --' },
                ...folders.map((f) => ({ value: String(f.id), label: folderPathLabel(folders, f) })),
              ]}
            />
          </Field>
          <Field label="Epic ID">
            <input value={epicId} onChange={(e) => setEpicId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="CR Number">
            <input value={crNumber} onChange={(e) => setCrNumber(e.target.value)} disabled={readOnly} placeholder="e.g. CR-2026-001" />
          </Field>
          <Field label="Feature ID">
            <input value={featureId} onChange={(e) => setFeatureId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="User Story ID">
            <input value={userStoryId} onChange={(e) => setUserStoryId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Test Type">
            <select value={testType} onChange={(e) => setTestType(e.target.value)} disabled={readOnly}>
              {TEST_CASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Module Name">
            <input value={moduleName} onChange={(e) => setModuleName(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={readOnly}>
              {TEST_CASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Tags / Labels">
            <input value={tags} onChange={(e) => setTags(e.target.value)} disabled={readOnly} placeholder="smoke, payments, regression" />
            <small className="muted">Separate multiple tags with commas.</small>
          </Field>
          <Field label="Workflow Status">
            <div className="tm-workflow-status-field">
              <Badge status={existing?.status || 'Draft'} label={TEST_CASE_STATUS_LABELS[existing?.status || 'Draft']} />
              {/* Reported directly: this note used to only check
                  current_approved_version_id, so a brand-new, never-submitted
                  Draft showed "Unavailable until QA Lead approval" -- easily
                  misread as "already sent to the QA Lead and just waiting,"
                  when actually nothing had been submitted yet (submit_test_case
                  was never called), so review_test_case correctly had nothing
                  to approve. This now reflects the actual status/submission
                  state instead of only the approval-history flag. */}
              <small>{workflowStatusNote(existing)}</small>
              {isTerminalStatus && <small className="muted">Terminal state -- use Clone or edit to start a fresh Draft revision.</small>}
            </div>
          </Field>
          {existing && (
            <Field label="Version">
              <div className="tm-workflow-status-field">
                <span className="badge badge-gray">{`v${existing.version || '1.0'}`}</span>
                <small>
                  {existing.current_draft_version_id
                    ? 'A Draft revision is in progress on top of the Approved baseline'
                    : 'Bumps when a QA Lead approves the next revision'}
                </small>
                {versions.length > 0 && (
                  <button type="button" className="btn btn-sm" onClick={() => setShowVersions(true)}>Version history ({versions.length})</button>
                )}
              </div>
            </Field>
          )}
          {existing && (
            <Field label="Editing access">
              <div className="tm-workflow-status-field">
                {pendingDecisionStatus ? (
                  <span className={`badge ${canActOnPendingStage ? 'badge-blue' : 'badge-yellow'}`}>
                    {canActOnPendingStage ? 'Decision mode — editing locked' : 'Locked during review'}
                  </span>
                ) : existing.checked_out_by_id ? (
                  <span className={`badge ${lockedByMe ? 'badge-blue' : 'badge-yellow'}`}>
                    {lockedByMe ? 'Reserved by you' : `Being edited by ${existing.checked_out_by_name}`}
                  </span>
                ) : (
                  <span className="badge badge-gray">Available</span>
                )}
                {canAuthor && !pendingDecisionStatus && (lockedByMe || !existing.checked_out_by_id) && (
                  <button type="button" className="btn btn-sm" onClick={toggleCheckout} disabled={checkoutBusy}>
                    {checkoutBusy ? 'Please wait…' : lockedByMe ? 'Finish editing' : 'Start editing'}
                  </button>
                )}
                {canAuthor && pendingDecisionStatus && (
                  <button type="button" className="btn btn-sm" disabled title="Editing is locked while an approval decision is pending">Start editing</button>
                )}
                {!pendingDecisionStatus && (canReview || canGiveFinalApproval) && lockedByOther && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setShowOverride(true)}>Override checkout</button>
                )}
              </div>
            </Field>
          )}
          {existing && canAuthor && isCurrentDraftAuthor && (
            <Field label="Approver assignment">
              <div className="tm-workflow-status-field" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <small className="muted">The assigned Reviewer and QA Lead own their respective workflow decisions. Administrators retain oversight access. Leave blank to use the project's default.</small>
                <div className="grid grid-2">
                  <Field label="Assigned Reviewer (Stage 1)">
                    <SearchableSelect
                      value={assignReviewerId === '' ? '' : String(assignReviewerId)}
                      onChange={(v) => setAssignReviewerId(v ? Number(v) : '')}
                      placeholder="-- Use project default --"
                      options={users.filter((u) => u.is_active && u.id !== existing.current_draft_author_id).map((u) => ({ value: String(u.id), label: u.full_name }))}
                    />
                  </Field>
                  <Field label="Assigned QA Lead (Stage 2)">
                    <SearchableSelect
                      value={assignQaLeadId === '' ? '' : String(assignQaLeadId)}
                      onChange={(v) => setAssignQaLeadId(v ? Number(v) : '')}
                      placeholder="-- Use project default --"
                      options={users.filter((u) => u.is_active && u.roles.includes('QA_LEAD')).map((u) => ({ value: String(u.id), label: u.full_name }))}
                    />
                  </Field>
                </div>
                <ErrorText error={assignError} />
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button type="button" className="btn btn-sm" onClick={saveAssignment} disabled={assignBusy}>{assignBusy ? 'Saving…' : 'Save assignment'}</button>
                  {assignSaved && <span className="storage-setting-saved">✓ Assignment updated</span>}
                </div>
              </div>
            </Field>
          )}
        </div>
        {pendingLockContext && (
          <div className="info-banner">
            <strong>{pendingLockContext.title}.</strong> {pendingLockContext.message}
          </div>
        )}
        {lockedByOther && !pendingDecisionStatus && (
          <div className="info-banner">
            <strong>{existing?.checked_out_by_name}</strong> has this test case checked out, so it's locked
            for editing until they check it back in. {(canReview || canGiveFinalApproval) ? 'You can override the checkout above.' : 'Ask them, or a QA Lead/Reviewer on this project, to release it.'}
          </div>
        )}
        {existing && canAuthor && !existing.checked_out_by_id && !pendingDecisionStatus && (
          <div className="tm-edit-access-notice"><strong>Read-only until reserved</strong><span>Select <b>Start editing</b> above to check out this case and enable the form.</span></div>
        )}
        <Field label="Test Scenario">
          <input value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Pre-Condition">
          <textarea value={preCondition} onChange={(e) => setPreCondition(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Steps">
          {readOnly ? (
            <table className="simple-table">
              <thead><tr><th>#</th><th>Step</th><th>Expected Result</th></tr></thead>
              <tbody>{steps.map((s, i) => <tr key={i}><td>{i + 1}</td><td>{s.step_text}</td><td>{s.expected_result}</td></tr>)}</tbody>
            </table>
          ) : (
            <StepsEditor steps={steps} onChange={setSteps} />
          )}
        </Field>
        <ErrorText error={error} />
        {!readOnly && (
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            {existing && (existing.status === 'Draft' || existing.status === 'Returned') && (
              <button type="button" className="btn btn-success" onClick={() => setShowSubmit(true)} disabled={busy}>
                Submit for review
              </button>
            )}
            {existing && !existing.current_approved_version_id && <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</button>}
          </div>
        )}
      </form>
      {existing && canAuthor && (
        <div className="tm-review-actions">
          <div><strong>More actions</strong><span>Clone into a new testcase, or archive the approved baseline.</span></div>
          <button className="btn" onClick={() => setShowClone(true)}>Clone…</button>
          {canReview && existing.current_approved_version_id && existing.status !== 'Archived' && (
            <button className="btn btn-danger" onClick={() => setShowArchive(true)}>Archive</button>
          )}
          {canReview && existing.status === 'Archived' && (
            <button className="btn" disabled={archiveBusy} onClick={async () => {
              setArchiveBusy(true); setError(null)
              try { onReviewed(await api.post<TestCaseOut>(`/api/test-repository/test-cases/${existing.id}/restore`)) }
              catch (err) { setError(err) } finally { setArchiveBusy(false) }
            }}>{archiveBusy ? 'Restoring…' : 'Restore from archive'}</button>
          )}
        </div>
      )}
      {/* Stage 1 -- Reviewer tier, only valid while "In Review" (RECOMMEND/RETURN). */}
      {existing && existing.status === 'In Review' && canReview && canActOnPendingStage && (
        <div className="tm-review-actions">
          <div><strong>Reviewer decision (Stage 1)</strong><span>{isCurrentDraftAuthor ? 'You authored this testcase version. Another Reviewer must record the decision.' : "Recommend this test case for the QA Lead's final approval, or return it to the Author for changes."}</span></div>
          <button className="btn btn-primary" disabled={isCurrentDraftAuthor} onClick={() => setReviewDecision('RECOMMEND')}>{TEST_CASE_REVIEW_ACTION_LABELS.RECOMMEND}</button>
          <button className="btn" disabled={isCurrentDraftAuthor} onClick={() => setReviewDecision('RETURN')}>{TEST_CASE_REVIEW_ACTION_LABELS.RETURN}</button>
        </div>
      )}
      {/* Stage 2 -- QA Lead tier, only valid while "Review Completed" (APPROVE/RETURN/REJECT). Strictly narrower than Stage 1 -- a plain Reviewer project role does not qualify. */}
      {existing && existing.status === 'Review Completed' && canGiveFinalApproval && canActOnPendingStage && (
        <div className="tm-review-actions">
          <div><strong>QA Lead final decision (Stage 2)</strong><span>Approve and activate this test case, return it for changes, or reject it.</span></div>
          <button className="btn btn-primary" onClick={() => setReviewDecision('APPROVE')}>{TEST_CASE_REVIEW_ACTION_LABELS.APPROVE}</button>
          <button className="btn" onClick={() => setReviewDecision('RETURN')}>{TEST_CASE_REVIEW_ACTION_LABELS.RETURN}</button>
          <button className="btn btn-danger" onClick={() => setReviewDecision('REJECT')}>{TEST_CASE_REVIEW_ACTION_LABELS.REJECT}</button>
        </div>
      )}
      {existing && <LinkedDefects query={`test_case_id=${existing.id}`} />}
      {existing && <JiraActivity entityType="TEST_CASE" entityId={existing.id} items={activity} onPosted={(item) => setActivity((prev) => [...prev, item])} />}
      {confirmDelete && existing && (
        <ConfirmModal
          title="Delete test case?"
          message={<p>Delete <strong>{existing.test_case_key}</strong>? Its definition and steps will be permanently removed.</p>}
          confirmLabel="Delete test case" cancelLabel="Keep test case" destructive busy={busy}
          onConfirm={remove} onCancel={() => setConfirmDelete(false)}
        />
      )}
      {reviewDecision && existing && (
        <TestCaseReviewModal
          testCase={existing}
          decision={reviewDecision}
          users={users}
          defaultQaLeadId={currentVersionDetail?.assigned_qa_lead_id ?? currentProject?.default_qa_lead_id}
          onClose={() => setReviewDecision(null)}
          onReviewed={onReviewed}
        />
      )}
      {showSubmit && existing && currentProject && (
        <BulkSubmitModal
          project={currentProject}
          selectedCases={[existing]}
          users={users}
          onClose={() => setShowSubmit(false)}
          onSubmitted={(submitted) => {
            setShowSubmit(false)
            if (submitted[0]) onReviewed(submitted[0])
          }}
        />
      )}
      {showVersions && existing && (
        <TestCaseVersionsModal testCase={existing} versions={versions} onClose={() => setShowVersions(false)} />
      )}
      {showOverride && existing && (
        <TestCaseCheckoutOverrideModal
          testCase={existing}
          onClose={() => setShowOverride(false)}
          onOverridden={(tc) => { onCheckoutChange(tc); setShowOverride(false) }}
        />
      )}
      {showClone && existing && (
        <TestCaseCloneModal
          testCase={existing}
          projects={allProjects}
          onClose={() => setShowClone(false)}
          onCloned={() => { setShowClone(false); onClose() }}
        />
      )}
      {showArchive && existing && (
        <TestCaseArchiveModal
          testCase={existing}
          onClose={() => setShowArchive(false)}
          onArchived={(tc) => { onReviewed(tc); setShowArchive(false) }}
        />
      )}
    </Modal>
  )
}

function BulkFieldCard({ title, description, enabled, onToggle, children, wide = false, disabled = false }: {
  title: string
  description: string
  enabled: boolean
  onToggle: (enabled: boolean) => void
  children: React.ReactNode
  wide?: boolean
  disabled?: boolean
}) {
  return (
    <section className={`tm-bulk-field-card${enabled ? ' active' : ''}${wide ? ' wide' : ''}${disabled ? ' disabled' : ''}`}>
      <label className="tm-bulk-field-heading">
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
        <span className="tm-bulk-switch" aria-hidden="true"><i /></span>
        <span><strong>{title}</strong><small>{description}</small></span>
      </label>
      <div className="tm-bulk-field-control" aria-disabled={!enabled}>{children}</div>
    </section>
  )
}

function BulkUpdateModal({ projectId, selectedCases, folders, users, canUpdateAssignments, onClose, onUpdated }: {
  projectId: number
  selectedCases: TestCaseOut[]
  folders: TestFolderOut[]
  users: UserOut[]
  canUpdateAssignments: boolean
  onClose: () => void
  onUpdated: (cases: TestCaseOut[]) => void
}) {
  type BulkUpdateStage = 'edit' | 'confirm' | 'updating' | 'success' | 'error'
  type BulkUpdateBody = {
    ids: number[]
    folder_id?: number | null
    priority?: string
    test_type?: string
    module_name?: string
    tags?: string[]
    assigned_reviewer_id?: number | null
    assigned_qa_lead_id?: number | null
  }
  const [folder, setFolder] = useState('unchanged')
  const [priority, setPriority] = useState('')
  const [testType, setTestType] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [tags, setTags] = useState('')
  const [reviewerId, setReviewerId] = useState<number | ''>('')
  const [qaLeadId, setQaLeadId] = useState<number | ''>('')
  const [updateFolder, setUpdateFolder] = useState(false)
  const [updatePriority, setUpdatePriority] = useState(false)
  const [updateTestType, setUpdateTestType] = useState(false)
  const [updateModule, setUpdateModule] = useState(false)
  const [updateTags, setUpdateTags] = useState(false)
  const [updateReviewer, setUpdateReviewer] = useState(false)
  const [updateQaLead, setUpdateQaLead] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [stage, setStage] = useState<BulkUpdateStage>('edit')
  const [pendingBody, setPendingBody] = useState<BulkUpdateBody | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting to start')
  const [failurePoint, setFailurePoint] = useState('validating the selected test cases')
  const selectedIds = useMemo(() => selectedCases.map((testCase) => testCase.id), [selectedCases])
  const totalSelected = useState(selectedCases.length)[0]
  const workflowLockedCases = useMemo(
    () => selectedCases.filter((testCase) => testCase.status === 'In Review' || testCase.status === 'Review Completed'),
    [selectedCases],
  )
  const testcaseFieldsLocked = workflowLockedCases.length > 0
  const selectedAuthorIds = useMemo(
    () => new Set(selectedCases.map((testCase) => testCase.current_draft_author_id).filter((id): id is number => id != null)),
    [selectedCases],
  )

  const changeSummary = useMemo(() => {
    const changes: string[] = []
    if (updateFolder) {
      const folderName = folder === 'unfiled' ? 'Unfiled' : folders.find((item) => item.id === Number(folder))?.name || 'Selected folder'
      changes.push(`Folder → ${folderName}`)
    }
    if (updatePriority) changes.push(`Priority → ${priority}`)
    if (updateTestType) changes.push(`Test Type → ${testType}`)
    if (updateModule) changes.push(`Module Name → ${moduleName.trim() || 'None'}`)
    if (updateTags) changes.push(`Tags → ${tags.trim() || 'None'}`)
    if (updateReviewer) changes.push(`Assigned Reviewer (Stage 1) → ${users.find((user) => user.id === reviewerId)?.full_name || 'Project default'}`)
    if (updateQaLead) changes.push(`Assigned QA Lead (Stage 2) → ${users.find((user) => user.id === qaLeadId)?.full_name || 'Project default'}`)
    return changes
  }, [folder, folders, priority, testType, moduleName, tags, reviewerId, qaLeadId, users, updateFolder, updatePriority, updateTestType, updateModule, updateTags, updateReviewer, updateQaLead])

  function review(e: React.FormEvent) {
    e.preventDefault()
    const body: BulkUpdateBody = { ids: selectedIds }
    if (updateFolder) body.folder_id = folder === 'unfiled' ? null : Number(folder)
    if (updatePriority) body.priority = priority
    if (updateTestType) body.test_type = testType
    if (updateModule) body.module_name = moduleName.trim()
    if (updateTags) body.tags = tags.split(',').map((tag) => tag.trim()).filter(Boolean)
    if (updateReviewer) body.assigned_reviewer_id = reviewerId || null
    if (updateQaLead) body.assigned_qa_lead_id = qaLeadId || null
    if (Object.keys(body).length === 1) {
      setError(new Error('Choose at least one field to update'))
      return
    }
    setError(null)
    setPendingBody(body)
    setStage('confirm')
  }

  async function applyUpdate() {
    if (!pendingBody) return
    setStage('updating')
    setError(null)
    setProgress(8)
    setProgressMessage('Validating the selected test cases…')
    const startedAt = Date.now()
    let currentPhase = 'validating the selected test cases'
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 45 ? 9 : 4))
        if (next >= 65) {
          currentPhase = 'saving the changes atomically'
          setProgressMessage('Saving the changes atomically…')
        } else if (next >= 35) {
          currentPhase = 'applying the selected field changes'
          setProgressMessage('Applying the selected field changes…')
        }
        return next
      })
    }, 300)
    try {
      const updated = await api.post<TestCaseOut[]>(`/api/test-repository/projects/${projectId}/test-cases/bulk-update`, pendingBody)
      const remainingDisplayTime = Math.max(0, 800 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${updated.length} test case${updated.length !== 1 ? 's' : ''} updated successfully`)
      onUpdated(updated)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setFailurePoint(currentPhase)
      setProgressMessage('The update was stopped before completion')
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'confirm' ? 'Confirm bulk update'
    : stage === 'updating' ? 'Updating test cases'
      : stage === 'success' ? 'Bulk update completed'
        : stage === 'error' ? 'Bulk update failed'
          : `Update ${totalSelected} test case${totalSelected !== 1 ? 's' : ''}`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose wide>
      {stage === 'edit' && <form className="tm-bulk-editor" onSubmit={review}>
        <div className="tm-bulk-hero">
          <span className="tm-bulk-hero-icon">✦</span>
          <div><strong>Choose what to change</strong><p>Turn on only the fields you want applied. Everything else—including test steps—stays untouched.</p></div>
          <span className="tm-bulk-selection"><b>{totalSelected}</b> selected</span>
        </div>
        <div className="tm-bulk-layout">
          <div className="tm-bulk-fields">
            {canUpdateAssignments && <section className="tm-bulk-section">
              <div className="tm-bulk-section-heading">
                <div><strong>Approver Assignment</strong><span>Routing can be updated at any workflow stage.</span></div>
                <span className="tm-bulk-section-status available">Available</span>
              </div>
              <div className="tm-bulk-field-grid">
                <BulkFieldCard title="Assigned Reviewer (Stage 1)" description="Set the Stage 1 routing assignment" enabled={updateReviewer} onToggle={setUpdateReviewer}>
                  <SearchableSelect
                    value={reviewerId === '' ? '' : String(reviewerId)}
                    onChange={(value) => setReviewerId(value ? Number(value) : '')}
                    placeholder="-- Use project default --"
                    options={[
                      { value: '', label: '-- Use project default --' },
                      ...users.filter((candidate) => candidate.is_active && !selectedAuthorIds.has(candidate.id)).map((candidate) => ({ value: String(candidate.id), label: candidate.full_name })),
                    ]}
                  />
                </BulkFieldCard>
                <BulkFieldCard title="Assigned QA Lead (Stage 2)" description="Set the Stage 2 routing assignment" enabled={updateQaLead} onToggle={setUpdateQaLead}>
                  <SearchableSelect
                    value={qaLeadId === '' ? '' : String(qaLeadId)}
                    onChange={(value) => setQaLeadId(value ? Number(value) : '')}
                    placeholder="-- Use project default --"
                    options={[
                      { value: '', label: '-- Use project default --' },
                      ...users.filter((candidate) => candidate.is_active && candidate.roles.includes('QA_LEAD')).map((candidate) => ({ value: String(candidate.id), label: candidate.full_name })),
                    ]}
                  />
                </BulkFieldCard>
              </div>
            </section>}
            <section className={`tm-bulk-section${testcaseFieldsLocked ? ' locked' : ''}`}>
              <div className="tm-bulk-section-heading">
                <div><strong>Testcase Fields</strong><span>Update testcase classification and repository details.</span></div>
                {testcaseFieldsLocked
                  ? <span className="tm-bulk-section-status locked">Locked during review</span>
                  : <span className="tm-bulk-section-status available">Available</span>}
              </div>
              {testcaseFieldsLocked && <div className="tm-bulk-lock-note">{workflowLockedCases.length} selected testcase{workflowLockedCases.length !== 1 ? 's are' : ' is'} pending reviewer recommendation or QA Lead approval. Testcase fields cannot be changed until the workflow returns to Draft.</div>}
              <div className="tm-bulk-field-grid">
            <BulkFieldCard title="Folder" description="Move cases together" enabled={updateFolder} onToggle={setUpdateFolder} disabled={testcaseFieldsLocked}>
              <SearchableSelect value={folder === 'unchanged' ? 'unfiled' : folder} onChange={setFolder} options={[{ value: 'unfiled', label: 'Unfiled' }, ...folders.map((f) => ({ value: String(f.id), label: folderPathLabel(folders, f) }))]} />
            </BulkFieldCard>
            <BulkFieldCard title="Priority" description="Set execution importance" enabled={updatePriority} onToggle={setUpdatePriority} disabled={testcaseFieldsLocked}>
              <select required={updatePriority} value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">Select priority</option>{TEST_CASE_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
            </BulkFieldCard>
            <BulkFieldCard title="Test Type" description="Change testing category" enabled={updateTestType} onToggle={setUpdateTestType} disabled={testcaseFieldsLocked}>
              <select required={updateTestType} value={testType} onChange={(e) => setTestType(e.target.value)}><option value="">Select test type</option>{TEST_CASE_TYPES.map((type) => <option key={type}>{type}</option>)}</select>
            </BulkFieldCard>
            <BulkFieldCard title="Module Name" description="Organize by product module" enabled={updateModule} onToggle={setUpdateModule} disabled={testcaseFieldsLocked}>
              <input value={moduleName} onChange={(e) => setModuleName(e.target.value)} placeholder="Blank removes module name" />
            </BulkFieldCard>
            <BulkFieldCard title="Tags / Labels" description="Replace searchable labels" enabled={updateTags} onToggle={setUpdateTags} wide disabled={testcaseFieldsLocked}>
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="smoke, payments, regression — blank removes tags" />
              {tags.trim() && <div className="tm-bulk-tag-preview">{tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 8).map((tag) => <span key={tag}>{tag}</span>)}</div>}
            </BulkFieldCard>
              </div>
            </section>
          </div>
          <aside className="tm-bulk-summary">
            <small>UPDATE SUMMARY</small>
            <strong>{changeSummary.length ? `${changeSummary.length} field${changeSummary.length !== 1 ? 's' : ''} selected` : 'No fields selected'}</strong>
            {changeSummary.length ? <ul>{changeSummary.map((change) => <li key={change}>{change}</li>)}</ul> : <p>Enable a field to preview the change here.</p>}
            {(updatePriority || updateTestType || updateModule) && <div className="tm-bulk-review-note"><b>New review required</b><span>Approved cases become Draft revisions and must be submitted for Reviewer recommendation.</span></div>}
          </aside>
        </div>
        <ErrorText error={error} />
        <div className="tm-bulk-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!changeSummary.length}>Review changes <span>→</span></button></div>
      </form>}

      {stage === 'confirm' && (
        <div className="tm-bulk-confirm">
          <div className="tm-bulk-confirm-count"><strong>{totalSelected}</strong><span>test case{totalSelected !== 1 ? 's' : ''} will be updated</span></div>
          <p>Review the changes before continuing:</p>
          <ul>{changeSummary.map((change) => <li key={change}>{change}</li>)}</ul>
          <p className="muted small">This operation is atomic. If validation or saving fails, none of the selected test cases will be changed.</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={applyUpdate}>Confirm and update</button>
            <button className="btn" onClick={() => setStage('edit')}>Back</button>
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}

      {(stage === 'updating' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk update progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Please keep this dialog open' : 'All changes are now visible in the repository'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}

      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Update stopped</strong>
          <p className="muted small">No selected test cases were changed. The operation stopped while {failurePoint}.</p>
          <div className="tm-progress-track" role="progressbar" aria-label="Bulk update stopped progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="tm-progress-meta"><span>Stopped while {failurePoint}</span><strong>{progress}%</strong></div>
          <div className="tm-operation-error"><strong>Reason</strong><p>{errorReason}</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={applyUpdate}>Try again</button>
            <button className="btn" onClick={() => { setError(null); setStage('edit') }}>Change update</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export default function TestRepository() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  // SRS PRJ-005/GOV-001 -- a project's own membership roles (Author/
  // Reviewer/Tester/QA Lead/Owner/Viewer) can further restrict what a
  // QA_ENGINEER/QA_LEAD is allowed to do on THIS specific project, on top of
  // their system-wide role. `myAccess` is fetched per project selection
  // below and defaults to permissive (undefined -> treated as allowed)
  // while it's loading, so buttons don't flicker hidden/disabled before the
  // fetch resolves -- the backend is the real source of truth regardless of
  // what's shown here.
  const [myAccess, setMyAccess] = useState<TestProjectMyAccessOut | null>(null)
  const canAuthor = hasRole(user, ...CAN_AUTHOR_ROLES) && (myAccess?.can_author_repository ?? true)
  // Review-tier actions (approve/return, checkout override, archive/
  // restore, delete folder, bulk-approve) are reachable by system QA_LEAD/
  // Admin always, or by a QA_ENGINEER who is this project's Reviewer/
  // Project Lead/Owner member -- can_review_repository (deps.py) is the
  // real, strict check; it's deliberately NOT the same "any QA_ENGINEER
  // gets in" fallback canAuthor above relies on, so this checks the same
  // CAN_AUTHOR_ROLES system-role floor and lets myAccess narrow it further.
  const canReview = hasRole(user, ...CAN_AUTHOR_ROLES) && (myAccess?.can_review_repository ?? true)
  // 2026-08 Test Approval Workflow refactor -- Stage 2 (QA Lead final
  // approve/return/reject, only valid while a version is "Review
  // Completed") is strictly narrower/higher-trust than canReview above:
  // Project Lead/Owner project roles or system QA_LEAD/Admin only, no plain
  // "Reviewer" project role, no permissive default while myAccess is still
  // loading (defaults to false, not true, unlike every other flag here).
  const canGiveFinalApproval = hasRole(user, ...CAN_AUTHOR_ROLES) && (myAccess?.can_give_final_approval ?? false)
  const canDeleteFolder = hasRole(user, ...CAN_AUTHOR_ROLES) && (myAccess?.can_review_repository ?? true)
  // Selection is shared workflow infrastructure, not an authoring action.
  // Reviewer-only members need it for bulk recommendation, while Stage 2
  // approvers need it for bulk final approval. Edit/delete controls remain
  // separately gated by canAuthor below.
  const canSelectCases = canAuthor || canReview || canGiveFinalApproval
  const [users, setUsers] = useState<UserOut[]>([])
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [projectId, setProjectId] = useState<number | ''>('')
  const [folders, setFolders] = useState<TestFolderOut[]>([])
  const [cases, setCases] = useState<TestCaseOut[]>([])
  const [selectedFolder, setSelectedFolder] = useState<number | typeof UNFILED | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingCase, setEditingCase] = useState<TestCaseOut | null | 'new'>(null)
  const [search, setSearch] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [folderToDelete, setFolderToDelete] = useState<TestFolderOut | null>(null)
  const [folderAction, setFolderAction] = useState<{ mode: 'move' | 'copy'; folder: TestFolderOut } | null>(null)
  const [folderToRename, setFolderToRename] = useState<TestFolderOut | null>(null)
  // Empty by default (nothing collapsed) so every folder that was always
  // visible under the old flat list stays visible after this change too --
  // collapsing is purely opt-in per folder.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<number>>(new Set())
  const [repositoryStructureCollapsed, setRepositoryStructureCollapsed] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState(false)
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<number>>(new Set())
  const [showBulkUpdate, setShowBulkUpdate] = useState(false)
  const [showBulkDelete, setShowBulkDelete] = useState(false)
  const [showBulkApprove, setShowBulkApprove] = useState(false)
  const [showBulkRecommend, setShowBulkRecommend] = useState(false)
  const [showBulkSubmit, setShowBulkSubmit] = useState(false)
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)
  const [exportingRepository, setExportingRepository] = useState(false)

  async function downloadTemplate() {
    setDownloadingTemplate(true)
    try {
      await api.downloadFile('/api/test-repository/import-template', 'Test Case Import Template.xlsx')
    } catch (err) { setError(err) } finally { setDownloadingTemplate(false) }
  }

  async function exportRepository() {
    if (!projectId || !selectedProject) return
    setExportingRepository(true); setError(null)
    try {
      await api.downloadFile(
        `/api/test-repository/projects/${projectId}/export-xlsx`,
        `${selectedProject.project_key}_test_repository.xlsx`,
      )
    } catch (err) { setError(err) } finally { setExportingRepository(false) }
  }

  useEffect(() => {
    api.get<TestProjectOut[]>('/api/test-projects?include_inactive=true').then((p) => {
      setProjects(p)
      const requested = Number(searchParams.get('project'))
      if (p.length && !projectId) setProjectId(p.some((x) => x.id === requested) ? requested : p[0].id)
    }).catch(setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Author-tier approver assignment (PATCH .../approvers) needs a user
  // picker, same SearchableSelect-over-user-list pattern TestProjects.tsx
  // uses for its own Owner/Default Reviewer/Default QA Lead pickers -- both
  // scoped to constants.TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS via the
  // dedicated /api/test-projects/eligible-users endpoint, not the app-wide
  // /api/auth/users list every other module uses.
  useEffect(() => {
    api.get<UserOut[]>('/api/test-projects/eligible-users').then(setUsers).catch(() => setUsers([]))
  }, [])

  const loadProjectData = useCallback(async (pid: number) => {
    try {
      const [f, c] = await Promise.all([
        api.get<TestFolderOut[]>(`/api/test-repository/projects/${pid}/folders`),
        api.get<TestCaseOut[]>(`/api/test-repository/projects/${pid}/test-cases`),
      ])
      setFolders(f); setCases(c)
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    setSelectedCaseIds(new Set())
    if (projectId) loadProjectData(projectId)
  }, [projectId, loadProjectData])

  useEffect(() => {
    if (!projectId) { setMyAccess(null); return }
    let active = true
    api.get<TestProjectMyAccessOut>(`/api/test-projects/${projectId}/my-access`)
      .then((access) => { if (active) setMyAccess(access) })
      .catch(() => { if (active) setMyAccess(null) })
    return () => { active = false }
  }, [projectId])

  // Global Search deep-link: resolve the business ID independently of the
  // currently selected repository project, switch to its real project, and
  // open the test-case editor/details modal immediately.
  useEffect(() => {
    const openKey = searchParams.get('open')?.trim()
    if (!openKey) return
    let active = true
    api.get<TestCaseOut>(`/api/test-repository/test-cases/by-key/${encodeURIComponent(openKey)}`)
      .then((testCase) => {
        if (!active) return
        setProjectId(testCase.project_id)
        setSelectedFolder(testCase.folder_id || UNFILED)
        setSearch(testCase.test_case_key)
        setEditingCase(testCase)
        setSearchParams((params) => { params.delete('open'); return params }, { replace: true })
      })
      .catch((err) => { if (active) setError(err) })
    return () => { active = false }
  }, [searchParams, setSearchParams])

  const visibleCases = useMemo(() => {
    let rows = selectedFolder === '' ? cases : selectedFolder === UNFILED
      ? cases.filter((c) => !c.folder_id)
      : cases.filter((c) => c.folder_id === selectedFolder)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter((c) => [c.test_case_key, c.test_scenario, c.epic_id, c.cr_number, c.feature_id, c.user_story_id, c.module_name, ...(c.tags || [])].some((v) => String(v || '').toLowerCase().includes(q)))
    if (priorityFilter) rows = rows.filter((c) => c.priority === priorityFilter)
    if (statusFilter) rows = rows.filter((c) => c.status === statusFilter)
    if (tagFilter) rows = rows.filter((c) => (c.tags || []).some((tag) => tag.toLowerCase() === tagFilter.toLowerCase()))
    return rows
  }, [cases, selectedFolder, search, priorityFilter, statusFilter, tagFilter])

  const availableTags = useMemo(() => Array.from(new Set(cases.flatMap((testCase) => testCase.tags || []))).sort((a, b) => a.localeCompare(b)), [cases])

  const folderCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    cases.forEach((c) => { if (c.folder_id) counts[c.folder_id] = (counts[c.folder_id] || 0) + 1 })
    return counts
  }, [cases])
  const unfiledCount = cases.filter((c) => !c.folder_id).length
  const folderTree = useMemo(() => buildFolderTree(folders), [folders])
  const selectedProject = projects.find((project) => project.id === projectId)
  const projectIsActive = !!selectedProject?.is_active
  const selectedCount = selectedCaseIds.size
  const selectedCases = cases.filter((testCase) => selectedCaseIds.has(testCase.id))
  const selectedCasesIncludeWorkflowLock = selectedCases.some(
    (testCase) => testCase.status === 'In Review' || testCase.status === 'Review Completed',
  )
  const canBulkUpdateAssignments = canAuthor && selectedCases.length > 0 && selectedCases.every(
    (testCase) => testCase.current_draft_author_id === user?.id
      && !['Approved', 'Rejected', 'Archived'].includes(testCase.status),
  )
  const canBulkUpdateTestcaseFields = canAuthor && !selectedCasesIncludeWorkflowLock
  const canOpenBulkUpdate = canBulkUpdateAssignments || canBulkUpdateTestcaseFields
  // Stage 1 (Reviewer) bulk-recommend only acts on "In Review" rows; Stage 2
  // (QA Lead) bulk-approve now acts on "Review Completed" rows instead
  // (previously acted on "In Review" -- see BulkApproveModal invocation below).
  const recommendSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id)
    && testCase.status === 'In Review' && testCase.current_draft_author_id !== user?.id
    && (testCase.pending_with_user_id === user?.id || hasRole(user, 'ADMIN'))).map((testCase) => testCase.id)
  const finalApproveSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id)
    && testCase.status === 'Review Completed' && testCase.current_draft_author_id !== user?.id
    && (testCase.pending_with_user_id === user?.id || hasRole(user, 'ADMIN'))).map((testCase) => testCase.id)
  const submittableSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id)
    && (testCase.status === 'Draft' || testCase.status === 'Returned')).map((testCase) => testCase.id)
  const allVisibleSelected = visibleCases.length > 0 && visibleCases.every((testCase) => selectedCaseIds.has(testCase.id))
  const selectedFolderRecord = typeof selectedFolder === 'number' ? folders.find((folder) => folder.id === selectedFolder) : undefined
  const currentViewTitle = selectedFolder === ''
    ? 'All test cases'
    : selectedFolder === UNFILED
      ? 'Unfiled test cases'
      : selectedFolderRecord?.name || 'Selected folder'
  const currentViewDescription = selectedFolderRecord
    ? folderPathLabel(folders, selectedFolderRecord)
    : selectedFolder === UNFILED
      ? 'Cases that have not yet been assigned to a repository folder.'
      : 'Complete repository coverage across every folder and sub-folder.'

  function toggleSelected(id: number) {
    setSelectedCaseIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelectedCaseIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleCases.forEach((testCase) => next.delete(testCase.id))
      else visibleCases.forEach((testCase) => next.add(testCase.id))
      return next
    })
  }

  async function bulkDelete() {
    if (!projectId || selectedCount === 0) return
    setBulkDeleteBusy(true); setError(null)
    try {
      await api.post(`/api/test-repository/projects/${projectId}/test-cases/bulk-delete`, { ids: Array.from(selectedCaseIds) })
      setCases((prev) => prev.filter((testCase) => !selectedCaseIds.has(testCase.id)))
      setSelectedCaseIds(new Set())
      setShowBulkDelete(false)
    } catch (err) { setError(err); setShowBulkDelete(false) } finally { setBulkDeleteBusy(false) }
  }

  function toggleCollapsed(id: number) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Row-level quick actions for the Lock column below -- same checkout/
  // check-in endpoints the modal's own "Checkout" field calls, just
  // reachable without opening a test case at all.
  async function checkoutCase(id: number) {
    setError(null)
    try {
      const updated = await api.post<TestCaseOut>(`/api/test-repository/test-cases/${id}/checkout`)
      setCases((prev) => prev.map((c) => (c.id === id ? updated : c)))
      setEditingCase(updated)
    } catch (err) { setError(err) }
  }

  async function checkinCase(id: number) {
    setError(null)
    try {
      const updated = await api.post<TestCaseOut>(`/api/test-repository/test-cases/${id}/checkin`)
      setCases((prev) => prev.map((c) => (c.id === id ? updated : c)))
    } catch (err) { setError(err) }
  }

  async function deleteFolder() {
    if (!folderToDelete) return
    const folder = folderToDelete
    setError(null)
    setDeletingFolder(true)
    try {
      await api.del(`/api/test-repository/folders/${folder.id}`)
      setFolders((prev) => prev.filter((f) => f.id !== folder.id))
      if (selectedFolder === folder.id) setSelectedFolder('')
      setFolderToDelete(null)
    } catch (err) { setError(err); setFolderToDelete(null) } finally { setDeletingFolder(false) }
  }

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        title="Test Repository" count={cases.length}
        subtitle="Design and organize reusable test cases using the Epic → Feature → Story hierarchy from your Excel template."
        actions={canAuthor && projectId && projectIsActive ? (
          <button className="btn btn-primary tm-new-test-case" onClick={() => setEditingCase('new')}>+ New Test Case</button>
        ) : undefined}
      />
      <div className="tm-repository-commandbar">
        <div className="tm-repository-project-picker">
          <div>
            <small>Repository project</small>
            <strong>{selectedProject?.name || 'Choose a project'}</strong>
          </div>
          <div className="tm-repository-project-select">
            <SearchableSelect
              value={projectId === '' ? '' : String(projectId)}
              onChange={(v) => { setProjectId(v ? Number(v) : ''); setSelectedFolder('') }}
              placeholder={projects.length === 0 ? 'No Test Projects yet' : 'Select a project...'}
              options={projects.map((p) => ({
                value: String(p.id),
                label: `${p.project_key} -- ${p.name}${p.is_active ? '' : ' [Inactive]'}`,
              }))}
            />
          </div>
          {selectedProject && <span className={`tm-project-state ${projectIsActive ? 'active' : 'inactive'}`}>{projectIsActive ? 'Active' : 'Inactive'}</span>}
        </div>
        <div className="tm-repository-command-actions">
          <button className="btn" onClick={downloadTemplate} disabled={downloadingTemplate}>
            {downloadingTemplate ? 'Downloading…' : 'Download Template'}
          </button>
          <button className="btn" onClick={exportRepository} disabled={!projectId || exportingRepository}>
            {exportingRepository ? 'Exporting…' : 'Export Repository'}
          </button>
          {canAuthor && projectId && projectIsActive && (
            <>
              <button className="btn" onClick={() => setShowNewFolder(true)}>+ New Folder</button>
              <button className="btn" onClick={() => setShowImport(true)}>Import Excel</button>
            </>
          )}
        </div>
      </div>
      {projectId && !projectIsActive && (
        <div className="tm-workflow-banner inactive"><span>!</span><div><strong>Project is inactive</strong><p>Repository content remains available for review, but changes are disabled until the project is reactivated.</p></div></div>
      )}
      {projectId && projectIsActive && (
        <div className="tm-workflow-banner"><span>✓</span><div><strong>Governed test-case workflow</strong><p>QA Tester creates or imports a Draft → Author submits for review → Reviewer recommends → QA Lead approves → approved testcases become available in Test Cycles.</p></div></div>
      )}
      {projectId && (
        <div className={`tm-workspace${repositoryStructureCollapsed ? ' tree-collapsed' : ''}`}>
          <aside className="tm-tree-panel">
            <div className="tm-tree-heading">
              {!repositoryStructureCollapsed && <div><small>Repository structure</small><strong>Folders</strong></div>}
              {!repositoryStructureCollapsed && <span className="tm-tree-count">{folders.length}</span>}
              <button
                type="button"
                className="tm-tree-collapse"
                onClick={() => setRepositoryStructureCollapsed((collapsed) => !collapsed)}
                aria-expanded={!repositoryStructureCollapsed}
                aria-label={repositoryStructureCollapsed ? 'Expand repository structure' : 'Collapse repository structure'}
                title={repositoryStructureCollapsed ? 'Expand repository structure' : 'Collapse repository structure'}
              >{repositoryStructureCollapsed ? '›' : '‹'}</button>
            </div>
            {!repositoryStructureCollapsed && <ul className="plain-list">
              <li>
                <button className={`link-btn ${selectedFolder === '' ? 'active' : ''}`} onClick={() => setSelectedFolder('')}>
                  <span>▦</span> All test cases <em>{cases.length}</em>
                </button>
              </li>
              <li>
                <button className={`link-btn ${selectedFolder === UNFILED ? 'active' : ''}`} onClick={() => setSelectedFolder(UNFILED)}>
                  <span>◇</span> Unfiled <em>{unfiledCount}</em>
                </button>
              </li>
              <FolderTreeRows
                nodes={folderTree}
                selectedFolder={selectedFolder}
                onSelect={setSelectedFolder}
                folderCounts={folderCounts}
                collapsedFolders={collapsedFolders}
                onToggleCollapse={toggleCollapsed}
                canAuthor={canAuthor}
                canDeleteFolder={canDeleteFolder}
                projectIsActive={projectIsActive}
                onDeleteRequest={setFolderToDelete}
                onCopyRequest={(f) => setFolderAction({ mode: 'copy', folder: f })}
                onMoveRequest={(f) => setFolderAction({ mode: 'move', folder: f })}
                onRenameRequest={setFolderToRename}
              />
            </ul>}
            {!repositoryStructureCollapsed && canAuthor && projectIsActive && <button className="tm-tree-add" onClick={() => setShowNewFolder(true)}>+ Add folder</button>}
          </aside>
          <section className="tm-main-panel">
            <div className="tm-current-view">
              <div>
                <small>Current view</small>
                <h3>{currentViewTitle}</h3>
                <p>{currentViewDescription}</p>
              </div>
              <span>{visibleCases.length} test case{visibleCases.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="tm-repository-summary">
              <div><small>Test cases</small><strong>{cases.length}</strong></div>
              <div><small>Approved</small><strong>{cases.filter((c) => !!c.current_approved_version_id).length}</strong></div>
              <div><small>Pending review</small><strong>{cases.filter((c) => c.status === 'In Review').length}</strong></div>
              <div><small>Critical</small><strong>{cases.filter((c) => c.priority === 'Critical').length}</strong></div>
            </div>
            <div className="tm-list-toolbar">
              <ClearableSearchInput value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} clearLabel="Clear test case search" wrapperClassName="search-grow" placeholder="Search cases, epics, features, or stories…" />
              <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}><option value="">All priorities</option>{TEST_CASE_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All statuses</option>{TEST_CASE_STATUSES.map((s) => <option key={s} value={s}>{TEST_CASE_STATUS_LABELS[s] || s}</option>)}</select>
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}><option value="">All tags</option>{availableTags.map((tag) => <option key={tag}>{tag}</option>)}</select>
              {canReview && (
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === 'In Review' ? 'btn-primary' : ''}`}
                  onClick={() => setStatusFilter(statusFilter === 'In Review' ? '' : 'In Review')}
                >
                  Review queue ({cases.filter((c) => c.status === 'In Review').length})
                </button>
              )}
              {canGiveFinalApproval && (
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === 'Review Completed' ? 'btn-primary' : ''}`}
                  onClick={() => setStatusFilter(statusFilter === 'Review Completed' ? '' : 'Review Completed')}
                >
                  Final approval queue ({cases.filter((c) => c.status === 'Review Completed').length})
                </button>
              )}
              <span>{visibleCases.length} result{visibleCases.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="tm-checkout-guide" role="note" aria-label="How test case editing access works">
              <span className="tm-checkout-guide-icon">↔</span>
              <div>
                <strong>Safe editing</strong>
                <p><b>Start editing</b> reserves and opens the test case for you. When finished, use <b>Finish editing</b> to release it for another QA user.</p>
              </div>
            </div>
            {selectedCount > 0 && canSelectCases && projectIsActive && (
              <div className="tm-bulk-bar" role="region" aria-label="Bulk test case actions">
                <strong>{selectedCount} test case{selectedCount !== 1 ? 's' : ''} selected</strong>
                {canAuthor && submittableSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkSubmit(true)}>Submit for review ({submittableSelectedIds.length})</button>}
                {canReview && recommendSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkRecommend(true)}>Bulk recommend pending ({recommendSelectedIds.length})</button>}
                {canGiveFinalApproval && finalApproveSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkApprove(true)}>Bulk approve pending ({finalApproveSelectedIds.length})</button>}
                {canOpenBulkUpdate && <button className="btn btn-sm" onClick={() => setShowBulkUpdate(true)}>Bulk update</button>}
                {canAuthor && <button className="btn btn-sm btn-danger" onClick={() => setShowBulkDelete(true)}>Bulk delete</button>}
                <button className="btn btn-sm" onClick={() => setSelectedCaseIds(new Set())}>Clear selection</button>
              </div>
            )}
            <Table
              rowKey="id"
              onRowClick={(c) => setEditingCase(c)}
              columns={[
                {
                  key: 'selection',
                  header: canSelectCases && projectIsActive ? (
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      aria-label={allVisibleSelected ? 'Deselect all filtered test cases' : 'Select all filtered test cases'}
                    />
                  ) : null,
                  render: (c) => canSelectCases && projectIsActive ? (
                    <span onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedCaseIds.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                        aria-label={`Select ${c.test_case_key}`}
                      />
                    </span>
                  ) : null,
                  filterable: false,
                },
                { key: 'test_case_key', header: 'Test Case', render: (c) => <span className="tm-test-case-cell"><strong>{c.test_case_key}</strong><small>{c.test_scenario || 'Scenario not provided'}{c.module_name ? ` · ${c.module_name}` : ''}</small></span>, filterValue: (c) => `${c.test_case_key} ${c.test_scenario || ''} ${c.module_name || ''}` },
                { key: 'epic_id', header: 'Epic / CR / Story', render: (c) => <span className="tm-hierarchy-cell"><strong>{c.epic_id || '—'}</strong><small>{[c.cr_number, c.feature_id, c.user_story_id].filter(Boolean).join(' · ') || 'No mapping'}</small></span>, filterValue: (c) => `${c.epic_id || ''} ${c.cr_number || ''} ${c.feature_id || ''} ${c.user_story_id || ''}` },
                { key: 'classification', header: 'Type / Priority', render: (c) => <span className="tm-classification-cell"><strong>{c.test_type || '—'}</strong>{c.priority ? <Badge status={c.priority} /> : <small>No priority</small>}</span>, filterValue: (c) => `${c.test_type || ''} ${c.priority || ''}` },
                { key: 'tags', header: 'Tags', render: (c) => <span className="tm-case-tags">{(c.tags || []).length ? c.tags.map((tag) => <button type="button" key={tag} onClick={(event) => { event.stopPropagation(); setTagFilter(tag) }}>{tag}</button>) : <small>—</small>}</span>, filterValue: (c) => (c.tags || []).join(' ') },
                { key: 'status', header: 'Workflow', render: (c) => {
                  // Prefer the real assignee (APR-006) over the static
                  // status->role fallback map; surface pending_since too so
                  // SLA aging is visible without opening the record.
                  const pendingWithLabel = c.pending_with_user_name || TEST_CASE_PENDING_WITH[c.status]
                  return (
                    <span className="tm-workflow-cell">
                      <Badge status={c.status} label={TEST_CASE_STATUS_LABELS[c.status] || c.status} />
                      <small>{pendingWithLabel ? `Pending with ${pendingWithLabel}` : 'No action pending'}</small>
                      {c.pending_since && (
                        <small className="muted" title={`Pending since ${new Date(c.pending_since).toLocaleString()}`}>
                          Since {new Date(c.pending_since).toLocaleDateString()}
                        </small>
                      )}
                    </span>
                  )
                }, filterValue: (c) => `${TEST_CASE_STATUS_LABELS[c.status] || c.status} ${c.pending_with_user_name || TEST_CASE_PENDING_WITH[c.status] || ''}` },
                { key: 'version', header: 'Version', render: (c) => <span className="badge badge-gray">{`v${c.version || '1.0'}`}</span>, filterValue: (c) => `v${c.version || '1.0'}` },
                { key: 'steps', header: 'Steps', render: (c) => c.steps.length, filterable: false },
                {
                  key: 'checkout',
                  header: 'Editing access',
                  render: (c) => {
                    const lockedByMe = c.checked_out_by_id === user?.id
                    const lockedByOther = !!c.checked_out_by_id && !lockedByMe
                    const reviewLocked = TEST_CASE_PENDING_DECISION_STATUSES.includes(c.status)
                    if (reviewLocked) {
                      return (
                        <span className="tm-checkout-control" onClick={(event) => event.stopPropagation()}>
                          <span className="tm-checkout-state is-review-locked"><strong>Review in progress</strong><small>Editing unlocks after the pending decision</small></span>
                          {canAuthor && projectIsActive && <button className="btn btn-sm tm-checkout-button" disabled title="Editing is locked while an approval decision is pending">Start editing</button>}
                        </span>
                      )
                    }
                    if (!canAuthor || !projectIsActive) {
                      return c.checked_out_by_id
                        ? <span className="tm-checkout-state is-other"><strong>Being edited</strong><small>Checked out by {c.checked_out_by_name || 'another user'}</small></span>
                        : <span className="tm-checkout-state is-available"><strong>Available</strong><small>Not checked out</small></span>
                    }
                    return (
                      <span className="tm-checkout-control" onClick={(e) => e.stopPropagation()}>
                        {lockedByOther ? (
                          <span className="tm-checkout-state is-other">
                            <strong>Being edited</strong>
                            <small>Checked out by {c.checked_out_by_name || 'another user'}</small>
                          </span>
                        ) : lockedByMe ? (
                          <>
                            <span className="tm-checkout-state is-mine"><strong>Reserved by you</strong><small>Editing is currently locked to you</small></span>
                            <button className="btn btn-sm tm-checkin-button" title="Check in and release this test case for other QA users" onClick={() => checkinCase(c.id)}>Finish editing</button>
                          </>
                        ) : (
                          <>
                            <span className="tm-checkout-state is-available"><strong>Available to edit</strong><small>No one has reserved this case</small></span>
                            <button className="btn btn-sm tm-checkout-button" title="Check out, reserve, and open this test case" onClick={() => checkoutCase(c.id)}>Start editing</button>
                          </>
                        )}
                      </span>
                    )
                  },
                  filterable: false,
                },
              ]}
              rows={visibleCases}
            />
          </section>
        </div>
      )}
      {showNewFolder && projectId && projectIsActive && (
        <NewFolderModal
          projectId={projectId}
          folders={folders}
          onClose={() => setShowNewFolder(false)}
          onCreated={(f) => { setFolders((prev) => [...prev, f]); setShowNewFolder(false) }}
        />
      )}
      {showImport && projectId && projectIsActive && (
        <ImportModal
          projectId={projectId}
          folders={folders}
          folderId={typeof selectedFolder === 'number' ? selectedFolder : ''}
          onClose={() => setShowImport(false)}
          onImported={() => loadProjectData(projectId)}
        />
      )}
      {showBulkUpdate && projectId && projectIsActive && (
        <BulkUpdateModal
          projectId={projectId}
          selectedCases={selectedCases}
          folders={folders}
          users={users}
          canUpdateAssignments={canBulkUpdateAssignments}
          onClose={() => setShowBulkUpdate(false)}
          onUpdated={(updated) => {
            const updatedById = new Map(updated.map((testCase) => [testCase.id, testCase]))
            setCases((prev) => prev.map((testCase) => updatedById.get(testCase.id) || testCase))
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkApprove && projectId && projectIsActive && (
        <BulkApproveModal
          projectId={projectId}
          selectedIds={finalApproveSelectedIds}
          onClose={() => setShowBulkApprove(false)}
          onApproved={(approved, approvedIds) => {
            const approvedById = new Map(approved.map((testCase) => [testCase.id, testCase]))
            setCases((prev) => prev.map((testCase) => approvedById.get(testCase.id) || testCase))
            setSelectedCaseIds((prev) => {
              const next = new Set(prev)
              approvedIds.forEach((id) => next.delete(id))
              return next
            })
          }}
        />
      )}
      {showBulkRecommend && projectId && selectedProject && projectIsActive && (
        <BulkRecommendModal
          project={selectedProject}
          selectedCases={cases.filter((testCase) => recommendSelectedIds.includes(testCase.id))}
          users={users}
          onClose={() => setShowBulkRecommend(false)}
          onRecommended={(recommended, recommendedIds) => {
            const recommendedById = new Map(recommended.map((testCase) => [testCase.id, testCase]))
            setCases((prev) => prev.map((testCase) => recommendedById.get(testCase.id) || testCase))
            setSelectedCaseIds((prev) => {
              const next = new Set(prev)
              recommendedIds.forEach((id) => next.delete(id))
              return next
            })
          }}
        />
      )}
      {showBulkSubmit && projectId && selectedProject && projectIsActive && (
        <BulkSubmitModal
          project={selectedProject}
          selectedCases={cases.filter((testCase) => submittableSelectedIds.includes(testCase.id))}
          users={users}
          onClose={() => setShowBulkSubmit(false)}
          onSubmitted={(submitted, submittedIds) => {
            const submittedById = new Map(submitted.map((testCase) => [testCase.id, testCase]))
            setCases((prev) => prev.map((testCase) => submittedById.get(testCase.id) || testCase))
            setSelectedCaseIds((prev) => {
              const next = new Set(prev)
              submittedIds.forEach((id) => next.delete(id))
              return next
            })
          }}
        />
      )}
      {showBulkDelete && selectedCount > 0 && (
        <ConfirmModal
          title={`Delete ${selectedCount} test case${selectedCount !== 1 ? 's' : ''}?`}
          message={<div><p>This will permanently delete the selected test cases.</p><p className="muted small">Their steps and linked execution results will also be removed. This action cannot be undone.</p></div>}
          confirmLabel={`Delete ${selectedCount} test case${selectedCount !== 1 ? 's' : ''}`}
          cancelLabel="Keep test cases"
          destructive
          busy={bulkDeleteBusy}
          onConfirm={bulkDelete}
          onCancel={() => setShowBulkDelete(false)}
        />
      )}
      {editingCase && projectId && (
        <TestCaseModal
          projectId={projectId}
          allProjects={projects}
          folders={folders}
          folderId={typeof selectedFolder === 'number' ? selectedFolder : ''}
          existing={editingCase === 'new' ? null : editingCase}
          users={users}
          canAuthor={canAuthor && projectIsActive}
          canReview={canReview && projectIsActive}
          canGiveFinalApproval={canGiveFinalApproval && projectIsActive}
          onClose={() => setEditingCase(null)}
          onSaved={(tc) => {
            setCases((prev) => {
              const exists = prev.some((c) => c.id === tc.id)
              return exists ? prev.map((c) => (c.id === tc.id ? tc : c)) : [tc, ...prev]
            })
            setEditingCase(null)
          }}
          onDeleted={(id) => { setCases((prev) => prev.filter((c) => c.id !== id)); setEditingCase(null) }}
          onReviewed={(tc) => {
            setCases((prev) => prev.map((c) => (c.id === tc.id ? tc : c)))
            setEditingCase(null)
          }}
          onCheckoutChange={(tc) => {
            setCases((prev) => prev.map((c) => (c.id === tc.id ? tc : c)))
            setEditingCase(tc)
          }}
        />
      )}
      {folderToDelete && (
        <ConfirmModal
          title={`Delete ${folderToDelete.parent_id ? 'sub-folder' : 'folder'}?`}
          message={<div><p>Delete <strong>{folderToDelete.name}</strong> from this repository?</p><p className="muted small">Only empty folders can be deleted. Test cases and child folders will never be removed automatically.</p></div>}
          confirmLabel="Delete folder" cancelLabel="Keep folder" destructive busy={deletingFolder}
          onConfirm={deleteFolder} onCancel={() => setFolderToDelete(null)}
        />
      )}
      {folderAction && projectId && (
        <FolderMoveCopyModal
          mode={folderAction.mode}
          folder={folderAction.folder}
          folders={folders}
          onClose={() => setFolderAction(null)}
          onDone={() => { setFolderAction(null); loadProjectData(projectId) }}
        />
      )}
      {folderToRename && (
        <RenameFolderModal
          folder={folderToRename}
          onClose={() => setFolderToRename(null)}
          onRenamed={(f) => {
            setFolders((prev) => prev.map((folder) => folder.id === f.id ? f : folder))
            setFolderToRename(null)
          }}
        />
      )}
    </div>
  )
}
