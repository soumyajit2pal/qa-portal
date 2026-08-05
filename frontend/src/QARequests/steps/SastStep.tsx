import React from "react";
import { Field } from "../../components/Common";
import { PRIORITIES, RISK_RATINGS } from "../../constants";
import { DraftChecklistEvidenceOut } from "../../types";
import { blankSastComponent, QARequestForm, SetField, SAST_COMPONENT_FIELDS } from "../types";
import { EvidenceKind } from "./ChecklistEvidencePicker";
import { ReadinessChecklistSection } from "./ReadinessChecklistSection";

interface Props {
  form: QARequestForm;
  set: SetField;
  // Once the linked SAST request already exists (created on an earlier
  // save), further edits happen on that request's own page instead.
  existingSast: boolean;
  draftRequestId?: number;
  evidenceFiles: (kind: EvidenceKind, itemIndex: number) => File[];
  setEvidenceFiles: (kind: EvidenceKind, itemIndex: number, files: File[]) => void;
  savedEvidenceFor: (kind: EvidenceKind, itemIndex: number) => DraftChecklistEvidenceOut[];
  onEvidenceChanged: () => void;
}

// Shown only while "SAST" is a selected request type -- fills in the
// auto-created SAST request's repository details and its own Security
// Readiness checklist self-declaration, up front.
export function SastStep({ form, set, existingSast, draftRequestId, evidenceFiles, setEvidenceFiles, savedEvidenceFor, onEvidenceChanged }: Props) {
  function toggleChecked(item: string) {
    set(
      "sast_checked_items",
      form.sast_checked_items.includes(item)
        ? form.sast_checked_items.filter((x) => x !== item)
        : [...form.sast_checked_items, item]
    );
  }

  function setComponent(index: number, key: string, value: string) {
    set("sast_components", form.sast_components.map((row, rowIndex) => (
      rowIndex === index ? { ...row, [key]: value } : row
    )));
  }

  function addComponent() {
    set("sast_components", [...form.sast_components, blankSastComponent()]);
  }

  function removeComponent(index: number) {
    if (form.sast_components.length <= 1) return;
    set("sast_components", form.sast_components.filter((_, rowIndex) => rowIndex !== index));
  }

  return (
    <div className="security-request-step security-request-step-sast">
      <div className="security-step-intro">
        <span>SAST request configuration</span>
        <h3>Static application security testing details</h3>
        <p>Define classification, source repositories, build traceability, and readiness evidence before raising the request.</p>
      </div>
      {existingSast ? (
        <div className="security-existing-request">
          <strong>SAST request already raised</strong>
          <span>Edit its configuration from SAST Requests. This intake step is now read-only.</span>
        </div>
      ) : (
        <>
          <section className="security-request-panel">
            <div className="security-panel-heading">
              <span className="security-panel-number">01</span>
              <div><h4>Classification</h4><p>Set the operational urgency and security risk independently for this SAST request.</p></div>
            </div>
            <div className="security-classification-grid">
              <Field label="Priority *">
                <select value={form.sast_priority} onChange={(e) => set("sast_priority", e.target.value)}>
                  {PRIORITIES.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              <Field label="Risk Category *">
                <select value={form.sast_risk_category} onChange={(e) => set("sast_risk_category", e.target.value)}>
                  {RISK_RATINGS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
            </div>
          </section>

          <section className="security-request-panel">
            <div className="security-panel-heading security-panel-heading-with-action">
              <span className="security-panel-number">02</span>
              <div><h4>Repository and build details</h4><p>Add one complete, traceable record for every repository included in the scan.</p></div>
              <button type="button" className="btn security-add-button" onClick={addComponent}>+ Add repository</button>
            </div>
            <div className="security-target-list">
              {form.sast_components.map((component, index) => (
                <div className="security-target-card" key={index}>
                  <div className="security-target-card-head">
                    <span>Repository {String(index + 1).padStart(2, '0')}</span>
                    {form.sast_components.length > 1 && (
                      <button type="button" className="security-remove-button" aria-label={`Remove repository ${index + 1}`} onClick={() => removeComponent(index)}>Remove</button>
                    )}
                  </div>
                  <div className="security-repository-grid">
                    {SAST_COMPONENT_FIELDS.map((field) => (
                      <label className={`security-control security-control-${field.key.split('_').join('-')}`} key={field.key}>
                        <span>{field.label} *</span>
                        <input
                          required
                          value={component[field.key] || ''}
                          placeholder={field.key === 'repository_url' ? 'https://source-control/project/repository' : field.label}
                          onChange={(event) => setComponent(index, field.key, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="security-hash-field">
              <Field label="SHA256 / MD5 Hash">
                <input
                  value={form.sast_hash_value}
                  onChange={(e) => set("sast_hash_value", e.target.value)}
                  placeholder="Optional build or artifact hash"
                />
              </Field>
              <p>Optional, but recommended when a packaged build or artifact is supplied for scanning.</p>
            </div>
          </section>

          <ReadinessChecklistSection
            module="SAST" kind="sast" sectionNumber="03"
            heading="Security readiness self-declaration"
            description="Confirm what is already in place and attach supporting evidence beside the relevant criterion. The Security Analyst will verify every declaration independently."
            noticeLabel="Before SM approval"
            noticeText="Every mandatory criterion must be selected. Evidence is recommended for mandatory and selected items."
            selectedItems={form.sast_checked_items} onToggle={toggleChecked}
            draftRequestId={draftRequestId} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles}
            savedEvidenceFor={savedEvidenceFor} onEvidenceChanged={onEvidenceChanged}
          />
        </>
      )}
    </div>
  );
}
