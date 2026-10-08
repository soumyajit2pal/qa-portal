import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { formatDateIST, formatDateTimeIST } from '../time'
import { ErrorText } from './Common'
import { OccupancyTrendOut, occupancyPath, occupancyScale } from '../testerOccupancy'

function workloadBand(value: number | null) {
  if (value === null) return { label: 'History unavailable', tone: 'unknown' }
  if (value === 0) return { label: 'Available', tone: 'light' }
  if (value < 50) return { label: 'Light', tone: 'light' }
  if (value < 80) return { label: 'Balanced', tone: 'balanced' }
  if (value < 100) return { label: 'High', tone: 'high' }
  if (value === 100) return { label: 'Full', tone: 'high' }
  return { label: 'Overloaded', tone: 'overloaded' }
}

export default function TesterOccupancyTrend({ query, periodLabel, selectedTesterId, onSelectTester }: {
  query: string
  periodLabel: string
  selectedTesterId: number | null
  onSelectTester: (id: number) => void
}) {
  const [data, setData] = useState<OccupancyTrendOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [chartWidth, setChartWidth] = useState(860)
  const plotRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const plot = plotRef.current
    if (!plot) return
    const observer = new ResizeObserver(entries => setChartWidth(Math.max(280, entries[0].contentRect.width)))
    observer.observe(plot)
    return () => observer.disconnect()
  }, [data])
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
  const recorded = points.filter(point => point.average_occupancy !== null)
  const hasHistory = recorded.length > 0
  const max = occupancyScale(points)
  const plotRight = chartWidth - 20
  const plotWidth = plotRight - 54
  const x = (index: number) => points.length === 1 ? chartWidth / 2 : 54 + index / Math.max(1, points.length - 1) * plotWidth
  const y = (value: number) => 224 - value / max * 196
  const selectedIndex = activeIndex !== null && points[activeIndex] ? activeIndex
    : Math.max(0, points.reduce((last, point, index) => point.average_occupancy !== null ? index : last, -1))
  const selected = points[selectedIndex]
  const band = workloadBand(selected?.average_occupancy ?? null)
  const ticks = [...new Set([0, Math.round((points.length - 1) / 4), Math.round((points.length - 1) / 2), Math.round((points.length - 1) * 3 / 4), points.length - 1])].filter(index => index >= 0)
  const grid = [...new Set([0, 50, 80, 100, max])]

  return <section className="tester-occupancy-trend" aria-label="Occupancy trend for reporting period">
    <div className="tester-trend-toolbar">
      <div><h3>Occupancy trend</h3><p>{periodLabel}</p></div>
      <label>QA tester<select value={tester.tester_id} onChange={event => { setActiveIndex(null); onSelectTester(Number(event.target.value)) }}>
        {data.testers.map(row => <option key={row.tester_id} value={row.tester_id}>{row.tester_name}</option>)}
      </select></label>
    </div>
    <div className="tester-trend-metrics">
      <div><small>Average occupancy</small><strong>{tester.average_occupancy === null ? '—' : `${tester.average_occupancy}%`}</strong><span>Across recorded time</span></div>
      <div><small>Peak occupancy</small><strong>{tester.peak_occupancy === null ? '—' : `${tester.peak_occupancy}%`}</strong><span>Highest recorded load</span></div>
      <div><small>High occupancy days</small><strong>{hasHistory ? tester.high_occupancy_days : '—'}</strong><span>Daily average of 80% or more</span></div>
      <div><small>History coverage</small><strong>{recorded.length}<em> / {points.length} days</em></strong><span>Days with recorded history</span></div>
    </div>
    {recorded.length < points.length && <div className="tester-trend-coverage" role="note">
      <span className="tester-trend-coverage-dot" />
      <div><strong>{recorded.length === 0 ? 'No history in this period' : `Limited history · ${recorded.length} of ${points.length} days recorded`}</strong><span>Unrecorded dates are shown in grey. Period figures use recorded time only.</span></div>
    </div>}
    <div className="tester-trend-body">
      <div className="tester-trend-plot" ref={plotRef}>
        {recorded.length > 1 ? <>
          <div className="tester-trend-plot-head"><strong>Daily occupancy</strong><div className="tester-trend-legend"><span><i className="average" />Daily average</span><span><i className="peak" />Daily peak</span></div></div>
          <svg viewBox={`0 0 ${chartWidth} 260`} preserveAspectRatio="none" role="img" aria-label={`${tester.tester_name} daily average and peak occupancy`}>
            <title>{`${tester.tester_name} occupancy over the reporting period. Gaps indicate unavailable history.`}</title>
            <rect x="54" width={plotWidth} y={y(50)} height={y(0) - y(50)} className="tester-trend-band-normal" />
            <rect x="54" width={plotWidth} y={y(80)} height={y(50) - y(80)} className="tester-trend-band-balanced" />
            <rect x="54" width={plotWidth} y={y(100)} height={y(80) - y(100)} className="tester-trend-band-high" />
            {max > 100 && <rect x="54" width={plotWidth} y={y(max)} height={y(100) - y(max)} className="tester-trend-band-overloaded" />}
            {points.map((point, index) => {
              if (point.average_occupancy !== null) return null
              const left = index === 0 ? 54 : (x(index - 1) + x(index)) / 2
              const right = index === points.length - 1 ? plotRight : (x(index) + x(index + 1)) / 2
              return <rect key={point.date} x={left} width={right - left} y="28" height="196" className="tester-trend-band-unknown" />
            })}
            {grid.map(value => <g key={value}><line x1="54" x2={plotRight} y1={y(value)} y2={y(value)} className={value === 100 ? 'tester-trend-capacity' : 'tester-trend-grid'} /><text x="43" y={y(value) + 4} textAnchor="end">{value}%</text></g>)}
            {selected && selected.average_occupancy !== null && <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1="28" y2="224" className="tester-trend-selection" />}
            <path d={occupancyPath(points, 'peak_occupancy', x, y)} className="tester-trend-peak" />
            <path d={occupancyPath(points, 'average_occupancy', x, y)} className="tester-trend-average" />
            {points.map((point, index) => point.average_occupancy === null ? null : <g key={point.date} onMouseEnter={() => setActiveIndex(index)} onClick={() => setActiveIndex(index)}>
              {point.peak_occupancy !== null && <circle cx={x(index)} cy={y(point.peak_occupancy)} r="3" className="tester-trend-peak-dot" />}
              <circle cx={x(index)} cy={y(point.average_occupancy)} r={index === selectedIndex ? 5 : 3} className="tester-trend-average-dot">
                <title>{`${formatDateIST(point.date)}: average ${point.average_occupancy}%, peak ${point.peak_occupancy}%`}</title>
              </circle>
            </g>)}
            {ticks.map(index => <text key={index} x={x(index)} y="250" textAnchor="middle">{formatDateIST(points[index].date).slice(0, 5)}</text>)}
          </svg>
          <p className="tester-trend-plot-caption">100% = planned capacity <span>·</span> Select a day below to inspect its workload.</p>
        </> : <div className="tester-trend-empty">
          <div className="tester-trend-empty-mark" aria-hidden="true">↗</div>
          <strong>{hasHistory ? 'More history is needed for a trend' : 'No recorded occupancy history is available for this period'}</strong>
          <p>{hasHistory ? `Only ${formatDateIST(recorded[0].date)} has recorded history. A trend will appear once another day is recorded.` : 'Select a more recent reporting period or check again after occupancy tracking begins.'}</p>
          <span>{hasHistory ? '1 recorded day' : 'History unavailable'} · {tester.tester_name}</span>
        </div>}
      </div>
      {selected && <aside className="tester-trend-day" aria-label="Selected reporting day">
        <label>Reporting day<select value={selectedIndex} onChange={event => setActiveIndex(Number(event.target.value))}>
          {points.map((point, index) => <option key={point.date} value={index}>{formatDateIST(point.date)}</option>)}
        </select></label>
        {selected.average_occupancy === null ? <div className="tester-trend-day-unknown"><strong>History unavailable for this day</strong><p>No occupancy estimate is available for this date.</p></div> : <>
          <div className="tester-trend-day-value"><strong>{selected.average_occupancy}<small>%</small></strong><span className={`tester-trend-status ${band.tone}`}>{band.label}</span></div>
          <span className="tester-trend-day-caption">Daily average occupancy</span>
          <div className="tester-trend-day-meter"><i className={band.tone} style={{ width: `${Math.min(100, Math.max(0, selected.average_occupancy))}%` }} /></div>
          <dl><div><dt>Daily peak</dt><dd>{selected.peak_occupancy === null ? '—' : `${selected.peak_occupancy}%`}</dd></div><div><dt>History coverage</dt><dd>{selected.recorded_hours} hours recorded</dd></div></dl>
          {selected.recorded_hours < 24 && <p className="tester-trend-partial">Partial day · average uses recorded time only.</p>}
        </>}
      </aside>}
    </div>
    {points.length > 0 && <div className="tester-trend-calendar">
      <div className="tester-trend-calendar-head"><strong>Workload by day</strong><span>Colour shows daily average</span></div>
      <div className="tester-trend-days-scroll"><div className="tester-trend-days" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(12px, 1fr))` }}>
        {points.map((point, index) => {
          const dayBand = workloadBand(point.average_occupancy)
          const description = point.average_occupancy === null ? 'History unavailable' : `${dayBand.label}, average ${point.average_occupancy}%, peak ${point.peak_occupancy}%`
          return <button type="button" key={point.date} className={`tester-trend-day-cell ${dayBand.tone}`} aria-label={`${formatDateIST(point.date)}: ${description}`} aria-pressed={index === selectedIndex} title={`${formatDateIST(point.date)} · ${description}`} onClick={() => setActiveIndex(index)} />
        })}
      </div></div>
      <div className="tester-trend-calendar-dates"><span>{formatDateIST(points[0].date)}</span><span>{formatDateIST(points[points.length - 1].date)}</span></div>
      <div className="tester-trend-band-legend"><span><i className="light" />Below 50%</span><span><i className="balanced" />50%–&lt;80%</span><span><i className="high" />80–100%</span><span><i className="overloaded" />Above 100%</span><span><i className="unknown" />No history</span></div>
    </div>}
    <details className="tester-trend-method">
      <summary>About this data</summary>
      <p>Based on recorded request states and tester assignments, using the same workload weights as current occupancy. Daily averages account for time in each state; shared assignments divide the load. These are workload estimates, rather than timesheet hours.</p>
      <p>{data.tracking_started_at ? `Reliable tracking began ${formatDateTimeIST(data.tracking_started_at)}. Earlier dates are unavailable. Partial days use only recorded time; the latest day runs through ${formatDateTimeIST(data.observed_until)}.` : 'Reliable occupancy tracking has not started. Historical percentages cannot be reconstructed from incomplete workflow logs.'}</p>
    </details>
  </section>
}
