import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { IconBell } from './Icons'
import { NotificationOut } from '../types'

// 2026-08 "Test Approval Workflow" refactor (spec section 10) -- in-app-only
// notifications (no email/SMTP anywhere in this app; see
// backend/app/routers/notifications.py). Lives in the topbar next to the
// user menu (see Layout.tsx's .right-group), reusing that menu's own
// .topbar-user-menu/.topbar-user-popover positioning classes so this needs
// only a handful of notification-specific rules (see index.css).
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function NotificationBell() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<NotificationOut[]>([])
  const [loading, setLoading] = useState(false)
  const [markingAll, setMarkingAll] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const refreshUnreadCount = useCallback(() => {
    api.get<{ unread_count: number }>('/api/notifications/unread-count')
      .then((res) => setUnreadCount(res.unread_count))
      .catch(() => undefined)
  }, [])

  // Poll every 60s so the badge count stays roughly current even while the
  // dropdown is closed -- there is no push/websocket channel in this app.
  useEffect(() => {
    refreshUnreadCount()
    const interval = window.setInterval(refreshUnreadCount, 60000)
    return () => window.clearInterval(interval)
  }, [refreshUnreadCount])

  const loadNotifications = useCallback(() => {
    setLoading(true)
    api.get<NotificationOut[]>('/api/notifications?limit=20')
      .then(setNotifications)
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (open) loadNotifications()
  }, [open, loadNotifications])

  // Same outside-click/Escape pattern as Layout.tsx's own userMenuOpen/userMenuRef.
  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  async function handleRowClick(notification: NotificationOut) {
    if (!notification.read_at) {
      try {
        const updated = await api.post<NotificationOut>(`/api/notifications/${notification.id}/read`, {})
        setNotifications((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
        setUnreadCount((prev) => Math.max(0, prev - 1))
      } catch {
        // Best-effort -- navigation below still proceeds even if marking read failed.
      }
    }
    setOpen(false)
    // Only TEST_CASE notifications have a known deep-link route today
    // (mirrors the `?open=<key>` pattern TestRepository.tsx already reads --
    // see its own searchParams.get('open') handling). Other entity types
    // (projects/cycles, if they ever fire notifications) are left
    // un-navigated rather than guessing at a route.
    if (notification.entity_type === 'TEST_CASE' && notification.entity_key) {
      navigate(`/test-repository?open=${encodeURIComponent(notification.entity_key)}`)
    } else if (notification.entity_type === 'DEFECT' && notification.entity_key) {
      navigate(`/defects?open=${encodeURIComponent(notification.entity_key)}`)
    }
  }

  async function markAllRead() {
    setMarkingAll(true)
    try {
      await api.post('/api/notifications/read-all', {})
      const now = new Date().toISOString()
      setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })))
      setUnreadCount(0)
    } catch {
      // Best-effort.
    } finally {
      setMarkingAll(false)
    }
  }

  return (
    <div className="topbar-user-menu" ref={rootRef}>
      <button
        type="button"
        className="topbar-notification-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}` : 'Notifications'}
      >
        <IconBell width={18} height={18} />
        {unreadCount > 0 && <span className="topbar-notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="topbar-user-popover topbar-notification-popover">
          <div className="topbar-notification-popover-head">
            <span className="topbar-user-popover-name" style={{ marginBottom: 0 }}>Notifications</span>
            <button type="button" className="link-btn" disabled={markingAll || unreadCount === 0} onClick={markAllRead}>
              Mark all read
            </button>
          </div>
          <div className="topbar-notification-list">
            {loading && <div className="topbar-notification-empty">Loading…</div>}
            {!loading && notifications.length === 0 && (
              <div className="topbar-notification-empty">No notifications yet.</div>
            )}
            {!loading && notifications.map((notification) => (
              <button
                type="button"
                key={notification.id}
                className={`topbar-notification-row ${notification.read_at ? '' : 'unread'}`}
                onClick={() => handleRowClick(notification)}
              >
                <span className="topbar-notification-message">{notification.message}</span>
                <span className="topbar-notification-meta">{timeAgo(notification.created_at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
