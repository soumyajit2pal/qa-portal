import React, { ReactNode } from 'react'
import { Modal } from './Common'

interface ConfirmModalProps {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
  // A secondary button can be a real alternative decision (for example,
  // "No, skip re-approval"), while the header X must only dismiss the
  // dialog. Callers with that three-way flow provide onDismiss explicitly;
  // ordinary confirm/cancel dialogs can keep using onCancel for both.
  onDismiss?: () => void
}

// A Yes/No confirmation pop-up -- for actions that branch down two different
// paths depending on the answer (e.g. SAST/DAST's Complete Scan/Rescan "were
// any findings identified?" gate), as opposed to a single acknowledgement
// (see InfoModal for that single-button "OK, got it" case instead).
export default function ConfirmModal({
  title, message, confirmLabel = 'Yes', cancelLabel = 'No', busy, destructive, onConfirm, onCancel, onDismiss,
}: ConfirmModalProps) {
  return (
    <Modal title={title} onClose={onDismiss ?? onCancel} closeDisabled={busy} variant="dialog" preventBackdropClose>
      <div>{message}</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button type="button" className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
      </div>
    </Modal>
  )
}
