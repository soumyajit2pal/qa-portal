import React, { ReactNode, Suspense, lazy } from 'react'
import { Routes, Route, Navigate, Link, Outlet } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import DepartmentPrompt from './components/DepartmentPrompt'
import PendingApprovalsNotice from './components/PendingApprovalsNotice'
import { UserOut } from './types'
import { hasDepartment, QA_DEPARTMENT } from './constants'

// Cross-cutting pages -- not owned by any one domain module (the QA Request
// gateway feeds every module, the Dashboard summarizes across all of
// them, Login is pre-auth). Loaded eagerly since they're on the app's
// default/most-common paths.
import Login from './Login'
import Dashboard from './Dashboard'
import QARequests from './QARequests'
import ModuleBoundary from './components/ModuleBoundary'
import ApiActivityIndicator from './components/ApiActivityIndicator'

const Help = lazy(() => import('./Help'))

// The 4 domain modules (Functional / Security / Specialised Testing /
// Governance) live under src/modules/<group>/ as plain local folders in
// this same app/build -- not separately deployed. `React.lazy()` still
// code-splits each into its own chunk (so e.g. visiting only "/sast" never
// downloads the Governance or Specialised Testing code), it's just resolved from
// this repo's own filesystem at build time instead of fetched from another
// origin's remoteEntry.js at runtime. This project previously used real
// Module Federation (separate images/deploys per module) and reverted to
// this single-app model -- see README "Frontend architecture" for why.
const Functional = lazy(() => import('./modules/functional/Functional'))
const SAST = lazy(() => import('./modules/security/SAST'))
const DAST = lazy(() => import('./modules/security/DAST'))
const Suppression = lazy(() => import('./modules/security/Suppression'))
const Performance = lazy(() => import('./modules/specialised-testing/Performance'))
const SignOff = lazy(() => import('./modules/governance/SignOff'))
const PendingApprovals = lazy(() => import('./modules/governance/PendingApprovals'))
const Approvals = lazy(() => import('./modules/governance/Approvals'))
const Reports = lazy(() => import('./modules/governance/Reports'))
const Admin = lazy(() => import('./modules/governance/Admin'))
const DepartmentAdmin = lazy(() => import('./modules/governance/DepartmentAdmin'))
const AuditLog = lazy(() => import('./modules/governance/AuditLog'))
const ChecklistConfig = lazy(() => import('./modules/governance/ChecklistConfig'))

// Test Management module (Project Management / Test Repository / Test
// Execution) -- a Zephyr-style test case management layer, kept as its own
// nav group rather than folded into Functional/Specialised Testing since
// it's a distinct workflow (author/import/execute test cases) rather than a
// request-approval flow like every other module.
const TestProjects = lazy(() => import('./modules/test-management/TestProjects'))
const TestRepository = lazy(() => import('./modules/test-management/TestRepository'))
const TestExecution = lazy(() => import('./modules/test-management/TestExecution'))
const Defects = lazy(() => import('./modules/test-management/Defects'))
// SRS EXE-002 "My Executions" -- the signed-in user's actionable items
// across every authorized project.
const MyExecutions = lazy(() => import('./modules/test-management/MyExecutions'))
// SRS section 11 -- the 8 Test Management reporting views.
const TestReports = lazy(() => import('./modules/test-management/TestReports'))

