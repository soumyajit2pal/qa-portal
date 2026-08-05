import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { Card, Table, Badge, ErrorText, PageHeader } from '../../components/Common'
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

  // Built from whatever categories are actually present for this user
  // (which roles/checkpoints apply varies a lot person to person) rather
  // than a hardcoded list -- mirrors Approvals.tsx's own ENTITY_TYPES
  // filter, just derived at runtime since there's no fixed enum here.
  const categories = Array.from(new Set(rows.map((r) => r.category))).sort()
  const visibleRows = category ? rows.filter((r) => r.category === category) : rows

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Pending Approvals" count={rows.length}
        subtitle="Every approval checkpoint across the portal that is genuinely awaiting your decision right now — Application Name approvals, SM / Department Head / Readiness checkpoints on Functional, SAST, DAST and Performance requests, Suppression, QA Sign-off, and Test Project activation. Click a row to open it and decide."
      />
      {categories.length > 1 && (
        <div className="toolbar">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}
      <Card>
        {!loading && rows.length === 0 ? (
          <p className="muted" style={{ padding: '16px 4px' }}>
            Nothing is currently awaiting your action. New items show up here the moment a request reaches a
            checkpoint you can decide.
          </p>
        ) : (
          <Table
            rowKey="_key"
            onRowClick={(r) => navigate(r.path)}
            rows={visibleRows}
            columns={[
              { key: 'category', header: 'Checkpoint' },
              { key: 'title', header: 'Item', render: (r) => (
                <>
                  {r.title}
                  {r.display_id && <div className="muted small">{r.display_id}</div>}
                </>
              ) },
              { key: 'status_label', header: 'Status', render: (r) => <Badge status={r.status} label={r.status_label} /> },
              { key: 'department', header: 'Department', render: (r) => r.department || '—' },
              { key: 'submitted_by', header: 'Submitted By', render: (r) => r.submitted_by || '—' },
              {
                key: 'submitted_at', header: 'Submitted',
                render: (r) => (r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—'),
              },
            ]}
          />
        )}
      </Card>
    </div>
  )
}
