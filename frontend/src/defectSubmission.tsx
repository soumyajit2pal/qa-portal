import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ConfirmModal from './components/ConfirmModal'

export function useDefectSubmissionConfirmation() {
  const [kind, setKind] = useState<'workflow' | 'details' | null>(null)
  const pending = useRef<((confirmed: boolean) => void) | null>(null)

  useEffect(() => () => {
    pending.current?.(false)
    pending.current = null
  }, [])

  function confirmDefectSubmission(nextKind: 'workflow' | 'details' = 'workflow'): Promise<boolean> {
    if (pending.current) return Promise.resolve(false)
    setKind(nextKind)
    return new Promise(resolve => { pending.current = resolve })
  }

  function finish(confirmed: boolean) {
    const resolve = pending.current
    pending.current = null
    setKind(null)
    resolve?.(confirmed)
  }

  const confirmationModal = kind && createPortal(
    <ConfirmModal
      title="Confirm submission"
      message={<p>{kind === 'workflow'
        ? 'Once submitted, this form cannot be edited. Please review all details and supporting evidence before saving.'
        : 'Please review all details and supporting evidence before saving. Defect details can only be edited while the defect is in New status. Once it moves to the next stage, this form cannot be edited.'}</p>}
      confirmLabel={kind === 'workflow' ? 'Submit' : 'Save'}
      cancelLabel="Cancel"
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />,
    document.body,
  )

  return { confirmDefectSubmission, confirmationModal }
}
