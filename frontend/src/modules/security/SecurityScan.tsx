import React, { useState } from 'react'
import { ErrorText, Field, Modal } from '../../components/Common'
import { SecurityScanResultOut, SecurityScanSummaryOut } from '../../types'

export function SecurityScanDialog({ kind, mode = 'start', initialApplicationName, initialApplicationVersion, busy, error, onClose, onStart }: {
  kind: 'SAST' | 'DAST'
  // 2026-08 "Findings Validation" doc -- Rescan re-uses this exact dialog
  // (same Application Name/Version identity, same SSC import call) rather
  // than a separate form; `mode` only changes copy/labels and whether the
  // fields start prefilled from the latest scan (Rescan) or blank (Start).
  mode?: 'start' | 'rescan'
  initialApplicationName?: string | null
  initialApplicationVersion?: string | null
  busy: boolean
  error: unknown
  onClose: () => void
  onStart: (applicationName: string, applicationVersion: string) => Promise<void>
}) {
  const [applicationName, setApplicationName] = useState(initialApplicationName || '')
  const [applicationVersion, setApplicationVersion] = useState(initialApplicationVersion || '')
  const isRescan = mode === 'rescan'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!applicationName.trim() || !applicationVersion.trim()) return
    await onStart(applicationName.trim(), applicationVersion.trim())
  }

  return (
    <Modal title={isRescan ? `Rescan ${kind} Request` : `Start ${kind} Scan`} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose wide>
      <form className="security-scan-start" onSubmit={submit} aria-busy={busy}>
        <div className="security-scan-intro">
          <strong>{isRescan ? 'Re-import the latest Fortify SSC analysis' : 'Import the matching Fortify SSC analysis'}</strong>
          <span>
            {isRescan
              ? 'Confirm (or update) the Application Name and Version, then re-check Fortify SSC for the latest results. This creates a new scan record -- the previous scan stays exactly as it was.'
              : 'Enter the exact Application Name and Version used in Fortify. QualityOps will validate them, import the severity summary, and then move this request to Scanning.'}
          </span>
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
            {busy ? <><span className="api-activity-spinner" aria-hidden="true" /> Importing SSC Results…</> : (isRescan ? 'Rescan' : 'Validate & Start Scan')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
        {busy && <div className="security-scan-progress" role="status" aria-live="assertive"><span className="api-activity-spinner" aria-hidden="true" /><div><strong>Connecting to Fortify SSC</strong><span>Resolving the application version and importing filter-set findings. Please keep this dialog open.</span></div></div>}
      </form>
    </Modal>
  )
}

function severityBreakdown(scan: SecurityScanResultOut) {
  return (
    <div className="security-scan-severity-grid">
      <div className="critical"><small>Critical</small><strong>{scan.critical_count}</strong></div>
      <div className="high"><small>High</small><strong>{scan.high_count}</strong></div>
      <div className="medium"><small>Medium</small><strong>{scan.medium_count}</strong></div>
      <div className="low"><small>Low</small><strong>{scan.low_count}</strong></div>
      <div className="total"><small>Total</small><strong>{scan.total_count}</strong></div>
    </div>
  )
}

