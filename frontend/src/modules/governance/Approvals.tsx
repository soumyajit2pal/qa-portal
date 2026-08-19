import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { Card, Table, Badge, ErrorText, PageHeader } from '../../components/Common'
import { ApprovalActionOut, UserOut } from '../../types'
import { usePaginatedList } from '../../hooks/usePaginatedList'
import ClearableSearchInput from '../../components/ClearableSearchInput'

// SAST and DAST log distinctly now ("SAST" / "DAST", not a shared
// "SAST_DAST") -- see the long comment on routers/sast_dast.py::_log().
// "SAST_DAST" is kept in the filter list too, purely so older rows logged
// before that split still have a way to be filtered to.
const ENTITY_TYPES = [
  '', 'QA_REQUEST', 'FUNCTIONAL_REQUEST', 'SAST', 'DAST', 'SAST_DAST', 'PERFORMANCE',
  'SUPPRESSION', 'SIGNOFF',
]

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

export default function Approvals() {
  const [users, setUsers] = useState<UserOut[]>([])
  const [entityType, setEntityType] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(setError)
  }, [])

  const {
    items: rows, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading, setPage, setPageSize,
  } = usePaginatedList<ApprovalActionOut>('/api/approvals/history', {
    search,
    extra: { entity_type: entityType || undefined },
  })

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Approval Workflow Log" count={total}
        subtitle="Full audit / decision trail across QA Requests, Functional Testing, SAST/DAST, Performance, Suppression and Clearance — who acted, what they decided, and when."
      />
      <div className="toolbar">
        <ClearableSearchInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClear={() => setSearch('')}
          clearLabel="Clear approval workflow search"
          wrapperClassName="search-grow"
          placeholder="Search request ID, step, decision, actor, role, status, or comments…"
          aria-label="Search approval workflow log"
        />
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t || 'All entity types'}</option>)}
        </select>
      </div>
      <Card>
        <Table
          rowKey="id"
          server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange: setPage, onPageSizeChange: setPageSize, loading }}
          columns={[
          { key: 'entity_type', header: 'Entity' },
          { key: 'request_ref', header: 'Request ID', render: (r) => r.request_ref || `#${r.entity_id}`, filterValue: (r) => r.request_ref || `#${r.entity_id}` },
          { key: 'step_name', header: 'Step' },
          { key: 'decision', header: 'Decision', render: (r) => <Badge status={r.decision} /> },
          { key: 'actor_id', header: 'Actor', render: (r) => userName(users, r.actor_id) || '—', filterValue: (r) => userName(users, r.actor_id) || '' },
          { key: 'actor_role', header: 'Actor Role' },
          { key: 'comments', header: 'Comments' },
          { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
        ]} rows={rows} />
      </Card>
    </div>
  )
}
