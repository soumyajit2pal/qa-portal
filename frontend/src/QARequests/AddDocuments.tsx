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

  return (
    <form onSubmit={submit} style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} />
      <button className="btn btn-sm" disabled={busy || files.length === 0}>
        {busy ? 'Uploading...' : 'Upload'}
      </button>
      <ErrorText error={error} />
    </form>
  )
}
