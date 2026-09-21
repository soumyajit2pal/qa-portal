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

export class RequestLookupError extends Error {
  constructor(readonly identifier: string) {
    super(`Request ${identifier} was not found or is no longer available to you.`)
    this.name = 'RequestLookupError'
  }
}

const PORTAL_ORIGIN = 'https://portal.invalid'

/** Accept only canonical same-origin SPA destinations from query/API data. */
export function internalNavigationPath(value?: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value, PORTAL_ORIGIN)
    if (url.origin !== PORTAL_ORIGIN) return null
    // Reject encoded protocol-relative/backslash forms before React Router or
    // a future server fallback has an opportunity to interpret them.
    const decodedPath = decodeURIComponent(url.pathname)
    if (decodedPath.startsWith('//') || decodedPath.includes('\\') || /[\u0000-\u001f\u007f]/.test(decodedPath)) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

export function requestTarget(to: string): RequestTarget | null {
  // Module navigation and creation/search flows continue to use the router.
  const internalPath = internalNavigationPath(to)
  if (!internalPath) return null
  const url = new URL(internalPath, PORTAL_ORIGIN)
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
  throw new RequestLookupError(target.identifier)
}
