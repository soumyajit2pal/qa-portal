import { useRequestNavigation } from '../../hooks/useRequestNavigation'
import React, { useCallback, useEffect, useState } from 'react'

import { api } from '../../api'
import { formatDateTimeIST } from '../../time'
import { useAuth } from '../../context/AuthContext'
import { hasWorkflowRole as hasRole, SUPPRESSION_REQUESTER_CONTROLLED_STATUSES, SUPPRESSION_TERMINAL_STATUSES } from '../../constants'
import { EmptyState, ErrorText, Field, Modal, Table, TableColumn } from '../../components/Common'
import { DASTTargetStateOut, SASTRepositoryStateOut, SecurityScanResultOut, SecurityScanSummaryOut, SecurityTargetScanIn, SuppressionOut } from '../../types'
import { REPOSITORY_STATE_LABELS, repositoriesForAction, selectedRepositoryRows, repositorySelectionComplete, scanFindingViews, securityAuditorCurrentFindings } from './sastRepositoryWorkflow'

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

export function SecurityFixDialog({ kind, targets, repositoryStates, targetStates, onClose, onSubmit }: {
  kind: 'SAST' | 'DAST'
  targets: { id: number; label: string; previousCommit?: string | null }[]
  currentScans: SecurityScanResultOut[]
  repositoryStates?: SASTRepositoryStateOut[]
  targetStates?: DASTTargetStateOut[]
  onClose: () => void
  onSubmit: (targets: { target_id: number; commit_id: string }[]) => Promise<void>
}) {
  const isSAST = kind === 'SAST'
  const states = isSAST ? repositoryStates || [] : targetStates || []
  const noun = isSAST ? 'repositories' : 'targets'
  const [rows, setRows] = useState(() => targets.filter(target =>
    repositoriesForAction(states, 'fix').some(row => row.target_id === target.id)
  ).map(target => ({ ...target, commitId: '', selected: false })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const selected = selectedRepositoryRows(rows)
  const complete = repositorySelectionComplete(rows, row => !!row.commitId.trim())

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!complete || busy) return
    setBusy(true); setError(null)
    try {
      await onSubmit(selected.map(row => ({ target_id: row.id, commit_id: row.commitId.trim() })))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return <Modal title={isSAST ? 'Submit Repository Fixes' : 'Submit Target Fixes'} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose wide>
    <form className="security-scan-start" onSubmit={submit} aria-busy={busy}>
      <div className="security-scan-intro"><strong>{isSAST ? 'Select only repositories whose fixes are ready' : 'Select only application URLs whose fixes are ready'}</strong><span>{isSAST ? 'Enter the latest commit ID or code hash only for selected repositories. Other repositories keep their findings and current progress.' : 'Enter the source commit ID or deployed artifact hash containing the fix only for selected application URLs. Other targets keep their findings and current progress.'} These references will be recorded with your name and submission date in the activity history.</span></div>
      {targets.length > rows.length && <p className="muted small">{isSAST ? 'Repositories' : 'Targets'} at other stages keep their current progress and do not require a code reference for this fix submission.</p>}
      {rows.map(row => <div className="security-scan-target-row" key={row.id}>
        <label className="security-scan-target-choice"><input type="checkbox" checked={row.selected} disabled={busy} onChange={event => setRows(current => current.map(target => target.id === row.id ? { ...target, selected: event.target.checked } : target))} /><span><strong>{row.label}</strong><small>{REPOSITORY_STATE_LABELS[states.find(state => state.target_id === row.id)!.state]}</small></span></label>
        {row.previousCommit && <p className="muted small">Previously recorded commit: {row.previousCommit}</p>}
        {row.selected && <Field label="Latest commit ID / code hash *"><input required maxLength={500} disabled={busy} value={row.commitId} onChange={event => setRows(current => current.map(target => target.id === row.id ? { ...target, commitId: event.target.value } : target))} placeholder="Commit ID or code/artifact hash" /></Field>}
      </div>)}
      {!rows.length && <p>No target is awaiting remediation. Refresh the findings before continuing.</p>}
      <p className="muted small">{selected.length} of {rows.length} eligible {noun} selected. The Security Analyst can rescan these while other fixes remain in progress.</p>
      <ErrorText error={error} />
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !complete}>{busy ? 'Submitting…' : 'Submit Selected Fixes & Request Rescan'}</button><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}

export function SecurityScanDialog({ kind, mode = 'start', initialApplicationName, targets, initialScans, repositoryStates, targetStates, reverification = false, busy, error, onClose, onStart }: {
  kind: 'SAST' | 'DAST'
  // 2026-08 "Findings Validation" doc -- Rescan re-uses this exact dialog
  // (same Application Name/Version identity, same SSC import call) rather
  // than a separate form; `mode` only changes copy/labels and whether the
  // fields start prefilled from the latest scan (Rescan) or blank (Start).
  mode?: 'start' | 'rescan'
  initialApplicationName?: string | null
  targets: { id: number; label: string; detail?: string | null }[]
  initialScans?: SecurityScanResultOut[]
  repositoryStates?: SASTRepositoryStateOut[]
  targetStates?: DASTTargetStateOut[]
  reverification?: boolean
  busy: boolean
  error: unknown
  onClose: () => void
  onStart: (scans: SecurityTargetScanIn[]) => Promise<void>
}) {
  const previousByTarget = new Map((initialScans || []).flatMap(scan => scan.targets.map(target => [target.id, scan] as const)))
  const isRescan = mode === 'rescan'
  const isSAST = kind === 'SAST'
  const states = isSAST ? repositoryStates || [] : targetStates || []
  const noun = isSAST ? 'repositories' : 'targets'
  const pendingTargets = targets.filter(target => repositoriesForAction(states, isRescan ? 'rescan' : 'start').some(row => row.target_id === target.id))
  const retainedTargets = targets.filter(target => !pendingTargets.some(pending => pending.id === target.id))
  const [rows, setRows] = useState(() => pendingTargets.map(target => {
    const previous = previousByTarget.get(target.id)
    const repository = repositoryStates?.find(row => row.target_id === target.id)
    return { ...target, selected: false, applicationName: previous?.application_name || initialApplicationName || '', applicationVersion: previous?.application_version || '', needsBranch: isSAST && !repository?.git_branch?.trim(), needsCommit: isSAST && !repository?.commit_id?.trim(), gitBranch: repository?.git_branch || '', commitId: repository?.commit_id || '' }
  }))

  function update(id: number, values: Partial<(typeof rows)[number]>) {
    setRows(current => current.map(row => row.id === id ? { ...row, ...values } : row))
  }

  const selected = selectedRepositoryRows(rows)
  const complete = repositorySelectionComplete(rows, row => !!(row.applicationName.trim() && row.applicationVersion.trim()) && (!row.needsBranch || !!row.gitBranch.trim()) && (!row.needsCommit || !!row.commitId.trim()))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!complete || busy) return
    await onStart(selected.map(row => ({ target_id: row.id, application_name: row.applicationName.trim(), application_version: row.applicationVersion.trim(), ...(row.needsBranch ? { git_branch: row.gitBranch.trim() } : {}), ...(row.needsCommit ? { commit_id: row.commitId.trim() } : {}) })))
  }

  return (
    <Modal title={reverification ? isSAST ? 'Reverify Repository Results' : 'Reverify Target Results' : isRescan ? isSAST ? 'Retrieve Selected Repository Rescans' : 'Retrieve Selected Target Rescans' : isSAST ? 'Retrieve Repository Scan Results' : 'Retrieve Target Scan Results'} onClose={() => { if (!busy) onClose() }} variant="dialog" preventBackdropClose wide>
      <form className="security-scan-start" onSubmit={submit} aria-busy={busy}>
        <div className="security-scan-intro">
          <strong>{isRescan ? 'Re-import the latest Fortify SSC analysis' : 'Import the matching Fortify SSC analysis'}</strong>
          <span>
            Select only {noun} with completed Fortify results ready to retrieve. Enter Fortify details only for selected {noun}; unselected results and pending work stay unchanged.
          </span>
        </div>
        <fieldset className="security-scan-targets">
          <legend>{kind === 'SAST' ? 'Repository scans *' : 'URL scans *'}</legend>
          <p className="muted small">Each selected {isSAST ? 'repository' : 'target'} produces its own result and history entry. You can retrieve remaining {noun} in another batch.</p>
          {retainedTargets.length > 0 && <p className="muted small">Other {noun} keep their current progress: {retainedTargets.map(target => target.label).join(', ')}</p>}
          {rows.length ? rows.map(row => (
            <div className="security-scan-target-row" key={row.id}>
              <label className="security-scan-target-choice"><input type="checkbox" disabled={busy} checked={row.selected} onChange={event => update(row.id, { selected: event.target.checked })} /><span><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</span></label>
              {row.selected && <div className="form-row">
                <Field label="Fortify Application Name *"><input required disabled={busy} value={row.applicationName} onChange={event => update(row.id, { applicationName: event.target.value })} placeholder="Exact Fortify application name" /></Field>
                <Field label="Fortify Application Version *"><input required disabled={busy} value={row.applicationVersion} onChange={event => update(row.id, { applicationVersion: event.target.value })} placeholder="For example: 1, 1.1 or 2026.08" /></Field>
              </div>}
              {row.selected && (row.needsBranch || row.needsCommit) && <>
                <p className="muted small">This older repository scope is missing a source reference. Enter the branch and commit used by the completed Fortify scan so the new result can be tracked accurately.</p>
                <div className="form-row">
                  {row.needsBranch && <Field label="Scanned Git branch *"><input required maxLength={500} disabled={busy} value={row.gitBranch} onChange={event => update(row.id, { gitBranch: event.target.value })} placeholder="Branch used by the completed scan" /></Field>}
                  {row.needsCommit && <Field label="Scanned commit ID / code hash *"><input required maxLength={500} disabled={busy} value={row.commitId} onChange={event => update(row.id, { commitId: event.target.value })} placeholder="Commit ID or code hash used by the completed scan" /></Field>}
                </div>
              </>}
            </div>
          )) : <span className="muted">No {isSAST ? 'repository' : 'target'} is eligible for this action. Refresh {isSAST ? 'repository' : 'target'} progress before continuing.</span>}
        </fieldset>
        <p className="muted small">Every selected application/version must already exist and have processed results in Fortify SSC. Nothing is saved if any target import fails.</p>
        {reverification && <p className="muted small">Retrieving these results will reopen this {kind} request for findings validation. Select only {noun} needing current evidence.</p>}
        <p className="muted small">{selected.length} of {rows.length} eligible {noun} selected.</p>
        <ErrorText error={error} />
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={busy || !complete}>
            {busy ? <><span className="api-activity-spinner" aria-hidden="true" /> Importing SSC Results…</> : 'Retrieve Selected Results'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
        {busy && <div className="security-scan-progress" role="status" aria-live="assertive"><span className="api-activity-spinner" aria-hidden="true" /><div><strong>Connecting to Fortify SSC</strong><span>Resolving the application version and importing filter-set findings. Please keep this dialog open.</span></div></div>}
      </form>
    </Modal>
  )
}

