import React, { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from './api'
import { useAuth } from './context/AuthContext'
import { Card, MetricCard, BarChart, Table, Badge, ErrorText, TableColumn } from './components/Common'
import SearchableSelect from './components/SearchableSelect'
import ClearableSearchInput from './components/ClearableSearchInput'
import {
  IconGrid, IconWarning, IconApprove, IconWorkflow, IconCheckCircle,
} from './components/Icons'
import {
  GATEWAY_TERMINAL_STATUSES, QA_TERMINAL_STATUSES, SAST_DAST_TERMINAL_STATUSES,
  PERFORMANCE_TERMINAL_STATUSES,
} from './constants'
import {
  QARequestListOut, PageOut, FunctionalListOut, SASTListOut, DASTListOut, PerformanceListOut,
  ApprovalActionOut, ProjectWiseOut, ThreeWOut, ThreeWItem, ThreeWDetailOut, DashboardSummaryOut,
  SecuritySastDashboard, SecurityDastDashboard, SuppressionDashboard,
} from './types'

// A single request, whatever its underlying type, reduced to the handful of
// fields "My Requests & My Department" needs -- lets that section show one
// combined, sortable list across the QA Request gateway and every linked
// child request type instead of six separate tables.
interface UnifiedRequestRow {
  id: number
  // `id` is each row's raw primary key from its OWN source table (QARequest,
  // FunctionalRequest, SASTRequest, DASTRequest, PerformanceRequest) -- those
  // are five independent auto-increment sequences, so the same numeric id
  // can (and does) show up in more than one of them at once. `uid` below is
  // the value actually handed to <Table rowKey> so React always has a
  // globally-unique key across the merged list; `id` is kept only for
  // display/back-compat, not for keying.
  uid: string
  request_id: string
  type: string
  application_name: string
  department?: string | null
  status: string
  requester_id?: number | null
  created_at: string
  // Reported directly: "IN dashboard also show change description" --
  // delegated from the QA Request gateway on every source type this unifies
  // (see backend models.QARequest.change_description and each child
  // request's own delegated property), same as application_name/department
  // above.
  change_description?: string | null
}

function toUnified(type: string, rows: {
  id: number; request_id?: string | null; application_name?: string | null
  department?: string | null; status: string; requester_id?: number | null; created_at: string
  change_description?: string | null
}[]): UnifiedRequestRow[] {
  return rows.map((r) => ({
    // A still-Draft QA Request gateway has no request_id yet -- see the
    // backend's matching column comment -- so fall back to a stable
    // placeholder rather than showing a blank/undefined cell here.
    id: r.id, uid: `${type}-${r.id}`, request_id: r.request_id || `Draft #${r.id}`, type, application_name: r.application_name || '—',
    department: r.department, status: r.status, requester_id: r.requester_id, created_at: r.created_at,
    change_description: r.change_description,
  }))
}

// DAST previously fell back to the first scan target's URL when the
// delegated application_name wasn't set (e.g. a standalone/legacy DAST
// request with no linked QA Request) -- but `targets` isn't part of the
// lightweight PAG-005 list schema this now consumes (see DASTListOut), so
// this mapper is kept separate mainly for its own '—' fallback and type,
// not for that target-URL fallback anymore (mirrors the same simplification
// made in Suppression.tsx's selectRequest).
function toUnifiedDast(rows: DASTListOut[]): UnifiedRequestRow[] {
  return rows.map((r) => ({
    id: r.id, uid: `DAST-${r.id}`, request_id: r.request_id, type: 'DAST',
    application_name: r.application_name || '—',
    department: r.department, status: r.status, requester_id: r.requester_id, created_at: r.created_at,
    change_description: r.change_description,
  }))
}

// Each request type has its own terminal-status vocabulary (see constants.ts)
// -- reused here rather than guessing at a generic "is this closed" rule, so
// "Active" always agrees with what that type's own detail page considers open.
const TERMINAL_STATUSES_BY_TYPE: Record<string, string[]> = {
  'QA Request': GATEWAY_TERMINAL_STATUSES,
  'Functional QA': QA_TERMINAL_STATUSES,
  SAST: SAST_DAST_TERMINAL_STATUSES,
  DAST: SAST_DAST_TERMINAL_STATUSES,
  Performance: PERFORMANCE_TERMINAL_STATUSES,
}
// Reported directly: "Draft should not be seen in Active" -- a Draft is not
// yet even submitted for review, so it shouldn't count as "in progress"
// alongside genuinely in-flight requests, even though DRAFT was never in any
// type's own terminal-status list (it isn't terminal either -- it just
// hasn't started).
function isActiveRequest(row: UnifiedRequestRow): boolean {
  if (row.status === 'DRAFT') return false
  return !(TERMINAL_STATUSES_BY_TYPE[row.type] || []).includes(row.status)
}
function isTerminalRequest(row: UnifiedRequestRow): boolean {
  return (TERMINAL_STATUSES_BY_TYPE[row.type] || []).includes(row.status)
}

const TYPE_TO_PATH: Record<string, string> = {
  'QA Request': '/qa-requests',
  'Functional QA': '/functional-requests',
  SAST: '/sast',
  DAST: '/dast',
  Performance: '/performance',
}

const DONUT_COLORS = ['#4f46e5', '#16a34a', '#d97706', '#dc2626', '#7c3aed']

// "Raised" date-range filter -- reported directly ("add filter like within 1
// hr raised, 1 month, from date to to date"). Applies to whatever on-screen
// data is actually keyed by a raise/created timestamp (the "Active requests"
// stat + its footline, and Recent Activity) -- the other three At-a-Glance
// cards are backend-aggregated all-time counts (distinct applications, open
// findings, pending-approval gates) with no per-request created_at of their
// own to filter by, so they intentionally stay as-is; a note next to the
// filter says so rather than silently doing nothing.
type RaisedRangePreset = 'all' | '1h' | '3d' | '15d' | '1m' | 'custom'
interface RaisedRange {
  preset: RaisedRangePreset
  from: string
  to: string
}
const DEFAULT_RAISED_RANGE: RaisedRange = { preset: 'all', from: '', to: '' }

function rangeBounds(range: RaisedRange): { start?: Date; end?: Date } {
  if (range.preset === 'all') return {}
  if (range.preset === '1h') return { start: new Date(Date.now() - 60 * 60 * 1000), end: new Date() }
  if (range.preset === '3d') return { start: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), end: new Date() }
  if (range.preset === '15d') return { start: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), end: new Date() }
  if (range.preset === '1m') {
    const start = new Date(); start.setMonth(start.getMonth() - 1)
    return { start, end: new Date() }
  }
  const start = range.from ? new Date(`${range.from}T00:00:00`) : undefined
  const end = range.to ? new Date(`${range.to}T23:59:59.999`) : undefined
  return { start, end }
}

function rangeQuery(range: RaisedRange): string {
  const { start, end } = rangeBounds(range)
  const params = new URLSearchParams()
  if (start) params.set('date_from', start.toISOString())
  if (end) params.set('date_to', end.toISOString())
  const query = params.toString()
  return query ? `?${query}` : ''
}

function isWithinRaisedRange(dateStr: string, range: RaisedRange): boolean {
  if (range.preset === 'all') return true
  const t = new Date(dateStr).getTime()
  if (range.preset === '1h') return t >= Date.now() - 60 * 60 * 1000
  if (range.preset === '3d') return t >= Date.now() - 3 * 24 * 60 * 60 * 1000
  if (range.preset === '15d') return t >= Date.now() - 15 * 24 * 60 * 60 * 1000
  if (range.preset === '1m') {
    const oneMonthAgo = new Date()
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1)
    return t >= oneMonthAgo.getTime()
  }
  // custom
  if (range.from && t < new Date(range.from).getTime()) return false
  if (range.to) {
    const toEnd = new Date(range.to)
    toEnd.setHours(23, 59, 59, 999)
    if (t > toEnd.getTime()) return false
  }
  return true
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const mins = Math.max(1, Math.round(diffMs / 60000))
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}

