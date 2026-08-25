import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, waitForJob } from '../../api'
import { formatDateIST, formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { Table, Modal, Field, ErrorText, PageHeader, Badge, InfoTooltip, WorkflowDecisionPanel } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import {
  hasRole, TEST_CASE_TYPES, TEST_CASE_CURRENT_STATUSES, TEST_CASE_STATUS_LABELS, TEST_CASE_PENDING_WITH, TEST_CASE_PRIORITIES,
  TEST_CASE_PENDING_DECISION_STATUSES, TEST_CASE_TERMINAL_STATUSES, TEST_CASE_REVIEW_ACTION_LABELS,
  TEST_CASE_REVIEW_MANDATORY_COMMENT_DECISIONS, QA_LEAD_GROUP_ROLES, selectionActionLabel, selectionActionPhrase,
} from '../../constants'
import {
  TestProjectOut, TestFolderOut, TestCaseOut, TestCaseListOut, TestCaseSummaryOut, TestStepIn, TestCaseImportResult, ApprovalActionOut,
  TestCaseVersionSummary, TestCaseVersionCompareOut, TestProjectMyAccessOut, TestCaseVersionOut,
  TestCaseReviewDecision, TestCaseBulkRecommendIn, UserOut, PageOut,
} from '../../types'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import ClearableSearchInput from '../../components/ClearableSearchInput'
import LinkedDefects from '../../components/LinkedDefects'
import RoleGroupLink from '../../components/RoleGroupLink'
import { usePaginatedList } from '../../hooks/usePaginatedList'

// 2026-08 "Simplified Test Management" NEW-path group-pending statuses --
// reported directly: "show the group name where pending approval, on click
// of group name, members will be visible" -- maps each NEW-path
// group-routed status to the system role(s) RoleGroupLink should filter its
// member list to (same component/pattern Functional.tsx/SAST.tsx/etc.
// already use for "Assigned Group"). OLD-path "In Review"/"Review
// Completed" are deliberately NOT included -- eligibility there is role OR
// project membership (can_review_repository/can_give_final_approval), which
// a role-only member list would misrepresent; those keep their existing
// plain-text label.
const TEST_CASE_PENDING_GROUP_ROLES: Record<string, string | string[]> = {
  'Recommendation Pending': 'QA_ENGINEER',
  'QA Lead Approval Pending': QA_LEAD_GROUP_ROLES,
}

// Test Repository module -- folder tree + test case authoring/import, under
// a selected Test Project. QA Engineer + QA Lead both author (create/edit/
// import/delete); everyone with portal access can browse/read (Admin
// bypasses the author gate automatically via hasRole).
const CAN_AUTHOR_ROLES = ['QA_ENGINEER', 'QA_LEAD', 'CHIEF_MANAGER_QA', 'AGM_QA']
const UNFILED = '__unfiled__'
// 2026-08 "Create Recycle bin and Archive folder" requirement -- two more
// pinned pseudo-folder sentinels alongside UNFILED above, same mechanic:
// not real TestFolder rows, just special selectedFolder values the main
// list's own data-fetching branches on. ARCHIVE_VIEW is a flat,
// project-wide "every Archived testcase regardless of its real folder"
// view (status=Archived under the hood, on the existing paginated list
// endpoint); RECYCLE_BIN routes to its own dedicated endpoint entirely,
// since a soft-deleted case is excluded from every normal query and has no
// status/folder scoping worth offering.
const ARCHIVE_VIEW = '__archived__'
const RECYCLE_BIN = '__recycle_bin__'
// Quick-filter tokens for the "Review queue"/"Final approval queue" buttons
// below -- each one expands to BOTH the OLD-path and NEW-path status for
// that stage, matching TestCaseSummaryOut's own in_review_count/
// review_completed_count (backend test_repository.py), which count both
// generations together under the same field. Not real status values (never
// sent as-is to the backend -- see the usePaginatedList status: mapping).
const REVIEW_QUEUE_TOKEN = '__review_queue__'
const REVIEW_QUEUE_STATUSES = ['In Review', 'Recommendation Pending']
const FINAL_APPROVAL_QUEUE_TOKEN = '__final_approval_queue__'
const FINAL_APPROVAL_QUEUE_STATUSES = ['Review Completed', 'QA Lead Approval Pending']

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
    // 2026-08 "Simplified Test Management Review and Approval" requirement --
    // NEW-path statuses (any fresh Draft submission, or a NEW-vocabulary
    // Returned status resubmitting). Stage 1 routes to the QA Group
    // (QA_ENGINEER), Stage 2 to the QA Lead Group (QA_LEAD/CHIEF_MANAGER_QA/
    // AGM_QA) -- no individual reviewer/QA-Lead assignment either way.
    case 'Recommendation Pending':
      return 'Submitted -- awaiting a QA Group recommendation.'
    case 'QA Lead Approval Pending':
      return "Recommended by the QA Group -- awaiting the QA Lead Group's final decision."
    case 'Returned by QA':
    case 'Returned by QA Lead':
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
  selectedFolder: number | typeof UNFILED | typeof ARCHIVE_VIEW | typeof RECYCLE_BIN | ''
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
      // Reported directly: "while uploading testcase from excel, though it's
      // saying api timeout 30 sec, but actually upload completed, still
      // showing error." A large workbook (many test cases, each with
      // several step rows) can legitimately take longer than api.ts's
      // default 30s budget to parse and create -- the browser was aborting
      // the request and showing a timeout error for an import that kept
      // running server-side and actually succeeded. 3 minutes gives a
      // realistically large workbook enough room without ever getting to
      // that false-negative state; see api.uploadForm's own timeoutMs param.
      const queued = await api.uploadForm<{ id: string }>(
        `/api/test-repository/projects/${projectId}/import-xlsx/jobs`,
        { file, folder_id: targetFolder ? String(targetFolder) : undefined },
      )
      setProgressMessage('Import queued; processing rows in the background…')
      const completed = await waitForJob<TestCaseImportResult>(queued.id)
      const res = completed.result!
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
          <textarea required aria-label={`Step ${i + 1}`} placeholder="Step *" value={s.step_text || ''} onChange={(e) => update(i, 'step_text', e.target.value)} style={{ flex: 1 }} />
          <textarea required aria-label={`Expected Result ${i + 1}`} placeholder="Expected Result *" value={s.expected_result || ''} onChange={(e) => update(i, 'expected_result', e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" onClick={() => remove(i)}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={add}>+ Add Step</button>
    </div>
  )
}

// Spec section 9 -- every review decision's confirmation must state the
// RESULTING status and WHO owns it next, not just what button was clicked.
function reviewDecisionOutcome(decision: TestCaseReviewDecision, currentStatus?: string): string {
  switch (decision) {
    case 'RECOMMEND':
      return currentStatus === 'Recommendation Pending'
        ? "Moves to QA Lead Approval Pending, awaiting the QA Lead Group's final decision."
        : "Moves to Review Completed, awaiting the QA Lead's final decision."
    case 'APPROVE':
      return currentStatus === 'In Review'
        ? 'Completes Stage 1 and routes the test case to the shared CM QA / AGM QA approval queue.'
        : 'The test case becomes Approved and is immediately available for Test Cycles.'
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
function TestCaseReviewModal({ testCase, decision, onClose, onReviewed }: {
  testCase: TestCaseOut
  decision: TestCaseReviewDecision
  onClose: () => void
  onReviewed: (testCase: TestCaseOut) => void
}) {
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
        <p><strong>Result:</strong> {reviewDecisionOutcome(decision, testCase.status)}</p>
        {testCase.status === 'In Review' && decision === 'APPROVE' && <div className="info-banner">Approval will automatically route to all active CM QA and AGM QA users. Either may complete Stage 2.</div>}
        {testCase.status === 'Recommendation Pending' && decision === 'RECOMMEND' && <div className="info-banner">Recommending will automatically route to every active QA Lead Group member (QA Lead, CM QA, or AGM QA). Any of them may complete Stage 2.</div>}
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
          <button className={`btn ${positive ? 'btn-primary' : 'btn-danger'}`} disabled={busy}>
            {busy ? 'Saving decision…' : label}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// 2026-08 -- "Final-Approved Test Case Deletion and Archive Requirement":
// bulk counterpart to the single-case Archive action, alongside Bulk
// delete. Mirrors BulkApproveModal's own confirm/progress/success/error
// shape; reason is mandatory, matching the single-case Archive modal's own
// requirement (see TestCaseArchive's backend docstring).
function BulkArchiveModal({ projectId, selectedIds, onClose, onArchived }: {
  projectId: number
  selectedIds: number[]
  onClose: () => void
  onArchived: (testCases: TestCaseOut[], archivedIds: number[]) => void
}) {
  const [archiveIds] = useState(selectedIds)
  const [reason, setReason] = useState('')
  const [stage, setStage] = useState<'confirm' | 'archiving' | 'success' | 'error'>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)

  async function archive(e?: React.FormEvent) {
    e?.preventDefault()
    if (!reason.trim()) {
      setError(new Error('An archive reason is required'))
      setStage('confirm')
      return
    }
    setError(null)
    setStage('archiving')
    setProgress(10)
    setProgressMessage('Validating approved status…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 60 ? 'Recording the archive action…' : 'Verifying selected testcases…')
        return next
      })
    }, 280)
    try {
      const archived = await api.post<TestCaseOut[]>(`/api/test-repository/projects/${projectId}/test-cases/bulk-archive`, {
        ids: archiveIds,
        reason: reason.trim(),
      })
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${archived.length} testcase${archived.length !== 1 ? 's' : ''} archived`)
      onArchived(archived, archiveIds)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'archiving' ? 'Archiving testcases'
    : stage === 'success' ? `${selectionActionLabel(archiveIds.length, 'archive')} completed`
      : stage === 'error' ? `${selectionActionLabel(archiveIds.length, 'archive')} failed`
        : `Archive ${archiveIds.length} test case${archiveIds.length !== 1 ? 's' : ''}?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={archive}>
          <div className="tm-bulk-confirm-count"><strong>{archiveIds.length}</strong><span>test case{archiveIds.length !== 1 ? 's' : ''} will be archived</span></div>
          <p>The selected test cases will be removed from active lists but their approval history, execution history, attachments, comments, and audit records will be preserved. Restorable at any time by an authorized QA Lead or Admin.</p>
          <Field label="Archive reason *">
            <textarea required rows={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain why these testcases are being archived…" />
          </Field>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary">{archiveIds.length > 1 ? 'Archive all' : 'Archive testcase'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'archiving' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(archiveIds.length, 'archive')} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Archive is being recorded atomically' : 'Archived testcases are now removed from active lists'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was archived</strong>
          <p className="muted small">The {selectionActionPhrase(archiveIds.length, 'archive')} is atomic, so all selected testcases remain Approved.</p>
          <div className="tm-operation-error"><strong>Reason</strong><p>{errorReason}</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => archive()}>Try again</button>
            <button className="btn" onClick={() => { setError(null); setStage('confirm') }}>Edit reason</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
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
    : stage === 'success' ? `${selectionActionLabel(approvalIds.length, 'approval')} completed`
      : stage === 'error' ? `${selectionActionLabel(approvalIds.length, 'approval')} failed`
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
            <button className="btn btn-primary">Verify and approve{approvalIds.length > 1 ? ' all' : ''}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'approving' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(approvalIds.length, 'approval')} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Approval is being recorded atomically' : 'Approved testcases are now available for cycles'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was approved</strong>
          <p className="muted small">The {selectionActionPhrase(approvalIds.length, 'approval')} is atomic, so all selected testcases remain pending.</p>
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
function BulkRecommendModal({ project, selectedCases, onClose, onRecommended }: {
  project: TestProjectOut
  selectedCases: TestCaseListOut[]
  onClose: () => void
  onRecommended: (testCases: TestCaseOut[], recommendedIds: number[]) => void
}) {
  const [recommendCases] = useState(selectedCases)
  const recommendIds = useMemo(() => recommendCases.map((testCase) => testCase.id), [recommendCases])
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
      const body: TestCaseBulkRecommendIn = { ids: recommendIds, comments: comments.trim() || null }
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
    : stage === 'success' ? `${selectionActionLabel(recommendIds.length, 'recommendation')} completed`
      : stage === 'error' ? `${selectionActionLabel(recommendIds.length, 'recommendation')} failed`
        : `Recommend ${recommendIds.length} pending testcase${recommendIds.length !== 1 ? 's' : ''} for approval?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={recommend}>
          <div className="tm-bulk-confirm-count"><strong>{recommendIds.length}</strong><span>pending testcase{recommendIds.length !== 1 ? 's' : ''} will move to Stage 2 final approval</span></div>
          <p>Confirm that the selected definitions and steps have been reviewed. They will await the QA Lead's final decision next -- Recommend does not approve or activate them.</p>
          <div className="info-banner">These test cases will automatically route to the shared approval queue -- CM QA/AGM QA for a testcase already mid-review under the pre-existing workflow, or the whole QA Lead Group for a new submission.</div>
          <Field label="Comments (optional)">
            <textarea rows={4} value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional notes for the QA Lead…" />
          </Field>
          <p className="muted small">This message (if any) will be signed by you and recorded in every selected testcase's activity history.</p>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary">Recommend{recommendIds.length > 1 ? ' all' : ''}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'recommending' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(recommendIds.length, 'recommend')} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Recommendation is being recorded atomically' : 'Recommended testcases now await QA Lead approval'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was recommended</strong>
          <p className="muted small">The {selectionActionPhrase(recommendIds.length, 'recommendation')} is atomic, so all selected testcases remain pending.</p>
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

// 2026-08 -- bulk Return/Reject, the missing bulk counterparts to the
// existing single-case "Recommend Approval / Return for Correction /
// Reject" panel (bulk-recommend/bulk-approve already existed for the first
// of those three). Both share one shape (mandatory reason, atomic, NEW-path
// only), so one component drives both via the `action` prop instead of two
// near-duplicate modals.
function BulkDecisionModal({ action, project, selectedCases, onClose, onDone }: {
  action: 'return' | 'reject'
  project: TestProjectOut
  selectedCases: TestCaseListOut[]
  onClose: () => void
  onDone: (testCases: TestCaseOut[], ids: number[]) => void
}) {
  const [cases] = useState(selectedCases)
  const ids = useMemo(() => cases.map((testCase) => testCase.id), [cases])
  const [comments, setComments] = useState('')
  const [stage, setStage] = useState<'confirm' | 'working' | 'success' | 'error'>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)
  const verb = action === 'return' ? 'return' : 'reject'
  const verbGerund = action === 'return' ? 'Returning' : 'Rejecting'
  const verbPast = action === 'return' ? 'returned' : 'rejected'
  const endpoint = action === 'return' ? 'bulk-return' : 'bulk-reject'

  async function run(e?: React.FormEvent) {
    e?.preventDefault()
    if (!comments.trim()) {
      setError(new Error(`Enter one reason to ${verb} the selected testcases`))
      setStage('confirm')
      return
    }
    setError(null)
    setStage('working')
    setProgress(10)
    setProgressMessage('Validating pending status…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 60 ? `Recording the ${verb} decision…` : 'Verifying selected testcases…')
        return next
      })
    }, 280)
    try {
      const result = await api.post<TestCaseOut[]>(
        `/api/test-repository/projects/${project.id}/test-cases/${endpoint}`,
        { ids, comments: comments.trim() },
      )
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${result.length} testcase${result.length !== 1 ? 's' : ''} ${verbPast}`)
      onDone(result, ids)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'working' ? `${verbGerund} testcases`
    : stage === 'success' ? `${selectionActionLabel(ids.length, verb)} completed`
      : stage === 'error' ? `${selectionActionLabel(ids.length, verb)} failed`
        : `${action === 'return' ? 'Return' : 'Reject'} ${ids.length} pending testcase${ids.length !== 1 ? 's' : ''}?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={run}>
          <div className="tm-bulk-confirm-count"><strong>{ids.length}</strong><span>pending testcase{ids.length !== 1 ? 's' : ''} will be {verbPast}</span></div>
          <p>{action === 'return'
            ? 'Sends each selected testcase back to its author for correction. It leaves the review/approval queue until resubmitted.'
            : 'Terminal decision -- each selected testcase is rejected and leaves the review/approval queue permanently.'}</p>
          <Field label="Reason *">
            <textarea required rows={4} value={comments} onChange={(e) => setComments(e.target.value)} placeholder={`Explain why these testcases are being ${verbPast}…`} />
          </Field>
          <p className="muted small">This one reason will be signed by you and recorded in every selected testcase's activity history.</p>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className={`btn ${action === 'reject' ? 'btn-danger' : 'btn-primary'}`}>{action === 'return' ? `Return${ids.length > 1 ? ' all' : ''}` : `Reject${ids.length > 1 ? ' all' : ''}`}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'working' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(ids.length, verb)} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? `${verbGerund} is being recorded atomically` : `Testcases have been ${verbPast}`}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was {verbPast}</strong>
          <p className="muted small">The {selectionActionPhrase(ids.length, verb)} is atomic, so all selected testcases remain pending.</p>
          <div className="tm-operation-error"><strong>Reason</strong><p>{errorReason}</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => run()}>Try again</button>
            <button className="btn" onClick={() => { setError(null); setStage('confirm') }}>Edit reason</button>
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
function BulkSubmitModal({ project, selectedCases, onClose, onSubmitted }: {
  project: TestProjectOut
  selectedCases: TestCaseListOut[]
  onClose: () => void
  onSubmitted: (testCases: TestCaseOut[], submittedIds: number[]) => void
}) {
  const [submitCases] = useState(selectedCases)
  const submitIds = useMemo(() => submitCases.map((testCase) => testCase.id), [submitCases])
  const [note, setNote] = useState('')
  const [stage, setStage] = useState<'confirm' | 'submitting' | 'success' | 'error'>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)


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
    : stage === 'success' ? `${selectionActionLabel(submitIds.length, 'submit')} completed`
      : stage === 'error' ? `${selectionActionLabel(submitIds.length, 'submit')} failed`
        : `Submit ${submitIds.length} testcase${submitIds.length !== 1 ? 's' : ''} for review?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={doSubmit}>
          <div className="tm-bulk-confirm-count"><strong>{submitIds.length}</strong><span>Draft / Returned testcase{submitIds.length !== 1 ? 's' : ''} will move to review</span></div>
          <p>If any selected testcase isn't ready, none of them are submitted.</p>
          <div className="info-banner">Stage 1 is assigned to the QA Lead for existing reviews or the QA Group for new submissions. 
            Stage 2 goes to CM/AGM QA or the QA Lead Group, respectively.</div>
          <p className="muted small">Group routing sends work to the appropriate approval queue -- there's no individual reviewer/QA Lead to assign. The testcase author is excluded from acting on their own submission at every stage.</p>
          <Field label="Note for the Reviewer (optional)">
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional context shared on every selected testcase…" />
          </Field>
          <p className="muted small">This note (if any) is recorded in every selected testcase's own activity history.</p>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary">Submit {submitIds.length === 1 ? 'for review' : 'all for review'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'submitting' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(submitIds.length, 'submit')} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Submission is being recorded atomically' : 'Submitted testcases now await Reviewer recommendation'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was submitted</strong>
          <p className="muted small">The {selectionActionPhrase(submitIds.length, 'submit')} is atomic, so all selected testcases remain unchanged.</p>
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
const _CONTENT_VERSION_FIELDS: Array<[keyof TestCaseVersionOut, string]> = [
  ['epic_id', 'Epic ID'], ['cr_number', 'CR Number'], ['feature_id', 'Feature ID'],
  ['user_story_id', 'User Story ID'], ['test_type', 'Test Type'], ['module_name', 'Module'],
  ['test_scenario', 'Test Scenario'], ['pre_condition', 'Pre-condition'],
  ['description', 'Description'], ['priority', 'Priority'],
]

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
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
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

  const selectedVersion = selectedVersionId ? details[selectedVersionId] : null
  const displayStatus = (index: number, status: string) => index === 0 ? status : 'Superseded'
  const fieldLabel = (field: string) => field.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

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
          {versions.map((v, index) => {
            const full = details[v.id]
            return (
              <tr key={v.id} className="tm-version-row" onClick={() => setSelectedVersionId(v.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedVersionId(v.id) }}>
                <td><button type="button" className="tm-version-link" onClick={() => setSelectedVersionId(v.id)}>v{v.version}</button></td>
                <td><Badge status={displayStatus(index, v.status)} /></td>
                <td>{v.author_name || '—'}</td>
                <td>{formatDateTimeIST(v.created_at)}</td>
                <td>{v.submitted_at ? formatDateTimeIST(v.submitted_at) : '—'}</td>
                <td>
                  {full?.reviewed_by_name ? (
                    <span className="tm-workflow-status-field">
                      <strong>{full.reviewed_by_name}</strong>
                      <small>{full.reviewed_at ? formatDateTimeIST(full.reviewed_at) : ''}{full.review_comments ? ` -- ${full.review_comments}` : ''}</small>
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {full?.qa_lead_decided_by_name ? (
                    <span className="tm-workflow-status-field">
                      <strong>{full.qa_lead_decided_by_name}</strong>
                      <small>{full.qa_lead_decided_at ? formatDateTimeIST(full.qa_lead_decided_at) : ''}{full.qa_lead_decision_comments ? ` -- ${full.qa_lead_decision_comments}` : ''}</small>
                    </span>
                  ) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {selectedVersionId && (
        <section className="tm-version-details">
          <div className="tm-version-details-head"><div><strong>Version v{versions.find((version) => version.id === selectedVersionId)?.version}</strong><small>Immutable version snapshot</small></div><button type="button" className="btn btn-sm" onClick={() => setSelectedVersionId(null)}>Hide details</button></div>
          {!selectedVersion ? <p className="muted small">Loading version details…</p> : <>
            <dl className="tm-version-detail-grid">
              {_CONTENT_VERSION_FIELDS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(selectedVersion[key] ?? '—')}</dd></div>)}
            </dl>
            <div className="tm-version-steps"><strong>Test steps</strong>{selectedVersion.steps.length ? selectedVersion.steps.map((step) => <div key={step.id}><b>Step {step.step_no}</b><span>{step.step_text || '—'}</span><span>{step.expected_result || '—'}</span></div>) : <p className="muted small">No test steps in this version.</p>}</div>
          </>}
        </section>
      )}
      {versions.length > 1 && (
        <div className="tm-version-compare">
          <strong>Compare two versions</strong>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={compare.left} onChange={(e) => setCompare((c) => ({ ...c, left: Number(e.target.value) }))}>
              {versions.map((v, index) => <option key={v.id} value={v.id}>v{v.version} ({displayStatus(index, v.status)})</option>)}
            </select>
            <span>vs</span>
            <select value={compare.right} onChange={(e) => setCompare((c) => ({ ...c, right: Number(e.target.value) }))}>
              {versions.map((v, index) => <option key={v.id} value={v.id}>v{v.version} ({displayStatus(index, v.status)})</option>)}
            </select>
            <button type="button" className="btn btn-sm" onClick={runCompare} disabled={busy || compare.left === compare.right}>
              {busy ? 'Comparing…' : 'Compare'}
            </button>
          </div>
          <ErrorText error={error} />
          {diff && (
            <div className="tm-version-diff">
              <div className="tm-diff-header"><strong>Changed field</strong><span>v{diff.left.version}</span><span>v{diff.right.version}</span></div>
              {Object.keys(diff.field_diffs).length === 0 && Object.keys(diff.step_diffs).length === 0 ? (
                <p className="muted small">No field or step differences between these two versions.</p>
              ) : (
                <>
                  {Object.entries(diff.field_diffs).map(([field, values]) => (
                    <div className="tm-diff-row" key={field}>
                      <strong>{fieldLabel(field)}</strong>
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
// 2026-08 -- bulk counterpart to the single-case "Restore from archive"
// action (see the restore button in TestCaseReviewModal, ~line 1861), for
// the Archive view. Mirrors BulkArchiveModal's own confirm/progress/
// success/error shape, minus the reason field -- matches the single-case
// /restore endpoint, which likewise doesn't require one (only Archive
// itself demands a documented reason; reversing it back to Approved isn't
// a governance decision the way archiving or deleting is).
function BulkRestoreFromArchiveModal({ projectId, selectedIds, onClose, onRestored }: {
  projectId: number
  selectedIds: number[]
  onClose: () => void
  onRestored: (testCases: TestCaseOut[], restoredIds: number[]) => void
}) {
  const [restoreIds] = useState(selectedIds)
  const [stage, setStage] = useState<'confirm' | 'restoring' | 'success' | 'error'>('confirm')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting for confirmation')
  const [error, setError] = useState<unknown>(null)

  async function restore(e?: React.FormEvent) {
    e?.preventDefault()
    setError(null)
    setStage('restoring')
    setProgress(10)
    setProgressMessage('Validating archived status…')
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(88, current + (current < 50 ? 10 : 5))
        setProgressMessage(next >= 60 ? 'Recording the restore action…' : 'Verifying selected testcases…')
        return next
      })
    }, 280)
    try {
      const restored = await api.post<TestCaseOut[]>(`/api/test-repository/projects/${projectId}/test-cases/bulk-restore-from-archive`, {
        ids: restoreIds,
      })
      const remainingDisplayTime = Math.max(0, 750 - (Date.now() - startedAt))
      if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime))
      window.clearInterval(timer)
      setProgress(100)
      setProgressMessage(`${restored.length} testcase${restored.length !== 1 ? 's' : ''} restored`)
      onRestored(restored, restoreIds)
      setStage('success')
    } catch (err) {
      window.clearInterval(timer)
      setError(err)
      setStage('error')
    }
  }

  const errorReason = error instanceof Error ? error.message : String(error || 'The server did not provide an error reason.')
  const title = stage === 'restoring' ? 'Restoring testcases'
    : stage === 'success' ? `${selectionActionLabel(restoreIds.length, 'restore')} completed`
      : stage === 'error' ? `${selectionActionLabel(restoreIds.length, 'restore')} failed`
        : `Restore ${restoreIds.length} test case${restoreIds.length !== 1 ? 's' : ''} from archive?`

  return (
    <Modal title={title} onClose={onClose} variant="dialog" preventBackdropClose>
      {stage === 'confirm' && (
        <form onSubmit={restore}>
          <div className="tm-bulk-confirm-count"><strong>{restoreIds.length}</strong><span>test case{restoreIds.length !== 1 ? 's' : ''} will be restored to Approved</span></div>
          <p>The selected test cases will move out of Archived back to Approved, becoming available for new Test Cycle selection again. Their approval history, execution history, attachments, comments, and audit records are unaffected.</p>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={!restoreIds.length}>Restore {restoreIds.length} test case{restoreIds.length !== 1 ? 's' : ''}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {(stage === 'restoring' || stage === 'success') && (
        <div className={`tm-operation-state ${stage === 'success' ? 'success' : ''}`} aria-live="polite">
          <div className="tm-operation-icon">{stage === 'success' ? '✓' : '↻'}</div>
          <strong>{progressMessage}</strong>
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(restoreIds.length, 'restore')} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <div className="tm-progress-meta"><span>{progress < 100 ? 'Restore is being recorded atomically' : 'Restored testcases are now available for cycles'}</span><strong>{progress}%</strong></div>
          {stage === 'success' && <button className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      )}
      {stage === 'error' && (
        <div className="tm-operation-state error" role="alert">
          <div className="tm-operation-icon">!</div>
          <strong>Nothing was restored</strong>
          <p className="muted small">The {selectionActionPhrase(restoreIds.length, 'restore')} is atomic, so all selected testcases remain archived.</p>
          <div className="tm-operation-error"><strong>Reason</strong><p>{errorReason}</p></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => restore()}>Try again</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

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
    // 2026-08 -- "The user must provide an archive reason" (Final-Approved
    // Test Case Deletion and Archive Requirement) -- reason is now
    // mandatory, matching TestCaseArchive's backend schema.
    if (!reason.trim()) { setError(new Error('An archive reason is required')); return }
    setBusy(true); setError(null)
    try {
      onArchived(await api.post<TestCaseOut>(`/api/test-repository/test-cases/${testCase.id}/archive`, { reason: reason.trim() }))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Archive ${testCase.test_case_key}?`} onClose={onClose} variant="dialog" preventBackdropClose>
      <form onSubmit={submit}>
        <p>Are you sure you want to archive this test case? The test case will be removed from active lists but its history and execution records will be preserved.</p>
        <Field label="Archive reason *">
          <textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this test case being archived?" />
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
  // 2026-08 -- reported directly: "On save button click of testcase closing
  // the modal, it should not close the modal." Save used to be the only
  // action that closed this modal (onSaved -> setEditingCase(null) at the
  // call site below) -- every other action here (checkout, submit, review
  // decisions) leaves it open. Save now just persists and stays open; this
  // is the only feedback that it actually happened (the modal itself gives
  // no other visual cue once it doesn't close), so it's shown briefly next
  // to the button and cleared on a timer, same idea as a toast.
  const [justSaved, setJustSaved] = useState(false)
  useEffect(() => {
    if (!justSaved) return
    const timer = window.setTimeout(() => setJustSaved(false), 2500)
    return () => window.clearTimeout(timer)
  }, [justSaved])
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
  const { user } = useAuth()
  // 2026-08 "Simplified Test Management Review and Approval" requirement --
  // repository-governance actions that aren't tied to a specific
  // TestCaseVersion's old/new-workflow status (checkout override, archive/
  // restore of an already-Approved baseline) moved off project membership
  // to the plain QA Lead Group system-role model on the backend
  // (require_can_manage_repository_governance, deps.py) -- mirror that
  // exactly here instead of reusing the OLD-path-only canReview/
  // canGiveFinalApproval props. QA Group / QA Lead Group new-path Stage 1/
  // Stage 2 review authority is the same kind of plain system-role check
  // (see canActOnPendingStage below).
  const canManageRepoGovernance = hasRole(user, ...QA_LEAD_GROUP_ROLES)
  const canQAGroupNewPath = hasRole(user, 'QA_ENGINEER')
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
    existing.current_draft_author_id === user.id
  )
  // 2026-08 "Simplified Test Management" GOV-002 gap fix, NEW-path only --
  // reported directly: Tester 2 (not the draft's author) submitted Tester
  // 1's draft, then Tester 2 was immediately able to record the Stage 1
  // decision on the very item they'd just submitted. Mirrors
  // review_test_case's identical backend fix -- blocks whoever submitted
  // the draft from also recording its Stage 1 decision, and whoever
  // recorded Stage 1 from also recording Stage 2, not just the content
  // author. OLD-path ("In Review"/"Review Completed") stays exactly
  // isCurrentDraftAuthor, unchanged.
  const isBlockedFromNewStage1 = !!existing && !!user?.id && (
    isCurrentDraftAuthor || existing.current_draft_submitted_by_id === user.id
  )
  const isBlockedFromNewStage2 = !!existing && !!user?.id && (
    isCurrentDraftAuthor
    || existing.current_draft_submitted_by_id === user.id
    || existing.current_draft_reviewed_by_id === user.id
  )
  const canActOnPendingStage = !!existing && (
    (existing.status === 'In Review' && canReview && !isCurrentDraftAuthor)
    || (existing.status === 'Review Completed' && canGiveFinalApproval && !isCurrentDraftAuthor)
    || (existing.status === 'Recommendation Pending' && canQAGroupNewPath && !isBlockedFromNewStage1)
    || (existing.status === 'QA Lead Approval Pending' && canManageRepoGovernance && !isBlockedFromNewStage2)
  )
  const gov002BlockedMessage = !existing ? null
    : isCurrentDraftAuthor
      ? 'You authored this testcase version, so you cannot review or approve it yourself. Another authorized reviewer must record the pending decision.'
      : (existing.status === 'Recommendation Pending' && existing.current_draft_submitted_by_id === user?.id)
        ? 'You submitted this testcase version for review, so you cannot also record its Stage 1 decision. Another QA Group member must record it.'
        : (existing.status === 'QA Lead Approval Pending' && (existing.current_draft_submitted_by_id === user?.id || existing.current_draft_reviewed_by_id === user?.id))
          ? 'You already acted on this testcase version at an earlier stage (submitted it, or recorded its Stage 1 decision), so you cannot also record its Stage 2 decision. Another QA Lead Group member must record it.'
          : null
  const pendingLockContext = !pendingDecisionStatus || !existing ? null
    : gov002BlockedMessage ? {
      title: 'Maker-checker lock',
      message: gov002BlockedMessage,
    }
      : existing.status === 'In Review' && canReview ? {
        title: 'Reviewer mode — submitted content locked',
        message: 'The submitted testcase is preserved unchanged while you review it. Use the Stage 1 Reviewer decision controls below to recommend it or return it for correction.',
      }
        : existing.status === 'Review Completed' && canGiveFinalApproval ? {
          title: 'QA Lead approval mode — submitted content locked',
          message: 'The recommended testcase is preserved unchanged while you make the final decision. Use the Stage 2 controls below to approve, return, or reject it.',
        }
          : existing.status === 'Recommendation Pending' && canQAGroupNewPath ? {
            title: 'QA Group mode — submitted content locked',
            message: 'The submitted testcase is preserved unchanged while you review it. Use the Stage 1 QA Group decision controls below to recommend it or return it for correction.',
          }
            : existing.status === 'QA Lead Approval Pending' && canManageRepoGovernance ? {
              title: 'QA Lead Group mode — submitted content locked',
              message: 'The recommended testcase is preserved unchanged while you make the final decision. Use the Stage 2 controls below to approve, return, or reject it.',
            }
              : existing.status === 'In Review' || existing.status === 'Recommendation Pending' ? {
                title: 'Editing locked — awaiting a QA recommendation',
                message: 'The testcase content cannot change while Stage 1 review is pending. Editing reopens only if the QA reviewer returns it for correction.',
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
    setError(null)
    const incompleteSteps = steps
      .map((step, index) => ({ step, number: index + 1 }))
      .filter(({ step }) => !step.step_text?.trim() || !step.expected_result?.trim())
    const missing: string[] = []
    if (!testType.trim()) missing.push('Test Type')
    if (!moduleName.trim()) missing.push('Module Name')
    if (!priority.trim()) missing.push('Priority')
    if (!scenario.trim()) missing.push('Test Scenario')
    if (!description.trim()) missing.push('Description')
    if (!steps.length) missing.push('at least one Step')
    if (missing.length || incompleteSteps.length) {
      const messages: string[] = []
      if (missing.length) messages.push(`Complete the mandatory fields: ${missing.join(', ')}.`)
      if (incompleteSteps.length) messages.push(`Provide both Step and Expected Result for step ${incompleteSteps.map(({ number }) => number).join(', ')}.`)
      setError(new Error(messages.join(' ')))
      return
    }
    setBusy(true)
    const body = {
      test_case_key: null,
      folder_id: folder || null,
      epic_id: epicId || null, feature_id: featureId || null, user_story_id: userStoryId || null,
      test_type: testType, module_name: moduleName.trim(), test_scenario: scenario.trim(),
      pre_condition: preCondition || null, description: description || null,
      priority,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      steps: steps.map((step) => ({
        ...step,
        step_text: step.step_text?.trim(),
        expected_result: step.expected_result?.trim(),
      })),
    }
    try {
      const saved = existing
        ? await api.patch<TestCaseOut>(`/api/test-repository/test-cases/${existing.id}`, body)
        : await api.post<TestCaseOut>(`/api/test-repository/projects/${projectId}/test-cases`, body)
      onSaved(saved)
      setJustSaved(true)
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
          <Field label="Feature ID">
            <input value={featureId} onChange={(e) => setFeatureId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="User Story ID">
            <input value={userStoryId} onChange={(e) => setUserStoryId(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Test Type *">
            <select required value={testType} onChange={(e) => setTestType(e.target.value)} disabled={readOnly}>
              {TEST_CASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Module Name *">
            <input required value={moduleName} onChange={(e) => setModuleName(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Priority *">
            <select required value={priority} onChange={(e) => setPriority(e.target.value)} disabled={readOnly}>
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
                {!pendingDecisionStatus && canManageRepoGovernance && lockedByOther && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setShowOverride(true)}>Override checkout</button>
                )}
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
            for editing until they check it back in. {canManageRepoGovernance ? 'You can override the checkout above.' : 'Ask them, or a member of the QA Lead Group, to release it.'}
          </div>
        )}
        {existing && canAuthor && !existing.checked_out_by_id && !pendingDecisionStatus && (
          <div className="tm-edit-access-notice"><strong>Read-only until reserved</strong><span>Select <b>Start editing</b> above to check out this case and enable the form.</span></div>
        )}
        <Field label="Test Scenario *">
          <input required value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Pre-Condition">
          <textarea value={preCondition} onChange={(e) => setPreCondition(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Description *">
          <textarea required value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Steps *">
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
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
            {justSaved && <span className="tm-save-confirm">Saved</span>}
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            {existing && ['Draft', 'Returned', 'Returned by QA', 'Returned by QA Lead'].includes(existing.status) && (
              <button type="button" className="btn btn-success" onClick={() => setShowSubmit(true)} disabled={busy}>
                Submit for review
              </button>
            )}
            {/* 2026-08 -- "Final-Approved Test Case Deletion and Archive Requirement": Delete must stay hidden
                for any governed test case, not just an Approved/Archived one (current_approved_version_id is
                set for both, since archiving never clears the pointer) -- also hides it for a Rejected case
                that's never been approved, which the plain current_approved_version_id check alone missed
                (backend delete_test_case blocks it either way; this just keeps the button consistent with
                what the backend will actually allow). */}
            {existing && !existing.current_approved_version_id && existing.status !== 'Rejected' && <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</button>}
          </div>
        )}
      </form>
      {existing && canAuthor && (
        <div className="tm-review-actions">
          <div><strong>More actions</strong><span>Clone into a new testcase, or archive the approved baseline.</span></div>
          <button className="btn" onClick={() => setShowClone(true)}>Clone…</button>
          {canManageRepoGovernance && existing.current_approved_version_id && existing.status !== 'Archived' && (
            <button className="btn btn-danger" onClick={() => setShowArchive(true)}>Archive</button>
          )}
          {canManageRepoGovernance && existing.status === 'Archived' && (
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
        <WorkflowDecisionPanel title="QA review decision (Stage 1)" description={isCurrentDraftAuthor ? 'You authored this testcase version. Another Reviewer must record the decision.' : 'Approve for QA management, return for correction, or reject the test case.'} options={[
          { key: 'approve', label: 'Approve Stage 1', description: 'Recommend for final QA approval', tone: 'approve', disabled: isCurrentDraftAuthor, onClick: () => setReviewDecision('APPROVE') },
          { key: 'return', label: TEST_CASE_REVIEW_ACTION_LABELS.RETURN, description: 'Send back to the author for correction', tone: 'return', disabled: isCurrentDraftAuthor, onClick: () => setReviewDecision('RETURN') },
          { key: 'reject', label: TEST_CASE_REVIEW_ACTION_LABELS.REJECT, description: 'Reject this testcase version', tone: 'reject', disabled: isCurrentDraftAuthor, onClick: () => setReviewDecision('REJECT') },
        ]} />
      )}
      {/* Stage 2 -- QA Lead tier, only valid while "Review Completed" (APPROVE/RETURN/REJECT). Strictly narrower than Stage 1 -- a plain Reviewer project role does not qualify. */}
      {existing && existing.status === 'Review Completed' && canGiveFinalApproval && canActOnPendingStage && (
        <WorkflowDecisionPanel title="QA management decision (Stage 2)" description="Approve and activate this test case, return it for changes, or reject it." options={[
          { key: 'approve', label: TEST_CASE_REVIEW_ACTION_LABELS.APPROVE, description: 'Approve and activate this testcase version', tone: 'approve', onClick: () => setReviewDecision('APPROVE') },
          { key: 'return', label: TEST_CASE_REVIEW_ACTION_LABELS.RETURN, description: 'Send back to the author for correction', tone: 'return', onClick: () => setReviewDecision('RETURN') },
          { key: 'reject', label: TEST_CASE_REVIEW_ACTION_LABELS.REJECT, description: 'Reject this testcase version', tone: 'reject', onClick: () => setReviewDecision('REJECT') },
        ]} />
      )}
      {/* 2026-08 "Simplified Test Management" NEW-path Stage 1 -- QA Group
          (QA_ENGINEER) tier, only valid while "Recommendation Pending"
          (RECOMMEND/RETURN/REJECT). No individual reviewer assignment --
          any active QA Group member may act, GOV-002 self-authorship aside. */}
      {existing && existing.status === 'Recommendation Pending' && canQAGroupNewPath && canActOnPendingStage && (
        <div className="tm-review-actions">
          <div><strong>QA recommendation (Stage 1)</strong><span>{isBlockedFromNewStage1 ? (isCurrentDraftAuthor ? 'You authored this testcase version. Another QA Group member must record the decision.' : 'You submitted this testcase version for review. Another QA Group member must record the decision.') : 'Recommend for QA Lead approval, return for correction, or reject the test case.'}</span></div>
          <button className="btn btn-primary" disabled={isBlockedFromNewStage1} onClick={() => setReviewDecision('RECOMMEND')}>{TEST_CASE_REVIEW_ACTION_LABELS.RECOMMEND}</button>
          <button className="btn" disabled={isBlockedFromNewStage1} onClick={() => setReviewDecision('RETURN')}>{TEST_CASE_REVIEW_ACTION_LABELS.RETURN}</button>
          <button className="btn btn-danger" disabled={isBlockedFromNewStage1} onClick={() => setReviewDecision('REJECT')}>{TEST_CASE_REVIEW_ACTION_LABELS.REJECT}</button>
        </div>
      )}
      {/* NEW-path Stage 2 -- QA Lead Group (QA_LEAD/CHIEF_MANAGER_QA/AGM_QA)
          tier, only valid while "QA Lead Approval Pending" (APPROVE/RETURN/REJECT). */}
      {existing && existing.status === 'QA Lead Approval Pending' && canManageRepoGovernance && canActOnPendingStage && (
        <div className="tm-review-actions">
          <div><strong>QA Lead decision (Stage 2)</strong><span>{isBlockedFromNewStage2 ? (isCurrentDraftAuthor ? 'You authored this testcase version. Another QA Lead Group member must record the decision.' : 'You already acted on this testcase version at an earlier stage (submitted it, or recorded its Stage 1 decision). Another QA Lead Group member must record the decision.') : 'Any QA Lead Group member (QA Lead, CM QA, or AGM QA) may approve and activate this test case, return it for changes, or reject it.'}</span></div>
          <button className="btn btn-primary" disabled={isBlockedFromNewStage2} onClick={() => setReviewDecision('APPROVE')}>{TEST_CASE_REVIEW_ACTION_LABELS.APPROVE}</button>
          <button className="btn" disabled={isBlockedFromNewStage2} onClick={() => setReviewDecision('RETURN')}>{TEST_CASE_REVIEW_ACTION_LABELS.RETURN}</button>
          <button className="btn btn-danger" disabled={isBlockedFromNewStage2} onClick={() => setReviewDecision('REJECT')}>{TEST_CASE_REVIEW_ACTION_LABELS.REJECT}</button>
        </div>
      )}
      {existing && <LinkedDefects query={`test_case_id=${existing.id}`} />}
      {existing && <JiraActivity entityType="TEST_CASE" entityId={existing.id} items={activity} onPosted={(item) => setActivity((prev) => [...prev, item])} />}
      {confirmDelete && existing && (
        <ConfirmModal
          title="Delete test case?"
          message={<p>Delete <strong>{existing.test_case_key}</strong>? It will move to the Recycle Bin, where it can be restored, or permanently cleared by an authorized QA Lead.</p>}
          confirmLabel="Delete test case" cancelLabel="Keep test case" destructive busy={busy}
          onConfirm={remove} onCancel={() => setConfirmDelete(false)}
        />
      )}
      {reviewDecision && existing && (
        <TestCaseReviewModal
          testCase={existing}
          decision={reviewDecision}
          onClose={() => setReviewDecision(null)}
          onReviewed={onReviewed}
        />
      )}
      {showSubmit && existing && currentProject && (
        <BulkSubmitModal
          project={currentProject}
          selectedCases={[existing]}
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

function BulkUpdateModal({ projectId, selectedCases, folders, onClose, onUpdated }: {
  projectId: number
  selectedCases: TestCaseListOut[]
  folders: TestFolderOut[]
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
  }
  const [folder, setFolder] = useState('unchanged')
  const [priority, setPriority] = useState('')
  const [testType, setTestType] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [tags, setTags] = useState('')
  const [updateFolder, setUpdateFolder] = useState(false)
  const [updatePriority, setUpdatePriority] = useState(false)
  const [updateTestType, setUpdateTestType] = useState(false)
  const [updateModule, setUpdateModule] = useState(false)
  const [updateTags, setUpdateTags] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [stage, setStage] = useState<BulkUpdateStage>('edit')
  const [pendingBody, setPendingBody] = useState<BulkUpdateBody | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting to start')
  const [failurePoint, setFailurePoint] = useState('validating the selected test cases')
  const selectedIds = useMemo(() => selectedCases.map((testCase) => testCase.id), [selectedCases])
  const totalSelected = useState(selectedCases.length)[0]
  const workflowLockedCases = useMemo(
    () => selectedCases.filter((testCase) => TEST_CASE_PENDING_DECISION_STATUSES.includes(testCase.status)),
    [selectedCases],
  )
  const testcaseFieldsLocked = workflowLockedCases.length > 0

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
    return changes
  }, [folder, folders, priority, testType, moduleName, tags, updateFolder, updatePriority, updateTestType, updateModule, updateTags])

  function review(e: React.FormEvent) {
    e.preventDefault()
    const body: BulkUpdateBody = { ids: selectedIds }
    if (updateFolder) body.folder_id = folder === 'unfiled' ? null : Number(folder)
    if (updatePriority) body.priority = priority
    if (updateTestType) body.test_type = testType
    if (updateModule) body.module_name = moduleName.trim()
    if (updateTags) body.tags = tags.split(',').map((tag) => tag.trim()).filter(Boolean)
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
  const title = stage === 'confirm' ? `Confirm ${totalSelected > 1 ? 'bulk ' : ''}update`
    : stage === 'updating' ? 'Updating test cases'
      : stage === 'success' ? `${selectionActionLabel(totalSelected, 'update')} completed`
        : stage === 'error' ? `${selectionActionLabel(totalSelected, 'update')} failed`
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
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(totalSelected, 'update')} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
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
          <div className="tm-progress-track" role="progressbar" aria-label={`${selectionActionLabel(totalSelected, 'update')} stopped progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
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

// 2026-08 "Create Recycle bin and Archive folder" requirement -- "any
// delete testcases before approve will go to recycle bin. only QA lead can
// clear from recycle bin." A deliberately self-contained view (own
// selection state, own simple columns) rather than trying to force the
// main list's much larger review-workflow-oriented Table configuration
// (Workflow badges, checkout state, GOV-002-aware checkboxes, etc. -- all
// meaningless for a case that's been deleted) to also cover this case.
// Restore is Author-tier (canRestore, same as who could delete in the
// first place); permanently clearing is QA Lead Group only (canPurge).
function RecycleBinPanel({
  projectId, items, loading, total, totalPages, page, pageSize, hasNext, hasPrevious,
  onPageChange, onPageSizeChange, search, onSearchChange, canRestore, canPurge, onChanged,
}: {
  projectId: number
  items: TestCaseListOut[]
  loading: boolean
  total: number; totalPages: number; page: number; pageSize: number
  hasNext: boolean; hasPrevious: boolean
  onPageChange: (p: number) => void
  onPageSizeChange: (n: number) => void
  search: string
  onSearchChange: (s: string) => void
  canRestore: boolean
  canPurge: boolean
  onChanged: () => void
}) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmBulkPurge, setConfirmBulkPurge] = useState(false)
  const [confirmSingle, setConfirmSingle] = useState<{ id: number; key: string } | null>(null)

  useEffect(() => { setSelectedIds(new Set()) }, [items])

  function toggle(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allSelected = items.length > 0 && items.every((tc) => selectedIds.has(tc.id))
  function toggleAll() {
    setSelectedIds((prev) => {
      if (allSelected) return new Set()
      return new Set(items.map((tc) => tc.id))
    })
  }

  async function restoreOne(id: number) {
    setBusyId(id); setError(null)
    try {
      await api.post(`/api/test-repository/test-cases/${id}/restore-from-recycle-bin`, {})
      onChanged()
    } catch (err) { setError(err) } finally { setBusyId(null) }
  }

  async function restoreSelected() {
    if (selectedIds.size === 0) return
    setBulkBusy(true); setError(null)
    try {
      await api.post(`/api/test-repository/projects/${projectId}/test-cases/bulk-restore-from-recycle-bin`, { ids: Array.from(selectedIds) })
      setSelectedIds(new Set())
      onChanged()
    } catch (err) { setError(err) } finally { setBulkBusy(false) }
  }

  async function purgeOne(id: number) {
    setBusyId(id); setError(null)
    try {
      await api.del(`/api/test-repository/test-cases/${id}/purge`)
      onChanged()
    } catch (err) { setError(err) } finally { setBusyId(null); setConfirmSingle(null) }
  }

  async function purgeSelected() {
    if (selectedIds.size === 0) return
    setBulkBusy(true); setError(null)
    try {
      await api.post(`/api/test-repository/projects/${projectId}/test-cases/bulk-purge`, { ids: Array.from(selectedIds) })
      setSelectedIds(new Set())
      onChanged()
    } catch (err) { setError(err) } finally { setBulkBusy(false); setConfirmBulkPurge(false) }
  }

  return (
    <>
      <div className="tm-current-view">
        <div>
          <small>Current view</small>
          <h3>Recycle Bin</h3>
          <p>Test cases deleted before ever being approved. Restorable by any author, or permanently cleared by an authorized QA Lead.</p>
        </div>
        <span>{total} test case{total !== 1 ? 's' : ''}</span>
      </div>
      <div className="tm-list-toolbar">
        <ClearableSearchInput value={search} onChange={(e) => onSearchChange(e.target.value)} onClear={() => onSearchChange('')} clearLabel="Clear Recycle Bin search" wrapperClassName="search-grow" placeholder="Search deleted cases by key or scenario…" />
      </div>
      <ErrorText error={error} />
      {selectedIds.size > 0 && (
        <div className="tm-bulk-bar" role="region" aria-label={selectedIds.size > 1 ? 'Recycle Bin bulk actions' : 'Recycle Bin testcase actions'}>
          <strong>{selectedIds.size} test case{selectedIds.size !== 1 ? 's' : ''} selected</strong>
          {canRestore && <button className="btn btn-sm btn-primary" disabled={bulkBusy} onClick={restoreSelected}>Restore selected ({selectedIds.size})</button>}
          {canPurge && <button className="btn btn-sm btn-danger" disabled={bulkBusy} onClick={() => setConfirmBulkPurge(true)}>Empty selected ({selectedIds.size})</button>}
          <button className="btn btn-sm" onClick={() => setSelectedIds(new Set())}>Clear selection</button>
        </div>
      )}
      <Table
        rowKey="id"
        server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange, onPageSizeChange, loading }}
        columns={[
          {
            key: 'selection',
            header: (canRestore || canPurge) && items.length > 0 ? (
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label={allSelected ? 'Deselect all' : 'Select all'} />
            ) : null,
            render: (c) => (canRestore || canPurge) ? (
              <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.test_case_key}`} />
            ) : null,
            filterable: false,
          },
          { key: 'test_case_key', header: 'Test Case', render: (c) => <span className="tm-test-case-cell"><strong>{c.test_case_key}</strong><small>{c.test_scenario || 'Scenario not provided'}</small></span>, filterValue: (c) => `${c.test_case_key} ${c.test_scenario || ''}` },
          { key: 'status', header: 'Status when deleted', render: (c) => <Badge status={c.status} label={TEST_CASE_STATUS_LABELS[c.status] || c.status} /> },
          { key: 'deleted_by', header: 'Deleted by', render: (c) => <span>{c.deleted_by_name || '—'}</span> },
          { key: 'deleted_at', header: 'Deleted on', render: (c) => <span>{c.deleted_at ? formatDateTimeIST(c.deleted_at) : '—'}</span> },
          {
            key: 'actions', header: 'Actions', filterable: false,
            render: (c) => (
              <span className="tm-recycle-actions">
                {canRestore && <button className="btn btn-sm btn-primary" disabled={busyId === c.id} onClick={() => restoreOne(c.id)}>Restore</button>}
                {canPurge && <button className="btn btn-sm btn-danger" disabled={busyId === c.id} onClick={() => setConfirmSingle({ id: c.id, key: c.test_case_key })}>Clear permanently</button>}
                {!canRestore && !canPurge && <small>No permitted actions</small>}
              </span>
            ),
          },
        ]}
        rows={items}
      />
      {confirmSingle && (
        <ConfirmModal
          title={`Permanently delete ${confirmSingle.key}?`}
          message={<div><p>This permanently removes the test case and its steps. This action cannot be undone.</p></div>}
          confirmLabel="Clear permanently"
          cancelLabel="Cancel"
          destructive
          busy={busyId === confirmSingle.id}
          onConfirm={() => purgeOne(confirmSingle.id)}
          onCancel={() => setConfirmSingle(null)}
        />
      )}
      {confirmBulkPurge && (
        <ConfirmModal
          title={`Permanently delete ${selectedIds.size} test case${selectedIds.size !== 1 ? 's' : ''}?`}
          message={<div><p>This permanently removes the selected test cases and their steps. This action cannot be undone.</p></div>}
          confirmLabel={`Clear ${selectedIds.size} permanently`}
          cancelLabel="Cancel"
          destructive
          busy={bulkBusy}
          onConfirm={purgeSelected}
          onCancel={() => setConfirmBulkPurge(false)}
        />
      )}
    </>
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
  // 2026-08 "Simplified Test Management Review and Approval" requirement --
  // folder deletion is repository governance not tied to a specific
  // TestCaseVersion's old/new-workflow status, so it moved off project
  // membership to the plain QA Lead Group system-role model on the backend
  // (require_can_manage_repository_governance, deps.py) -- same set
  // TestCaseModal's own canManageRepoGovernance mirrors for archive/
  // restore/checkout-override.
  const canDeleteFolder = hasRole(user, ...QA_LEAD_GROUP_ROLES)
  // NEW-path Stage 1/Stage 2 authority (see TestCaseModal's identically-named
  // consts above) -- plain system-role checks, no project membership,
  // reused here for the bulk recommend/approve eligibility filters below.
  const canManageRepoGovernance = hasRole(user, ...QA_LEAD_GROUP_ROLES)
  const canQAGroupNewPath = hasRole(user, 'QA_ENGINEER')
  // Selection is shared workflow infrastructure, not an authoring action.
  // Reviewer-only members need it for bulk recommendation, while Stage 2
  // approvers need it for bulk final approval. Edit/delete controls remain
  // separately gated by canAuthor below. QA_ENGINEER/QA_LEAD_GROUP are both
  // already inside CAN_AUTHOR_ROLES, so canAuthor alone already covers
  // NEW-path Stage 1/Stage 2 selection eligibility too.
  const canSelectCases = canAuthor || canReview || canGiveFinalApproval
  const [users, setUsers] = useState<UserOut[]>([])
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [projectId, setProjectId] = useState<number | ''>('')
  const [folders, setFolders] = useState<TestFolderOut[]>([])
  // SRS 7.2 pagination rollout -- see TestCaseSummaryOut's own comment
  // (types.ts) for why this exists: the folder tree's counts, the tag
  // filter dropdown, and the project-wide stat bar all need project-wide
  // aggregates the paginated case list below can no longer provide on its
  // own.
  const [summary, setSummary] = useState<TestCaseSummaryOut | null>(null)
  const [selectedFolder, setSelectedFolder] = useState<number | typeof UNFILED | typeof ARCHIVE_VIEW | typeof RECYCLE_BIN | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingCase, setEditingCase] = useState<TestCaseOut | null | 'new'>(null)
  // PAG-006 -- the list only ever holds the lightweight TestCaseListOut
  // shape; opening a case fetches the full TestCaseOut (steps included)
  // fresh via GET /test-cases/{id} before the editor modal is shown.
  const [openingCaseId, setOpeningCaseId] = useState<number | null>(null)
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
  const [showBulkReturn, setShowBulkReturn] = useState(false)
  const [showBulkReject, setShowBulkReject] = useState(false)
  const [showBulkArchive, setShowBulkArchive] = useState(false)
  const [showBulkRestore, setShowBulkRestore] = useState(false)
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
      const queued = await api.post<{ id: string }>(`/api/test-repository/projects/${projectId}/export-xlsx/jobs`)
      await waitForJob(queued.id)
      await api.downloadFile(
        `/api/jobs/${queued.id}/download`,
        `${selectedProject.project_key}_test_repository.xlsx`,
      )
    } catch (err) { setError(err) } finally { setExportingRepository(false) }
  }

  useEffect(() => {
    // SRS 7.2 pagination rollout -- /api/test-projects is now wrapped in
    // Page[T] for API-contract consistency (task #82); page_size=100 +
    // .items since this project picker still wants the complete list.
    api.get<PageOut<TestProjectOut>>('/api/test-projects?include_inactive=true&page_size=100').then((page) => {
      const p = page.items
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

  const loadFolders = useCallback(async (pid: number) => {
    try { setFolders(await api.get<TestFolderOut[]>(`/api/test-repository/projects/${pid}/folders`)) }
    catch (err) { setError(err) }
  }, [])
  // Reported directly: "Testcases count and all should be updated based on
  // folder. otherwise creating confusion" -- the "Current view" stat cards
  // (Test cases/Approved/Pending review/Critical) used to always show
  // GET .../summary's project-wide total/approved_count/etc regardless of
  // which folder was selected in the sidebar. `folderParam` mirrors the
  // same folder_id semantics the main case list's own `extra.folder_id`
  // already sends (see the `extra` object below), plus a distinct 'archived'
  // value for the Archive pseudo-folder (which the list reaches via a
  // status filter instead, since it's project-wide, not folder-scoped) --
  // passed to the summary endpoint so its new scoped_total/
  // scoped_approved_count/scoped_in_review_count/scoped_critical_count
  // fields reflect the folder actually on screen. Recycle Bin has no stat
  // cards at all (see the isRecycleBinView branch below), so its own value
  // here is never rendered -- left as undefined (whole project) for
  // simplicity rather than adding a fifth branch nothing reads.
  const summaryFolderParam = selectedFolder === ARCHIVE_VIEW ? 'archived'
    : selectedFolder === UNFILED ? 'unfiled'
    : selectedFolder === '' || selectedFolder === RECYCLE_BIN ? undefined
    : String(selectedFolder)
  const loadSummary = useCallback(async (pid: number, folderParam?: string) => {
    try {
      const qs = folderParam ? `?folder_id=${encodeURIComponent(folderParam)}` : ''
      setSummary(await api.get<TestCaseSummaryOut>(`/api/test-repository/projects/${pid}/test-cases/summary${qs}`))
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    setSelectedCaseIds(new Set())
    if (projectId) { loadFolders(projectId) } else { setFolders([]) }
  }, [projectId, loadFolders])
  useEffect(() => {
    if (projectId) { loadSummary(projectId, summaryFolderParam) } else { setSummary(null) }
  }, [projectId, summaryFolderParam, loadSummary])

  useEffect(() => {
    if (!projectId) { setMyAccess(null); return }
    let active = true
    api.get<TestProjectMyAccessOut>(`/api/test-projects/${projectId}/my-access`)
      .then((access) => { if (active) setMyAccess(access) })
      .catch(() => { if (active) setMyAccess(null) })
    return () => { active = false }
  }, [projectId])

  // SRS 7.2 pagination rollout -- the main case list is now server-paginated
  // and server-filtered (folder/search/priority/status/tag all become query
  // params instead of an in-browser .filter() over the whole project's
  // cases). See TestCaseSummaryOut (loaded above) for the folder-tree
  // counts/tag list/stat bar this list can no longer compute on its own.
  // 2026-08 "Create Recycle bin and Archive folder" requirement -- Recycle
  // Bin is a genuinely different dataset (its own endpoint, since a
  // soft-deleted case is excluded from the normal one entirely) so it
  // switches `path` itself; Archive stays on the normal paginated endpoint
  // but forces status=Archived project-wide (ignoring whatever real folder
  // is selected -- "all archive testcases will go to Archive folder" reads
  // as one flat view of everything archived, not nested per original
  // folder) and search-only otherwise (no priority/tag scoping, matching
  // Recycle Bin's own flat-list simplicity).
  const isRecycleBinView = selectedFolder === RECYCLE_BIN
  const isArchiveView = selectedFolder === ARCHIVE_VIEW
  const {
    items: cases, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading: casesLoading, setPage, setPageSize, reload: reloadCases,
  } = usePaginatedList<TestCaseListOut>(
    projectId
      ? isRecycleBinView
        ? `/api/test-repository/projects/${projectId}/test-cases/recycle-bin`
        : `/api/test-repository/projects/${projectId}/test-cases`
      : '',
    {
      search,
      status: isRecycleBinView ? undefined
        : isArchiveView ? ['Archived']
        : statusFilter === REVIEW_QUEUE_TOKEN ? REVIEW_QUEUE_STATUSES
        : statusFilter === FINAL_APPROVAL_QUEUE_TOKEN ? FINAL_APPROVAL_QUEUE_STATUSES
          : statusFilter ? [statusFilter] : undefined,
      extra: isRecycleBinView ? {} : {
        folder_id: isArchiveView || selectedFolder === '' ? undefined : selectedFolder === UNFILED ? 'unfiled' : String(selectedFolder),
        priority: priorityFilter || undefined,
        tag: tagFilter || undefined,
      },
    },
    { cursor: !isRecycleBinView },
  )
  const refreshCases = useCallback(() => {
    reloadCases()
    if (projectId) loadSummary(projectId, summaryFolderParam)
  }, [reloadCases, loadSummary, projectId, summaryFolderParam])
  // Selection is only ever meaningful against whatever's currently loaded --
  // switching project/folder/page/filters changes what's on screen, so any
  // held-over selection from before would silently refer to rows the user
  // can no longer see (or, worse, rows on a different page they never
  // intended to act on). Cleared on every axis that changes what's visible.
  useEffect(() => {
    setSelectedCaseIds(new Set())
  }, [projectId, selectedFolder, search, priorityFilter, statusFilter, tagFilter, page, pageSize])
  function goToPage(p: number) { setPage(p) }
  function goToPageSize(n: number) { setPageSize(n) }

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

  // PAG-006 -- cases only ever holds the lightweight TestCaseListOut shape;
  // opening one fetches the full TestCaseOut (with steps) before showing
  // the editor modal.
  const openCase = useCallback(async (id: number) => {
    setOpeningCaseId(id)
    try { setEditingCase(await api.get<TestCaseOut>(`/api/test-repository/test-cases/${id}`)) }
    catch (err) { setError(err) } finally { setOpeningCaseId(null) }
  }, [])

  const availableTags = summary?.tags || []
  const folderCounts = summary?.folder_counts || {}
  const unfiledCount = summary?.unfiled_count || 0
  const folderTree = useMemo(() => buildFolderTree(folders), [folders])
  const selectedProject = projects.find((project) => project.id === projectId)
  const projectIsActive = !!selectedProject?.is_active
  const selectedCount = selectedCaseIds.size
  const selectedCases = cases.filter((testCase) => selectedCaseIds.has(testCase.id))
  // 2026-08 fix: this originally only checked the two OLD-path in-flight
  // statuses -- missed the NEW-path pair introduced alongside them
  // (Recommendation Pending / QA Lead Approval Pending), so a selection
  // sitting under NEW-path pending approval could still open Bulk update
  // and edit fields mid-review. Reported directly: "if testcase under
  // pending approval then bulk update button should not be visible." Now
  // reuses the same TEST_CASE_PENDING_DECISION_STATUSES constant the
  // modal's own internal per-row lock and the single-case panel already use,
  // instead of a separately-maintained two-status list.
  const selectedCasesIncludeWorkflowLock = selectedCases.some(
    (testCase) => TEST_CASE_PENDING_DECISION_STATUSES.includes(testCase.status),
  )
  const canBulkUpdateAssignments = canAuthor && !selectedCasesIncludeWorkflowLock && selectedCases.length > 0 && selectedCases.every(
    (testCase) => testCase.current_draft_author_id === user?.id
      && !['Approved', 'Rejected', 'Archived'].includes(testCase.status),
  )
  const canBulkUpdateTestcaseFields = canAuthor && !selectedCasesIncludeWorkflowLock
  const canOpenBulkUpdate = canBulkUpdateAssignments || canBulkUpdateTestcaseFields
  // Stage 1 (Reviewer) bulk-recommend acts on OLD-path "In Review" rows
  // (unchanged, still keyed to the individually-assigned pending_with_user_id
  // -- ORACLE_MIGRATION_2026-07 "new cases only" migration decision); Stage 2
  // (QA Lead) bulk-approve on OLD-path "Review Completed" rows likewise.
  // 2026-08 "Simplified Test Management" NEW-path rows have no individual
  // assignee at all -- group routing is authoritative -- so eligibility there
  // is a plain QA Group / QA Lead Group role check instead of
  // pending_with_user_id. A selection spanning both an OLD- and a NEW-path
  // row is intentionally left in the same eligible-ids array: the backend's
  // own bulk-recommend/bulk-approve guard rejects a mixed OLD+NEW selection
  // with an explicit "select one group at a time" error.
  const recommendSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id)
    && testCase.current_draft_author_id !== user?.id
    && (
      (testCase.status === 'In Review' && (testCase.pending_with_user_id === user?.id || hasRole(user, 'ADMIN')))
      // 2026-08 GOV-002 gap fix, NEW-path only -- also exclude whoever
      // submitted this specific draft (see TestCaseModal's identically-named
      // isBlockedFromNewStage1 for the single-case equivalent). OLD-path
      // ("In Review" above) intentionally stays author-only, unchanged.
      || (testCase.status === 'Recommendation Pending' && canQAGroupNewPath
          && testCase.current_draft_submitted_by_id !== user?.id)
    )).map((testCase) => testCase.id)
  const finalApproveSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id)
    && testCase.current_draft_author_id !== user?.id
    && (
      (testCase.status === 'Review Completed' && (testCase.pending_with_user_id === user?.id || hasRole(user, 'ADMIN')))
      // 2026-08 GOV-002 gap fix, NEW-path only -- also exclude whoever
      // submitted this draft or recorded its Stage 1 decision (see
      // isBlockedFromNewStage2). OLD-path ("Review Completed" above)
      // intentionally stays author-only, unchanged.
      || (testCase.status === 'QA Lead Approval Pending' && canManageRepoGovernance
          && testCase.current_draft_submitted_by_id !== user?.id
          && testCase.current_draft_reviewed_by_id !== user?.id)
    )).map((testCase) => testCase.id)
  const submittableSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id)
    && ['Draft', 'Returned', 'Returned by QA', 'Returned by QA Lead'].includes(testCase.status)).map((testCase) => testCase.id)
  // 2026-08 -- bulk Return/Reject, NEW-path only (see backend
  // bulk_return_test_cases/bulk_reject_test_cases -- OLD-path "In Review"/
  // "Review Completed" return/reject stays single-case only, unchanged).
  // Same GOV-002 exclusions as recommendSelectedIds/finalApproveSelectedIds
  // above -- a selection spanning both stages is intentionally left in one
  // array; the backend's own guard rejects a mixed-stage selection.
  const returnRejectSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id)
    && testCase.current_draft_author_id !== user?.id
    && (
      (testCase.status === 'Recommendation Pending' && canQAGroupNewPath
        && testCase.current_draft_submitted_by_id !== user?.id)
      || (testCase.status === 'QA Lead Approval Pending' && canManageRepoGovernance
        && testCase.current_draft_submitted_by_id !== user?.id
        && testCase.current_draft_reviewed_by_id !== user?.id)
    )).map((testCase) => testCase.id)
  // 2026-08 -- "Final-Approved Test Case Deletion and Archive Requirement":
  // a test case that has ever been approved/archived/rejected is governed
  // history and can never be hard-deleted (backend delete_test_case/
  // bulk_delete_test_cases -- see their own docstrings). `current_
  // approved_version_id` is set the moment a case is ever approved and is
  // never cleared again (archiving only flips the version's own status, it
  // doesn't unlink the pointer), so its presence alone reliably captures
  // "approved or archived." `status === 'Rejected'` catches the common
  // rejected-and-not-yet-revised case too; a case rejected long ago and
  // since revised again (current status back to Draft) is a rarer edge the
  // list view can't detect without a dedicated backend flag -- the
  // backend's own check (which scans full version history) remains the
  // authoritative guard for that case, same as every other bulk action here.
  const governedSelectedIds = selectedCases.filter((testCase) =>
    !!testCase.current_approved_version_id || testCase.status === 'Rejected').map((testCase) => testCase.id)
  const deletableSelectedIds = selectedCases.filter((testCase) =>
    !testCase.current_approved_version_id && testCase.status !== 'Rejected').map((testCase) => testCase.id)
  // "Archive Selected" -- only a live Approved baseline is archivable (an
  // already-Archived row has nothing further to do, a Draft/In Review/etc
  // row has no approved baseline to archive yet).
  const archivableSelectedIds = canManageRepoGovernance
    ? selectedCases.filter((testCase) => testCase.status === 'Approved').map((testCase) => testCase.id)
    : []
  // "Restore selected" -- the reverse of Archive Selected, same eligibility
  // gate (QA Lead Group/Admin, canManageRepoGovernance) and only ever
  // targets rows currently Archived. Naturally empty outside the Archive
  // view (or an "All test cases" selection filtered to status=Archived),
  // same as archivableSelectedIds isn't gated to any one view either.
  const restorableSelectedIds = canManageRepoGovernance
    ? selectedCases.filter((testCase) => testCase.status === 'Archived').map((testCase) => testCase.id)
    : []
  // "Visible" now means "on the current page" -- selection/bulk actions are
  // scoped to whatever page is loaded, same tradeoff already made for Test
  // Executions' own bulk bar (see TestExecution.tsx). Select All itself is
  // now eligibility-aware (allEligibleSelected/someEligibleSelected, defined
  // near toggleAllVisible below) rather than selecting every row regardless
  // of whether the user could actually act on it.
  const selectedFolderRecord = typeof selectedFolder === 'number' ? folders.find((folder) => folder.id === selectedFolder) : undefined
  const currentViewTitle = selectedFolder === ''
    ? 'All test cases'
    : selectedFolder === UNFILED
      ? 'Unfiled test cases'
      : selectedFolder === ARCHIVE_VIEW
        ? 'Archived test cases'
        : selectedFolder === RECYCLE_BIN
          ? 'Recycle Bin'
          : selectedFolderRecord?.name || 'Selected folder'
  const currentViewDescription = selectedFolderRecord
    ? folderPathLabel(folders, selectedFolderRecord)
    : selectedFolder === UNFILED
      ? 'Cases that have not yet been assigned to a repository folder.'
      : selectedFolder === ARCHIVE_VIEW
        ? 'Every archived test case across the whole project, regardless of its original folder. Restorable by an authorized QA Lead.'
        : selectedFolder === RECYCLE_BIN
          ? 'Test cases deleted before ever being approved. Restorable by any author, or permanently cleared by an authorized QA Lead.'
          : 'Complete repository coverage across every folder and sub-folder.'

  // 2026-08 -- "Bulk Test Case Recommendation - Checkbox Validation
  // Requirements": a row's checkbox must only ever be selectable when the
  // logged-in user could actually act on it. Only the four review
  // checkpoints (In Review/Review Completed OLD-path, Recommendation
  // Pending/QA Lead Approval Pending NEW-path) carry a real GOV-002/role
  // gate the way the requirement describes -- every other status (Draft/
  // Returned/Approved/Archived/Rejected) stays selectable exactly as today
  // for Submit/Delete/Bulk update, which aren't per-row gated the same way
  // and would otherwise become unselectable by accident. Mirrors the exact
  // same predicates already used by recommendSelectedIds/
  // finalApproveSelectedIds/returnRejectSelectedIds above, just evaluated
  // per-row instead of against the current selection, so the three stay
  // consistent by construction.
  function checkboxEligibility(testCase: TestCaseListOut): { eligible: boolean; reason?: string } {
    const isAuthor = testCase.current_draft_author_id === user?.id
    if (testCase.status === 'In Review') {
      if (isAuthor) return { eligible: false, reason: 'You authored this test case. Another reviewer must record the decision.' }
      if (!canReview) return { eligible: false, reason: 'You are not eligible to review this test case.' }
      if (!(testCase.pending_with_user_id === user?.id || hasRole(user, 'ADMIN'))) {
        return { eligible: false, reason: 'This test case is currently assigned to another reviewer.' }
      }
      return { eligible: true }
    }
    if (testCase.status === 'Review Completed') {
      if (isAuthor) return { eligible: false, reason: 'You authored this test case. Another QA Lead must record the decision.' }
      if (!canGiveFinalApproval) return { eligible: false, reason: 'You are not eligible to give final approval on this test case.' }
      if (!(testCase.pending_with_user_id === user?.id || hasRole(user, 'ADMIN'))) {
        return { eligible: false, reason: 'This test case is currently assigned to another QA Lead.' }
      }
      return { eligible: true }
    }
    if (testCase.status === 'Recommendation Pending') {
      // isAuthor checks current_draft_author_id (who wrote the content),
      // which is NOT necessarily current_draft_submitted_by_id (who clicked
      // Submit) -- authoring/checkout is a broad team-tier permission, so
      // a different QA_ENGINEER can submit someone else's authored draft.
      // GOV-002 blocks the author either way (backend: "the author of a
      // draft version may not act on their own work", unconditional on
      // submitter) -- the reason text below must say "authored", not
      // "submitted", or it reads as flatly wrong whenever those two differ
      // (reported: QA 2 authored it, QA 1 submitted it, QA 2 still blocked).
      if (isAuthor) return { eligible: false, reason: 'You authored this test case. Another QA Group member must record its Stage 1 decision.' }
      if (!canQAGroupNewPath) return { eligible: false, reason: 'Only QA Group members can act on this test case.' }
      if (testCase.current_draft_submitted_by_id === user?.id) {
        return { eligible: false, reason: 'You submitted this test case for review and cannot also record its Stage 1 decision.' }
      }
      return { eligible: true }
    }
    if (testCase.status === 'QA Lead Approval Pending') {
      if (isAuthor) return { eligible: false, reason: 'You authored this test case. Another QA Lead Group member must record the decision.' }
      if (!canManageRepoGovernance) return { eligible: false, reason: 'Already recommended and pending QA Lead approval.' }
      if (testCase.current_draft_submitted_by_id === user?.id || testCase.current_draft_reviewed_by_id === user?.id) {
        return { eligible: false, reason: 'You already acted on this test case at an earlier stage and cannot also record its Stage 2 decision.' }
      }
      return { eligible: true }
    }
    return { eligible: true }
  }
  const eligibleOnPageIds = cases.filter((testCase) => checkboxEligibility(testCase).eligible).map((testCase) => testCase.id)
  const allEligibleSelected = eligibleOnPageIds.length > 0 && eligibleOnPageIds.every((id) => selectedCaseIds.has(id))
  const someEligibleSelected = eligibleOnPageIds.some((id) => selectedCaseIds.has(id))

  function toggleSelected(id: number) {
    if (!checkboxEligibility(cases.find((testCase) => testCase.id === id) as TestCaseListOut).eligible) return
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
      if (allEligibleSelected) eligibleOnPageIds.forEach((id) => next.delete(id))
      else eligibleOnPageIds.forEach((id) => next.add(id))
      return next
    })
  }

  // "the system must recalculate selection eligibility and clear invalid
  // selections" when data is refreshed/filtered/paginated/updated -- prunes
  // any id that's on the current page but no longer eligible (e.g. someone
  // else just acted on it). Ids selected on a different page are left
  // untouched, matching this list's existing "selection persists across
  // pages" behavior.
  useEffect(() => {
    setSelectedCaseIds((prev) => {
      if (prev.size === 0) return prev
      const eligibleIds = new Set(eligibleOnPageIds)
      let changed = false
      const next = new Set(prev)
      for (const testCase of cases) {
        if (prev.has(testCase.id) && !eligibleIds.has(testCase.id)) { next.delete(testCase.id); changed = true }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases])

  async function bulkDelete() {
    // 2026-08 -- only ever sends deletableSelectedIds (never-governed cases),
    // never the raw selection -- an Approved/Archived/Rejected case must
    // never even be attempted for hard delete, let alone silently dropped
    // from a mixed batch server-side.
    if (!projectId || deletableSelectedIds.length === 0) return
    setBulkDeleteBusy(true); setError(null)
    try {
      await api.post(`/api/test-repository/projects/${projectId}/test-cases/bulk-delete`, { ids: deletableSelectedIds })
      refreshCases()
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
      reloadCases()
      setEditingCase(updated)
    } catch (err) { setError(err) }
  }

  async function checkinCase(id: number) {
    setError(null)
    try {
      await api.post<TestCaseOut>(`/api/test-repository/test-cases/${id}/checkin`)
      reloadCases()
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
        eyebrow="Test Case Management · Design · Organize · Execute · Trace"
        title="Test Repository" count={summary?.total ?? 0}
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
        <div className="tm-workflow-banner inactive"><span>!</span><strong>Project is inactive</strong><InfoTooltip label="About inactive projects" content="Repository content remains available for review, but changes are disabled until the project is reactivated." /></div>
      )}
      {projectId && projectIsActive && (
        <div className="tm-workflow-banner"><span>✓</span><strong>Governed test-case workflow</strong><InfoTooltip label="About the governed test-case workflow" content="Author creates or imports a Draft → submits for review → the QA Group recommends → the QA Lead Group gives final approval → approved testcases become available in Test Cycles. No individual reviewer or QA Lead is assigned — either group routes and notifies automatically." /></div>
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
                  <span>▦</span> All test cases <em>{summary?.total ?? 0}</em>
                </button>
              </li>
              <li>
                <button className={`link-btn ${selectedFolder === UNFILED ? 'active' : ''}`} onClick={() => setSelectedFolder(UNFILED)}>
                  <span>◇</span> Unfiled <em>{unfiledCount}</em>
                </button>
              </li>
              {/* 2026-08 "Create Recycle bin and Archive folder" requirement --
                  two pinned pseudo-folders, same treatment as Unfiled above. */}
              <li>
                <button className={`link-btn ${selectedFolder === ARCHIVE_VIEW ? 'active' : ''}`} onClick={() => setSelectedFolder(ARCHIVE_VIEW)}>
                  <span>🗄</span> Archived <em>{summary?.archived_count ?? 0}</em>
                </button>
              </li>
              <li>
                <button className={`link-btn ${selectedFolder === RECYCLE_BIN ? 'active' : ''}`} onClick={() => setSelectedFolder(RECYCLE_BIN)}>
                  <span>🗑</span> Recycle Bin <em>{summary?.recycle_bin_count ?? 0}</em>
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
            {isRecycleBinView ? (
              <RecycleBinPanel
                projectId={projectId!}
                items={cases}
                loading={casesLoading}
                total={total} totalPages={totalPages} page={page} pageSize={pageSize}
                hasNext={hasNext} hasPrevious={hasPrevious}
                onPageChange={goToPage} onPageSizeChange={goToPageSize}
                search={search} onSearchChange={setSearch}
                canRestore={canAuthor}
                canPurge={canManageRepoGovernance}
                onChanged={refreshCases}
              />
            ) : (
            <>
            <div className="tm-current-view">
              <div>
                <small>Current view</small>
                <h3>{currentViewTitle}</h3>
                <p>{currentViewDescription}</p>
              </div>
              <span>{total} test case{total !== 1 ? 's' : ''}</span>
            </div>
            <div className="tm-repository-summary">
              <div><small>Test cases</small><strong>{summary?.scoped_total ?? 0}</strong></div>
              <div><small>Approved</small><strong>{summary?.scoped_approved_count ?? 0}</strong></div>
              <div><small>Pending review</small><strong>{summary?.scoped_in_review_count ?? 0}</strong></div>
              <div><small>Critical</small><strong>{summary?.scoped_critical_count ?? 0}</strong></div>
            </div>
            <div className="tm-list-toolbar">
              <ClearableSearchInput value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} clearLabel="Clear test case search" wrapperClassName="search-grow" placeholder="Search cases, epics, features, or stories…" />
              <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}><option value="">All priorities</option>{TEST_CASE_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All current statuses</option>{TEST_CASE_CURRENT_STATUSES.map((s) => <option key={s} value={s}>{TEST_CASE_STATUS_LABELS[s] || s}</option>)}</select>
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}><option value="">All tags</option>{availableTags.map((tag) => <option key={tag}>{tag}</option>)}</select>
              {(canReview || canQAGroupNewPath) && (
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === REVIEW_QUEUE_TOKEN ? 'btn-primary' : ''}`}
                  onClick={() => setStatusFilter(statusFilter === REVIEW_QUEUE_TOKEN ? '' : REVIEW_QUEUE_TOKEN)}
                >
                  Review queue ({summary?.in_review_count ?? 0})
                </button>
              )}
              {(canGiveFinalApproval || canManageRepoGovernance) && (
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === FINAL_APPROVAL_QUEUE_TOKEN ? 'btn-primary' : ''}`}
                  onClick={() => setStatusFilter(statusFilter === FINAL_APPROVAL_QUEUE_TOKEN ? '' : FINAL_APPROVAL_QUEUE_TOKEN)}
                >
                  Final approval queue ({summary?.review_completed_count ?? 0})
                </button>
              )}
              <span>{total} result{total !== 1 ? 's' : ''}</span>
            </div>
            <div className="tm-checkout-guide" role="note" aria-label="How test case editing access works">
              <span className="tm-checkout-guide-icon">↔</span>
              <strong>Safe editing</strong>
              <InfoTooltip label="About safe editing" content={<><b>Start editing</b> reserves and opens the test case for you. When finished, use <b>Finish editing</b> to release it for another QA user.</>} />
            </div>
            {selectedCount > 0 && canSelectCases && projectIsActive && (
              <div className="tm-bulk-bar" role="region" aria-label={selectedCount > 1 ? 'Bulk test case actions' : 'Test case actions'}>
                <strong>{selectedCount} test case{selectedCount !== 1 ? 's' : ''} selected</strong>
                {canAuthor && submittableSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkSubmit(true)}>Submit for review ({submittableSelectedIds.length})</button>}
                {/* 2026-08 fix: recommendSelectedIds/finalApproveSelectedIds already
                    include NEW-path-eligible rows (see their own comments above), but
                    these two buttons were still gated on the OLD-path-only canReview/
                    canGiveFinalApproval flags, matching the "Review queue"/"Final
                    approval queue" filter buttons above did already -- so a QA Group/
                    QA Lead Group member with no old-path project access could select
                    an eligible NEW-path testcase and never see a button to act on it. */}
                {(canReview || canQAGroupNewPath) && recommendSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkRecommend(true)}>{selectionActionLabel(recommendSelectedIds.length, 'Recommend')} ({recommendSelectedIds.length})</button>}
                {(canGiveFinalApproval || canManageRepoGovernance) && finalApproveSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkApprove(true)}>{selectionActionLabel(finalApproveSelectedIds.length, 'Approve')} ({finalApproveSelectedIds.length})</button>}
                {/* 2026-08 -- bulk counterparts to the single-case "Return for Correction"/"Reject" decisions,
                    NEW-path only (see returnRejectSelectedIds above and bulk_return_test_cases/
                    bulk_reject_test_cases on the backend). */}
                {(canQAGroupNewPath || canManageRepoGovernance) && returnRejectSelectedIds.length > 0 && <button className="btn btn-sm" onClick={() => setShowBulkReturn(true)}>{selectionActionLabel(returnRejectSelectedIds.length, 'Return For Correction')} ({returnRejectSelectedIds.length})</button>}
                {(canQAGroupNewPath || canManageRepoGovernance) && returnRejectSelectedIds.length > 0 && <button className="btn btn-sm btn-danger" onClick={() => setShowBulkReject(true)}>{selectionActionLabel(returnRejectSelectedIds.length, 'Reject')} ({returnRejectSelectedIds.length})</button>}
                {canOpenBulkUpdate && <button className="btn btn-sm" onClick={() => setShowBulkUpdate(true)}>{selectionActionLabel(selectedCount, 'update')}</button>}
                {/* 2026-08 -- "Final-Approved Test Case Deletion and Archive Requirement": Delete only ever
                    targets deletableSelectedIds (never-governed cases) -- an Approved/Archived/Rejected case in
                    the same selection is silently excluded from the delete count/payload rather than blocking
                    the whole batch, and is instead offered "Archive Selected" alongside it. */}
                {canAuthor && deletableSelectedIds.length > 0 && <button className="btn btn-sm btn-danger" onClick={() => setShowBulkDelete(true)}>{selectionActionLabel(deletableSelectedIds.length, 'Delete')} ({deletableSelectedIds.length})</button>}
                {archivableSelectedIds.length > 0 && <button className="btn btn-sm" onClick={() => setShowBulkArchive(true)}>Archive selected ({archivableSelectedIds.length})</button>}
                {restorableSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkRestore(true)}>Restore selected ({restorableSelectedIds.length})</button>}
                {governedSelectedIds.length > 0 && deletableSelectedIds.length === 0 && archivableSelectedIds.length === 0 && (
                  <span className="muted small">{governedSelectedIds.length} selected test case{governedSelectedIds.length !== 1 ? 's are' : ' is'} approval-governed history and {governedSelectedIds.length !== 1 ? 'are' : 'is'} not eligible for deletion.</span>
                )}
                <button className="btn btn-sm" onClick={() => setSelectedCaseIds(new Set())}>Clear selection</button>
              </div>
            )}
            <Table
              rowKey="id"
              onRowClick={(c) => openCase(c.id)}
              server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange: goToPage, onPageSizeChange: goToPageSize, loading: casesLoading }}
              columns={[
                {
                  key: 'selection',
                  // Select All only ever selects/deselects the currently-eligible
                  // rows on this page and shows an indeterminate dash when some
                  // (but not all) of them are selected -- disabled entirely when
                  // no row on the page is eligible for anything.
                  header: canSelectCases && projectIsActive ? (
                    <input
                      type="checkbox"
                      checked={allEligibleSelected}
                      disabled={eligibleOnPageIds.length === 0}
                      ref={(el) => { if (el) el.indeterminate = someEligibleSelected && !allEligibleSelected }}
                      onChange={toggleAllVisible}
                      aria-label={allEligibleSelected ? 'Deselect all eligible test cases on this page' : 'Select all eligible test cases on this page'}
                    />
                  ) : null,
                  render: (c) => {
                    if (!(canSelectCases && projectIsActive)) return null
                    const { eligible, reason } = checkboxEligibility(c)
                    return (
                      <span onClick={(e) => e.stopPropagation()} title={!eligible ? reason : undefined}>
                        <input
                          type="checkbox"
                          checked={selectedCaseIds.has(c.id)}
                          disabled={!eligible}
                          onChange={() => toggleSelected(c.id)}
                          aria-label={eligible ? `Select ${c.test_case_key}` : `${c.test_case_key} not eligible for selection: ${reason}`}
                        />
                      </span>
                    )
                  },
                  filterable: false,
                },
                { key: 'test_case_key', header: 'Test Case', render: (c) => <span className="tm-test-case-cell"><strong>{openingCaseId === c.id ? 'Opening…' : c.test_case_key}</strong><small>{c.test_scenario || 'Scenario not provided'}{c.module_name ? ` · ${c.module_name}` : ''}</small></span>, filterValue: (c) => `${c.test_case_key} ${c.test_scenario || ''} ${c.module_name || ''}` },
                { key: 'epic_id', header: 'Epic / CR / Story', render: (c) => <span className="tm-hierarchy-cell"><strong>{c.epic_id || '—'}</strong><small>{[c.cr_number, c.feature_id, c.user_story_id].filter(Boolean).join(' · ') || 'No mapping'}</small></span>, filterValue: (c) => `${c.epic_id || ''} ${c.cr_number || ''} ${c.feature_id || ''} ${c.user_story_id || ''}` },
                { key: 'classification', header: 'Type / Priority', render: (c) => <span className="tm-classification-cell"><strong>{c.test_type || '—'}</strong>{c.priority ? <Badge status={c.priority} /> : <small>No priority</small>}</span>, filterValue: (c) => `${c.test_type || ''} ${c.priority || ''}` },
                { key: 'tags', header: 'Tags', render: (c) => <span className="tm-case-tags">{(c.tags || []).length ? c.tags.map((tag) => <button type="button" key={tag} onClick={(event) => { event.stopPropagation(); setTagFilter(tag) }}>{tag}</button>) : <small>—</small>}</span>, filterValue: (c) => (c.tags || []).join(' ') },
                { key: 'status', header: 'Workflow', render: (c) => {
                  // Prefer the real assignee (APR-006) over the static
                  // status->role fallback map; surface pending_since too so
                  // SLA aging is visible without opening the record. Reported
                  // directly: "Pending with author, give details who have
                  // uploaded" (now covered -- pending_with_user_name returns
                  // the real author for every Returned-family status, NEW-path
                  // included, see models.TestCaseVersion.pending_with_user_name)
                  // and "show the group name where pending approval, on click
                  // of group name, members will be visible" (NEW-path group
                  // statuses below render a clickable RoleGroupLink instead of
                  // plain text).
                  // A never-submitted Draft has no pending_with_user_name
                  // (nothing's actually pending review yet), so its fallback
                  // is the bare word "Author" -- swap in the real author's
                  // name there specifically, same reported request.
                  const pendingWithLabel = c.pending_with_user_name
                    || (c.status === 'Draft' ? c.current_draft_author_name : null)
                    || TEST_CASE_PENDING_WITH[c.status]
                  const groupRole = TEST_CASE_PENDING_GROUP_ROLES[c.status]
                  // Final states have no next actor. The fallback map uses
                  // an em dash for those states; treating that as a person
                  // produced the confusing literal "Pending with —" below
                  // an already Approved badge.
                  const hasPendingActor = !!pendingWithLabel && pendingWithLabel !== '—'
                  return (
                    <span className="tm-workflow-cell">
                      <Badge status={c.status} label={TEST_CASE_STATUS_LABELS[c.status] || c.status} />
                      {groupRole && hasPendingActor ? (
                        <span className="tm-workflow-pending-group" onClick={(e) => e.stopPropagation()}>
                          <small>Pending with</small>
                          <RoleGroupLink users={users} role={groupRole} label={pendingWithLabel || 'group'} />
                        </span>
                      ) : hasPendingActor ? <small>Pending with {pendingWithLabel}</small> : null}
                      {/* "along with Pending with details, show submitted by as well" --
                          current_draft_submitted_by_name is only ever set once the current
                          draft has actually been submitted, so this stays absent for a
                          never-submitted Draft (nothing to attribute yet). */}
                      {c.current_draft_submitted_by_name && (
                        <small className="muted">Submitted by {c.current_draft_submitted_by_name}</small>
                      )}
                      {/* Reported directly: a checkbox disabled because the viewer authored
                          the draft was a mystery when the row only ever showed who SUBMITTED
                          it -- author and submitter are frequently different people (authoring
                          is a broad team-tier permission, anyone on the team can pick up and
                          submit someone else's draft) and GOV-002 blocks the author regardless
                          of who submitted. Only shown once actually submitted (mirrors the
                          "Submitted by" line above) and only when it adds information, i.e.
                          differs from the submitter -- otherwise it's a redundant restatement. */}
                      {c.current_draft_submitted_by_name && c.current_draft_author_name
                        && c.current_draft_author_name !== c.current_draft_submitted_by_name && (
                        <small className="muted">Authored by {c.current_draft_author_name}</small>
                      )}
                      {/* Reported directly: "Add Recommended By once recommended" -- only ever
                          set once Stage 1 has actually been decided (review_test_case /
                          bulk_recommend_test_cases both set reviewed_by_id on recommend), so this
                          is naturally absent while still at "Recommendation Pending" and only
                          appears once the case has moved on to "QA Lead Approval Pending" (or
                          beyond, until a fresh draft resets it). */}
                      {c.current_draft_reviewed_by_name && (
                        <small className="muted">Recommended by {c.current_draft_reviewed_by_name}</small>
                      )}
                      {hasPendingActor && c.pending_since && (
                        <small className="muted" title={`Pending since ${formatDateTimeIST(c.pending_since)}`}>
                          Since {formatDateIST(c.pending_since)}
                        </small>
                      )}
                    </span>
                  )
                }, filterValue: (c) => {
                  const pending = c.pending_with_user_name || TEST_CASE_PENDING_WITH[c.status] || ''
                  return `${TEST_CASE_STATUS_LABELS[c.status] || c.status} ${pending === '—' ? '' : pending}`
                } },
                { key: 'version', header: 'Version', render: (c) => <span className="badge badge-gray">{`v${c.version || '1.0'}`}</span>, filterValue: (c) => `v${c.version || '1.0'}` },
                { key: 'steps', header: 'Steps', render: (c) => c.steps_count, filterable: false },
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
              rows={cases}
            />
            </>
            )}
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
          onImported={() => refreshCases()}
        />
      )}
      {showBulkUpdate && projectId && projectIsActive && (
        <BulkUpdateModal
          projectId={projectId}
          selectedCases={selectedCases}
          folders={folders}
          onClose={() => setShowBulkUpdate(false)}
          onUpdated={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkApprove && projectId && projectIsActive && (
        <BulkApproveModal
          projectId={projectId}
          selectedIds={finalApproveSelectedIds}
          onClose={() => setShowBulkApprove(false)}
          onApproved={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkRecommend && projectId && selectedProject && projectIsActive && (
        <BulkRecommendModal
          project={selectedProject}
          selectedCases={cases.filter((testCase) => recommendSelectedIds.includes(testCase.id))}
          onClose={() => setShowBulkRecommend(false)}
          onRecommended={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkReturn && projectId && selectedProject && projectIsActive && (
        <BulkDecisionModal
          action="return"
          project={selectedProject}
          selectedCases={cases.filter((testCase) => returnRejectSelectedIds.includes(testCase.id))}
          onClose={() => setShowBulkReturn(false)}
          onDone={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkReject && projectId && selectedProject && projectIsActive && (
        <BulkDecisionModal
          action="reject"
          project={selectedProject}
          selectedCases={cases.filter((testCase) => returnRejectSelectedIds.includes(testCase.id))}
          onClose={() => setShowBulkReject(false)}
          onDone={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkSubmit && projectId && selectedProject && projectIsActive && (
        <BulkSubmitModal
          project={selectedProject}
          selectedCases={cases.filter((testCase) => submittableSelectedIds.includes(testCase.id))}
          onClose={() => setShowBulkSubmit(false)}
          onSubmitted={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkDelete && deletableSelectedIds.length > 0 && (
        <ConfirmModal
          title={`Delete ${deletableSelectedIds.length} test case${deletableSelectedIds.length !== 1 ? 's' : ''}?`}
          message={<div>
            <p>This will move {deletableSelectedIds.length} test case{deletableSelectedIds.length !== 1 ? 's' : ''} to the Recycle Bin.</p>
            <p className="muted small">They can be restored from the Recycle Bin, or permanently cleared by an authorized QA Lead.</p>
            {governedSelectedIds.length > 0 && (
              <p className="muted small">{governedSelectedIds.length} other selected test case{governedSelectedIds.length !== 1 ? 's are' : ' is'} approval-governed history (approved, archived, or rejected) and will be skipped -- archive {governedSelectedIds.length !== 1 ? 'them' : 'it'} instead.</p>
            )}
          </div>}
          confirmLabel={`Delete ${deletableSelectedIds.length} test case${deletableSelectedIds.length !== 1 ? 's' : ''}`}
          cancelLabel="Keep test cases"
          destructive
          busy={bulkDeleteBusy}
          onConfirm={bulkDelete}
          onCancel={() => setShowBulkDelete(false)}
        />
      )}
      {showBulkArchive && projectId && archivableSelectedIds.length > 0 && (
        <BulkArchiveModal
          projectId={projectId}
          selectedIds={archivableSelectedIds}
          onClose={() => setShowBulkArchive(false)}
          onArchived={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
        />
      )}
      {showBulkRestore && projectId && restorableSelectedIds.length > 0 && (
        <BulkRestoreFromArchiveModal
          projectId={projectId}
          selectedIds={restorableSelectedIds}
          onClose={() => setShowBulkRestore(false)}
          onRestored={() => {
            refreshCases()
            setSelectedCaseIds(new Set())
          }}
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
          onSaved={(saved) => {
            // 2026-08 -- reported directly: Save shouldn't close this modal
            // (every other action here -- checkout, submit, review -- leaves
            // it open too). Refresh the underlying list in the background,
            // but keep the modal open against the now-saved record -- this
            // also matters functionally for a brand-new testcase ('new' ->
            // real id), since TestCaseModal's own `existing` prop is what
            // decides POST-vs-PATCH on the next Save.
            refreshCases()
            setEditingCase(saved)
          }}
          onDeleted={() => { refreshCases(); setEditingCase(null) }}
          onReviewed={() => {
            refreshCases()
            setEditingCase(null)
          }}
          onCheckoutChange={(tc) => {
            reloadCases()
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
          onDone={() => { setFolderAction(null); loadFolders(projectId); refreshCases() }}
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
