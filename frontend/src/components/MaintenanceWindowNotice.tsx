import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, subscribeToApiMutations } from '../api'
import { useAuth } from '../context/AuthContext'
import { formatDateTimeIST } from '../time'
import { MaintenanceWindowCurrentOut, MaintenanceWindowNoticeOut } from '../types'
import {
  acknowledgeMaintenanceWindow,
  hasMaintenanceAcknowledgement,
  MAINTENANCE_WINDOW_ADMIN_PATH,
  MAINTENANCE_WINDOW_CURRENT_PATH,
} from '../maintenanceWindow'
import { IconWarning } from './Icons'
import InfoModal from './InfoModal'
import PendingApprovalsNotice from './PendingApprovalsNotice'
import { boundedRetryDelay } from '../retryPolicy'
import { createLatestRequestGate } from '../latestRequest'

interface MaintenanceWindowContextValue {
  current: MaintenanceWindowCurrentOut | null
  ready: boolean
  refresh: () => Promise<void>
}

const MaintenanceWindowContext = createContext<MaintenanceWindowContextValue | null>(null)
const REFRESH_INTERVAL_MS = 60_000

function validCurrent(value: MaintenanceWindowCurrentOut | null): MaintenanceWindowCurrentOut {
  if (!value || value.visible !== true || !value.notice || !['UPCOMING', 'IN_PROGRESS'].includes(value.phase || '')) {
    return { visible: false, phase: null, notice: null }
  }
  return value
}

function sameCurrent(left: MaintenanceWindowCurrentOut | null, right: MaintenanceWindowCurrentOut): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function MaintenanceWindowProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<MaintenanceWindowCurrentOut | null>(null)
  const [ready, setReady] = useState(false)
  const requestGate = useRef(createLatestRequestGate()).current

  const fetchCurrent = useCallback(async (): Promise<boolean> => {
    const generation = requestGate.begin()
    try {
      const next = validCurrent(await api.getWithoutActivity<MaintenanceWindowCurrentOut | null>(MAINTENANCE_WINDOW_CURRENT_PATH))
      // A PUT/cancel mutation can start a refresh while the prior poll is
      // still in flight. Only the newest response may publish, otherwise an
      // old visible envelope could briefly resurrect a cancelled banner.
      if (!requestGate.isCurrent(generation)) return false
      setCurrent((previous) => sameCurrent(previous, next) ? previous : next)
      setReady(true)
      return true
    } catch {
      // A notice lookup must never block portal access. Preserve a previously
      // loaded warning through a transient failure instead of hiding it.
      return false
    }
  }, [requestGate])

  const refresh = useCallback(async () => { await fetchCurrent() }, [fetchCurrent])

  useEffect(() => {
    // Pending Approvals must not overtake a maintenance warning after one
    // transient failure. Keep the login-notice coordinator waiting while a
    // bounded backoff retries; the rest of the authenticated portal remains
    // fully usable because only notice rendering depends on `ready`.
    let cancelled = false
    let retryTimer: number | undefined
    let attempt = 0
    async function loadInitial() {
      const loaded = await fetchCurrent()
      if (!loaded && !cancelled) {
        retryTimer = window.setTimeout(() => { void loadInitial() }, boundedRetryDelay(attempt++))
      }
    }
    void loadInitial()
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      requestGate.invalidate()
    }
  }, [fetchCurrent, requestGate])
  useEffect(() => {
    const refreshIfVisible = () => { if (!document.hidden) void refresh() }
    const timer = window.setInterval(refreshIfVisible, REFRESH_INTERVAL_MS)
    const unsubscribe = subscribeToApiMutations((event) => {
      if (event.path.startsWith(MAINTENANCE_WINDOW_ADMIN_PATH)) void refresh()
    })
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      unsubscribe()
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refresh])

  const value = useMemo(() => ({ current, ready, refresh }), [current, ready, refresh])
  return <MaintenanceWindowContext.Provider value={value}>{children}</MaintenanceWindowContext.Provider>
}

