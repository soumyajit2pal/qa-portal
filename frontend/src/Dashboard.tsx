import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from './api'
import { useAuth } from './context/AuthContext'
import { Card, MetricCard, BarChart, Table, Badge, ErrorText, PageHeader, TableColumn } from './components/Common'
import {
  IconGrid, IconWarning, IconApprove, IconArrowRight, IconWorkflow, IconCheckCircle,
} from './components/Icons'
import {
  GATEWAY_TERMINAL_STATUSES, QA_TERMINAL_STATUSES, SAST_DAST_TERMINAL_STATUSES,
  PERFORMANCE_TERMINAL_STATUSES, hasRole,
} from './constants'
import {
  QARequestOut, FunctionalOut, SASTOut, DASTOut, PerformanceOut,
  ApprovalActionOut, ProjectWiseOut, ThreeWOut, ThreeWItem, ThreeWDetailOut,
  SecuritySastDashboard, SecurityDastDashboard, SuppressionDashboard, SignOffOut, UserOut,
} from './types'

// A single request, whatever its underlying type, reduced to the handful of
// fields "My Requests & My Department" needs -- lets that section show one
// combined, sortable list across the QA Request gateway and every linked
// child request type instead of six separate tables.
interface UnifiedRequestRow {
  id: number
  request_id: string
  type: string
  application_name: string
  department?: string | null
  status: string
  requester_id?: number | null
  created_at: string
}

