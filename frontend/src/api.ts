const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string) || ''

function getToken(): string | null {
  return localStorage.getItem('qa_portal_token')
}

interface RequestOptions {
  method?: string
  body?: unknown
  formEncoded?: boolean
  isBlob?: boolean
  // Reported directly: "while uploading testcase from excel, though it's
  // saying api timeout 30 sec, but actually upload completed, still showing
  // error." The flat 30s abort below was applied to every request
  // uniformly, including large multipart uploads whose backend processing
  // (e.g. test_repository.py's import-xlsx, parsing + creating a row per
  // test step) can legitimately take longer than a typical CRUD call --
  // the browser gave up and showed a timeout error while the server kept
  // working and finished the import anyway, so the user saw a failure for
  // an upload that had actually succeeded. Lets a slow-by-nature call site
  // (see api.uploadForm's own optional param) opt into a longer budget
  // instead of raising the default for every request.
  timeoutMs?: number
}

const REQUEST_TIMEOUT_MS = 30_000
const GET_CACHE_TTL_MS = 8_000
const RETRYABLE_STATUSES = new Set([502, 503, 504])
const inFlightGets = new Map<string, Promise<unknown>>()
const completedGets = new Map<string, { value: unknown; expiresAt: number }>()
let cacheGeneration = 0
const activityListeners = new Set<(pending: number) => void>()
const mutationListeners = new Set<(path: string) => void>()
let pendingRequests = 0

function updateActivity(change: number) {
  pendingRequests = Math.max(0, pendingRequests + change)
  activityListeners.forEach((listener) => listener(pendingRequests))
}

/** Subscribe to all API activity. Returns an unsubscribe function. */
export function subscribeToApiActivity(listener: (pending: number) => void): () => void {
  activityListeners.add(listener)
  listener(pendingRequests)
  return () => activityListeners.delete(listener)
}

/** Subscribe to successful data-changing requests. */
export function subscribeToApiMutations(listener: (path: string) => void): () => void {
  mutationListeners.add(listener)
  return () => mutationListeners.delete(listener)
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function formatBackendReason(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail.map((item) => {
      if (!item || typeof item !== 'object') return String(item)
      const entry = item as Record<string, unknown>
      const reason = entry.msg ?? entry.message ?? entry.reason ?? entry.detail
      const location = Array.isArray(entry.loc)
        ? entry.loc.filter((part) => part !== 'body').join(' › ')
        : ''
      const message = reason ? String(reason) : JSON.stringify(entry)
      return location ? `${location}: ${message}` : message
    }).join('\n')
  }
  if (detail && typeof detail === 'object') {
    const entry = detail as Record<string, unknown>
    const reason = entry.message ?? entry.reason ?? entry.error
    if (reason) return String(reason)
    return JSON.stringify(entry)
  }
  return String(detail || '')
}

async function executeRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  const { method = 'GET', body, formEncoded = false, isBlob = false } = opts
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let payload: BodyInit | undefined
  if (body && !formEncoded) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  } else if (body) {
    payload = body as BodyInit
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('The server took too long to respond. Please try again.')
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }

  if (!res.ok) {
    let detail: unknown = res.statusText || `Request failed (${res.status})`
    try {
      const responseBody = await res.text()
      if (responseBody) {
        try {
          const errJson = JSON.parse(responseBody)
          detail = errJson.detail ?? errJson.message ?? errJson.reason ?? errJson.error ?? errJson
        } catch {
          // Some services return a plain-text reason instead of JSON. Keep it
          // verbatim so the popup never replaces a useful backend explanation
          // with a generic HTTP status.
          detail = responseBody
        }
      }
    } catch (e) { /* ignore */ }
    throw new HttpError(formatBackendReason(detail) || res.statusText || `Request failed (${res.status})`, res.status)
  }

  if (isBlob) return (res.blob() as unknown) as Promise<T>
  if (res.status === 204) return null as unknown as T
  return res.json() as Promise<T>
}

async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method || 'GET'
  const key = method === 'GET' ? `${getToken() || ''}:${path}:${opts.isBlob ? 'blob' : 'json'}` : ''
  // Briefly reuse successful JSON reads across components and route changes.
  // Mutations clear this cache below, so saved data is never hidden behind a
  // stale entry. Blob/download responses are deliberately excluded.
  const cached = key && !opts.isBlob ? completedGets.get(key) : undefined
  if (cached && cached.expiresAt > Date.now()) return cached.value as T
  if (cached) completedGets.delete(key)
  const existing = key ? inFlightGets.get(key) : undefined
  if (existing) return existing as Promise<T>

  if (method !== 'GET') {
    cacheGeneration += 1
    completedGets.clear()
    // A mutation can make every currently-running read stale. Do not let a
    // follow-up refresh attach itself to a GET that started before the save.
    // The old promises may still finish for their original callers, but new
    // reads must go to the server and observe the mutation.
    inFlightGets.clear()
  }
  const requestGeneration = cacheGeneration

  let operation!: Promise<T>
  operation = (async () => {
    updateActivity(1)
    try {
      try {
        const result = await executeRequest<T>(path, opts)
        if (method !== 'GET') mutationListeners.forEach((listener) => listener(path))
        if (key && !opts.isBlob && requestGeneration === cacheGeneration) {
          completedGets.set(key, { value: result, expiresAt: Date.now() + GET_CACHE_TTL_MS })
        }
        return result
      } catch (error) {
        // A single safe retry handles brief proxy/backend restarts. Mutations
        // are never retried because doing so could submit data twice.
        const retryable = method === 'GET' &&
          (!(error instanceof HttpError) || RETRYABLE_STATUSES.has(error.status))
        if (!retryable) throw error
        await new Promise((resolve) => window.setTimeout(resolve, 350))
        const result = await executeRequest<T>(path, opts)
        if (method !== 'GET') mutationListeners.forEach((listener) => listener(path))
        if (key && !opts.isBlob && requestGeneration === cacheGeneration) {
          completedGets.set(key, { value: result, expiresAt: Date.now() + GET_CACHE_TTL_MS })
        }
        return result
      }
    } finally {
      updateActivity(-1)
      // Do not let an older request remove a newer request stored under the
      // same key after a mutation invalidated the in-flight map.
      if (key && inFlightGets.get(key) === operation) inFlightGets.delete(key)
    }
  })()

  if (key) inFlightGets.set(key, operation)
  return operation
}

