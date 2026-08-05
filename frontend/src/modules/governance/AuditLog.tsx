import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { AuditLogOut, AuditLogPage } from '../../types'
import { Card, ErrorText, Modal, PageHeader, Table } from '../../components/Common'
import ClearableSearchInput from '../../components/ClearableSearchInput'

const EVENT_TYPES = ['', 'AUTHENTICATION', 'ACCESS_MANAGEMENT', 'DATA_CHANGE', 'ACCESS']

function label(value?: string | null): string {
  return (value || '—').replace(/_/g, ' ')
}

function prettyDetails(raw?: string | null): string {
  if (!raw) return 'No additional detail was recorded.'
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

export default function AuditLog() {
  const [data, setData] = useState<AuditLogPage>({
    rows: [], total: 0, page: 1, page_size: 50,
    summary: { total: 0, failed: 0, authentication: 0, access_management: 0 },
  })
  const [eventType, setEventType] = useState('')
  const [outcome, setOutcome] = useState('')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<AuditLogOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), page_size: '50' })
    if (eventType) p.set('event_type', eventType)
    if (outcome) p.set('outcome', outcome)
    if (search.trim()) p.set('search', search.trim())
    if (dateFrom) p.set('date_from', `${dateFrom}T00:00:00`)
    if (dateTo) p.set('date_to', `${dateTo}T23:59:59`)
    return p.toString()
  }, [eventType, outcome, search, dateFrom, dateTo, page])

  const load = useCallback(async () => {
    try {
      setError(null)
      setData(await api.get<AuditLogPage>(`/api/audit?${query}`))
    } catch (err) { setError(err) }
  }, [query])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [eventType, outcome, search, dateFrom, dateTo])

  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Audit Log" count={data.total}
        subtitle="Immutable record of sign-ins, failed access, API activity, data changes, and user/role administration. Passwords, tokens, and request bodies are never captured."
        actions={<button className="btn btn-primary" onClick={() => api.downloadFile(`/api/audit/export?${query}`, 'qualityhub-audit-log.csv')}>Export CSV</button>}
      />

      <div className="audit-summary-grid">
        <div className="audit-summary"><span>Total events</span><strong>{data.summary.total}</strong></div>
        <div className="audit-summary"><span>Authentication</span><strong>{data.summary.authentication}</strong></div>
        <div className="audit-summary"><span>Access changes</span><strong>{data.summary.access_management}</strong></div>
        <div className="audit-summary audit-summary-danger"><span>Failed events</span><strong>{data.summary.failed}</strong></div>
      </div>

      <div className="toolbar audit-toolbar">
        <ClearableSearchInput value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} clearLabel="Clear audit log search" wrapperClassName="search-grow" placeholder="Search actor, action, path or target" aria-label="Search audit log" />
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} aria-label="Event type">
          {EVENT_TYPES.map((value) => <option key={value} value={value}>{value ? label(value) : 'All event types'}</option>)}
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
          <option value="">All outcomes</option><option value="SUCCESS">Success</option><option value="FAILED">Failed</option>
        </select>
        <label className="audit-date">From <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></label>
        <label className="audit-date">To <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></label>
        <button className="btn btn-sm" onClick={() => { setSearch(''); setEventType(''); setOutcome(''); setDateFrom(''); setDateTo('') }}>Clear</button>
      </div>

      <Card subtitle="Select any row to see the complete event context and before/after access changes.">
        <Table<AuditLogOut> rowKey="id" pageSize={50} onRowClick={setSelected} columns={[
          { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
          { key: 'actor_name', header: 'Who', render: (r) => <div><div>{r.actor_name || r.actor_username || 'Unauthenticated'}</div><div className="muted small">{r.actor_username || '—'}</div></div>, filterValue: (r) => `${r.actor_name || ''} ${r.actor_username || ''}` },
          { key: 'event_type', header: 'Event', render: (r) => label(r.event_type) },
          { key: 'action', header: 'Action', render: (r) => label(r.action) },
          { key: 'outcome', header: 'Outcome', render: (r) => <span className={`badge ${r.outcome === 'FAILED' ? 'badge-red' : 'badge-green'}`}>{r.outcome}</span> },
          { key: 'path', header: 'Access / Target', render: (r) => <div><div>{[r.method, r.path].filter(Boolean).join(' ') || '—'}</div>{(r.target_name || r.target_id) && <div className="muted small">{r.target_type}: {r.target_name || r.target_id}</div>}</div>, filterValue: (r) => `${r.method || ''} ${r.path || ''} ${r.target_name || ''} ${r.target_id || ''}` },
          { key: 'ip_address', header: 'Source IP', render: (r) => r.ip_address || '—' },
        ]} rows={data.rows} />
        <div className="audit-pagination">
          <span>Page {page} of {totalPages} · {data.total} matching events</span>
          <div><button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button><button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button></div>
        </div>
      </Card>

      {selected && (
        <Modal title={`Audit event #${selected.id}`} onClose={() => setSelected(null)} wide>
          <div className="audit-detail-grid">
            <div><span>Timestamp</span><strong>{new Date(selected.created_at).toLocaleString()}</strong></div>
            <div><span>Actor</span><strong>{selected.actor_name || selected.actor_username || 'Unauthenticated'}</strong></div>
            <div><span>Roles at the time</span><strong>{selected.actor_roles || '—'}</strong></div>
            <div><span>Event / action</span><strong>{label(selected.event_type)} · {label(selected.action)}</strong></div>
            <div><span>Outcome / HTTP status</span><strong>{selected.outcome} · {selected.status_code || '—'}</strong></div>
            <div><span>Source</span><strong>{selected.ip_address || '—'}</strong></div>
            <div><span>Request</span><strong>{[selected.method, selected.path].filter(Boolean).join(' ') || '—'}</strong></div>
            <div><span>Correlation ID</span><strong>{selected.request_id || '—'}</strong></div>
            <div><span>Target</span><strong>{[selected.target_type, selected.target_name || selected.target_id].filter(Boolean).join(' · ') || '—'}</strong></div>
            <div><span>User agent</span><strong>{selected.user_agent || '—'}</strong></div>
          </div>
          <h4>Event details</h4>
          <pre className="audit-details-json">{prettyDetails(selected.details)}</pre>
        </Modal>
      )}
    </div>
  )
}
