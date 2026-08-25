import React, { useCallback, useEffect, useRef, useState } from 'react'

import { subscribeToApiMutations } from '../api'
import { mutationSuccessCopy } from '../mutationToast'

interface ToastItem {
  id: number
  title: string
  message: string
}

const TOAST_DURATION_MS = 4_500
const MAX_VISIBLE_TOASTS = 4

export default function GlobalToastCenter() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToApiMutations((event) => {
      const copy = mutationSuccessCopy(event)
      if (!copy) return
      const id = ++nextId.current
      setToasts((current) => [...current, { id, ...copy }].slice(-MAX_VISIBLE_TOASTS))
      const timer = window.setTimeout(() => dismiss(id), TOAST_DURATION_MS)
      timers.current.set(id, timer)
    })
    const activeTimers = timers.current
    return () => {
      unsubscribe()
      activeTimers.forEach((timer) => window.clearTimeout(timer))
      activeTimers.clear()
    }
  }, [dismiss])

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div className="success-toast" role="status" key={toast.id}>
          <span className="success-toast-icon" aria-hidden="true">✓</span>
          <div className="success-toast-copy">
            <strong>{toast.title}</strong>
            <span>{toast.message}</span>
          </div>
          <button type="button" className="success-toast-close" aria-label={`Dismiss ${toast.title}`} onClick={() => dismiss(toast.id)}>×</button>
          <span className="success-toast-progress" aria-hidden="true" />
        </div>
      ))}
    </div>
  )
}
