import React, { useEffect, useState, useCallback, useRef, ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  ROLE_LABELS, GATEWAY_TERMINAL_STATUSES, QA_ACTIVE_STATUSES, SAST_DAST_TERMINAL_STATUSES,
  PERFORMANCE_TERMINAL_STATUSES, SUPPRESSION_TERMINAL_STATUSES, hasRole,
} from '../constants'
import { api } from '../api'
import { QARequestOut, FunctionalOut, SASTOut, DASTOut, PerformanceOut, SuppressionOut, SignOffOut, UserOut, PendingApprovalItem } from '../types'
import {
  IconGrid, IconEdit, IconFolder, IconShield, IconTarget, IconEyeOff,
  IconCertificate, IconApprove, IconChart, IconSearch, IconWorkflow,
  IconPlus, IconCheckCircle, IconLogout, IconUsers, IconApps, IconPlay, IconBell,
  IconHelp,
} from './Icons'
import ClearableSearchInput from './ClearableSearchInput'

interface NavCounts {
  qaRequests: number
  functional: number
  sast: number
  dast: number
  performance: number
  suppression: number
  signoff: number
  pendingReview: number
  pendingApprovals: number
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
      label: 'Overview',
      items: [
        { to: '/', label: 'Dashboard', icon: IconGrid },
      ],
    },
    {
      label: 'Request Management',
      items: [
        { to: '/qa-requests', label: 'QA Requests', icon: IconEdit, count: counts.qaRequests },
      ],
    },
    {
      label: 'Functional',
      items: [
        { to: '/functional-requests', label: 'Functional Requests', icon: IconFolder, count: counts.functional },
      ],
    },
    {
      label: 'Test Management',
      items: [
        { to: '/test-projects', label: 'Projects', icon: IconApps },
        { to: '/test-repository', label: 'Test Repository', icon: IconFolder },
        { to: '/test-execution', label: 'Test Execution', icon: IconPlay },
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
        { to: '/performance', label: 'Performance Testing', icon: IconWorkflow, count: counts.performance },
      ],
    },
    {
      label: 'Governance',
      items: [
        { to: '/signoff', label: 'QA Sign-off', icon: IconCertificate, count: counts.signoff },
        { to: '/pending-approvals', label: 'Pending Approvals', icon: IconBell, count: counts.pendingApprovals },
        { to: '/approvals', label: 'Approval Workflow Log', icon: IconApprove },
        { to: '/reports', label: 'Reports & Export Centre', icon: IconChart },
        ...(hasRole(user, 'ADMIN', 'DEPARTMENT_HEAD_COE_CM', 'DEPARTMENT_HEAD_COE_AGM')
          ? [{ to: '/audit-log', label: 'Audit Log', icon: IconSearch }]
          : []),
      ],
    },
    {
      label: 'Help & Support',
      items: [
        { to: '/help', label: 'Help & User Manual', icon: IconHelp },
      ],
    },
  ]
  // hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM') is also true for an Admin account (see
  // constants.ts::hasRole's own ADMIN short-circuit), so an Admin sees both
  // items below merged into the one Administration group rather than two
  // separately-labeled groups.
  const adminItems: NavItem[] = []
  if (hasRole(user, 'ADMIN')) {
    adminItems.push({ to: '/admin', label: 'Users & Access', icon: IconUsers, count: counts.pendingReview })
    adminItems.push({ to: '/checklist-config', label: 'Readiness Checklist Config', icon: IconCheckCircle })
  }
  if (hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM', 'DEPARTMENT_HEAD_COE_CM', 'DEPARTMENT_HEAD_COE_AGM')) {
    adminItems.push({ to: '/department-admin', label: 'Department Coordinator', icon: IconUsers })
  }
  if (adminItems.length > 0) {
    groups.push({ label: 'Administration', items: adminItems })
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

// Maps each request type's own ID prefix (see models.py's gen_id calls) to
// the module that owns it, for the topbar search box (submitSearch below).
// Every new business ID shares the TQA namespace and has a module segment.
// Legacy Suppression/Sign-off aliases remain searchable for records created
// before the standardized ID convention was introduced.
const ID_PREFIX_ROUTES: { prefix: string; path: string }[] = [
  { prefix: 'TQA-FUNC', path: '/functional-requests' },
  { prefix: 'TQA-SAST', path: '/sast' },
  { prefix: 'TQA-DAST', path: '/dast' },
  { prefix: 'TQA-PERF', path: '/performance' },
  { prefix: 'TQA-SUP', path: '/suppression' },
  { prefix: 'TQA-SIGN', path: '/signoff' },
  { prefix: 'TQA-PROJ', path: '/test-projects' },
  { prefix: 'TQA-TC', path: '/test-repository' },
  { prefix: 'TQA-CYCLE', path: '/test-execution' },
  { prefix: 'SUP', path: '/suppression' },
  { prefix: 'QA-CERT', path: '/signoff' },
]

// Shorthand accepted by Global Search. Suppression deliberately stays out
// of this list because legacy records already use the real `SUP-*` prefix;
// rewriting those would make valid historical IDs impossible to open.
const TQA_ID_SHORTHAND = /^(FUNC|SAST|DAST|PERF|SIGN|PROJ|TC|CYCLE)-/i

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
    qaRequests: 0, functional: 0, sast: 0, dast: 0, performance: 0, suppression: 0, signoff: 0, pendingReview: 0,
    pendingApprovals: 0,
  })
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('qa_nav_collapsed') === 'true')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set([
    'Overview', 'Request Management', 'Functional', 'Test Management', 'Security', 'Specialized Testing', 'Governance', 'Administration', 'Help & Support',
  ]))
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Topbar user menu -- clicking the signed-in name reveals Department +
  // Role(s) (mirrors the sidebar's own user-chip, but reachable from the
  // topbar too, which stays visible even with the sidebar collapsed/closed
  // on mobile).
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const groups = navGroups(counts, user)
  const activeGroup = groups.find((group) => group.items.some((item) => (
    item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
  )))
  const activeItem = activeGroup?.items.find((item) => (
    item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
  ))

  useEffect(() => { setSidebarOpen(false) }, [location.pathname])
  useEffect(() => { setUserMenuOpen(false) }, [location.pathname])
  useEffect(() => {
    if (!userMenuOpen) return
    function onDocMouseDown(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [userMenuOpen])
  useEffect(() => {
    if (!activeGroup) return
    setExpandedGroups((previous) => {
      if (previous.has(activeGroup.label)) return previous
      const next = new Set(previous)
      next.add(activeGroup.label)
      return next
    })
  }, [activeGroup?.label])

  useEffect(() => {
    function focusGlobalSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', focusGlobalSearch)
    return () => window.removeEventListener('keydown', focusGlobalSearch)
  }, [])

  function toggleSidebarSize() {
    setSidebarCollapsed((previous) => {
      const next = !previous
      localStorage.setItem('qa_nav_collapsed', String(next))
      return next
    })
  }

  function toggleGroup(label: string) {
    setExpandedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const loadCounts = useCallback(async () => {
    try {
      const [reqs, functional, sast, dast, performance, suppression, signoffs] = await Promise.all([
        api.get<QARequestOut[]>('/api/qa-requests'),
        api.get<FunctionalOut[]>('/api/functional-requests'),
        api.get<SASTOut[]>('/api/sast-requests'),
        api.get<DASTOut[]>('/api/dast-requests'),
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
      // Pending Approvals gets a live badge (unlike every other nav item's
      // count above, which is rendered but currently switched off -- see the
      // commented-out <span className="nav-count"> below) since the whole
      // point of that page is "how many things need me right now" -- a
      // silent nav entry would defeat that.
      let pendingApprovals = 0
      try {
        const items = await api.get<PendingApprovalItem[]>('/api/pending-approvals')
        pendingApprovals = items.length
      } catch (e) { /* ignore */ }
      setCounts({
        qaRequests, functional: functionalCount, sast: sastCount, dast: dastCount,
        performance: performanceCount, suppression: suppressionCount,
        signoff: signoffCount, pendingReview, pendingApprovals,
      })
    } catch (e) { /* badges are non-critical; ignore failures */ }
  }, [user])

  useEffect(() => { loadCounts() }, [loadCounts, location.pathname])

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const term = search.trim()
    if (!term) return
    // Reported directly: this used to always navigate to
    // `/qa-requests?search=...`, whose own search only matches the QA
    // Request gateway's own request_id/application_name/epic_number (see
    // `search` on GET /api/qa-requests) -- so typing in a SAST/DAST/
    // Functional QA/Performance/Suppression/Sign-off request ID (which all
    // use their own distinct ID prefix, see models.py's gen_id calls) landed
    // on an empty/irrelevant QA Requests list every time. Detect the prefix
    // and deep-link straight to that request's own module instead, reusing
    // the `?open=<request_id>` pattern each of those pages already supports
    // (see e.g. Functional.tsx) for jumping straight to a specific row's
    // detail drawer. Anything that doesn't match a known ID prefix (a QA
    // Request ID itself, or a free-text application name/epic number) still
    // falls through to the QA Request gateway search, unchanged.
    const upper = term.toUpperCase()
    const normalizedTerm = !upper.startsWith('TQA-') && TQA_ID_SHORTHAND.test(upper)
      ? `TQA-${upper}`
      : term
    const normalizedUpper = normalizedTerm.toUpperCase()
    if (normalizedTerm !== term) setSearch(normalizedTerm)
    const idRoute = ID_PREFIX_ROUTES.find((r) => normalizedUpper.startsWith(r.prefix))
    if (idRoute) {
      navigate(`${idRoute.path}?open=${encodeURIComponent(normalizedTerm)}`)
    } else {
      navigate(`/qa-requests?search=${encodeURIComponent(normalizedTerm)}`)
    }
  }

  return (
    <div className="app-shell redesigned-shell navigation-v2">
      <button className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`} aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} aria-label="Primary navigation">
        <div className="brand">
          <span className="bank-logo" role="img" aria-label="Bank of Maharashtra logo" />
          <div className="brand-copy">
            <h1>QualityHub</h1>
            <p>Bank of Maharashtra · QA Portal</p>
          </div>
          <button className="sidebar-collapse-control" onClick={toggleSidebarSize} aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}>
            {sidebarCollapsed ? '›' : '‹'}
          </button>
          <button className="sidebar-mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation">×</button>
        </div>

        <nav aria-label="Application modules">
          {groups.map((group) => (
            <div className={`nav-group ${sidebarCollapsed || expandedGroups.has(group.label) ? 'group-open' : ''}`} key={group.label}>
              <button className="nav-group-toggle" onClick={() => toggleGroup(group.label)} aria-expanded={sidebarCollapsed || expandedGroups.has(group.label)}>
                <span>{group.label}</span><i>⌄</i>
              </button>
              <div className="nav-group-items">
                {group.items.map((item) => {
                  const Icon = item.icon
                  return (
                    <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={() => setSidebarOpen(false)}
                             title={sidebarCollapsed ? item.label : undefined}
                             className={({ isActive }) => (isActive ? 'active' : '')}>
                      <span className="nav-icon"><Icon /></span>
                      <span className="nav-label">{item.label}</span>
                      {/* Every other nav item's own count is rendered but
                          switched off (see the disabled block this replaced,
                          left in git history) -- Pending Approvals is the one
                          deliberate exception: unlike an in-flight-request
                          count, which is just descriptive, this number is
                          the entire point of the page (how many things need
                          YOU right now), so it stays live. */}
                      {item.to === '/pending-approvals' && typeof item.count === 'number' && item.count > 0 && (
                        <span className="nav-count">{item.count}</span>
                      )}
                    </NavLink>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="audit-card shell-trust-card">
            <IconCheckCircle width={16} height={16} />
            <div>
              <div className="title">Governed workspace</div>
              <div className="desc">Actions and approvals are audit logged.</div>
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
                <div className="dept">{user.department || 'No department set'}</div>
              </div>
              <button onClick={logout} title="Log out"><IconLogout width={16} height={16} /></button>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="mobile-nav-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><span /><span /><span /></button>
          <div className="topbar-context">
            <span>{activeGroup?.label || 'Workspace'}</span>
            <strong>{activeItem?.label || 'QualityHub'}</strong>
          </div>
          <form className="search-box" onSubmit={submitSearch}>
            <IconSearch width={16} height={16} />
            <ClearableSearchInput ref={searchInputRef} aria-label="Global search" placeholder="Search request ID or application…" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} clearLabel="Clear global search" wrapperClassName="search-grow" />
            <kbd>⌘ K</kbd>
          </form>
          <div className="right-group">
            {user && (
              <div className="topbar-user-menu" ref={userMenuRef}>
                <button
                  type="button"
                  className="topbar-user-context"
                  onClick={() => setUserMenuOpen((v) => !v)}
                  aria-expanded={userMenuOpen}
                >
                  <span className="status-dot" />{user.full_name}
                  <i className={`topbar-user-caret ${userMenuOpen ? 'open' : ''}`}>⌄</i>
                </button>
                {userMenuOpen && (
                  <div className="topbar-user-popover">
                    <div className="topbar-user-popover-name">{user.full_name}</div>
                    <div className="topbar-user-popover-row">
                      <span className="label">Department</span>
                      <span>{user.department || 'No department set'}</span>
                    </div>
                    <div className="topbar-user-popover-row">
                      <span className="label">Role(s)</span>
                      <span>{(user.roles || []).map((r) => ROLE_LABELS[r] || r).join(', ') || 'No role assigned'}</span>
                    </div>
                    {/* <button type="button" className="btn btn-sm topbar-user-popover-logout" onClick={logout}>
                      <IconLogout width={14} height={14} /> Log out
                    </button> */}
                  </div>
                )}
              </div>
            )}
            {!user && <span className="topbar-user-context"><span className="status-dot" />Signed in</span>}
            {hasRole(user, 'REQUESTER', 'BUSINESS_ANALYST') && (
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/qa-requests', { state: { openNew: true } })}>
                <IconPlus width={14} height={14} /> New QA request
              </button>
            )}
          </div>
        </div>
        <div className="content">{children}</div>
        {/* Moved out of the sidebar's own footer (previously .portal-credit,
            hidden entirely once the sidebar was collapsed -- see index.css)
            into a real page footer instead, so it's visible on every signed-
            in page (not just an expanded sidebar) regardless of collapse
            state. Lives here rather than inside .content so it stays pinned
            under the scrollable page area (same fixed-shell pattern as
            .topbar above it) instead of scrolling away with long page
            content. */}
        <div className="app-footer">
          <span>Developed by</span>
          <strong>Soumyajit Pal</strong>
          <span>·</span>
          <span>Quality Assurance Department - IT</span>
        </div>
      </div>
    </div>
  )
}
