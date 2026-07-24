import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { Card, Table, Badge, ErrorText, PageHeader } from '../components/Common'
import { ApprovalActionOut, UserOut } from '../types'

const ENTITY_TYPES = ['', 'QA_REQUEST', 'TEST_CASE', 'SAST_DAST', 'SUPPRESSION', 'SIGNOFF']

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

export default function Approvals() {
  const [rows, setRows] = useState<ApprovalActionOut[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [entityType, setEntityType] = useState('')
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      const qs = entityType ? `?entity_type=${entityType}` : ''
      const [approvals, us] = await Promise.all([
        api.get<ApprovalActionOut[]>(`/api/approvals${qs}`),
        api.get<UserOut[]>('/api/auth/users'),
      ])
      setRows(approvals)
      setUsers(us)
    } catch (err) { setError(err) }
  }, [entityType])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Approval Workflow Log" count={rows.length}
        subtitle="Full audit / decision trail across QA Requests, SAST/DAST, Suppression and Sign-off — who acted, what they decided, and when."
      />
      <div className="toolbar">
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t || 'All entity types'}</option>)}
        </select>
      </div>
      <Card>
        <Table rowKey="id" columns={[
          { key: 'entity_type', header: 'Entity' },
          { key: 'request_ref', header: 'Request ID', render: (r) => r.request_ref || `#${r.entity_id}` },
          { key: 'step_name', header: 'Step' },
          { key: 'decision', header: 'Decision', render: (r) => <Badge status={r.decision} /> },
          { key: 'actor_id', header: 'Actor', render: (r) => userName(users, r.actor_id) || '—' },
          { key: 'actor_role', header: 'Actor Role' },
          { key: 'comments', header: 'Comments' },
          { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
        ]} rows={rows} />
      </Card>
    </div>
  )
}