function toUnified(type: string, rows: {
  id: number; request_id: string; application_name?: string | null
  department?: string | null; status: string; requester_id?: number | null; created_at: string
}[]): UnifiedRequestRow[] {
  return rows.map((r) => ({
    id: r.id, request_id: r.request_id, type, application_name: r.application_name || '—',
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
    id: r.id, request_id: r.request_id, type: 'DAST',
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

const RAISED_RANGE_PRESETS: { key: RaisedRangePreset; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: '1h', label: 'Within 1 hour' },
  { key: '1m', label: 'Within 1 month' },
  { key: 'custom', label: 'Custom range' },
]

function RaisedRangeFilter({ range, onChange }: { range: RaisedRange; onChange: (r: RaisedRange) => void }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="pill-tabs">
          {RAISED_RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              className={range.preset === p.key ? 'active' : ''}
              onClick={() => onChange({ ...range, preset: p.key })}
            >
              {p.label}
            </button>
          ))}
        </div>
        {range.preset === 'custom' && (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <label className="muted small">From <input type="date" value={range.from} onChange={(e) => onChange({ ...range, from: e.target.value })} /></label>
            <label className="muted small">To <input type="date" value={range.to} onChange={(e) => onChange({ ...range, to: e.target.value })} /></label>
          </span>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
        Filters "Active requests (org-wide)" and Recent Activity below by when they were raised. The other
        three At-a-Glance cards are all-time totals and aren't affected by this filter.
      </p>
    </div>
  )
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
  const stops = entries.map(([label, v], i) => {
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
  DEFECT_RAISED: 3, WAITING_FOR_FIX: 3, RETESTING: 3, REGRESSION_TESTING: 3, QA_COMPLETED: 3,
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

function CommandCentre() {
  const navigate = useNavigate()
  const [proj, setProj] = useState<ProjectWiseOut | null>(null)
  const [threeW, setThreeW] = useState<ThreeWOut | null>(null)
  const [requests, setRequests] = useState<QARequestOut[]>([])
  const [functionalRequests, setFunctionalRequests] = useState<FunctionalOut[]>([])
  const [sastRequests, setSastRequests] = useState<SASTOut[]>([])
  const [dastRequests, setDastRequests] = useState<DASTOut[]>([])
  const [performanceRequests, setPerformanceRequests] = useState<PerformanceOut[]>([])
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [govTab, setGovTab] = useState('Overview')
  const [teamFilter, setTeamFilter] = useState('')
  const [raisedRange, setRaisedRange] = useState<RaisedRange>(DEFAULT_RAISED_RANGE)

  useEffect(() => {
    Promise.all([
      api.get<ProjectWiseOut>('/api/dashboard/project-wise'),
      api.get<ThreeWOut>('/api/dashboard/3w'),
      api.get<QARequestOut[]>('/api/qa-requests'),
      api.get<FunctionalOut[]>('/api/functional-requests'),
      api.get<ApprovalActionOut[]>('/api/approvals'),
      api.get<SASTOut[]>('/api/sast-requests'),
      api.get<DASTOut[]>('/api/dast-requests'),
      api.get<PerformanceOut[]>('/api/performance-requests'),
    ]).then(([p, w, r, f, a, sast, dast, perf]) => {
      // Kept as the full list (not pre-sliced to 6) so the Raised filter
      // below has something to actually narrow down before RecentActivity
      // takes its top-6 slice for display.
      setProj(p); setThreeW(w); setRequests(r); setFunctionalRequests(f); setActivity(a)
      setSastRequests(sast); setDastRequests(dast); setPerformanceRequests(perf)
    }).catch(setError)
  }, [])

  const teams = useMemo(() => threeW ? Object.keys(threeW.team_wise_distribution) : [], [threeW])
  const visibleItems = useMemo<ThreeWItem[]>(() => {
    if (!threeW) return []
    const items = teamFilter ? threeW.items.filter((i) => i.responsible_team === teamFilter) : threeW.items
    return items
  }, [threeW, teamFilter])

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
    () => unifiedRequests.filter((r) => isWithinRaisedRange(r.created_at, raisedRange)),
    [unifiedRequests, raisedRange]
  )
  const filteredActivity = useMemo(
    () => activity.filter((a) => isWithinRaisedRange(a.created_at, raisedRange)).slice(0, 6),
    [activity, raisedRange]
  )

  const activeRequestsCount = filteredUnifiedRequests.filter(isActiveRequest).length

  if (error) return <ErrorText error={error} />
  if (!proj || !threeW) return <p className="muted">Loading...</p>

  const m = proj.metrics
  const slaWithin = threeW.items.filter((i) => i.ageing_days <= 7).length
  const slaNear = threeW.items.filter((i) => i.ageing_days > 7 && i.ageing_days <= 15).length
  const slaBreached = threeW.items.filter((i) => i.ageing_days > 15).length
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
    { key: 'ageing_days', header: 'Since', render: (r) => `${r.ageing_days} day${r.ageing_days !== 1 ? 's' : ''} ago` },
    { key: 'ageing_bucket', header: 'Ageing' },
    { key: 'priority', header: 'Priority' },
  ]

  return (
    <div>
      {m.pending_approvals > 0 && (
        <div className="alert-banner">
          <div className="icon-wrap"><IconWarning width={16} height={16} /></div>
          <div className="body">
            <div className="title">{m.pending_approvals} approval{m.pending_approvals > 1 ? 's' : ''} need your attention</div>
            <div className="sub">{criticalPending} critical-priority decision{criticalPending !== 1 ? 's are' : ' is'} waiting.</div>
          </div>
          <a className="action" onClick={() => navigate('/approvals')} style={{ cursor: 'pointer' }}>
            Review approvals <IconArrowRight width={14} height={14} />
          </a>
        </div>
      )}

      <div className="section-title" style={{ marginTop: m.pending_approvals > 0 ? 18 : 0 }}>At a Glance</div>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 14 }}>
        Each number below counts a different slice of the same underlying requests -- see the line under
        each card for exactly what it includes. They're not meant to add up to each other.
      </p>
      <RaisedRangeFilter range={raisedRange} onChange={setRaisedRange} />
      <div className="grid grid-4">
        <StatCard icon={IconGrid} iconClass="blue" tag="Live" value={m.active_projects} label="Active projects"
                  hint="Distinct applications with a Functional Testing request currently in progress (excludes Draft and Closed/Cancelled)."
                  footline={`${nearingRelease} nearing release`} spark={proj.charts.risk_distribution} />
        <StatCard icon={IconWarning} iconClass="red" tag="Live" value={m.sast_findings + m.dast_findings} label="Open security findings"
                  hint="SAST + DAST findings still marked Open (not yet Fixed, Accepted, or suppressed)."
                  footline={`${m.sast_findings} SAST · ${m.dast_findings} DAST findings open`}
                  segments={[{ label: 'SAST', value: m.sast_findings, color: '#dc2626' }, { label: 'DAST', value: m.dast_findings, color: '#f97316' }]} />
        <StatCard icon={IconApprove} iconClass="amber" tag="Action queue" value={m.pending_approvals} label="Pending approvals"
                  hint="Requests sitting at an SM, Department Head, or Security decision point, plus every open Suppression request."
                  footline={`${criticalPending} critical`} />
        <StatCard icon={IconWorkflow} iconClass="purple" tag="Live" value={activeRequestsCount} label="Active requests (org-wide)"
                  hint={raisedRange.preset === 'all'
                    ? 'Every request of any type (QA, Functional, SAST, DAST, Performance) not yet Closed or Cancelled.'
                    : 'Every request of any type (QA, Functional, SAST, DAST, Performance) not yet Closed or Cancelled, raised within the selected range above.'}
                  footline={`${filteredUnifiedRequests.length} raised in total${raisedRange.preset === 'all' ? ' across all departments' : ' in the selected range'}`} />
      </div>

      <Card
        style={{ marginTop: 18 }}
        title="Project Visibility & Governance"
        subtitle="Know what's pending, where, and since when -- across every open QA, SAST, DAST and Suppression request (excludes Drafts and anything already Closed/Cancelled)."
        right={(
          <div className="pill-tabs">
            {['Overview', 'Projects', 'Ageing'].map((t) => (
              <button key={t} className={govTab === t ? 'active' : ''} onClick={() => setGovTab(t)}>{t}</button>
            ))}
          </div>
        )}
      >
        {govTab === 'Overview' && (
          <>
            <div className="grid grid-2" style={{ marginTop: 12 }}>
              <div className="subpanel">
                <div className="subpanel-title">Pending by Team</div>
                <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
                  {threeW.total_pending} open item{threeW.total_pending !== 1 ? 's' : ''} awaiting action, grouped by which team currently owns them.
                </p>
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
                <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
                  The same {threeW.total_pending} open item{threeW.total_pending !== 1 ? 's' : ''} above, grouped by days since they were last updated.
                </p>
                <Donut data={threeW.ageing_bucket_distribution} />
              </div>
            </div>

            <div className="subpanel" style={{ marginTop: 16 }}>
              <div className="toolbar" style={{ marginBottom: 10 }}>
                <div>
                  <div className="subpanel-title" style={{ marginBottom: 2 }}>Projects Requiring Attention</div>
                  <p className="muted small" style={{ margin: 0 }}>Sorted by highest ageing and risk</p>
                </div>
                <div className="spacer" />
                <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
                  <option value="">All teams</option>
                  {teams.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <button className="btn btn-sm" onClick={() => downloadCsv('projects_requiring_attention.csv', visibleItems, [
                  { key: 'project_id', header: 'Project' }, { key: 'department', header: 'Department' },
                  { key: 'pending_stage', header: 'Pending At' },
                  { key: 'responsible_team', header: 'Pending With' },
                  { key: 'owner', header: 'Owner' }, { key: 'ageing_days', header: 'Ageing (days)' }, { key: 'priority', header: 'Priority' },
                ])}>Download</button>
              </div>
              {/* Used to cap at 8 rows with a "View all" link out to the
                  Projects tab -- the Table itself now paginates (5/page,
                  see components/Common.tsx), so every row is reachable
                  right here and that link is no longer needed. */}
              <Table rowKey="project_id" columns={attentionColumns} rows={visibleItems} />
            </div>
          </>
        )}

        {govTab === 'Projects' && (
          <div style={{ marginTop: 12 }}>
            <Table rowKey="project_id" columns={[
              { key: 'project_id', header: 'Project' },
              { key: 'application_name', header: 'Application' },
              { key: 'department', header: 'Department', render: (r) => r.department || '—' },
              { key: 'pending_stage', header: 'Pending At' },
              { key: 'responsible_team', header: 'Team' },
              { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
              { key: 'ageing_days', header: 'Ageing (days)' },
              { key: 'priority', header: 'Priority' },
            ]} rows={threeW.items} />
          </div>
        )}

        {govTab === 'Ageing' && (
          <div className="subpanel" style={{ marginTop: 12 }}>
            <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
              All {threeW.total_pending} open item{threeW.total_pending !== 1 ? 's' : ''} (QA, SAST, DAST & Suppression,
              excluding Drafts and Closed/Cancelled), grouped by days since last update.
            </p>
            <Donut data={threeW.ageing_bucket_distribution} size={160} />
          </div>
        )}
      </Card>

      <div className="grid grid-2" style={{ marginTop: 4 }}>
        <Card
          title="QA Lifecycle Health"
          subtitle="Projects by current workflow stage"
          right={(
            <a style={{ cursor: 'pointer', color: 'var(--navy)', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }} onClick={() => navigate('/qa-requests')}>
              <IconWorkflow width={14} height={14} /> View workflow
            </a>
          )}
        >
          <LifecycleStepper requests={functionalRequests} />
        </Card>
        <Card title="Recent Activity" subtitle={raisedRange.preset === 'all' ? 'Live updates from across the portal' : 'Live updates from across the portal, within the selected range above'}>
          <RecentActivity items={filteredActivity} />
        </Card>
      </div>
    </div>
  )
}

function SecurityTab() {
  const [sast, setSast] = useState<SecuritySastDashboard | null>(null)
  const [dast, setDast] = useState<SecurityDastDashboard | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    Promise.all([api.get<SecuritySastDashboard>('/api/dashboard/security/sast'), api.get<SecurityDastDashboard>('/api/dashboard/security/dast')])
      .then(([s, d]) => { setSast(s); setDast(d) }).catch(setError)
  }, [])
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
    </div>
  )
}

