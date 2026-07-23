const BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

function getToken() {
  return localStorage.getItem('qa_portal_token')
}

async function request(path, { method = 'GET', body, formEncoded = false, isBlob = false } = {}) {
  const headers = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let payload = body
  if (body && !formEncoded) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload })

  if (!res.ok) {
    let detail = res.statusText
    try {
      const errJson = await res.json()
      detail = errJson.detail || JSON.stringify(errJson)
    } catch (e) { /* ignore */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }

  if (isBlob) return res.blob()
  if (res.status === 204) return null
  return res.json()
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),

  login: async (username, password) => {
    const form = new URLSearchParams()
    form.append('username', username)
    form.append('password', password)
    return request('/api/auth/login', { method: 'POST', body: form, formEncoded: true })
  },

  downloadReport: async (reportKey, format = 'xlsx', filters = '') => {
    const blob = await request(
      `/api/export/${reportKey}?format=${format}&filters=${encodeURIComponent(filters)}`,
      { isBlob: true }
    )
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${reportKey}.${format}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.URL.revokeObjectURL(url)
  },

  // Uploads one or more files as multipart/form-data. `fileList` is a
  // FileList or array of File objects (e.g. from an <input type="file" multiple>).
  uploadFiles: (path, fileList) => {
    const form = new FormData()
    Array.from(fileList).forEach((f) => form.append('files', f))
    return request(path, { method: 'POST', body: form, formEncoded: true })
  },

  downloadFile: async (path, filename) => {
    const blob = await request(path, { isBlob: true })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.URL.revokeObjectURL(url)
  },
}

export function setToken(token) {
  if (token) localStorage.setItem('qa_portal_token', token)
  else localStorage.removeItem('qa_portal_token')
}

export function hasToken() {
  return !!getToken()
}
