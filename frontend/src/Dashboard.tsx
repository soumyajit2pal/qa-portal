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
  QARequestOut, FunctionalOut, SASTOut, DASTOut, PerformanceOut,
  ApprovalActionOut, ProjectWiseOut, ThreeWOut, ThreeWItem, ThreeWDetailOut,
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
}

function toUnified(type: string, rows: {
  id: number; request_id?: string | null; application_name?: string | null
  department?: string | null; status: string; requester_id?: number | null; created_at: string
}[]): UnifiedRequestRow[] {
  return rows.map((r) => ({
    // A still-Draft QA Request gateway has no request_id yet -- see the
    // backend's matching column comment -- so fall back to a stable
    // placeholder rather than showing a blank/undefined cell here.
    id: r.id, uid: `${type}-${r.id}`, request_id: r.request_id || `Draft #${r.id}`, type, application_name: r.application_name || '—',
    department: r.department, status: r.status, requester_id: r.requester_id, created_at: r.created_at,
  }))
}

// DAST requests fall back to the first scan target's URL (see
// DASTOut.targets in types.ts) when the delegated application_name isn't
// set (e.g. a standalone/legacy DAST request with no linked QA Request) --
// given its own mapper rather than forcing it through the generic shape
// above.
function toUnifiedDast(rows: DASTOut[]): UnifiedRequestRow[] {
  return rows.map((r) => ({
    id: r.id, uid: `DAST-${r.id}`, request_id: r.request_id, type: 'DAST',
    application_name: r.application_name || r.targets?.[0]?.application_url || '—',
    department: r.department, status: r.status, requester_id: r.requester_id, created_at: r.created_at,
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
function isActiveRequest(row: UnifiedRequestRow): boolean {
  return !(TERMINAL_STATUSES_BY_TYPE[row.type] || []).includes(row.status)
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
type RaisedRangePreset = 'all' | '1h' | '1m' | 'custom'
interface RaisedRange {
  preset: RaisedRangePreset
  from: string
  to: string
}
const DEFAULT_RAISED_RANGE: RaisedRange = { preset: 'all', from: '', to: '' }

function rangeBounds(range: RaisedRange): { start?: Date; end?: Date } {
  if (range.preset === 'all') return {}
  if (range.preset === '1h') return { start: new Date(Date.now() - 60 * 60 * 1000), end: new Date() }
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
  return (
    <div className="sparkline">
      {entries.map(([k, v]) => (
        <div key={k} className={`bar ${v > 0 ? 'filled' : ''}`} style={{ height: `${Math.max(10, (v / max) * 100)}%` }} title={`${k}: ${v}`} />
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
  // screen saying so. Always visible, not a hover-only tooltip.
  hint?: React.ReactNode
  footline?: React.ReactNode
  spark?: Record<string, number>
  segments?: Segment[]
}

function StatCard({ icon: Icon, iconClass, tag, value, label, hint, footline, spark, segments }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="top-row">
        <div className={`icon-chip ${iconClass}`}><Icon width={17} height={17} /></div>
        {tag && <span className="chip-tag">{tag}</span>}
      </div>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {hint && <div className="hint">{hint}</div>}
      {footline && <div className="footline">{footline}</div>}
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

// Representative subset of the QA Request lifecycle used for the funnel
// visualization. Every status maps to one of these stage indices; CANCELLED requests
// are excluded from the funnel entirely (they never completed the lifecycle).
const LIFECYCLE_STAGES = [
  { key: 'request', label: 'Request' },
  { key: 'department-head-approval', label: 'Department Head Approval' },
  { key: 'qa-lead-readiness', label: 'QA Lead / Readiness' },
  { key: 'execution', label: 'Execution' },
  { key: 'signoff', label: 'Sign-off' },
]

const STATUS_STAGE_INDEX: Record<string, number> = {
  DRAFT: 0, SUBMITTED: 0,
  DEPARTMENT_HEAD_APPROVAL_PENDING: 1, RETURNED_BY_DEPARTMENT_HEAD: 1, DEPARTMENT_HEAD_REJECTED: 1,
  QA_LEAD_ASSIGNED: 2, READINESS_VERIFICATION: 2, RETURNED_BY_QA_LEAD: 2,
  QA_ACTIVITY_INITIATED: 3, PLANNING: 3, TESTER_ASSIGNED: 3, TEST_DESIGN: 3, EXECUTION_IN_PROGRESS: 3,
  DEFECT_RAISED: 3, WAITING_FOR_FIX: 3, RETESTING: 3, QA_COMPLETED: 3,
  QA_SIGNOFF_PENDING: 4, QA_SIGNED_OFF: 4, REQUESTER_VERIFICATION: 4, CLOSED: 4,
}

function lifecycleFunnel(requests: { status: string }[]) {
  const eligible = requests.filter((r) => r.status !== 'CANCELLED')
  return LIFECYCLE_STAGES.map((stage, i) => {
    const count = eligible.filter((r) => (STATUS_STAGE_INDEX[r.status] ?? 0) >= i).length
    return { ...stage, count }
  })
}

// Fed with Functional Testing Requests (see FunctionalOut) -- that's where
// the QAStatus lifecycle now lives; the QA Request gateway itself only has
// Draft/Submitted/Raised/Cancelled (see constants.GATEWAY_STATUSES).
function LifecycleStepper({ requests }: { requests: { status: string }[] }) {
  const funnel = lifecycleFunnel(requests)
  const maxCount = Math.max(1, ...funnel.map((f) => f.count))
  return (
    <div className="stepper">
      {funnel.map((s, i) => (
        <React.Fragment key={s.key}>
          <div className={`step ${s.count > 0 ? 'filled' : ''}`}>
            <div className="circle">{s.count}</div>
            <div className="step-label">{s.label}</div>
          </div>
          {i < funnel.length - 1 && <div className={`connector ${funnel[i + 1].count > 0 ? 'filled' : ''}`} />}
        </React.Fragment>
      ))}
      {maxCount === 0 && <span className="muted small">No QA requests raised yet.</span>}
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
// multiple time". requests/functionalRequests/sastRequests/dastRequests/
// performanceRequests used to be fetched independently here AND again in
// MyRequestsTab below -- since only one tab is ever mounted at a time
// (see Dashboard's own tab switch), toggling between the "Dashboard" and
// "Requests" tabs re-fetched all 5 full lists every single time. Lifted
// to Dashboard itself instead (fetched once, passed down as props) so
// switching tabs back and forth reuses the same data instead of
// re-requesting it.
function CommandCentre({ range, requests, functionalRequests, sastRequests, dastRequests, performanceRequests, requestsLoaded, requestsError }: {
  range: RaisedRange
  requests: QARequestOut[]
  functionalRequests: FunctionalOut[]
  sastRequests: SASTOut[]
  dastRequests: DASTOut[]
  performanceRequests: PerformanceOut[]
  requestsLoaded: boolean
  requestsError: unknown
}) {
  const [proj, setProj] = useState<ProjectWiseOut | null>(null)
  const [threeW, setThreeW] = useState<ThreeWOut | null>(null)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
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
      api.get<ProjectWiseOut>(`/api/dashboard/project-wise${query}`),
      api.get<ThreeWOut>(`/api/dashboard/3w${query}`),
      api.get<ApprovalActionOut[]>('/api/approvals'),
    ]).then(([p, w, a]) => {
      setProj(p); setThreeW(w); setActivity(a)
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
      && (!query || [i.project_id, i.application_name, i.department, i.pending_stage, i.owner, i.source]
        .some((value) => String(value || '').toLowerCase().includes(query)))
    ))
  }, [threeW, teamFilter, priorityFilter, ageingFilter, governanceSearch])

  // Combines the gateway + every linked child request type into one list --
  // org-wide, not scoped to any one user/department (that view now lives in
  // its own "My Requests" tab below, see MyRequestsTab) -- so the Command
  // Centre's own stats reflect everything happening across the whole portal.
  const unifiedRequests = useMemo<UnifiedRequestRow[]>(() => {
    const all = [
      ...toUnified('QA Request', requests),
      ...toUnified('Functional QA', functionalRequests),
      ...toUnified('SAST', sastRequests),
      ...toUnifiedDast(dastRequests),
      ...toUnified('Performance', performanceRequests),
    ]
    return all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [requests, functionalRequests, sastRequests, dastRequests, performanceRequests])

  // Everything below this point that's keyed off a raise/created timestamp
  // -- narrowed to whatever window RaisedRangeFilter above has selected (see
  // its own comment for why the other 3 At-a-Glance cards aren't included).
  const filteredUnifiedRequests = useMemo(
    () => unifiedRequests.filter((r) => isWithinRaisedRange(r.created_at, range)),
    [unifiedRequests, range]
  )
  const filteredActivity = useMemo(
    () => activity.filter((a) => isWithinRaisedRange(a.created_at, range)).slice(0, 6),
    [activity, range]
  )

  const activeRequestsCount = filteredUnifiedRequests.filter(isActiveRequest).length

  if (error || requestsError) return <ErrorText error={error || requestsError} />
  if (!proj || !threeW || !requestsLoaded) return <p className="muted">Loading...</p>

  const m = proj.metrics
  const slaWithin = threeW.items.filter((i) => i.ageing_days <= 7).length
  const slaNear = threeW.items.filter((i) => i.ageing_days > 7 && i.ageing_days <= 15).length
  const slaBreached = threeW.items.filter((i) => i.ageing_days > 15).length
  const highRiskPending = threeW.items.filter((i) => ['Critical', 'High'].includes(i.priority || '')).length
  const nearingRelease = requests.filter((r) => {
    if (!r.target_release_date) return false
    const days = (new Date(r.target_release_date).getTime() - Date.now()) / 86400000
    return days >= 0 && days <= 14
  }).length
  // Priority/workflow-stage now live on the linked Functional Testing
  // Request, not the QA Request gateway (see FunctionalOut).
  const criticalPending = functionalRequests.filter((r) => (
    ['DEPARTMENT_HEAD_APPROVAL_PENDING', 'READINESS_VERIFICATION',
     'QA_SIGNOFF_PENDING', 'REQUESTER_VERIFICATION'].includes(r.status)
    && r.priority === 'Critical'
  )).length

  const attentionColumns: TableColumn<ThreeWItem>[] = [
    { key: 'project_id', header: 'Project' },
    { key: 'department', header: 'Department', render: (r) => r.department || '—' },
    { key: 'pending_stage', header: 'Pending At' },
    { key: 'responsible_team', header: 'Pending With' },
    { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
    { key: 'ageing_days', header: 'Since', render: (r) => <span className={`ageing-pill ${r.ageing_days > 15 ? 'breached' : r.ageing_days > 7 ? 'near' : 'within'}`}>{r.ageing_days}d</span> },
    { key: 'ageing_bucket', header: 'Ageing bucket' },
    { key: 'priority', header: 'Priority', render: (r) => r.priority ? <Badge status={r.priority} /> : '—' },
  ]

  return (
    <div className="dashboard-command-centre">
      <div className="dashboard-brief">
        <div>
          <span className="dashboard-brief-kicker">Enterprise quality overview</span>
          <h2>Release governance Dashboard</h2>
          <p>Live visibility across testing, security, approvals, sign-offs, and audit readiness.</p>
        </div>
        <div className="dashboard-brief-meta">
          <span className="live-indicator"><i /> Live data</span>
          <small>Updated {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
        </div>
      </div>
      <div className="dashboard-section-head">
        <div><span>Portfolio health</span><h3>Operational pulse</h3></div>
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
                    ? 'Open QA, security, and performance requests.'
                    : 'Open requests raised within the selected period.'}
                  footline={`${filteredUnifiedRequests.length} raised in total${range.preset === 'all' ? ' across all departments' : ' in the selected range'}`} />
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
                  { key: 'responsible_team', header: 'Pending With' },
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
              { key: 'responsible_team', header: 'Team' },
              { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
              { key: 'ageing_days', header: 'Ageing', render: (r) => <span className={`ageing-pill ${r.ageing_days > 15 ? 'breached' : r.ageing_days > 7 ? 'near' : 'within'}`}>{r.ageing_days}d</span> },
              { key: 'priority', header: 'Priority', render: (r) => r.priority ? <Badge status={r.priority} /> : '—' },
            ]} rows={visibleItems} />
          </div>
        )}

        {govExpanded && govTab === 'Ageing' && (
          <div className="subpanel" style={{ marginTop: 12 }}>
            <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
              All {threeW.total_pending} open item{threeW.total_pending !== 1 ? 's' : ''} (QA, SAST, DAST & Suppression,
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
          subtitle="Projects by current workflow stage"
        >
          <LifecycleStepper requests={functionalRequests} />
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
// something narrowing the default landing view. Reported directly: "lots
// of api calling, sometime same api calling multiple time" -- this used to
// fetch its own copy of the same 5 request-type endpoints CommandCentre
// already fetches, refiring every time a visitor switched to this tab (and
// again switching back and forth). Now takes them as props from Dashboard,
// which fetches them once and shares them across whichever tab is mounted.
function MyRequestsTab({ range, requests, functionalRequests, sastRequests, dastRequests, performanceRequests, loaded, error }: {
  range: RaisedRange
  requests: QARequestOut[]
  functionalRequests: FunctionalOut[]
  sastRequests: SASTOut[]
  dastRequests: DASTOut[]
  performanceRequests: PerformanceOut[]
  loaded: boolean
  error: unknown
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [reqScope, setReqScope] = useState<'mine' | 'department'>('mine')

  const unifiedRequests = useMemo<UnifiedRequestRow[]>(() => {
    const all = [
      ...toUnified('QA Request', requests),
      ...toUnified('Functional QA', functionalRequests),
      ...toUnified('SAST', sastRequests),
      ...toUnifiedDast(dastRequests),
      ...toUnified('Performance', performanceRequests),
    ]
    return all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [requests, functionalRequests, sastRequests, dastRequests, performanceRequests])

  const myRequests = useMemo(
    () => unifiedRequests.filter((r) => !!user?.id && r.requester_id === user.id),
    [unifiedRequests, user]
  )
  const departmentRequests = useMemo(
    () => unifiedRequests.filter((r) => !!user?.department && r.department === user.department),
    [unifiedRequests, user]
  )
  const filteredMyRequests = myRequests.filter((r) => isWithinRaisedRange(r.created_at, range))
  const filteredDepartmentRequests = departmentRequests.filter((r) => isWithinRaisedRange(r.created_at, range))
  const scopedRequests = reqScope === 'mine' ? filteredMyRequests : filteredDepartmentRequests
  const scopedActiveCount = scopedRequests.filter(isActiveRequest).length

  if (error) return <ErrorText error={error} />
  if (!loaded) return <p className="muted">Loading...</p>

  return (
    <div>
      <p className="muted small">
        Everything raised by you, or by {user?.department || 'your department'}, across every request type — QA
        Request, Functional QA, SAST, DAST and Performance.
      </p>
      <Card
        right={(
          <div className="pill-tabs">
            <button className={reqScope === 'mine' ? 'active' : ''} onClick={() => setReqScope('mine')}>
              My Requests ({filteredMyRequests.length})
            </button>
            <button className={reqScope === 'department' ? 'active' : ''} onClick={() => setReqScope('department')}>
              {user?.department || 'My Department'} ({filteredDepartmentRequests.length})
            </button>
          </div>
        )}
      >
        <div className="grid grid-3">
          <StatCard icon={IconGrid} iconClass="blue" value={scopedRequests.length} label="Total requests" />
          <StatCard icon={IconWorkflow} iconClass="purple" value={scopedActiveCount} label="Active / in progress" />
          <StatCard icon={IconCheckCircle} iconClass="amber" value={scopedRequests.length - scopedActiveCount} label="Closed / cancelled" />
        </div>

        <div style={{ marginTop: 18 }}>
          <Table
            rowKey="uid"
            onRowClick={(r) => navigate(TYPE_TO_PATH[r.type] || '/qa-requests')}
            columns={[
              { key: 'type', header: 'Type' },
              { key: 'request_id', header: 'Request ID' },
              { key: 'application_name', header: 'Application' },
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
}

// QA-team-only capacity view. Aggregation and permission
// enforcement both live on /api/dashboard/qa-tester-workload; the client
// gate below is for navigation clarity, not the sole security boundary.
function TesterOverviewTab({ range }: { range: RaisedRange }) {
  const [workload, setWorkload] = useState<TesterWorkloadOut | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    setWorkload(null); setError(null)
    api.get<TesterWorkloadOut>(`/api/dashboard/qa-tester-workload${rangeQuery(range)}`)
      .then(setWorkload).catch(setError)
  }, [range])

  if (error) return <ErrorText error={error} />
  if (!workload) return <p className="muted">Loading QA tester workload…</p>

  const columns: TableColumn<TesterWorkloadRow>[] = [
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

  return (
    <div className="tester-overview-tab">
      <div className="dashboard-section-head">
        <div><strong>QA team capacity and occupancy</strong><span>Current Functional, Performance, SAST, and DAST assignments for QA Testers and Security Analysts.</span></div>
        <Badge status="QA_LEAD_ASSIGNED" label="QA team only" />
      </div>
      <div className="tester-workload-summary">
        <div><small>Average team occupancy</small><strong>{workload.average_occupancy}%</strong><span>Across {workload.rows.length} active QA team members</span></div>
        <div><small>Available team members</small><strong>{workload.available_testers}</strong><span>Below 50% occupied</span></div>
        <div><small>Highly occupied</small><strong>{workload.highly_occupied_testers}</strong><span>80% occupied or higher</span></div>
        <div><small>Overloaded team members</small><strong className={workload.overloaded_testers ? 'danger' : ''}>{workload.overloaded_testers}</strong><span>Above planned capacity</span></div>
      </div>
      <div className="tester-capacity-note">
        <strong>How occupancy is calculated</strong>
        <span>{workload.capacity_points} fully-active concurrent assignments equal 100%. Active execution/scanning = 1 point, configuration/retest/regression = 0.75, queued/defect/remediation = 0.5, waiting/result analysis = 0.25, and near-complete work = 0.05–0.15. Shared Functional or Performance requests are divided between assigned testers.</span>
      </div>
      <Card>
        <Table
          rowKey="tester_id"
          columns={columns}
          rows={workload.rows}
        />
        {workload.rows.length === 0 && (
          <p className="muted small" style={{ marginTop: 8 }}>No active QA testers are available.</p>
        )}
      </Card>
    </div>
  )
}

// Reported directly: the "My Requests" tab (renamed to just "Requests" --
// see below) should be hidden for these roles -- QA Engineer, QA Lead,
// Security Analyst, and Executive COE (DEPARTMENT_HEAD_COE_CM /
// DEPARTMENT_HEAD_COE_AGM, split 2026-08 from the single old
// DEPARTMENT_HEAD_COE role but with identical authority/visibility) --
// they work across every team's requests as part of their job, so a
// "requests I personally raised" view isn't relevant to them the way it is
// for a Requester/Business Analyst/SM/Department Head. Checked directly
// against `user.roles` (not the shared `hasRole` helper, which treats ADMIN
// as satisfying any role check) so an Admin who also happens to hold one of
// these roles still sees the tab, matching "Admin always sees everything"
// elsewhere in the app.
const REQUESTS_TAB_HIDDEN_ROLES = [
  'QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'DEPARTMENT_HEAD_COE_CM', 'DEPARTMENT_HEAD_COE_AGM',
]

export default function Dashboard() {
  const { user } = useAuth()
  const [tab, setTab] = useState('command')
  const range = DEFAULT_RAISED_RANGE

  // Shared across CommandCentre and MyRequestsTab (see each of their own
  // comments) -- fetched once here instead of separately by whichever tab
  // happens to be mounted, so switching between "Dashboard" and "Requests"
  // reuses the same data instead of re-fetching all 5 lists every time.
  const [requests, setRequests] = useState<QARequestOut[]>([])
  const [functionalRequests, setFunctionalRequests] = useState<FunctionalOut[]>([])
  const [sastRequests, setSastRequests] = useState<SASTOut[]>([])
  const [dastRequests, setDastRequests] = useState<DASTOut[]>([])
  const [performanceRequests, setPerformanceRequests] = useState<PerformanceOut[]>([])
  const [requestsLoaded, setRequestsLoaded] = useState(false)
  const [requestsError, setRequestsError] = useState<unknown>(null)

  useEffect(() => {
    Promise.all([
      api.get<QARequestOut[]>('/api/qa-requests'),
      api.get<FunctionalOut[]>('/api/functional-requests'),
      api.get<SASTOut[]>('/api/sast-requests'),
      api.get<DASTOut[]>('/api/dast-requests'),
      api.get<PerformanceOut[]>('/api/performance-requests'),
    ]).then(([r, f, sast, dast, perf]) => {
      setRequests(r); setFunctionalRequests(f)
      setSastRequests(sast); setDastRequests(dast); setPerformanceRequests(perf)
      setRequestsLoaded(true)
    }).catch(setRequestsError)
  }, [])

  const hideRequestsTab = !!user?.roles?.some((r) => REQUESTS_TAB_HIDDEN_ROLES.includes(r))
    && !user?.roles?.includes('ADMIN')
  // QA workload contains internal tester assignment information. This uses
  // a direct role check (not hasRole's Admin bypass): Admin-only accounts are
  // not QA team members and therefore must not see this restricted view.
  const showTesterOverviewTab = !!user?.roles?.some((role) => (
    ['QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'DEPARTMENT_HEAD_COE_CM', 'DEPARTMENT_HEAD_COE_AGM'].includes(role)
  ))

  const tabs = [
    { key: 'command', label: 'Dashboard' },
    ...(hideRequestsTab ? [] : [{ key: 'my-requests', label: 'Requests' }]),
    { key: 'security', label: 'Security (SAST/DAST)' },
    { key: 'suppression', label: 'Suppression' },
    { key: '3w', label: '3W Pending Items' },
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
      {tab === 'command' && (
        <CommandCentre
          range={range}
          requests={requests}
          functionalRequests={functionalRequests}
          sastRequests={sastRequests}
          dastRequests={dastRequests}
          performanceRequests={performanceRequests}
          requestsLoaded={requestsLoaded}
          requestsError={requestsError}
        />
      )}
      {tab === 'my-requests' && !hideRequestsTab && (
        <MyRequestsTab
          range={range}
          requests={requests}
          functionalRequests={functionalRequests}
          sastRequests={sastRequests}
          dastRequests={dastRequests}
          performanceRequests={performanceRequests}
          loaded={requestsLoaded}
          error={requestsError}
        />
      )}
      {tab === 'security' && <SecurityTab range={range} />}
      {tab === 'suppression' && <SuppressionTab range={range} />}
      {tab === '3w' && <ThreeWTab range={range} />}
      {tab === 'tester-overview' && showTesterOverviewTab && <TesterOverviewTab range={range} />}
    </div>
  )
}