function SuppressionTab() {
  const [data, setData] = useState<SuppressionDashboard | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => { api.get<SuppressionDashboard>('/api/dashboard/suppression').then(setData).catch(setError) }, [])
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

function ThreeWTab() {
  const [data, setData] = useState<ThreeWOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [detail, setDetail] = useState<ThreeWDetailOut | null>(null)

  useEffect(() => { api.get<ThreeWOut>('/api/dashboard/3w').then(setData).catch(setError) }, [])

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
            { key: 'ageing_days', header: 'Ageing (days)' },
            { key: 'priority', header: 'Priority' },
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

// Own dedicated tab (not a card mixed into Command Centre) so the main
// dashboard always shows the whole portal's data, and this personal/
// department-scoped view is a deliberate, separate destination instead of
// something narrowing the default landing view. Fetches its own copy of the
// 6 request-type endpoints (same pattern as SecurityTab/SuppressionTab/
// ThreeWTab each fetching independently) rather than sharing CommandCentre's
// state, since only one of these tab components is ever mounted at a time.
function MyRequestsTab() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [requests, setRequests] = useState<QARequestOut[]>([])
  const [functionalRequests, setFunctionalRequests] = useState<FunctionalOut[]>([])
  const [sastRequests, setSastRequests] = useState<SASTOut[]>([])
  const [dastRequests, setDastRequests] = useState<DASTOut[]>([])
  const [performanceRequests, setPerformanceRequests] = useState<PerformanceOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loaded, setLoaded] = useState(false)
  const [reqScope, setReqScope] = useState<'mine' | 'department'>('mine')

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
      setLoaded(true)
    }).catch(setError)
  }, [])

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
  const scopedRequests = reqScope === 'mine' ? myRequests : departmentRequests
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
              My Requests ({myRequests.length})
            </button>
            <button className={reqScope === 'department' ? 'active' : ''} onClick={() => setReqScope('department')}>
              {user?.department || 'My Department'} ({departmentRequests.length})
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
            rowKey="id"
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

