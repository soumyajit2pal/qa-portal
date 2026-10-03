import type { SASTComponentOut, SASTRepositoryState, SASTRepositoryStateOut, SecurityScanResultOut, SecurityScanSummaryOut } from '../../types'

export const SAST_ACTIVE_SCAN_STATUSES = ['CONFIGURATION', 'SCANNING', 'FINDING_VALIDATION', 'REMEDIATION', 'WAITING_FOR_FIX', 'RESCAN']
export const SAST_REVERIFICATION_STATUSES = ['CLOSED', 'REPORT_READY', 'SECURITY_COMPLETE']

export const REPOSITORY_STATE_LABELS: Record<SASTRepositoryState, string> = {
  NOT_SCANNED: 'Not scanned',
  AWAITING_VALIDATION: 'Awaiting validation',
  WAITING_FOR_FIX: 'Waiting for fix',
  READY_FOR_RESCAN: 'Ready for rescan',
  CLEAR: 'Clear',
  STALE: 'New scan required',
}

/** Older flat imports use the same Auditor view fallback as the findings table. */
export function scanFindingViews(result?: SecurityScanResultOut) {
  return !result ? [] : result.filters.length ? result.filters : [{ ...result, title: 'Security Auditor View', guid: 'auditor' }]
}

/** Active findings show the latest Auditor result, never another view's total. */
export function securityAuditorCurrentFindings(result?: SecurityScanResultOut) {
  return scanFindingViews(result).find(view => view.title.trim().toLowerCase().includes('security auditor view'))?.total_count ?? null
}

const ACTION_STATES = {
  start: ['NOT_SCANNED', 'STALE'],
  rescan: ['READY_FOR_RESCAN'],
  fix: ['WAITING_FOR_FIX', 'STALE'],
  validate: ['AWAITING_VALIDATION'],
} satisfies Record<string, SASTRepositoryState[]>

export function repositoriesForAction(states: SASTRepositoryStateOut[], action: keyof typeof ACTION_STATES) {
  const allowed: SASTRepositoryState[] = ACTION_STATES[action]
  return states.filter(row => allowed.includes(row.state))
}

export function canRetrieveSASTResults(status: string, states: SASTRepositoryStateOut[]) {
  return (SAST_ACTIVE_SCAN_STATUSES.includes(status) || SAST_REVERIFICATION_STATUSES.includes(status))
    && repositoriesForAction(states, 'start').length > 0
}

/** Missing coverage or an older server response cannot establish repository clearance. */
export function sastRepositoryProgress(components: SASTComponentOut[], summary: SecurityScanSummaryOut | null): SASTRepositoryStateOut[] {
  const states = new Map((summary?.repository_states || []).map(row => [row.target_id, row]))
  return components.map(component => states.get(component.id) || {
    target_id: component.id,
    label: component.repository_url || 'Repository URL not recorded',
    state: 'NOT_SCANNED',
    commit_id: component.commit_id,
    git_branch: component.git_branch,
    latest_scan_id: null,
    open_findings: 0,
  })
}

export function allSASTRepositoriesClear(states: SASTRepositoryStateOut[], summary: SecurityScanSummaryOut | null) {
  return summary?.all_repositories_clear === true && states.length > 0
    && summary.total_repositories === states.length && states.every(row => row.state === 'CLEAR')
}

/** Build a batch from selected rows only; unselected required fields never block it. */
export function selectedRepositoryRows<T extends { selected: boolean }>(rows: T[]) {
  return rows.filter(row => row.selected)
}

export function repositorySelectionComplete<T extends { selected: boolean }>(rows: T[], hasRequiredReference: (row: T) => boolean) {
  const selected = selectedRepositoryRows(rows)
  return selected.length > 0 && selected.every(hasRequiredReference)
}
