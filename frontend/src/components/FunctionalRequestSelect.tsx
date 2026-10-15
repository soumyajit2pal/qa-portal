import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { PageOut } from '../types'
import { ErrorText } from './Common'
import SearchableSelect from './SearchableSelect'

export interface FunctionalRequestOption {
  id: number
  request_id: string
  application_name: string
  module_name?: string | null
  status: string
}

export default function FunctionalRequestSelect({ value, onChange, defectId, filter = false, disabled = false }: {
  value: string; onChange: (value: string) => void; defectId?: number; filter?: boolean; disabled?: boolean
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<FunctionalRequestOption[]>([])
  const [selected, setSelected] = useState<FunctionalRequestOption | null>(null)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!value || value === 'none') { setSelected(null); return }
    let active = true
    const qs = new URLSearchParams({ request_id: value })
    if (defectId) qs.set('defect_id', String(defectId))
    api.get<PageOut<FunctionalRequestOption>>(`/api/defects/functional-request-options?${qs}`).then(result => {
      if (active) setSelected(result.items[0] || null)
    }).catch(err => { if (active) { setSelected(null); setError(err) } })
    return () => { active = false }
  }, [value, defectId])
  useEffect(() => {
    let active = true
    setLoading(true); setError(null)
    if (page === 1) setRows([])
    const timer = window.setTimeout(() => {
      const qs = new URLSearchParams({ search, page: String(page), page_size: '50' })
      if (defectId) qs.set('defect_id', String(defectId))
      api.get<PageOut<FunctionalRequestOption>>(`/api/defects/functional-request-options?${qs}`).then(result => {
        if (active) { setRows(previous => page === 1 ? result.items : [...previous, ...result.items]); setHasNext(result.has_next) }
      }).catch(err => { if (active) { setError(err); setHasNext(false) } })
        .finally(() => { if (active) setLoading(false) })
    }, 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [search, page, defectId])
  const changeSearch = React.useCallback((query: string) => { setSearch(query); setPage(1) }, [])
  const options = new Map(rows.map(row => [String(row.id), { value: String(row.id), label: `${row.request_id} · ${row.application_name}${row.module_name ? ` · ${row.module_name}` : ''} · ${row.status}` }]))
  if (selected) options.set(String(selected.id), { value: String(selected.id), label: `${selected.request_id} · ${selected.application_name}` })
  return <div style={{ minWidth: 240 }}>
    <SearchableSelect value={value} onChange={onChange} disabled={disabled} ariaLabel="Functional Request"
      placeholder={filter ? 'All Functional Requests' : 'Select Functional Request'} searchPlaceholder="Search request ID, application or module"
      onSearchChange={changeSearch} options={[
        ...(filter ? [{ value: '', label: 'All Functional Requests' }, { value: 'none', label: 'No Functional Request linked' }] : []),
        ...options.values(),
      ]} optionsFooter={<>{loading && <p role="status">Loading requests…</p>}{!loading && hasNext && <button type="button" className="btn btn-sm" onClick={() => setPage(current => current + 1)}>Load more requests</button>}</>} />
    <ErrorText error={error} />
  </div>
}
