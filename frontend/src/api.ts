const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string) || ''

function getToken(): string | null {
  return localStorage.getItem('qa_portal_token')
}

interface RequestOptions {
  method?: string
  body?: unknown
  formEncoded?: boolean
  isBlob?: boolean
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

async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
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

  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload })

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
    throw new Error(formatBackendReason(detail) || res.statusText || `Request failed (${res.status})`)
  }

  if (isBlob) return (res.blob() as unknown) as Promise<T>
  if (res.status === 204) return null as unknown as T
  return res.json() as Promise<T>
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
  post: <T = any>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', body }),
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
  // rather than sent as the string "undefined"/"null".
  uploadForm: <T = any>(path: string, fields: Record<string, string | Blob | undefined | null>): Promise<T> => {
    const form = new FormData()
    Object.entries(fields).forEach(([k, v]) => {
      if (v !== undefined && v !== null) form.append(k, v)
    })
    return request<T>(path, { method: 'POST', body: form, formEncoded: true })
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
  if (token) localStorage.setItem('qa_portal_token', token)
  else localStorage.removeItem('qa_portal_token')
}

export function hasToken(): boolean {
  return !!getToken()
}
