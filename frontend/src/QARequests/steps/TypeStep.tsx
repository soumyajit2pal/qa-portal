import React from 'react'
import { IconCheckCircle } from '../../components/Icons'
import { REQUEST_TYPES } from '../../constants'
import { QARequestForm, SetField } from '../types'

interface Props {
  form: QARequestForm
  set: SetField
}

// The "which request type(s)" chip picker -- what determines every other
// step that shows up in this wizard (see ../buildSteps.ts).
export function TypeStep({ form, set }: Props) {
  function toggleType(t: string) {
    set(
      'request_types',
      form.request_types.includes(t) ? form.request_types.filter((x) => x !== t) : [...form.request_types, t],
    )
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Request Type *</div>
      <div className="chip-select">
        {REQUEST_TYPES.map((t) => {
          const active = form.request_types.includes(t)
          return (
            <label key={t} className={`chip-toggle ${active ? 'active' : ''}`}>
              <input type="checkbox" checked={active} onChange={() => toggleType(t)} />
              <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
              {t}
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