function downloadCsv<T extends Record<string, any>>(filename: string, rows: T[], columns: { key: string; header: string }[]) {
  const header = columns.map((c) => c.header).join(',')
  const lines = rows.map((r) => columns.map((c) => `"${String(r[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
  const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

function Sparkline({ values }: { values?: Record<string, number> | null }) {
  const entries = Object.entries(values || {})
  if (entries.length === 0) return null
  const max = Math.max(1, ...entries.map(([, v]) => v))
  const riskColors: Record<string, string> = {
    critical: '#c9363e',
    high: '#e66a24',
    medium: '#d2a91e',
    low: '#2f8a57',
  }
  return (
    <div className="sparkline">
      {entries.map(([k, v]) => (
        <div
          key={k}
          className={`bar ${v > 0 ? 'filled' : ''}`}
          style={{
            height: `${Math.max(10, (v / max) * 100)}%`,
            ...(v > 0 ? { background: riskColors[k.trim().toLowerCase()] || '#16788b' } : {}),
          }}
          title={`${k}: ${v}`}
        />
      ))}
    </div>
  )
}

interface Segment {
  label: string
  value: number
  color: string
}

function SegmentBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  return (
    <div className="segment-bar">
      {segments.filter((s) => s.value > 0).map((s) => (
        <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
      ))}
      {total === 0 && <div style={{ width: '100%', background: '#eef0f3' }} />}
    </div>
  )
}

interface StatCardProps {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  iconClass: string
  tag?: string
  value: React.ReactNode
  label: React.ReactNode
  // One plain-English line describing exactly what's being counted --
  // reported directly ("what is Active Projects, what is pending Approval,
  // what is Active requests") -- these four numbers each use a different
  // scope/definition under the hood (distinct project epics vs. individual
  // requests vs. specific approval-gate statuses), so they were never meant
  // to add up to each other -- without this line there was nothing on
  // screen saying so. Displayed through the accessible information control
  // so cards stay compact without losing the metric definition.
  hint?: React.ReactNode
  footline?: React.ReactNode
  spark?: Record<string, number>
  segments?: Segment[]
}

function StatCard({ icon: Icon, iconClass, tag, value, label, hint, footline, spark, segments }: StatCardProps) {
  return (
    <div className={`stat-card stat-card-${iconClass}`}>
      <div className="top-row">
        <div className={`icon-chip ${iconClass}`}><Icon width={17} height={17} /></div>
        <div className="stat-card-meta">
          {tag && <span className="chip-tag">{tag}</span>}
          {(hint || footline) && (
            <span className="stat-card-info">
              <button type="button" aria-label={`About ${String(label)}`}>i</button>
              <span className="stat-card-tooltip" role="tooltip">
                {hint && <span>{hint}</span>}
                {footline && <small>{footline}</small>}
              </span>
            </span>
          )}
        </div>
      </div>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {spark && <Sparkline values={spark} />}
      {segments && <SegmentBar segments={segments} />}
    </div>
  )
}

function Donut({ data, size = 128 }: { data?: Record<string, number> | null; size?: number }) {
  const entries = Object.entries(data || {}).filter(([, v]) => v > 0)
  const total = entries.reduce((s, [, v]) => s + v, 0)
  let acc = 0
  const stops = entries.map(([, v], i) => {
    const start = (acc / (total || 1)) * 360
    acc += v
    const end = (acc / (total || 1)) * 360
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${start}deg ${end}deg`
  })
  const bg = total > 0 ? `conic-gradient(${stops.join(', ')})` : '#eef0f3'
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ background: bg, width: size, height: size }}>
        <div className="donut-center">
          <span className="num">{total}</span>
          <span className="lbl">pending</span>
        </div>
      </div>
      <div className="donut-legend">
        {entries.map(([label, v], i) => (
          <div className="row" key={label}>
            <span><span className="dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />{label}</span>
            <strong>{v}</strong>
          </div>
        ))}
        {entries.length === 0 && <span className="muted small">No pending items.</span>}
      </div>
    </div>
  )
}

// The actual Functional Request lifecycle. Counts below are mutually
// exclusive current-stage counts, not a cumulative "has reached this point"
// funnel; that distinction keeps the numbers consistent with the widget's
// "current workflow stage" description.
const LIFECYCLE_STAGES = [
  { key: 'request', label: 'Requester' },
  { key: 'sm-approval', label: 'SM Approval' },
  { key: 'department-head-approval', label: 'Department Head Approval' },
  { key: 'qa-activity', label: 'QA Activity' },
  { key: 'signoff', label: 'Sign-off' },
  { key: 'closed', label: 'Closed' },
]

const STATUS_STAGE_INDEX: Record<string, number> = {
  DRAFT: 0, RETURNED_BY_SM: 0, SM_REJECTED: 0,
  RETURNED_BY_DEPARTMENT_HEAD: 0, RETURNED_BY_QA_LEAD: 0,
  SUBMITTED: 1, SM_APPROVAL_PENDING: 1,
  DEPARTMENT_HEAD_APPROVAL_PENDING: 2, DEPARTMENT_HEAD_REJECTED: 2,
  QA_LEAD_ASSIGNED: 3, READINESS_VERIFICATION: 3, QA_ACTIVITY_INITIATED: 3,
  PLANNING: 3, TESTER_ASSIGNED: 3, TEST_DESIGN: 3, EXECUTION_IN_PROGRESS: 3,
  DEFECT_RAISED: 3, WAITING_FOR_FIX: 3, RETESTING: 3, QA_COMPLETED: 3,
  QA_SIGNOFF_PENDING: 4, QA_SIGNED_OFF: 4, REQUESTER_VERIFICATION: 4,
  CLOSED: 5,
}

// DSH-001..004 -- takes a raw per-status count dict (Functional Testing
// Requests -- see FunctionalOut; the QA Request gateway itself only has
// Draft/Submitted/Raised/Cancelled, see constants.GATEWAY_STATUSES) rather
// than the full row list this used to filter/count client-side. CANCELLED
// is excluded the same way it always was (it also never appears in
// STATUS_STAGE_INDEX, so this filter is belt-and-suspenders, not load-
// bearing).
function lifecycleDistribution(statusCounts: Record<string, number>) {
  const eligible = Object.entries(statusCounts).filter(([status]) => status !== 'CANCELLED')
  return LIFECYCLE_STAGES.map((stage, i) => {
    const count = eligible.reduce((sum, [status, c]) => sum + (STATUS_STAGE_INDEX[status] === i ? c : 0), 0)
    return { ...stage, count }
  })
}

// Fed with Functional Testing Requests' per-status counts (see
// DashboardSummaryOut.functional_status_counts) rather than full rows.
function LifecycleStepper({ statusCounts }: { statusCounts: Record<string, number> }) {
  const distribution = lifecycleDistribution(statusCounts)
  const total = distribution.reduce((sum, stage) => sum + stage.count, 0)
  return (
    <div className="lifecycle-distribution">
      <div className="lifecycle-distribution-summary">
        <div><span>Current portfolio</span><strong>{total}</strong></div>
        <p>Each request appears once at its current workflow stage.</p>
      </div>
      <div className="lifecycle-stage-list">
        {distribution.map((stage, index) => {
          const percentage = total ? Math.round((stage.count / total) * 100) : 0
          return <div className={`lifecycle-stage-row stage-${index}`} key={stage.key}>
            <span className="lifecycle-stage-index">{index + 1}</span>
            <div className="lifecycle-stage-copy">
              <div><strong>{stage.label}</strong><span>{percentage}%</span></div>
              <i><b style={{ width: `${percentage}%` }} /></i>
            </div>
            <strong className="lifecycle-stage-count">{stage.count}</strong>
          </div>
        })}
      </div>
      {total === 0 && <span className="muted small">No Functional requests raised yet.</span>}
    </div>
  )
}

function ACTIVITY_ICON(decision?: string | null) {
  if (decision === 'Approved' || decision === 'Completed' || decision === 'Started') return { cls: 'green', Icon: IconCheckCircle }
  if (decision === 'Rejected' || decision === 'Returned') return { cls: 'amber', Icon: IconWarning }
  return { cls: 'blue', Icon: IconApprove }
}

