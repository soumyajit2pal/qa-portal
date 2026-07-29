import React, { ReactNode } from 'react'
import { Modal } from './Common'

interface InfoModalProps {
  title: string
  onClose: () => void
  children?: ReactNode
}

// A simple one-button "OK, got it" pop-up for messages the person just needs
// to acknowledge (e.g. "saved as Draft", "now raised, go review it") -- not a
// form and nothing to lose, so unlike the QA Request wizard this can still
// be dismissed by clicking outside, same as every other read-only modal.
export default function InfoModal({ title, onClose, children }: InfoModalProps) {
  return (
    <Modal title={title} onClose={onClose} variant="dialog">
      {children}
      <div style={{ marginTop: 18 }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  )
}
