import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { formatDateIST, formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { hasRole, SUPPRESSION_TERMINAL_STATUSES } from '../../constants'
import { ErrorText, Field, Modal, Table, TableColumn } from '../../components/Common'
import { SecurityScanResultOut, SecurityScanSummaryOut, SuppressionOut } from '../../types'

// One row per (scan, filter set) -- see findingsByFilter/the Scan History
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
}

const SCAN_HISTORY_COLUMNS: TableColumn<ScanHistoryRow>[] = [
  { key: 'scan_no', header: 'Scan No' },
  { key: 'scan_type', header: 'Type' },
  { key: 'filter_title', header: 'Filter' },
  { key: 'imported_at', header: 'Scan Date', render: (r) => formatDateIST(r.imported_at) },
  { key: 'critical_count', header: 'Critical' },
  { key: 'high_count', header: 'High' },
  { key: 'medium_count', header: 'Medium' },
  { key: 'low_count', header: 'Low' },
  { key: 'total_count', header: 'Total' },
  { key: 'status', header: 'Status' },
]

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

// Shared by the full scan result (SecurityScanResultOut) and each individual
// filter set breakdown (SecurityScanFilterOut) below -- both have the same
// critical/high/medium/low/total_count fields.
function severityBreakdown(counts: { critical_count: number; high_count: number; medium_count: number; low_count: number; total_count: number }) {
  return (
    <div className="security-scan-severity-grid">
      <div className="critical"><small>Critical</small><strong>{counts.critical_count}</strong></div>
      <div className="high"><small>High</small><strong>{counts.high_count}</strong></div>
      <div className="medium"><small>Medium</small><strong>{counts.medium_count}</strong></div>
      <div className="low"><small>Low</small><strong>{counts.low_count}</strong></div>
      <div className="total"><small>Total</small><strong>{counts.total_count}</strong></div>
    </div>
  )
}

// 2026-08 -- reported directly: "show initial scan findings and Current
// Scan findings but split Filter and total also individual level not
// security + quick like that" -- each filter set (Security Auditor View,
// Quick View, ...) gets its own full severityBreakdown card, with its own
// independent Total; filter sets are never added together into one combined
// number (see fortify_ssc.py's retrieve_snapshot for why -- they're
// overlapping views of the same issues, not disjoint subsets of them).
function findingsByFilter(scan: SecurityScanResultOut) {
  if (!scan.filters.length) return severityBreakdown(scan)
  return (
    <>
      {scan.filters.map((filter) => (
        <div key={filter.guid} className="security-scan-filter-breakdown">
          <span className="security-scan-filter-label">{filter.title}</span>
          {severityBreakdown(filter)}
        </div>
      ))}
    </>
  )
}

function suppressedFindingsBreakdown(scan: SecurityScanResultOut) {
  return severityBreakdown({
    critical_count: scan.suppressed_critical_count ?? 0,
    high_count: scan.suppressed_high_count ?? 0,
    medium_count: scan.suppressed_medium_count ?? 0,
    low_count: scan.suppressed_low_count ?? 0,
    total_count: scan.suppressed_total_count ?? 0,
  })
}

