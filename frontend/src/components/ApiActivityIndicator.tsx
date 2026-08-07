import { useEffect, useState } from 'react'
import { subscribeToApiActivity } from '../api'

export default function ApiActivityIndicator() {
  const [pending, setPending] = useState(0)
  const [visible, setVisible] = useState(false)
  const [slow, setSlow] = useState(false)

  useEffect(() => subscribeToApiActivity(setPending), [])

  useEffect(() => {
    if (!pending) {
      setVisible(false)
      setSlow(false)
      return
    }
    const showTimer = window.setTimeout(() => setVisible(true), 180)
    const slowTimer = window.setTimeout(() => setSlow(true), 2500)
    return () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(slowTimer)
    }
  }, [pending])

  if (!visible) return null
  return (
    <div className={`api-activity ${slow ? 'api-activity-slow' : ''}`} role="status" aria-live="polite">
      <span className="api-activity-spinner" aria-hidden="true" />
      <span>{slow ? 'The server is taking longer than usual…' : 'Loading…'}</span>
    </div>
  )
}
