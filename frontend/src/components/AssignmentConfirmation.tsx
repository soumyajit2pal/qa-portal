import React, { useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { MutationFeedbackItem } from '../mutationFeedback'
import './AssignmentConfirmation.css'

export default function AssignmentConfirmation({ item, remaining, onAcknowledge }: {
  item: MutationFeedbackItem
  remaining: number
  onAcknowledge: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog?.showModal()
    doneRef.current?.focus()
    return () => {
      dialog?.close()
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return createPortal(
    <dialog ref={dialogRef} className="assignment-confirmation" role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => event.preventDefault()}>
      <div className="assignment-confirmation-content">
        <span className="assignment-confirmation-icon" aria-hidden="true">✓</span>
        <h2 id={titleId}>{item.title}</h2>
        <p id={descriptionId}>{item.message}</p>
        {(item.requestId || item.applicationName || item.assigneeName) && <dl className="assignment-confirmation-details">
          {item.requestId && <div><dt>Reference</dt><dd>{item.requestId}</dd></div>}
          {item.applicationName && <div><dt>Application</dt><dd>{item.applicationName}</dd></div>}
          {item.assigneeName && <div><dt>Assigned to</dt><dd>{item.assigneeName}</dd></div>}
        </dl>}
        <button ref={doneRef} type="button" className="btn btn-primary assignment-confirmation-done" onClick={onAcknowledge}>Done</button>
        {remaining > 0 && <small>{remaining} more {remaining === 1 ? 'update' : 'updates'} to review</small>}
      </div>
    </dialog>, document.body,
  )
}
