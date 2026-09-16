import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { PageHeader, Field, ErrorText, Badge, Table, EmptyState } from '../../components/Common'
import { formatDateIST } from '../../time'
import SearchableSelect from '../../components/SearchableSelect'
import {
  TestProjectOut, TestCycleOut, ReportCountRow, ReportStatusCountRow,
  RepositoryHealthOut, CycleProgressOut, DefectQualityOut,
  VersionImpactOut, ProjectPortfolioOut, RequirementTraceabilityOut, PageOut, DefectListOut,
} from '../../types'

type ReportTab = 'traceability' | 'health' | 'cycle-progress' | 'defects' | 'version-impact' | 'portfolio' | 'incomplete-defects'

const TABS: { id: ReportTab; label: string; scope: 'project' | 'cycle' | 'none' }[] = [
  { id: 'traceability', label: 'Requirements Traceability', scope: 'project' },
  { id: 'health', label: 'Repository Health', scope: 'project' },
  { id: 'cycle-progress', label: 'Cycle Progress', scope: 'cycle' },
  { id: 'defects', label: 'Defect Quality', scope: 'project' },
  { id: 'incomplete-defects', label: 'Incomplete Defect Traceability', scope: 'none' },
  { id: 'version-impact', label: 'Version Impact', scope: 'project' },
  { id: 'portfolio', label: 'Project Portfolio', scope: 'none' },
]

const TAB_DESCRIPTIONS: Record<ReportTab, string> = {
  traceability: 'Epic, CR, Feature and User Story coverage through execution and defects',
  health: 'Coverage, ownership, age and execution readiness',
  'cycle-progress': 'Execution completion and assignment health',
  defects: 'Governed defect outcomes, resolvers, reopen trends and execution traceability',
  'incomplete-defects': 'Unlinked and partially linked defects missing an execution trail',
  'version-impact': 'Stale test-case versions requiring action',
  portfolio: 'Cross-project delivery and ownership trends',
}

function barTone(label: string): string {
  const value = label.toLowerCase()
  if (/critical|fail|reject|blocked|breach/.test(value)) return 'tone-danger'
  if (/high|pending|warning|stale|unassigned/.test(value)) return 'tone-warning'
  if (/pass|approve|complete|active|closed/.test(value)) return 'tone-success'
  if (/medium|progress|review/.test(value)) return 'tone-info'
  return 'tone-primary'
}

function CountBars({ rows, total }: { rows: { key: string; count: number }[]; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="tm-report-bars">
      {rows.length === 0 && <EmptyState compact title="No report data available" description="This chart will populate when matching project records are available." />}
      {rows.map((row) => (
        <div className="tm-report-bar-row" key={row.key}>
          <span className="tm-report-bar-label">{row.key}</span>
          <div className="tm-report-bar-track"><div className={`tm-report-bar-fill ${barTone(row.key)}`} style={{ width: `${(row.count / max) * 100}%` }} /></div>
          <span className="tm-report-bar-count">{row.count}{total ? ` (${Math.round((row.count / total) * 100)}%)` : ''}</span>
        </div>
      ))}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="tm-report-stat"><strong>{value}</strong><span>{label}</span></div>
  )
}

function PopulationNote({ text }: { text: string }) {
  return <p className="muted small tm-report-population-note">{text}</p>
}

function Pager({ offset, limit, total, onOffset }: { offset: number; limit: number; total: number; onOffset: (o: number) => void }) {
  if (total <= limit) return null
  const page = Math.floor(offset / limit) + 1
  const pages = Math.ceil(total / limit)
  return (
    <div className="tm-report-pager">
      <button className="btn btn-sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>← Prev</button>
      <span className="muted small">Page {page} of {pages} · {total} total</span>
      <button className="btn btn-sm" disabled={offset + limit >= total} onClick={() => onOffset(offset + limit)}>Next →</button>
    </div>
  )
}

const PAGE_SIZE = 5

