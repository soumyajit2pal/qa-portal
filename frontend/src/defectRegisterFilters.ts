export interface DefectRegisterFilters {
  functionalRequest: string
  record_type?: string
  search?: string
  status?: string
  severity?: string
  priority?: string
  queue?: string
}

/** Same scope for the visible register, queue counts and workbook export. */
export function defectRegisterParams(filters: DefectRegisterFilters, includeQueue = true): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.functionalRequest === 'none') params.set('without_functional_request', 'true')
  else if (filters.functionalRequest) params.set('functional_request_id', filters.functionalRequest)
  for (const key of ['search', 'status', 'severity', 'priority', 'record_type'] as const) {
    if (filters[key]) params.set(key, filters[key]!)
  }
  if (includeQueue && filters.queue && filters.queue !== 'all') params.set('queue', filters.queue)
  return params
}

export function defectDetailParams(params: URLSearchParams, open?: string, openId?: number): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('execution')
  next.delete('open'); next.delete('openId'); next.delete('defect')
  if (open) next.set('open', open)
  if (openId) next.set('openId', String(openId))
  return next
}
