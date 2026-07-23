import React, { useEffect, useState, useCallback } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS, QA_ACTIVE_STATUSES, hasRole } from '../constants'
import { api } from '../api'
import {
  IconGrid, IconEdit, IconFolder, IconPlay, IconShield, IconTarget, IconEyeOff,
  IconCertificate, IconApprove, IconChart, IconSearch,
  IconPlus, IconCheckCircle, IconLogout, IconUsers,
} from './Icons'

// Nav items are grouped into short, labeled sections (Workspace / Security /
// Governance / Administration) rather than one long flat list -- with 8+
// destinations a flat list stops reading as a hierarchy, so grouping gives
// the sidebar a clearer information architecture.
function navGroups(counts, user) {
  const groups = [
    {
      label: 'Workspace',
      items: [
        { to: '/', label: 'Command Centre', icon: IconGrid },
        { to: '/qa-requests', label: 'QA Requests', icon: IconEdit, count: counts.qaRequests },
        // Test Case Repository (Module 2) and Test Execution Management (Module 3)
        // are temporarily DISABLED per request -- see App.jsx for the matching
        // commented-out routes. Re-enable by uncommenting these two nav items too.
        // { to: '/test-cases', label: 'Test Case Repository', icon: IconFolder },
        // { to: '/test-runs', label: 'Test Execution', icon: IconPlay },
      ],
    },
    {
      label: 'Security',
      items: [
        { to: '/sast', label: 'SAST Requests', icon: IconShield, count: counts.security },
        { to: '/dast', label: 'DAST Requests', icon: IconTarget },
        { to: '/suppression', label: 'Suppression / False Positive', icon: IconEyeOff },
      ],
    },
    {
      label: 'Governance',
      items: [
        { to: '/signoff', label: 'QA Sign-off', icon: IconCertificate },
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

const OPEN_SECURITY_STATUSES = ['Requested', 'Lead Approved', 'Allocated', 'Scanning']

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase()
}

export default function Layout({ children }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [counts, setCounts] = useState({ qaRequests: 0, security: 0, pendingReview: 0 })
  const [search, setSearch] = useState('')

  const loadCounts = useCallback(async () => {
    try {
      const [reqs, sast, dast] = await Promise.all([
        api.get('/api/qa-requests'),
        api.get('/api/sast-requests'),
        api.get('/api/dast-requests'),
      ])
      const qaRequests = reqs.filter((r) => QA_ACTIVE_STATUSES.includes(r.status)).length
      const security = sast.filter((r) => OPEN_SECURITY_STATUSES.includes(r.status)).length
        + dast.filter((r) => OPEN_SECURITY_STATUSES.includes(r.status)).length

      let pendingReview = 0
      if (hasRole(user, 'ADMIN')) {
        try {
          const allUsers = await api.get('/api/auth/users/all')
          pendingReview = allUsers.filter((u) => u.needs_role_review).length
        } catch (e) { /* ignore */ }
      }
      setCounts({ qaRequests, security, pendingReview })
    } catch (e) { /* badges are non-critical; ignore failures */ }
  }, [user])

  useEffect(() => { loadCounts() }, [loadCounts, location.pathname])

  function submitSearch(e) {
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
