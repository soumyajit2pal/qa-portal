import React, { useId, useState } from 'react'
import { DashboardAttentionOut } from '../types'
import { Badge } from './Common'
import { IconArrowRight } from './Icons'
import ClearableSearchInput from './ClearableSearchInput'

interface Props {
  data: DashboardAttentionOut
  loading: boolean
  onLoad: (page: number, pageSize: number, search: string) => void
  onOpen: (route: string) => void
  formatUpdated: (date: string) => string
}

export default function ActiveProjectsBrowser({ data, loading, onLoad, onOpen, formatUpdated }: Props) {
  const [selectedKey, setSelectedKey] = useState<string | null>()
  const sectionId = useId()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const selected = selectedKey === null ? null : data.rows.find((row) => row.key === selectedKey) || data.rows[0]

  function runSearch(value: string) {
    setSearch(value.trim())
    onLoad(1, data.page_size, value.trim())
  }

  return <section className="active-projects-browser" aria-label="Active CR / EPIC explorer">
    <div className="ap-toolbar">
    <div className="ap-overview">
      <div><strong>{data.total}</strong><span>active CRs / EPICs</span></div>
    </div>
    <form className="ap-search" onSubmit={(event) => { event.preventDefault(); runSearch(query) }}>
      <ClearableSearchInput value={query} onChange={(event) => setQuery(event.target.value)}
        onClear={() => { setQuery(''); runSearch('') }}
        aria-label="Search all active CRs / EPICs" placeholder="Search CR / EPIC, application, department, request ID or stage…" />
      <button type="submit" className="btn" disabled={loading}>Search</button>
    </form>
    </div>
    <p className="ap-guide">Each CR / EPIC is counted once. Expand it to view its active Functional QA requests.</p>
    <div className="ap-accordion" aria-busy={loading}>
        <div className="ap-list-heading"><span>CR / EPIC · Application</span><span>Department</span><span>Requests</span><span>Updated</span><span /></div>
        <div aria-label="CRs / EPICs">
          {data.rows.map((project, index) => {
            const expanded = selected?.key === project.key
            const panelId = `${sectionId}-project-${index}`
            return <div className="ap-project-group" key={project.key}>
              <button type="button" className={`ap-project ${expanded ? 'is-selected' : ''}`}
                aria-expanded={expanded} aria-controls={panelId}
                aria-label={`View requests for ${project.project_id}`} title={`View requests for ${project.project_id}`}
                disabled={loading} onClick={() => setSelectedKey(expanded ? null : project.key)}>
                <span className="ap-project-info"><strong>{project.project_id}</strong><span title={project.application_name}>{project.application_name}</span></span>
                <span className="ap-department">{project.department || '—'}</span>
                <span className="ap-request-count">{project.request_count || 0}</span>
                <span className="ap-updated">{project.updated_at ? formatUpdated(project.updated_at) : '—'}</span>
                <span className={`ap-chevron ${expanded ? 'is-expanded' : ''}`} aria-hidden="true">›</span>
              </button>
              <section id={panelId} hidden={!expanded} className="ap-inline-requests" aria-label={`Requests for ${project.project_id}`}>
                {(project.linked_requests || []).map((request) => <div className="ap-request" key={request.id}>
                  <strong>{request.request_id}</strong>
                  <Badge status={request.status} />
                  <button type="button" className="ap-open-request" disabled={loading}
                    aria-label={`Open request ${request.request_id}`} title={`Open ${request.request_id}`}
                    onClick={() => onOpen(request.route)}>Open <IconArrowRight /></button>
                </div>)}
                {!project.linked_requests?.length && <p className="ap-empty">No linked requests available.</p>}
              </section>
            </div>
          })}
          {!data.rows.length && <p className="ap-empty">No active CRs / EPICs match your search.</p>}
        </div>
        <div className="ap-pagination">
          <span>{data.total_rows ? (data.page - 1) * data.page_size + 1 : 0}–{Math.min(data.page * data.page_size, data.total_rows)} of {data.total_rows}</span>
          <select aria-label="CRs / EPICs per page" value={data.page_size} disabled={loading}
            onChange={(event) => onLoad(1, Number(event.target.value), search)}>
            {[5, 10, 25, 50, 100].map((size) => <option key={size} value={size}>{size} / page</option>)}
          </select>
          <button type="button" aria-label="Previous CR / EPIC page" disabled={loading || !data.has_previous} onClick={() => onLoad(data.page - 1, data.page_size, search)}>‹</button>
          <span>{data.page} / {data.total_pages}</span>
          <button type="button" aria-label="Next CR / EPIC page" disabled={loading || !data.has_next} onClick={() => onLoad(data.page + 1, data.page_size, search)}>›</button>
        </div>
    </div>
  </section>
}