export function useMaintenanceWindow(): MaintenanceWindowContextValue {
  const value = useContext(MaintenanceWindowContext)
  if (!value) throw new Error('useMaintenanceWindow must be used inside MaintenanceWindowProvider')
  return value
}

function visibleNotice(current: MaintenanceWindowCurrentOut | null): MaintenanceWindowNoticeOut | null {
  return current?.visible && current.phase && current.notice ? current.notice : null
}

export function MaintenanceWindowBanner() {
  const { current } = useMaintenanceWindow()
  const notice = visibleNotice(current)
  if (!notice || !current?.phase) return null
  const inProgress = current.phase === 'IN_PROGRESS'
  return (
    <section
      className={`maintenance-window-banner ${inProgress ? 'in-progress' : 'upcoming'}`}
      role={inProgress ? 'alert' : 'status'}
      aria-live={inProgress ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <span className="maintenance-window-banner-icon" aria-hidden="true"><IconWarning width={18} height={18} /></span>
      <div className="maintenance-window-banner-copy">
        <strong>{inProgress ? 'Planned downtime is in progress' : notice.title}</strong>
        <span>{notice.message}</span>
      </div>
      <div className="maintenance-window-banner-time">
        <small>{inProgress ? 'Expected window' : 'Scheduled window'}</small>
        <span><time dateTime={notice.starts_at}>{formatDateTimeIST(notice.starts_at)}</time> – <time dateTime={notice.ends_at}>{formatDateTimeIST(notice.ends_at)}</time></span>
      </div>
    </section>
  )
}

/** Serializes login notices: downtime acknowledgement, then approvals. */
export function LoginNoticeCoordinator({ includePendingApprovals = true }: { includePendingApprovals?: boolean }) {
  const { user, justLoggedIn, acknowledgeLogin } = useAuth()
  const { current, ready } = useMaintenanceWindow()
  const notice = visibleNotice(current)
  const revision = notice?.revision
  const [acknowledgedKey, setAcknowledgedKey] = useState('')
  const storageKey = user && revision != null ? `${user.id}:${revision}` : ''
  const alreadyAcknowledged = !!user && revision != null && (
    acknowledgedKey === storageKey || hasMaintenanceAcknowledgement(user.id, revision)
  )

  function acknowledge() {
    if (!user || revision == null) return
    acknowledgeMaintenanceWindow(user.id, revision)
    setAcknowledgedKey(`${user.id}:${revision}`)
  }

  useEffect(() => {
    // Onboarding screens may call only their small self-service API set, so
    // they show the maintenance notice without starting the approvals count
    // request. Once no maintenance acknowledgement is pending, complete the
    // one-login lifecycle locally.
    if (!includePendingApprovals && justLoggedIn && ready && (!notice || alreadyAcknowledged)) {
      acknowledgeLogin()
    }
  }, [acknowledgeLogin, alreadyAcknowledged, includePendingApprovals, justLoggedIn, notice, ready])

  if (!justLoggedIn || !ready) return null
  if (notice && current?.phase && !alreadyAcknowledged) {
    return (
      <InfoModal title="Planned downtime" tone="warning" onClose={acknowledge}>
        <div className="maintenance-window-login-notice">
          <span className="maintenance-window-login-icon" aria-hidden="true"><IconWarning width={22} height={22} /></span>
          <div>
            <strong>{current.phase === 'IN_PROGRESS' ? 'Downtime is currently in progress' : notice.title}</strong>
            <p>{notice.message}</p>
            <dl>
              <div><dt>Starts</dt><dd><time dateTime={notice.starts_at}>{formatDateTimeIST(notice.starts_at)}</time></dd></div>
              <div><dt>Ends</dt><dd><time dateTime={notice.ends_at}>{formatDateTimeIST(notice.ends_at)}</time></dd></div>
            </dl>
            <p className="muted small">Save work before the scheduled start and avoid beginning long uploads or workflow actions close to this window.</p>
          </div>
        </div>
      </InfoModal>
    )
  }
  if (!includePendingApprovals) return null
  return <PendingApprovalsNotice />
}
