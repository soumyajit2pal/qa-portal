import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@qa-portal/shared/api'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import { Card, MetricCard, BarChart, Table, Badge, ErrorText, PageHeader, TableColumn } from '@qa-portal/shared/components/Common'
import {
  IconGrid, IconWarning, IconApprove, IconArrowRight, IconWorkflow, IconCheckCircle,
} from '@qa-portal/shared/components/Icons'
import {
  GATEWAY_TERMINAL_STATUSES, QA_TERMINAL_STATUSES, SAST_DAST_TERMINAL_STATUSES,
  AUTOMATION_TERMINAL_STATUSES, PERFORMANCE_TERMINAL_STATUSES,
} from '@qa-portal/shared/constants'
import {
  QARequestOut, FunctionalOut, SASTOut, DASTOut, AutomationOut, PerformanceOut,
  ApprovalActionOut, ProjectWiseOut, ThreeWOut, ThreeWItem, ThreeWDetailOut,
  SecuritySastDashboard, SecurityDastDashboard, SuppressionDashboard,
} from '@qa-portal/shared/types'

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
  Automation: AUTOMATION_TERMINAL_STATUSES,
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
  Automation: '/automation',
  Performance: '/performance',
}

const DONUT_COLORS = ['#4f46e5', '#16a34a', '#d97706', '#dc2626', '#7c3aed']

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
  footline?: React.ReactNode
  spark?: Record<string, number>
  segments?: Segment[]
}