function RequirementsTraceabilityPanel({ projectId, onExportPath }: { projectId: number; onExportPath: (path: string | null) => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<RequirementTraceabilityOut | null>(null)
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [requirementType, setRequirementType] = useState('all')
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    const params = new URLSearchParams({ project_id: String(projectId), requirement_type: requirementType })
    if (appliedSearch) params.set('search', appliedSearch)
    onExportPath(`/api/test-reports/export/traceability?${params}`)
  }, [projectId, requirementType, appliedSearch, onExportPath])

  useEffect(() => { setOffset(0); setSearch(''); setAppliedSearch(''); setRequirementType('all') }, [projectId])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset), requirement_type: requirementType })
    if (appliedSearch) params.set('search', appliedSearch)
    api.get<RequirementTraceabilityOut>(`/api/test-reports/projects/${projectId}/requirements-traceability?${params}`)
      .then((result) => {
        if (cancelled) return
        if (offset > 0 && offset >= result.total_rows) {
          setOffset(Math.max(0, Math.ceil(result.total_rows / pageSize) - 1) * pageSize)
          return
        }
        setData(result)
      }).catch((err) => { if (!cancelled) setError(err) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, appliedSearch, requirementType, offset, pageSize])

  const applySearch = (event: React.FormEvent) => {
    event.preventDefault()
    setOffset(0)
    setAppliedSearch(search.trim())
  }
  const exportMatrix = async () => {
    const params = new URLSearchParams({ requirement_type: requirementType })
    if (appliedSearch) params.set('search', appliedSearch)
    try {
      setError(null)
      await api.downloadFile(
        `/api/test-reports/projects/${projectId}/requirements-traceability/export-xlsx?${params}`,
        'requirements-traceability-matrix.xlsx',
      )
    } catch (err) { setError(err) }
  }
  return (
    <div className="tm-report-panel tm-rtm-panel">
      <form className="tm-rtm-controls" onSubmit={applySearch}>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search requirement, test case, request, cycle or defect…"
          aria-label="Search traceability matrix"
        />
        <SearchableSelect
          value={requirementType}
          onChange={(value) => { setOffset(0); setRequirementType(value || 'all') }}
          options={[
            { value: 'all', label: 'All requirement mappings' },
            { value: 'epic', label: 'Epic ID mapped' },
            { value: 'cr', label: 'CR Number mapped' },
            { value: 'feature', label: 'Feature ID mapped' },
            { value: 'story', label: 'User Story ID mapped' },
            { value: 'unmapped', label: 'Unmapped test cases' },
          ]}
        />
        <button className="btn btn-primary btn-sm" type="submit">Search</button>
        <button className="btn btn-sm" type="button" onClick={() => void exportMatrix()}>Export matrix</button>
        {(search || appliedSearch) && <button className="btn btn-sm" type="button" onClick={() => { setSearch(''); setAppliedSearch(''); setOffset(0) }}>Clear</button>}
      </form>
      <ErrorText error={error} />
      {!data && !error && <p className="muted">Loading…</p>}
      {data && <>
        <PopulationNote text={data.population_note} />
        <div className="tm-report-stats-row">
          <StatCard label="Test cases" value={data.total_test_cases} />
          <StatCard label="Requirement mapped" value={data.mapped_test_cases} />
          <StatCard label="Unmapped" value={data.unmapped_test_cases} />
          <StatCard label="Added to a cycle" value={data.covered_test_cases} />
          <StatCard label="Executed" value={data.executed_test_cases} />
          <StatCard label="Failed / Blocked" value={data.failed_or_blocked_rows} />
          <StatCard label="With defects" value={data.defect_linked_rows} />
        </div>
        {data.items.length === 0 ? (
          <EmptyState compact title="No traceability records found" description="Change the search or requirement filter, or add requirement IDs to test cases in this project." />
        ) : (
          <Table
            tableId="requirements-traceability-matrix"
            rowKey="row_id"
            rows={data.items}
            server={{
              page: Math.floor(offset / pageSize) + 1,
              pageSize,
              total: data.total_rows,
              totalPages: Math.max(1, Math.ceil(data.total_rows / pageSize)),
              hasPrevious: offset > 0,
              hasNext: offset + pageSize < data.total_rows,
              onPageChange: (page) => setOffset((page - 1) * pageSize),
              onPageSizeChange: (size) => { setPageSize(size); setOffset(0) },
              loading,
            }}
            columns={[
              { key: 'requirement', header: 'Requirement', filterValue: (row) => [row.epic_id, row.cr_number, row.feature_id, row.user_story_id].filter(Boolean).join(' ') || 'Unmapped', render: (row) => (
                <div className="tm-rtm-stack">
                  {row.epic_id && <span><b>Epic</b>{row.epic_id}</span>}
                  {row.cr_number && <span><b>CR</b>{row.cr_number}</span>}
                  {row.feature_id && <span><b>Feature</b>{row.feature_id}</span>}
                  {row.user_story_id && <span><b>Story</b>{row.user_story_id}</span>}
                  {!row.epic_id && !row.cr_number && !row.feature_id && !row.user_story_id && <em>Unmapped</em>}
                </div>
              ) },
              { key: 'test_case', header: 'Test Case', filterValue: (row) => `${row.test_case_key} v${row.test_case_version} ${row.test_case_status} ${row.module_name || ''}`, render: (row) => <div className="tm-rtm-primary"><strong>{row.test_case_key}</strong><span>v{row.test_case_version} · {row.test_case_status}</span>{row.module_name && <small>{row.module_name}</small>}</div> },
              { key: 'functional_request_key', header: 'Functional Request', render: (row) => row.functional_request_key && row.functional_request_id ? <button className="btn btn-sm" onClick={() => navigate(`/functional-requests?openId=${row.functional_request_id}`)}>{row.functional_request_key}</button> : <span className="muted">Not linked</span> },
              { key: 'cycle', header: 'Test Cycle', filterValue: (row) => row.cycle_key ? `${row.cycle_key} ${row.cycle_name || ''}` : 'Not in a cycle', render: (row) => row.cycle_key ? <div className="tm-rtm-primary"><strong>{row.cycle_key}</strong><span>{row.cycle_name}</span></div> : <span className="muted">Not in a cycle</span> },
              { key: 'latest_result', header: 'Latest Result', render: (row) => <div className="tm-rtm-primary"><Badge status={row.latest_result} />{row.run_count > 0 && <span>{row.run_count} run{row.run_count === 1 ? '' : 's'}</span>}</div> },
              { key: 'defects', header: 'Defects', filterValue: (row) => row.defect_keys.join(' ') || 'None', render: (row) => row.defect_keys.length ? <div className="tm-rtm-stack">{row.defect_keys.map((key) => <strong key={key}>{key}</strong>)}</div> : <span className="muted">None</span> },
              { key: 'actions', header: 'Actions', filterable: false, render: (row) => <div className="tm-rtm-actions"><button className="btn btn-sm" onClick={() => navigate(`/test-repository?project=${projectId}&open=${encodeURIComponent(row.test_case_key)}`)}>Open case</button>{row.cycle_id && <button className="btn btn-sm" onClick={() => navigate(`/test-execution?project=${projectId}&cycle=${row.cycle_id}${row.execution_id ? `&execution=${row.execution_id}` : ''}`)}>Open execution</button>}</div> },
            ]}
          />
        )}
      </>}
    </div>
  )
}

