import React, { ReactNode, Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import DepartmentPrompt from './components/DepartmentPrompt'

// Cross-cutting pages -- not owned by any one domain module (the QA Request
// gateway feeds every module, the Command Centre summarizes across all of
// them, Login is pre-auth). Loaded eagerly since they're on the app's
// default/most-common paths.
import Login from './Login'
import Dashboard from './Dashboard'
import QARequests from './QARequests'
import ModuleBoundary from './components/ModuleBoundary'

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
const Approvals = lazy(() => import('./modules/governance/Approvals'))
const Reports = lazy(() => import('./modules/governance/Reports'))
const Admin = lazy(() => import('./modules/governance/Admin'))

function Protected({ children }: { children?: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ padding: 40 }}>Loading...</div>
  if (!user) return <Navigate to="/login" replace />
  return (
    <Layout>
      {children}
      {/* First-ever LDAP login: blocks interaction with the rest of the app
          (Modal's preventBackdropClose) until the person picks their
          department -- see models.User.needs_department_selection. Rendered
          on top of the normal page (not instead of it) so it shows up
          immediately after login regardless of which page they land on. */}
      {user.needs_department_selection && <DepartmentPrompt />}
    </Layout>
  )
}

// Fallback shown while a lazy-loaded module's chunk is still downloading
// (typically instant on a warm cache, briefly visible on first visit to a
// module or right after a fresh deploy) -- matches Protected's own
// plain-text loading state above rather than introducing a spinner
// component just for this.
function ModuleFallback() {
  return <div style={{ padding: 40 }}>Loading...</div>
}

export default function App() {
  return (
    <Suspense fallback={<ModuleFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Protected><Dashboard /></Protected>} />
        <Route path="/qa-requests" element={<Protected><QARequests /></Protected>} />

        {/* Functional module. Each lazy route is wrapped in its own
            ModuleBoundary instance (not one boundary around the whole
            <Routes>) so a failed chunk load shows a clear, actionable
            error for just that module instead of silently blanking the
            entire app, and so navigating away from a failed module to a
            working one gets a fresh boundary instead of a stuck error
            screen. */}
        <Route path="/functional-requests" element={<Protected><ModuleBoundary moduleName="Functional"><Functional /></ModuleBoundary></Protected>} />

        {/* Security module */}
        <Route path="/sast" element={<Protected><ModuleBoundary moduleName="Security"><SAST /></ModuleBoundary></Protected>} />
        <Route path="/dast" element={<Protected><ModuleBoundary moduleName="Security"><DAST /></ModuleBoundary></Protected>} />
        <Route path="/suppression" element={<Protected><ModuleBoundary moduleName="Security"><Suppression /></ModuleBoundary></Protected>} />

        {/* Specialised Testing module */}
        <Route path="/performance" element={<Protected><ModuleBoundary moduleName="Specialised Testing"><Performance /></ModuleBoundary></Protected>} />

        {/* Governance module */}
        <Route path="/signoff" element={<Protected><ModuleBoundary moduleName="Governance"><SignOff /></ModuleBoundary></Protected>} />
        <Route path="/approvals" element={<Protected><ModuleBoundary moduleName="Governance"><Approvals /></ModuleBoundary></Protected>} />
        <Route path="/reports" element={<Protected><ModuleBoundary moduleName="Governance"><Reports /></ModuleBoundary></Protected>} />
        <Route path="/admin" element={<Protected><ModuleBoundary moduleName="Governance"><Admin /></ModuleBoundary></Protected>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
