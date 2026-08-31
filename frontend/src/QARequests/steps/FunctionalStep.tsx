import React from "react";
import { Field } from "../../components/Common";
import { PRIORITIES, RISK_RATINGS } from "../../constants";
import { DraftChecklistEvidenceOut } from "../../types";
import { QARequestForm, SetField } from "../types";
import { EvidenceKind } from "./ChecklistEvidencePicker";
import { ReadinessChecklistSection } from "./ReadinessChecklistSection";

interface Props {
  form: QARequestForm;
  set: SetField;
  draftRequestId?: number;
  evidenceFiles: (kind: EvidenceKind, itemIndex: number) => File[];
  setEvidenceFiles: (kind: EvidenceKind, itemIndex: number, files: File[]) => void;
  // Already-uploaded evidence for one item -- see NewRequestModal.tsx's
  // loadSavedEvidence (one batched fetch for the whole Draft instead of
  // each ChecklistEvidencePicker instance fetching its own).
  savedEvidenceFor: (kind: EvidenceKind, itemIndex: number) => DraftChecklistEvidenceOut[];
  onEvidenceChanged: () => void;
  focusEvidenceItem?: string;
}

// Shown only while a Functional-bucket type (Functional/Sanity/Regression
// Testing/UAT Support) is selected -- collects the combined Functional QA
// request's own Priority + Risk Rating, independent of any other request
// type raised alongside it, plus its own "Ready for Testing" readiness
// checklist self-declaration -- folded into this same step (not a separate
// one) to match how SAST/DAST already self-declare their own Security
// Readiness checklist within their own step (see SastStep.tsx/DastStep.tsx).
export function FunctionalStep({ form, set, draftRequestId, evidenceFiles, setEvidenceFiles, savedEvidenceFor, onEvidenceChanged, focusEvidenceItem }: Props) {
  function toggleChecked(item: string) {
    set(
      "checked_items",
      form.checked_items.includes(item)
        ? form.checked_items.filter((x) => x !== item)
        : [...form.checked_items, item]
    );
  }

  return (
    <div className="security-request-step security-request-step-functional">
      <div className="security-step-intro">
        <span>Functional request configuration</span>
        <h3>Functional QA testing details</h3>
        <p>Set request classification, confirm readiness, and attach evidence before raising the request.</p>
      </div>

      <section className="security-request-panel">
        <div className="security-panel-heading">
          <span className="security-panel-number">01</span>
          <div>
            <h4>Classification</h4>
            <p>Set the operational priority and risk rating for the combined Functional QA request.</p>
          </div>
        </div>
        <div className="security-classification-grid">
          <Field label="Priority *">
            <select value={form.functional_priority} onChange={(e) => set("functional_priority", e.target.value)}>
              {PRIORITIES.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
          <Field label="Risk Rating *">
            <select value={form.functional_risk_rating} onChange={(e) => set("functional_risk_rating", e.target.value)}>
              {RISK_RATINGS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <ReadinessChecklistSection
        module="FUNCTIONAL" kind="functional" sectionNumber="02"
        heading="Readiness checklist — self-declaration"
        description="Confirm what is already in place and attach supporting evidence beside the relevant criterion. The QA Lead will verify every declaration independently."
        noticeLabel="Before SM approval"
        noticeText="Every mandatory criterion must be selected and have supporting evidence attached before the request can be raised."
        selectedItems={form.checked_items} onToggle={toggleChecked}
        draftRequestId={draftRequestId} evidenceFiles={evidenceFiles} setEvidenceFiles={setEvidenceFiles}
        savedEvidenceFor={savedEvidenceFor} onEvidenceChanged={onEvidenceChanged}
        focusEvidenceItem={focusEvidenceItem}
      />
    </div>
  );
}