function RepositoryHealthPanel({ projectId }: { projectId: number }) {
  const [data, setData] = useState<RepositoryHealthOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    setData(null)
    api.get<RepositoryHealthOut>(`/api/test-reports/projects/${projectId}/repository-health`).then(setData).catch(setError)
  }, [projectId])
  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div className="tm-report-panel">
      <PopulationNote text={data.population_note} />
      <div className="tm-report-stats-row">
        <StatCard label="Total test cases" value={data.total_cases} />
        <StatCard label="Average age (days)" value={data.average_age_days} />
        <StatCard label="Never executed" value={data.never_executed_count} />
      </div>
      <div className="tm-report-grid">
        <div><h4>By Status</h4><CountBars rows={data.by_status} total={data.total_cases} /></div>
        <div><h4>By Module</h4><CountBars rows={data.by_module} total={data.total_cases} /></div>
        <div><h4>By Priority</h4><CountBars rows={data.by_priority} total={data.total_cases} /></div>
        <div><h4>By Test Type</h4><CountBars rows={data.by_test_type} total={data.total_cases} /></div>
        <div><h4>By Owner</h4><CountBars rows={data.by_owner} total={data.total_cases} /></div>
      </div>
    </div>
  )
}

function CycleProgressPanel({ projectId, onExportPath }: { projectId: number; onExportPath: (path: string | null) => void }) {
  const [cycles, setCycles] = useState<TestCycleOut[]>([])
  const [cycleId, setCycleId] = useState<number | ''>('')
  const [data, setData] = useState<CycleProgressOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    onExportPath(cycleId ? `/api/test-reports/export/cycle-progress?project_id=${projectId}&cycle_id=${cycleId}` : null)
  }, [cycleId, projectId, onExportPath])

  useEffect(() => {
    setCycleId(''); setData(null)

    api.get<PageOut<TestCycleOut>>(`/api/test-execution/projects/${projectId}/cycles?page_size=100`).then((page) => {
      const c = page.items
      setCycles(c)
      if (c.length) setCycleId(c[0].id)
    }).catch(setError)
  }, [projectId])

  useEffect(() => {
    if (!cycleId) return
    setData(null)
    api.get<CycleProgressOut>(`/api/test-reports/cycles/${cycleId}/progress`).then(setData).catch(setError)
  }, [cycleId])

  if (error) return <ErrorText error={error} />
  return (
    <div className="tm-report-panel">
      <Field label="Cycle">
        <SearchableSelect
          value={cycleId === '' ? '' : String(cycleId)}
          onChange={(v) => setCycleId(v ? Number(v) : '')}
          placeholder={cycles.length ? 'Select a cycle...' : 'No cycles in this project'}
          options={cycles.map((c) => ({ value: String(c.id), label: `${c.cycle_key} · ${c.name}` }))}
        />
      </Field>
      {!cycleId && <p className="muted">Select a cycle to see its progress.</p>}
      {cycleId && !data && <p className="muted">Loading…</p>}
      {data && (
        <div className="tm-report-panel-body">
          <PopulationNote text={data.population_note} />
          <div className="tm-report-stats-row">
            <StatCard label="Total items" value={data.total_items} />
            <StatCard label="Completion" value={`${data.completion_pct}%`} />
            <StatCard label="Assigned" value={data.assigned_count} />
            <StatCard label="Unassigned" value={data.unassigned_count} />
            <StatCard label="Cycle status" value={<Badge status={data.cycle_status} />} />
          </div>
          {data.is_locked && <p className="info-banner">This cycle is operationally locked while Blocked or after completion.</p>}
          <h4>By Result</h4>
          <CountBars rows={data.by_status.map((r) => ({ key: r.status, count: r.count }))} total={data.total_items} />
        </div>
      )}
    </div>
  )
}

