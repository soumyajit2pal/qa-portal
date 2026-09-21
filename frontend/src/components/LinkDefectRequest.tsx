import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { DefectOut, QARequestListOut } from '../types'
import { ErrorText, Field, Modal } from './Common'
import SearchableSelect from './SearchableSelect'

export default function LinkDefectRequest({ defect, onChanged }: { defect: DefectOut; onChanged: (d: DefectOut) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<QARequestListOut[]>([])
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true); setError(null); setRequestId('')
    api.getAll<QARequestListOut>(`/api/qa-requests?search=${encodeURIComponent(search)}`)
      .then(options => { if (active) setRows(options.filter(r => r.application_name.toLowerCase() === defect.application_name.toLowerCase() && r.department === defect.department && r.qa_workspace_id === defect.qa_workspace_id)) })
      .catch(e => { if (active) { setError(e); setRows([]) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, search, defect.application_name, defect.department, defect.qa_workspace_id])
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    try {
      const updated = await api.post<DefectOut>(`/api/defects/${defect.id}/link-request`, { qa_request_id: Number(requestId), revision: defect.workflow_revision || 0 })
      setOpen(false); onChanged(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <><button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Link QA request (optional)</button>
    {open && <Modal title="Link QA request" onClose={() => { if (!busy) setOpen(false) }}><form onSubmit={submit}>
      <p>Select a request for {defect.application_name} in the same workspace and department. The defect keeps its existing workflow version.</p>
      <Field label="Search request ID"><input value={search} onChange={e => setSearch(e.target.value)} disabled={busy} /></Field>
      <Field label="QA request"><SearchableSelect value={requestId} onChange={setRequestId} placeholder={loading ? 'Loading…' : 'Select matching request'} options={rows.map(r => ({ value: String(r.id), label: `${r.request_id} · ${r.application_name}` }))} /></Field>
      {!loading && !rows.length && <p>No matching requests in these search results. Search by request ID to narrow the results.</p>}
      <ErrorText error={error} /><button className="btn btn-primary" disabled={busy || loading || !requestId}>{busy ? 'Linking…' : 'Link request'}</button>
    </form></Modal>}
  </>
}
