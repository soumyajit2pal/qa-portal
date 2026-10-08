import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { formatDateIST, formatDateTimeIST } from '../time'
import { ErrorText } from './Common'
import { OccupancyTrendOut, occupancyPath, occupancyScale } from '../testerOccupancy'

export default function TesterOccupancyTrend({ query, periodLabel, selectedTesterId, onSelectTester }: {
  query: string
  periodLabel: string
  selectedTesterId: number | null
  onSelectTester: (id: number) => void
}) {
  const [data, setData] = useState<OccupancyTrendOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  useEffect(() => {
    let current = true
    setData(null); setError(null); setActiveIndex(null)
    api.get<OccupancyTrendOut>(`/api/dashboard/qa-tester-occupancy-trend${query}`)
      .then(result => { if (current) setData(result) })
      .catch(err => { if (current) setError(err) })
    return () => { current = false }
  }, [query])

  if (error) return <ErrorText error={error} />
  if (!data) return <p role="status" className="muted">Loading occupancy history…</p>
  const tester = data.testers.find(row => row.tester_id === selectedTesterId) || data.testers[0]
  if (!tester) return <p className="muted">No QA testers are available in this workspace.</p>
  const points = tester.points
  const max = occupancyScale(points)
  const x = (index: number) => points.length === 1 ? 416 : 64 + index / Math.max(1, points.length - 1) * 704
  const y = (value: number) => 220 - value / max * 188
  const hasHistory = points.some(point => point.average_occupancy !== null)
  const selectedIndex = activeIndex !== null && points[activeIndex] ? activeIndex
    : Math.max(0, points.reduce((last, point, index) => point.average_occupancy !== null ? index : last, -1))
  const selected = points[selectedIndex]
  const ticks = [...new Set([0, Math.round((points.length - 1) / 4), Math.round((points.length - 1) / 2), Math.round((points.length - 1) * 3 / 4), points.length - 1])].filter(index => index >= 0)

  return <section className="tester-occupancy-trend" aria-label="Occupancy trend for reporting period">
    <div className="tester-trend-toolbar">
      <div><h3>Occupancy trend</h3><p>{periodLabel}</p></div>
      <label>QA tester<select value={tester.tester_id} onChange={event => { setActiveIndex(null); onSelectTester(Number(event.target.value)) }}>
        {data.testers.map(row => <option key={row.tester_id} value={row.tester_id}>{row.tester_name}</option>)}
      </select></label>
    </div>
    <div className="tester-trend-metrics">
      <div><small>Average in recorded period</small><strong>{tester.average_occupancy === null ? 'No history' : `${tester.average_occupancy}%`}</strong></div>
      <div><small>Peak occupancy</small><strong>{tester.peak_occupancy === null ? 'No history' : `${tester.peak_occupancy}%`}</strong></div>
      <div><small>Days averaging at least 80%</small><strong>{hasHistory ? tester.high_occupancy_days : 'No history'}</strong></div>
    </div>
    <div className="tester-trend-legend"><span><i className="average" />Daily average</span><span><i className="peak" />Daily peak</span><span>100% = planned capacity</span></div>
    {hasHistory ? <svg viewBox="0 0 800 266" role="img" aria-label={`${tester.tester_name} daily average and peak occupancy`}>
      <title>{`${tester.tester_name} occupancy over the reporting period`}</title>
      {[0, max / 2, max].map(value => <g key={value}><line x1="64" x2="768" y1={y(value)} y2={y(value)} className="tester-trend-grid" /><text x="52" y={y(value) + 4} textAnchor="end">{value}%</text></g>)}
      <line x1="64" x2="768" y1={y(100)} y2={y(100)} className="tester-trend-capacity" />
      <path d={occupancyPath(points, 'peak_occupancy', x, y)} className="tester-trend-peak" />
      <path d={occupancyPath(points, 'average_occupancy', x, y)} className="tester-trend-average" />
      {points.map((point, index) => point.average_occupancy === null ? null : <g key={point.date}>
        <circle cx={x(index)} cy={y(point.peak_occupancy!)} r="3" className="tester-trend-peak-dot" />
        <circle cx={x(index)} cy={y(point.average_occupancy)} r={index === selectedIndex ? 5 : 3} className="tester-trend-average-dot" onMouseEnter={() => setActiveIndex(index)}>
          <title>{`${formatDateIST(point.date)}: average ${point.average_occupancy}%, peak ${point.peak_occupancy}%`}</title>
        </circle>
      </g>)}
      {ticks.map(index => <text key={index} x={x(index)} y="247" textAnchor="middle">{formatDateIST(points[index].date).slice(0, 5)}</text>)}
    </svg> : <p className="tester-trend-empty">No recorded occupancy history is available for this period.</p>}
    {selected && <div className="tester-trend-day">
      <label>Reporting day<select value={selectedIndex} onChange={event => setActiveIndex(Number(event.target.value))}>
        {points.map((point, index) => <option key={point.date} value={index}>{formatDateIST(point.date)}</option>)}
      </select></label>
      <span>{selected.average_occupancy === null ? 'History unavailable for this day' : `Average ${selected.average_occupancy}% · Peak ${selected.peak_occupancy}% · ${selected.recorded_hours} hours recorded`}</span>
    </div>}
    <p className="tester-trend-note">Based on recorded request states and tester assignments, using the same workload weights as current occupancy. Daily averages account for time in each state; shared assignments divide the load. These are workload estimates, rather than timesheet hours.</p>
    <p className="tester-trend-note">{data.tracking_started_at ? `Reliable tracking began ${formatDateTimeIST(data.tracking_started_at)}. Earlier dates are unavailable. Partial days use only recorded time; the latest day runs through ${formatDateTimeIST(data.observed_until)}.` : 'Reliable occupancy tracking has not started. Historical percentages cannot be reconstructed from incomplete workflow logs.'}</p>
  </section>
}
