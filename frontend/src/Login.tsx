import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { IconApprove, IconCertificate, IconEyeOff, IconLock, IconShield, IconUsers, IconWorkflow } from './components/Icons'
import { ErrorText } from './components/Common'

const DEMO_ACCOUNTS: [string, string][] = [
  ['requester1', 'Requester 1 (Developer) / Others'], ['requester1', 'Requester 2 (Developer) / Others'],['ba1', 'Business Analyst'], ['qa1', 'QA Engineer (QA 1)'],['qa2', 'QA Engineer (QA 2)']
  ,['qalead1', 'QA Lead'], ['cm1', 'Executive COE (CM-QA)'],['agm1', 'Executive COE (AGM-QA)'], ['security1', 'Security Analyst (QA)'],
  ['appowner1', 'Application Owner'], ['depthead1', 'Department Head - CM'],['depthead2', 'Department Head - AGM'],
  ['sm1', 'SM'], ['sm2', 'SM With App Owner'], ['admin', 'Administrator'],
]
export default function Login() {
  const [username, setUsername] = useState('requester1')
  const [password, setPassword] = useState('Password@123')
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
      await login(username, password)
      navigate('/')
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  function chooseDemoAccount(value: string) {
    if (!value) return
    setUsername(value)
    setPassword('Password@123')
    setError(null)
  }

  return (
    <main className="login-page">
      <div className="login-ambient login-ambient-one" />
      <div className="login-ambient login-ambient-two" />

      <section className="login-shell" aria-label="QualityHub sign in">
        <aside className="login-brand">
          <div className="login-brand-top">
            <span className="bank-logo login-bank-logo" role="img" aria-label="Bank of Maharashtra logo" />
            <div className="brand-name">
              <strong>Bank of Maharashtra</strong>
              <span>QualityHub · Enterprise QA Portal</span>
            </div>
          </div>

          <div className="login-brand-copy">
            <div className="eyebrow"><span /> Built for confident releases</div>
            <h1>Quality, governed<br />from start to sign-off.</h1>
            <p>One secure workspace for QA requests, testing, evidence, approvals, and release readiness.</p>

            <div className="login-capabilities">
              <div><span><IconWorkflow /></span><strong>Orchestrated workflows</strong><small>Track every request through a clear, governed lifecycle.</small></div>
              <div><span><IconShield /></span><strong>Security built in</strong><small>SAST, DAST, and suppression reviews in one place.</small></div>
              <div><span><IconCertificate /></span><strong>Audit-ready sign-off</strong><small>Decisions and evidence remain complete and traceable.</small></div>
            </div>
          </div>

          <div className="login-brand-foot">
            <span><IconApprove /> Controlled &amp; traceable</span>
            <span>Quality Assurance Department - IT</span>
          </div>
        </aside>

        <div className="login-card">
          <div className="login-mobile-brand">
            <span className="bank-logo" role="img" aria-label="Bank of Maharashtra logo" />
            <div><strong>QualityHub</strong><small>Bank of Maharashtra</small></div>
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
                <input id="login-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
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
              <span>{busy ? 'Signing you in…' : 'Sign in to QualityHub'}</span>
              {!busy && <span aria-hidden="true">→</span>}
            </button>
          </form>

          <div className="login-divider"><span>Demo environment</span></div>
          <div className="demo-access">
            <div><strong>Explore by role</strong><small>Credentials are filled automatically.</small></div>
            <select value={DEMO_ACCOUNTS.some(([u]) => u === username) ? username : ''} onChange={(e) => chooseDemoAccount(e.target.value)} aria-label="Choose a demo role">
              <option value="">Choose role</option>
              {DEMO_ACCOUNTS.map(([user, role]) => <option value={user} key={user}>{role}</option>)}
            </select>
          </div>

          <p className="login-help">Need access? Contact your QualityHub administrator.</p>
          {/* Reported directly: "Help & user Manual should come on login page
              as well, without login atleast user can read" -- links to the
              same /help route signed-in users use, which now also works
              signed out (see App.tsx's HelpRoute/PublicHelp). */}
          <p className="login-help"><Link to="/help">Help &amp; User Manual</Link></p>
        </div>
      </section>

      <footer className="login-page-footer">
        Developed By <strong>Soumyajit Pal</strong><span>•</span>Quality Assurance Department - IT
      </footer>
    </main>
  )
}
