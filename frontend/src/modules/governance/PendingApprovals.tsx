import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, subscribeToApiMutations } from '../../api'
import { formatDateIST, formatDateTimeIST } from '../../time'
import { Card, Badge, ErrorText, PageHeader } from '../../components/Common'
import { PendingApprovalItem, PendingApprovalPage } from '../../types'

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
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(5)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [hasPrevious, setHasPrevious] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (category) query.set('category', category)
      const result = await api.get<PendingApprovalPage>(`/api/pending-approvals?${query}`)
      if (category && !result.category_counts[category]) {
        setCategory('')
        setPage(1)
        return
      }
      if (result.page > result.total_pages) {
        setPage(result.total_pages)
        return
      }
      setRows(result.items.map((r) => ({ ...r, _key: `${r.category}-${r.entity_type}-${r.entity_id}` })))
      setCategoryCounts(result.category_counts)
      setTotal(result.total)
      setTotalPages(result.total_pages)
      setHasNext(result.has_next)
      setHasPrevious(result.has_previous)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [category, page, pageSize])

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
  const categories = Object.keys(categoryCounts).sort()
  const allTotal = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0)
  const groups = Array.from(rows.reduce((map, row) => {
    const key = row.parent_request_id
      ? `parent:${row.parent_request_id}`
      : `standalone:${row.display_id || `${row.entity_type}-${row.entity_id}`}`
    const existing = map.get(key)
    if (existing) existing.items.push(row)
    else map.set(key, {
      key,
      parentId: row.parent_request_id || row.display_id || row.title,
      parentPath: row.parent_path || null,
      parentLabel: row.parent_label || null,
      hasParent: Boolean(row.parent_request_id),
      items: [row],
    })
    return map
  }, new Map<string, { key: string; parentId: string; parentPath: string | null; parentLabel: string | null; hasParent: boolean; items: Row[] }>()).values())

  // Sub-groups a parent card's own children by folder_name (Test Project
  // parents only -- every other category leaves folder_name null on every
  // item, which collapses to a single unlabeled bucket, i.e. today's flat
  // list, unchanged).
  function folderBuckets(items: Row[]) {
    const map = new Map<string, Row[]>()
    for (const item of items) {
      const key = item.folder_name || ''
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return Array.from(map.entries())
  }

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
    <div className="pending-approvals-page">
      <ErrorText error={error} />
      <PageHeader
        title="Pending Approvals" count={total}
        subtitle="Review work grouped by its parent QA Request or Test Project (folder-wise, for test cases). Select a child to open its approval drawer directly."
      />
      {categories.length > 1 && (
        <div className="pending-approval-filters" role="group" aria-label="Filter approval checkpoints">
          <button type="button" className={!category ? 'active' : ''} onClick={() => { setCategory(''); setPage(1) }}>
            All <span>{allTotal}</span>
          </button>
          {categories.map((c) => (
            <button type="button" key={c} className={category === c ? 'active' : ''} onClick={() => { setCategory(c); setPage(1) }}>
              {c.replace(' -- ', ' · ')} <span>{categoryCounts[c]}</span>
            </button>
          ))}
        </div>
      )}
      {loading && rows.length === 0 ? (
        <div className="pending-approval-loading" role="status" aria-label="Loading pending approvals">
          {[1, 2, 3].map((item) => <div key={item}><i /><span /><span /></div>)}
        </div>
      ) : total === 0 ? (
        <Card className="pending-approval-empty">
          <div className="pending-approval-empty-icon">✓</div>
          <strong>You're all caught up</strong>
          <p>There are no requests waiting for your approval right now.</p>
        </Card>
      ) : (
        <>
          <div className="pending-approval-groups">
            {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key)
            const oldest = group.items.find((item) => item.submitted_at)?.submitted_at
            // "Test Project" (folder-wise grouped, see folderBuckets above)
            // vs the pre-existing "Parent QA Request"/"Standalone Request"
            // wording for every other category -- parentLabel is only ever
            // set by the backend for Test Case items right now, but this
            // stays generic rather than hardcoding entity_type here.
            const parentIcon = group.parentLabel === 'Test Project' ? 'TP' : group.hasParent ? 'PR' : 'RQ'
            const parentKicker = group.parentLabel || (group.hasParent ? 'Parent QA Request' : 'Standalone Request')
            const buckets = folderBuckets(group.items)
            return (
            <Card key={group.key} className={`pending-approval-group${isCollapsed ? ' collapsed' : ''}`}>
              <div className="pending-approval-parent">
                <button
                  type="button"
                  className="pending-approval-parent-toggle"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!isCollapsed}
                  title={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.parentId}`}
                >
                  <span className="pending-approval-chevron">⌄</span>
                  <span className="pending-approval-parent-icon">{parentIcon}</span>
                  <span className="pending-approval-parent-copy">
                    <small>{parentKicker}</small>
                    <strong>{group.parentId}</strong>
                    {oldest && <em>Oldest pending since {formatDateIST(oldest)}</em>}
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
                  {buckets.map(([folderName, items]) => (
                    <React.Fragment key={folderName || '__none__'}>
                      {folderName && (
                        <div className="pending-approval-folder-heading">
                          <span className="pending-approval-folder-icon">📁</span>{folderName}
                          <span className="pending-approval-folder-count">{items.length}</span>
                        </div>
                      )}
                      {items.map((item, index) => (
                        <button
                          type="button"
                          className="pending-approval-child"
                          key={item._key}
                          onClick={() => openFromPending(item.path)}
                          aria-label={`Review ${item.display_id || item.title}`}
                          title={`Open ${item.display_id || 'approval'} for review`}
                        >
                          <span className="pending-approval-branch" aria-hidden="true">{index === items.length - 1 ? '└' : '├'}</span>
                          <span className="pending-approval-child-main">
                            <span className="pending-approval-child-heading">
                              <strong>{item.display_id || 'Application Name Approval'}</strong>
                              <Badge status={item.status} label={item.status_label} />
                            </span>
                            <span className="pending-approval-child-title">{item.title}</span>
                            <span className="pending-approval-child-meta">
                              <span><b>Checkpoint</b>{item.category.replace(' -- ', ' · ')}</span>
                              {item.department && <span><b>Department</b>{item.department}</span>}
                              {item.submitted_by && <span><b>Submitted by</b>{item.submitted_by}</span>}
                              {item.submitted_at && <span><b>Received</b>{formatDateTimeIST(item.submitted_at)}</span>}
                            </span>
                          </span>
                          <span className="pending-approval-open">Review now <b>→</b></span>
                        </button>
                      ))}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </Card>
            )})}
          </div>
          <div className="table-footer pending-approval-pagination-footer" aria-label="Pending approvals pagination">
            <div className="table-footer-filters">{loading && <span>Refreshing…</span>}</div>
            <div className="table-pagination">
              <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
              <select className="table-page-size" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }} aria-label="Approvals per page">
                {[5, 10, 25, 50, 100].map((size) => <option key={size} value={size}>{size} / page</option>)}
              </select>
              <button type="button" disabled={!hasPrevious || loading} onClick={() => setPage((current) => current - 1)}>‹ Prev</button>
              <span>Page {page} of {totalPages}</span>
              <button type="button" disabled={!hasNext || loading} onClick={() => setPage((current) => current + 1)}>Next ›</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
