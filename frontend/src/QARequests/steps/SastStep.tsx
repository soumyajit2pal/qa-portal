import React from "react";
import { Field, RepeatableGroupInput } from "../../components/Common";
import {
  PRIORITIES,
  RISK_RATINGS,
  DEFAULT_SAST_CHECKLIST_ITEMS,
} from "../../constants";
import { QARequestForm, SetField, SAST_COMPONENT_FIELDS } from "../types";

interface Props {
  form: QARequestForm;
  set: SetField;
  // Once the linked SAST request already exists (created on an earlier
  // save), further edits happen on that request's own page instead.
  existingSast: boolean;
}

// Shown only while "SAST" is a selected request type -- fills in the
// auto-created SAST request's repository details and its own Security
// Readiness checklist self-declaration, up front.
export function SastStep({ form, set, existingSast }: Props) {
  function toggleChecked(item: string) {
    set(
      "sast_checked_items",
      form.sast_checked_items.includes(item)
        ? form.sast_checked_items.filter((x) => x !== item)
        : [...form.sast_checked_items, item]
    );
  }

  return (
    <div className="form-section">
      <div className="form-section-title">SAST Details *</div>
      {existingSast ? (
        <p className="muted small" style={{ marginTop: -4 }}>
          The linked SAST request has already been raised — edit these details
          on its own page (SAST Requests) instead of here.
        </p>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            Fills in the auto-created SAST request's details up front, instead
            of leaving them as placeholders to fill in later.
          </p>
          <div className="form-row">
            <Field label="Priority *">
              <select
                value={form.sast_priority}
                onChange={(e) => set("sast_priority", e.target.value)}
              >
                {PRIORITIES.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Risk Category *">
              <select
                value={form.sast_risk_category}
                onChange={(e) => set("sast_risk_category", e.target.value)}
              >
                {RISK_RATINGS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Repository Details *">
            <RepeatableGroupInput
              required
              fields={SAST_COMPONENT_FIELDS}
              rows={form.sast_components}
              onChange={(v) => set("sast_components", v)}
            />
          </Field>
          <p className="muted small" style={{ marginTop: 6 }}>
            Click "+" to add another repository (its own branch, commit ID, tech
            stack and build number) if this project spans more than one.
          </p>
          <Field label="SHA256/MD5 Hash">
            <input
              value={form.sast_hash_value}
              onChange={(e) => set("sast_hash_value", e.target.value)}
              placeholder="Optional -- hash of the build/artifact, if available"
            />
          </Field>
          <div className="form-section-title" style={{ marginTop: 16 }}>
            Security Readiness Checklist — Self-Declaration
          </div>
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            Tick what's already in place. This is your own declaration for
            reference only — the Security Analyst will independently verify
            every item during Security Readiness (on the linked SAST request,
            once raised). Items marked "mandatory" must be ticked before the
            SAST request can be submitted for SM Approval.
          </p>
          {DEFAULT_SAST_CHECKLIST_ITEMS.map((ci) => {
            const checked = form.sast_checked_items.includes(ci.item);
            return (
              <label
                key={ci.item}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "5px 0",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleChecked(ci.item)}
                />
                <span>
                  {ci.item} <span className="muted small">({ci.owner})</span>{" "}
                  {ci.is_mandatory && (
                    <span className="badge badge-red">Mandatory</span>
                  )}
                </span>
              </label>
            );
          })}
        </>
      )}
    </div>
  );
}
