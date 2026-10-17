import React, { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Modal } from './Common'
import AppVersion from './AppVersion'
import VendorOrganizationSelect, { VendorSelection, validVendorSelection } from './VendorOrganizationSelect'

export default function VendorOrganizationPrompt() {
  const { user, logout, refreshUser } = useAuth()
  const [selection, setSelection] = useState<VendorSelection>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !validVendorSelection(selection)) return
    setBusy(true); setError(null)
    try {
      if (!saved) {
        await api.patch('/api/auth/me/vendor-organization', selection)
        setSaved(true)
      }
      await refreshUser()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  async function checkProfile() {
    setBusy(true); setError(null)
    try { await refreshUser() } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <Modal title="Set up your vendor profile" onClose={logout} preventBackdropClose closeDisabled={busy} hideClose variant="dialog" className="vendor-profile-dialog">
    <div className="vendor-profile-intro">
      <span className="vendor-profile-kicker">One-time setup</span>
      <p>Hi {user?.full_name || 'there'}, which organization do you work for?</p>
      <span>This identifies your company in QualityOps.</span>
    </div>
    <form onSubmit={save} aria-busy={busy}>
      <div className="vendor-profile-fields">
        <VendorOrganizationSelect value={selection} onChange={setSelection} disabled={busy || saved} />
        {!!error && <div className="vendor-profile-error" role="alert">
          <strong>{saved ? 'Your organization is saved, but your profile couldn’t be refreshed.' : 'We couldn’t confirm your profile was saved.'}</strong>
          <p>{error instanceof Error ? error.message : String(error)}</p>
          <p>{saved ? 'Select Continue to try opening your profile again.' : 'Your entries are kept. Try saving again, or check whether your profile was saved.'}</p>
        </div>}
        {saved && !error && <p className="vendor-profile-saved" role="status">Your organization is saved. Continue to refresh your profile.</p>}
      </div>
      <div className="vendor-profile-actions"><button type="submit" className="btn btn-primary" disabled={busy || !validVendorSelection(selection)}>{busy ? saved ? 'Opening your profile…' : 'Saving…' : saved ? 'Continue' : 'Save and continue'}</button>{!!error && !saved && <button type="button" className="btn" disabled={busy} onClick={checkProfile}>Check saved profile</button>}<button type="button" className="vendor-text-button" disabled={busy} onClick={logout}>Log out</button></div>
    </form>
    <div className="access-pending-version"><AppVersion /></div>
  </Modal>
}
