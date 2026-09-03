// Both database IDs and older business-ID links identify a single request.
export const requestRoutes = {
  '/qa-requests': { api: '/api/qa-requests', field: 'request_id' },
  '/functional-requests': { api: '/api/functional-requests', field: 'request_id' },
  '/sast': { api: '/api/sast-requests', field: 'request_id' },
  '/dast': { api: '/api/dast-requests', field: 'request_id' },
  '/performance': { api: '/api/performance-requests', field: 'request_id' },
  '/suppression': { api: '/api/suppressions', field: 'suppression_id' },
  '/signoff': { api: '/api/signoffs', field: 'certificate_id' },
} as const

export interface RequestTarget {
  path: keyof typeof requestRoutes
  identifier: string
}

export function requestTarget(to: string): RequestTarget | null {
  // Module navigation and creation/search flows continue to use the router.
  if (!to.startsWith('/') || to.startsWith('//')) return null
  const url = new URL(to, 'https://portal.invalid')
  if (!Object.prototype.hasOwnProperty.call(requestRoutes, url.pathname) || url.searchParams.has('new')) return null
  const identifier = url.searchParams.get('openId') || url.searchParams.get('open')
  return identifier ? { path: url.pathname as RequestTarget['path'], identifier } : null
}

type LookupRow = { id: number; request_id?: string | null; suppression_id?: string; certificate_id?: string }
type LookupPage = { items: LookupRow[]; has_next: boolean }

export async function resolveRequestId(target: RequestTarget, get: (url: string) => Promise<LookupRow[] | LookupPage>): Promise<number> {
  if (/^[1-9]\d*$/.test(target.identifier)) return Number(target.identifier)
  const route = requestRoutes[target.path]
  for (let page = 1; ; page++) {
    const result = await get(`${route.api}?search=${encodeURIComponent(target.identifier)}&page_size=100&page=${page}`)
    const rows = Array.isArray(result) ? result : result.items
    const match = rows.find((row) => row[route.field]?.toUpperCase() === target.identifier.toUpperCase())
    if (match) return match.id
    if (Array.isArray(result) || !result.has_next) break
  }
  throw new Error(`Request ${target.identifier} was not found or is no longer available to you.`)
}
