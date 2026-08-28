import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { IconApprove, IconCertificate, IconEyeOff, IconLock, IconShield, IconUsers, IconWorkflow } from './components/Icons'
import { ErrorText } from './components/Common'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username.trim().toLowerCase(), password)
      navigate('/')
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-ambient login-ambient-one" />
      <div className="login-ambient login-ambient-two" />

      <section className="login-shell" aria-label="QualityOps sign in">
        <aside className="login-brand">
          <div className="login-brand-top">
            <div className="qualitysphere-identity">
              <img className="qualityops-app-logo qualityops-app-logo-lg" src="/qualityops-logo.png" alt="" aria-hidden="true" />
              <div className="brand-name">
                <strong>Quality<em>Ops</em></strong>
                <small>Enterprise quality operations</small>
              </div>
            </div>
            <img className="bank-wordmark login-bank-wordmark" src="/bank-of-maharashtra-wordmark.png" alt="Bank of Maharashtra" />
          </div>

          <div className="login-brand-copy">
            <div className="eyebrow"><span /> Plan · Test · Secure · Approve</div>
            <h1>Quality operations,<br />governed end to end.</h1>
            <p>One secure workspace for QA requests, test case management, execution, security assurance, and approvals workflow.</p>

            <div className="login-capabilities">
              <div><span><IconWorkflow /></span><strong>Orchestrated workflows</strong><small>Track every request through a clear, governed lifecycle.</small></div>
              <div><span><IconShield /></span><strong>Security built in</strong><small>SAST, DAST, and suppression reviews in one place.</small></div>
              <div><span><IconCertificate /></span><strong>Audit-ready clearance</strong><small>Decisions and evidence remain complete and traceable.</small></div>
            </div>
          </div>

          <div className="login-brand-foot">
            <span><IconApprove /> Controlled &amp; traceable</span>
            <span>Quality Assurance Department - IT</span>
          </div>
        </aside>

        <div className="login-card">
          <div className="login-mobile-brand">
            <img className="qualityops-app-logo" src="/qualityops-logo.png" alt="" aria-hidden="true" />
            <div><strong>Quality<em>Ops</em></strong><img className="bank-wordmark mobile-bank-wordmark" src="/bank-of-maharashtra-wordmark.png" alt="Bank of Maharashtra" /></div>
          </div>

          <div className="login-card-head">
            <div className="login-security-mark"><IconLock /></div>
            <p className="login-kicker">Secure portal access</p>
            <h2>Welcome back</h2>
            <p className="sub">Sign in with your assigned credentials to continue.</p>
          </div>

          <form onSubmit={onSubmit} className="login-form">
            <div className="login-field">
              <label htmlFor="login-username">Username</label>
              <div className="login-input-wrap">
                <IconUsers />
                <input
                  id="login-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  required
                />
              </div>
            </div>

            <div className="login-field">
              <div className="login-label-row"><label htmlFor="login-password">Password</label><span>Case sensitive</span></div>
              <div className="login-input-wrap">
                <IconLock />
                <input id="login-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                <button className="password-toggle" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
                  <IconEyeOff />
                </button>
              </div>
            </div>

            <ErrorText
              error={error}
              title="Sign-in failed"
              guidance="Verify your username and password, confirm that your account is active, and try signing in again."
            />

            <button className="login-submit" type="submit" disabled={busy}>
              <span>{busy ? 'Signing you in…' : 'Sign in to QualityOps'}</span>
              {!busy && <span aria-hidden="true">→</span>}
            </button>
          </form>

          <p className="login-help">Need access? Contact your QualityOps administrator.</p>
          {/* Reported directly: "Help & user Manual should come on login page
              as well, without login atleast user can read" -- links to the
              same /help route signed-in users use, which now also works
              signed out (see App.tsx's HelpRoute/PublicHelp). */}
          <p className="login-help"><Link to="/help">Help &amp; User Manual</Link></p>
        </div>
      </section>

      <footer className="login-page-footer">
        Developed By <strong>Soumyajit Pal</strong><span>•</span>Quality Assurance Department - IT
        <span>•</span>© 2026 All rights reserved.
      </footer>
    </main>
  )
}
