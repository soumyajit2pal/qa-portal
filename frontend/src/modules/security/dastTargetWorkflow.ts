import type { DASTTargetOut, DASTTargetStateOut, SecurityScanSummaryOut } from '../../types'
import { SAST_ACTIVE_SCAN_STATUSES, SAST_REVERIFICATION_STATUSES, repositoriesForAction } from './sastRepositoryWorkflow'

export const DAST_ACTIVE_SCAN_STATUSES = SAST_ACTIVE_SCAN_STATUSES
export const DAST_REVERIFICATION_STATUSES = SAST_REVERIFICATION_STATUSES
export const targetsForAction = repositoriesForAction

export function canRetrieveDASTResults(status: string, states: DASTTargetStateOut[]) {
  return (DAST_ACTIVE_SCAN_STATUSES.includes(status) || DAST_REVERIFICATION_STATUSES.includes(status))
    && targetsForAction(states, 'start').length > 0
}

/** Every configured URL stays visible even before its first scan is imported. */
export function dastTargetProgress(targets: DASTTargetOut[], summary: SecurityScanSummaryOut | null): DASTTargetStateOut[] {
  const states = new Map((summary?.target_states || []).map(row => [row.target_id, row]))
  return targets.map(target => states.get(target.id) || {
    target_id: target.id,
    label: target.application_url || 'Application URL not recorded',
    state: 'NOT_SCANNED',
    commit_id: target.commit_id,
    environment: target.environment,
    authentication_required: target.authentication_required,
    latest_scan_id: null,
    open_findings: 0,
  })
}

/** A zero partial import or an older server response cannot clear the request. */
export function allDASTTargetsClear(states: DASTTargetStateOut[], summary: SecurityScanSummaryOut | null) {
  return summary?.all_targets_clear === true && states.length > 0
    && summary.total_targets === states.length && states.every(row => row.state === 'CLEAR')
}
