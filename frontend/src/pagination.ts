/** Minimal shape shared by every paginated list endpoint. */
export interface PageSlice<T> {
  items: T[]
  page: number
  total_pages: number
  has_next: boolean
}

/**
 * Add/replace the standard pagination parameters without disturbing filters,
 * repeated query keys (for example `status=A&status=B`), or their encoding.
 */
export function paginatedPath(path: string, page: number, pageSize = 100): string {
  const queryIndex = path.indexOf('?')
  const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path
  const params = new URLSearchParams(queryIndex >= 0 ? path.slice(queryIndex + 1) : '')
  params.set('page', String(page))
  params.set('page_size', String(pageSize))
  return `${pathname}?${params.toString()}`
}

/**
 * Exhaust a server-paginated endpoint for controls that must offer every
 * authorized record. Tables should continue to use server-side paging.
 */
export async function fetchAllPages<T>(
  getPage: (path: string) => Promise<PageSlice<T>>,
  path: string,
  pageSize = 100,
): Promise<T[]> {
  const items: T[] = []
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await getPage(paginatedPath(path, pageNumber, pageSize))
    items.push(...page.items)
    if (!page.has_next || pageNumber >= page.total_pages) return items
  }
}