// 2026-08 "Findings Validation" requirement doc -- the full spec (4.1 Scan
// Summary, 4.2 Findings Display, 4.3 Scan History, 4.4 Action Buttons),
// replacing the old single-latest-result view. `summary`/`results` both come
// from routers/sast_dast.py's new scan-summary/scan-results endpoints.
// Action buttons are rendered here (rather than back in SAST.tsx/DAST.tsx's
// own action bar) so both modules automatically stay in sync -- one shared
// component, matching this file's existing SecurityScanDialog convention.
export function SecurityScanResults({
  kind, results, summary, canAct, busy, suppressionPending, suppressionPendingMessage,
  onRescan, onMarkComplete, onInitiateSuppression,
}: {
  kind: 'SAST' | 'DAST'
  results: SecurityScanResultOut[]
  summary: SecurityScanSummaryOut | null
  canAct: boolean
  busy: boolean
  // 2026-08 doc, 4.4: "If Suppression Pending: Disable [Mark Scan Complete]
  // and show: 'Pending suppression requests exist. Scan cannot be
  // completed.'" -- distinct from the FR-06 block-on-submit error (which
  // still fires too, as a safety net); this is the up-front, before-you-
  // even-try version.
  suppressionPending?: boolean
  suppressionPendingMessage?: string
  onRescan: () => void
  onMarkComplete: () => void
  onInitiateSuppression: () => void
}) {
  if (!results.length || !summary) return null
  const current = summary.current!
  const initial = summary.initial!
  const hasFindings = current.total_count > 0

  return (
    <section className="security-scan-results" aria-label="Fortify SSC scan results">
      <header>
        <div><small>{current.provider} · Latest imported result</small><strong>{current.application_name} <span>v{current.application_version}</span></strong><p>Imported {new Date(current.imported_at).toLocaleString()} · Provider version ID {current.provider_version_id}</p></div>
        {current.audit_url && <a className="btn btn-sm" href={current.audit_url} target="_blank" rel="noreferrer">Open in Fortify SSC ↗</a>}
      </header>

      {/* 4.1 Scan Summary */}
      <div className="security-scan-summary-grid">
        <div><small>Initial Scan Findings</small><strong>{initial.total_count}</strong></div>
        <div><small>Current Scan Findings</small><strong>{current.total_count}</strong></div>
        <div><small>Total Rescans</small><strong>{summary.total_rescans}</strong></div>
        <div><small>Open Findings</small><strong>{summary.open_findings}</strong></div>
        <div><small>Suppressed Findings</small><strong>{summary.suppressed_findings}</strong></div>
      </div>

      {/* 4.2 Findings Display -- Initial vs Current shown separately */}
      <div className="security-scan-findings-compare">
        <div>
          <strong>Initial Scan Findings</strong>
          {severityBreakdown(initial)}
        </div>
        <div>
          <strong>Current Scan Findings</strong>
          {severityBreakdown(current)}
        </div>
      </div>

      {current.filters.length > 0 && <div className="security-scan-filter-results">
        <strong>Filter-set analysis (latest scan)</strong>
        <div className="table-wrap"><table><thead><tr><th>Filter</th><th>Total</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>Result</th></tr></thead><tbody>
          {current.filters.map((filter) => <tr key={filter.guid}><td>{filter.title}</td><td>{filter.total_count}</td><td>{filter.critical_count}</td><td>{filter.high_count}</td><td>{filter.medium_count}</td><td>{filter.low_count}</td><td>{filter.audit_url ? <a href={filter.audit_url} target="_blank" rel="noreferrer">View ↗</a> : '—'}</td></tr>)}
        </tbody></table></div>
      </div>}

      {/* 4.3 Scan History */}
      <div className="security-scan-history-table">
        <strong>Scan History</strong>
        <div className="table-wrap"><table><thead><tr><th>Scan No</th><th>Type</th><th>Scan Date</th><th>Findings</th><th>Status</th></tr></thead><tbody>
          {results.map((r) => <tr key={r.id}><td>{r.scan_no}</td><td>{r.scan_type}</td><td>{new Date(r.imported_at).toLocaleDateString()}</td><td>{r.total_count}</td><td>{r.status}</td></tr>)}
        </tbody></table></div>
      </div>

      {/* 4.4 Action Buttons */}
      {canAct && (
        <div className="security-scan-actions">
          {hasFindings ? (
            <>
              <button className="btn btn-sm" disabled={busy} onClick={onRescan}>Rescan</button>
              <button className="btn btn-sm" disabled={busy} onClick={onInitiateSuppression}>Initiate Suppression Request</button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" disabled={busy || suppressionPending} onClick={onMarkComplete}>Mark Scan Complete</button>
          )}
          {suppressionPending && (
            <p className="security-scan-suppression-blocked">
              Pending suppression requests exist. Scan cannot be completed.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
