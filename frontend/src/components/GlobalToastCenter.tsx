import React, { useEffect, useReducer, useRef } from 'react'

import { subscribeToApiMutations } from '../api'
import { mutationSuccessCopy } from '../mutationToast'
import { EMPTY_MUTATION_FEEDBACK, mutationFeedbackReducer } from '../mutationFeedback'
import AssignmentConfirmation from './AssignmentConfirmation'

const TOAST_DURATION_MS = 4_500

export default function GlobalToastCenter() {
  const [{ toast, confirmations }, dispatch] = useReducer(mutationFeedbackReducer, EMPTY_MUTATION_FEEDBACK)
  const nextId = useRef(0)
  const confirmation = confirmations[0]

  useEffect(() => {
    const unsubscribe = subscribeToApiMutations((event) => {
      if (['/api/auth/login', '/api/auth/logout'].includes(event.path.split('?')[0])) {
        dispatch({ type: 'clear' })
        return
      }
      const copy = mutationSuccessCopy(event)
      if (!copy) return
      dispatch({ type: 'received', item: { id: ++nextId.current, ...event, ...copy } })
    })
    const clear = () => dispatch({ type: 'clear' })
    window.addEventListener('qa-session-expired', clear)
    return () => {
      unsubscribe()
      window.removeEventListener('qa-session-expired', clear)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => dispatch({ type: 'dismiss-toast', id: toast.id }), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <>
      {confirmation && <AssignmentConfirmation key={confirmation.id} item={confirmation} remaining={confirmations.length - 1}
        onAcknowledge={() => dispatch({ type: 'acknowledge', id: confirmation.id })} />}
      <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toast && (
        <div className="success-toast" role="status" key={toast.id}>
          <span className="success-toast-icon" aria-hidden="true">✓</span>
          <div className="success-toast-copy">
            <strong>{toast.title}</strong>
            <span>{toast.message}</span>
          </div>
          <button type="button" className="success-toast-close" aria-label={`Dismiss ${toast.title}`} onClick={() => dispatch({ type: 'dismiss-toast', id: toast.id })}>×</button>
          <span className="success-toast-progress" aria-hidden="true" />
        </div>
      )}
      </div>
    </>
  )
}
