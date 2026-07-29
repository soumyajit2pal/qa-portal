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
      {form.request_types.includes('Others') && (
        <input
          placeholder="Please specify other request type"
          value={form.request_type_other}
          onChange={(e) => set('request_type_other', e.target.value)}
          style={{ marginTop: 10 }}
        />
      )}
      {form.request_types.length > 0 && (
        <p className="muted small" style={{ marginTop: 10 }}>
          This QA Request is just the intake form — a separate request with its own unique ID will be raised
          for each selected type, landing straight at SM Approval Pending the moment you submit (no separate
          Draft/Submit step of its own): Functional Testing / Sanity Testing / Regression Testing / UAT Support
          are combined into one Functional Testing Request, while SAST, DAST, and Performance Testing
          each get their own separate request (see the extra page(s) added above for the ones that need more
          detail up front). Every one of these runs its own workflow from here — this gateway record itself
          has no approval step of its own.
        </p>
      )}
    </div>
  )
}
