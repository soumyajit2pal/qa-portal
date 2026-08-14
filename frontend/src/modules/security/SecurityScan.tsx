import React, { useState } from 'react'
import { ErrorText, Field, Modal } from '../../components/Common'
import { SecurityScanResultOut } from '../../types'

export function SecurityScanDialog({ kind, initialApplicationName, busy, error, onClose, onStart }: {
  kind: 'SAST' | 'DAST'
  initialApplicationName?: string | null
  busy: boolean
  error: unknown
  onClose: () => void
  onStart: (applicationName: string, applicationVersion: string) => Promise<void>
}) {
  const [applicationName, setApplicationName] = useState(initialApplicationName || '')
  const [applicationVersion, setApplicationVersion] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!applicationName.trim() || !applicationVersion.trim()) return
    await onStart(applicationName.trim(), applicationVersion.trim())
  }

  return (
    <Modal title={`Start ${kind} Scan`} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose wide>
      <form className="security-scan-start" onSubmit={submit} aria-busy={busy}>
        <div className="security-scan-intro">
          <strong>Import the matching Fortify SSC analysis</strong>
          <span>Enter the exact Application Name and Version used in Fortify. QualityShield will validate them, import the severity summary, and then move this request to Scanning.</span>
        </div>
        <div className="form-row">
          <Field label="Application Name *">
            <input required autoFocus disabled={busy} value={applicationName} onChange={(event) => setApplicationName(event.target.value)} placeholder="Exact Fortify application name" />
          </Field>
          <Field label="Application Version *">
            <input required disabled={busy} value={applicationVersion} onChange={(event) => setApplicationVersion(event.target.value)} placeholder="For example: 1, 1.1 or 2026.08" />
          </Field>
        </div>
        <p className="muted small">The selected version must already exist and have processed results in Fortify SSC.</p>
        <ErrorText error={error} />
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={busy || !applicationName.trim() || !applicationVersion.trim()}>
            {busy ? <><span className="api-activity-spinner" aria-hidden="true" /> Importing SSC Results…</> : 'Validate & Start Scan'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
        {busy && <div className="security-scan-progress" role="status" aria-live="assertive"><span className="api-activity-spinner" aria-hidden="true" /><div><strong>Connecting to Fortify SSC</strong><span>Resolving the application version and importing filter-set findings. Please keep this dialog open.</span></div></div>}
      </form>
    </Modal>
  )
}

export function SecurityScanResults({ results }: { results: SecurityScanResultOut[] }) {
  if (!results.length) return null
  const latest = results[0]
  return (
    <section className="security-scan-results" aria-label="Fortify SSC scan results">
      <header>
        <div><small>{latest.provider} · Imported result</small><strong>{latest.application_name} <span>v{latest.application_version}</span></strong><p>Imported {new Date(latest.imported_at).toLocaleString()} · Provider version ID {latest.provider_version_id}</p></div>
        {latest.audit_url && <a className="btn btn-sm" href={latest.audit_url} target="_blank" rel="noreferrer">Open in Fortify SSC ↗</a>}
      </header>
      <div className="security-scan-severity-grid">
        <div className="critical"><small>Critical</small><strong>{latest.critical_count}</strong></div>
        <div className="high"><small>High</small><strong>{latest.high_count}</strong></div>
        <div className="medium"><small>Medium</small><strong>{latest.medium_count}</strong></div>
        <div className="low"><small>Low</small><strong>{latest.low_count}</strong></div>
        <div className="total"><small>Total across filters</small><strong>{latest.total_count}</strong></div>
      </div>
      {latest.filters.length > 0 && <div className="security-scan-filter-results">
        <strong>Filter-set analysis</strong>
        <div className="table-wrap"><table><thead><tr><th>Filter</th><th>Total</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>Result</th></tr></thead><tbody>
          {latest.filters.map((filter) => <tr key={filter.guid}><td>{filter.title}</td><td>{filter.total_count}</td><td>{filter.critical_count}</td><td>{filter.high_count}</td><td>{filter.medium_count}</td><td>{filter.low_count}</td><td>{filter.audit_url ? <a href={filter.audit_url} target="_blank" rel="noreferrer">View ↗</a> : '—'}</td></tr>)}
        </tbody></table></div>
      </div>}
      {results.length > 1 && <details className="security-scan-history"><summary>Previous imported scans ({results.length - 1})</summary>{results.slice(1).map((result) => <div key={result.id}><strong>{result.application_name} v{result.application_version}</strong><span>{new Date(result.imported_at).toLocaleString()} · {result.total_count} total</span></div>)}</details>}
    </section>
  )
}
