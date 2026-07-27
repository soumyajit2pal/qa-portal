import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import { IconGrid, IconShield, IconApprove, IconCertificate } from '@qa-portal/shared/components/Icons'

// Mirrors backend app/seed.py DEMO_USERS -- one demo account per role.
const DEMO_ACCOUNTS: [string, string][] = [
  ['requester1', 'Requester (Developer) / Others'], ['ba1', 'Business Analyst'], ['qa1', 'QA Engineer (QA)'],
  ['qalead1', 'QA Lead'], ['exec1', 'Executive COE (AGM-QA)'], ['security1', 'Security Analyst (QA)'],
  ['appowner1', 'Application Owner'], ['depthead1', 'Department Head - CM/AGM'],
  ['sm1', 'SM'], ['admin', 'Administrator'],
]

const HIGHLIGHTS = [
  { Icon: IconGrid, text: 'One command centre for every QA request, from raise to sign-off.' },
  { Icon: IconShield, text: 'Integrated SAST/DAST security testing and suppression workflows.' },
  { Icon: IconApprove, text: 'Full approval workflow log — every decision, evidenced and traceable.' },
  { Icon: IconCertificate, text: 'Formal QA sign-off certificates before every release.' },
]

export default function Login() {
  const [username, setUsername] = useState('requester1')
  const [password, setPassword] = useState('Password@123')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      navigate('/')
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="login-brand">
          <div className="logo-mark">Q</div>
          <h1>QualityHub</h1>
          <p className="tagline">Centralized QA Portal &middot; Bank of Maharashtra, Information Technology Department</p>
          <ul className="highlights">
            {HIGHLIGHTS.map(({ Icon, text }, i) => (
              <li key={i}><Icon width={16} height={16} /><span>{text}</span></li>
            ))}
          </ul>
        </div>

        <div className="login-card">
          <h1>Sign in</h1>
          <p className="sub">Use your assigned username and password to continue.</p>
          <form onSubmit={onSubmit}>
            <div className="form-field" style={{ marginBottom: 12 }}>
              <label>Username</label>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </div>
            <div className="form-field" style={{ marginBottom: 12 }}>
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="error-text">{error}</p>}
            <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
          <div className="hint-box">
            <strong>Demo accounts</strong> (password: <code>Password@123</code> for all):
            <div className="demo-accounts">
              {DEMO_ACCOUNTS.map(([u, l]) => (
                <button type="button" key={u} className="demo-chip" onClick={() => { setUsername(u); setPassword('Password@123') }}>
                  {u} <span className="muted">· {l}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
