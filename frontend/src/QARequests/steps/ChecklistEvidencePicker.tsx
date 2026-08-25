import React, { useRef, useState } from 'react'
import { api } from '../../api'
import { ErrorText, ChecklistEvidenceFileRow, ChecklistEvidenceDeleteModal, SupportingEvidenceControl } from '../../components/Common'
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
  savedFiles,
  onReload,
  checked = false,
  required = false,
}: {
  kind: EvidenceKind
  itemIndex: number
  draftRequestId?: number
  files: File[]
  onFilesChange: (files: File[]) => void
  // Already-uploaded documents for this one item -- fetched and owned by
  // the wizard (NewRequestModal.tsx), one batched call for every item across
  // every module rather than each picker instance fetching its own (see
  // that component's own loadSavedEvidence for why). Empty until a Draft
  // with this item's own evidence already saved is reopened.
  savedFiles: RequestDocumentOut[]
  // Re-runs that same batched fetch -- called after this picker deletes one
  // of its own already-saved files, so the parent's shared list picks up
  // the removal (harmless to re-fetch everything for one delete; it's a
  // single request either way now, not one per item).
  onReload: () => void
  // Whether this checklist item's own checkbox is currently ticked --
  // reported directly: attaching evidence for an item that isn't even
  // declared "in place" yet doesn't make sense, so new evidence can't be
  // attached until it's checked. Already-saved evidence (e.g. attached
  // while checked, then the box got unticked again) stays visible/
  // deletable regardless -- only adding NEW evidence is blocked.
  checked?: boolean
  // Whether this item is mandatory or self-declared checked -- purely a
  // visual hint suggesting evidence would be useful here; nothing enforces
  // it, raising the request works either way (see RequestDetail.tsx's
  // non-blocking heads-up pop-up at Raise time for the one place this is
  // actually surfaced as a prompt, not a requirement).
  required?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<unknown>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<RequestDocumentOut | null>(null)

  const endpoint = draftRequestId
    ? `/api/qa-requests/${draftRequestId}/checklist-evidence/${kind}/${itemIndex}/documents`
    : ''

  async function deleteSavedFile() {
    if (!pendingDelete || !endpoint) return
    setDeleteBusy(true)
    setError(null)
    try {
      await api.del(`${endpoint}/${pendingDelete.id}`)
      setPendingDelete(null)
      onReload()
    } catch (err) {
      // Close the confirmation before showing the shared error dialog so
      // two modal overlays never compete for focus or stack visually.
      setPendingDelete(null)
      setError(err)
    } finally {
      setDeleteBusy(false)
    }
  }

  const totalFiles = savedFiles.length + files.length

  return (
    <div className="checklist-evidence-picker supporting-evidence-control">
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
      <SupportingEvidenceControl
        attachDisabled={!checked}
        onAttach={() => inputRef.current?.click()}
        totalFiles={totalFiles}
        required={required}
      >
          {savedFiles.map((document) => (
            <ChecklistEvidenceFileRow
              key={document.id}
              fileName={document.file_name}
              onDownload={() => api.downloadFile(`${endpoint}/${document.id}/download`, document.file_name)}
              onDelete={() => setPendingDelete(document)}
            />
          ))}
          {files.map((file, index) => (
            <div className="checklist-evidence-file" key={`${file.name}-${index}`}>
              <span className="muted small" title={file.name} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file.name} · uploads when draft is saved
              </span>
              <button type="button" className="btn btn-sm" aria-label={`Remove ${file.name}`} onClick={() => onFilesChange(files.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
      </SupportingEvidenceControl>
      <ErrorText error={error} />
      {pendingDelete && (
        <ChecklistEvidenceDeleteModal
          fileName={pendingDelete.file_name}
          busy={deleteBusy}
          onConfirm={deleteSavedFile}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
