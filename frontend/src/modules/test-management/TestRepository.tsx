import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import { hasRole, TEST_CASE_TYPES, TEST_CASE_STATUSES, TEST_CASE_STATUS_LABELS, TEST_CASE_PENDING_WITH, TEST_CASE_PRIORITIES } from '../../constants'
import { TestProjectOut, TestFolderOut, TestCaseOut, TestStepIn, TestCaseImportResult, ApprovalActionOut } from '../../types'
import ConfirmModal from '../../components/ConfirmModal'
import JiraActivity from '../../components/JiraActivity'
import ClearableSearchInput from '../../components/ClearableSearchInput'

// Test Repository module -- folder tree + test case authoring/import, under
// a selected Test Project. QA Engineer + QA Lead both author (create/edit/
// import/delete); everyone with portal access can browse/read (Admin
// bypasses the author gate automatically via hasRole).
const CAN_AUTHOR_ROLES = ['QA_ENGINEER', 'QA_LEAD']
const UNFILED = '__unfiled__'

function emptyStep(stepNo: number): TestStepIn {
  return { step_no: stepNo, step_text: '', expected_result: '' }
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
            pending QA Lead review again.
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
      onClose={stage === 'importing' ? () => undefined : onClose}
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
              test case's first row. Imported definitions enter QA Lead review; execution-result
              columns are not added to a cycle until the testcase is approved.
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
            <div className="info-banner">Imported test cases are pending QA Lead verification. They will become available in Test Cycles only after approval.</div>
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

function TestCaseReviewModal({ testCase, decision, onClose, onReviewed }: {
  testCase: TestCaseOut
  decision: 'APPROVE' | 'RETURN'
  onClose: () => void
  onReviewed: (testCase: TestCaseOut) => void
}) {
  const [comments, setComments] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const approving = decision === 'APPROVE'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!approving && !comments.trim()) {
      setError(new Error('Explain what the QA Tester must change before resubmitting'))
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
    <Modal title={approving ? 'Approve test case?' : 'Return test case for changes?'} onClose={onClose} variant="dialog" preventBackdropClose hideCloseButton>
      <form onSubmit={submit}>
        <div className="tm-review-summary">
          <strong>{testCase.test_case_key}</strong>
          <span>{testCase.test_scenario || 'No scenario provided'}</span>
        </div>
        <p>{approving
          ? 'Confirm that you verified the definition and steps. Approval makes this test case immediately available for Test Cycles.'
          : 'This test case will remain unavailable for Test Cycles until the QA Tester addresses your comments and it is approved.'}</p>
        <Field label={approving ? 'Verification notes (optional)' : 'Reason and required changes *'}>
          <textarea required={!approving} rows={4} value={comments} onChange={(e) => setComments(e.target.value)} placeholder={approving ? 'Add verification notes…' : 'Describe exactly what must be corrected…'} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className={`btn ${approving ? 'btn-primary' : 'btn-danger'}`} disabled={busy}>
            {busy ? 'Saving decision…' : approving ? 'Verify and approve' : 'Return for changes'}
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
    <Modal title={title} onClose={stage === 'approving' ? () => undefined : onClose} variant="dialog" preventBackdropClose hideCloseButton>
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

function TestCaseModal({ projectId, folders, folderId, existing, onClose, onSaved, onDeleted, onReviewed, onCheckoutChange, canAuthor, canReview }: {
  projectId: number
  folders: TestFolderOut[]
  folderId: number | ''
  existing: TestCaseOut | null
  onClose: () => void
  onSaved: (tc: TestCaseOut) => void
  onDeleted: (id: number) => void
  onReviewed: (tc: TestCaseOut) => void
  onCheckoutChange: (tc: TestCaseOut) => void
  canAuthor: boolean
  canReview: boolean
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
  const [steps, setSteps] = useState<TestStepIn[]>(
    existing?.steps.length ? existing.steps.map((s) => ({ step_no: s.step_no, step_text: s.step_text, expected_result: s.expected_result })) : [emptyStep(1)]
  )
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reviewDecision, setReviewDecision] = useState<'APPROVE' | 'RETURN' | null>(null)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const { user } = useAuth()
  // Reported directly: "check in checkout option should be available for
  // testcases, otherwise multiple people can edit at once, if checkout, the
  // testcase is locked for editing by that user." A case someone ELSE
  // checked out is forced read-only here too (not just on the backend,
  // which would otherwise only surface as a 423 on Save) -- lockedByMe
  // leaves editing open as normal.
  const lockedByOther = !!existing?.checked_out_by_id && existing.checked_out_by_id !== user?.id
  const lockedByMe = !!existing?.checked_out_by_id && existing.checked_out_by_id === user?.id
  const readOnly = !canAuthor || lockedByOther

  useEffect(() => {
    if (existing) api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_CASE&entity_id=${existing.id}`).then(setActivity).catch(() => setActivity([]))
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
    setBusy(true); setError(null)
    const body = {
      test_case_key: null,
      folder_id: folder || null,
      epic_id: epicId || null, cr_number: crNumber || null, feature_id: featureId || null, user_story_id: userStoryId || null,
      test_type: testType || null, module_name: moduleName || null, test_scenario: scenario || null,
      pre_condition: preCondition || null, description: description || null,
      priority: priority || null,
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
          <Field label="Workflow Status">
            <div className="tm-workflow-status-field">
              <Badge status={existing?.status || 'Draft'} label={TEST_CASE_STATUS_LABELS[existing?.status || 'Draft']} />
              <small>{existing?.status === 'Active' ? 'Available for Test Cycles' : 'Unavailable until QA Lead approval'}</small>
            </div>
          </Field>
          {existing && (
            <Field label="Version">
              <div className="tm-workflow-status-field">
                <span className="badge badge-gray">{`v${existing.version || '1.0'}`}</span>
                <small>Bumps automatically on each QA Lead re-approval after an edit</small>
              </div>
            </Field>
          )}
          {existing && (
            <Field label="Checkout">
              <div className="tm-workflow-status-field">
                {existing.checked_out_by_id ? (
                  <span className={`badge ${lockedByMe ? 'badge-blue' : 'badge-yellow'}`}>
                    {lockedByMe ? 'Checked out by you' : `Checked out by ${existing.checked_out_by_name}`}
                  </span>
                ) : (
                  <span className="badge badge-gray">Not checked out</span>
                )}
                {canAuthor && (lockedByMe || !existing.checked_out_by_id) && (
                  <button type="button" className="btn btn-sm" onClick={toggleCheckout} disabled={checkoutBusy}>
                    {checkoutBusy ? '...' : lockedByMe ? 'Check in' : 'Check out'}
                  </button>
                )}
              </div>
            </Field>
          )}
        </div>
        {lockedByOther && (
          <div className="info-banner">
            <strong>{existing?.checked_out_by_name}</strong> has this test case checked out, so it's locked
            for editing until they check it back in (an Administrator can force a check-in if needed).
          </div>
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
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            {existing && <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</button>}
          </div>
        )}
      </form>
      {existing && canReview && (
        <div className="tm-review-actions">
          <div><strong>QA Lead verification</strong><span>Review the definition and steps before making it available for execution.</span></div>
          {existing.status !== 'Active' && <button className="btn btn-primary" onClick={() => setReviewDecision('APPROVE')}>Verify and approve</button>}
          <button className="btn" onClick={() => setReviewDecision('RETURN')}>Return for changes</button>
        </div>
      )}
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
          onClose={() => setReviewDecision(null)}
          onReviewed={onReviewed}
        />
      )}
    </Modal>
  )
}

function BulkUpdateModal({ projectId, selectedIds, folders, onClose, onUpdated }: {
  projectId: number
  selectedIds: number[]
  folders: TestFolderOut[]
  onClose: () => void
  onUpdated: (cases: TestCaseOut[]) => void
}) {
  type BulkUpdateStage = 'edit' | 'confirm' | 'updating' | 'success' | 'error'
  type BulkUpdateBody = { ids: number[]; folder_id?: number | null; priority?: string }
  const [folder, setFolder] = useState('unchanged')
  const [priority, setPriority] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [stage, setStage] = useState<BulkUpdateStage>('edit')
  const [pendingBody, setPendingBody] = useState<BulkUpdateBody | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('Waiting to start')
  const [failurePoint, setFailurePoint] = useState('validating the selected test cases')
  const totalSelected = useState(selectedIds.length)[0]

  const changeSummary = useMemo(() => {
    const changes: string[] = []
    if (folder !== 'unchanged') {
      const folderName = folder === 'unfiled' ? 'Unfiled' : folders.find((item) => item.id === Number(folder))?.name || 'Selected folder'
      changes.push(`Folder → ${folderName}`)
    }
    if (priority) changes.push(`Priority → ${priority}`)
    return changes
  }, [folder, folders, priority])

  function review(e: React.FormEvent) {
    e.preventDefault()
    const body: BulkUpdateBody = { ids: selectedIds }
    if (folder !== 'unchanged') body.folder_id = folder === 'unfiled' ? null : Number(folder)
    if (priority) body.priority = priority
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
    <Modal title={title} onClose={stage === 'updating' ? () => undefined : onClose} variant="dialog" preventBackdropClose hideCloseButton>
      {stage === 'edit' && <form onSubmit={review}>
        <p className="muted small">Only the fields changed below will be applied. Existing test steps and other details will remain unchanged.</p>
        <Field label="Folder">
          <SearchableSelect
            value={folder}
            onChange={setFolder}
            options={[
              { value: 'unchanged', label: 'No change' },
              { value: 'unfiled', label: 'Unfiled' },
              ...folders.map((f) => ({ value: String(f.id), label: folderPathLabel(folders, f) })),
            ]}
          />
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">No change</option>
            {TEST_CASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        {priority && <p className="muted small">Changing priority on an approved test case sends it back to QA Lead review.</p>}
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary">Review update</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
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
  const canAuthor = hasRole(user, ...CAN_AUTHOR_ROLES)
  const canReview = hasRole(user, 'QA_LEAD')
  const canDeleteFolder = hasRole(user, 'QA_LEAD')
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
  const [folderToDelete, setFolderToDelete] = useState<TestFolderOut | null>(null)
  const [folderAction, setFolderAction] = useState<{ mode: 'move' | 'copy'; folder: TestFolderOut } | null>(null)
  const [folderToRename, setFolderToRename] = useState<TestFolderOut | null>(null)
  // Empty by default (nothing collapsed) so every folder that was always
  // visible under the old flat list stays visible after this change too --
  // collapsing is purely opt-in per folder.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<number>>(new Set())
  const [deletingFolder, setDeletingFolder] = useState(false)
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<number>>(new Set())
  const [showBulkUpdate, setShowBulkUpdate] = useState(false)
  const [showBulkDelete, setShowBulkDelete] = useState(false)
  const [showBulkApprove, setShowBulkApprove] = useState(false)
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
    if (q) rows = rows.filter((c) => [c.test_case_key, c.test_scenario, c.epic_id, c.cr_number, c.feature_id, c.user_story_id, c.module_name].some((v) => String(v || '').toLowerCase().includes(q)))
    if (priorityFilter) rows = rows.filter((c) => c.priority === priorityFilter)
    if (statusFilter) rows = rows.filter((c) => c.status === statusFilter)
    return rows
  }, [cases, selectedFolder, search, priorityFilter, statusFilter])

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
  const pendingSelectedIds = cases.filter((testCase) => selectedCaseIds.has(testCase.id) && testCase.status === 'Draft').map((testCase) => testCase.id)
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
        <div className="tm-workflow-banner"><span>✓</span><div><strong>Governed test-case workflow</strong><p>QA Tester creates or imports → QA Lead verifies and approves → approved test cases become available in Test Cycles.</p></div></div>
      )}
      {projectId && (
        <div className="tm-workspace">
          <aside className="tm-tree-panel">
            <div className="tm-tree-heading">
              <div><small>Repository structure</small><strong>Folders</strong></div>
              <span>{folders.length}</span>
            </div>
            <ul className="plain-list">
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
            </ul>
            {canAuthor && projectIsActive && <button className="tm-tree-add" onClick={() => setShowNewFolder(true)}>+ Add folder</button>}
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
              <div><small>Approved</small><strong>{cases.filter((c) => c.status === 'Active').length}</strong></div>
              <div><small>Pending review</small><strong>{cases.filter((c) => c.status === 'Draft').length}</strong></div>
              <div><small>Critical</small><strong>{cases.filter((c) => c.priority === 'Critical').length}</strong></div>
            </div>
            <div className="tm-list-toolbar">
              <ClearableSearchInput value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} clearLabel="Clear test case search" wrapperClassName="search-grow" placeholder="Search cases, epics, features, or stories…" />
              <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}><option value="">All priorities</option>{TEST_CASE_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All statuses</option>{TEST_CASE_STATUSES.map((s) => <option key={s} value={s}>{TEST_CASE_STATUS_LABELS[s] || s}</option>)}</select>
              <span>{visibleCases.length} result{visibleCases.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="tm-checkout-guide" role="note" aria-label="How check-out and check-in work">
              <span className="tm-checkout-guide-icon">↔</span>
              <div>
                <strong>Editing a test case</strong>
                <p><b>Check Out</b> reserves the test case for you so others cannot overwrite your changes. <b>Check In</b> releases it after you finish editing.</p>
              </div>
            </div>
            {selectedCount > 0 && canAuthor && projectIsActive && (
              <div className="tm-bulk-bar" role="region" aria-label="Bulk test case actions">
                <strong>{selectedCount} test case{selectedCount !== 1 ? 's' : ''} selected</strong>
                {canReview && pendingSelectedIds.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowBulkApprove(true)}>Bulk approve pending ({pendingSelectedIds.length})</button>}
                <button className="btn btn-sm" onClick={() => setShowBulkUpdate(true)}>Bulk update</button>
                <button className="btn btn-sm btn-danger" onClick={() => setShowBulkDelete(true)}>Bulk delete</button>
                <button className="btn btn-sm" onClick={() => setSelectedCaseIds(new Set())}>Clear selection</button>
              </div>
            )}
            <Table
              rowKey="id"
              onRowClick={(c) => setEditingCase(c)}
              columns={[
                {
                  key: 'selection',
                  header: canAuthor && projectIsActive ? (
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      aria-label={allVisibleSelected ? 'Deselect all filtered test cases' : 'Select all filtered test cases'}
                    />
                  ) : null,
                  render: (c) => canAuthor && projectIsActive ? (
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
                { key: 'status', header: 'Workflow', render: (c) => <span className="tm-workflow-cell"><Badge status={c.status} label={TEST_CASE_STATUS_LABELS[c.status] || c.status} /><small>{TEST_CASE_PENDING_WITH[c.status] ? `Pending with ${TEST_CASE_PENDING_WITH[c.status]}` : 'No action pending'}</small></span>, filterValue: (c) => `${TEST_CASE_STATUS_LABELS[c.status] || c.status} ${TEST_CASE_PENDING_WITH[c.status] || ''}` },
                { key: 'version', header: 'Version', render: (c) => <span className="badge badge-gray">{`v${c.version || '1.0'}`}</span>, filterValue: (c) => `v${c.version || '1.0'}` },
                { key: 'steps', header: 'Steps', render: (c) => c.steps.length, filterable: false },
                {
                  key: 'checkout',
                  header: 'Check-out status',
                  render: (c) => {
                    const lockedByMe = c.checked_out_by_id === user?.id
                    const lockedByOther = !!c.checked_out_by_id && !lockedByMe
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
                            <span className="tm-checkout-state is-mine"><strong>Checked out by you</strong><small>Only you can edit this case</small></span>
                            <button className="btn btn-sm tm-checkin-button" title="Release this test case so another QA user can edit it" onClick={() => checkinCase(c.id)}>Check In</button>
                          </>
                        ) : (
                          <>
                            <span className="tm-checkout-state is-available"><strong>Available to edit</strong><small>Check out before editing</small></span>
                            <button className="btn btn-sm tm-checkout-button" title="Reserve this test case for your editing session" onClick={() => checkoutCase(c.id)}>Check Out</button>
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
          selectedIds={Array.from(selectedCaseIds)}
          folders={folders}
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
          selectedIds={pendingSelectedIds}
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
          folders={folders}
          folderId={typeof selectedFolder === 'number' ? selectedFolder : ''}
          existing={editingCase === 'new' ? null : editingCase}
          canAuthor={canAuthor && projectIsActive}
          canReview={canReview && projectIsActive}
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
