import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import InfoModal from './InfoModal'

// Reported directly: "also show one info on login if there are any pending
// approval pending." Fires once per sign-in (see AuthContext.tsx's own
// justLoggedIn/acknowledgeLogin -- set true by login(), never by the
// session-restore path a page refresh takes, so this doesn't re-nag on
// every reload) -- uses a count-only endpoint so login does not download
// and hydrate the full approval feed merely to display one number. Detailed
// records load only when the user opens Pending Approvals. If anything is
// genuinely awaiting this person's decision, this shows one pop-up with the
// count and a link straight to that page. Silently
// acknowledges itself (no pop-up at all) when the count is zero or the
// fetch fails, rather than showing an empty/broken notice.
export default function PendingApprovalsNotice() {
  const { justLoggedIn, acknowledgeLogin } = useAuth()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!justLoggedIn) return
    let cancelled = false
    api.get<{ count: number }>('/api/pending-approvals/count')
      .then((summary) => {
        if (cancelled) return
        if (summary.count > 0) setCount(summary.count)
        else acknowledgeLogin()
      })
      .catch(() => {
        if (!cancelled) acknowledgeLogin()
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justLoggedIn])

  if (!justLoggedIn || count === null) return null

  return (
    <InfoModal title="Pending Approvals" onClose={acknowledgeLogin}>
      <p style={{ marginTop: -4 }}>
        You have <strong>{count}</strong> approval{count === 1 ? '' : 's'} awaiting your action.
      </p>
      <p className="muted small">
        <Link to="/pending-approvals" onClick={acknowledgeLogin}>Go to Pending Approvals →</Link>
      </p>
    </InfoModal>
  )
}