function RecentActivity({ items }: { items: ApprovalActionOut[] }) {
  if (items.length === 0) return <p className="muted small">No activity recorded yet.</p>
  return (
    <div>
      {items.map((a) => {
        const { cls, Icon } = ACTIVITY_ICON(a.decision)
        return (
          <div className="activity-item" key={a.id}>
            <div className={`icon-wrap ${cls}`}><Icon width={14} height={14} /></div>
            <div>
              <div className="title">{a.step_name} {a.decision?.toLowerCase()}</div>
              <div className="sub">{a.entity_type.replace('_', ' ')} #{a.entity_id} &middot; {a.actor_role || 'System'} &middot; {timeAgo(a.created_at)}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Reported directly: "lots of api calling, sometime same api calling
// multiple time". This tab used to separately fetch requests/
// functionalRequests/sastRequests/dastRequests/performanceRequests (full
// row lists, up to 5 x page_size=100) just to derive 4 numbers and a
// Functional-lifecycle breakdown client-side -- that's exactly what
// DSH-001..004's consolidated GET /api/dashboard/summary now replaces (see
// its own fetch below). The full row lists are still fetched once at the
// Dashboard level and shared across tab switches, but only MyRequestsTab
// needs them now (genuine row browsing, out of scope for this endpoint).
function CommandCentre({ range }: { range: RaisedRange }) {
  const [proj, setProj] = useState<ProjectWiseOut | null>(null)
  const [threeW, setThreeW] = useState<ThreeWOut | null>(null)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [summary, setSummary] = useState<DashboardSummaryOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [govTab, setGovTab] = useState('Overview')
  // Reported directly: "Dashboard is too much of details and tracker." The
  // 3W governance card below is the densest thing on the default landing
  // tab -- a tabbed chart/donut/filter-toolbar/table tracker -- so it now
  // starts collapsed, showing only the card's own KPI strip (4 numbers) plus
  // a toggle, instead of dumping the full tracker in front of every visitor
  // by default. Nothing removed, just deferred behind one click.
  const [govExpanded, setGovExpanded] = useState(false)
  const [teamFilter, setTeamFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [ageingFilter, setAgeingFilter] = useState('')
  const [governanceSearch, setGovernanceSearch] = useState('')

  useEffect(() => {
    const query = rangeQuery(range)
    Promise.all([
      // project-wise/3w are only ever fetched by this Command Centre tab, so
      // their own department scoping (see backend dashboard_department_scope)
      // is applied unconditionally server-side -- no flag needed here.
      api.get<ProjectWiseOut>(`/api/dashboard/project-wise${query}`),
      api.get<ThreeWOut>(`/api/dashboard/3w${query}`),
      // /api/approvals also feeds the separate Approval Workflow Log page
      // (see modules/governance/Approvals.tsx) -- both now apply the same
      // department scoping unconditionally server-side (reported directly:
      // "Approval Workflow log ... everything also by department only"), so
      // no flag is needed here any more.
      api.get<ApprovalActionOut[]>(`/api/approvals${query}`),
      // DSH-001..004 -- replaces this tab's own client-side derivation of
      // active/nearing-release/critical-pending counts and the Functional
      // lifecycle breakdown from 4-5 fully-fetched request collections (see
      // dashboard.py::dashboard_summary's own docstring for exactly which
      // numbers respect date_from/date_to vs. stay all-time).
      api.get<DashboardSummaryOut>(`/api/dashboard/summary${query}`),
    ]).then(([p, w, a, s]) => {
      setProj(p); setThreeW(w); setActivity(a); setSummary(s)
    }).catch(setError)
  }, [range])

  const teams = useMemo(() => threeW ? Object.keys(threeW.team_wise_distribution) : [], [threeW])
  const priorities = useMemo(() => threeW
    ? Array.from(new Set(threeW.items.map((i) => i.priority).filter((p): p is string => !!p)))
    : [], [threeW])
  const visibleItems = useMemo<ThreeWItem[]>(() => {
    if (!threeW) return []
    const query = governanceSearch.trim().toLowerCase()
    return threeW.items.filter((i) => (
      (!teamFilter || i.responsible_team === teamFilter)
      && (!priorityFilter || i.priority === priorityFilter)
      && (!ageingFilter || i.ageing_bucket === ageingFilter)
      && (!query || [i.project_id, i.application_name, i.department, i.pending_stage, i.pending_with, i.owner, i.source]
        .some((value) => String(value || '').toLowerCase().includes(query)))
    ))
  }, [threeW, teamFilter, priorityFilter, ageingFilter, governanceSearch])

  // Everything below this point that's keyed off a raise/created timestamp
  // -- narrowed to whatever window RaisedRangeFilter above has selected (see
  // its own comment for why the other 3 At-a-Glance cards aren't included).
  const filteredActivity = useMemo(
    () => activity.filter((a) => isWithinRaisedRange(a.created_at, range)).slice(0, 5),
    [activity, range]
  )

  if (error) return <ErrorText error={error} />
  if (!proj || !threeW || !summary) return <p className="muted">Loading...</p>

  const m = proj.metrics
  const slaWithin = threeW.items.filter((i) => i.ageing_days <= 7).length
  const slaNear = threeW.items.filter((i) => i.ageing_days > 7 && i.ageing_days <= 15).length
  const slaBreached = threeW.items.filter((i) => i.ageing_days > 15).length
  const highRiskPending = threeW.items.filter((i) => ['Critical', 'High'].includes(i.priority || '')).length
  // DSH-001..004 -- nearingRelease/criticalPending/activeRequestsCount below
  // all now come straight from the summary endpoint (see its own docstring
  // for exact query definitions) instead of being derived here from full
  // request-row collections.
  const nearingRelease = summary.nearing_release_count
  const criticalPending = summary.critical_pending_count
  const activeRequestsCount = summary.active_requests_count

  const attentionColumns: TableColumn<ThreeWItem>[] = [
    { key: 'project_id', header: 'Project' },
    { key: 'department', header: 'Department', render: (r) => r.department || '—' },
    { key: 'pending_stage', header: 'Pending At' },
    { key: 'pending_with', header: 'Pending With' },
    { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
    { key: 'ageing_days', header: 'Since', render: (r) => <span className={`ageing-pill ${r.ageing_days > 15 ? 'breached' : r.ageing_days > 7 ? 'near' : 'within'}`}>{r.ageing_days}d</span> },
    { key: 'ageing_bucket', header: 'Ageing bucket' },
    { key: 'priority', header: 'Priority', render: (r) => r.priority ? <Badge status={r.priority} /> : '—' },
  ]

  return (
    <div className="dashboard-command-centre">
      <div className="dashboard-section-head">
        <div><span>Live portfolio</span><h3>What needs attention</h3></div>
      </div>
      <div className="grid grid-4 dashboard-metric-grid">
        <StatCard icon={IconGrid} iconClass="blue" tag="Live" value={m.active_projects} label="Active projects"
                  hint="Applications currently moving through functional QA."
                  footline={`${nearingRelease} nearing release`} spark={proj.charts.risk_distribution} />
        <StatCard icon={IconWarning} iconClass="red" tag="Live" value={m.sast_findings + m.dast_findings} label="Open security findings"
                  hint="Unresolved SAST and DAST findings."
                  footline={`${m.sast_findings} SAST · ${m.dast_findings} DAST findings open`}
                  segments={[{ label: 'SAST', value: m.sast_findings, color: '#dc2626' }, { label: 'DAST', value: m.dast_findings, color: '#f97316' }]} />
        <StatCard icon={IconApprove} iconClass="amber" tag={criticalPending ? `${criticalPending} critical` : 'Needs attention'} value={m.pending_approvals} label="Waiting for a decision"
                  hint="Requests paused until the responsible approver completes the current workflow step."
                  footline="Open the relevant request module to approve, return, or reject." />
        <StatCard icon={IconWorkflow} iconClass="purple" tag="Live" value={activeRequestsCount} label="Active requests (org-wide)"
                  hint={range.preset === 'all'
                    ? 'Open Functional, SAST, DAST, and Performance child requests.'
                    : 'Open child requests raised within the selected period.'}
                  footline={`${summary.child_requests_total} exact child request${summary.child_requests_total === 1 ? '' : 's'}${range.preset === 'all' ? ' across all departments' : ' in the selected range'}`} />
      </div>

      <Card
        style={{ marginTop: 18 }}
        title="3W project governance"
        subtitle="What is pending, where it is pending, and since when."
        right={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {govExpanded && (
              <div className="pill-tabs">
                {['Overview', 'Projects', 'Ageing'].map((t) => (
                  <button key={t} className={govTab === t ? 'active' : ''} onClick={() => setGovTab(t)}>{t}</button>
                ))}
              </div>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setGovExpanded((v) => !v)}>
              {govExpanded ? 'Hide details' : 'Show details'}
            </button>
          </div>
        )}
      >
        <div className="governance-kpis">
          <div><small>Total pending</small><strong>{threeW.total_pending}</strong><span>Across all workflows</span></div>
          <div><small>SLA breached</small><strong className={slaBreached ? 'danger' : ''}>{slaBreached}</strong><span>Pending over 15 days</span></div>
          <div><small>Critical / high</small><strong className={highRiskPending ? 'warning' : ''}>{highRiskPending}</strong><span>Priority items requiring focus</span></div>
          <div><small>Owning teams</small><strong>{teams.length}</strong><span>Teams with pending work</span></div>
        </div>
        {!govExpanded && (
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            {threeW.total_pending} pending item{threeW.total_pending !== 1 ? 's' : ''} across {teams.length} team{teams.length !== 1 ? 's' : ''} --
            click "Show details" for the breakdown, ageing, and full list.
          </p>
        )}
        {govExpanded && govTab === 'Overview' && (
          <>
            <div className="grid grid-2 governance-chart-grid" style={{ marginTop: 12 }}>
              <div className="subpanel">
                <div className="subpanel-title">Pending by Team</div>
                <BarChart data={threeW.team_wise_distribution} />
                <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 13.5 }}>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#2563eb', marginRight: 5 }} />Within SLA {slaWithin}</span>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#d97706', marginRight: 5 }} />Near SLA {slaNear}</span>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#dc2626', marginRight: 5 }} />Breached {slaBreached}</span>
                </div>
                <p className="muted small" style={{ marginTop: 8 }}>
                  SLA bands: 0-7 days = within SLA, 8-15 = near SLA, 16+ = breached (based on days since last update).
                </p>
              </div>
              <div className="subpanel">
                <div className="subpanel-title">Ageing Distribution</div>
                <Donut data={threeW.ageing_bucket_distribution} />
              </div>
            </div>

            <div className="subpanel" style={{ marginTop: 16 }}>
              <div className="toolbar governance-toolbar" style={{ marginBottom: 10 }}>
                <div>
                  <div className="subpanel-title" style={{ marginBottom: 2 }}>Projects Requiring Attention</div>
                  <p className="muted small" style={{ margin: 0 }}>{visibleItems.length} of {threeW.total_pending} items · oldest first</p>
                </div>
                <div className="spacer" />
                <ClearableSearchInput className="governance-search" value={governanceSearch} onChange={(e) => setGovernanceSearch(e.target.value)} onClear={() => setGovernanceSearch('')} clearLabel="Clear pending item search" wrapperClassName="governance-search-wrap" placeholder="Search project, application, owner…" aria-label="Search pending items" />
                <SearchableSelect
                  value={teamFilter}
                  onChange={setTeamFilter}
                  style={{ minWidth: 160 }}
                  options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t, label: t }))]}
                />
                <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
                  <option value="">All priorities</option>
                  {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <select value={ageingFilter} onChange={(e) => setAgeingFilter(e.target.value)}>
                  <option value="">All ageing</option>
                  {Object.keys(threeW.ageing_bucket_distribution).map((bucket) => <option key={bucket} value={bucket}>{bucket}</option>)}
                </select>
                <button className="btn btn-sm" onClick={() => downloadCsv('projects_requiring_attention.csv', visibleItems, [
                  { key: 'project_id', header: 'Project' }, { key: 'department', header: 'Department' },
                  { key: 'pending_stage', header: 'Pending At' },
                  { key: 'pending_with', header: 'Pending With' },
                  { key: 'owner', header: 'Owner' }, { key: 'ageing_days', header: 'Ageing (days)' }, { key: 'priority', header: 'Priority' },
                ])}>Export CSV</button>
              </div>
              {/* Used to cap at 8 rows with a "View all" link out to the
                  Projects tab -- the Table itself now paginates (5/page,
                  see components/Common.tsx), so every row is reachable
                  right here and that link is no longer needed. */}
              <Table rowKey="project_id" columns={attentionColumns} rows={visibleItems} />
            </div>
          </>
        )}

        {govExpanded && govTab === 'Projects' && (
          <div style={{ marginTop: 12 }}>
            <div className="governance-filter-strip">
              <ClearableSearchInput value={governanceSearch} onChange={(e) => setGovernanceSearch(e.target.value)} onClear={() => setGovernanceSearch('')} clearLabel="Clear project search" wrapperClassName="search-grow" placeholder="Search project, application, owner…" />
              <SearchableSelect
                value={teamFilter}
                onChange={setTeamFilter}
                style={{ minWidth: 160 }}
                options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t, label: t }))]}
              />
              <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}><option value="">All priorities</option>{priorities.map((p) => <option key={p}>{p}</option>)}</select>
              <span>{visibleItems.length} result{visibleItems.length !== 1 ? 's' : ''}</span>
            </div>
            <Table rowKey="project_id" columns={[
              { key: 'project_id', header: 'Project' },
              { key: 'application_name', header: 'Application' },
              { key: 'department', header: 'Department', render: (r) => r.department || '—' },
              { key: 'pending_stage', header: 'Pending At' },
              { key: 'responsible_team', header: 'Team', render: (r) => r.responsible_team || r.department || '—' },
              { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
              { key: 'ageing_days', header: 'Ageing', render: (r) => <span className={`ageing-pill ${r.ageing_days > 15 ? 'breached' : r.ageing_days > 7 ? 'near' : 'within'}`}>{r.ageing_days}d</span> },
              { key: 'priority', header: 'Priority', render: (r) => r.priority ? <Badge status={r.priority} /> : '—' },
            ]} rows={visibleItems} />
          </div>
        )}

        {govExpanded && govTab === 'Ageing' && (
          <div className="subpanel" style={{ marginTop: 12 }}>
            <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
              All {threeW.total_pending} open item{threeW.total_pending !== 1 ? 's' : ''} (Functional, SAST, DAST, Performance & Suppression,
              excluding Drafts and Closed/Cancelled), grouped by days since last update.
            </p>
            <Donut data={threeW.ageing_bucket_distribution} size={160} />
          </div>
        )}
      </Card>

      <div className="dashboard-section-head dashboard-lower-head"><div><span>Delivery flow</span><h3>Lifecycle and activity</h3></div></div>
      <div className="grid grid-2 dashboard-lower-grid">
        <Card
          title="QA Lifecycle Health"
          subtitle="Functional requests by current workflow stage"
        >
          <LifecycleStepper statusCounts={summary.functional_status_counts} />
        </Card>
        <Card title="Recent Activity" subtitle={range.preset === 'all' ? 'Live updates from across the portal' : 'Activity within the selected reporting period'}>
          <RecentActivity items={filteredActivity} />
        </Card>
      </div>
    </div>
  )
}

