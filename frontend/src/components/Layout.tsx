import React, { useEffect, useState, useCallback, ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import {
  ROLE_LABELS, GATEWAY_TERMINAL_STATUSES, QA_ACTIVE_STATUSES, SAST_DAST_TERMINAL_STATUSES,
  AUTOMATION_TERMINAL_STATUSES, PERFORMANCE_TERMINAL_STATUSES, SUPPRESSION_TERMINAL_STATUSES, hasRole,
} from '@qa-portal/shared/constants'
import { api } from '@qa-portal/shared/api'
import { QARequestOut, FunctionalOut, SASTOut, DASTOut, AutomationOut, PerformanceOut, SuppressionOut, SignOffOut, UserOut } from '@qa-portal/shared/types'
import {
  IconGrid, IconEdit, IconFolder, IconPlay, IconShield, IconTarget, IconEyeOff,
  IconCertificate, IconApprove, IconChart, IconSearch, IconWorkflow,
  IconPlus, IconCheckCircle, IconLogout, IconUsers,
} from '@qa-portal/shared/components/Icons'

interface NavCounts {
  qaRequests: number
  functional: number
  sast: number
  dast: number
  automation: number
  performance: number
  suppression: number
  signoff: number
  pendingReview: number
}

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  count?: number
}

interface NavGroup {
  label: string
  items: NavItem[]
}

// Nav items are grouped into short, labeled sections (Workspace / Security /
// Governance / Administration) rather than one long flat list -- with 8+
// destinations a flat list stops reading as a hierarchy, so grouping gives
// the sidebar a clearer information architecture.
function navGroups(counts: NavCounts, user: UserOut | null): NavGroup[] {
  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { to: '/', label: 'Command Centre', icon: IconGrid },
        { to: '/qa-requests', label: 'QA Requests', icon: IconEdit, count: counts.qaRequests },
        { to: '/functional-requests', label: 'Functional QA', icon: IconFolder, count: counts.functional },
      ],
    },
    {
      label: 'Security',
      items: [
        { to: '/sast', label: 'SAST Requests', icon: IconShield, count: counts.sast },
        { to: '/dast', label: 'DAST Requests', icon: IconTarget, count: counts.dast },
        { to: '/suppression', label: 'Suppression / False Positive', icon: IconEyeOff, count: counts.suppression },
      ],
    },
    {
      label: 'Specialized Testing',
      items: [
        { to: '/automation', label: 'Automation Testing', icon: IconPlay, count: counts.automation },
        { to: '/performance', label: 'Performance Testing', icon: IconWorkflow, count: counts.performance },
      ],
    },
    {
      label: 'Governance',
      items: [
        { to: '/signoff', label: 'QA Sign-off', icon: IconCertificate, count: counts.signoff },
        { to: '/approvals', label: 'Approval Workflow Log', icon: IconApprove },
        { to: '/reports', label: 'Reports & Export Centre', icon: IconChart },
      ],
    },
  ]
  if (hasRole(user, 'ADMIN')) {
    groups.push({
      label: 'Administration',
      items: [{ to: '/admin', label: 'Users & Access', icon: IconUsers, count: counts.pendingReview }],
    })
  }
  return groups
}

// "Open" = anything not yet in a terminal SAST/DAST state (see
// SAST_DAST_TERMINAL_STATUSES) -- computed as an exclusion rather than a
// hardcoded list of in-flight statuses so this nav badge doesn't silently
// go stale the next time the lifecycle's stage names change.
function isOpenSecurityStatus(status: string): boolean {
  return !SAST_DAST_TERMINAL_STATUSES.includes(status)
}

function initials(name?: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase()
}