function DefectQualityPanel({ projectId, onExportPath }: { projectId: number; onExportPath: (path: string | null) => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<DefectQualityOut | null>(null)
  const [offset, setOffset] = useState(0)
  const [resolverFilter, setResolverFilter] = useState<{ id: number; name: string; reopened: boolean } | null>(null)
  const [resolverSearch, setResolverSearch] = useState('')
  const [resolverPage, setResolverPage] = useState(1)
  const [expandedResolverId, setExpandedResolverId] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    const params = new URLSearchParams({ project_id: String(projectId) })
    if (resolverFilter) params.set('resolver_id', String(resolverFilter.id))
    if (resolverFilter?.reopened) params.set('reopened_only', 'true')
    onExportPath(`/api/test-reports/export/defects?${params}`)
  }, [projectId, resolverFilter, onExportPath])
  useEffect(() => { setOffset(0); setResolverFilter(null); setResolverSearch(''); setResolverPage(1); setExpandedResolverId(null) }, [projectId])
  useEffect(() => {
    setData(null)
    setError(null)
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (resolverFilter) params.set('resolver_id', String(resolverFilter.id))
    if (resolverFilter?.reopened) params.set('reopened_only', 'true')
    api.get<DefectQualityOut>(`/api/test-reports/projects/${projectId}/defect-quality?${params}`).then(setData).catch(setError)
  }, [projectId, offset, resolverFilter])
  const filterResolver = (id: number, name: string, reopened: boolean) => {
    setOffset(0)
    setResolverFilter({ id, name, reopened })
  }
  const matchingResolvers = useMemo(() => {
    if (!data) return []
    const needle = resolverSearch.trim().toLowerCase()
    return needle ? data.resolution_activity.filter((item) => item.resolver_name.toLowerCase().includes(needle)) : data.resolution_activity
  }, [data, resolverSearch])
  const resolverPageSize = 10
  const resolverPages = Math.max(1, Math.ceil(matchingResolvers.length / resolverPageSize))
  const visibleResolvers = matchingResolvers.slice((resolverPage - 1) * resolverPageSize, resolverPage * resolverPageSize)
  useEffect(() => { setResolverPage(1); setExpandedResolverId(null) }, [resolverSearch])
  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div className="tm-report-panel tm-defect-quality-report">
      <PopulationNote text={data.population_note} />
      <div className="tm-report-stats-row">
        <StatCard label="Governed defects" value={data.total_governed_defects} />
        <StatCard label="Open defects" value={data.open_defects} />
        <StatCard label="Resolved history" value={data.resolved_defects} />
        <StatCard label="Reopened defects" value={data.reopened_defects} />
        <StatCard label="Reopen events" value={data.reopen_events} />
        <StatCard label="Retest success rate" value={`${data.retest_success_rate_pct}%`} />
      </div>
      <div className="tm-report-grid">
        <div><h4>Governed defects by module</h4><CountBars rows={data.by_module} total={data.total_governed_defects} /></div>
        <div><h4>Governed defects by status</h4><CountBars rows={data.by_status} total={data.total_governed_defects} /></div>
      </div>
      <section className="tm-defect-quality-section">
        <div className="tm-defect-quality-heading"><div><span>RESOLUTION OUTCOMES</span><h4>Resolution activity</h4><p>Attributed to the user who submitted the latest audited Resolved action.</p></div><label className="tm-defect-quality-search"><span>{data.resolution_activity.length} contributors</span><input value={resolverSearch} onChange={(event) => setResolverSearch(event.target.value)} placeholder="Find contributor…" /></label></div>
        {data.resolution_activity.length ? <><div className="tm-resolver-accordion"><div className="tm-resolver-heading"><span>Resolved by</span><span>Resolved</span><span>Reopened</span><span>Events</span><span /></div>{visibleResolvers.map((row) => { const expanded = expandedResolverId === row.resolver_id; return <div className="tm-resolver-group" key={row.resolver_id}><button type="button" className={`tm-resolver-row ${expanded ? 'is-expanded' : ''}`} aria-expanded={expanded} onClick={() => setExpandedResolverId(expanded ? null : row.resolver_id)}><span><strong>{row.resolver_name}</strong><small>Submitted the latest Resolved action</small></span><b>{row.resolved_defects}</b><b>{row.reopened_defects}</b><b>{row.reopen_events}</b><i>›</i></button><div hidden={!expanded} className="tm-resolver-actions"><div><strong>{row.resolved_defects} resolved defects</strong><span>{row.reopened_defects} reopened across {row.reopen_events} recorded event{row.reopen_events === 1 ? '' : 's'}.</span></div><button type="button" onClick={() => filterResolver(row.resolver_id, row.resolver_name, false)}>View resolved defects</button><button type="button" disabled={!row.reopened_defects} onClick={() => filterResolver(row.resolver_id, row.resolver_name, true)}>View reopened defects</button></div></div> })}</div><div className="tm-defect-quality-resolver-pager"><span>{matchingResolvers.length ? `${(resolverPage - 1) * resolverPageSize + 1}–${Math.min(resolverPage * resolverPageSize, matchingResolvers.length)} of ${matchingResolvers.length}` : 'No contributors match'}</span><div><button disabled={resolverPage === 1} onClick={() => setResolverPage((page) => Math.max(1, page - 1))}>← Previous</button><button disabled={resolverPage === resolverPages || !matchingResolvers.length} onClick={() => setResolverPage((page) => Math.min(resolverPages, page + 1))}>Next →</button></div></div></> : <EmptyState compact title="No audited resolutions yet" description="Resolution activity will appear after a governed defect reaches Resolved." />}
      </section>
      <section className="tm-defect-quality-section">
        <div className="tm-defect-quality-heading"><div><span>PROJECT DEFECT REGISTER</span><h4>{resolverFilter ? `${resolverFilter.reopened ? 'Reopened defects' : 'Resolved defects'} by ${resolverFilter.name}` : `${data.project_key} · ${data.project_name}`}</h4><p>Request, project, cycle, testcase, resolution and reopen traceability in one view.</p></div>{resolverFilter && <button className="btn btn-sm" onClick={() => { setResolverFilter(null); setOffset(0) }}>Clear resolver filter</button>}</div>
        <Table
          tableId="test-report-defect-quality"
          rowKey="defect_id"
          rows={data.items}
          onRowClick={(item) => navigate(`/defects?open=${encodeURIComponent(item.defect_key)}`)}
          columns={[
            { key: 'defect_key', header: 'Defect', render: (item) => <span className="tm-defect-quality-primary"><button className="link-btn" onClick={(event) => { event.stopPropagation(); navigate(`/defects?open=${encodeURIComponent(item.defect_key)}`) }}>{item.defect_key}</button><strong>{item.title}</strong><small>{item.application_name} · {item.module_feature}</small></span> },
            { key: 'qa_request_key', header: 'Request / Project', render: (item) => <span className="tm-defect-quality-stack"><strong>{item.qa_request_key || 'Request not numbered'}</strong><span>{item.project_key} · {item.project_name}</span><small>Project database ID {item.project_id}</small></span> },
            { key: 'cycle_keys', header: 'Execution trace', render: (item) => <span className="tm-defect-quality-stack"><strong>{item.cycle_keys.join(', ') || 'No cycle'}</strong><span>{item.test_case_keys.join(', ') || 'No testcase'}</span></span> },
            { key: 'status', header: 'Quality state', render: (item) => <span className="tm-defect-quality-stack"><Badge status={item.status} /><span>{item.severity}</span><small>{item.target_release ? `Target ${item.target_release}` : 'No target release'}</small></span> },
            { key: 'resolved_by_name', header: 'Resolution outcome', render: (item) => <span className="tm-defect-quality-stack"><strong>{item.resolved_by_name || 'Not resolved'}</strong><span>{item.reopen_count} reopen event{item.reopen_count === 1 ? '' : 's'}</span><small>Updated {formatDateIST(item.updated_at)}</small></span> },
          ]}
        />
        {!data.items.length && <EmptyState compact title="No matching governed defects" description={resolverFilter ? 'Clear the resolver filter to return to the full project defect register.' : 'Governed defects linked to this project will appear here.'} />}
        <Pager offset={offset} limit={PAGE_SIZE} total={data.total_items} onOffset={setOffset} />
      </section>
    </div>
  )
}

