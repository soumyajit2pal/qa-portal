export interface OccupancyPoint {
  date: string
  average_occupancy: number | null
  peak_occupancy: number | null
  recorded_hours: number
}

export interface TesterOccupancySeries {
  tester_id: number
  tester_name: string
  points: OccupancyPoint[]
  average_occupancy: number | null
  peak_occupancy: number | null
  high_occupancy_days: number
}

export interface OccupancyTrendOut {
  tracking_started_at: string | null
  observed_until: string
  basis: 'time_weighted_daily_occupancy'
  testers: TesterOccupancySeries[]
}

export function occupancyPath(points: OccupancyPoint[], key: 'average_occupancy' | 'peak_occupancy', x: (index: number) => number, y: (percent: number) => number): string {
  let drawing = false
  return points.map((point, index) => {
    const value = point[key]
    if (value === null) { drawing = false; return '' }
    const command = drawing ? 'L' : 'M'
    drawing = true
    return `${command}${x(index)},${y(value)}`
  }).filter(Boolean).join(' ')
}

export function occupancyScale(points: OccupancyPoint[]): number {
  return Math.max(100, Math.ceil(Math.max(0, ...points.map(point => point.peak_occupancy ?? 0)) / 50) * 50)
}
