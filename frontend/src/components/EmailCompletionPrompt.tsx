import React, { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { ErrorText, Modal } from './Common'

// LDAP authentication can succeed even when the directory's mail attribute
// is blank. This modal is deliberately non-dismissible: workflow mail is a
// core control, so an approved user must provide their own notification
// address before the portal exposes any operational data.
export default function EmailCompletionPrompt() {
  const { user, logout, refreshUser } = useAuth()
  const [email, setEmail] = useState(user?.email || '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

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
    <Modal title="Add your notification email" onClose={logout} preventBackdropClose variant="dialog">
      <p className="muted small" style={{ marginTop: -4, marginBottom: 16 }}>
        Your LDAP account has been approved, but no email address was received from the directory. Add the address where QA Portal should send your workflow notifications.
      </p>
      <form onSubmit={save}>
        <label className="field">
          <span>Notification email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value.toLowerCase())}
            placeholder="name@example.com"
            autoCapitalize="none"
            autoComplete="email"
            spellCheck={false}
            required
            disabled={busy}
            autoFocus
          />
        </label>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
            {busy ? 'Saving…' : 'Save email and continue'}
          </button>
          <button type="button" className="btn" onClick={logout} disabled={busy}>Log out</button>
        </div>
      </form>
    </Modal>
  )
}