// 2026-08, reported directly: "if supression request then link that
// request with that sast request, which should be linkable ... give
// option to link and delink supression request from sast request and
// supression both." -- the SAST/DAST-side counterpart to Suppression.tsx's
// own Relink control (opened from the requester's suppression detail
// view): picks one of the requester's own still-open suppression requests
// and points it at *this* SAST/DAST request instead, via the same backend
// relink_suppression endpoint / SUPPRESSION_TERMINAL_STATUSES eligibility.
export function LinkSuppressionModal({ kind, requestId, requestLabel, onClose, onLinked }: {
  kind: 'SAST' | 'DAST'
  requestId: number
  requestLabel: string
  onClose: () => void
  onLinked: (s: SuppressionOut) => void
}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [suppressions, setSuppressions] = useState<SuppressionOut[]>([])
  const [selectedId, setSelectedId] = useState<number | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.get<SuppressionOut[]>('/api/suppressions')
      .then(setSuppressions)
      .catch((err) => setError(err))
      .finally(() => setLoaded(true))
  }, [])

  function isAlreadyLinkedHere(s: SuppressionOut): boolean {
    return (kind === 'SAST' ? s.sast_request_id : s.dast_request_id) === requestId
  }
  // Same requester-or-admin scoping as everywhere else in the suppression
  // flow (Only the requester of the linked request -- or Admin -- can
  // raise/relink a suppression), plus "still open" (SUPPRESSION_TERMINAL_
  // STATUSES) since a Done/Rejected suppression is a finished decision, not
  // something to re-point elsewhere.
  const candidates = suppressions.filter((s) =>
    (s.created_by_id === user?.id || hasRole(user, 'ADMIN'))
    && !SUPPRESSION_TERMINAL_STATUSES.includes(s.status)
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
        requests. You may also link one of your other open suppression requests to this request.
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
      {loaded && candidates.length === 0 && <p className="muted small">No other eligible open suppression requests of yours were found.</p>}
      <ErrorText error={error} />
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
  canInitiateSuppression, busy, hasOpenSuppression, openSuppressionIds, hasDoneSuppression, doneSuppressionIds,
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
  if (!results.length || !summary) return null
  const current = summary.current!
  const initial = summary.initial!

  return (
    <section className="security-scan-results" aria-label="Fortify SSC scan results">
      <header>
        <div><small>{current.provider} · Latest imported result</small><strong>{current.application_name} <span>v{current.application_version}</span></strong><p>Imported {formatDateTimeIST(current.imported_at)} · Provider version ID {current.provider_version_id}</p></div>
        {current.audit_url && <a className="btn btn-sm" href={current.audit_url} target="_blank" rel="noreferrer">Open in Fortify SSC ↗</a>}
      </header>

      {/* 4.1 Scan Summary grid removed -- reported directly ("this part is
          not required") right after it shipped, since 4.2's per-filter
          Initial/Current breakdown below already covers Initial/Current
          Scan Findings, and this summary strip's numbers (esp. Current
          Scan Findings vs Open Findings both reading the same value) read
          as redundant/confusing next to it. */}

      {/* 4.2 Findings Display -- Initial vs Current shown separately, and
          each split by filter set (Security Auditor View, Quick View, ...)
          rather than one combined number -- see findingsByFilter above. */}
      <div className="security-scan-findings-compare">
        <div>
          <strong>Initial Scan Findings</strong>
          {findingsByFilter(initial)}
        </div>
        <div>
          <strong>Current Scan Findings</strong>
          {findingsByFilter(current)}
        </div>
      </div>

      <section className="security-scan-suppressed-summary" aria-label="Latest Fortify suppressed findings">
        <header>
          <span className="security-scan-suppressed-icon" aria-hidden="true">S</span>
          <div>
            <small>Current Fortify state · Security Auditor View</small>
            <strong>Suppressed Findings</strong>
            <p>
              {current.application_name} v{current.application_version} · These findings are suppressed in Fortify SSC and are not included in the active finding totals above.
            </p>
          </div>
        </header>
        {suppressedFindingsBreakdown(current)}
      </section>

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
      <div className="security-scan-history-table">
        <strong>Scan History</strong>
        <Table
          rowKey="id"
          columns={SCAN_HISTORY_COLUMNS}
          rows={results.flatMap((r): ScanHistoryRow[] => (
            r.filters.length > 0 ? r.filters : [{
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
          })))}
        />
      </div>

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
              Suppression Approval Pending{openSuppressionIds && openSuppressionIds.length > 0 ? `: ${openSuppressionIds.join(', ')}` : ''} --
              {canMarkFixed ? ' wait for it to be approved or rejected before reassigning.' : ' only one open suppression request per SAST/DAST request at a time.'}
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
    </section>
  )
}
