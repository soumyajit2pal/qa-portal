import React, { useState } from 'react'
import { TESTER_ACTIVITY_METRICS, TesterActivityMetric, TesterActivityRow, testerActivityRows } from '../testerActivity'

export default function TesterActivityChart({ rows }: { rows: TesterActivityRow[] }) {
  const [metricKey, setMetricKey] = useState<TesterActivityMetric>('testcases_created')
  const metric = TESTER_ACTIVITY_METRICS.find(item => item.key === metricKey)!
  const chartRows = testerActivityRows(rows, metricKey)
  const max = Math.max(1, ...chartRows.map(row => row[metricKey]))

  return <div className="tester-activity-chart">
    <label className="tester-activity-selector">Activity type
      <select value={metricKey} onChange={event => setMetricKey(event.target.value as TesterActivityMetric)}>
        {TESTER_ACTIVITY_METRICS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select>
    </label>
    <p className="tester-activity-definition">{metric.definition} Activity types are shown separately.</p>
    <div className="bar-chart" role="group" aria-label={`${metric.label} by tester`}>
      {chartRows.map(row => <div className="bar-row" key={row.tester_id} aria-label={`${row.tester_name}: ${row[metricKey]} ${metric.label.toLowerCase()}`}>
        <span className="bar-label" title={`${row.tester_name} · Tester #${row.tester_id}`}>{row.tester_name}</span>
        <div className="bar-track" aria-hidden="true"><div className="bar-fill" style={{ width: `${row[metricKey] / max * 100}%` }} /></div>
        <span className="bar-value">{row[metricKey]}</span>
      </div>)}
    </div>
    {!chartRows.length && <p className="muted">No testers match the selected filters.</p>}
    {rows.length > 10 && <p className="tester-activity-definition">Showing 10 of {rows.length} testers, ordered by {metric.label.toLowerCase()}.</p>}
  </div>
}