// The chrome every signed-in page sits inside -- sidebar/topbar (Layout)
// plus the two blocking pop-ups that can appear on top of any of them
// (DepartmentPrompt, PendingApprovalsNotice). Factored out so both
// ProtectedLayout (the normal nested-route case, below) and HelpRoute's
// signed-in branch (still a one-off special case -- see its own comment)
// render identically without duplicating this logic.
function AuthenticatedChrome({ user, children }: { user: UserOut; children: ReactNode }) {
  return (
    <Layout>
      {children}
      {/* First-ever LDAP login: blocks interaction with the rest of the app
          (Modal's preventBackdropClose) until the person picks their
          department -- see models.User.needs_department_selection. Rendered
          on top of the normal page (not instead of it) so it shows up
          immediately after login regardless of which page they land on. */}
      {user.needs_department_selection && <DepartmentPrompt />}
      {/* Reported directly: "also show one info on login if there are any
          pending approval pending." Held back while DepartmentPrompt is
          still up (above) so a first-ever LDAP login never stacks two
          blocking pop-ups -- PendingApprovalsNotice itself no-ops until
          AuthContext's justLoggedIn is true, which stays true across that
          whole exchange, so it still fires right after DepartmentPrompt is
          dismissed rather than being skipped entirely. */}
      {!user.needs_department_selection && <PendingApprovalsNotice />}
    </Layout>
  )
}

// Reported directly (twice now): "there are lots of api calling, sometime
// same api calling multiple time" -- traced (see ORACLE_MIGRATION_2026-07.md
// section 185) to every protected route independently wrapping its OWN
// `<Protected><Page /></Protected>` instance with no shared parent route --
// so Layout (sidebar/topbar, and its pending-approvals badge fetch) actually
// unmounted and remounted on every single navigation between pages, not just
// re-ran an effect. Section 185 papered over the symptom with a short-lived
// cache; THIS is the real fix: one pathless parent route
// (`<Route element={<ProtectedLayout />}>`, a React Router v6 "layout
// route") wrapping every protected page below it via `<Outlet/>`, so
// `AuthenticatedChrome`/`Layout` mounts ONCE for the whole signed-in session
// and only the `<Outlet/>` content swaps as you navigate between its child
// routes -- the sidebar, topbar, and the badge fetch no longer tear down and
// rebuild on every click. `/login` and `/help` stay outside this group
// deliberately: `/login` must render with no chrome at all, and `/help` must
// still work when signed OUT (see HelpRoute below, unchanged in shape from
// before), which a route nested under an auth-gated parent could never do.
function ProtectedLayout() {
  const { user, loading } = useAuth()
  if (loading) return <ModuleFallback />
  if (!user) return <Navigate to="/login" replace />
  return (
    <AuthenticatedChrome user={user}>
      <Outlet />
    </AuthenticatedChrome>
  )
}

function QaGroupOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return hasDepartment(user, QA_DEPARTMENT) ? <>{children}</> : <Navigate to="/" replace />
}

// Reported directly: "Help & user Manual should come on login page as well,
// without login atleast user can read" -- Help.tsx is entirely static
// content (no API calls, no auth-scoped data, see its own file), so there's
// nothing that actually requires being signed in to view it. Routes to this
// same /help path either way: signed-in users still get the normal
// Layout/DepartmentPrompt/PendingApprovalsNotice chrome via
// AuthenticatedChrome above (a deliberate one-off exception to "everything
// protected lives under ProtectedLayout" -- /help itself must remain
// reachable signed OUT, which a route nested under an auth-gated parent
// could never be); a signed-out visitor instead gets PublicHelp below, a
// minimal standalone shell (brand mark + a way back to the login page)
// around the exact same <Help /> content, rather than a second copy of the
// manual to keep in sync.
function HelpRoute() {
  const { user, loading } = useAuth()
  if (loading) return <ModuleFallback />
  if (user) return <AuthenticatedChrome user={user}><Help /></AuthenticatedChrome>
  return <PublicHelp />
}

function PublicHelp() {
  return (
    <div className="public-help-shell">
      <div className="public-help-topbar">
        <Link to="/help" className="public-help-brand">
          <img className="qualityshield-app-logo" src="/qualityshield-logo.png" alt="" aria-hidden="true" />
          <div>
            <strong>Quality<em>Shield</em></strong>
            <img className="bank-wordmark public-bank-wordmark" src="/bank-of-maharashtra-wordmark.png" alt="Bank of Maharashtra" />
          </div>
        </Link>
        <Link to="/login" className="public-help-back">← Back to sign in</Link>
      </div>
      <Help />
    </div>
  )
}

