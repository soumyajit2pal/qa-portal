import React from 'react'
import { Field } from '../../components/Common'
import { IconCheckCircle } from '../../components/Icons'
import { PRIORITIES, RISK_RATINGS, PERFORMANCE_REQUEST_TYPES, POST_SIT_ENVIRONMENTS } from '../../constants'
import { DraftChecklistEvidenceOut } from '../../types'
import { QARequestForm, SetField } from '../types'
import { EvidenceKind } from './ChecklistEvidencePicker'
import { ReadinessChecklistSection } from './ReadinessChecklistSection'

interface Props {
  form: QARequestForm
  set: SetField
  // Once the linked Performance request already exists (created on an
  // earlier save), further edits happen on that request's own page instead.
  existingPerformance: boolean
  draftRequestId?: number
  evidenceFiles: (kind: EvidenceKind, itemIndex: number) => File[]
  setEvidenceFiles: (kind: EvidenceKind, itemIndex: number, files: File[]) => void
  savedEvidenceFor: (kind: EvidenceKind, itemIndex: number) => DraftChecklistEvidenceOut[]
  onEvidenceChanged: () => void
  focusEvidenceItem?: string
}

// Shown only while "Performance Testing" is a selected request type --
// collects the Annexure VIII request type(s) and the 19-item "L1:
// Pre-Testing Readiness Checklist" self-declaration.
export function PerformanceStep({ form, set, existingPerformance, draftRequestId, evidenceFiles, setEvidenceFiles, savedEvidenceFor, onEvidenceChanged, focusEvidenceItem }: Props) {
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
    <div className="security-request-step security-request-step-performance">
      <div className="security-step-intro">
        <span>Performance request configuration</span>
        <h3>Performance testing details</h3>
        <p>Define classification, target environment, testing scope, and pre-testing readiness evidence.</p>
      </div>
      {existingPerformance ? (
        <div className="security-existing-request">
          <strong>Performance request already raised</strong>
          <span>Edit its configuration from Performance Requests. This intake step is now read-only.</span>
        </div>
      ) : (
        <>
          <section className="security-request-panel">
            <div className="security-panel-heading">
              <span className="security-panel-number">01</span>
              <div><h4>Classification and environment</h4><p>Set urgency, risk, and the post-SIT environment where performance testing will run.</p></div>
            </div>
            <div className="security-classification-grid security-performance-classification">
              <Field label="Priority *">
                <select value={form.performance_priority} onChange={(e) => set('performance_priority', e.target.value)}>
                  {PRIORITIES.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              <Field label="Risk Category *">
                <select value={form.performance_risk_category} onChange={(e) => set('performance_risk_category', e.target.value)}>
                  {RISK_RATINGS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              <Field label="Environment *">
                <select value={form.performance_environment} onChange={(e) => set('performance_environment', e.target.value)}>
                  {POST_SIT_ENVIRONMENTS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
            </div>
          </section>

          <section className="security-request-panel">
            <div className="security-panel-heading">
              <span className="security-panel-number">02</span>
              <div><h4>Testing scope</h4><p>Select every performance testing type required for this request.</p></div>
            </div>
            <div className="chip-select security-performance-types">
              {PERFORMANCE_REQUEST_TYPES.map((type) => {
                const active = form.performance_request_types.includes(type)
                return (
                  <label key={type} className={`chip-toggle ${active ? 'active' : ''}`}>
                    <input type="checkbox" checked={active} onChange={() => toggleType(type)} />
                    <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
                    {type}
                  </label>
                )
              })}
            </div>
          </section>

          <ReadinessChecklistSection
            module="PERFORMANCE" kind="performance" sectionNumber="03"
            heading="L1 pre-testing readiness — self-declaration"
            description="Confirm what is already in place and attach supporting evidence beside the relevant criterion. QA will verify every declaration independently."
            noticeLabel="Before SM approval"
            noticeText="Every mandatory criterion must be selected and have supporting evidence attached before the request can be raised."
            selectedItems={form.performance_checked_items} onToggle={toggleChecked}
            draftRequestId={draftRequestId} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles}
            savedEvidenceFor={savedEvidenceFor} onEvidenceChanged={onEvidenceChanged}
            focusEvidenceItem={focusEvidenceItem}
          />
        </>
      )}
    </div>
  )
}