function VersionImpactPanel({ projectId }: { projectId: number }) {
  const [data, setData] = useState<VersionImpactOut | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => { setOffset(0) }, [projectId])
  useEffect(() => {
    setData(null)
    api.get<VersionImpactOut>(`/api/test-reports/projects/${projectId}/version-impact?limit=${PAGE_SIZE}&offset=${offset}`).then(setData).catch(setError)
  }, [projectId, offset])
  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div className="tm-report-panel">
      <PopulationNote text={data.population_note} />
      <div className="tm-report-stats-row">
        <StatCard label="Cycles with stale items" value={data.cycles_with_stale_items} />
      </div>
      <Table
        tableId="test-report-version-impact"
        rowKey="cycle_id"
        rows={data.items}
        columns={[
          { key: 'cycle_key', header: 'Cycle' },
          { key: 'cycle_status', header: 'Status', render: (item) => <Badge status={item.cycle_status} /> },
          { key: 'stale_item_count', header: 'Stale Items' },
          { key: 'upgradeable_count', header: 'Upgradeable' },
          { key: 'permanently_pinned_count', header: 'Permanently Pinned' },
        ]}
      />
      <Pager offset={offset} limit={PAGE_SIZE} total={data.total_items} onOffset={setOffset} />
    </div>
  )
}

