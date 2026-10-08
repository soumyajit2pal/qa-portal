export interface TesterActivityCounts {
  testcases_created: number
  defects_raised: number
  retests_performed: number
  executions_completed: number
}

export interface TesterActivityRow extends TesterActivityCounts {
  tester_id: number
  tester_name: string
}

export const TESTER_ACTIVITY_METRICS = [
  {
    key: 'testcases_created', label: 'Test cases created',
    definition: 'Unique test cases attributed to their original creator in the selected period. Versions are not added.',
  },
  {
    key: 'defects_raised', label: 'Defects raised',
    definition: 'Distinct defects reported by each tester in the selected period.',
  },
  {
    key: 'retests_performed', label: 'Defects retested',
    definition: 'Defects whose latest recorded retest is attributed to this tester in the selected period. Each defect is counted once.',
  },
  {
    key: 'executions_completed', label: 'Execution attempts',
    definition: 'Saved execution attempts in the selected period. Repeat runs of the same test case are included.',
  },
] as const

export type TesterActivityMetric = typeof TESTER_ACTIVITY_METRICS[number]['key']

export function hasRecordedTesterActivity(row: TesterActivityCounts): boolean {
  return TESTER_ACTIVITY_METRICS.some(metric => row[metric.key] > 0)
}

export function testerActivityRows(rows: TesterActivityRow[], metric: TesterActivityMetric): TesterActivityRow[] {
  return [...rows].sort((a, b) => b[metric] - a[metric]
    || a.tester_name.localeCompare(b.tester_name) || a.tester_id - b.tester_id).slice(0, 10)
}
