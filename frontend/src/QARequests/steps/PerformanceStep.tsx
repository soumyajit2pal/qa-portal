import React from 'react'
import { Field } from '../../components/Common'
import { IconCheckCircle } from '../../components/Icons'
import { PRIORITIES, RISK_RATINGS, PERFORMANCE_REQUEST_TYPES, DEFAULT_PERFORMANCE_CHECKLIST_ITEMS } from '../../constants'
import { QARequestForm, SetField } from '../types'
import { ChecklistEvidencePicker, EvidenceKind } from './ChecklistEvidencePicker'

interface Props {
  form: QARequestForm
  set: SetField
  // Once the linked Performance request already exists (created on an
  // earlier save), further edits happen on that request's own page instead.
  existingPerformance: boolean
  draftRequestId?: number
  evidenceFiles: (kind: EvidenceKind, itemIndex: number) => File[]
  setEvidenceFiles: (kind: EvidenceKind, itemIndex: number, files: File[]) => void
}

// Shown only while "Performance Testing" is a selected request type --
// collects the Annexure VIII request type(s) and the 19-item "L1:
// Pre-Testing Readiness Checklist" self-declaration.
export function PerformanceStep({ form, set, existingPerformance, draftRequestId, evidenceFiles, setEvidenceFiles }: Props) {
  function toggleType(t: string) {
    set(
      'performance_request_types',
      form.performance_request_types.includes(t)
        ? form.performance_request_types.filter((x) => x !== t)
        : [...form.performance_request_types, t],
    )
  }
  function toggleChecked(item: string) {
    set(
      'performance_checked_items',
      form.performance_checked_items.includes(item)
        ? form.performance_checked_items.filter((x) => x !== item)
        : [...form.performance_checked_items, item],
    )
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Performance Testing Details</div>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
        Per Annexure VIII — QA Request Form &amp; Checklist (Performance Testing). Change Type,
        Vendor / SI Partner, Technology Stack, Release Version, Build Number and Target
        Promotion Environment aren't collected again here — they're already captured once on
        "Application &amp; Change Details" and carry straight over to the Performance request.
      </p>
      {existingPerformance ? (
        <p className="muted small">
          The linked Performance request has already been raised — edit any of these details
          (including Hash Value) on its own page (Performance Testing Requests) instead of here.
        </p>
      ) : (
        <>
          <div className="form-row">
            <Field label="Priority">
              <select value={form.performance_priority} onChange={(e) => set('performance_priority', e.target.value)}>
                {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Risk Category">
              <select value={form.performance_risk_category} onChange={(e) => set('performance_risk_category', e.target.value)}>
                {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          </div>
          <div className="chip-select">
            {PERFORMANCE_REQUEST_TYPES.map((t) => {
              const active = form.performance_request_types.includes(t)
              return (
                <label key={t} className={`chip-toggle ${active ? 'active' : ''}`}>
                  <input type="checkbox" checked={active} onChange={() => toggleType(t)} />
                  <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
                  {t}
                </label>
              )
            })}
          </div>

          <div className="section-title" style={{ marginTop: 16 }}>L1: Pre-Testing Readiness Checklist — Self-Declaration</div>
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            Tick what's already in place. This is your own declaration for reference only — QA
            will independently verify every item during Readiness (on the linked Performance
            Testing Request, once raised).
          </p>
          {DEFAULT_PERFORMANCE_CHECKLIST_ITEMS.map((ci, itemIndex) => {
            const checked = form.performance_checked_items.includes(ci.item)
            return (
              <div key={ci.item} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleChecked(ci.item)} />
                  <span>{ci.item} <span className="muted small">({ci.data_required})</span></span>
                </label>
                <ChecklistEvidencePicker kind="performance" itemIndex={itemIndex} draftRequestId={draftRequestId}
                  files={evidenceFiles('performance', itemIndex)} onFilesChange={(files) => setEvidenceFiles('performance', itemIndex, files)} />
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
