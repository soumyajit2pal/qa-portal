import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { ErrorText, Field, Modal } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import type { TestCaseListOut, TestCaseMovePreviewOut, TestCaseOut, TestFolderOut, TestProjectOut } from '../../types'

function folderPath(folders: TestFolderOut[], folder: TestFolderOut): string {
  const names: string[] = [], seen = new Set<number>()
  let current: TestFolderOut | undefined = folder
  while (current && !seen.has(current.id)) {
    seen.add(current.id); names.unshift(current.name)
    current = folders.find(parent => parent.id === current?.parent_id)
  }
  return names.join(' / ')
}

export default function TestCaseMoveModal({ sourceProject, projects, cases, onClose, onMoved }: {
  sourceProject: TestProjectOut
  projects: TestProjectOut[]
  cases: Pick<TestCaseListOut, 'id' | 'test_case_key'>[]
  onClose: () => void
  onMoved: () => void
}) {
  const [ids, setIds] = useState(() => cases.map(testCase => testCase.id))
  const [targetId, setTargetId] = useState<number | ''>('')
  const [folderId, setFolderId] = useState<number | ''>('')
  const [folders, setFolders] = useState<TestFolderOut[]>([])
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<TestCaseMovePreviewOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const destinations = projects.filter(project => project.id !== sourceProject.id && project.is_active && !project.is_archived
    && project.workspace_contributable && project.qa_workspace_id === sourceProject.qa_workspace_id)
  const target = destinations.find(project => project.id === targetId)
  const targetFolder = folders.find(folder => folder.id === folderId)

  useEffect(() => {
    let current = true
    setFolders([])
    setLoadingFolders(!!targetId)
    if (targetId) {
      api.getFresh<TestFolderOut[]>(`/api/test-repository/projects/${targetId}/folders`)
        .then(result => { if (current) setFolders(result.filter(folder => folder.workspace_writable)) })
        .catch(err => { if (current) { setError(err); setTargetId('') } })
        .finally(() => { if (current) setLoadingFolders(false) })
    }
    return () => { current = false }
  }, [targetId])

  const targetBody = { ids, target_project_id: targetId, folder_id: folderId || null }
  async function review(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !target || loadingFolders || !reason.trim() || !ids.length) return
    setBusy(true); setError(null)
    try {
      setPreview(await api.post<TestCaseMovePreviewOut>(
        `/api/test-repository/projects/${sourceProject.id}/test-cases/move-preview`, targetBody))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function move() {
    if (busy || !preview || preview.blocked.length || !preview.eligible_ids.length) return
    setBusy(true); setError(null)
    try {
      const body = { ...targetBody, reason: reason.trim() }
      if (cases.length === 1) {
        await api.post<TestCaseOut>(`/api/test-repository/test-cases/${ids[0]}/move`, body)
      } else {
        await api.post<TestCaseOut[]>(`/api/test-repository/projects/${sourceProject.id}/test-cases/bulk-move`, body)
      }
      onMoved()
    } catch (err) {
      setPreview(null)
      setError(err)
    } finally { setBusy(false) }
  }

  return (
    <Modal title={preview ? 'Confirm project move' : 'Move to another project'} onClose={onClose}
      closeDisabled={busy} preventBackdropClose>
      <div className="tm-project-move-route">
        <span>From project</span><strong>{sourceProject.project_key} — {sourceProject.name}</strong>
        <small>{ids.length} test case{ids.length === 1 ? '' : 's'} selected</small>
      </div>
      {!preview ? (
        <form onSubmit={review}>
          <p className="muted small">Move unused Draft cases between projects in this workspace. Cases that have entered review or have cycle or defect links must be cloned instead.</p>
          <Field label="Destination project *">
            <SearchableSelect value={String(targetId)} onChange={value => {
              setTargetId(value ? Number(value) : ''); setFolderId(''); setError(null)
            }} options={destinations.map(project => ({ value: String(project.id), label: `${project.project_key} — ${project.name}` }))}
              placeholder="Choose an active project" disabled={busy} />
          </Field>
          {!destinations.length && <p role="status">No other active project in this workspace is writable for you.</p>}
          <Field label="Destination folder">
            <SearchableSelect value={String(folderId)} onChange={value => setFolderId(value ? Number(value) : '')}
              disabled={!target || loadingFolders || busy} placeholder={loadingFolders ? 'Loading folders…' : 'Unfiled'}
              options={[{ value: '', label: 'Unfiled' }, ...folders.map(folder => ({ value: String(folder.id), label: folderPath(folders, folder) }))]} />
          </Field>
          <Field label="Reason *">
            <textarea required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}
              disabled={busy} placeholder="For example: uploaded into the wrong project" rows={3} />
          </Field>
          <div className="modal-actions">
            <button className="btn btn-primary" disabled={busy || !target || loadingFolders || !reason.trim() || !ids.length || ids.length > 500}>
              {busy ? 'Checking cases…' : 'Review move'}
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
          {ids.length > 500 && <p role="alert">Select at most 500 test cases for one move.</p>}
        </form>
      ) : (
        <div>
          <div className="tm-project-move-route">
            <span>To project</span><strong>{target?.project_key} — {target?.name}</strong>
            <small>Folder: {targetFolder ? folderPath(folders, targetFolder) : 'Unfiled'}</small>
          </div>
          <p><strong>Reason:</strong> {reason.trim()}</p>
          <p>{preview.eligible_ids.length} eligible; {preview.blocked.length} blocked.</p>
          {preview.blocked.length > 0 ? (
            <>
              <p role="alert">The entire selection must be eligible before it can move. No cases have been moved.</p>
              <ul className="tm-project-move-blocked">
                {preview.blocked.map(item => <li key={item.id}><strong>{item.test_case_key}</strong><ul>
                  {item.reasons.map(itemReason => <li key={itemReason}>{itemReason}</li>)}
                </ul></li>)}
              </ul>
              {preview.eligible_ids.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => {
                setIds(preview.eligible_ids); setPreview(null)
              }}>Select only eligible cases ({preview.eligible_ids.length})</button>}
            </>
          ) : <p>All {ids.length} cases will leave the source project. Their IDs, definitions, versions, tags, author and history are preserved. The move is recorded in Activity.</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" disabled={busy || preview.blocked.length > 0 || !preview.eligible_ids.length}
              onClick={move}>{busy ? 'Moving cases…' : `Move ${ids.length} test case${ids.length === 1 ? '' : 's'}`}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>Back</button>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
      <ErrorText error={error} />
    </Modal>
  )
}
