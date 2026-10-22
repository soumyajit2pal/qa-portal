import React from 'react'
import { workPath } from '../workViewStore'
import { IconExternalLink } from './Icons'

export default function RecordNumberLink({ kind, id, recordKey, loading, title, onOpen }: {
  kind: 'defect' | 'functional'; id: number; recordKey: string; loading?: boolean; title?: string; onOpen: () => void
}) {
  const href = workPath({ kind, id })
  return <span className="record-number-links">
    <a className="record-number-link" href={href} title={title} rel="noopener noreferrer" onClick={event => {
      event.stopPropagation()
      // Keep the normal preview while leaving modified clicks and the
      // browser's native link context menu available.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onOpen()
    }}>{loading ? 'Opening…' : recordKey}</a>
    <a className="record-new-tab-link" href={href} target="_blank" rel="noopener noreferrer"
      aria-label={`Open ${recordKey} in new tab`} title={`Open ${recordKey} in new tab`}
      onClick={event => event.stopPropagation()}>
      <IconExternalLink aria-hidden="true" />
    </a>
  </span>
}
