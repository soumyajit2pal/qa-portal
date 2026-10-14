import React from 'react'
import InfoModal from './InfoModal'

export default function NewApplicationDisabledModal({ onClose }: { onClose: () => void }) {
  return <InfoModal title="New application creation is disabled" onClose={onClose} tone="warning" buttonLabel="Choose existing application">
    <p>New application creation is disabled. Select an application from the existing list or contact an administrator to add a new application.</p>
  </InfoModal>
}
