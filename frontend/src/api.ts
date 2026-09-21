import { encryptLogin, LoginKey } from './loginEncryption'
import { isQaEvidenceUpload, qaDocumentSizeError } from './qaDocumentUpload'
import { isWorkspaceSelectionStorageChange, selectedWorkspaceStorageId } from './workspaceTransition'
import { fetchAllPages } from './pagination'

const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string) || ''

// Remove credentials written by releases that used browser storage. The
// current session cookie is HttpOnly and is never read or copied by JS.
try {
  localStorage.removeItem('qa_portal_token')
  sessionStorage.removeItem('qa_portal_token')
} catch { /* Storage can be unavailable in restricted browser contexts. */ }

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}=`))
  if (!match) return null
  try { return decodeURIComponent(match.slice(name.length + 1)) }
  catch { return null }
}

function csrfToken(): string | null {
  // Production uses the __Host- prefix; development uses the non-secure name.
  return readCookie('__Host-QAP-CSRF') || readCookie('QAP-CSRF')
}

interface RequestOptions {
  method?: string
  body?: unknown
  formEncoded?: boolean
  isBlob?: boolean
  // Some operations expose their own, more useful progress UI. Excluding
  // those requests prevents the generic page-loading indicator from
  // competing with that operation-specific status.
  trackActivity?: boolean
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
// localStorage is shared by every tab. If another tab changes the selected
// workspace, block any interval/click request that races the reload installed
// by AuthContext; otherwise an old-workspace screen can submit with the new
// X-Workspace-ID during the brief hand-off.
let crossTabWorkspaceChange = false
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (isWorkspaceSelectionStorageChange(event)) crossTabWorkspaceChange = true
  })
}
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
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    const csrf = csrfToken()
    if (csrf) headers['X-CSRF-Token'] = csrf
  }
  const activeWorkspace = selectedWorkspaceStorageId(localStorage)
  if (activeWorkspace) headers['X-Workspace-ID'] = activeWorkspace

  let payload: BodyInit | undefined
  if (body && !formEncoded) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  } else if (body) {
    payload = body as BodyInit
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload, signal: controller.signal, credentials: 'include' })

    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/login')) {
        window.dispatchEvent(new Event('qa-session-expired'))
      }
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

    // Await body consumption before releasing the deadline (including downloads).
    if (isBlob) return await res.blob() as T
    if (res.status === 204) return null as T
    return await res.json() as T
  } catch (error) {
    if (controller.signal.aborted) throw new HttpError(STATUS_MESSAGES[408], 408)
    if (error instanceof HttpError) throw error
    throw new HttpError(
      'QualityOps could not connect to the application service. Check your network connection and try again.', 0,
    )
  } finally {
    window.clearTimeout(timeout)
  }
}

async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (crossTabWorkspaceChange) {
    throw new HttpError('The active workspace changed in another tab. This page is reloading before more work can be submitted.', 409)
  }
  const method = opts.method || 'GET'
  // Workspace is part of response identity. The same account can switch
  // workspaces while staying signed in, and `/api/dashboard/*` paths do not
  // contain that scope because it is carried in X-Workspace-ID. Without it,
  // an in-flight or eight-second cached response from workspace A could be
  // rendered after workspace B became active.
  const activeWorkspace = selectedWorkspaceStorageId(localStorage)
  // Encryption challenges are single-use, including across concurrent actions.
  const key = method === 'GET' && !['/api/auth/me', '/api/auth/login-key'].includes(path.split('?')[0])
    ? `${activeWorkspace}:${path}:${opts.isBlob ? 'blob' : 'json'}`
    : ''
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
    const trackActivity = opts.trackActivity !== false
    if (trackActivity) updateActivity(1)
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
      if (trackActivity) updateActivity(-1)
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
  // Pickers and exports need the complete authorized result set. Keep this
  // separate from normal tables, which should retain server-side paging.
  getAll: <T = any>(path: string): Promise<T[]> =>
    fetchAllPages<T>((pagePath) => request(pagePath), path),
  getWithoutActivity: <T = any>(path: string): Promise<T> =>
    request<T>(path, { trackActivity: false }),
  // `timeoutMs` (optional, third arg) lets a caller whose POST triggers slow
  // server-side bulk work (e.g. adding a few thousand testcases to a Test
  // Cycle at once) raise the default 30s budget instead of racing it -- see
  // RequestOptions.timeoutMs's own comment and api.uploadForm's matching
  // pattern.
  post: <T = any>(path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
    request<T>(path, { method: 'POST', body, timeoutMs }),
  // For a mutation embedded in a component that already presents a blocking
  // progress state (for example Document Portal upload validation).
  postWithoutActivity: <T = any>(path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
    request<T>(path, { method: 'POST', body, timeoutMs, trackActivity: false }),
  put: <T = any>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PUT', body }),
  patch: <T = any>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body }),
  del: <T = any>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),

  login: async (username: string, password: string): Promise<{ roles: string[]; full_name: string; username: string }> => {
    if (import.meta.env.PROD && window.location.protocol !== 'https:') {
      throw new Error('HTTPS is required. Open the secure portal URL before signing in.')
    }
    const key = await request<LoginKey>('/api/auth/login-key', { method: 'GET' })
    const envelope = await encryptLogin(key, username, password)
    return request('/api/auth/login', { method: 'POST', body: envelope })
  },

  createUser: async <T = any>(body: { username: string; login_type: string; password?: string; [key: string]: unknown }): Promise<T> => {
    const { password, ...payload } = body
    if (body.login_type === 'LDAP') {
      return request<T>('/api/auth/users', { method: 'POST', body: payload })
    }
    const key = await request<LoginKey>('/api/auth/login-key', { method: 'GET' })
    const encrypted_password = await encryptLogin(key, `create-user:${body.username}`, password || '')
    return request<T>('/api/auth/users', { method: 'POST', body: { ...payload, encrypted_password } })
  },

  resetUserPassword: async (userId: number, password: string): Promise<unknown> => {
    const key = await request<LoginKey>('/api/auth/login-key', { method: 'GET' })
    const encrypted_password = await encryptLogin(key, `reset-password:${userId}`, password)
    return request(`/api/auth/users/${userId}/reset-password`, { method: 'POST', body: { encrypted_password } })
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
    const files = Array.from(fileList)
    const qaEvidenceUpload = isQaEvidenceUpload(path)
    const sizeError = qaEvidenceUpload ? qaDocumentSizeError(files) : null
    if (sizeError) return Promise.reject(new Error(sizeError))
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    return request<T>(path, { method: 'POST', body: form, formEncoded: true, timeoutMs: qaEvidenceUpload ? 600_000 : undefined })
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
  // inline (for example, images pasted into a Jira-style comment). Fetching
  // here provides normal API error handling and a revocable object URL.
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
    // Repository uploads are capacity-based rather than size-based. A large
    // valid file on a slower internal network must not fail merely because a
    // fixed five-minute client timer elapsed. XMLHttpRequest timeout=0 keeps
    // it active until the server responds or the connection actually fails.
    timeoutMs: number = 0,
  ): Promise<T> => new Promise((resolve, reject) => {
    if (crossTabWorkspaceChange) {
      reject(new HttpError('The active workspace changed in another tab. This page is reloading before more work can be submitted.', 409))
      return
    }
    const form = new FormData()
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined && value !== null) form.append(key, value)
    })
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}${path}`)
    const csrf = csrfToken()
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf)
    const activeWorkspace = selectedWorkspaceStorageId(localStorage)
    if (activeWorkspace) xhr.setRequestHeader('X-Workspace-ID', activeWorkspace)
    xhr.withCredentials = true
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
      if (xhr.status === 401 && !path.startsWith('/api/auth/login')) {
        window.dispatchEvent(new Event('qa-session-expired'))
      }
      reject(new HttpError(formatBackendReason(payload?.detail ?? payload) || statusMessage(xhr.status, xhr.statusText), xhr.status))
    }
    // This helper is only used when the caller renders granular upload
    // progress, so do not also show the global "loading data" indicator.
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

export function setToken(_token: string | null | undefined): void {
  // Compatibility cleanup for tokens issued by releases before cookie
  // sessions. Authentication is now carried only by the HttpOnly cookie.
  cacheGeneration += 1
  completedGets.clear()
  inFlightGets.clear()
  try {
    localStorage.removeItem('qa_portal_token')
    sessionStorage.removeItem('qa_portal_token')
  } catch { /* Credential cleanup must not break cookie-based sign-in/out. */ }
}
