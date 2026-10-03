import React, { useRef } from 'react'
import { RequestDocumentOut } from '../types'
import { ACTIVITY_ATTACHMENT_ACCEPT, ACTIVITY_MAX_ATTACHMENTS, activityAttachmentKind, activityAttachmentSize, activityAttachmentType } from '../activityAttachments'

export interface PendingActivityAttachment { id: string; file: File }

export function ActivityAttachmentPicker({ files, inlineImageCount, disabled, onFiles, onRemove }: {
  files: PendingActivityAttachment[]
  inlineImageCount: number
  disabled: boolean
  onFiles: (files: File[]) => void
  onRemove: (id: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return <div className="activity-attachment-picker">
    <div className="activity-attachment-picker-actions"><button type="button" className="btn btn-sm activity-attach-button" disabled={disabled} onClick={() => input.current?.click()}><span aria-hidden="true">＋</span> Attach files</button><span>Drop files here · {files.length + inlineImageCount}/{ACTIVITY_MAX_ATTACHMENTS} files · 10 MB each</span></div>
    <input ref={input} type="file" aria-label="Attach files to comment" accept={ACTIVITY_ATTACHMENT_ACCEPT} multiple hidden disabled={disabled} onChange={event => { onFiles(Array.from(event.target.files || [])); event.target.value = '' }} />
    <p className="activity-attachment-help">Images, PDF, Word, Excel, CSV, TXT and LOG. Paste screenshots into the comment to place them inline.</p>
    {files.length > 0 && <ul className="activity-draft-files" aria-label="Files attached to draft comment">{files.map(({ id, file }) => <li className="activity-file-card" key={id}><span className="activity-file-icon" aria-hidden="true">{activityAttachmentType(file.name)}</span><span className="activity-file-info"><strong title={file.name}>{file.name}</strong><small>{activityAttachmentType(file.name)} · {activityAttachmentSize(file.size)}</small></span><button type="button" className="activity-file-remove" disabled={disabled} aria-label={`Remove ${file.name}`} title="Remove attachment" onClick={() => onRemove(id)}>×</button></li>)}</ul>}
  </div>
}

export function ActivityAttachmentCard({ attachment, imageUrl, busy, onPreview, onDownload }: {
  attachment: RequestDocumentOut
  imageUrl?: string
  busy: boolean
  onPreview: () => void
  onDownload: () => void
}) {
  const kind = activityAttachmentKind(attachment)
  return <div className={`activity-file-card posted is-${kind}`}>
    {kind === 'image' && imageUrl ? <button type="button" className="activity-file-image" title={`Open ${attachment.file_name}`} onClick={onPreview}><img src={imageUrl} alt={attachment.file_name} /></button> : <span className="activity-file-icon" aria-hidden="true">{activityAttachmentType(attachment.file_name)}</span>}
    <div className="activity-file-info"><strong title={attachment.file_name}>{attachment.file_name}</strong><small>{activityAttachmentType(attachment.file_name)} · {activityAttachmentSize(attachment.file_size)}</small><div className="activity-file-actions">{kind === 'pdf' && <button type="button" disabled={busy} onClick={onPreview}>Preview PDF</button>}<button type="button" disabled={busy} onClick={onDownload}>{busy ? 'Loading…' : 'Download'}</button></div></div>
  </div>
}
