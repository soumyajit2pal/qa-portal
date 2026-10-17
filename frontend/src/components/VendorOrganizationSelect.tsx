import React, { useEffect, useId, useState } from 'react'
import { api } from '../api'
import { VendorOrganizationOut } from '../types'
import { IconSearch, IconPlus } from './Icons'
import ClearableSearchInput from './ClearableSearchInput'

export type VendorSelection = { organization_id?: number; organization_name?: string }
export function validVendorSelection(value: VendorSelection) {
  return !!value.organization_id || (value.organization_name !== undefined && value.organization_name.trim().length >= 2)
}

export default function VendorOrganizationSelect({ value, onChange, disabled = false, allowBlank = false, currentName }: {
  value: VendorSelection; onChange: (value: VendorSelection) => void; disabled?: boolean; allowBlank?: boolean; currentName?: string | null
}) {
  const [rows, setRows] = useState<VendorOrganizationOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const id = useId()
  useEffect(() => {
    let active = true
    setLoading(true); setError(null)
    api.getFresh<VendorOrganizationOut[]>('/api/vendor-organizations')
      .then(result => {
        if (active) {
          setRows(result)
          if (!allowBlank && value.organization_id && !result.some(row => row.id === value.organization_id)) onChange({})
        }
      })
      .catch(err => { if (active) setError(err) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [reload])

  const options = rows.map(row => ({ id: row.id, name: row.name, inactive: false }))
  if (value.organization_id && currentName && !rows.some(row => row.id === value.organization_id)) {
    options.push({ id: value.organization_id, name: currentName, inactive: true })
  }
  const search = query.trim().toLocaleLowerCase()
  const filtered = options.filter(row => row.name.toLocaleLowerCase().includes(search))
  const selected = options.find(row => row.id === value.organization_id)
  const empty = !loading && !error && options.length === 0
  const creating = value.organization_name !== undefined || (empty && !allowBlank)
  const locked = disabled || loading || !!error

  return <fieldset className="vendor-organization-picker" disabled={disabled}>
    <legend>Vendor organization{!allowBlank && <span className="vendor-required">Required</span>}</legend>
    <div className="vendor-directory-heading">
      <span>{creating ? 'Add your organization' : 'Choose your organization'}</span>
      <button type="button" className="vendor-text-button" disabled={disabled || loading} onClick={() => setReload(count => count + 1)}>{loading ? 'Loading…' : error ? 'Retry' : 'Refresh list'}</button>
    </div>

    {loading && <p className="vendor-directory-message" role="status">Loading organizations…</p>}
    {!!error && <div className="vendor-directory-error" role="alert"><strong>We couldn’t load the organization list.</strong><p>Select Retry to try again. Your entries are kept.</p></div>}

    {!loading && !error && <>
      {creating ? <div className="vendor-create-panel">
        {empty ? <p className="vendor-directory-message"><strong>No organizations have been added yet.</strong> Enter your organization’s official name to get started.</p> : <p className="vendor-directory-message">Use your organization’s official name so colleagues can find it later.</p>}
        <label htmlFor={`${id}-name`}>Organization name <span aria-hidden="true">*</span></label>
        <input id={`${id}-name`} aria-label="Organization name" aria-describedby={`${id}-name-help`} required minLength={2} maxLength={150}
          autoFocus={value.organization_name !== undefined} autoComplete="organization" placeholder="e.g. Acme Technologies"
          value={value.organization_name || ''} disabled={locked} onChange={event => onChange({ organization_name: event.target.value })} />
        <p id={`${id}-name-help`} className="vendor-field-help">2–150 characters. Added to the directory when you save this profile.</p>
        {(options.length > 0 || allowBlank) && <button type="button" className="vendor-text-button" disabled={locked} onClick={() => onChange({})}>← Choose an existing organization</button>}
      </div> : <>
        {options.length > 0 && <>
          <div className="vendor-organization-search">
            <IconSearch aria-hidden="true" />
            <ClearableSearchInput aria-label="Search organizations" placeholder="Search by organization name" value={query} disabled={locked} onChange={event => setQuery(event.target.value)} onClear={() => setQuery('')} clearLabel="Clear organization search" />
          </div>
        </>}
        <div className="vendor-directory-toolbar">
          <p className="vendor-result-count" role="status">{empty ? 'No organizations yet' : search ? `${filtered.length} ${filtered.length === 1 ? 'match' : 'matches'}` : `${options.length} ${options.length === 1 ? 'organization' : 'organizations'} available`}</p>
          <button type="button" className="vendor-text-button vendor-add-button" disabled={locked} onClick={() => onChange({ organization_name: query.trim() })}><IconPlus aria-hidden="true" /> Add organization</button>
        </div>
        <div className="vendor-organization-options">
          {allowBlank && <label className={`vendor-organization-option ${!value.organization_id ? 'is-selected' : ''}`}>
            <input type="radio" name={`${id}-organization`} checked={!value.organization_id} disabled={locked} onChange={() => onChange({})} />
            <span>Not provided<small>Ask this user to complete organization setup.</small></span>
          </label>}
          {filtered.map(row => <label key={row.id} className={`vendor-organization-option ${value.organization_id === row.id ? 'is-selected' : ''}`}>
            <input type="radio" name={`${id}-organization`} checked={value.organization_id === row.id} disabled={locked} onChange={() => onChange({ organization_id: row.id })} />
            <span>{row.name}{row.inactive && <small>Current organization · inactive</small>}</span>
          </label>)}
          {options.length > 0 && filtered.length === 0 && <p className="vendor-directory-message">No organizations match “{query.trim()}”. Try another name or select Add organization.</p>}
        </div>
        {selected && !filtered.some(row => row.id === selected.id) && <p className="vendor-field-help" role="status">Selected: {selected.name}</p>}
      </>}
    </>}
  </fieldset>
}
