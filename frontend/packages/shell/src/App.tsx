import React, { ReactNode, Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import Layout from './components/Layout'

// Shell-owned pages -- cross-cutting, not owned by any one domain module
// (the QA Request gateway feeds every module, the Command Centre summarizes
// across all of them, Login is pre-auth). Loaded eagerly since they're on
// the app's default/most-common paths, and they live in this same
// application/build (not a separate remote).
import Login from './Login'
import Dashboard from './Dashboard'
import QARequests from './QARequests'

// The 4 domain modules (Functional / Security / Specialised Testing /
// Governance) are now true Module Federation remotes -- each is its own
// separately built, separately deployed application (own Dockerfile/image,
// own container/URL), not a folder inside this codebase. The shell only
// knows each remote's *name* and *exposed module path* (e.g.
// "functional/Functional") -- both wired up in vite.config.ts's
// `federation({ remotes: {...} })` config, which is what actually resolves
// these specifiers to a real URL (https://<module-host>/assets/remoteEntry.js)
// at build/runtime. TypeScript doesn't know these modules exist at
// compile time (they're not real files in this repo) -- see
// src/remotes.d.ts for the ambient declarations that satisfy tsc.
//
// Because each is loaded over the network as its own bundle, a change
// inside one module's own repo/deploy can go out (rebuild + redeploy just
// that module's image) without rebuilding or redeploying the shell, or any
// other module, at all -- this is the actual point of "each module its own
// image and deployment" (vs. the previous round's lazy-loaded-but-still-
// one-build "modular restructure").
const Functional = lazy(() => import('functional/Functional'))
const SAST = lazy(() => import('security/SAST'))
const DAST = lazy(() => import('security/DAST'))
const Suppression = lazy(() => import('security/Suppression'))
const Automation = lazy(() => import('specialisedTesting/Automation'))
const Performance = lazy(() => import('specialisedTesting/Performance'))
const SignOff = lazy(() => import('governance/SignOff'))
const Approvals = lazy(() => import('governance/Approvals'))
const Reports = lazy(() => import('governance/Reports'))
const Admin = lazy(() => import('governance/Admin'))

function Protected({ children }: { children?: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ padding: 40 }}>Loading...</div>
  if (!user) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

// Fallback shown while a remote module's own bundle is still downloading
// from its own origin (typically instant on a warm cache, briefly visible
// on first visit to a module or right after that module's own deploy
// rolled out a new version) -- matches Protected's own plain-text loading
// state above rather than introducing a spinner component just for this.
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

        {/* Functional module -- remote "functional" */}
        <Route path="/functional-requests" element={<Protected><Functional /></Protected>} />

        {/* Security module -- remote "security" */}
        <Route path="/sast" element={<Protected><SAST /></Protected>} />
        <Route path="/dast" element={<Protected><DAST /></Protected>} />
        <Route path="/suppression" element={<Protected><Suppression /></Protected>} />

        {/* Specialised Testing module -- remote "specialisedTesting" */}
        <Route path="/automation" element={<Protected><Automation /></Protected>} />
        <Route path="/performance" element={<Protected><Performance /></Protected>} />

        {/* Governance module -- remote "governance" */}
        <Route path="/signoff" element={<Protected><SignOff /></Protected>} />
        <Route path="/approvals" element={<Protected><Approvals /></Protected>} />
        <Route path="/reports" element={<Protected><Reports /></Protected>} />
        <Route path="/admin" element={<Protected><Admin /></Protected>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
