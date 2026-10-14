import React, { useEffect, useState } from 'react'
import { api, HttpError } from '../../api'
import { Card, ErrorText } from '../../components/Common'
import type { ApplicationCreationPolicyOut } from '../../types'

const PATH = '/api/system-settings/application-creation'

export default function ApplicationCreationSettings() {
  const [policy, setPolicy] = useState<ApplicationCreationPolicyOut | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)

  function apply(value: ApplicationCreationPolicyOut) { setPolicy(value); setEnabled(value.enabled) }
  async function load() {
    setBusy(true); setError(null); setSaved(false)
    try { apply(await api.getFresh<ApplicationCreationPolicyOut>(PATH)) }
    catch (err) { setPolicy(null); setError(err) }
    finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])

  async function save() {
    if (!policy) return
    setBusy(true); setError(null); setSaved(false)
    try {
      apply(await api.put<ApplicationCreationPolicyOut>(PATH, { enabled, expected_revision: policy.revision }))
      setSaved(true)
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        try {
          apply(await api.getFresh<ApplicationCreationPolicyOut>(PATH))
          setError(new Error('Another administrator changed this setting. The latest value is loaded; review it before saving again.'))
        } catch (refreshError) { setPolicy(null); setError(refreshError) }
      } else setError(err)
    } finally { setBusy(false) }
  }

  return <Card title="New application creation">
    <ErrorText error={error} />
    <p>Control whether users can propose a new application through “Other (new application)” when raising or editing requests. This setting applies to every workspace.</p>
    <p className="muted small">Disabled by default. Existing applications, saved proposals and approval history remain available. Administrators can add applications to the approved list below.</p>
    <label><input type="checkbox" checked={enabled} disabled={busy || !policy} onChange={event => { setEnabled(event.target.checked); setSaved(false) }} /> Enable “Other (new application)”</label>
    {policy && <p className="muted small">Current saved setting: {policy.enabled ? 'Enabled' : 'Disabled'}</p>}
    {saved && <p role="status">Application creation setting saved.</p>}
    <div style={{ display:'flex', gap:8, marginTop:12 }}>
      <button type="button" className="btn btn-primary" disabled={busy || !policy || enabled === policy.enabled} onClick={save}>{busy ? 'Loading / saving…' : 'Save setting'}</button>
      <button type="button" className="btn" disabled={busy} onClick={load}>Refresh setting</button>
    </div>
  </Card>
}
