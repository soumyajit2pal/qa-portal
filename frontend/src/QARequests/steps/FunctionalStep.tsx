import React from 'react'
import { Field } from '../../components/Common'
import { PRIORITIES, RISK_RATINGS, DEFAULT_CHECKLIST_ITEMS } from '../../constants'
import { QARequestForm, SetField } from '../types'

interface Props {
  form: QARequestForm
  set: SetField
}

// Shown only while a Functional-bucket type (Functional/Sanity/Regression
// Testing/UAT Support) is selected -- collects the combined Functional QA
// request's own Priority + Risk Rating, independent of any other request
// type raised alongside it, plus its own "Ready for Testing" readiness
// checklist self-declaration -- folded into this same step (not a separate
// one) to match how SAST/DAST already self-declare their own Security
// Readiness checklist within their own step (see SastStep.tsx/DastStep.tsx).
export function FunctionalStep({ form, set }: Props) {
  function toggleChecked(item: string) {
    set(
      'checked_items',
      form.checked_items.includes(item) ? form.checked_items.filter((x) => x !== item) : [...form.checked_items, item],
    )
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Functional QA Classification *</div>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
        Priority and Risk Rating for the combined Functional QA
        request -- independent of whatever Priority/Risk applies to any other request type
        raised alongside it (see the SAST/DAST/Performance steps, if selected).
      </p>
      <div className="form-row">
        <Field label="Priority *">
          <select value={form.functional_priority} onChange={(e) => set('functional_priority', e.target.value)}>
            {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Risk Rating *">
          <select value={form.functional_risk_rating} onChange={(e) => set('functional_risk_rating', e.target.value)}>
            {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
      </div>

      <div className="form-section-title" style={{ marginTop: 16 }}>
        Readiness Checklist — Self-Declaration
      </div>
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
