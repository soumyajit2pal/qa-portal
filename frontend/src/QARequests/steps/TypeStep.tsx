import React from 'react'
import { IconCheckCircle } from '../../components/Icons'
import { RequestTypeConfigOut } from '../../types'
import { QARequestForm, SetField } from '../types'

interface Props {
  form: QARequestForm
  set: SetField
  requestTypes: RequestTypeConfigOut[]
}

// The "which request type(s)" chip picker -- what determines every other
// step that shows up in this wizard (see ../buildSteps.ts).
export function TypeStep({ form, set, requestTypes }: Props) {
  function toggleType(t: string) {
    if (!requestTypes.find((row) => row.request_type === t)?.is_active) return
    set(
      'request_types',
      form.request_types.includes(t) ? form.request_types.filter((x) => x !== t) : [...form.request_types, t],
    )
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Request Type *</div>
      <div className="chip-select">
        {requestTypes.map((config) => {
          const t = config.request_type
          const active = form.request_types.includes(t)
          return (
            <label
              key={t}
              className={`chip-toggle ${active ? 'active' : ''} ${config.is_active ? '' : 'disabled'}`}
              title={config.is_active ? undefined : `${t} is currently disabled by an Administrator`}
            >
              <input type="checkbox" checked={active} disabled={!config.is_active} onChange={() => toggleType(t)} />
              <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
              {t}
              {!config.is_active && <small style={{ marginLeft: 3 }}>(Disabled)</small>}
            </label>
          )
        })}
      </div>
      {form.request_types.length > 0 && (
        <p className="muted small" style={{ marginTop: 10 }}>
          This QA Request is only an intake form. 
          On submission, separate requests are created for each selected testing type and sent directly for SM Approval. 
          Functional, Sanity, Regression, and UAT Support are combined into one Functional Testing Request, 
          while SAST, DAST, and Performance Testing create separate requests with their own IDs and workflows.
        </p>
      )}
    </div>
  )
}