function StatCard({ icon: Icon, iconClass, tag, value, label, footline, spark, segments }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="top-row">
        <div className={`icon-chip ${iconClass}`}><Icon width={17} height={17} /></div>
        {tag && <span className="chip-tag">{tag}</span>}
      </div>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
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
  const { user } = useAuth()
  const [proj, setProj] = useState<ProjectWiseOut | null>(null)
  const [threeW, setThreeW] = useState<ThreeWOut | null>(null)
  const [requests, setRequests] = useState<QARequestOut[]>([])
  const [functionalRequests, setFunctionalRequests] = useState<FunctionalOut[]>([])
  const [sastRequests, setSastRequests] = useState<SASTOut[]>([])
  const [dastRequests, setDastRequests] = useState<DASTOut[]>([])
  const [automationRequests, setAutomationRequests] = useState<AutomationOut[]>([])
  const [performanceRequests, setPerformanceRequests] = useState<PerformanceOut[]>([])
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [govTab, setGovTab] = useState('Overview')
  const [teamFilter, setTeamFilter] = useState('')
  const [reqScope, setReqScope] = useState<'mine' | 'department'>('mine')

  useEffect(() => {
    Promise.all([
      api.get<ProjectWiseOut>('/api/dashboard/project-wise'),
      api.get<ThreeWOut>('/api/dashboard/3w'),
      api.get<QARequestOut[]>('/api/qa-requests'),
      api.get<FunctionalOut[]>('/api/functional-requests'),
      api.get<ApprovalActionOut[]>('/api/approvals'),
      api.get<SASTOut[]>('/api/sast-requests'),
      api.get<DASTOut[]>('/api/dast-requests'),
      api.get<AutomationOut[]>('/api/automation-requests'),
      api.get<PerformanceOut[]>('/api/performance-requests'),
    ]).then(([p, w, r, f, a, sast, dast, auto, perf]) => {
      setProj(p); setThreeW(w); setRequests(r); setFunctionalRequests(f); setActivity(a.slice(0, 6))
      setSastRequests(sast); setDastRequests(dast); setAutomationRequests(auto); setPerformanceRequests(perf)
    }).catch(setError)
  }, [])

  const teams = useMemo(() => threeW ? Object.keys(threeW.team_wise_distribution) : [], [threeW])
  const visibleItems = useMemo<ThreeWItem[]>(() => {
    if (!threeW) return []
    const items = teamFilter ? threeW.items.filter((i) => i.responsible_team === teamFilter) : threeW.items
    return items
  }, [threeW, teamFilter])

  // Combines the gateway + every linked child request type into one list so
  // "My Requests & My Department" below can show a single, complete picture
  // instead of six separate tables -- newest first.
  const unifiedRequests = useMemo<UnifiedRequestRow[]>(() => {
    const all = [
      ...toUnified('QA Request', requests),
      ...toUnified('Functional QA', functionalRequests),
      ...toUnified('SAST', sastRequests),
      ...toUnifiedDast(dastRequests),
      ...toUnified('Automation', automationRequests),
      ...toUnified('Performance', performanceRequests),
    ]
    return all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [requests, functionalRequests, sastRequests, dastRequests, automationRequests, performanceRequests])

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
  const myActiveCount = myRequests.filter(isActiveRequest).length

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

  const tableRows = visibleItems.slice(0, 8)

  const attentionColumns: TableColumn<ThreeWItem>[] = [
    { key: 'project_id', header: 'Project' },
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
      <div className="grid grid-4">
        <StatCard icon={IconGrid} iconClass="blue" tag="Live" value={m.active_projects} label="Active projects"
                  footline={`${nearingRelease} nearing release`} spark={proj.charts.risk_distribution} />
        <StatCard icon={IconWarning} iconClass="red" tag="Live" value={m.sast_findings + m.dast_findings} label="Open security findings"
                  footline={`${m.sast_findings} SAST · ${m.dast_findings} DAST findings open`}
                  segments={[{ label: 'SAST', value: m.sast_findings, color: '#dc2626' }, { label: 'DAST', value: m.dast_findings, color: '#f97316' }]} />
        <StatCard icon={IconApprove} iconClass="amber" tag="Action queue" value={m.pending_approvals} label="Pending approvals"
                  footline={`${criticalPending} critical`} />
        <StatCard icon={IconWorkflow} iconClass="purple" tag="Mine" value={myActiveCount} label="My active requests"
                  footline={`${myRequests.length} raised in total`} />
      </div>

      <Card
        style={{ marginTop: 18 }}
        title="My Requests & My Department"
        subtitle={`Everything raised by you or ${user?.department || 'your department'}, across every request type`}
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
        <div className="grid grid-3" style={{ marginTop: 12 }}>
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
            rows={scopedRequests.slice(0, 8)}
          />
          {scopedRequests.length === 0 && (
            <p className="muted small" style={{ marginTop: 8 }}>
              {reqScope === 'mine' ? "You haven't raised any requests yet." : 'No requests found for your department yet.'}
            </p>
          )}
          {scopedRequests.length > 8 && (
            <p className="muted small" style={{ marginTop: 8 }}>
              Showing the 8 most recent of {scopedRequests.length} — open the relevant request page for the full list.
            </p>
          )}
        </div>
      </Card>

      <Card
        style={{ marginTop: 18 }}
        title="Project Visibility & Governance"
        subtitle="Know what's pending, where, and since when"
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
                <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>{threeW.total_pending} open items</p>
                <BarChart data={threeW.team_wise_distribution} />
                <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 13.5 }}>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#2563eb', marginRight: 5 }} />Within SLA {slaWithin}</span>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#d97706', marginRight: 5 }} />Near SLA {slaNear}</span>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#dc2626', marginRight: 5 }} />Breached {slaBreached}</span>
                </div>
              </div>
              <div className="subpanel">
                <div className="subpanel-title">Ageing Distribution</div>
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
                  { key: 'project_id', header: 'Project' }, { key: 'pending_stage', header: 'Pending At' },
                  { key: 'responsible_team', header: 'Pending With' },
                  { key: 'owner', header: 'Owner' }, { key: 'ageing_days', header: 'Ageing (days)' }, { key: 'priority', header: 'Priority' },
                ])}>Download</button>
              </div>
              <Table rowKey="project_id" columns={attentionColumns} rows={tableRows} />
              {visibleItems.length > tableRows.length && (
                <p style={{ textAlign: 'center', marginTop: 10 }}>
                  <a style={{ cursor: 'pointer', color: 'var(--navy)', fontSize: 13, fontWeight: 600 }} onClick={() => setGovTab('Projects')}>
                    View all {visibleItems.length} projects &rarr;
                  </a>
                </p>
              )}
            </div>
          </>
        )}

        {govTab === 'Projects' && (
          <div style={{ marginTop: 12 }}>
            <Table rowKey="project_id" columns={[
              { key: 'project_id', header: 'Project' },
              { key: 'application_name', header: 'Application' },
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
        <Card title="Recent Activity" subtitle="Live updates from across the portal">
          <RecentActivity items={activity} />
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
      <div className="grid grid-4">
        <MetricCard label="Applications Scanned (SAST)" value={sast.applications_scanned} />
        <MetricCard label="Open Vulnerabilities" value={sast.open_vulnerabilities} />
        <MetricCard label="Scan Coverage (DAST)" value={dast.scan_coverage} />
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
        <MetricCard label="Open Suppressions" value={data.open_suppressions} />
        <MetricCard label="Critical/High Risk Exceptions" value={data.critical_high_risk_exceptions} />
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
        <MetricCard label="Total Pending Items" value={data.total_pending} />
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

export default function Dashboard() {
  const [tab, setTab] = useState('command')

  const tabs = [
    { key: 'command', label: 'Command Centre' },
    { key: 'security', label: 'Security (SAST/DAST)' },
    { key: 'suppression', label: 'Suppression' },
    { key: '3w', label: '3W Pending Items' },
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
      {tab === 'security' && <SecurityTab />}
      {tab === 'suppression' && <SuppressionTab />}
      {tab === '3w' && <ThreeWTab />}
    </div>
  )
}