export default function Layout({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [counts, setCounts] = useState<NavCounts>({
    qaRequests: 0, functional: 0, sast: 0, dast: 0, automation: 0, performance: 0, suppression: 0, signoff: 0, pendingReview: 0,
  })
  const [search, setSearch] = useState('')

  const loadCounts = useCallback(async () => {
    try {
      const [reqs, functional, sast, dast, automation, performance, suppression, signoffs] = await Promise.all([
        api.get<QARequestOut[]>('/api/qa-requests'),
        api.get<FunctionalOut[]>('/api/functional-requests'),
        api.get<SASTOut[]>('/api/sast-requests'),
        api.get<DASTOut[]>('/api/dast-requests'),
        api.get<AutomationOut[]>('/api/automation-requests'),
        api.get<PerformanceOut[]>('/api/performance-requests'),
        api.get<SuppressionOut[]>('/api/suppressions'),
        api.get<SignOffOut[]>('/api/signoffs'),
      ])
      // The QA Request gateway itself only has Draft/Submitted/Raised/
      // Cancelled (see constants.GATEWAY_STATUSES) -- "still in flight" here
      // just means "not yet Raised or Cancelled", i.e. still sitting in Draft.
      const qaRequests = reqs.filter((r) => !GATEWAY_TERMINAL_STATUSES.includes(r.status)).length
      // The real workflow (and its in-flight count) lives on the linked
      // Functional Testing Request -- see constants.QA_ACTIVE_STATUSES.
      const functionalCount = functional.filter((r) => QA_ACTIVE_STATUSES.includes(r.status)).length
      // SAST and DAST are separate nav items, each with their own badge --
      // previously these were wrongly added together into one combined
      // number and shown only on the SAST badge (so SAST's badge showed the
      // total of both, and DAST never showed one at all).
      const sastCount = sast.filter((r) => isOpenSecurityStatus(r.status)).length
      const dastCount = dast.filter((r) => isOpenSecurityStatus(r.status)).length
      // Same "not yet in a terminal state" idea, mirrored for the remaining
      // request-type nav items so every module with its own workflow gets a
      // consistent in-flight badge (previously only QA Requests/Functional
      // QA/SAST/DAST had one).
      const automationCount = automation.filter((r) => !AUTOMATION_TERMINAL_STATUSES.includes(r.status)).length
      const performanceCount = performance.filter((r) => !PERFORMANCE_TERMINAL_STATUSES.includes(r.status)).length
      const suppressionCount = suppression.filter((r) => !SUPPRESSION_TERMINAL_STATUSES.includes(r.status)).length
      // Sign-off certificates have only two states (Draft / Issued, see
      // models.SignOffCertificate) -- "open" here means still a Draft, i.e.
      // not yet issued/signed.
      const signoffCount = signoffs.filter((s) => s.status === 'Draft').length

      let pendingReview = 0
      if (hasRole(user, 'ADMIN')) {
        try {
          const allUsers = await api.get<UserOut[]>('/api/auth/users/all')
          pendingReview = allUsers.filter((u) => u.needs_role_review).length
        } catch (e) { /* ignore */ }
      }
      setCounts({
        qaRequests, functional: functionalCount, sast: sastCount, dast: dastCount,
        automation: automationCount, performance: performanceCount, suppression: suppressionCount,
        signoff: signoffCount, pendingReview,
      })
    } catch (e) { /* badges are non-critical; ignore failures */ }
  }, [user])

  useEffect(() => { loadCounts() }, [loadCounts, location.pathname])

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    // Broad search -- matches Request ID, Application Name, or Project Name
    // (see the `search` query param on GET /api/qa-requests).
    if (search.trim()) navigate(`/qa-requests?search=${encodeURIComponent(search.trim())}`)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo-mark">Q</div>
          <div>
            <h1>QualityHub</h1>
            <p>Centralized QA Portal</p>
          </div>
        </div>

        <nav>
          {navGroups(counts, user).map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="sidebar-section-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink key={item.to} to={item.to} end={item.to === '/'}
                           className={({ isActive }) => (isActive ? 'active' : '')}>
                    <Icon />
                    <span className="nav-label">{item.label}</span>
                    {typeof item.count === 'number' && item.count > 0 && (
                      <span className="nav-count">{item.count}</span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="audit-card">
            <IconCheckCircle width={16} height={16} />
            <div>
              <div className="title">Audit ready</div>
              <div className="desc">All activity is recorded with evidence and approvals.</div>
              <div className="since">Bank of Maharashtra &middot; IT Department</div>
            </div>
          </div>
          {user && (
            <div className="user-chip">
              <div className="avatar">{initials(user.full_name)}</div>
              <div className="who">
                <div className="name">{user.full_name}</div>
                <div className="role">
                  {(user.roles || []).map((r) => ROLE_LABELS[r] || r).join(' · ') || 'No role assigned'}
                </div>
              </div>
              <button onClick={logout} title="Log out"><IconLogout width={16} height={16} /></button>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <form className="search-box" onSubmit={submitSearch}>
            <IconSearch width={16} height={16} />
            <input placeholder="Search projects, requests or IDs..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <kbd>&#8984;K</kbd>
          </form>
          <div className="right-group">
            <span className="status-pill"><span className="status-dot" /> All systems operational</span>
            {/* Favorites/Help/Notifications/Apps icon buttons removed -- they
                were non-functional placeholders (no onClick handlers), so
                hidden per request rather than left as dead UI. Re-add here
                (with real handlers) if/when those features are built. */}
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/qa-requests', { state: { openNew: true } })}>
              <IconPlus width={14} height={14} /> New QA request
            </button>
          </div>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}
