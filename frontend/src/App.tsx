import React, { ReactNode } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import QARequests from './pages/QARequests'
// Test Case Repository (Module 2) and Test Execution Management (Module 3) are
// temporarily DISABLED per request -- pages are untouched and fully working,
// just not routed to. Re-enable by uncommenting these two imports, the two
// <Route> entries below, and the nav items in components/Layout.tsx.
// import TestCases from './pages/TestCases'
// import TestRuns from './pages/TestRuns'
import SAST from './pages/SAST'
import DAST from './pages/DAST'
import Suppression from './pages/Suppression'
import SignOff from './pages/SignOff'
import Approvals from './pages/Approvals'
import Reports from './pages/Reports'
import Admin from './pages/Admin'

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ padding: 40 }}>Loading...</div>
  if (!user) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/qa-requests" element={<Protected><QARequests /></Protected>} />
      {/* <Route path="/test-cases" element={<Protected><TestCases /></Protected>} /> */}
      {/* <Route path="/test-runs" element={<Protected><TestRuns /></Protected>} /> */}
      <Route path="/sast" element={<Protected><SAST /></Protected>} />
      <Route path="/dast" element={<Protected><DAST /></Protected>} />
      <Route path="/suppression" element={<Protected><Suppression /></Protected>} />
      <Route path="/signoff" element={<Protected><SignOff /></Protected>} />
      <Route path="/approvals" element={<Protected><Approvals /></Protected>} />
      <Route path="/reports" element={<Protected><Reports /></Protected>} />
      <Route path="/admin" element={<Protected><Admin /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
