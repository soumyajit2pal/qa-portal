import React, { useEffect, useState, useRef, ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS, hasRole } from '../constants'
import { UserOut } from '../types'
import {
  IconGrid, IconEdit, IconFolder, IconShield, IconTarget, IconEyeOff,
  IconCertificate, IconApprove, IconChart, IconSearch, IconWorkflow,
  IconPlus, IconCheckCircle, IconLogout, IconUsers, IconApps, IconPlay, IconBell,
  IconHelp,
} from './Icons'
import ClearableSearchInput from './ClearableSearchInput'
import NotificationBell from './NotificationBell'

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

interface NavGroup {
  label: string
  items: NavItem[]
}

// Nav items are grouped into short, labeled sections (Workspace / Security /
// Governance / Administration) rather than one long flat list -- with 8+
// destinations a flat list stops reading as a hierarchy, so grouping gives
// the sidebar a clearer information architecture.
function navGroups(user: UserOut | null): NavGroup[] {
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
        { to: '/qa-requests', label: 'QA Requests', icon: IconEdit },
      ],
    },
    {
      label: 'Functional',
      items: [
        { to: '/functional-requests', label: 'Functional Requests', icon: IconFolder },
      ],
    },
    {
      label: 'Security',
      items: [
        { to: '/sast', label: 'SAST Requests', icon: IconShield },
        { to: '/dast', label: 'DAST Requests', icon: IconTarget },
        { to: '/suppression', label: 'Suppression / False Positive', icon: IconEyeOff },
      ],
    },
    {
      label: 'Specialized Testing',
      items: [
        { to: '/performance', label: 'Performance Testing', icon: IconWorkflow },
      ],
    },
    {
      label: 'Test Management',
      items: [
        { to: '/test-projects', label: 'Projects', icon: IconApps },
        { to: '/test-repository', label: 'Test Repository', icon: IconFolder },
        { to: '/test-execution', label: 'Test Execution', icon: IconPlay },
        { to: '/defects', label: 'Defect Management', icon: IconTarget },
        // SRS EXE-002 "My Executions" -- the signed-in user's own actionable
        // items across every authorized project, one cross-project view
        // instead of hunting through each project's own Test Execution page.
        { to: '/my-executions', label: 'My Executions', icon: IconCheckCircle },
        // SRS section 11 -- the 5 reporting views (repository health, cycle
        // progress, defect quality, version impact, project portfolio).
        { to: '/test-reports', label: 'Test Reports', icon: IconChart },
      ],
    },
    {
      label: 'Governance',
      items: [
        { to: '/signoff', label: 'QA Sign-off', icon: IconCertificate },
        { to: '/pending-approvals', label: 'Pending Approvals', icon: IconBell },
        { to: '/approvals', label: 'Approval Workflow Log', icon: IconApprove },
        { to: '/reports', label: 'Reports & Export Centre', icon: IconChart },
        ...(hasRole(user, 'ADMIN', 'CHEIF_MANAGER_COE', 'CHEIF_MANAGER_QA', 'AGM_COE')
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
    adminItems.push({ to: '/admin', label: 'Users & Access', icon: IconUsers })
    adminItems.push({ to: '/checklist-config', label: 'Readiness Checklist Config', icon: IconCheckCircle })
  }
  if (hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM', 'CHEIF_MANAGER_COE', 'CHEIF_MANAGER_QA', 'AGM_COE')) {
    adminItems.push({ to: '/department-admin', label: 'Department Coordinator', icon: IconUsers })
  }
  if (adminItems.length > 0) {
    groups.push({ label: 'Administration', items: adminItems })
  }
  return groups
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
  { prefix: 'TQA-PLAN', path: '/test-projects' },
  { prefix: 'TQA-TC', path: '/test-repository' },
  { prefix: 'TQA-CYCLE', path: '/test-execution' },
  { prefix: 'DEF-', path: '/defects' },
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
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('qa_nav_collapsed') === 'true')
  // Nav-group toggle buttons now default to closed -- the effect below still
  // auto-opens whichever group contains the current route, so the active
  // section is never hidden on load; only the OTHER groups start collapsed
  // instead of every group being expanded up front.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Topbar user menu -- clicking the signed-in name reveals Department +
  // Role(s) (mirrors the sidebar's own user-chip, but reachable from the
  // topbar too, which stays visible even with the sidebar collapsed/closed
  // on mobile).
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const groups = navGroups(user)
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

  function handleLogout() {
    logout()
  }

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
    <div className="app-shell redesigned-shell navigation-v2 navigation-v3 navigation-v4">
      <button className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`} aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} aria-label="Primary navigation">
        <div className="brand">
          <span className="qualitysphere-mark" aria-hidden="true"><b>Q</b><i>S</i></span>
          <div className="brand-copy">
            <h1>Quality<span>Shield</span></h1>
            <img className="bank-wordmark sidebar-bank-wordmark" src="/bank-of-maharashtra-wordmark.png" alt="Bank of Maharashtra" />
          </div>
          <button className="sidebar-collapse-control" onClick={toggleSidebarSize} aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}>
            {sidebarCollapsed ? '›' : '‹'}
          </button>
          <button className="sidebar-mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation">×</button>
        </div>

        <nav aria-label="Application modules">
          <div className="nav-workspace-label"><span>Workspace</span><i /></div>
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
              <button onClick={handleLogout} title="Log out"><IconLogout width={16} height={16} /></button>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="mobile-nav-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><span /><span /><span /></button>
          <div className="topbar-context">
            <span><b>QualityShield</b><i>/</i>{activeGroup?.label || 'Workspace'}</span>
            <strong>{activeItem?.label || 'Dashboard'}</strong>
          </div>
          <form className="search-box" onSubmit={submitSearch}>
            <IconSearch width={16} height={16} />
            <ClearableSearchInput ref={searchInputRef} aria-label="Global search" placeholder="Search requests, applications or IDs…" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} clearLabel="Clear global search" wrapperClassName="search-grow" />
            <kbd>⌘ K</kbd>
          </form>
          <div className="right-group">
            {user && <NotificationBell />}
            {user && (
              <div className="topbar-user-menu" ref={userMenuRef}>
                <button
                  type="button"
                  className="topbar-user-context"
                  onClick={() => setUserMenuOpen((v) => !v)}
                  aria-expanded={userMenuOpen}
                >
                  <span className="topbar-avatar">{initials(user.full_name)}</span>
                  <span className="topbar-user-name">{user.full_name}</span>
                  <i className={`topbar-user-caret ${userMenuOpen ? 'open' : ''}`}>⌄</i>
                </button>
                {userMenuOpen && (
                  <div className="topbar-user-popover">
                    <div className="topbar-user-popover-name">{user.full_name}</div>
                    <div className="topbar-user-popover-email">{user.username}</div>
                    <div className="topbar-user-popover-row">
                      <span className="label">Department</span>
                      <span>{user.department || 'No department set'}</span>
                    </div>
                    <div className="topbar-user-popover-row">
                      <span className="label">Role(s)</span>
                      <span>{(user.roles || []).map((r) => ROLE_LABELS[r] || r).join(', ') || 'No role assigned'}</span>
                    </div>
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