interface TesterOverviewRow {
  testerId: number
  testerName: string
  department: string
  totalAssigned: number
  completed: number
  pending: number
  signedOff: number
}

// Statuses at which a tester's own testing execution work is considered
// done for that request -- QA_COMPLETED onwards, regardless of how much
// further the request still has to go through sign-off/closure. Anything
// still active but earlier than this (TESTER_ASSIGNED through
// REGRESSION_TESTING) counts as still pending on the tester's plate.
const TESTER_WORK_DONE_STATUSES = ['QA_COMPLETED', 'QA_SIGNOFF_PENDING', 'QA_SIGNED_OFF', 'REQUESTER_VERIFICATION', 'CLOSED']

// Reported directly: a broad, per-tester overview -- how many requests each
// tester has completed, how many are still pending, and how many have
// reached an issued sign-off -- grouped by the tester's own department.
// Visible only to Executive COE (CM/AGM) (see the role gate in Dashboard()
// below, which is the only place this component is ever mounted).
function TesterOverviewTab() {
  const [functionalRequests, setFunctionalRequests] = useState<FunctionalOut[]>([])
  const [signoffs, setSignoffs] = useState<SignOffOut[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    Promise.all([
      api.get<FunctionalOut[]>('/api/functional-requests'),
      api.get<SignOffOut[]>('/api/signoffs'),
      api.get<UserOut[]>('/api/auth/users'),
    ]).then(([f, s, u]) => {
      setFunctionalRequests(f); setSignoffs(s); setUsers(u); setLoaded(true)
    }).catch(setError)
  }, [])

  const signoffById = useMemo(() => {
    const m = new Map<number, SignOffOut>()
    signoffs.forEach((s) => m.set(s.id, s))
    return m
  }, [signoffs])

  const rows = useMemo<TesterOverviewRow[]>(() => {
    const byTester = new Map<number, TesterOverviewRow>()
    for (const req of functionalRequests) {
      if (!req.assigned_tester_ids) continue
      const ids = req.assigned_tester_ids.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
      for (const id of ids) {
        if (!byTester.has(id)) {
          const u = users.find((x) => x.id === id)
          byTester.set(id, {
            testerId: id, testerName: u?.full_name || `User #${id}`, department: u?.department || '—',
            totalAssigned: 0, completed: 0, pending: 0, signedOff: 0,
          })
        }
        const row = byTester.get(id)!
        row.totalAssigned += 1
        if (TESTER_WORK_DONE_STATUSES.includes(req.status)) row.completed += 1
        else if (!QA_TERMINAL_STATUSES.includes(req.status)) row.pending += 1
        const so = req.signoff_id ? signoffById.get(req.signoff_id) : undefined
        if (so?.status === 'ISSUED') row.signedOff += 1
      }
    }
    return Array.from(byTester.values()).sort(
      (a, b) => a.department.localeCompare(b.department) || a.testerName.localeCompare(b.testerName)
    )
  }, [functionalRequests, users, signoffById])

  if (error) return <ErrorText error={error} />
  if (!loaded) return <p className="muted">Loading...</p>

  return (
    <div>
      <p className="muted small">
        Every tester ever assigned to a Functional QA request -- how many of those requests have finished
        testing (QA Completed or later), how many are still active on their plate, and how many have
        reached an Issued sign-off certificate. Grouped by the tester's own department.
      </p>
      <Card>
        <Table
          rowKey="testerId"
          columns={[
            { key: 'department', header: 'Department' },
            { key: 'testerName', header: 'Tester' },
            { key: 'totalAssigned', header: 'Total Assigned' },
            { key: 'completed', header: 'Completed' },
            { key: 'pending', header: 'Pending' },
            { key: 'signedOff', header: 'Signed Off' },
          ]}
          rows={rows}
        />
        {rows.length === 0 && (
          <p className="muted small" style={{ marginTop: 8 }}>No testers have been assigned to any Functional QA request yet.</p>
        )}
      </Card>
    </div>
  )
}

