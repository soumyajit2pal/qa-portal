import { useEffect, useRef, useState } from 'react'
import { subscribeToApiActivity } from '../api'

const SHOW_AFTER_MS = 250
const SLOW_AFTER_MS = 4_000
const MINIMUM_VISIBLE_MS = 500

export default function ApiActivityIndicator() {
  const [pending, setPending] = useState(0)
  const [visible, setVisible] = useState(false)
  const [slow, setSlow] = useState(false)
  const visibleSince = useRef<number | null>(null)
  const active = pending > 0

  useEffect(() => subscribeToApiActivity(setPending), [])

  useEffect(() => {
    if (!active) {
      setSlow(false)
      const shownAt = visibleSince.current
      if (shownAt === null) {
        setVisible(false)
        return
      }
      const remaining = Math.max(0, MINIMUM_VISIBLE_MS - (Date.now() - shownAt))
      const hideTimer = window.setTimeout(() => {
        visibleSince.current = null
        setVisible(false)
      }, remaining)
      return () => window.clearTimeout(hideTimer)
    }

    // Keep one continuous busy period even when concurrent request counts
    // rise/fall. Depending on `active` rather than the raw count prevents a
    // burst of API calls from repeatedly postponing this feedback.
    const showTimer = window.setTimeout(() => {
      visibleSince.current = Date.now()
      setVisible(true)
    }, visibleSince.current === null ? SHOW_AFTER_MS : 0)
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(slowTimer)
    }
  }, [active])

  if (!visible) return null
  return (
    <div className={`api-activity ${slow ? 'api-activity-slow' : ''}`} role="status" aria-live="polite">
      <div className="api-activity-rail" aria-hidden="true"><i /></div>
      <div className="api-activity-status">
        <span className="api-activity-spinner" aria-hidden="true" />
        <span>
          <strong>{slow ? 'Still working…' : 'Working…'}</strong>
          <small>{slow ? 'The response is taking longer than usual. Please keep this page open.' : 'Loading or saving portal data.'}</small>
        </span>
      </div>
    </div>
  )
}
