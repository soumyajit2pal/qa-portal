import React, { useState } from 'react'
import { api } from '../api'
import { QARequestOut } from '../types'
import { ErrorText, Modal, WarningNotice } from './Common'

interface Props {
  request: QARequestOut
  disabled?: boolean
  disabledReason?: string
  onResubmitted: (request: QARequestOut) => void
}

export function ApplicationNameReconsideration({ request, disabled, disabledReason, onResubmitted }: Props) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function resubmit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || disabled) return
    if (!reason.trim()) {
      setError(new Error('Explain why the rejected application name should be reconsidered.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const updated = await api.post<QARequestOut>(`/api/qa-requests/${request.id}/application-name/resubmit`, {
        reason: reason.trim(),
      })
      setOpen(false)
      setReason('')
      onResubmitted(updated)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return <>
    <WarningNotice title="Application name rejected" style={{ marginTop: 8 }}>
      <p><strong>{request.application_name}</strong> was rejected. Choose an available application or explicitly resubmit this name for a fresh Application Owner review.</p>
      <p><strong>Previous rejection reason:</strong> {request.application_name_rejection_reason || 'No remarks are available for this historical decision.'}</p>
      <button type="button" className="btn btn-warning btn-sm" disabled={disabled} onClick={() => {
        setError(null)
        setOpen(true)
      }}>Resubmit application name for approval</button>
      {disabledReason && <p className="small">{disabledReason}</p>}
    </WarningNotice>
    {open && <Modal title="Resubmit application name for approval" variant="dialog" compact tone="warning"
      preventBackdropClose onClose={() => { if (!busy) setOpen(false) }}>
      <form onSubmit={resubmit}>
        <p>This application name was previously rejected. Resubmitting will send it for a fresh Application Owner review. Explain the discussion outcome and how the name meets the <strong>BCP policy</strong>. Approval is required before this QA request can proceed.</p>
        <p><strong>Application name:</strong> {request.application_name}</p>
        <p><strong>Previous rejection reason:</strong> {request.application_name_rejection_reason || 'No remarks are available for this historical decision.'}</p>
        <div className="form-field">
          <label htmlFor={`application-name-reconsideration-${request.id}`}>Reason for reconsideration <span aria-hidden="true">*</span></label>
          <textarea id={`application-name-reconsideration-${request.id}`} required maxLength={4000} rows={5} value={reason} disabled={busy}
            onChange={event => setReason(event.target.value)}
            placeholder="Explain the discussion outcome and why this name meets the BCP policy. Include a discussion or document reference if available." />
        </div>
        <p className="muted small">The same QA request, saved details, documents, and previous decisions will be retained. Linked requests will be generated after approval.</p>
        <ErrorText error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" className="btn btn-warning" disabled={busy || disabled || !reason.trim()}>
            {busy ? 'Resubmitting…' : 'Resubmit for approval'}
          </button>
        </div>
      </form>
    </Modal>}
  </>
}
