import React, { ReactNode, Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import Layout from './components/Layout'

// Cross-cutting pages -- not owned by any one domain module (the QA Request
// gateway feeds every module, the Command Centre summarizes across all of
// them, Login is pre-auth). Loaded eagerly since they're on the app's
// default/most-common paths.
import Login from './Login'
import Dashboard from './Dashboard'
import QARequests from './QARequests'

// The domain modules (Functional / Security / Specialised Testing /
// Governance) are just route-level code-split chunks of this one app --
// lazy() + Suspense below give the same on-demand loading a separate
// Module Federation remote would, without the operational cost of a
// separate build/deploy per module.
const Functional = lazy(() => import('./modules/functional/Functional'))
const SAST = lazy(() => import('./modules/security/SAST'))
const DAST = lazy(() => import('./modules/security/DAST'))
const Suppression = lazy(() => import('./modules/security/Suppression'))
const Automation = lazy(() => import('./modules/specialisedTesting/Automation'))
const Performance = lazy(() => import('./modules/specialisedTesting/Performance'))
const SignOff = lazy(() => import('./modules/governance/SignOff'))
const Approvals = lazy(() => import('./modules/governance/Approvals'))
const Reports = lazy(() => import('./modules/governance/Reports'))
const Admin = lazy(() => import('./modules/governance/Admin'))

function Protected({ children }: { children?: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ padding: 40 }}>Loading...</div>
  if (!user) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

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

        {/* Functional module */}
        <Route path="/functional-requests" element={<Protected><Functional /></Protected>} />

        {/* Security module */}
        <Route path="/sast" element={<Protected><SAST /></Protected>} />
        <Route path="/dast" element={<Protected><DAST /></Protected>} />
        <Route path="/suppression" element={<Protected><Suppression /></Protected>} />

        {/* Specialised Testing module */}
        <Route path="/automation" element={<Protected><Automation /></Protected>} />
        <Route path="/performance" element={<Protected><Performance /></Protected>} />

        {/* Governance module */}
        <Route path="/signoff" element={<Protected><SignOff /></Protected>} />
        <Route path="/approvals" element={<Protected><Approvals /></Protected>} />
        <Route path="/reports" element={<Protected><Reports /></Protected>} />
        <Route path="/admin" element={<Protected><Admin /></Protected>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