const FINDING_COUNT_COLUMNS = ['critical_count', 'high_count', 'medium_count', 'low_count', 'total_count'] as const

function SecurityTargetProgress({ kind, states, results, allClear, canStart, canValidate, reverification = false, busy, onStart, onValidate }: {
  kind: 'SAST' | 'DAST'
  states: SASTRepositoryStateOut[]
  results: SecurityScanResultOut[]
  allClear: boolean
  canStart: boolean
  canValidate: boolean
  reverification?: boolean
  busy: boolean
  onStart: () => void
  onValidate: (targetIds: number[]) => void
}) {
  const isSAST = kind === 'SAST'
  const noun = isSAST ? 'repository' : 'target'
  const plural = isSAST ? 'repositories' : 'targets'
  const [selected, setSelected] = useState<number[]>([])
  const eligible = repositoriesForAction(states, 'validate').map(row => row.target_id)
  const validationVersion = repositoriesForAction(states, 'validate').map(row => `${row.target_id}:${row.latest_scan_id ?? ''}`).join('|')
  useEffect(() => { setSelected([]) }, [validationVersion])
  // A completed validation must not leave a now-ineligible row selected.
  const selectedIds = selected.filter(id => eligible.includes(id))
  const clearCount = states.filter(row => row.state === 'CLEAR').length

  return <section className="sast-repository-progress" aria-label={isSAST ? 'Repository progress' : 'Target progress'}>
    <header><div><strong>{isSAST ? 'Repository progress' : 'Target progress'}</strong><p>Each {noun} moves independently. Unselected {plural} retain their findings and pending work.</p></div><span className={allClear ? 'complete' : ''}>{clearCount} / {states.length} clear</span></header>
    <div className="sast-repository-progress-scroll"><table>
      <thead><tr>{canValidate && <th scope="col">Validate</th>}<th scope="col">{isSAST ? 'Repository' : 'Application URL'}</th><th scope="col">Progress</th><th scope="col">{isSAST ? 'Branch / current commit' : 'Deployed code / artifact hash'}</th><th scope="col">Latest import</th><th scope="col">Active findings<small>Security Auditor View → Current Result</small></th></tr></thead>
      <tbody>{states.map(row => {
        const scan = results.find(result => result.id === row.latest_scan_id)
        return <tr key={row.target_id}>
          {canValidate && <td>{row.state === 'AWAITING_VALIDATION' ? <input type="checkbox" aria-label={`Validate ${row.label}`} checked={selectedIds.includes(row.target_id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...current.filter(id => id !== row.target_id), row.target_id] : current.filter(id => id !== row.target_id))} /> : '—'}</td>}
          <th scope="row">{row.label}</th>
          <td><span className={`sast-repository-state state-${row.state.toLowerCase()}`}>{REPOSITORY_STATE_LABELS[row.state]}</span>{row.fix_submitted_at && row.state === 'READY_FOR_RESCAN' && <small>Fix submitted {formatDateTimeIST(row.fix_submitted_at)}</small>}</td>
          <td>{isSAST ? <>{row.git_branch || '—'}<small>{row.commit_id || 'Commit not recorded'}</small></> : row.commit_id || 'Hash not recorded'}</td>
          <td>{scan ? formatDateTimeIST(scan.imported_at) : row.latest_scan_id ? 'Import recorded' : 'Not imported'}</td>
          <td>{row.state === 'NOT_SCANNED' ? '—' : securityAuditorCurrentFindings(scan) ?? '—'}</td>
        </tr>
      })}</tbody>
    </table></div>
    <p className="security-findings-note">{allClear ? `Every ${noun} has a current, validated clear result.` : isSAST ? 'Overall clearance requires a current, validated clear result for every repository. Repositories without a scan or with a changed branch/commit remain pending.' : 'Overall clearance requires a current, validated clear result for every application URL. Targets without a scan or with changed scan details remain pending.'}</p>
    {(canStart || canValidate) && <div className="security-scan-actions">
      {canStart && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onStart}>{reverification ? isSAST ? 'Reverify Repository Results' : 'Reverify Target Results' : isSAST ? 'Retrieve Repository Results' : 'Retrieve Target Results'}</button>}
      {canValidate && <button type="button" className="btn btn-primary btn-sm" disabled={busy || !selectedIds.length} onClick={() => onValidate(selectedIds)}>Validate Selected Findings ({selectedIds.length})</button>}
      {canValidate && <p className="muted small">Select the imported {plural} you have reviewed. Other {plural} keep their current progress.</p>}
    </div>}
  </section>
}

