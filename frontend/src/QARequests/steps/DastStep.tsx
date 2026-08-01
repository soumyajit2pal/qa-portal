import React from 'react'
import { Field, RepeatableRows } from '../../components/Common'
import { PRIORITIES, RISK_RATINGS, ENVIRONMENTS, DEFAULT_DAST_CHECKLIST_ITEMS } from '../../constants'
import { QARequestForm, SetField, blankDastComponent } from '../types'
import { ChecklistEvidencePicker, EvidenceKind } from './ChecklistEvidencePicker'

interface Props {
  form: QARequestForm
  set: SetField
  // Once the linked DAST request already exists (created on an earlier
  // save), further edits happen on that request's own page instead.
  existingDast: boolean
  draftRequestId?: number
  evidenceFiles: (kind: EvidenceKind, itemIndex: number) => File[]
  setEvidenceFiles: (kind: EvidenceKind, itemIndex: number, files: File[]) => void
}

// Shown only while "DAST" is a selected request type -- fills in the
// auto-created DAST request's target details and its own Security
// Readiness checklist self-declaration, up front.
export function DastStep({ form, set, existingDast, draftRequestId, evidenceFiles, setEvidenceFiles }: Props) {
  function toggleChecked(item: string) {
    set(
      'dast_checked_items',
      form.dast_checked_items.includes(item)
        ? form.dast_checked_items.filter((x) => x !== item)
        : [...form.dast_checked_items, item],
    )
  }

  return (
    <div className="form-section">
      <div className="form-section-title">DAST Details *</div>
      {existingDast ? (
        <p className="muted small" style={{ marginTop: -4 }}>
          The linked DAST request has already been raised — edit these details on its own page
          (DAST Requests) instead of here.
        </p>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            Fills in the auto-created DAST request's details up front, instead of leaving them as
            placeholders to fill in later.
          </p>
          <p className="muted small" style={{ marginTop: -4, marginBottom: 10 }}>
            Target Release Date is already set on the "Application &amp; Change Details" step
            ({form.target_release_date || 'not set'}) — no separate one here.
          </p>
          <div className="form-row">
            <Field label="Priority *">
              <select value={form.dast_priority} onChange={(e) => set('dast_priority', e.target.value)}>
                {PRIORITIES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Risk Category *">
              <select value={form.dast_risk_category} onChange={(e) => set('dast_risk_category', e.target.value)}>
                {RISK_RATINGS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          </div>
          <Field label="DAST Targets">
            <RepeatableRows
              rows={form.dast_components}
              blankRow={blankDastComponent}
              onChange={(v) => set('dast_components', v)}
              renderRow={(row, setField) => (
                <>
                  <input
                    placeholder="Application URL"
                    value={row.application_url}
                    onChange={(e) => setField('application_url', e.target.value)}
                    style={{ flex: 2, minWidth: 180 }}
                  />
                  <select
                    value={row.environment}
                    onChange={(e) => setField('environment', e.target.value)}
                    style={{ flex: 1, minWidth: 130 }}
                  >
                    <option value="">Select Environment (defaults to Deployment Environment)</option>
                    {ENVIRONMENTS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
                    <input
                      type="checkbox"
                      checked={row.authentication_required}
                      onChange={(e) => setField('authentication_required', e.target.checked)}
                    />
                    <span className="small">Auth required</span>
                  </label>
                  {row.authentication_required && (
                    <input
                      required
                      placeholder="Test Credentials *"
                      value={row.test_credentials}
                      onChange={(e) => setField('test_credentials', e.target.value)}
                      style={{ flex: 2, minWidth: 160 }}
                    />
                  )}
                </>
              )}
            />
          </Field>
          <p className="muted small" style={{ marginTop: 6 }}>
            Click "+" to add another target URL if this project spans more than one.
          </p>
          <div className="form-section-title" style={{ marginTop: 16 }}>
            Security Readiness Checklist — Self-Declaration
          </div>
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            Tick what's already in place. This is your own declaration for reference only — the
            Security Analyst will independently verify every item during Security Readiness (on the
            linked DAST request, once raised). Items marked "mandatory" must be ticked before the
            DAST request can be submitted for SM Approval.
          </p>
          {DEFAULT_DAST_CHECKLIST_ITEMS.map((ci, itemIndex) => {
            const checked = form.dast_checked_items.includes(ci.item)
            return (
              <div key={ci.item} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleChecked(ci.item)} />
                  <span>
                    {ci.item} <span className="muted small">({ci.owner})</span>{' '}
                    {ci.is_mandatory && <span className="badge badge-red">Mandatory</span>}
                  </span>
                </label>
                <ChecklistEvidencePicker kind="dast" itemIndex={itemIndex} draftRequestId={draftRequestId}
                  files={evidenceFiles('dast', itemIndex)} onFilesChange={(files) => setEvidenceFiles('dast', itemIndex, files)} />
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