function SecurityTab({ range }: { range: RaisedRange }) {
  const [sast, setSast] = useState<SecuritySastDashboard | null>(null)
  const [dast, setDast] = useState<SecurityDastDashboard | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    const query = rangeQuery(range)
    Promise.all([api.get<SecuritySastDashboard>(`/api/dashboard/security/sast${query}`), api.get<SecurityDastDashboard>(`/api/dashboard/security/dast${query}`)])
      .then(([s, d]) => { setSast(s); setDast(d) }).catch(setError)
  }, [range])
  if (error) return <ErrorText error={error} />
  if (!sast || !dast) return <p className="muted">Loading...</p>
  return (
    <div>
      <div className="section-title">SAST</div>
      <div className="grid grid-3">
        <MetricCard label="SAST Requests Raised" value={sast.total_requests} hint="Every SAST request ever raised, in any status." />
        <MetricCard label="Applications Scanned" value={sast.applications_scanned} hint="Distinct applications whose SAST request has reached Report Ready or Closed." />
        <MetricCard label="Open Vulnerabilities" value={sast.open_vulnerabilities} hint="SAST findings still marked Open." />
      </div>
      <div className="section-title" style={{ marginTop: 16 }}>DAST</div>
      <div className="grid grid-2">
        <MetricCard label="DAST Requests Raised" value={dast.total_requests} hint="Every DAST request ever raised, in any status." />
        {/* Only counts requests that actually finished scanning
            (REPORT_READY/CLOSED) -- see security_dast in dashboard.py --
            not every DAST request ever raised, so a pile of Draft/pending
            requests doesn't inflate this number. */}
        <MetricCard label="Scan Coverage (Scanned Applications)" value={dast.scan_coverage}
                    hint="Distinct application URLs whose DAST request has reached Report Ready or Closed." />
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="SAST Severity Distribution"><BarChart data={sast.severity_distribution} /></Card>
        <Card title="DAST Vulnerability Trends"><BarChart data={dast.vulnerability_trends} /></Card>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="SAST Remediation Status" subtitle="Current disposition of identified findings"><BarChart data={sast.remediation_status} /></Card>
        <Card title="DAST Compliance Status" subtitle="Requests by workflow and compliance state"><BarChart data={dast.compliance_status} /></Card>
      </div>
    </div>
  )
}

function SuppressionTab({ range }: { range: RaisedRange }) {
  const [data, setData] = useState<SuppressionDashboard | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => { api.get<SuppressionDashboard>(`/api/dashboard/suppression${rangeQuery(range)}`).then(setData).catch(setError) }, [range])
  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading...</p>
  return (
    <div>
      <div className="grid grid-4">
        <MetricCard label="Open Suppressions" value={data.open_suppressions} hint="Suppression requests not yet Done, Rejected, or otherwise closed out." />
        <MetricCard label="Critical/High Risk Exceptions" value={data.critical_high_risk_exceptions}
                    hint="Of those open suppressions, how many cover at least one Critical or High severity finding." />
      </div>
      <Card title="Status Breakdown" style={{ marginTop: 16 }}><BarChart data={data.status_breakdown} /></Card>
    </div>
  )
}

