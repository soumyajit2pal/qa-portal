import React from 'react'
import { DEFAULT_CHECKLIST_ITEMS } from '../../constants'
import { QARequestForm, SetField } from '../types'

interface Props {
  form: QARequestForm
  set: SetField
}

// Functional Testing's own "Ready for Testing" readiness checklist -- shown
// only while a Functional-bucket type is selected (see ../buildSteps.ts).
// SAST/DAST have their own separate checklist, self-declared on their own
// SAST/DAST step instead (see SastStep.tsx/DastStep.tsx).
export function ChecklistStep({ form, set }: Props) {
  function toggleChecked(item: string) {
    set(
      'checked_items',
      form.checked_items.includes(item) ? form.checked_items.filter((x) => x !== item) : [...form.checked_items, item],
    )
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Readiness Checklist — Self-Declaration</div>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
        Tick what's already in place. This is your own declaration for reference only — the
        QA Lead will independently verify every item during Readiness Verification (on the linked
        Functional Testing Request, once raised).
      </p>
      {DEFAULT_CHECKLIST_ITEMS.map((ci) => {
        const checked = form.checked_items.includes(ci.item)
        return (
          <label key={ci.item} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
            <input type="checkbox" checked={checked} onChange={() => toggleChecked(ci.item)} />
            <span>{ci.item} <span className="muted small">({ci.owner})</span></span>
          </label>
        )
      })}
    </div>
  )
}