// Fallback shown while a lazy-loaded module's chunk is still downloading
// (typically instant on a warm cache, briefly visible on first visit to a
// module or right after a fresh deploy) -- matches ProtectedLayout's own
// plain-text loading state above rather than introducing a spinner
// component just for this.
function ModuleFallback() {
  return (
    <div className="route-loading" role="status" aria-label="Loading page">
      <div className="route-loading-title" />
      <div className="route-loading-toolbar" />
      <div className="route-loading-card" />
      <div className="route-loading-card route-loading-card-short" />
    </div>
  )
}

export default function App() {
  return (
    <>
      <ApiActivityIndicator />
      <Suspense fallback={<ModuleFallback />}>
        <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/help" element={<HelpRoute />} />

        {/* Every protected page below shares this one pathless layout route
            -- see ProtectedLayout's own comment above for why. */}
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/qa-requests" element={<QARequests />} />

          {/* Functional module. Each lazy route is wrapped in its own
              ModuleBoundary instance (not one boundary around the whole
              <Routes>) so a failed chunk load shows a clear, actionable
              error for just that module instead of silently blanking the
              entire app, and so navigating away from a failed module to a
              working one gets a fresh boundary instead of a stuck error
              screen. */}
          <Route path="/functional-requests" element={<ModuleBoundary moduleName="Functional"><Functional /></ModuleBoundary>} />

          {/* Security module */}
          <Route path="/sast" element={<ModuleBoundary moduleName="Security"><SAST /></ModuleBoundary>} />
          <Route path="/dast" element={<ModuleBoundary moduleName="Security"><DAST /></ModuleBoundary>} />
          <Route path="/suppression" element={<ModuleBoundary moduleName="Security"><Suppression /></ModuleBoundary>} />

          {/* Specialised Testing module */}
          <Route path="/performance" element={<ModuleBoundary moduleName="Specialised Testing"><Performance /></ModuleBoundary>} />

          {/* Governance module */}
          <Route path="/signoff" element={<ModuleBoundary moduleName="Governance"><SignOff /></ModuleBoundary>} />
          <Route path="/pending-approvals" element={<ModuleBoundary moduleName="Governance"><PendingApprovals /></ModuleBoundary>} />
          <Route path="/approvals" element={<ModuleBoundary moduleName="Governance"><Approvals /></ModuleBoundary>} />
          <Route path="/reports" element={<ModuleBoundary moduleName="Governance"><Reports /></ModuleBoundary>} />
          <Route path="/admin" element={<ModuleBoundary moduleName="Governance"><Admin /></ModuleBoundary>} />
          <Route path="/department-admin" element={<ModuleBoundary moduleName="Governance"><DepartmentAdmin /></ModuleBoundary>} />
          <Route path="/audit-log" element={<ModuleBoundary moduleName="Governance"><AuditLog /></ModuleBoundary>} />
          <Route path="/checklist-config" element={<ModuleBoundary moduleName="Governance"><ChecklistConfig /></ModuleBoundary>} />

          {/* Test Management module */}
          <Route path="/test-projects" element={<ModuleBoundary moduleName="Test Management"><TestProjects /></ModuleBoundary>} />
          <Route path="/test-repository" element={<ModuleBoundary moduleName="Test Management"><TestRepository /></ModuleBoundary>} />
          <Route path="/test-execution" element={<ModuleBoundary moduleName="Test Management"><TestExecution /></ModuleBoundary>} />
          <Route path="/defects" element={<ModuleBoundary moduleName="Defect Management"><Defects /></ModuleBoundary>} />
          <Route path="/my-executions" element={<QaGroupOnly><ModuleBoundary moduleName="Test Management"><MyExecutions /></ModuleBoundary></QaGroupOnly>} />
          <Route path="/test-reports" element={<ModuleBoundary moduleName="Test Management"><TestReports /></ModuleBoundary>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  )
}
