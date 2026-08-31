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
const RETRYABLE_STATUSES = new Set([408, 502, 503, 504])
const inFlightGets = new Map<string, Promise<unknown>>()
const completedGets = new Map<string, { value: unknown; expiresAt: number }>()
let cacheGeneration = 0
const activityListeners = new Set<(pending: number) => void>()
export interface ApiMutationEvent {
  path: string
  method: string
}

const mutationListeners = new Set<(event: ApiMutationEvent) => void>()
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
export function subscribeToApiMutations(listener: (event: ApiMutationEvent) => void): () => void {
  mutationListeners.add(listener)
  return () => mutationListeners.delete(listener)
}

/**
 * Process browser API work with a fixed upper bound instead of allowing a
 * large attachment/history list to open one HTTP (and therefore DB-backed)
 * request per item at once. The order of the returned values matches input.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)
  async function worker() {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reference?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request could not be processed. Review the entered information and try again.',
  401: 'Your session has expired or is no longer valid. Sign in again and retry the action.',
  403: 'Your account does not have permission to perform this action.',
  404: 'The requested record or service endpoint could not be found.',
  408: 'The server took too long to respond. Please wait a moment and try again.',
  409: 'The record changed while you were working. Refresh it and try again.',
  413: 'The submitted file or request is too large.',
  422: 'Some submitted information is invalid or incomplete.',
  429: 'Too many requests were received. Wait a moment before trying again.',
  500: 'The application service encountered an unexpected error.',
  502: 'QualityOps cannot reach the application service right now. The service may be restarting.',
  503: 'The application service is temporarily unavailable.',
  504: 'The application service did not respond before the gateway timeout.',
}

function looksLikeHtml(value: string, contentType: string): boolean {
  const normalized = value.trim().toLowerCase()
  return contentType.toLowerCase().includes('text/html')
    || normalized.startsWith('<!doctype html')
    || normalized.startsWith('<html')
    || /<body[\s>]/i.test(value)
}

function statusMessage(status: number, statusText: string): string {
  return STATUS_MESSAGES[status]
    || (status >= 500
      ? 'The application service could not complete the request.'
      : statusText || `The request failed with HTTP status ${status}.`)
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
      throw new HttpError(STATUS_MESSAGES[408], 408)
    }
    throw new HttpError(
      'QualityOps could not connect to the application service. Check your network connection and try again.',
      0,
    )
  } finally {
    window.clearTimeout(timeout)
  }

  if (!res.ok) {
    let detail: unknown = null
    let reference = res.headers.get('x-request-id') || res.headers.get('x-audit-request-id') || undefined
    try {
      const responseBody = await res.text()
      if (responseBody) {
        try {
          const errJson = JSON.parse(responseBody)
          detail = errJson.detail ?? errJson.message ?? errJson.reason ?? errJson.error ?? errJson
          reference = errJson.request_id || reference
        } catch {
          // Reverse proxies commonly return branded/full HTML error pages.
          // Never expose that markup to users. Genuine short plain-text API
          // explanations are retained for non-5xx responses only.
          const contentType = res.headers.get('content-type') || ''
          if (!looksLikeHtml(responseBody, contentType) && res.status < 500) {
            detail = responseBody.trim().slice(0, 2_000)
          }
        }
      }
    } catch (e) { /* ignore */ }
    const backendReason = formatBackendReason(detail)
    const message = backendReason || statusMessage(res.status, res.statusText)
    throw new HttpError(message, res.status, reference)
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
        if (method !== 'GET') mutationListeners.forEach((listener) => listener({ path, method }))
        if (key && !opts.isBlob && requestGeneration === cacheGeneration) {
          completedGets.set(key, { value: result, expiresAt: Date.now() + GET_CACHE_TTL_MS })
        }
        return result
      } catch (error) {
        // A single safe retry handles brief proxy/backend restarts. Mutations
        // are never retried because doing so could submit data twice.
        const retryable = method === 'GET' &&
          (!(error instanceof HttpError) || error.status === 0 || RETRYABLE_STATUSES.has(error.status))
        if (!retryable) throw error
        await new Promise((resolve) => window.setTimeout(resolve, 350))
        const result = await executeRequest<T>(path, opts)
        if (method !== 'GET') mutationListeners.forEach((listener) => listener({ path, method }))
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

  downloadReport: async (reportKey: string, format: string = 'xlsx', filters: string = '', dateFrom = '', dateTo = ''): Promise<void> => {
    const params = new URLSearchParams({ format, filters })
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    const blob = await request<Blob>(
      `/api/export/${reportKey}?${params.toString()}`,
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

  // Same authenticated Blob handoff as downloadFile, for endpoints whose
  // download selection is expressed as JSON (for example, a folder/file
  // selection that the server turns into one ZIP archive).
  downloadPost: async (path: string, body: unknown, filename: string): Promise<void> => {
    const blob = await request<Blob>(path, { method: 'POST', body, isBlob: true })
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

  // XHR is used only where a user needs granular upload progress. Fetch does
  // not expose request-body progress, while the Document Portal must report
  // each file's transfer state for large evidence-folder uploads.
  uploadFormWithProgress: <T = any>(
    path: string,
    fields: Record<string, string | Blob | undefined | null>,
    onProgress: (loaded: number, total: number) => void,
    timeoutMs: number = 5 * 60_000,
  ): Promise<T> => new Promise((resolve, reject) => {
    const form = new FormData()
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined && value !== null) form.append(key, value)
    })
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}${path}`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.timeout = timeoutMs
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onerror = () => reject(new HttpError('QualityOps could not connect to the application service. Check your network connection and try again.', 0))
    xhr.ontimeout = () => reject(new HttpError(STATUS_MESSAGES[408], 408))
    xhr.onload = () => {
      let payload: any = null
      try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        cacheGeneration += 1
        completedGets.clear()
        inFlightGets.clear()
        mutationListeners.forEach((listener) => listener({ path, method: 'POST' }))
        resolve(payload as T)
        return
      }
      reject(new HttpError(formatBackendReason(payload?.detail ?? payload) || statusMessage(xhr.status, xhr.statusText), xhr.status))
    }
    updateActivity(1)
    xhr.onloadend = () => updateActivity(-1)
    xhr.send(form)
  }),

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

export interface BackgroundJob<T = Record<string, unknown>> {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  progress: number
  result?: T | null
  error?: string | null
  artifact_name?: string | null
}

export async function waitForJob<T = Record<string, unknown>>(jobId: string): Promise<BackgroundJob<T>> {
  for (;;) {
    const job = await api.get<BackgroundJob<T>>(`/api/jobs/${jobId}?poll=${Date.now()}`)
    if (job.status === 'FAILED') throw new Error(job.error || 'The background operation failed')
    if (job.status === 'COMPLETED') return job
    await new Promise((resolve) => window.setTimeout(resolve, 1000))
  }
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
