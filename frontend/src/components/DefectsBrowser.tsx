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

export default function DefectsBrowser({ data, loading, onLoad, onOpen, formatUpdated }: Props) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const sectionId = useId()

  function runSearch(value: string) {
    const normalized = value.trim()
    setSearch(normalized)
    setExpandedKey(null)
    onLoad(1, data.page_size, normalized)
  }

  return <section className="active-projects-browser defect-records-browser" aria-label="Defect explorer">
    <div className="ap-toolbar">
      <div className="ap-overview"><div><strong>{data.total_rows}</strong><span>defects</span></div></div>
      <form className="ap-search" onSubmit={(event) => { event.preventDefault(); runSearch(query) }}>
        <ClearableSearchInput value={query} onChange={(event) => setQuery(event.target.value)}
          onClear={() => { setQuery(''); runSearch('') }} aria-label="Search defects"
          placeholder="Search defect, request, project, cycle, testcase, application or resolver…" />
        <button type="submit" className="btn" disabled={loading}>Search</button>
      </form>
    </div>
    <p className="ap-guide">Each governed defect is counted once. Expand a row to review every linked cycle and testcase.</p>
    <div className="ap-accordion" aria-busy={loading}>
      <div className="ap-list-heading"><span>Defect · Application</span><span>Request · Project</span><span>Status</span><span>Updated</span><span /></div>
      <div aria-label="Defects">
        {data.rows.map((defect, index) => {
          const expanded = expandedKey === defect.key
          const panelId = `${sectionId}-defect-${index}`
          return <div className="ap-project-group" key={defect.key}>
            <button type="button" className={`ap-project ${expanded ? 'is-selected' : ''}`}
              aria-expanded={expanded} aria-controls={panelId} disabled={loading}
              onClick={() => setExpandedKey(expanded ? null : defect.key)}>
              <span className="ap-project-info"><strong>{defect.defect_id}</strong><span>{defect.application_name || defect.title}</span></span>
              <span className="ap-project-info"><strong>{defect.request_id || 'No request ID'}</strong><span>{defect.project_ids?.join(', ') || 'No project'}</span></span>
              <span className="defect-browser-status"><Badge status={defect.status || ''} /><small>{defect.severity || '—'}</small></span>
              <span className="ap-updated">{defect.updated_at ? formatUpdated(defect.updated_at) : '—'}</span>
              <span className={`ap-chevron ${expanded ? 'is-expanded' : ''}`} aria-hidden="true">›</span>
            </button>
            <section id={panelId} hidden={!expanded} className="ap-inline-requests defect-browser-detail" aria-label={`Traceability for ${defect.defect_id}`}>
              <div className="defect-browser-trace"><div><span>Cycles</span><strong>{defect.cycle_ids?.join(', ') || 'No linked cycle'}</strong></div><div><span>Testcases</span><strong>{defect.test_case_ids?.join(', ') || 'No linked testcase'}</strong></div><div><span>Resolved by</span><strong>{defect.resolver_name || 'Not resolved'}</strong></div><div><span>Reopen events</span><strong>{defect.reopen_count || 0}</strong></div><button type="button" className="ap-open-request" disabled={loading || !defect.route} onClick={() => defect.route && onOpen(defect.route)}>Open defect <IconArrowRight /></button></div>
            </section>
          </div>
        })}
        {!data.rows.length && <p className="ap-empty">No defects match your search.</p>}
      </div>
      <div className="ap-pagination">
        <span>{data.total_rows ? (data.page - 1) * data.page_size + 1 : 0}–{Math.min(data.page * data.page_size, data.total_rows)} of {data.total_rows}</span>
        <select aria-label="Defects per page" value={data.page_size} disabled={loading} onChange={(event) => onLoad(1, Number(event.target.value), search)}>
          {[5, 10, 25, 50, 100].map((size) => <option key={size} value={size}>{size} / page</option>)}
        </select>
        <button type="button" aria-label="Previous defect page" disabled={loading || !data.has_previous} onClick={() => onLoad(data.page - 1, data.page_size, search)}>‹</button>
        <span>{data.page} / {data.total_pages}</span>
        <button type="button" aria-label="Next defect page" disabled={loading || !data.has_next} onClick={() => onLoad(data.page + 1, data.page_size, search)}>›</button>
      </div>
    </div>
  </section>
}