function ThreeWTab({ range }: { range: RaisedRange }) {
  const [data, setData] = useState<ThreeWOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [detail, setDetail] = useState<ThreeWDetailOut | null>(null)

  useEffect(() => { api.get<ThreeWOut>(`/api/dashboard/3w${rangeQuery(range)}`).then(setData).catch(setError) }, [range])

  async function openProject(projectId: string) {
    try { setDetail(await api.get<ThreeWDetailOut>(`/api/dashboard/3w/${projectId}`)) } catch (err) { setError(err) }
  }

  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading...</p>

  return (
    <div>
      <p className="muted small">
        "Know What Is Pending, Where It Is Pending, and Since When" — real-time visibility into pending QA
        documents, approvals, reviews and sign-offs across all teams. Click a Project ID to drill into its
        lifecycle.
      </p>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <MetricCard label="Total Pending Items" value={data.total_pending}
                    hint="Open QA, SAST, DAST & Suppression requests -- excludes Drafts and anything already Closed/Cancelled." />
      </div>
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Card title="Team-wise Distribution"><BarChart data={data.team_wise_distribution} /></Card>
        <Card title="Ageing Buckets"><BarChart data={data.ageing_bucket_distribution} /></Card>
        <Card title="Priority Distribution"><BarChart data={data.priority_distribution} /></Card>
      </div>
      <Card title="Pending Items">
        <Table
          rowKey="project_id"
          onRowClick={(r) => openProject(r.project_id)}
          columns={[
            { key: 'project_id', header: 'Project / Request ID' },
            { key: 'application_name', header: 'Application' },
            { key: 'department', header: 'Department', render: (r) => r.department || '—' },
            { key: 'pending_stage', header: 'Pending Stage' },
            { key: 'responsible_team', header: 'Responsible Team' },
            { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
            { key: 'ageing_days', header: 'Ageing', render: (r) => <span className={`ageing-pill ${r.ageing_days > 15 ? 'breached' : r.ageing_days > 7 ? 'near' : 'within'}`}>{r.ageing_days}d</span> },
            { key: 'priority', header: 'Priority', render: (r) => r.priority ? <Badge status={r.priority} /> : '—' },
            { key: 'source', header: 'Source' },
          ]}
          rows={data.items}
        />
      </Card>
      {detail && (
        <Card title={`Lifecycle — ${detail.project_id || ''}`}>
          {detail.detail ? <p className="muted">{detail.detail}</p> : (
            <>
              <p><strong>Application:</strong> {detail.application_name} &nbsp; <strong>Status:</strong> <Badge status={detail.status} /> &nbsp; <strong>Ageing:</strong> {detail.ageing_days} days</p>
              <div className="section-title">Lifecycle / Audit Trail</div>
              <Table rowKey="at" columns={[
                { key: 'step', header: 'Step' },
                { key: 'decision', header: 'Decision' },
                { key: 'actor_role', header: 'Role' },
                { key: 'at', header: 'When', render: (r) => new Date(r.at).toLocaleString() },
              ]} rows={detail.lifecycle} />
              <div className="section-title">Readiness Checklist</div>
              <ul className="small">
                {detail.readiness_checklist.map((c, i) => (
                  <li key={i}>{c.complete ? '✅' : '⬜️'} {c.item} — {c.owner}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
    </div>
  )
}

// Own dedicated tab (not a card mixed into Dashboard) so the main
// dashboard always shows the whole portal's data, and this personal/
// department-scoped view is a deliberate, separate destination instead of
// something narrowing the default landing view.
//
// Reported directly (live undercount, not just "lots of API calling"): this
// used to take the same 5 department-wide, page_size=100-capped request
// lists CommandCentre fetched and filter them client-side down to "mine"
// (requester_id === user.id) / "my department". That silently dropped a
// user's own older requests once their department's *total* volume for a
// single request type crossed 100 rows -- the client-side filter was
// narrowing an already-truncated page 1, not the user's actual complete
// history. DSH-001..004 removed CommandCentre's need for these lists
// entirely (it now uses /api/dashboard/summary), so there's no longer
// anything to share a hoisted fetch with -- this tab now owns two
// independently server-scoped fetches instead: `requester_id=<me>` for "My
// Requests" and `department=<mine>` for "My Department" (see
// qa_requests.py/functional.py/sast_dast.py/performance.py's new
// requester_id param). Both are still capped at page_size=100 per request
// type, but that's now a defensible "one person's, or one department's,
// total lifetime volume of a single request type" ceiling -- the same class
// of accepted compromise as MyExecutions.tsx's assignment=mine or Pending
// Approvals' bounded personal queue -- instead of resting on an unrelated
// org-wide page 1.
function MyRequestsTab({ range }: { range: RaisedRange }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [reqScope, setReqScope] = useState<'mine' | 'department'>('mine')
  const [myRequests, setMyRequests] = useState<UnifiedRequestRow[]>([])
  const [departmentRequests, setDepartmentRequests] = useState<UnifiedRequestRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // 2026-08 "one user can be on multiple departments" CR -- "My department"
  // now means the UNION across every department this user belongs to, not
  // just their primary one.
  const myDepartments = user?.departments && user.departments.length
    ? user.departments : (user?.department ? [user.department] : [])

  useEffect(() => {
    if (!user?.id) return
    setLoaded(false)
    function fetchUnified(extraQuery: string): Promise<UnifiedRequestRow[]> {
      return Promise.all([
        api.get<PageOut<QARequestListOut>>(`/api/qa-requests?${extraQuery}&page_size=100`).then((p) => p.items),
        api.get<PageOut<FunctionalListOut>>(`/api/functional-requests?${extraQuery}&page_size=100`).then((p) => p.items),
        api.get<PageOut<SASTListOut>>(`/api/sast-requests?${extraQuery}&page_size=100`).then((p) => p.items),
        api.get<PageOut<DASTListOut>>(`/api/dast-requests?${extraQuery}&page_size=100`).then((p) => p.items),
        api.get<PageOut<PerformanceListOut>>(`/api/performance-requests?${extraQuery}&page_size=100`).then((p) => p.items),
      ]).then(([r, f, sast, dast, perf]) => {
        const all = [
          ...toUnified('QA Request', r),
          ...toUnified('Functional QA', f),
          ...toUnified('SAST', sast),
          ...toUnifiedDast(dast),
          ...toUnified('Performance', perf),
        ]
        return all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      })
    }
    // `apply_department_filter` is still a single-value equality filter on
    // the backend, a deliberate per-request search/narrow control -- see its
    // own list_requests docstring -- so this fetches once per department and
    // merges/dedupes client-side rather than widening that filter's own
    // semantics.
    Promise.all([
      fetchUnified(`requester_id=${user.id}`),
      // A user with no department mapped (rare -- e.g. some executive
      // accounts) has no meaningful "my department" set; skip the fetch
      // rather than asking the backend for department="" (which would 400/
      // filter to nothing useful, not "no department").
      myDepartments.length
        ? Promise.all(myDepartments.map((dept) => fetchUnified(`department=${encodeURIComponent(dept)}`)))
          .then((batches) => {
            const seen = new Set<string>()
            const merged: UnifiedRequestRow[] = []
            for (const batch of batches) {
              for (const row of batch) {
                if (seen.has(row.uid)) continue
                seen.add(row.uid)
                merged.push(row)
              }
            }
            return merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          })
        : Promise.resolve([]),
    ]).then(([mine, department]) => {
      setMyRequests(mine); setDepartmentRequests(department); setLoaded(true)
    }).catch(setError)
  }, [user?.id, user?.department, user?.departments])

  const filteredMyRequests = myRequests.filter((r) => isWithinRaisedRange(r.created_at, range))
  const filteredDepartmentRequests = departmentRequests.filter((r) => isWithinRaisedRange(r.created_at, range))
  const scopedRequests = reqScope === 'mine' ? filteredMyRequests : filteredDepartmentRequests
  const scopedActiveCount = scopedRequests.filter(isActiveRequest).length
  // Computed the same way as isActiveRequest's own terminal-status check
  // (not just "total minus active") so a Draft request -- neither active nor
  // terminal now that Draft is excluded from Active above -- isn't
  // miscounted as "Closed / cancelled" either; it still counts toward Total
  // requests, just not toward either of the other two cards.
  const scopedTerminalCount = scopedRequests.filter(isTerminalRequest).length

  if (error) return <ErrorText error={error} />
  if (!loaded) return <p className="muted">Loading...</p>

  return (
    <div>
      <p className="muted small">
        Everything raised by you, or by {myDepartments.length ? myDepartments.join(', ') : 'your department'}, across every request type — QA
        Request, Functional QA, SAST, DAST and Performance.
      </p>
      <Card
        right={(
          <div className="pill-tabs">
            <button className={reqScope === 'mine' ? 'active' : ''} onClick={() => setReqScope('mine')}>
              My Requests ({filteredMyRequests.length})
            </button>
            <button className={reqScope === 'department' ? 'active' : ''} onClick={() => setReqScope('department')}>
              {myDepartments.length ? myDepartments.join(', ') : 'My Department'} ({filteredDepartmentRequests.length})
            </button>
          </div>
        )}
      >
        <div className="grid grid-3">
          <StatCard icon={IconGrid} iconClass="blue" value={scopedRequests.length} label="Total requests" />
          <StatCard icon={IconWorkflow} iconClass="purple" value={scopedActiveCount} label="Active / in progress" />
          <StatCard icon={IconCheckCircle} iconClass="amber" value={scopedTerminalCount} label="Closed / cancelled" />
        </div>

        <div style={{ marginTop: 18 }}>
          <Table
            rowKey="uid"
            onRowClick={(r) => navigate(TYPE_TO_PATH[r.type] || '/qa-requests')}
            columns={[
              { key: 'type', header: 'Type' },
              { key: 'request_id', header: 'Request ID' },
              { key: 'application_name', header: 'Application' },
              {
                key: 'change_description',
                header: 'Change Description',
                render: (r) => (
                  <span className="truncate-cell" title={r.change_description || ''}>
                    {r.change_description || '—'}
                  </span>
                ),
                filterValue: (r) => r.change_description || '',
              },
              { key: 'department', header: 'Department', render: (r) => r.department || '—' },
              { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
              { key: 'created_at', header: 'Raised', render: (r) => timeAgo(r.created_at) },
            ]}
            rows={scopedRequests}
          />
          {scopedRequests.length === 0 && (
            <p className="muted small" style={{ marginTop: 8 }}>
              {reqScope === 'mine' ? "You haven't raised any requests yet." : 'No requests found for your department yet.'}
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

interface TesterWorkloadRow {
  tester_id: number
  tester_name: string
  department: string
  role_label: string
  status_counts: Record<string, number>
  source_counts: Record<'Functional' | 'Performance' | 'SAST' | 'DAST', number>
  total_pending: number
  occupied_points: number
  occupancy_percent: number
  available_percent: number
  occupancy_band: 'Available' | 'Light' | 'Balanced' | 'High' | 'Full' | 'Overloaded'
  queued_count: number
  active_count: number
  waiting_count: number
  near_complete_count: number
  assignments: TesterAssignment[]
  testcases_created: number
  testcases_draft: number
  recommendation_pending: number
  qa_lead_approval_pending: number
  testcases_approved: number
  defects_raised: number
  retests_performed: number
  executions_completed: number
  projects_worked: number
  project_names: string[]
  current_execution_assignments: number
  last_activity?: string | null
  total_contributions: number
}

interface TesterAssignment {
  request_id: string
  request_pk: number
  source: 'Functional' | 'Performance' | 'SAST' | 'DAST'
  application_name: string
  status: string
  updated_at: string
  is_current: boolean
}

interface TesterWorkloadOut {
  statuses: string[]
  rows: TesterWorkloadRow[]
  total_pending: number
  testers_with_pending: number
  capacity_points: number
  average_occupancy: number
  available_testers: number
  highly_occupied_testers: number
  overloaded_testers: number
  contribution_summary: TesterContributionSummary
}

interface TesterContributionSummary {
  active_contributors: number
  testcases_created: number
  testcases_draft: number
  recommendation_pending: number
  qa_lead_approval_pending: number
  testcases_approved: number
  defects_raised: number
  retests_performed: number
  executions_completed: number
  projects_covered: number
}

interface TesterContributionActivity {
  activity_id: string
  activity_type: 'Defect Raised' | 'Defect Retested' | 'Execution Attempt'
  record_key: string
  description: string
  status: string
  activity_at: string
  project_id?: number | null
  project_key?: string | null
  project_name?: string | null
  route: string
}

interface TesterCurrentAssignment {
  record_key: string
  cycle_key: string
  cycle_status: string
  execution_status: string
  assigned_at?: string | null
  project_id: number
  project_key: string
  project_name: string
  route: string
}

interface TesterContributionProject {
  project_id: number
  project_key: string
  project_name: string
  activity_types: string[]
  last_activity?: string | null
}

interface TesterContributionDetail {
  tester_id: number
  tester_name: string
  period: { date_from?: string | null; date_to?: string | null }
  activities: TesterContributionActivity[]
  current_assignments: TesterCurrentAssignment[]
  projects: TesterContributionProject[]
  detail_limit: number
}

type TesterContributionDetailView = 'Defects' | 'Retests' | 'Executions' | 'Projects' | 'Current Assignments'

// QA-team-only capacity view. Aggregation and permission
// enforcement both live on /api/dashboard/qa-tester-workload; the client
// gate below is for navigation clarity, not the sole security boundary.
function TesterOverviewTab() {
  const navigate = useNavigate()
  const [range, setRange] = useState<RaisedRange>({ preset: '1m', from: '', to: '' })
  const [workload, setWorkload] = useState<TesterWorkloadOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [view, setView] = useState<'contribution' | 'capacity'>('contribution')
  const [selectedCapacityTesterId, setSelectedCapacityTesterId] = useState<number | null>(null)
  const [contributionDetail, setContributionDetail] = useState<TesterContributionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailView, setDetailView] = useState<TesterContributionDetailView>('Defects')
  const [testerFilterId, setTesterFilterId] = useState('')
  const [departmentFilter, setDepartmentFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [exportingContribution, setExportingContribution] = useState(false)

  useEffect(() => {
    // Keep the previous dashboard visible while a custom period is being
    // entered; do not accidentally issue an unbounded all-time query when
    // only one of the two mandatory dates is present.
    if (range.preset === 'custom' && (!range.from || !range.to)) return
    setWorkload(null); setError(null)
    setContributionDetail(null)
    api.get<TesterWorkloadOut>(`/api/dashboard/qa-tester-workload${rangeQuery(range)}`)
      .then(setWorkload).catch(setError)
  }, [range])

  if (error) return <ErrorText error={error} />
  if (!workload) return <p className="muted">Loading QA tester workload…</p>

  async function openContribution(row: TesterWorkloadRow, target?: TesterContributionDetailView) {
    const resolvedTarget = target
      || (row.defects_raised ? 'Defects'
        : row.retests_performed ? 'Retests'
          : row.executions_completed ? 'Executions'
            : row.projects_worked ? 'Projects' : 'Current Assignments')
    setDetailView(resolvedTarget)
    setDetailLoading(true)
    setError(null)
    try {
      const query = rangeQuery(range)
      setContributionDetail(await api.get<TesterContributionDetail>(
        `/api/dashboard/qa-tester-contribution/${row.tester_id}${query}${query ? '&' : '?'}limit=200`,
      ))
    } catch (err) {
      setError(err)
    } finally {
      setDetailLoading(false)
    }
  }

  const capacityColumns: TableColumn<TesterWorkloadRow>[] = [
    {
      key: 'tester_name', header: 'QA Tester',
      render: (row) => <div className="tester-capacity-person"><strong>{row.tester_name}</strong><span>{row.role_label} · {row.department}</span></div>,
    },
    {
      key: 'occupancy_percent', header: 'Occupancy',
      render: (row) => (
        <div className={`tester-occupancy tester-occupancy-${row.occupancy_band.toLowerCase()}`}>
          <div><strong>{row.occupancy_percent}%</strong><span>{row.occupancy_band}</span></div>
          <div className="tester-occupancy-track"><i style={{ width: `${Math.min(100, row.occupancy_percent)}%` }} /></div>
          <small>{row.occupied_points} of {workload.capacity_points} capacity points</small>
        </div>
      ),
      filterValue: (row) => `${row.occupancy_percent} ${row.occupancy_band}`,
    },
    {
      key: 'total_pending', header: 'Assigned',
      render: (row) => <strong className={row.total_pending ? 'tester-workload-total' : 'muted'}>{row.total_pending}</strong>,
    },
    { key: 'active_count', header: 'Active Work', render: (row) => <span className={`tester-workload-count ${row.active_count ? 'has-work' : ''}`}>{row.active_count}</span> },
    { key: 'queued_count', header: 'Queued', render: (row) => <span className={`tester-workload-count ${row.queued_count ? 'has-work' : ''}`}>{row.queued_count}</span> },
    { key: 'waiting_count', header: 'Waiting / Blocked', render: (row) => <span className={`tester-workload-count ${row.waiting_count ? 'is-waiting' : ''}`}>{row.waiting_count}</span> },
    { key: 'near_complete_count', header: 'Near Complete', render: (row) => <span className={`tester-workload-count ${row.near_complete_count ? 'is-complete' : ''}`}>{row.near_complete_count}</span> },
    {
      key: 'work_mix', header: 'Work Mix',
      render: (row) => (
        <div className="tester-work-mix">
          <span>Functional <strong>{row.source_counts.Functional || 0}</strong></span>
          <span>Performance <strong>{row.source_counts.Performance || 0}</strong></span>
          <span>SAST <strong>{row.source_counts.SAST || 0}</strong></span>
          <span>DAST <strong>{row.source_counts.DAST || 0}</strong></span>
        </div>
      ),
      filterValue: (row) => `Functional ${row.source_counts.Functional || 0} Performance ${row.source_counts.Performance || 0} SAST ${row.source_counts.SAST || 0} DAST ${row.source_counts.DAST || 0}`,
    },
    {
      key: 'available_percent', header: 'Available Capacity',
      render: (row) => <strong className={row.available_percent > 0 ? 'tester-available-capacity' : 'tester-no-capacity'}>{row.available_percent}%</strong>,
    },
  ]

  const contributionColumns: TableColumn<TesterWorkloadRow>[] = [
    {
      key: 'tester_name', header: 'QA Tester',
      render: (row) => <div className="tester-capacity-person"><strong>{row.tester_name}</strong><span>{row.role_label} · {row.department}</span></div>,
    },
    { key: 'testcases_created', header: 'Test Cases Created', render: (row) => <strong>{row.testcases_created}</strong> },
    { key: 'testcases_draft', header: 'Draft Test Cases', render: (row) => <strong className={row.testcases_draft ? 'tester-draft-count' : 'muted'}>{row.testcases_draft}</strong> },
    { key: 'recommendation_pending', header: 'Recommendation Pending', render: (row) => <strong className={row.recommendation_pending ? 'tester-pending-count' : 'muted'}>{row.recommendation_pending}</strong> },
    { key: 'qa_lead_approval_pending', header: 'QA Lead Approval Pending', render: (row) => <strong className={row.qa_lead_approval_pending ? 'tester-pending-count is-qa-lead' : 'muted'}>{row.qa_lead_approval_pending}</strong> },
    { key: 'testcases_approved', header: 'Approved Test Cases', render: (row) => <strong className={row.testcases_approved ? 'tester-approved-count' : 'muted'}>{row.testcases_approved}</strong> },
    { key: 'defects_raised', header: 'Defects Raised', render: (row) => <button className="tester-metric-link danger" disabled={!row.defects_raised} onClick={(event) => { event.stopPropagation(); openContribution(row, 'Defects') }}>{row.defects_raised}</button> },
    { key: 'retests_performed', header: 'Retests', render: (row) => <button className="tester-metric-link warning" disabled={!row.retests_performed} onClick={(event) => { event.stopPropagation(); openContribution(row, 'Retests') }}>{row.retests_performed}</button> },
    { key: 'executions_completed', header: 'Execution Attempts', render: (row) => <button className="tester-metric-link" disabled={!row.executions_completed} onClick={(event) => { event.stopPropagation(); openContribution(row, 'Executions') }}>{row.executions_completed}</button> },
    { key: 'projects_worked', header: 'Projects Worked On', render: (row) => <button className="tester-metric-link success" disabled={!row.projects_worked} title={row.project_names.join('\n')} onClick={(event) => { event.stopPropagation(); openContribution(row, 'Projects') }}>{row.projects_worked}</button>, filterValue: (row) => row.project_names.join(' ') },
    { key: 'current_execution_assignments', header: 'Current Assignments', render: (row) => <button className="tester-metric-link" disabled={!row.current_execution_assignments} onClick={(event) => { event.stopPropagation(); openContribution(row, 'Current Assignments') }}>{row.current_execution_assignments}</button> },
    { key: 'last_activity', header: 'Last Activity', render: (row) => row.last_activity ? new Date(row.last_activity).toLocaleString() : <span className="muted">No activity in period</span> },
  ]

  const departments = Array.from(new Set(workload.rows.map((row) => row.department).filter((value) => value && value !== '—'))).sort()
  const projects = Array.from(new Set(workload.rows.flatMap((row) => row.project_names))).sort()
  const filteredRows = workload.rows.filter((row) => (
    (!testerFilterId || row.tester_id === Number(testerFilterId))
    && (!departmentFilter || row.department.includes(departmentFilter))
    && (!projectFilter || row.project_names.includes(projectFilter))
  ))
  const filteredSummary: TesterContributionSummary = {
    active_contributors: filteredRows.filter((row) => row.total_contributions > 0).length,
    testcases_created: filteredRows.reduce((sum, row) => sum + row.testcases_created, 0),
    testcases_draft: filteredRows.reduce((sum, row) => sum + row.testcases_draft, 0),
    recommendation_pending: filteredRows.reduce((sum, row) => sum + row.recommendation_pending, 0),
    qa_lead_approval_pending: filteredRows.reduce((sum, row) => sum + row.qa_lead_approval_pending, 0),
    testcases_approved: filteredRows.reduce((sum, row) => sum + row.testcases_approved, 0),
    defects_raised: filteredRows.reduce((sum, row) => sum + row.defects_raised, 0),
    retests_performed: filteredRows.reduce((sum, row) => sum + row.retests_performed, 0),
    executions_completed: filteredRows.reduce((sum, row) => sum + row.executions_completed, 0),
    projects_covered: new Set(filteredRows.flatMap((row) => row.project_names)).size,
  }
  const testerContributionChart = Object.fromEntries(
    [...filteredRows].sort((a, b) => b.total_contributions - a.total_contributions).slice(0, 10)
      .map((row) => [row.tester_name, row.total_contributions]),
  )
  const projectCoverageChart = filteredRows.reduce<Record<string, number>>((result, row) => {
    row.project_names.forEach((project) => { result[project] = (result[project] || 0) + 1 })
    return result
  }, {})
  const bounds = rangeBounds(range)
  const periodLabel = range.preset === 'all' ? 'All recorded activity' : `${bounds.start?.toLocaleDateString() || 'Beginning'} – ${bounds.end?.toLocaleDateString() || 'Today'}`

  function exportContribution() {
    downloadCsv('qa-contribution-and-coverage.csv', filteredRows.map((row) => ({
      tester: row.tester_name, department: row.department,
      test_cases_created: row.testcases_created,
      draft_test_cases: row.testcases_draft,
      recommendation_pending: row.recommendation_pending,
      qa_lead_approval_pending: row.qa_lead_approval_pending,
      approved_test_cases: row.testcases_approved,
      defects_raised: row.defects_raised,
      retests_performed: row.retests_performed, execution_attempts: row.executions_completed,
      projects_worked_on: row.projects_worked, project_names: row.project_names.join('; '),
      current_assignments: row.current_execution_assignments,
      last_activity: row.last_activity ? new Date(row.last_activity).toLocaleString() : '',
      reporting_period: periodLabel,
    })), [
      { key: 'tester', header: 'QA Tester' }, { key: 'department', header: 'Department' },
      { key: 'test_cases_created', header: 'Test Cases Created' },
      { key: 'draft_test_cases', header: 'Draft Test Cases' },
      { key: 'recommendation_pending', header: 'Recommendation Pending' },
      { key: 'qa_lead_approval_pending', header: 'QA Lead Approval Pending' },
      { key: 'approved_test_cases', header: 'Approved Test Cases' },
      { key: 'defects_raised', header: 'Defects Raised' },
      { key: 'retests_performed', header: 'Retests Performed' }, { key: 'execution_attempts', header: 'Execution Attempts' },
      { key: 'projects_worked_on', header: 'Projects Worked On' }, { key: 'project_names', header: 'Project Names' },
      { key: 'current_assignments', header: 'Current Assignments' }, { key: 'last_activity', header: 'Last Activity' },
      { key: 'reporting_period', header: 'Reporting Period' },
    ])
  }

  async function exportContributionExcel() {
    setExportingContribution(true)
    setError(null)
    try {
      const { start, end } = rangeBounds(range)
      const params = new URLSearchParams()
      if (start) params.set('date_from', start.toISOString())
      if (end) params.set('date_to', end.toISOString())
      const selectedTester = workload?.rows.find((row) => row.tester_id === Number(testerFilterId))
      if (selectedTester) params.set('search', selectedTester.tester_name)
      if (departmentFilter) params.set('department', departmentFilter)
      if (projectFilter) params.set('project', projectFilter)
      await api.downloadFile(`/api/dashboard/qa-contribution-export?${params}`, 'qa-contribution-and-coverage.xlsx')
    } catch (err) {
      setError(err)
    } finally {
      setExportingContribution(false)
    }
  }

  return (
    <div className="tester-overview-tab">
      <div className="dashboard-section-head">
        <div><strong>QA Contribution & Coverage</strong><span>Evidence-based testcase, defect, retest, execution, project, and current-work tracking.</span></div>
        <Badge status="QA_LEAD_ASSIGNED" label="QA team only" />
      </div>
      <div className="pill-tabs tester-overview-modes">
        <button className={view === 'contribution' ? 'active' : ''} onClick={() => setView('contribution')}>Contribution & Coverage</button>
        <button className={view === 'capacity' ? 'active' : ''} onClick={() => setView('capacity')}>Capacity & Occupancy</button>
      </div>
      <div className="tester-period-filter" role="group" aria-label="Completed request period">
        <div><strong>Reporting period</strong><span>{periodLabel}. Current assignments always remain visible.</span></div>
        <div className="tester-period-presets">
          {([
            ['all', 'All time'], ['3d', 'Last 3 days'], ['15d', 'Last 15 days'], ['1m', 'Last month'], ['custom', 'Custom dates'],
          ] as Array<[RaisedRangePreset, string]>).map(([preset, label]) => <button key={preset} type="button" className={range.preset === preset ? 'active' : ''} onClick={() => setRange((current) => ({ ...current, preset }))}>{label}</button>)}
        </div>
        {range.preset === 'custom' && <div className="tester-custom-dates">
          <label><span>From *</span><input required type="date" value={range.from} max={range.to || undefined} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} /></label>
          <label><span>To *</span><input required type="date" value={range.to} min={range.from || undefined} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} /></label>
        </div>}
      </div>
      {view === 'contribution' && <>
      <div className="tester-contribution-filters">
        <SearchableSelect
          value={testerFilterId}
          onChange={setTesterFilterId}
          placeholder="Search QA tester…"
          options={[
            { value: '', label: 'All QA testers' },
            ...workload.rows.map((row) => ({ value: String(row.tester_id), label: `${row.tester_name} · ${row.role_label} · ${row.department}` })),
          ]}
          style={{ minWidth: 280, flex: '1 1 320px' }}
        />
        <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option value="">All departments</option>{departments.map((department) => <option key={department}>{department}</option>)}</select>
        <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">All projects</option>{projects.map((project) => <option key={project}>{project}</option>)}</select>
        <button className="btn btn-sm btn-primary" disabled={exportingContribution} onClick={exportContributionExcel}>{exportingContribution ? 'Exporting…' : 'Export Excel'}</button>
        <button className="btn btn-sm" onClick={exportContribution}>Export CSV</button>
      </div>
      <div className="tester-workload-summary tester-contribution-summary">
        <div><small>Active QA contributors</small><strong>{filteredSummary.active_contributors}</strong><span>With recorded work in this period</span></div>
        <div><small>Test cases created</small><strong>{filteredSummary.testcases_created}</strong><span>Original testcase identities, not versions</span></div>
        <div><small>Draft test cases</small><strong className={filteredSummary.testcases_draft ? 'draft' : ''}>{filteredSummary.testcases_draft}</strong><span>Created but not submitted for recommendation</span></div>
        <div><small>Recommendation pending</small><strong className={filteredSummary.recommendation_pending ? 'warning' : ''}>{filteredSummary.recommendation_pending}</strong><span>Awaiting reviewer recommendation</span></div>
        <div><small>QA Lead approval pending</small><strong className={filteredSummary.qa_lead_approval_pending ? 'danger' : ''}>{filteredSummary.qa_lead_approval_pending}</strong><span>Recommended and awaiting final approval</span></div>
        <div><small>Approved test cases</small><strong className={filteredSummary.testcases_approved ? 'approved' : ''}>{filteredSummary.testcases_approved}</strong><span>Completed final QA approval</span></div>
        <div><small>Defects raised</small><strong>{filteredSummary.defects_raised}</strong><span>Governed defects reported</span></div>
        <div><small>Retests performed</small><strong>{filteredSummary.retests_performed}</strong><span>Governed defect retest decisions</span></div>
        <div><small>Execution attempts</small><strong>{filteredSummary.executions_completed}</strong><span>Retained testcase run attempts</span></div>
        <div><small>Projects covered</small><strong>{filteredSummary.projects_covered}</strong><span>Distinct projects with real QA activity</span></div>
      </div>
      <div className="grid grid-2 tester-contribution-charts">
        <Card title="Contribution by tester"><BarChart data={testerContributionChart} /></Card>
        <Card title="Project coverage by QA testers"><BarChart data={projectCoverageChart} /></Card>
      </div>
      <div className="tester-metric-definition" role="note"><strong>How these figures are counted</strong><span>A testcase is counted once from its original author record; versions do not increase the count. Draft, pending, and approved figures show the current workflow stage of testcases created in the selected period. Defects use the reporter. Retests use the recorded retest tester and retest date. Projects require actual authoring, execution, defect, or retest activity. Click any number for record-level evidence.</span></div>
      <Card>
        <Table rowKey="tester_id" columns={contributionColumns} rows={filteredRows} onRowClick={(row) => openContribution(row)} />
        {!filteredRows.length && <p className="muted small" style={{ marginTop: 8 }}>No QA contribution matches the selected filters and period.</p>}
      </Card>
      {detailLoading && <p className="muted">Loading tester contribution details…</p>}
      {contributionDetail && !detailLoading && <Card title={`${contributionDetail.tester_name} · Contribution evidence`} className="tester-contribution-detail">
        <div className="pill-tabs tester-detail-tabs">
          {(['Defects', 'Retests', 'Executions', 'Projects', 'Current Assignments'] as const).map((item) => <button key={item} className={detailView === item ? 'active' : ''} onClick={() => setDetailView(item)}>{item}</button>)}
        </div>
        {detailView === 'Projects' ? <Table rowKey="project_id" rows={contributionDetail.projects} onRowClick={(project) => navigate(`/test-repository?project=${project.project_id}`)} columns={[
          { key: 'project_key', header: 'Project', render: (project) => <strong>{project.project_key}</strong> },
          { key: 'project_name', header: 'Project Name' },
          { key: 'activity_types', header: 'Contribution Types', render: (project) => project.activity_types.join(', ') },
          { key: 'last_activity', header: 'Last Activity', render: (project) => project.last_activity ? new Date(project.last_activity).toLocaleString() : '—' },
        ]} /> : detailView === 'Current Assignments' ? <Table rowKey="record_key" rows={contributionDetail.current_assignments} onRowClick={(item) => navigate(item.route)} columns={[
          { key: 'record_key', header: 'Test Case', render: (item) => <strong>{item.record_key}</strong> },
          { key: 'project_name', header: 'Project', render: (item) => `${item.project_key} — ${item.project_name}` },
          { key: 'cycle_key', header: 'Cycle' },
          { key: 'cycle_status', header: 'Cycle Status', render: (item) => <Badge status={item.cycle_status} /> },
          { key: 'execution_status', header: 'Latest Result', render: (item) => <Badge status={item.execution_status} /> },
          { key: 'assigned_at', header: 'Assigned', render: (item) => item.assigned_at ? new Date(item.assigned_at).toLocaleString() : '—' },
        ]} /> : <Table rowKey="activity_id" rows={contributionDetail.activities.filter((item) => (detailView === 'Defects' && item.activity_type === 'Defect Raised') || (detailView === 'Retests' && item.activity_type === 'Defect Retested') || (detailView === 'Executions' && item.activity_type === 'Execution Attempt'))} onRowClick={(item) => navigate(item.route)} columns={[
          { key: 'activity_type', header: 'Activity' },
          { key: 'record_key', header: 'Record ID', render: (item) => <strong>{item.record_key}</strong> },
          { key: 'project_name', header: 'Project', render: (item) => item.project_name ? `${item.project_key} — ${item.project_name}` : 'Not linked to a Test Project' },
          { key: 'description', header: 'Details' },
          { key: 'status', header: 'Status', render: (item) => <Badge status={item.status} /> },
          { key: 'activity_at', header: 'Activity Date', render: (item) => new Date(item.activity_at).toLocaleString() },
        ]} />}
        {!['Projects', 'Current Assignments'].includes(detailView) && <p className="muted small">Up to {contributionDetail.detail_limit} recent records are shown per activity category. Summary counts above always cover the complete selected period.</p>}
      </Card>}
      </>}
      {view === 'capacity' && <>
      <div className="tester-workload-summary">
        <div><small>Average team occupancy</small><strong>{workload.average_occupancy}%</strong><span>Across {workload.rows.length} active QA team members</span></div>
        <div><small>Available team members</small><strong>{workload.available_testers}</strong><span>Below 50% occupied</span></div>
        <div><small>Highly occupied</small><strong>{workload.highly_occupied_testers}</strong><span>80% occupied or higher</span></div>
        <div><small>Overloaded team members</small><strong className={workload.overloaded_testers ? 'danger' : ''}>{workload.overloaded_testers}</strong><span>Above planned capacity</span></div>
      </div>
      <div className="tester-capacity-note">
        <div><strong>How occupancy is calculated</strong>
        <span>{workload.capacity_points} points equal 100%. Active execution/scanning = 1 point; configuration/retest/baseline = 0.75; queued or remediation work = 0.5; result analysis = 0.25; waiting for fix = 0; and near-complete work = 0.05–0.15. Shared Functional or Performance requests are divided between assigned testers.</span></div>
        <a className="btn btn-sm" href="/docs/qa-tester-occupancy-guide.pdf" target="_blank" rel="noreferrer">View calculation guide</a>
      </div>
      <Card>
        <Table
          rowKey="tester_id"
          columns={capacityColumns}
          rows={workload.rows}
          onRowClick={(row) => setSelectedCapacityTesterId((current) => current === row.tester_id ? null : row.tester_id)}
        />
        {workload.rows.length === 0 && (
          <p className="muted small" style={{ marginTop: 8 }}>No active QA testers are available.</p>
        )}
      </Card>
      {selectedCapacityTesterId && (() => {
        const tester = workload.rows.find((row) => row.tester_id === selectedCapacityTesterId)
        if (!tester) return null
        const pathBySource: Record<TesterAssignment['source'], string> = { Functional: '/functional-requests', Performance: '/performance', SAST: '/sast', DAST: '/dast' }
        return <Card title={`${tester.tester_name} · Request tracking`} className="tester-assignment-ledger">
          <div className="tester-ledger-summary"><span><strong>{tester.assignments.filter((item) => item.is_current).length}</strong> currently working</span><span><strong>{tester.assignments.filter((item) => !item.is_current).length}</strong> completed in selected period</span></div>
          <Table
            tableId="qa-tester-request-ledger"
            rowKey="request_id"
            rows={tester.assignments}
            onRowClick={(assignment) => navigate(`${pathBySource[assignment.source]}?open=${assignment.request_pk}`)}
            columns={[
              { key: 'request_id', header: 'Request ID', render: (item) => <strong>{item.request_id}</strong> },
              { key: 'source', header: 'Request Type' },
              { key: 'application_name', header: 'Application' },
              { key: 'status', header: 'Status', render: (item) => <Badge status={item.status} /> },
              { key: 'work_state', header: 'Work State', render: (item) => <span className={item.is_current ? 'tester-ledger-current' : 'tester-ledger-complete'}>{item.is_current ? 'Currently working' : 'Completed'}</span> },
              { key: 'updated_at', header: 'Last Activity', render: (item) => new Date(item.updated_at).toLocaleString() },
            ]}
          />
          {!tester.assignments.length && <p className="muted small">No request assignments found for the selected period.</p>}
        </Card>
      })()}
      </>}
    </div>
  )
}

// Reported directly: the "My Requests" tab (renamed to just "Requests" --
// see below) should be hidden for these roles -- QA Engineer, QA Lead,
// Security Analyst, and the QA Executive Group (CHIEF_MANAGER_QA / AGM_QA,
// 2026-08 -- see constants.py::Role's own comment on the CHEIF_MANAGER_COE/
// AGM_COE consolidation) -- they work across every team's requests as part
// of their job, so a "requests I personally raised" view isn't relevant to
// them the way it is for a Requester/Business Analyst/SM/Department Head.
// Checked directly against `user.roles` (not the shared `hasRole` helper,
// which treats ADMIN as satisfying any role check) so an Admin who also
// happens to hold one of these roles still sees the tab, matching "Admin
// always sees everything" elsewhere in the app.
const REQUESTS_TAB_HIDDEN_ROLES = [
  'QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'CHIEF_MANAGER_QA', 'AGM_QA',
]

export default function Dashboard() {
  const { user } = useAuth()
  const [tab, setTab] = useState('command')
  const [insightTab, setInsightTab] = useState<'security' | 'suppression' | '3w'>('security')
  const range = DEFAULT_RAISED_RANGE

  const hideRequestsTab = !!user?.roles?.some((r) => REQUESTS_TAB_HIDDEN_ROLES.includes(r))
    && !user?.roles?.includes('ADMIN')
  // QA workload contains internal tester assignment information. This uses
  // a direct role check (not hasRole's Admin bypass): Admin-only accounts are
  // not QA team members and therefore must not see this restricted view.
  const showTesterOverviewTab = !!user?.roles?.some((role) => (
    ['QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'CHIEF_MANAGER_QA', 'AGM_QA'].includes(role)
  ))

  const tabs = [
    { key: 'command', label: 'Dashboard' },
    ...(hideRequestsTab ? [] : [{ key: 'my-requests', label: 'Requests' }]),
    { key: 'insights', label: 'Insights' },
    ...(showTesterOverviewTab ? [{ key: 'tester-overview', label: 'QA Tester Overview' }] : []),
  ]

  return (
    <div className="dashboard-page">
      <div className="dashboard-page-header">
        <div>
          <p>Quality operations</p>
          <h1>Dashboard</h1>
          <span>Monitor delivery health, governance, security, and team performance.</span>
        </div>
        <div className="dashboard-header-status"><i /><span><strong>Systems operational</strong><small>Live portal data</small></span></div>
      </div>
      <div className="tabs dashboard-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'command' && <CommandCentre range={range} />}
      {tab === 'my-requests' && !hideRequestsTab && <MyRequestsTab range={range} />}
      {tab === 'insights' && (
        <div className="dashboard-insights">
          <div className="dashboard-insights-head">
            <div><span>Detailed analytics</span><h2>Insights</h2><p>Open a focused view only when deeper analysis is needed.</p></div>
            <div className="pill-tabs dashboard-insight-tabs">
              <button className={insightTab === 'security' ? 'active' : ''} onClick={() => setInsightTab('security')}>Security</button>
              <button className={insightTab === 'suppression' ? 'active' : ''} onClick={() => setInsightTab('suppression')}>Suppression</button>
              <button className={insightTab === '3w' ? 'active' : ''} onClick={() => setInsightTab('3w')}>3W Pending</button>
            </div>
          </div>
          {insightTab === 'security' && <SecurityTab range={range} />}
          {insightTab === 'suppression' && <SuppressionTab range={range} />}
          {insightTab === '3w' && <ThreeWTab range={range} />}
        </div>
      )}
      {tab === 'tester-overview' && showTesterOverviewTab && <TesterOverviewTab />}
    </div>
  )
}
