import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { PageHeader, Field, ErrorText, Badge } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import {
  TestProjectOut, TestCycleOut, ReportCountRow, ReportStatusCountRow,
  RepositoryHealthOut, CycleProgressOut, DefectQualityOut,
  VersionImpactOut, ProjectPortfolioOut, PageOut,
} from '../../types'

// SRS section 11 -- the 5 Test Management reporting views. Each report is a
// read-only aggregate served by test_reports.py; RPT-002 "counts shall link
// to the filtered underlying records" is satisfied by every grouped row
// carrying enough identifying detail (project/cycle/test case key,
// requirement, status) to find the matching rows yourself in Repository/
// Execution -- this page intentionally stays a pure aggregate dashboard
// rather than re-implementing those list views' filtering here too.
type ReportTab = 'health' | 'cycle-progress' | 'defects' | 'version-impact' | 'portfolio'

const TABS: { id: ReportTab; label: string; scope: 'project' | 'cycle' | 'none' }[] = [
  { id: 'health', label: 'Repository Health', scope: 'project' },
  { id: 'cycle-progress', label: 'Cycle Progress', scope: 'cycle' },
  { id: 'defects', label: 'Defect Quality', scope: 'project' },
  { id: 'version-impact', label: 'Version Impact', scope: 'project' },
  { id: 'portfolio', label: 'Project Portfolio', scope: 'none' },
]

// A simple horizontal-bar breakdown -- used for every "counts by X" group
// across all 5 reports rather than a charting library, matching how
// Dashboard.tsx's own summary tiles favor plain styled bars/numbers over a
// chart dependency.
function CountBars({ rows, total }: { rows: { key: string; count: number }[]; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="tm-report-bars">
      {rows.length === 0 && <p className="muted small">No data.</p>}
      {rows.map((row) => (
        <div className="tm-report-bar-row" key={row.key}>
          <span className="tm-report-bar-label">{row.key}</span>
          <div className="tm-report-bar-track"><div className="tm-report-bar-fill" style={{ width: `${(row.count / max) * 100}%` }} /></div>
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

const PAGE_SIZE = 25

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
    <div>
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

function CycleProgressPanel({ projectId }: { projectId: number }) {
  const [cycles, setCycles] = useState<TestCycleOut[]>([])
  const [cycleId, setCycleId] = useState<number | ''>('')
  const [data, setData] = useState<CycleProgressOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    setCycleId(''); setData(null)
    // SRS 7.2 pagination rollout -- Page[T] wrapper (task #82); page_size=100
    // + .items since this picker still wants the complete list.
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
    <div>
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
        <div>
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

function DefectQualityPanel({ projectId }: { projectId: number }) {
  const [data, setData] = useState<DefectQualityOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    setData(null)
    api.get<DefectQualityOut>(`/api/test-reports/projects/${projectId}/defect-quality`).then(setData).catch(setError)
  }, [projectId])
  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <PopulationNote text={data.population_note} />
      <div className="tm-report-stats-row">
        <StatCard label="Total defect links" value={data.total_defect_links} />
        <StatCard label="Retest success rate" value={`${data.retest_success_rate_pct}%`} />
      </div>
      <div className="tm-report-grid">
        <div><h4>By Module</h4><CountBars rows={data.by_module} total={data.total_defect_links} /></div>
        <div><h4>By Defect Status</h4><CountBars rows={data.by_status} total={data.total_defect_links} /></div>
      </div>
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
    <div>
      <PopulationNote text={data.population_note} />
      <div className="tm-report-stats-row">
        <StatCard label="Cycles with stale items" value={data.cycles_with_stale_items} />
      </div>
      <table className="simple-table">
        <thead><tr><th>Cycle</th><th>Status</th><th>Stale Items</th><th>Upgradeable</th><th>Permanently Pinned</th></tr></thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.cycle_id}>
              <td>{item.cycle_key}</td>
              <td><Badge status={item.cycle_status} /></td>
              <td>{item.stale_item_count}</td>
              <td>{item.upgradeable_count}</td>
              <td>{item.permanently_pinned_count}</td>
            </tr>
          ))}
          {data.items.length === 0 && <tr><td colSpan={5} className="muted">No cycles currently carry a stale pinned version.</td></tr>}
        </tbody>
      </table>
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
    <div>
      <PopulationNote text={data.population_note} />
      <div className="tm-report-stats-row">
        <StatCard label="Active projects" value={data.active_project_count} />
        <StatCard label="Inactive projects" value={data.inactive_project_count} />
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

export default function TestReports() {
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [projectId, setProjectId] = useState<number | ''>('')
  const [tab, setTab] = useState<ReportTab>('health')
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      // SRS 7.2 pagination rollout -- Page[T] wrapper (task #82);
      // page_size=100 + .items since this picker still wants the complete
      // list.
      const p = await api.get<PageOut<TestProjectOut>>('/api/test-projects?page_size=100').then((page) => page.items)
      setProjects(p)
      if (p.length) setProjectId(p[0].id)
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  const activeTab = useMemo(() => TABS.find((t) => t.id === tab)!, [tab])

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        title="Test Reports"
        subtitle="Repository health, cycle progress, defect quality, version impact, and portfolio -- SRS section 11."
      />
      <div className="pill-tabs" style={{ marginBottom: 14, flexWrap: 'wrap' }} aria-label="Report views">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {activeTab.scope !== 'none' && (
        <div style={{ maxWidth: 420, marginBottom: 16 }}>
          <Field label="Project">
            <SearchableSelect
              value={projectId === '' ? '' : String(projectId)}
              onChange={(v) => setProjectId(v ? Number(v) : '')}
              placeholder={projects.length ? 'Select a project...' : 'No Test Projects yet'}
              options={projects.map((p) => ({ value: String(p.id), label: `${p.project_key} · ${p.name}` }))}
            />
          </Field>
        </div>
      )}
      {activeTab.scope !== 'none' && !projectId && <p className="muted">Select a project to view this report.</p>}
      {activeTab.scope === 'none' && <ProjectPortfolioPanel />}
      {projectId && tab === 'health' && <RepositoryHealthPanel projectId={projectId} />}
      {projectId && tab === 'cycle-progress' && <CycleProgressPanel projectId={projectId} />}
      {projectId && tab === 'defects' && <DefectQualityPanel projectId={projectId} />}
      {projectId && tab === 'version-impact' && <VersionImpactPanel projectId={projectId} />}
    </div>
  )
}
