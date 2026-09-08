import React, { useCallback, useEffect, useRef, useState } from 'react'

import { subscribeToApiMutations } from '../api'
import { mutationSuccessCopy } from '../mutationToast'

interface ToastItem {
  id: number
  title: string
  message: string
}

const TOAST_DURATION_MS = 4_500

export default function GlobalToastCenter() {
  const [toast, setToast] = useState<ToastItem | null>(null)
  const activeToast = useRef<ToastItem | null>(null)
  const nextId = useRef(0)
  const timer = useRef<number | null>(null)

  const dismiss = useCallback((id: number) => {
    if (activeToast.current?.id !== id) return
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    activeToast.current = null
    setToast(null)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToApiMutations((event) => {
      const copy = mutationSuccessCopy(event)
      if (!copy) return
      const current = activeToast.current
      // One user action can make several API calls (for example, one request
      // update plus one upload per evidence file). Never stack a toast for
      // every successful call. Identical feedback is ignored while visible;
      // different feedback replaces it instead of creating another card.
      if (current && current.title === copy.title && current.message === copy.message) return
      const next = { id: ++nextId.current, ...copy }
      activeToast.current = next
      setToast(next)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => dismiss(next.id), TOAST_DURATION_MS)
    })
    return () => {
      unsubscribe()
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [dismiss])

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toast && (
        <div className="success-toast" role="status" key={toast.id}>
          <span className="success-toast-icon" aria-hidden="true">✓</span>
          <div className="success-toast-copy">
            <strong>{toast.title}</strong>
            <span>{toast.message}</span>
          </div>
          <button type="button" className="success-toast-close" aria-label={`Dismiss ${toast.title}`} onClick={() => dismiss(toast.id)}>×</button>
          <span className="success-toast-progress" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
