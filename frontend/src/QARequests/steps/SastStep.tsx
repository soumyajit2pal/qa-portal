import React from "react";
import { Field } from "../../components/Common";
import SastRepositoryDetails from "../../components/SastRepositoryDetails";
import { PRIORITIES, RISK_RATINGS } from "../../constants";
import { DraftChecklistEvidenceOut } from "../../types";
import { QARequestForm, SetField } from "../types";
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
  focusEvidenceItem?: string;
}

// Shown only while "SAST" is a selected request type -- fills in the
// auto-created SAST request's repository details and its own Security
// Readiness checklist self-declaration, up front.
export function SastStep({ form, set, existingSast, draftRequestId, evidenceFiles, setEvidenceFiles, savedEvidenceFor, onEvidenceChanged, focusEvidenceItem }: Props) {
  function toggleChecked(item: string) {
    set(
      "sast_checked_items",
      form.sast_checked_items.includes(item)
        ? form.sast_checked_items.filter((x) => x !== item)
        : [...form.sast_checked_items, item]
    );
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

          <SastRepositoryDetails
            rows={form.sast_components}
            onChange={(rows) => set("sast_components", rows)}
            hashValue={form.sast_hash_value}
            onHashChange={(value) => set("sast_hash_value", value)}
          />

          <ReadinessChecklistSection
            department={form.department}
            module="SAST" kind="sast" sectionNumber="03"
            heading="Security readiness self-declaration"
            description="Confirm what is already in place and attach supporting evidence beside the relevant criterion. The Security Analyst will verify every declaration independently."
            noticeLabel="Before SM approval"
            noticeText="Every mandatory criterion must be selected and have supporting evidence attached before the request can be raised."
            selectedItems={form.sast_checked_items} onToggle={toggleChecked}
            draftRequestId={draftRequestId} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles}
            savedEvidenceFor={savedEvidenceFor} onEvidenceChanged={onEvidenceChanged}
            focusEvidenceItem={focusEvidenceItem}
          />
        </>
      )}
    </div>
  );
}
