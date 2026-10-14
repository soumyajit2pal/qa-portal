import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { RequestDocumentOut } from '../types'
import { ErrorText } from './Common'

export default function DefectEvidencePicker({ defectId, selectedIds, onChange, disabled = false }: {
  defectId: number; selectedIds: number[]; onChange: (ids: number[]) => void; disabled?: boolean
}) {
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [refresh, setRefresh] = useState(0)
  const selection = useRef({ selectedIds, onChange })
  selection.current = { selectedIds, onChange }
  useEffect(() => {
    let active = true
    setDocuments([]); setLoading(true); setError(null)
    api.getFresh<RequestDocumentOut[]>(`/api/defects/${defectId}/attachments`)
      .then(rows => {
        if (!active) return
        setDocuments(rows)
        const available = new Set(rows.map(row => row.id))
        const retained = selection.current.selectedIds.filter(id => available.has(id))
        if (retained.length !== selection.current.selectedIds.length) selection.current.onChange(retained)
      })
      .catch(err => { if (active) setError(err) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [defectId, refresh])
  return <div className="workflow-existing-evidence">
    <strong>Reuse attached evidence</strong>
    <p className="muted small">Select files relevant to this action, environment and build. Each verification still needs a fresh confirmation.</p>
    {loading ? <p role="status">Loading evidence…</p> : documents.length ? documents.map(doc =>
      <label className="workflow-evidence-choice" key={doc.id}>
        <input type="checkbox" checked={selectedIds.includes(doc.id)}
          disabled={disabled || (!selectedIds.includes(doc.id) && selectedIds.length >= 50)}
          onChange={event => onChange(event.target.checked
            ? [...new Set([...selectedIds, doc.id])] : selectedIds.filter(id => id !== doc.id))} />
        <span>{doc.file_name}</span>
      </label>) : !error && <p className="muted small">No evidence is currently attached.</p>}
    <ErrorText error={error} />
    <button type="button" className="link-btn" disabled={disabled || loading} onClick={() => setRefresh(value => value + 1)}>Refresh attached evidence</button>
  </div>
}
