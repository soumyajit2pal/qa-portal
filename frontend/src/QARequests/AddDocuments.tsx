import React, { useState } from 'react'
import { api } from '../api'
import { ErrorText } from '../components/Common'

interface Props {
  reqId: number
  onAdded: () => void
}

// Small standalone upload form shown on a request's own "Documents" tab, for
// adding more supporting documents after the request has already been
// raised (see RequestDetail.tsx).
export function AddDocuments({ reqId, onAdded }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.uploadFiles(`/api/qa-requests/${reqId}/documents`, files)
      setFiles([])
      onAdded()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  function removeStaged(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="file"
          multiple
          onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])])}
        />
        <button className="btn btn-sm" disabled={busy || files.length === 0}>
          {busy ? 'Uploading...' : 'Upload'}
        </button>
      </div>
      {files.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {files.map((f, idx) => (
            <li key={`${f.name}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <span>{f.name}</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => removeStaged(idx)}
                aria-label={`Remove ${f.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
    </form>
  )
}
