import React, { useEffect, useState } from 'react'
import { api } from '../../api'
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
  { key: 'imported_at', header: 'Scan Date', render: (r) => new Date(r.imported_at).toLocaleDateString() },
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
        Only your own still-open suppression requests (not yet Done or Rejected) are listed. Linking
        re-points the selected suppression at this {kind} request -- a suppression can only be linked
        to one SAST/DAST request at a time, so this replaces its current link.
      </p>
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
      {loaded && candidates.length === 0 && <p className="muted small">No eligible open suppression requests of yours were found.</p>}
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
export function SecurityScanResults({
  kind, results, summary, canAct, canInitiateSuppression, canAssignToRequester, canMarkFixed, busy,
  suppressionPending, hasOpenSuppression, openSuppressionIds, rejectedSuppressionIds,
  onRescan, onMarkComplete, onInitiateSuppression, onAssignToRequester, onMarkFixed, onLinkSuppression,
}: {
  kind: 'SAST' | 'DAST'
  results: SecurityScanResultOut[]
  summary: SecurityScanSummaryOut | null
  // Gates Rescan / Mark Scan Complete -- the assigned Security Analyst's own
  // scan-lifecycle actions.
  canAct: boolean
  // Reported directly: "suppression requests CAN ONLY be raised by
  // requester, so this should be enable for requester, not QA team." --
  // Initiate Suppression Request is deliberately its own, separate gate
  // (the linked SAST/DAST request's requester), not folded into canAct,
  // since it's the one 4.4 action that belongs to a different person than
  // Rescan/Mark Scan Complete.
  canInitiateSuppression: boolean
  busy: boolean
  // 2026-08 doc, 4.4: "If Suppression Pending: Disable [Mark Scan Complete]"
  // -- FR-06's own rule text: ANY status other than "Done" (Rejected
  // included) blocks scan completion, since a rejected suppression means
  // the finding is real and still open -- this stays deliberately broad
  // (see sast_dast.py's _pending_suppression_ids, same definition). Only
  // the *message wording* below distinguishes open vs. Rejected -- the
  // block itself doesn't.
  suppressionPending?: boolean
  // Reported directly (bug): "Supression request is now rejected, but
  // still user not able to create supression request." Initiate Suppression
  // Request needs a NARROWER gate than suppressionPending above -- Rejected
  // must NOT block raising a new one (it's terminal; the natural next step
  // is either remediate or try again with a better justification), only a
  // genuinely still-open suppression should. Mirrors suppression.py's
  // SUPPRESSION_TERMINAL_STATUSES-based _require_no_existing_pending_
  // suppression, which the same bug was fixed in server-side.
  hasOpenSuppression?: boolean
  // Reported directly (follow-up): "Pending suppression requests exist:
  // though request is rejected still it is showing like that" -- the block
  // on Mark Scan Complete while a suppression is Rejected is correct (FR-06
  // Rule 3), but labelling a Rejected decision "pending" is wrong; it's a
  // finished (unfavourable) decision, not one still awaiting action.
  // openSuppressionIds names genuinely still-in-flight ones (kept from
  // above); rejectedSuppressionIds is new -- lets the message say "rejected"
  // for those instead of "pending".
  openSuppressionIds?: string[]
  rejectedSuppressionIds?: string[]
  // Reported directly: "where is waiting for fix, assign to requester ...
  // if there are findings then it should show waiting for fix option, then
  // give option to delegate" -- Assign to Requester (-> Waiting For Fix) is
  // now a Findings-tab action next to Rescan, reachable whenever findings
  // exist, instead of the old dead REMEDIATION-only Overview button. Same
  // assigned-analyst gate as canAct (see SAST.tsx/DAST.tsx's
  // canAssignToRequester = canScanAct).
  canAssignToRequester?: boolean
  // Mark Fixed (-> Rescan) closes the loop: requester (or the analyst) says
  // the finding is fixed, which is what makes Rescan reachable again --
  // "after fix requester will reassign and then qa will scan / then again
  // the same process". Independent of hasFindings below since it only
  // applies once already in WAITING_FOR_FIX.
  canMarkFixed?: boolean
  onRescan: () => void
  onMarkComplete: () => void
  onInitiateSuppression: () => void
  onAssignToRequester?: () => void
  onMarkFixed?: () => void
  // Opens LinkSuppressionModal above -- same requester gate as
  // canInitiateSuppression (it's the requester's own suppression to
  // re-point), so no separate boolean prop needed.
  onLinkSuppression?: () => void
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

      {/* 4.4 Action Buttons -- Rescan/Mark Scan Complete/Assign to Requester
          (canAct/canAssignToRequester, the assigned Security Analyst),
          Initiate Suppression Request (canInitiateSuppression, the
          requester), and Mark Fixed (canMarkFixed, requester or analyst,
          only once already Waiting For Fix) are independent gates; only
          render this whole block if at least one of them applies. */}
      {(canAct || canMarkFixed || (hasFindings && (canInitiateSuppression || canAssignToRequester))) && (
        <div className="security-scan-actions">
          {hasFindings ? (
            <>
              {canAct && <button className="btn btn-sm" disabled={busy} onClick={onRescan}>Rescan</button>}
              {/* Reported directly: "if there are findings then it should
                  show waiting for fix option" -- Assign to Requester next to
                  Rescan, whenever the latest scan still has open findings. */}
              {canAssignToRequester && (
                <button className="btn btn-sm" disabled={busy} onClick={onAssignToRequester}>
                  Assign to Requester (Waiting for Fix)
                </button>
              )}
              {canInitiateSuppression && (
                <button className="btn btn-sm" disabled={busy || hasOpenSuppression} onClick={onInitiateSuppression}>
                  Initiate Suppression Request
                </button>
              )}
              {/* "give option to link and delink supression request from
                  sast request and supression both" -- lets the requester
                  point one of their own already-raised open suppressions
                  at this request instead of drafting a new one. Same
                  hasOpenSuppression gate as Initiate above (only one open
                  suppression per SAST/DAST request at a time). */}
              {canInitiateSuppression && onLinkSuppression && (
                <button className="btn btn-sm" disabled={busy || hasOpenSuppression} onClick={onLinkSuppression}>
                  Link Existing Suppression Request
                </button>
              )}
            </>
          ) : (
            canAct && <button className="btn btn-primary btn-sm" disabled={busy || suppressionPending} onClick={onMarkComplete}>Mark Scan Complete</button>
          )}
          {/* "then give option to delegate / then after fix requester will
              reassign and then qa will scan / then again the same process" --
              Mark Fixed is what sends a Waiting For Fix request back to
              Rescan (see sast_dast.py::_mark_fixed); delegation itself is
              the existing "Delegate for Input" control on the Overview tab
              (ChildRequestDelegation), now extended to WAITING_FOR_FIX. */}
          {canMarkFixed && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onMarkFixed}>
              Mark Fixed (send to Rescan)
            </button>
          )}
          {canAct && suppressionPending && (
            <p className="security-scan-suppression-blocked">
              {openSuppressionIds && openSuppressionIds.length > 0 && (
                <>Pending suppression requests exist: {openSuppressionIds.join(', ')}. </>
              )}
              {rejectedSuppressionIds && rejectedSuppressionIds.length > 0 && (
                <>Suppression request{rejectedSuppressionIds.length > 1 ? 's' : ''} rejected: {rejectedSuppressionIds.join(', ')} -- findings must be remediated (or a new suppression approved) before the scan can be marked complete.</>
              )}
            </p>
          )}
          {canInitiateSuppression && hasOpenSuppression && (
            <p className="security-scan-suppression-blocked">
              Pending suppression requests exist{openSuppressionIds && openSuppressionIds.length > 0 ? `: ${openSuppressionIds.join(', ')}` : ''}.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