// Triggers a same-origin download for a Blob response (report exports,
// document downloads) -- a temporary <a download> click, then cleanup.
function triggerDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

export const api = {
  get: <T = any>(path: string): Promise<T> => request<T>(path),
  // `timeoutMs` (optional, third arg) lets a caller whose POST triggers slow
  // server-side bulk work (e.g. adding a few thousand testcases to a Test
  // Cycle at once) raise the default 30s budget instead of racing it -- see
  // RequestOptions.timeoutMs's own comment and api.uploadForm's matching
  // pattern.
  post: <T = any>(path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
    request<T>(path, { method: 'POST', body, timeoutMs }),
  put: <T = any>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PUT', body }),
  patch: <T = any>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body }),
  del: <T = any>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),

  login: async (username: string, password: string): Promise<{ access_token: string; token_type: string; roles: string[]; full_name: string; username: string }> => {
    const form = new URLSearchParams()
    form.append('username', username)
    form.append('password', password)
    return request(`/api/auth/login`, { method: 'POST', body: form, formEncoded: true })
  },

  downloadReport: async (reportKey: string, format: string = 'xlsx', filters: string = ''): Promise<void> => {
    const blob = await request<Blob>(
      `/api/export/${reportKey}?format=${format}&filters=${encodeURIComponent(filters)}`,
      { isBlob: true }
    )
    triggerDownload(blob, `${reportKey}.${format}`)
  },

  // Uploads one or more files as multipart/form-data. `fileList` is a
  // FileList or array of File objects (e.g. from an <input type="file" multiple>).
  uploadFiles: <T = any>(path: string, fileList: FileList | File[]): Promise<T> => {
    const form = new FormData()
    Array.from(fileList).forEach((f) => form.append('files', f))
    return request<T>(path, { method: 'POST', body: form, formEncoded: true })
  },

  downloadFile: async (path: string, filename: string): Promise<void> => {
    const blob = await request<Blob>(path, { isBlob: true })
    triggerDownload(blob, filename)
  },

  // Authenticated Blob fetch used when a protected file must be displayed
  // inline (for example, images pasted into a Jira-style comment). Native
  // <img src> requests cannot attach the portal's Bearer token, so callers
  // fetch through this helper and render a short-lived object URL instead.
  getBlob: (path: string): Promise<Blob> => request<Blob>(path, { isBlob: true }),

  // Uploads a single named file plus optional extra form fields -- unlike
  // uploadFiles above (always field name 'files', no other data), this is
  // for endpoints that take one specific file field alongside other form
  // data (e.g. Test Repository's xlsx import, which also takes an optional
  // folder_id). Fields with an undefined/null value are omitted entirely
  // rather than sent as the string "undefined"/"null". `timeoutMs` lets a
  // caller whose upload triggers slow server-side processing (e.g. a large
  // Excel import creating many rows) raise the default 30s budget instead
  // of racing it -- see RequestOptions.timeoutMs's own comment.
  uploadForm: <T = any>(
    path: string,
    fields: Record<string, string | Blob | undefined | null>,
    timeoutMs?: number,
  ): Promise<T> => {
    const form = new FormData()
    Object.entries(fields).forEach(([k, v]) => {
      if (v !== undefined && v !== null) form.append(k, v)
    })
    return request<T>(path, { method: 'POST', body: form, formEncoded: true, timeoutMs })
  },

  // Multipart form with repeatable file fields. Used by rich comments,
  // where formatted body text and several pasted images are submitted as
  // one atomic user action.
  uploadFormFiles: <T = any>(
    path: string,
    fields: Record<string, string | undefined | null>,
    files: File[],
    fileField: string = 'files',
  ): Promise<T> => {
    const form = new FormData()
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined && value !== null) form.append(key, value)
    })
    files.forEach((file) => form.append(fileField, file))
    return request<T>(path, { method: 'POST', body: form, formEncoded: true })
  },
}

export function setToken(token: string | null | undefined): void {
  cacheGeneration += 1
  completedGets.clear()
  inFlightGets.clear()
  if (token) localStorage.setItem('qa_portal_token', token)
  else localStorage.removeItem('qa_portal_token')
}

export function hasToken(): boolean {
  return !!getToken()
}