function ProjectPortfolioPanel() {
  const [data, setData] = useState<ProjectPortfolioOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    api.get<ProjectPortfolioOut>('/api/test-reports/portfolio').then(setData).catch(setError)
  }, [])
  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div className="tm-report-panel">
      <PopulationNote text={data.population_note} />
      <div className="tm-report-stats-row">
        <StatCard label="Active test projects" value={data.active_project_count} />
        <StatCard label="Inactive test projects" value={data.inactive_project_count} />
        <StatCard label="Archived projects" value={data.archived_project_count} />
        <StatCard label="Cycles" value={data.cycle_count} />
      </div>
      <div className="tm-report-grid">
        <div><h4>Cycles by Status</h4><CountBars rows={data.cycles_by_status.map((r) => ({ key: r.status, count: r.count }))} total={data.cycle_count} /></div>
        <div><h4>Projects by Owner</h4><CountBars rows={data.ownership.map((r) => ({ key: r.owner, count: r.project_count }))} /></div>
      </div>
      <h4>Cycle Creation Trend (last 180 days)</h4>
      <CountBars rows={data.cycle_creation_trend.map((r) => ({ key: r.month, count: r.count }))} />
    </div>
  )
}

function IncompleteDefectTraceabilityPanel({ onExportPath }: { onExportPath: (path: string | null) => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<PageOut<DefectListOut> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  useEffect(() => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    onExportPath(`/api/test-reports/export/incomplete-defects${params.size ? `?${params}` : ''}`)
  }, [search, onExportPath])
  useEffect(() => {
    let active = true
    setData(null); setError(null)
    const params = new URLSearchParams({ queue: 'incomplete-traceability', page: String(page), page_size: '25', search })
    api.get<PageOut<DefectListOut>>(`/api/defects?${params}`)
      .then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err) })
    return () => { active = false }
  }, [page, search])
  return <div className="tm-report-panel">
    <PopulationNote text="Defects within your access scope without a primary or additional execution link, including defects with no links at all. Request, cycle or testcase links alone leave execution traceability incomplete. All statuses are included; no project selection is required." />
    <input aria-label="Search incomplete defect traceability" placeholder="Search defect, title, application or module…" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} />
    <ErrorText error={error} />
    {!data && !error && <p className="muted">Loading…</p>}
    {data && <>
      <StatCard label="Incomplete traceability" value={data.total} />
      <Table<DefectListOut> tableId="incomplete-defect-traceability" rowKey="id" rows={data.items}
        server={{ page: data.page, pageSize: data.page_size, total: data.total, totalPages: data.total_pages, hasNext: data.has_next, hasPrevious: data.has_previous, onPageChange: setPage }}
        onRowClick={item => navigate(`/defects?open=${encodeURIComponent(item.defect_key)}`)}
        columns={[
          { key: 'defect_key', header: 'Defect', render: item => <><button className="link-btn" onClick={event => { event.stopPropagation(); navigate(`/defects?open=${encodeURIComponent(item.defect_key)}`) }}>{item.defect_key}</button><div>{item.title}</div></> },
          { key: 'application_name', header: 'Application / Module', render: item => <>{item.application_name}<div className="muted">{item.module_feature}</div></> },
          { key: 'status', header: 'Status', render: item => <Badge status={item.status} /> },
          { key: 'severity', header: 'Severity' },
          { key: 'qa_request_key', header: 'QA Request', render: item => item.qa_request_key || (item.qa_request_id ? 'Request not numbered' : 'Not linked') },
          { key: 'cycle_key', header: 'Cycle', render: item => item.cycle_key || 'Not linked' },
          { key: 'test_case_key', header: 'Primary testcase', render: item => item.test_case_key || 'Not linked' },
          { key: 'execution_id', header: 'Traceability gap', render: () => <span className="badge badge-yellow">Missing execution link</span> },
        ]} />
      {!data.items.length && <EmptyState compact title="No matching defects with incomplete traceability" description="Defects without execution links will appear here within your access scope." />}
    </>}
  </div>
}

