import React from 'react'
import { Field } from '../../components/Common'
import { PRIORITIES, RISK_RATINGS } from '../../constants'
import { QARequestForm, SetField } from '../types'

interface Props {
  form: QARequestForm
  set: SetField
}

// Shown only while a Functional-bucket type (Functional/Sanity/Regression
// Testing/UAT Support) is selected -- collects the combined Functional QA
// request's own Priority + Risk Rating, independent of any other request
// type raised alongside it.
export function FunctionalStep({ form, set }: Props) {
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
    </div>
  )
}
