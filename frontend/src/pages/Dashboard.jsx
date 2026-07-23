import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, MetricCard, BarChart, Table, Badge, ErrorText, PageHeader } from '../components/Common'
import {
  IconGrid, IconWarning, IconApprove, IconArrowRight, IconWorkflow, IconCheckCircle,
} from '../components/Icons'

const DONUT_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed']

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const mins = Math.max(1, Math.round(diffMs / 60000))
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}

function downloadCsv(filename, rows, columns) {
  const header = columns.map((c) => c.header).join(',')
  const lines = rows.map((r) => columns.map((c) => `"${String(r[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
  const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

function Sparkline({ values }) {
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

function SegmentBar({ segments }) {
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

function StatCard({ icon: Icon, iconClass, tag, value, label, footline, spark, segments }) {
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

function Donut({ data, size = 128 }) {
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

const STATUS_STAGE_INDEX = {
  DRAFT: 0, SUBMITTED: 0,
  DEPARTMENT_HEAD_APPROVAL_PENDING: 1, RETURNED_BY_DEPARTMENT_HEAD: 1, DEPARTMENT_HEAD_REJECTED: 1,
  QA_LEAD_ASSIGNED: 2, READINESS_VERIFICATION: 2, RETURNED_BY_QA_LEAD: 2,
  QA_ACTIVITY_INITIATED: 3, PLANNING: 3, TESTER_ASSIGNED: 3, TEST_DESIGN: 3, EXECUTION_IN_PROGRESS: 3,
  DEFECT_RAISED: 3, WAITING_FOR_FIX: 3, RETESTING: 3, REGRESSION_TESTING: 3, QA_COMPLETED: 3,
  QA_SIGNOFF_PENDING: 4, QA_SIGNED_OFF: 4, REQUESTER_VERIFICATION: 4, CLOSED: 4,
}

function lifecycleFunnel(requests) {
  const eligible = requests.filter((r) => r.status !== 'CANCELLED')
  return LIFECYCLE_STAGES.map((stage, i) => {
    const count = eligible.filter((r) => (STATUS_STAGE_INDEX[r.status] ?? 0) >= i).length
    return { ...stage, count }
  })
}

function LifecycleStepper({ requests }) {
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

function ACTIVITY_ICON(decision) {
  if (decision === 'Approved' || decision === 'Completed' || decision === 'Started') return { cls: 'green', Icon: IconCheckCircle }
  if (decision === 'Rejected' || decision === 'Returned') return { cls: 'amber', Icon: IconWarning }
  return { cls: 'blue', Icon: IconApprove }
}

function RecentActivity({ items }) {
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
  const [proj, setProj] = useState(null)
  const [threeW, setThreeW] = useState(null)
  const [requests, setRequests] = useState([])
  const [activity, setActivity] = useState([])
  const [error, setError] = useState(null)
  const [govTab, setGovTab] = useState('Overview')
  const [teamFilter, setTeamFilter] = useState('')

  useEffect(() => {
    Promise.all([
      api.get('/api/dashboard/project-wise'),
      api.get('/api/dashboard/3w'),
      api.get('/api/qa-requests'),
      api.get('/api/approvals'),
    ]).then(([p, w, r, a]) => {
      setProj(p); setThreeW(w); setRequests(r); setActivity(a.slice(0, 6))
    }).catch(setError)
  }, [])

  const teams = useMemo(() => threeW ? Object.keys(threeW.team_wise_distribution) : [], [threeW])
  const visibleItems = useMemo(() => {
    if (!threeW) return []
    const items = teamFilter ? threeW.items.filter((i) => i.responsible_team === teamFilter) : threeW.items
    return items
  }, [threeW, teamFilter])

  if (error) return <ErrorText error={error} />
  if (!proj || !threeW) return <p className="muted">Loading...</p>

  const m = proj.metrics
  const slaWithin = threeW.items.filter((i) => i.ageing_days <= 7).length
  const slaNear = threeW.items.filter((i) => i.ageing_days > 7 && i.ageing_days <= 15).length
  const slaBreached = threeW.items.filter((i) => i.ageing_days > 15).length
  const nearingRelease = requests.filter((r) => {
    if (!r.target_release_date) return false
    const days = (new Date(r.target_release_date) - new Date()) / 86400000
    return days >= 0 && days <= 14
  }).length
  const criticalPending = requests.filter((r) => (
    ['DEPARTMENT_HEAD_APPROVAL_PENDING', 'READINESS_VERIFICATION',
     'QA_SIGNOFF_PENDING', 'REQUESTER_VERIFICATION'].includes(r.status)
    && r.priority === 'Critical'
  )).length

  const tableRows = visibleItems.slice(0, 8)

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

      {/* "Test cases tracked" and "Open defects" stat cards removed along with
          Test Case Repository / Test Execution Management (Modules 2 & 3) --
          portal is currently focused on the QA Request module only. SAST/DAST
          findings are still surfaced via the Security dashboard tab. */}
      <div className="grid grid-3">
        <StatCard icon={IconGrid} iconClass="blue" tag="Live" value={m.active_projects} label="Active projects"
                  footline={`${nearingRelease} nearing release`} spark={proj.charts.risk_distribution} />
        <StatCard icon={IconWarning} iconClass="red" tag="Live" value={m.sast_findings + m.dast_findings} label="Open security findings"
                  footline={`${m.sast_findings} SAST · ${m.dast_findings} DAST findings open`}
                  segments={[{ label: 'SAST', value: m.sast_findings, color: '#dc2626' }, { label: 'DAST', value: m.dast_findings, color: '#f97316' }]} />
        <StatCard icon={IconApprove} iconClass="amber" tag="Action queue" value={m.pending_approvals} label="Pending approvals"
                  footline={`${criticalPending} critical`} />
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="section-title" style={{ margin: 0 }}>Project Visibility &amp; Governance</div>
            <h3 style={{ margin: '4px 0 0' }}>Know what's pending, where, and since when</h3>
          </div>
          <div className="pill-tabs">
            {['Overview', 'Projects', 'Ageing'].map((t) => (
              <button key={t} className={govTab === t ? 'active' : ''} onClick={() => setGovTab(t)}>{t}</button>
            ))}
          </div>
        </div>

        {govTab === 'Overview' && (
          <>
            <div className="grid grid-2" style={{ marginTop: 18 }}>
              <div>
                <h3 style={{ fontSize: 13.5 }}>Pending by team &middot; <span className="muted" style={{ fontWeight: 400 }}>{threeW.total_pending} open items</span></h3>
                <BarChart data={threeW.team_wise_distribution} />
                <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 12 }}>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#2563eb', marginRight: 5 }} />Within SLA {slaWithin}</span>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#d97706', marginRight: 5 }} />Near SLA {slaNear}</span>
                  <span><span className="dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#dc2626', marginRight: 5 }} />Breached {slaBreached}</span>
                </div>
              </div>
              <div>
                <h3 style={{ fontSize: 13.5 }}>Ageing distribution</h3>
                <Donut data={threeW.ageing_bucket_distribution} />
              </div>
            </div>

            <div style={{ marginTop: 22 }}>
              <div className="toolbar" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ fontSize: 13.5, margin: 0 }}>Projects requiring attention</h3>
                  <p className="muted small" style={{ margin: '2px 0 0' }}>Sorted by highest ageing and risk</p>
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
              <Table rowKey="project_id" columns={[
                { key: 'project_id', header: 'Project' },
                { key: 'pending_stage', header: 'Pending At' },
                { key: 'responsible_team', header: 'Pending With' },
                { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
                { key: 'ageing_days', header: 'Since', render: (r) => `${r.ageing_days} day${r.ageing_days !== 1 ? 's' : ''} ago` },
                { key: 'ageing_bucket', header: 'Ageing' },
                { key: 'priority', header: 'Priority' },
              ]} rows={tableRows} />
              {visibleItems.length > tableRows.length && (
                <p style={{ textAlign: 'center', marginTop: 10 }}>
                  <a style={{ cursor: 'pointer', color: 'var(--navy)', fontSize: 12.5, fontWeight: 600 }} onClick={() => setGovTab('Projects')}>
                    View all {visibleItems.length} projects &rarr;
                  </a>
                </p>
              )}
            </div>
          </>
        )}

        {govTab === 'Projects' && (
          <div style={{ marginTop: 18 }}>
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
          <div style={{ marginTop: 18 }}>
            <Donut data={threeW.ageing_bucket_distribution} size={160} />
          </div>
        )}
      </div>

      <div className="grid grid-2" style={{ marginTop: 4 }}>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>QA lifecycle health</h3>
            <a style={{ cursor: 'pointer', color: 'var(--navy)', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }} onClick={() => navigate('/qa-requests')}>
              <IconWorkflow width={14} height={14} /> View workflow
            </a>
          </div>
          <p className="muted small">Projects by current workflow stage</p>
          <LifecycleStepper requests={requests} />
        </div>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Recent activity</h3>
          </div>
          <p className="muted small">Live updates from across the portal</p>
          <RecentActivity items={activity} />
        </div>
      </div>
    </div>
  )
}

function QAWiseTab({ userId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => { api.get(`/api/dashboard/qa-wise/${userId}`).then(setData).catch(setError) }, [userId])
  if (error) return <ErrorText error={error} />
  if (!data) return <p className="muted">Loading...</p>
  const m = data.metrics
  return (
    <div>
      <div className="grid grid-4">
        <MetricCard label="Assigned Projects" value={m.assigned_projects} />
        <MetricCard label="Assigned Test Cases" value={m.assigned_test_cases} />
        <MetricCard label="Executed Cases" value={m.executed_cases} />
        <MetricCard label="Pass Rate" value={`${m.pass_rate}%`} />
        <MetricCard label="Defects Logged" value={m.defects_logged} />
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title="Test Execution Trend"><BarChart data={data.charts.test_execution_trend} /></Card>
      </div>
    </div>
  )
}

function SecurityTab() {
  const [sast, setSast] = useState(null)
  const [dast, setDast] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    Promise.all([api.get('/api/dashboard/security/sast'), api.get('/api/dashboard/security/dast')])
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
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => { api.get('/api/dashboard/suppression').then(setData).catch(setError) }, [])
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
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [detail, setDetail] = useState(null)

  useEffect(() => { api.get('/api/dashboard/3w').then(setData).catch(setError) }, [])

  async function openProject(projectId) {
    try { setDetail(await api.get(`/api/dashboard/3w/${projectId}`)) } catch (err) { setError(err) }
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
  const { user } = useAuth()
  const [tab, setTab] = useState('command')

  const tabs = [
    { key: 'command', label: 'Command Centre' },
    // "QA-wise (My Metrics)" is temporarily DISABLED per request -- it's mostly
    // TestCase/TestRunCase-based (assigned/executed test cases, pass rate),
    // consistent with Test Case Repository / Test Execution Management
    // (Modules 2 & 3) being disabled elsewhere. Re-enable by uncommenting this
    // tab entry and the matching render branch below.
    // { key: 'qa', label: 'QA-wise (My Metrics)' },
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
      {/* {tab === 'qa' && <QAWiseTab userId={user.id || 0} />} */}
      {tab === 'security' && <SecurityTab />}
      {tab === 'suppression' && <SuppressionTab />}
      {tab === '3w' && <ThreeWTab />}
    </div>
  )
}
