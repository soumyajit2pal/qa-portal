import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, subscribeToApiMutations } from '../../api'
import { Card, Badge, ErrorText, PageHeader } from '../../components/Common'
import { PendingApprovalItem } from '../../types'

// Table's rowKey prop needs a single field name to key React's list
// rendering by -- there's no one column on PendingApprovalItem that's
// unique on its own (the same entity can appear under more than one
// category, e.g. a request an SM AND a Department Head both partially
// touch over its lifetime, just never at the same status at once), so a
// composite key is added client-side rather than asking the backend to
// invent one.
interface Row extends PendingApprovalItem {
  _key: string
}

// Reported directly: "The system shall provide a Pending Approvals section
// in the navigation bar to display all approval requests awaiting action
// from the logged-in user." See backend/app/routers/pending_approvals.py
// for the full inventory of checkpoints this aggregates and exactly how
// "awaiting this user" is worked out per category -- this page is a thin
// list on top of that single endpoint; there's no separate decision UI
// here, clicking a row navigates to that item's own page (the Application
// Owner/SM/Department Head/QA Lead/etc. banner or decision panel already
// lives there, same as before this feed existed).
export default function PendingApprovals() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [category, setCategory] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const load = useCallback(async () => {
    try {
      const items = await api.get<PendingApprovalItem[]>('/api/pending-approvals')
      setRows(items.map((r) => ({ ...r, _key: `${r.category}-${r.entity_type}-${r.entity_id}` })))
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Keep this queue live. Workflow decisions usually happen in an item's
  // detail page, so refresh on every successful mutation, when the user
  // returns to this tab, and periodically while the page remains open.
  useEffect(() => {
    const unsubscribe = subscribeToApiMutations(() => { void load() })
    const refresh = () => { if (!document.hidden) void load() }
    const timer = window.setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  // Built from whatever categories are actually present for this user
  // (which roles/checkpoints apply varies a lot person to person) rather
  // than a hardcoded list -- mirrors Approvals.tsx's own ENTITY_TYPES
  // filter, just derived at runtime since there's no fixed enum here.
  const categories = Array.from(new Set(rows.map((r) => r.category))).sort()
  const visibleRows = category ? rows.filter((r) => r.category === category) : rows
  const groups = Array.from(visibleRows.reduce((map, row) => {
    const key = row.parent_request_id
      ? `parent:${row.parent_request_id}`
      : `standalone:${row.display_id || `${row.entity_type}-${row.entity_id}`}`
    const existing = map.get(key)
    if (existing) existing.items.push(row)
    else map.set(key, {
      key,
      parentId: row.parent_request_id || row.display_id || row.title,
      parentPath: row.parent_path || null,
      hasParent: Boolean(row.parent_request_id),
      items: [row],
    })
    return map
  }, new Map<string, { key: string; parentId: string; parentPath: string | null; hasParent: boolean; items: Row[] }>()).values())

  function openFromPending(path: string) {
    const separator = path.includes('?') ? '&' : '?'
    navigate(`${path}${separator}fromPending=1`)
  }

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Pending Approvals" count={rows.length}
        subtitle="Review work grouped by its parent QA Request. Select a child to open its approval drawer directly."
      />
      {categories.length > 1 && (
        <div className="pending-approval-filters" role="group" aria-label="Filter approval checkpoints">
          <button type="button" className={!category ? 'active' : ''} onClick={() => setCategory('')}>
            All <span>{rows.length}</span>
          </button>
          {categories.map((c) => (
            <button type="button" key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
              {c.replace(' -- ', ' · ')} <span>{rows.filter((row) => row.category === c).length}</span>
            </button>
          ))}
        </div>
      )}
      {loading && rows.length === 0 ? (
        <div className="pending-approval-loading" role="status" aria-label="Loading pending approvals">
          {[1, 2, 3].map((item) => <div key={item}><i /><span /><span /></div>)}
        </div>
      ) : rows.length === 0 ? (
        <Card className="pending-approval-empty">
          <div className="pending-approval-empty-icon">✓</div>
          <strong>You're all caught up</strong>
          <p>There are no requests waiting for your approval right now.</p>
        </Card>
      ) : (
        <div className="pending-approval-groups">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key)
            const oldest = group.items.find((item) => item.submitted_at)?.submitted_at
            return (
            <Card key={group.key} className={`pending-approval-group${isCollapsed ? ' collapsed' : ''}`}>
              <div className="pending-approval-parent">
                <button type="button" className="pending-approval-parent-toggle" onClick={() => toggleGroup(group.key)} aria-expanded={!isCollapsed}>
                  <span className="pending-approval-chevron">⌄</span>
                  <span className="pending-approval-parent-icon">{group.hasParent ? 'PR' : 'RQ'}</span>
                  <span className="pending-approval-parent-copy">
                    <small>{group.hasParent ? 'Parent QA Request' : 'Standalone Request'}</small>
                    <strong>{group.parentId}</strong>
                    {oldest && <em>Oldest pending since {new Date(oldest).toLocaleDateString()}</em>}
                  </span>
                  <span className="pending-approval-child-count">{group.items.length}</span>
                </button>
                {group.parentPath && (
                  <button type="button" className="btn btn-sm" onClick={() => openFromPending(group.parentPath!)}>
                    View parent ↗
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="pending-approval-children">
                  {group.items.map((item, index) => (
                    <button type="button" className="pending-approval-child" key={item._key} onClick={() => openFromPending(item.path)}>
                      <span className="pending-approval-branch" aria-hidden="true">{index === group.items.length - 1 ? '└' : '├'}</span>
                      <span className="pending-approval-child-main">
                        <span className="pending-approval-child-heading">
                          <strong>{item.display_id || 'Application Name Approval'}</strong>
                          <Badge status={item.status} label={item.status_label} />
                        </span>
                        <span className="pending-approval-child-title">{item.title}</span>
                        <span className="pending-approval-child-meta">
                          <span>{item.category.replace(' -- ', ' · ')}</span>
                          {item.department && <span>{item.department}</span>}
                          {item.submitted_by && <span>From {item.submitted_by}</span>}
                          {item.submitted_at && <span>{new Date(item.submitted_at).toLocaleString()}</span>}
                        </span>
                      </span>
                      <span className="pending-approval-open">Review <b>→</b></span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )})}
        </div>
      )}
    </div>
  )
}
