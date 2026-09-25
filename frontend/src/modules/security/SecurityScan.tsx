import { useRequestNavigation } from '../../hooks/useRequestNavigation'
import React, { useCallback, useEffect, useState } from 'react'

import { api } from '../../api'
import { formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { hasWorkflowRole as hasRole, SUPPRESSION_REQUESTER_CONTROLLED_STATUSES, SUPPRESSION_TERMINAL_STATUSES } from '../../constants'
import { EmptyState, ErrorText, Field, Modal, Table, TableColumn } from '../../components/Common'
import { SecurityScanResultOut, SecurityScanSummaryOut, SuppressionOut } from '../../types'

// One row per scan and Fortify filter set in Scan History
// section below. A plain flat row shape (rather than nesting filters inside
// a scan_no group) so the shared Table component's per-column filter
// dropdowns and Columns toggle (reported directly: "in table filter option
// is missing" -- this table used to be a hand-rolled <table>, without them)
// work the same way here as everywhere else in the app.
interface ScanHistoryRow {
  id: string
  scan_no: number
  scan_type: string
  filter_title: string
  imported_at: string
  critical_count: number
  high_count: number
  medium_count: number
  low_count: number
  total_count: number
  status: string
  targets: string
}

const SCAN_HISTORY_COLUMNS: TableColumn<ScanHistoryRow>[] = [
  { key: 'scan_no', header: 'Scan No' },
  { key: 'scan_type', header: 'Type' },
  { key: 'targets', header: 'Scanned Targets' },
  { key: 'filter_title', header: 'Filter' },
  { key: 'imported_at', header: 'Imported At', render: (r) => formatDateTimeIST(r.imported_at) },
  { key: 'critical_count', header: 'Critical' },
  { key: 'high_count', header: 'High' },
  { key: 'medium_count', header: 'Medium' },
  { key: 'low_count', header: 'Low' },
  { key: 'total_count', header: 'Total' },
  { key: 'status', header: 'Status' },
]

function targetNeedsRemediation(id: number | undefined, scans: SecurityScanResultOut[]) {
  const previous = id == null ? scans[0] : scans.find(scan => scan.targets.some(target => target.id === id))
  return !previous || Math.max(previous.total_count || 0, ...previous.filters.map(filter => filter.total_count || 0)) > 0
}

export function SecurityFixDialog({ kind, targets, currentScans, onClose, onSubmit }: {
  kind: 'SAST' | 'DAST'
  targets: { id: number; label: string; previousCommit?: string | null }[]
  currentScans: SecurityScanResultOut[]
  onClose: () => void
  onSubmit: (targets: { target_id: number; commit_id: string }[]) => Promise<void>
}) {
  const [rows, setRows] = useState(() => targets.filter(target => targetNeedsRemediation(target.id, currentScans)).map(target => ({ ...target, commitId: '' })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const complete = rows.length > 0 && rows.every(row => row.commitId.trim())

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!complete || busy) return
    setBusy(true); setError(null)
    try {
      await onSubmit(rows.map(row => ({ target_id: row.id, commit_id: row.commitId.trim() })))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return <Modal title={`Mark ${kind} Fixes Complete`} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose wide>
    <form className="security-scan-start" onSubmit={submit} aria-busy={busy}>
      <div className="security-scan-intro"><strong>Identify the code containing each fix</strong><span>{kind === 'SAST' ? 'Enter the latest commit ID or code hash for each repository awaiting remediation.' : 'Enter the source commit ID or deployed artifact hash containing the fix for each application URL.'} These references will be recorded with your name and submission date in the activity history.</span></div>
      {targets.length > rows.length && <p className="muted small">Already-clear targets remain unchanged and do not require a new code reference.</p>}
      {rows.map((row, index) => <div className="security-scan-target-row" key={row.id}>
        <strong>{row.label}</strong>
        {row.previousCommit && <p className="muted small">Previously recorded commit: {row.previousCommit}</p>}
        <Field label="Latest commit ID / code hash *"><input required maxLength={500} autoFocus={index === 0} disabled={busy} value={row.commitId} onChange={event => setRows(current => current.map(target => target.id === row.id ? { ...target, commitId: event.target.value } : target))} placeholder="Commit ID or code/artifact hash" /></Field>
      </div>)}
      {!rows.length && <p>No target is awaiting remediation. Refresh the findings before continuing.</p>}
      <p className="muted small">Submitting returns the request to the assigned Security Analyst for rescan.</p>
      <ErrorText error={error} />
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !complete}>{busy ? 'Submitting…' : 'Mark Fixed & Send for Rescan'}</button><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}

export function SecurityScanDialog({ kind, mode = 'start', initialApplicationName, targets, initialScans, busy, error, onClose, onStart }: {
  kind: 'SAST' | 'DAST'
  // 2026-08 "Findings Validation" doc -- Rescan re-uses this exact dialog
  // (same Application Name/Version identity, same SSC import call) rather
  // than a separate form; `mode` only changes copy/labels and whether the
  // fields start prefilled from the latest scan (Rescan) or blank (Start).
  mode?: 'start' | 'rescan'
  initialApplicationName?: string | null
  targets: { id: number; label: string; detail?: string | null }[]
  initialScans?: SecurityScanResultOut[]
  busy: boolean
  error: unknown
  onClose: () => void
  onStart: (scans: { target_id: number; application_name: string; application_version: string }[]) => Promise<void>
}) {
  const previousByTarget = new Map((initialScans || []).flatMap(scan => scan.targets.map(target => [target.id, scan] as const)))
  const isRescan = mode === 'rescan'
  const pendingTargets = targets.filter(target => {
    if (!isRescan) return true
    return targetNeedsRemediation(target.id, initialScans || [])
  })
  const retainedTargets = targets.filter(target => !pendingTargets.some(pending => pending.id === target.id))
  const [rows, setRows] = useState(() => pendingTargets.map(target => {
    const previous = previousByTarget.get(target.id)
    return { ...target, applicationName: previous?.application_name || initialApplicationName || '', applicationVersion: previous?.application_version || '' }
  }))

  function update(id: number, values: Partial<(typeof rows)[number]>) {
    setRows(current => current.map(row => row.id === id ? { ...row, ...values } : row))
  }

  const complete = rows.length > 0 && rows.every(row => row.applicationName.trim() && row.applicationVersion.trim())

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!complete) return
    await onStart(rows.map(row => ({ target_id: row.id, application_name: row.applicationName.trim(), application_version: row.applicationVersion.trim() })))
  }

  return (
    <Modal title={isRescan ? `Rescan ${kind} Request` : `Start ${kind} Scan`} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose wide>
      <form className="security-scan-start" onSubmit={submit} aria-busy={busy}>
        <div className="security-scan-intro">
          <strong>{isRescan ? 'Re-import the latest Fortify SSC analysis' : 'Import the matching Fortify SSC analysis'}</strong>
          <span>
            {isRescan
              ? 'Only targets with findings pending are rescanned. Confirm their Fortify Application Name and Version.'
              : 'Select the targets scanned and enter the exact Fortify Application Name and Version for each one. Every target is imported independently.'}
          </span>
        </div>
        <fieldset className="security-scan-targets">
          <legend>{kind === 'SAST' ? 'Repository scans *' : 'URL scans *'}</legend>
          <p className="muted small">{isRescan ? 'Each pending target produces its own new result and history entry.' : 'Every configured target requires a separate Fortify scan and produces its own findings.'}</p>
          {retainedTargets.length > 0 && <p className="muted small">Already clear — latest results retained, no new scan history: {retainedTargets.map(target => target.label).join(', ')}</p>}
          {rows.length ? rows.map((row, index) => (
            <div className="security-scan-target-row" key={row.id}>
              <div className="security-scan-target-choice"><span><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</span></div>
              <div className="form-row">
                <Field label="Fortify Application Name *"><input autoFocus={index === 0} required disabled={busy} value={row.applicationName} onChange={event => update(row.id, { applicationName: event.target.value })} placeholder="Exact Fortify application name" /></Field>
                <Field label="Fortify Application Version *"><input required disabled={busy} value={row.applicationVersion} onChange={event => update(row.id, { applicationVersion: event.target.value })} placeholder="For example: 1, 1.1 or 2026.08" /></Field>
              </div>
            </div>
          )) : <span className="muted">{isRescan ? 'Every target is already clear. No rescan is required.' : 'No configured scan target is available. Add one in request details before starting the scan.'}</span>}
        </fieldset>
        <p className="muted small">Every selected application/version must already exist and have processed results in Fortify SSC. Nothing is saved if any target import fails.</p>
        <ErrorText error={error} />
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={busy || !complete}>
            {busy ? <><span className="api-activity-spinner" aria-hidden="true" /> Importing SSC Results…</> : (isRescan ? 'Rescan' : 'Validate & Start Scan')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
        {busy && <div className="security-scan-progress" role="status" aria-live="assertive"><span className="api-activity-spinner" aria-hidden="true" /><div><strong>Connecting to Fortify SSC</strong><span>Resolving the application version and importing filter-set findings. Please keep this dialog open.</span></div></div>}
      </form>
    </Modal>
  )
}

const FINDING_COUNT_COLUMNS = ['critical_count', 'high_count', 'medium_count', 'low_count', 'total_count'] as const

function TargetFindings({ scan, initialScan }: { scan: SecurityScanResultOut; initialScan?: SecurityScanResultOut }) {
  const pending = targetNeedsRemediation(scan.targets?.[0]?.id, [scan])
  const filtersFor = (result?: SecurityScanResultOut) => !result ? [] : result.filters.length ? result.filters : [{ ...result, title: 'Security Auditor View', guid: 'auditor' }]
  const currentFilters = filtersFor(scan)
  const initialFilters = filtersFor(initialScan)
  const views = [...new Set([...currentFilters, ...initialFilters].map(filter => filter.title))]
  const suppressed = {
    critical_count: scan.suppressed_critical_count ?? 0,
    high_count: scan.suppressed_high_count ?? 0,
    medium_count: scan.suppressed_medium_count ?? 0,
    low_count: scan.suppressed_low_count ?? 0,
    total_count: scan.suppressed_total_count ?? 0,
  }

  return <details className={`security-findings-target ${pending ? 'is-pending' : 'is-clear'}`} open={pending}>
    <summary>
      <span className="security-findings-target-identity"><strong>{scan.targets?.[0]?.label || 'Legacy target not captured'}</strong><small>{scan.application_name} · Version {scan.application_version}</small></span>
      <span className={`security-findings-target-status ${pending ? 'pending' : 'clear'}`}>{pending ? 'Fix pending' : 'Clear · no rescan needed'}</span>
      <span className="security-findings-expand" aria-hidden="true">⌄</span>
    </summary>
    <div className="security-findings-target-body">
      <div className="security-findings-target-context">
        <span><small>Initial import</small>{initialScan ? formatDateTimeIST(initialScan.imported_at) : 'Not captured'}</span>
        <span><small>Latest import</small>{formatDateTimeIST(scan.imported_at)}</span>
        {scan.audit_url && <a href={scan.audit_url} target="_blank" rel="noreferrer">Review in Fortify SSC ↗</a>}
      </div>
      {scan.targets?.[0]?.detail && <p className="security-findings-code-reference">Scanned reference: {scan.targets[0].detail}</p>}
      <div className="security-findings-comparison-scroll">
        <table className="security-findings-comparison">
          <caption>Initial and current findings for this target, separated by Fortify view</caption>
          <thead><tr><th scope="col">Fortify view</th><th scope="col">Result</th><th scope="col">Critical</th><th scope="col">High</th><th scope="col">Medium</th><th scope="col">Low</th><th scope="col">Total</th></tr></thead>
          <tbody>
            {views.map(view => {
              const first = initialFilters.find(filter => filter.title === view)
              const latest = currentFilters.find(filter => filter.title === view)
              return <React.Fragment key={view}>
                <tr className="initial"><th scope="rowgroup" rowSpan={2}>{view}</th><th scope="row">Initial</th>{FINDING_COUNT_COLUMNS.map(key => <td key={key}>{first ? first[key] : '—'}</td>)}</tr>
                <tr className="current"><th scope="row">Current</th>{FINDING_COUNT_COLUMNS.map(key => <td className={key.replace('_count', '')} key={key}>{latest ? latest[key] : '—'}</td>)}</tr>
              </React.Fragment>
            })}
            <tr className="suppressed"><th scope="row">Suppressed · Auditor view</th><th scope="row">Current</th>{FINDING_COUNT_COLUMNS.map(key => <td key={key}>{suppressed[key]}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="security-findings-note">Suppressed findings are separate from active counts. “—” means this view was not captured in that import.</p>
    </div>
  </details>
}

const FINDINGS_NEXT_STEP: Record<string, { title: string; description: string }> = {
  SCANNING: {
    title: 'Validate the imported findings',
    description: 'Review the Fortify results in Findings, then validate them before the request can continue.',
  },
  REMEDIATION: {
    title: 'Send validated findings for remediation',
    description: 'Review the validated findings, then assign the request to the requester for remediation.',
  },
  WAITING_FOR_FIX: {
    title: 'Review and resolve the active findings',
    description: 'Use Findings to review what must be fixed, mark remediation complete, or raise a suppression request where appropriate.',
  },
  RESCAN: {
    title: 'Review the findings and start the rescan',
    description: 'Confirm the remediation context in Findings, then import the latest Fortify scan results.',
  },
}

/** Keeps the post-scan workflow discoverable when a request is reopened on Overview. */
export function SecurityFindingsNextAction({
  status,
  activeCount,
  suppressedCount,
  hasWorkflowAction,
  onOpen,
}: {
  status: string
  activeCount: number
  suppressedCount: number
  hasWorkflowAction: boolean
  onOpen: () => void
}) {
  const nextStep = FINDINGS_NEXT_STEP[status] || {
    title: 'Review the latest scan findings',
    description: 'Open Findings to view the latest Fortify results, suppressed findings, and scan history.',
  }

  return (
    <section className="security-findings-next-action" aria-labelledby="security-findings-next-action-title">
      <div className="security-findings-next-action-icon" aria-hidden="true">!</div>
      <div className="security-findings-next-action-copy">
        <small>NEXT ACTION · FINDINGS</small>
        <strong id="security-findings-next-action-title">{nextStep.title}</strong>
        <p>{nextStep.description}</p>
        <div className="security-findings-next-action-counts" aria-label={`${activeCount} active and ${suppressedCount} suppressed findings`}>
          <span><b>{activeCount}</b> active</span>
          <span><b>{suppressedCount}</b> suppressed</span>
        </div>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={onOpen}>
        {hasWorkflowAction ? 'Continue in Findings' : 'Review Findings'} <span aria-hidden="true">→</span>
      </button>
    </section>
  )
}

/** Persistent ownership context while validated findings are with the requester. */
export function SecurityRemediationAssignment({ requesterName, activeCount, viewerOwnsAction }: {
  requesterName: string
  activeCount: number
  viewerOwnsAction: boolean
}) {
  return (
    <section className="security-remediation-assignment" role="status" aria-label="Current remediation assignment">
      <div className="security-remediation-assignment-icon" aria-hidden="true">R</div>
      <div className="security-remediation-assignment-copy">
        <small>REMEDIATION IN PROGRESS · ACTION WITH REQUESTER</small>
        <strong>Currently assigned to {requesterName}</strong>
        <p>
          {activeCount} active {activeCount === 1 ? 'finding requires' : 'findings require'} remediation.
          {' '}The requester must fix the findings or obtain an approved suppression, then select <b>Mark Fixed</b> to return the request for rescan.
        </p>
        <div className="security-remediation-flow" aria-label="Remediation workflow">
          <span className="complete">✓ Findings validated</span>
          <span aria-hidden="true">→</span>
          <span className="current">Requester remediation</span>
          <span aria-hidden="true">→</span>
          <span>Security rescan</span>
        </div>
        <em>{viewerOwnsAction
          ? 'You currently own the next action.'
          : 'No Security action is required until the requester returns the request for rescan.'}</em>
      </div>
    </section>
  )
}

// 2026-08, reported directly: "if supression request then link that
// request with that sast request, which should be linkable ... give
// option to link and delink supression request from sast request and
// supression both." -- the SAST/DAST-side counterpart to Suppression.tsx's
// own Relink control (opened from the requester's suppression detail
// view): picks one of the requester's own Draft/Returned suppression requests
// and points it at *this* SAST/DAST request instead, via the same backend
// relink_suppression endpoint. Only requester-controlled Draft/Returned
// requests are candidates because relinking restarts approval from Draft.
export function LinkSuppressionModal({ kind, requestId, requestLabel, onClose, onLinked }: {
  kind: 'SAST' | 'DAST'
  requestId: number
  requestLabel: string
  onClose: () => void
  onLinked: (s: SuppressionOut) => void
}) {
  const { user } = useAuth()
  const navigate = useRequestNavigation()
  const [suppressions, setSuppressions] = useState<SuppressionOut[]>([])
  const [selectedId, setSelectedId] = useState<number | ''>('')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const loadSuppressions = useCallback(async () => {
    setLoaded(false)
    setLoadError(null)
    try { setSuppressions(await api.get<SuppressionOut[]>('/api/suppressions')) }
    catch (err) { setLoadError(err) }
    finally { setLoaded(true) }
  }, [])
  useEffect(() => { void loadSuppressions() }, [loadSuppressions])

  function isAlreadyLinkedHere(s: SuppressionOut): boolean {
    return (kind === 'SAST' ? s.sast_request_id : s.dast_request_id) === requestId
  }
  // Same requester-or-admin scoping as everywhere else in the suppression
  // flow (Only the requester of the linked request -- or Admin -- can
  // raise/relink a suppression). A reviewer-owned request is deliberately
  // excluded: relinking changes its approval scope and must happen only
  // while the requester owns the next action.
  const candidates = suppressions.filter((s) =>
    (s.created_by_id === user?.id || hasRole(user, 'ADMIN'))
    && SUPPRESSION_REQUESTER_CONTROLLED_STATUSES.includes(s.status)
    && !isAlreadyLinkedHere(s),
  )
  // Existing requests linked to this scan are history, not relink
  // candidates. Keep terminal requests (especially Done) visible because
  // their approved decision is what authorizes suppression of the finding.
  const linkedHere = suppressions.filter(isAlreadyLinkedHere)

  async function submit() {
    if (!selectedId) { setError(new Error('Select a suppression request to link.')); return }
    setBusy(true)
    setError(null)
    try {
      const updated = await api.post<SuppressionOut>(`/api/suppressions/${selectedId}/relink`, {
        sast_request_id: kind === 'SAST' ? requestId : null,
        dast_request_id: kind === 'DAST' ? requestId : null,
      })
      onLinked(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Link an existing Suppression Request to ${requestLabel}`} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose>
      <p className="muted small">
        Suppression requests already created for this {kind} request are shown below, including completed
        requests. You may also link one of your other Draft or Returned suppression requests to this request;
        doing so restarts that request's approval workflow from Draft.
      </p>
      <div className="security-scan-linked-suppressions">
        <strong>Requests linked to {requestLabel}</strong>
        {!loaded && <p className="muted small">Loading suppression requests…</p>}
        {loaded && linkedHere.length === 0 && <p className="muted small">No suppression request has been created for this {kind} request yet.</p>}
        {linkedHere.map((s) => (
          <div key={s.id} className="security-scan-linked-suppression-row">
            <span><button type="button" className="suppression-id-link" onClick={() => navigate(`/suppression?open=${encodeURIComponent(s.suppression_id)}`)}>{s.suppression_id}</button> — {s.application_name}</span>
            <span className={`badge ${s.status === 'Done' ? 'badge-green' : s.status === 'Rejected' ? 'badge-red' : 'badge-yellow'}`}>{s.status}</span>
          </div>
        ))}
      </div>
      <Field label="Suppression Request *">
        <select value={selectedId} disabled={busy} onChange={(event) => setSelectedId(event.target.value ? Number(event.target.value) : '')}>
          <option value="">Select a suppression request...</option>
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.suppression_id} — {s.application_name} ({s.scan_type}{s.linked_request ? `, currently linked to ${s.linked_request.request_id}` : ''})
            </option>
          ))}
        </select>
      </Field>
      {loaded && candidates.length === 0 && <p className="muted small">No other eligible Draft or Returned suppression requests of yours were found.</p>}
      <ErrorText error={loadError} title="Suppression requests could not be loaded" />
      <ErrorText error={error} />
      {loaded && Boolean(loadError) && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void loadSuppressions()}>Retry loading suppression requests</button>}
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy || !selectedId} onClick={submit}>{busy ? 'Linking...' : 'Link'}</button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

// 2026-08 "Findings Validation" requirement doc -- the full spec (4.1 Scan
// Summary, 4.2 Findings Display, 4.3 Scan History, 4.4 Action Buttons),
// replacing the old single-latest-result view. `summary`/`results` both come
// from routers/sast_dast.py's new scan-summary/scan-results endpoints.
// Action buttons are rendered here (rather than back in SAST.tsx/DAST.tsx's
// own action bar) so both modules automatically stay in sync -- one shared
// component, matching this file's existing SecurityScanDialog convention.
//
// 2026-08, reported directly, full requirement doc pasted with a status-flow
// diagram: this session had earlier built a flatter model where Rescan/Mark
// Scan Complete acted directly from Scanning with no separate validation
// step. That's superseded here -- Finding Validation is a mandatory,
// explicit gate again (Scanning -> Validate Findings -> Security Complete
// or Remediation -> Assign to Requester -> Waiting For Fix -> Mark Fixed ->
// Rescan -> back to Scanning). Each action button below is now gated on the
// SPECIFIC status it's valid from (see sast_dast.py's matching functions),
// not a broad "somewhere in the active-scan window" set -- only one action
// is ever the right one to show at a time.
export function SecurityScanResults({
  kind, results, summary, canValidateFindings, canRescan, canAssignToRequester, canMarkFixed,
  canInitiateSuppression, busy, hasOpenSuppression, openSuppressionIds, requesterActionSuppressionIds, hasDoneSuppression, doneSuppressionIds,
  onValidateFindings, onRescan, onAssignToRequester, onMarkFixed, onInitiateSuppression, onLinkSuppression,
}: {
  kind: 'SAST' | 'DAST'
  results: SecurityScanResultOut[]
  summary: SecurityScanSummaryOut | null
  // Reachable only from Scanning -- the assigned Security Analyst's
  // mandatory "selects Finding Validation" step (sast_dast.py's
  // _validate_findings). Branches automatically to Security Complete (no
  // open findings, or every open finding already has an approved
  // suppression) or Remediation (open findings, Assign to Requester becomes
  // available next).
  canValidateFindings: boolean
  // Reachable only from Rescan status -- re-imports Fortify SSC results and
  // returns the request to Scanning, so Validate Findings is reachable
  // again on the fresh data.
  canRescan: boolean
  // Reachable only from Remediation -- hands the request to the requester
  // (-> Waiting For Fix).
  canAssignToRequester: boolean
  // Reachable only from Waiting For Fix, and only for the requester (or
  // their active Delegate for Input, section 132) -- "after fix requester
  // will reassign and then qa will scan / then again the same process".
  // Sends the request to Rescan.
  canMarkFixed: boolean
  // Reported directly: "suppression requests CAN ONLY be raised by
  // requester, so this should be enable for requester, not QA team." --
  // the requester's own action, reachable only from Waiting For Fix per the
  // requirement doc's Section 4 ("After reviewing the findings, the
  // requester may choose..." -- Option A: fix, Option B: raise a
  // suppression).
  canInitiateSuppression: boolean
  busy: boolean
  // Reported directly (bug): "Supression request is now rejected, but
  // still user not able to create supression request." Excludes both
  // SUPPRESSION_TERMINAL_STATUSES (Done AND Rejected) -- only a genuinely
  // still-open suppression blocks Initiate/Mark Fixed below, mirrors
  // suppression.py's SUPPRESSION_TERMINAL_STATUSES-based
  // _require_no_existing_pending_suppression.
  hasOpenSuppression?: boolean
  openSuppressionIds?: string[]
  // Draft/Returned suppressions are open, but they are not pending reviewer
  // approval: the requester must edit and submit/resubmit them. Keeping this
  // subset separate makes the blocking message actionable and truthful.
  requesterActionSuppressionIds?: string[]
  // Reported directly: "for same sast request, even though supression
  // request is present and mark completed, again asking for new supression
  // request and relink." Initiate/Link Suppression used to only check
  // hasOpenSuppression above, so once that same suppression reached Done
  // (no longer "open"), the button re-enabled and offered to raise ANOTHER
  // one against the same request -- but per the requirement doc's Section 4,
  // once a suppression is Approved the requester's next move is to reassign
  // to the analyst (Mark Fixed), not raise a second suppression. Blocks
  // Initiate/Link the same way hasOpenSuppression does, for as long as the
  // request stays in this same Waiting For Fix visit (Mark Fixed moves it
  // to Rescan, which is the natural reset point for a fresh cycle).
  hasDoneSuppression?: boolean
  doneSuppressionIds?: string[]
  onValidateFindings: () => void
  onRescan: () => void
  onAssignToRequester: () => void
  onMarkFixed: () => void
  onInitiateSuppression: () => void
  // Opens LinkSuppressionModal above -- same requester gate as
  // canInitiateSuppression (it's the requester's own suppression to
  // re-point), so no separate boolean prop needed.
  onLinkSuppression?: () => void
}) {
  const navigate = useRequestNavigation()
  // The empty summary returned before a request's first scan is a valid API
  // response (`initial` and `current` are null). The scan-results and
  // scan-summary requests used to update independently, so the first result
  // could render briefly against that old empty summary and crash on
  // `summary.current!`. Keep the renderer safe for that transition as well
  // as for legacy/incomplete responses.
  if (!results.length || !summary?.current || !summary?.initial) {
    return (
      <EmptyState
        title="No scan results available"
        description={`${kind} findings will appear here after a completed scan is imported from Fortify SSC.`}
      />
    )
  }
  const current = summary.current
  const initial = summary.initial
  const currentResults = summary.current_results?.length ? summary.current_results : [current]
  const initialResults = summary.initial_results?.length ? summary.initial_results : [initial]
  const targetLabel = (scan: SecurityScanResultOut) => scan.targets?.[0]?.label || 'Legacy target not captured'

  return (
    <section className="security-scan-results security-findings-register" aria-label="Fortify SSC scan results">
      <header>
        <div><small>{current.provider}</small><strong>Findings by {kind === 'SAST' ? 'repository' : 'application URL'}</strong><p>Initial and latest results together for each target. Clear targets retain their verified results during selective rescans.</p></div>
      </header>
      {/* 4.4 Action Buttons -- each gate is now specific to the ONE status
          it applies from (see the props above), so at most one of
          Validate Findings / Rescan / Assign to Requester is ever shown at
          once, plus the requester's own Initiate/Link Suppression Request
          and Mark Fixed while Waiting For Fix. */}
      {(canValidateFindings || canRescan || canAssignToRequester || canInitiateSuppression || canMarkFixed) && (
        <div className="security-scan-actions">
          {/* Scanning -> the analyst must explicitly validate findings
              before anything else can happen -- "When the Security Analyst
              selects Finding Validation, the system must require:
              Application Name, Application Version, Scan completion
              details, Number of findings, Scan report or supporting
              evidence" (all already on file from the scan import itself,
              shown above). */}
          {canValidateFindings && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onValidateFindings}>
              Validate Findings
            </button>
          )}
          {/* Remediation -> hands the findings to the requester. */}
          {canAssignToRequester && (
            <button className="btn btn-sm" disabled={busy} onClick={onAssignToRequester}>
              Assign to Requester (Waiting for Fix)
            </button>
          )}
          {/* Rescan status -> re-run the scan and return to Scanning, where
              Validate Findings becomes available again on the fresh data. */}
          {canRescan && (
            <button className="btn btn-sm" disabled={busy} onClick={onRescan}>
              Rescan
            </button>
          )}
          {/* Waiting For Fix -> the requester's own choice: fix and mark
              fixed, or raise/link a suppression instead. Also blocked once a
              suppression already reached Done (see hasDoneSuppression above)
              -- that decision is already made; Mark Fixed is the next step,
              not another suppression. */}
          {canInitiateSuppression && (
            <button className="btn btn-sm" disabled={busy || hasOpenSuppression || hasDoneSuppression} onClick={onInitiateSuppression}>
              Initiate Suppression Request
            </button>
          )}
          {/* "give option to link and delink supression request from sast
              request and supression both" -- lets the requester point one
              of their own already-raised open suppressions at this request
              instead of drafting a new one. Same hasOpenSuppression/
              hasDoneSuppression gates as Initiate above (only one open
              suppression per SAST/DAST request at a time, and none needed
              once one's already Done). */}
          {canInitiateSuppression && onLinkSuppression && (
            <button className="btn btn-sm" disabled={busy || hasOpenSuppression || hasDoneSuppression} onClick={onLinkSuppression}>
              Link Existing Suppression Request
            </button>
          )}
          {/* "then give option to delegate / then after fix requester will
              reassign and then qa will scan / then again the same process" --
              Mark Fixed is what sends a Waiting For Fix request back to
              Rescan (see sast_dast.py::_mark_fixed); delegation itself is
              the existing "Delegate for Input" control on the Overview tab
              (RequestDelegation), now extended to WAITING_FOR_FIX.
              Reported directly, full requirement doc: while a suppression
              is still awaiting a decision ("Suppression Approval Pending"),
              the requester can't reassign yet -- only once it's Approved or
              Rejected -- so this is disabled the same way Initiate above is. */}
          {canMarkFixed && (
            <button className="btn btn-primary btn-sm" disabled={busy || hasOpenSuppression} onClick={onMarkFixed}>
              Mark Fixed (send to Rescan)
            </button>
          )}
          {(canInitiateSuppression || canMarkFixed) && hasOpenSuppression && (
            <p className="security-scan-suppression-blocked">
              {requesterActionSuppressionIds?.length ? <>
                Suppression requires requester action:{' '}
                {requesterActionSuppressionIds.map((suppressionId, index) => <React.Fragment key={suppressionId}>
                  {index > 0 ? ', ' : ''}
                  <button type="button" className="suppression-id-link" onClick={() => navigate(`/suppression?open=${encodeURIComponent(suppressionId)}`)}>{suppressionId}</button>
                </React.Fragment>)}
                {' '}— open the request, make the required changes, then submit or re-submit it.
              </> : <>
                Suppression Approval Pending{openSuppressionIds && openSuppressionIds.length > 0 ? ': ' : ''}
                {openSuppressionIds?.map((suppressionId, index) => <React.Fragment key={suppressionId}>
                  {index > 0 ? ', ' : ''}
                  <button type="button" className="suppression-id-link" onClick={() => navigate(`/suppression?open=${encodeURIComponent(suppressionId)}`)}>{suppressionId}</button>
                </React.Fragment>)}{' '}—
                {canMarkFixed ? 'wait for it to be approved or rejected before reassigning.' : 'only one open suppression request per SAST/DAST request at a time.'}
              </>}
            </p>
          )}
          {/* Reported directly: "for same sast request, even though
              supression request is present and mark completed, again
              asking for new supression request and relink." Only shown once
              hasOpenSuppression's own message above no longer applies (a
              suppression can't be both open and Done at once, but this
              keeps the two messages from ever appearing together) -- tells
              the requester why Initiate/Link disappeared instead of just
              silently graying out. */}
          {canInitiateSuppression && !hasOpenSuppression && hasDoneSuppression && (
            <p className="security-scan-suppression-blocked">
              This request already has an approved suppression{doneSuppressionIds && doneSuppressionIds.length > 0 ? `: ${doneSuppressionIds.join(', ')}` : ''} --
              reassign it to the Security Analyst via Mark Fixed instead of raising another one.
            </p>
          )}
        </div>
      )}
      <div className="security-findings-overview" aria-label="Target findings overview">
        <span><b>{currentResults.length}</b> {kind === 'SAST' ? 'repositories' : 'application URLs'}</span>
        <span className="pending"><b>{currentResults.filter(scan => targetNeedsRemediation(scan.targets?.[0]?.id, [scan])).length}</b> with findings pending</span>
        <span className="clear"><b>{currentResults.filter(scan => !targetNeedsRemediation(scan.targets?.[0]?.id, [scan])).length}</b> clear</span>
      </div>
      <p className="security-findings-note">Review one target at a time. Fortify views can overlap; their totals are shown separately and are not added together.</p>
      <div className="security-findings-targets">
        {[...currentResults].sort((a, b) => targetLabel(a).localeCompare(targetLabel(b))).map(scan => {
          const targetId = scan.targets?.[0]?.id
          const initialScan = initialResults.find(first => targetId != null
            ? first.targets.some(target => target.id === targetId)
            : first.id === initial.id)
          return <TargetFindings key={scan.id} scan={scan} initialScan={initialScan} />
        })}
      </div>

      {/* 4.3 Scan History -- reported directly: "also split by filter,
          currently fixed to Security Auditor View only ... instead of
          total findings show all like critical, high etc" -- one row per
          (scan, filter set) now, with the full severity breakdown instead
          of one combined Findings number. Falls back to the scan's own
          top-level counts if a legacy row has no filters recorded. Uses the
          shared Table component (not a hand-rolled <table>) so it gets the
          same per-column filter dropdowns / Columns toggle every other
          table in the app has -- reported directly: "in table filter
          option is missing". */}
      <details className="security-findings-history">
        <summary><span>Scan history</span><small>{results.length} target scan records · expand to review imports and rescans</small></summary>
        <div className="security-scan-history-table">
        <Table
          rowKey="id"
          columns={SCAN_HISTORY_COLUMNS}
          rows={results.flatMap((r): ScanHistoryRow[] => {
            const filters = Array.isArray(r.filters) ? r.filters : []
            return (
              filters.length > 0 ? filters : [{
                guid: 'total', title: '—',
                critical_count: r.critical_count, high_count: r.high_count,
                medium_count: r.medium_count, low_count: r.low_count, total_count: r.total_count,
              }]
            ).map((f) => ({
              id: `${r.id}-${f.guid}`,
              scan_no: r.scan_no, scan_type: r.scan_type, filter_title: f.title,
              imported_at: r.imported_at,
              critical_count: f.critical_count, high_count: f.high_count,
              medium_count: f.medium_count, low_count: f.low_count, total_count: f.total_count,
              status: r.status,
              targets: r.targets?.map(target => target.label).join(', ') || 'Legacy scan — not captured',
            }))
          })}
        />
        </div>
      </details>


    </section>
  )
}
