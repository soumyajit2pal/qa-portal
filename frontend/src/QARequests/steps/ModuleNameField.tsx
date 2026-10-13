import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { Field } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'

const NEW_MODULE = '__new_module__'

interface Props {
  applicationName: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  workspaceId?: number | null
  recordLabel?: string
}

export function ModuleNameField({ applicationName, value, onChange, disabled = false, workspaceId, recordLabel = 'request' }: Props) {
  const [modules, setModules] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const hasApplication = !!applicationName.trim()

  useEffect(() => {
    setModules([])
    setLoadFailed(false)
    if (!hasApplication) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ application_name: applicationName.trim() })
      if (workspaceId) params.set('workspace_id', String(workspaceId))
      api.get<string[]>(`/api/qa-requests/module-options?${params}`)
        .then((rows) => { if (!cancelled) { setModules(rows); setLoadFailed(false) } })
        .catch(() => { if (!cancelled) setLoadFailed(true) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [applicationName, hasApplication, workspaceId])

  const showInput = creating || (!!value && !modules.includes(value))
  return (
    <Field label="Module Name (optional)">
      <SearchableSelect
        ariaLabel="Module Name"
        value={showInput ? NEW_MODULE : value}
        disabled={disabled || !hasApplication}
        placeholder={hasApplication ? 'Select Module Name' : 'Select an application first'}
        options={[
          { value: '', label: 'Whole application (no module)' },
          ...modules.map((name) => ({ value: name, label: name })),
          { value: NEW_MODULE, label: 'Other (new module)' },
        ]}
        onChange={(next) => {
          setCreating(next === NEW_MODULE)
          onChange(next === NEW_MODULE ? '' : next)
        }}
      />
      {showInput && (
        <input
          aria-label="New Module Name"
          placeholder="Type the new module name"
          maxLength={150}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          style={{ marginTop: 6 }}
        />
      )}
      <p className="muted small" style={{ margin: '4px 0 0' }}>
        {loadFailed ? 'Modules could not be loaded. You can still enter a new module name. '
          : loading ? 'Loading saved modules. ' : ''}
        New modules are saved with this {recordLabel} and are available for this application in this workspace. No approval is needed.
      </p>
    </Field>
  )
}
