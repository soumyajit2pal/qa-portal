import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ErrorText, Modal } from '../../components/Common'
import { RequestDocumentOut } from '../../types'

export type EvidenceKind = 'functional' | 'sast' | 'dast' | 'performance'

export function evidenceKey(kind: EvidenceKind, itemIndex: number): string {
  return `${kind}:${itemIndex}`
}

export function ChecklistEvidencePicker({
  kind,
  itemIndex,
  draftRequestId,
  files,
  onFilesChange,
  required = false,
}: {
  kind: EvidenceKind
  itemIndex: number
  draftRequestId?: number
  files: File[]
  onFilesChange: (files: File[]) => void
  // Whether this item is mandatory or self-declared checked -- purely a
  // visual hint suggesting evidence would be useful here; nothing enforces
  // it, raising the request works either way (see RequestDetail.tsx's
  // non-blocking heads-up pop-up at Raise time for the one place this is
  // actually surfaced as a prompt, not a requirement).
  required?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [savedFiles, setSavedFiles] = useState<RequestDocumentOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<RequestDocumentOut | null>(null)

  const endpoint = draftRequestId
    ? `/api/qa-requests/${draftRequestId}/checklist-evidence/${kind}/${itemIndex}/documents`
    : ''

  const load = useCallback(async () => {
    if (!endpoint) return
    try {
      setSavedFiles(await api.get<RequestDocumentOut[]>(endpoint))
    } catch (err) {
      setError(err)
    }
  }, [endpoint])

  useEffect(() => {
    load()
  }, [load])

  async function deleteSavedFile() {
    if (!pendingDelete || !endpoint) return
    setDeleteBusy(true)
    setError(null)
    try {
      await api.del(`${endpoint}/${pendingDelete.id}`)
      setPendingDelete(null)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setDeleteBusy(false)
    }
  }

  const totalFiles = savedFiles.length + files.length

  return (
    <div style={{ marginLeft: 'auto', width: 250, minWidth: 210 }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFilesChange([...files, ...Array.from(e.target.files || [])])
          e.target.value = ''
        }}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()}>
          Attach evidence
        </button>
        {totalFiles > 0 && <span className="badge badge-blue">{totalFiles} file{totalFiles !== 1 ? 's' : ''}</span>}
        {required && totalFiles === 0 && (
          <span
            className="badge badge-gray"
            title="This item is mandatory or checked off -- attaching evidence isn't required to raise this request, but it's recommended."
          >
            Evidence recommended
          </span>
        )}
      </div>
      {(savedFiles.length > 0 || files.length > 0) && (
        <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
          {savedFiles.map((document) => (
            <div key={document.id} style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
              <button
                type="button"
                className="btn btn-sm"
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`Download ${document.file_name}`}
                onClick={() => api.downloadFile(`${endpoint}/${document.id}/download`, document.file_name)}
              >
                {document.file_name}
              </button>
              <button type="button" className="btn btn-sm btn-danger" aria-label={`Delete ${document.file_name}`} onClick={() => setPendingDelete(document)}>×</button>
            </div>
          ))}
          {files.map((file, index) => (
            <div key={`${file.name}-${index}`} style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
              <span className="muted small" title={file.name} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file.name} · uploads when draft is saved
              </span>
              <button type="button" className="btn btn-sm" aria-label={`Remove ${file.name}`} onClick={() => onFilesChange(files.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
        </div>
      )}
      <ErrorText error={error} />
      {pendingDelete && (
        <Modal title="Delete checklist evidence?" variant="dialog" preventBackdropClose onClose={() => setPendingDelete(null)}>
          <p>Delete <strong>{pendingDelete.file_name}</strong>? This cannot be undone.</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button type="button" className="btn btn-danger" disabled={deleteBusy} onClick={deleteSavedFile}>{deleteBusy ? 'Deleting…' : 'Delete'}</button>
            <button type="button" className="btn" disabled={deleteBusy} onClick={() => setPendingDelete(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
