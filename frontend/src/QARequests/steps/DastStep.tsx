import React from 'react'
import { Field } from '../../components/Common'
import { PRIORITIES, RISK_RATINGS, POST_SIT_ENVIRONMENTS } from '../../constants'
import { DraftChecklistEvidenceOut } from '../../types'
import { QARequestForm, SetField, blankDastComponent } from '../types'
import { EvidenceKind } from './ChecklistEvidencePicker'
import { ReadinessChecklistSection } from './ReadinessChecklistSection'

interface Props {
  form: QARequestForm
  set: SetField
  // Once the linked DAST request already exists (created on an earlier
  // save), further edits happen on that request's own page instead.
  existingDast: boolean
  draftRequestId?: number
  evidenceFiles: (kind: EvidenceKind, itemIndex: number) => File[]
  setEvidenceFiles: (kind: EvidenceKind, itemIndex: number, files: File[]) => void
  savedEvidenceFor: (kind: EvidenceKind, itemIndex: number) => DraftChecklistEvidenceOut[]
  onEvidenceChanged: () => void
}

// Shown only while "DAST" is a selected request type -- fills in the
// auto-created DAST request's target details and its own Security
// Readiness checklist self-declaration, up front.
export function DastStep({ form, set, existingDast, draftRequestId, evidenceFiles, setEvidenceFiles, savedEvidenceFor, onEvidenceChanged }: Props) {
  function toggleChecked(item: string) {
    set(
      'dast_checked_items',
      form.dast_checked_items.includes(item)
        ? form.dast_checked_items.filter((x) => x !== item)
        : [...form.dast_checked_items, item],
    )
  }

  function setTarget<K extends keyof (typeof form.dast_components)[number]>(
    index: number,
    key: K,
    value: (typeof form.dast_components)[number][K],
  ) {
    set('dast_components', form.dast_components.map((row, rowIndex) => (
      rowIndex === index ? { ...row, [key]: value } : row
    )))
  }

  function addTarget() {
    set('dast_components', [...form.dast_components, blankDastComponent()])
  }

  function removeTarget(index: number) {
    if (form.dast_components.length <= 1) return
    set('dast_components', form.dast_components.filter((_, rowIndex) => rowIndex !== index))
  }

  return (
    <div className="security-request-step security-request-step-dast">
      <div className="security-step-intro">
        <span>DAST request configuration</span>
        <h3>Dynamic application security testing details</h3>
        <p>Define classification, reachable scan targets, authentication requirements, and readiness evidence.</p>
      </div>
      {existingDast ? (
        <div className="security-existing-request">
          <strong>DAST request already raised</strong>
          <span>Edit its configuration from DAST Requests. This intake step is now read-only.</span>
        </div>
      ) : (
        <>
          <section className="security-request-panel">
            <div className="security-panel-heading">
              <span className="security-panel-number">01</span>
              <div><h4>Classification</h4><p>Set the operational urgency and security risk independently for this DAST request.</p></div>
            </div>
            <div className="security-classification-grid">
              <Field label="Priority *">
                <select value={form.dast_priority} onChange={(e) => set('dast_priority', e.target.value)}>
                  {PRIORITIES.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              <Field label="Risk Category *">
                <select value={form.dast_risk_category} onChange={(e) => set('dast_risk_category', e.target.value)}>
                  {RISK_RATINGS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
            </div>
            <div className="security-context-note">
              <span>Target release date</span>
              <strong>{form.target_release_date || 'Not provided'}</strong>
              <small>Managed on the Application &amp; Change Details step.</small>
            </div>
          </section>

          <section className="security-request-panel">
            <div className="security-panel-heading security-panel-heading-with-action">
              <span className="security-panel-number">02</span>
              <div><h4>Application scan targets</h4><p>Add every reachable URL as its own target with environment and authentication details.</p></div>
              <button type="button" className="btn security-add-button" onClick={addTarget}>+ Add target</button>
            </div>
            <div className="security-target-list">
              {form.dast_components.map((target, index) => {
                const authId = `dast-target-auth-${index}`
                return (
                  <div className="security-target-card" key={index}>
                    <div className="security-target-card-head">
                      <span>Target {String(index + 1).padStart(2, '0')}</span>
                      {form.dast_components.length > 1 && (
                        <button type="button" className="security-remove-button" aria-label={`Remove target ${index + 1}`} onClick={() => removeTarget(index)}>Remove</button>
                      )}
                    </div>
                    <div className="security-dast-target-grid">
                      <label className="security-control security-control-application-url">
                        <span>Application URL *</span>
                        <input
                          required type="url" value={target.application_url}
                          placeholder="https://application.example.com"
                          onChange={(event) => setTarget(index, 'application_url', event.target.value)}
                        />
                      </label>
                      <label className="security-control security-control-environment">
                        <span>Environment *</span>
                        <select value={target.environment} onChange={(event) => setTarget(index, 'environment', event.target.value)}>
                          {POST_SIT_ENVIRONMENTS.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                      <div className="security-auth-control">
                        <span>Authentication</span>
                        <label htmlFor={authId}>
                          <input
                            id={authId} type="checkbox" checked={target.authentication_required}
                            onChange={(event) => setTarget(index, 'authentication_required', event.target.checked)}
                          />
                          <span><strong>{target.authentication_required ? 'Required' : 'Not required'}</strong><small>Does this target require sign-in?</small></span>
                        </label>
                      </div>
                      {target.authentication_required && (
                        <label className="security-control security-control-credentials">
                          <span>Test Credentials *</span>
                          <input
                            required value={target.test_credentials}
                            placeholder="Provide a dedicated non-production test account"
                            onChange={(event) => setTarget(index, 'test_credentials', event.target.value)}
                          />
                          <small>Use credentials approved for security testing. Do not enter personal production credentials.</small>
                        </label>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <ReadinessChecklistSection
            module="DAST" kind="dast" sectionNumber="03"
            heading="Security readiness self-declaration"
            description="Confirm what is already in place and attach supporting evidence beside the relevant criterion. The Security Analyst will verify every declaration independently."
            noticeLabel="Before SM approval"
            noticeText="Every mandatory criterion must be selected. Evidence is recommended for mandatory and selected items."
            selectedItems={form.dast_checked_items} onToggle={toggleChecked}
            draftRequestId={draftRequestId} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles}
            savedEvidenceFor={savedEvidenceFor} onEvidenceChanged={onEvidenceChanged}
          />
        </>
      )}
    </div>
  )
}
