import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { PageOut } from '../types'

// SRS 7.2 (PAG-001..010) -- the shared consumption side of
// backend/app/pagination.py. Every list page that used to call
// `api.get<XOut[]>('/api/xxx')` once and hand the complete array to
// Table (which then filtered/paginated it entirely client-side) now calls
// this hook instead: it owns page/pageSize/search/status/department/sort
// state, builds the PAG-001 query string, and re-fetches whenever any of
// them change. Pair the result with `<Table server={{...}} rows={items} />`
// (see components/Common.tsx) -- `items` is only ever the current page,
// never the whole dataset.
export interface PaginatedListFilters {
  search?: string
  status?: string[]
  department?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  // Any module-specific filters beyond the PAG-001 standard set (e.g.
  // QA Requests' `application_name`) -- merged into the query string
  // as-is. Entries that are undefined/null/empty string are omitted
  // rather than sent as the literal string "undefined"/"null"/"".
  extra?: Record<string, string | undefined | null>
}

const DEFAULT_PAGE_SIZE = 5

export function usePaginatedList<T>(path: string, filters: PaginatedListFilters = {}, options: { cursor?: boolean } = {}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [data, setData] = useState<PageOut<T> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [cursorByPage, setCursorByPage] = useState<Record<number, number | null>>({ 1: null })
  // Guards against an earlier, slower request's response overwriting a
  // later one's (e.g. typing quickly in a search box outruns the network) --
  // only the response matching the most recently issued request is applied.
  const requestId = useRef(0)

  const statusKey = (filters.status || []).join(',')
  const extraKey = filters.extra ? JSON.stringify(filters.extra) : ''

  // A changed filter, sort, or page size should always land back on page 1
  // -- otherwise narrowing a search while sitting on page 4 could request a
  // now-nonexistent page instead of the first, most relevant matches.
  useEffect(() => {
    setPage(1)
    setCursorByPage({ 1: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, statusKey, filters.department, filters.sortBy, filters.sortOrder, extraKey, pageSize, path])

  const load = useCallback(() => {
    // Some lists are scoped to a parent the caller may not have selected yet
    // (e.g. "test cases in project X", "executions in cycle Y" -- no
    // project/cycle chosen means there's nothing to fetch). An empty path
    // is treated as "nothing to load" rather than firing a request against
    // the API root -- clears any previous page's data instead of leaving it
    // stale once the caller's own guard (e.g. `projectId ? path : ''`) goes
    // empty.
    if (!path) {
      requestId.current += 1
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const qs = new URLSearchParams()
    qs.set('page', String(page))
    qs.set('page_size', String(pageSize))
    if (options.cursor) {
      qs.set('cursor_mode', 'true')
      const cursor = cursorByPage[page]
      if (cursor != null) qs.set('cursor', String(cursor))
    }
    if (filters.search) qs.set('search', filters.search)
    ;(filters.status || []).forEach((value) => qs.append('status', value))
    if (filters.department) qs.set('department', filters.department)
    if (filters.sortBy) qs.set('sort_by', filters.sortBy)
    if (filters.sortOrder) qs.set('sort_order', filters.sortOrder)
    if (filters.extra) {
      Object.entries(filters.extra).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') qs.set(key, value)
      })
    }
    const thisRequest = ++requestId.current
    setLoading(true)
    api.get<PageOut<T>>(`${path}?${qs.toString()}`)
      .then((result) => {
        if (thisRequest !== requestId.current) return
        setData(result)
        if (options.cursor && result.next_cursor != null) {
          setCursorByPage((current) => current[page + 1] === result.next_cursor
            ? current
            : { ...current, [page + 1]: result.next_cursor! })
        }
        setError(null)
      })
      .catch((err) => {
        if (thisRequest !== requestId.current) return
        setError(err)
      })
      .finally(() => {
        if (thisRequest === requestId.current) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, page, pageSize, filters.search, statusKey, filters.department, filters.sortBy, filters.sortOrder, extraKey, options.cursor, cursorByPage[page]])

  useEffect(() => { load() }, [load])

  return {
    items: data?.items || [],
    page: data?.page || page,
    pageSize: data?.page_size || pageSize,
    total: data?.total || 0,
    totalPages: data?.total_pages || 1,
    hasNext: data?.has_next || false,
    hasPrevious: data?.has_previous || false,
    loading,
    error,
    setPage: (nextPage: number) => {
      if (!options.cursor || nextPage <= page || cursorByPage[nextPage] !== undefined) setPage(nextPage)
    },
    setPageSize,
    reload: load,
  }
}