export function SASTRepositoryProgress(props: Omit<React.ComponentProps<typeof SecurityTargetProgress>, 'kind'>) {
  return <SecurityTargetProgress {...props} kind="SAST" />
}

export function DASTTargetProgress(props: Omit<React.ComponentProps<typeof SecurityTargetProgress>, 'kind'>) {
  return <SecurityTargetProgress {...props} kind="DAST" />
}

function TargetFindings({ scan, initialScan, repositoryState }: { scan: SecurityScanResultOut; initialScan?: SecurityScanResultOut; repositoryState?: SASTRepositoryStateOut }) {
  const pending = targetNeedsRemediation(scan.targets?.[0]?.id, [scan])
  const isClear = repositoryState ? repositoryState.state === 'CLEAR' : !pending
  const currentFilters = scanFindingViews(scan)
  const initialFilters = scanFindingViews(initialScan)
  const views = [...new Set([...currentFilters, ...initialFilters].map(filter => filter.title))]
  const suppressed = {
    critical_count: scan.suppressed_critical_count ?? 0,
    high_count: scan.suppressed_high_count ?? 0,
    medium_count: scan.suppressed_medium_count ?? 0,
    low_count: scan.suppressed_low_count ?? 0,
    total_count: scan.suppressed_total_count ?? 0,
  }

  return <details className={`security-findings-target ${isClear ? 'is-clear' : 'is-pending'}`} open={!isClear}>
    <summary>
      <span className="security-findings-target-identity"><strong>{scan.targets?.[0]?.label || 'Legacy target not captured'}</strong><small>{scan.application_name} · Version {scan.application_version}</small></span>
      <span className={`security-findings-target-status ${isClear ? 'clear' : 'pending'}`}>{repositoryState ? REPOSITORY_STATE_LABELS[repositoryState.state] : pending ? 'Fix pending' : 'Clear · no rescan needed'}</span>
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
  repositoryProgress,
  targetProgress,
}: {
  status: string
  activeCount: number
  suppressedCount: number
  hasWorkflowAction: boolean
  onOpen: () => void
  repositoryProgress?: { clear: number; total: number }
  targetProgress?: { clear: number; total: number }
}) {
  const progress = repositoryProgress || targetProgress
  const noun = repositoryProgress ? 'repositories' : 'application URLs'
  const nextStep = progress ? {
    title: `${repositoryProgress ? 'Repository' : 'Target'} progress: ${progress.clear} of ${progress.total} clear`,
    description: `Open Findings to retrieve, validate or submit fixes for selected ${noun}. Other ${noun} keep their progress; analyst rescans and developer fixes can proceed independently.`,
  } : FINDINGS_NEXT_STEP[status] || {
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
  const progressStates = (kind === 'SAST' ? summary.repository_states : summary.target_states) || []
  const totalTargets = kind === 'SAST' ? summary.total_repositories : summary.total_targets
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
              Retrieve Ready Rescans
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
              {kind === 'SAST' ? 'Submit Repository Fixes' : 'Submit Target Fixes'}
            </button>
          )}
          {(canInitiateSuppression || canMarkFixed) && hasOpenSuppression && (
            <p className="security-scan-suppression-blocked">
              The linked suppression applies to this request: submitting {kind === 'SAST' ? 'repository' : 'target'} fixes is blocked until it is resolved.{' '}
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
              submit the affected {kind === 'SAST' ? 'repository' : 'target'} fixes for the Security Analyst to rescan.
            </p>
          )}
        </div>
      )}
      <div className="security-findings-overview" aria-label="Target findings overview">
        <span><b>{totalTargets ?? currentResults.length}</b> {kind === 'SAST' ? 'repositories in scope' : 'application URLs'}</span>
        <span className="pending"><b>{progressStates.length ? progressStates.filter(row => row.state !== 'CLEAR').length : totalTargets ?? currentResults.length}</b> pending</span><span className="clear"><b>{progressStates.filter(row => row.state === 'CLEAR').length}</b> clear</span>
      </div>
      <p className="security-findings-note">Review one target at a time. Fortify views can overlap; their totals are shown separately and are not added together.</p>
      <div className="security-findings-targets">
        {[...currentResults].sort((a, b) => targetLabel(a).localeCompare(targetLabel(b))).map(scan => {
          const targetId = scan.targets?.[0]?.id
          const initialScan = initialResults.find(first => targetId != null
            ? first.targets.some(target => target.id === targetId)
            : first.id === initial.id)
          const repositoryState = progressStates.find(row => row.target_id === targetId)
            || { target_id: targetId ?? -1, label: targetLabel(scan), state: 'AWAITING_VALIDATION' as const, open_findings: scan.total_count }
          return <TargetFindings key={scan.id} scan={scan} initialScan={initialScan} repositoryState={repositoryState} />
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
