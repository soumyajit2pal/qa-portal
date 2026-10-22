import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { DefectOut, PageOut } from '../types'
import { ErrorText, Field, Modal, WarningNotice } from './Common'
import SearchableSelect from './SearchableSelect'

interface QARequestOption {
  id: number
  request_id: string
  application_name: string
  module_name?: string | null
  department: string
  cr_number?: string | null
  epic_number?: string | null
}

function optionLabel(request: QARequestOption): string {
  const references = [...new Set([request.cr_number, request.epic_number].map(value => value?.trim()).filter(Boolean))]
  return [request.request_id, references.length ? `CR/EPIC: ${references.join(' / ')}` : '', request.module_name, request.department].filter(Boolean).join(' · ')
}

export default function LinkDefectRequest({ defect, onChanged }: { defect: DefectOut; onChanged: (d: DefectOut) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<QARequestOption[]>([])
  const [selected, setSelected] = useState<QARequestOption | null>(null)
  const [hasNext, setHasNext] = useState(false)
  const [confirmDepartment, setConfirmDepartment] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [optionsError, setOptionsError] = useState<unknown>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true); setOptionsError(null)
    if (page === 1) setRows([])
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ search, page: String(page), page_size: '50' })
      api.getFresh<PageOut<QARequestOption>>(`/api/defects/${defect.id}/qa-request-options?${query}`)
        .then(result => {
          if (!active) return
          setRows(previous => [...new Map((page === 1 ? result.items : [...previous, ...result.items]).map(row => [row.id, row])).values()])
          setHasNext(result.has_next)
        })
        .catch(err => { if (active) { setOptionsError(err); setHasNext(false) } })
        .finally(() => { if (active) setLoading(false) })
    }, 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [open, search, page, defect.id, defect.workflow_revision, loadAttempt])
  const changeSearch = useCallback((query: string) => { setSearch(query); setPage(1) }, [])
  const options = selected && !rows.some(row => row.id === selected.id) ? [selected, ...rows] : rows
  const changesDepartment = !!selected && selected.department !== defect.department
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!selected || busy || (changesDepartment && !confirmDepartment)) return
    setBusy(true); setError(null)
    try {
      const updated = await api.post<DefectOut>(`/api/defects/${defect.id}/link-request`, {
        qa_request_id: selected.id, revision: defect.workflow_revision || 0,
        confirm_department_change: changesDepartment && confirmDepartment,
      })
      setOpen(false); onChanged(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <><button type="button" className="btn btn-sm" onClick={() => {
    setSearch(''); setPage(1); setRows([]); setSelected(null); setConfirmDepartment(false); setError(null); setOptionsError(null); setOpen(true)
  }}>Link QA request (optional)</button>
    {open && <Modal title="Link QA request" onClose={() => { if (!busy) setOpen(false) }} closeDisabled={busy} variant="dialog" compact preventBackdropClose><form onSubmit={submit}>
      <p>Select a raised request for <strong>{defect.application_name}</strong> in this defect’s workspace. Available departments follow your access permissions.</p>
      {defect.status !== 'New' && <p className="muted">The request must also belong to the defect’s owning department: {defect.department || 'Unspecified'}.</p>}
      <Field label="QA request"><SearchableSelect ariaLabel="QA request to link" value={selected ? String(selected.id) : ''}
        onChange={value => { setSelected(options.find(row => String(row.id) === value) || null); setConfirmDepartment(false); setError(null) }}
        disabled={busy} placeholder="Select matching request" searchPlaceholder="Search request ID, CR/EPIC, module or department..."
        onSearchChange={changeSearch} options={options.map(row => ({ value: String(row.id), label: optionLabel(row) }))}
        optionsFooter={<>{loading && <p role="status">Loading matching requests…</p>}{!loading && hasNext && <button type="button" className="btn btn-sm" onClick={() => setPage(current => current + 1)}>Load more requests</button>}</>} />
      </Field>
      {!loading && !optionsError && !rows.length && <p className="muted" role="status">{search ? 'No matching requests. Try another request ID or CR/EPIC number.' : 'No raised QA requests for this application are available to you in this workspace.'}</p>}
      {!!optionsError && <button type="button" className="btn btn-sm" disabled={loading || busy} onClick={() => setLoadAttempt(attempt => attempt + 1)}>Retry loading requests</button>}
      {changesDepartment && <WarningNotice title="Owning department will change" compact>
        <p>{defect.department || 'Unspecified'} → {selected?.department}. The workflow, resolver assignment and evidence stay unchanged.</p>
        <label><input type="checkbox" checked={confirmDepartment} disabled={busy} onChange={event => setConfirmDepartment(event.target.checked)} /> I confirm this request’s department owns the defect.</label>
      </WarningNotice>}
      <ErrorText error={error || optionsError} />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy || !selected || (changesDepartment && !confirmDepartment)}>{busy ? 'Linking…' : 'Link request'}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form></Modal>}
  </>
}