export default function TestReports() {
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [projectId, setProjectId] = useState<number | ''>('')
  const [tab, setTab] = useState<ReportTab>('traceability')
  const [error, setError] = useState<unknown>(null)
  const [activeExportPath, setActiveExportPath] = useState<string | null>(null)
  const [exportingTab, setExportingTab] = useState<ReportTab | null>(null)
  const updateExportPath = useCallback((path: string | null) => setActiveExportPath(path), [])

  const load = useCallback(async () => {
    try {
      const p = await api.get<PageOut<TestProjectOut>>('/api/test-projects?page_size=100').then((page) => page.items)
      setProjects(p)
      if (p.length) setProjectId(p[0].id)
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  const activeTab = useMemo(() => TABS.find((t) => t.id === tab)!, [tab])
  const exportReport = async (report: typeof TABS[number]) => {
    if (report.scope !== 'none' && !projectId) {
      setError(new Error('Select a Test Project before exporting this report.'))
      return
    }
    setError(null)
    setExportingTab(report.id)
    try {
      let path = report.id === tab && activeExportPath ? activeExportPath : `/api/test-reports/export/${report.id}`
      if (report.scope !== 'none' && !path.includes('project_id=')) {
        path += `?project_id=${projectId}`
      }
      if (report.id === 'cycle-progress' && !path.includes('cycle_id=')) {
        const page = await api.get<PageOut<TestCycleOut>>(`/api/test-execution/projects/${projectId}/cycles?page_size=100`)
        if (!page.items.length) throw new Error('This project has no Test Cycle to export.')
        path += `${path.includes('?') ? '&' : '?'}cycle_id=${page.items[0].id}`
      }
      await api.downloadFile(path, `test-report-${report.id}.xlsx`)
    } catch (err) { setError(err) }
    finally { setExportingTab(null) }
  }

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        eyebrow="Test Case Management · Design · Organize · Execute · Trace"
        title="Test Reports"
        subtitle="Trace requirements through repository quality, execution, defects, versions and project delivery."
      />
      <section className="tm-report-workspace">
        <aside className="tm-report-navigation" aria-label="Report views">
          <div className="tm-report-navigation-head">
            <span>Report catalogue</span>
            <strong>{TABS.length} views</strong>
          </div>
          {TABS.map((t, index) => (
            <div key={t.id} className={`tm-report-catalogue-item ${tab === t.id ? 'active' : ''}`}>
              <button type="button" className="tm-report-select" onClick={() => { setActiveExportPath(null); setTab(t.id) }} aria-current={tab === t.id ? 'page' : undefined}>
                <span className="tm-report-nav-index">{String(index + 1).padStart(2, '0')}</span>
                <span><strong>{t.label}</strong><small>{TAB_DESCRIPTIONS[t.id]}</small></span>
              </button>
              <button type="button" className="tm-report-export" onClick={() => exportReport(t)} disabled={exportingTab !== null || (t.scope !== 'none' && !projectId)} aria-label={`Export ${t.label} report`} title={`Export ${t.label} as Excel`}>
                {exportingTab === t.id ? 'Exporting…' : 'Export'}
              </button>
            </div>
          ))}
        </aside>
        <div className="tm-report-content">
          <header className="tm-report-content-head">
            <div>
              <span className="tm-report-eyebrow">Current report</span>
              <h3>{activeTab.label}</h3>
              <p>{TAB_DESCRIPTIONS[activeTab.id]}</p>
            </div>
            {activeTab.scope !== 'none' && (
              <div className="tm-report-project-control">
                <Field label="Project scope">
                  <SearchableSelect
                    value={projectId === '' ? '' : String(projectId)}
                    onChange={(v) => { setActiveExportPath(null); setProjectId(v ? Number(v) : '') }}
                    placeholder={projects.length ? 'Select a project...' : 'No Test Projects yet'}
                    options={projects.map((p) => ({ value: String(p.id), label: `${p.project_key} · ${p.name}` }))}
                  />
                </Field>
              </div>
            )}
          </header>
          <div className="tm-report-content-body">
            {activeTab.scope !== 'none' && !projectId && <div className="tm-report-empty"><strong>Select a project</strong><span>Choose a project scope to generate this report.</span></div>}
            {tab === 'portfolio' && <ProjectPortfolioPanel />}
            {tab === 'incomplete-defects' && <IncompleteDefectTraceabilityPanel onExportPath={updateExportPath} />}
            {projectId && tab === 'traceability' && <RequirementsTraceabilityPanel key={projectId} projectId={projectId} onExportPath={updateExportPath} />}
            {projectId && tab === 'health' && <RepositoryHealthPanel projectId={projectId} />}
            {projectId && tab === 'cycle-progress' && <CycleProgressPanel projectId={projectId} onExportPath={updateExportPath} />}
            {projectId && tab === 'defects' && <DefectQualityPanel projectId={projectId} onExportPath={updateExportPath} />}
            {projectId && tab === 'version-impact' && <VersionImpactPanel projectId={projectId} />}
          </div>
        </div>
      </section>
    </div>
  )
}
