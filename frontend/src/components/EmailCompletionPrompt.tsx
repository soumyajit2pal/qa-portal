import React, { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { ErrorText, Modal } from './Common'
import AppVersion from './AppVersion'

// Confirm directory-provided email once, with correction permitted during
// onboarding. Also retain the existing approved-user missing-email recovery.
export default function EmailCompletionPrompt() {
  const { user, logout, refreshUser } = useAuth()
  const [email, setEmail] = useState(user?.email || '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const suppliedEmail = user?.email?.trim() || ''
  const unchanged = email.trim().toLowerCase() === suppliedEmail.toLowerCase()

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.patch('/api/auth/me/email', { email: email.trim().toLowerCase() })
      await refreshUser()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={suppliedEmail ? 'Confirm your notification email' : 'Add your notification email'} onClose={logout} preventBackdropClose variant="dialog">
      <p className="muted small" style={{ marginTop: -4, marginBottom: 16 }}>
        {suppliedEmail
          ? 'Check the email address below. If it is correct, confirm it. If it is wrong, replace it with your correct email address before continuing.'
          : 'No email address was received for your LDAP account. Add the address where QA Portal should send your workflow notifications.'}
      </p>
      <form onSubmit={save}>
        <label className="form-field email-confirmation-field">
          <span>Notification email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value.toLowerCase())}
            placeholder="name@example.com"
            autoCapitalize="none"
            autoComplete="email"
            spellCheck={false}
            maxLength={150}
            required
            disabled={busy}
            autoFocus
          />
        </label>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
            {busy ? 'Saving…' : suppliedEmail && unchanged ? 'Confirm email and continue' : 'Save email and continue'}
          </button>
          <button type="button" className="btn" onClick={logout} disabled={busy}>Log out</button>
        </div>
      </form>
      <div className="access-pending-version"><AppVersion /></div>
    </Modal>
  )
}
