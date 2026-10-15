import React from 'react'
import { Field } from './Common'

/** Shared by QA request creation and returned Functional Request corrections. */
export default function BusinessDefectNumberField({ changeType, value, onChange }: {
  changeType: string
  value: string
  onChange: (value: string) => void
}) {
  if (changeType !== 'Bug Fix') return null
  return <Field label="Defect Number (Raised By Business)">
    <input value={value} maxLength={64} placeholder="Enter the defect number raised by business"
      onChange={event => onChange(event.target.value)} />
  </Field>
}