// Reported directly: the "My Requests" tab (renamed to just "Requests" --
// see below) should be hidden for these 4 roles -- QA Engineer, QA Lead,
// Security Analyst, and Executive COE (AGM/QA, i.e. DEPARTMENT_HEAD_COE) --
// they work across every team's requests as part of their job, so a
// "requests I personally raised" view isn't relevant to them the way it is
// for a Requester/Business Analyst/SM/Department Head. Checked directly
// against `user.roles` (not the shared `hasRole` helper, which treats ADMIN
// as satisfying any role check) so an Admin who also happens to hold one of
// these roles still sees the tab, matching "Admin always sees everything"
// elsewhere in the app.
const REQUESTS_TAB_HIDDEN_ROLES = ['QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'DEPARTMENT_HEAD_COE']

export default function Dashboard() {
  const { user } = useAuth()
  const [tab, setTab] = useState('command')
  const hideRequestsTab = !!user?.roles?.some((r) => REQUESTS_TAB_HIDDEN_ROLES.includes(r))
    && !user?.roles?.includes('ADMIN')
  // Reported directly: a broad, per-tester completed/pending/sign-off
  // overview, visible only to Executive COE (CM/AGM). Uses the shared
  // hasRole() helper here (not a direct user.roles check like
  // hideRequestsTab above) since this is a "show to X" gate, not a "hide
  // from X" one -- hasRole's ADMIN bypass is exactly the wanted behavior so
  // an Admin can see it too, matching "Admin always sees everything" as used
  // for the Administration nav group.
  const showTesterOverviewTab = hasRole(user, 'DEPARTMENT_HEAD_COE')

  const tabs = [
    { key: 'command', label: 'Command Centre' },
    ...(hideRequestsTab ? [] : [{ key: 'my-requests', label: 'Requests' }]),
    { key: 'security', label: 'Security (SAST/DAST)' },
    { key: 'suppression', label: 'Suppression' },
    { key: '3w', label: '3W Pending Items' },
    ...(showTesterOverviewTab ? [{ key: 'tester-overview', label: 'Tester Overview' }] : []),
  ]

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="A single view of what's pending, where, and since when — across QA Requests, Security and Suppression."
      />
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'command' && <CommandCentre />}
      {tab === 'my-requests' && !hideRequestsTab && <MyRequestsTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'suppression' && <SuppressionTab />}
      {tab === '3w' && <ThreeWTab />}
      {tab === 'tester-overview' && showTesterOverviewTab && <TesterOverviewTab />}
    </div>
  )
}
