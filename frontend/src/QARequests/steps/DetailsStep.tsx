import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { Field } from "../../components/Common";
import SearchableSelect from "../../components/SearchableSelect";
import { CHANGE_TYPES, DEPLOYMENT_ENVIRONMENTS, validTargetPromotionOptions } from "../../constants";
import { ApplicationMasterOut } from "../../types";
import { QARequestForm, SetField } from "../types";
import { CR_NUMBER_REGEX, EPIC_NUMBER_REGEX } from "../validation";

// Sentinel dropdown value for "Other" -- never a real application name (all
// real names are always upper-cased, see backend routers/qa_requests.py::
// _resolve_application_name), so this can't collide with one.
const OTHER = "__OTHER__";

interface Props {
  form: QARequestForm;
  set: SetField;
}

// First wizard step -- the core "Application & Change Details" and
// "Release & Environment" fields, shared by every request type.
export function DetailsStep({ form, set }: Props) {
  const [crError, setCrError] = useState("");
  const [epicError, setEpicError] = useState("");
  // Approved names only -- a brand-new name typed via "Other" doesn't show up
  // here until an Application Owner, then an SM, both from the requester's
  // department, approve it in turn (see backend
  // routers/applications.py::list_application_names and the "New
  // Application Name Pending ... Approval" banner on each linked module's
  // own detail view). Always includes "Other" itself as a standing option
  // regardless of what's been approved so far.
  const [approvedNames, setApprovedNames] = useState<ApplicationMasterOut[]>(
    []
  );
  const [showOther, setShowOther] = useState(false);

  useEffect(() => {
    api
      .get<ApplicationMasterOut[]>("/api/application-names")
      .then(setApprovedNames)
      .catch(() => {});
  }, []);

  // Once the approved list has loaded, figure out whether the current value
  // (e.g. re-opening a Draft that already has a still-pending "Other" name,
  // or a name an SM has since rejected) is one of the approved options or
  // needs the "Other" textbox shown instead -- covers both "brand new,
  // nothing typed yet" and "editing an existing Draft" the same way.
  useEffect(() => {
    if (!form.application_name) return;
    const isApproved = approvedNames.some(
      (a) => a.name === form.application_name
    );
    if (!isApproved) setShowOther(true);
  }, [approvedNames, form.application_name]);

  return (
    <>
      <div className="form-section">
        <div className="form-section-title">
          Application &amp; Change Details
        </div>
        <div className="form-row">
          <Field label="Application Name *">
            {/* Searchable -- this list only grows over time as new
                applications get approved, so a plain <select> becomes hard
                to scan (the original motivating case for this component). */}
            <SearchableSelect
              value={showOther ? OTHER : form.application_name}
              placeholder="Select Application Name"
              onChange={(v) => {
                if (v === OTHER) {
                  setShowOther(true);
                  set("application_name", "");
                } else {
                  setShowOther(false);
                  set("application_name", v);
                }
              }}
              options={[
                ...approvedNames.map((a) => ({ value: a.name, label: a.name })),
                { value: OTHER, label: "Other (new application)" },
              ]}
            />
            {showOther && (
              <>
                <input
                  required
                  placeholder="Type the new application name"
                  value={form.application_name}
                  onChange={(e) =>
                    set("application_name", e.target.value.toUpperCase())
                  }
                  style={{ marginTop: 6 }}
                />
                <p className="muted small" style={{ margin: "4px 0 0" }}>
                  Automatically capitalised. A new name needs approval from an
                  Application Owner, then an SM, both in your department,
                  before it appears in this dropdown for everyone else --
                  your request isn't blocked on that, it just shows as
                  "Pending Approval" until then.
                </p>
              </>
            )}
          </Field>
          <Field label="Application Owner *">
            <input
              required
              value={form.application_owner}
              onChange={(e) =>
                set("application_owner", e.target.value.toUpperCase())
              }
            />
          </Field>
          <Field label="Department">
            <input
              value={form.department || "Not set on your profile"}
              disabled
            />
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Fixed to your registered department. Contact an Administrator to
              change it.
            </p>
          </Field>
          <Field label="Change Request ID(s) *">
            <input
              required
              maxLength={8}
              value={form.cr_number}
              onChange={(e) => {
                set("cr_number", e.target.value.toUpperCase());
                // Clear as soon as they start correcting it -- otherwise the
                // stale message just sits there under the field, unrelated
                // to whatever they're currently typing, until the next blur.
                if (crError) setCrError("");
              }}
              onBlur={(e) => {
                if (e.target.value && !CR_NUMBER_REGEX.test(e.target.value)) {
                  setCrError("Invalid format. Example: CR-1234");
                } else {
                  setCrError("");
                }
              }}
            />
            {/* Plain inline text, not the shared ErrorText -- that component
                renders a full blocking dialog (Modal), which is right for a
                stopped save/submit action but was wrong here: tabbing through
                both this field and Epic Number while either was invalid
                popped up that dialog per field, so two near-identical
                "invalid format" popups could appear stacked on screen at
                once, reading as the same error "showing multiple times". */}
            {crError && (
              <p className="small" style={{ color: "var(--danger)", margin: "4px 0 0" }}>
                {crError}
              </p>
            )}
          </Field>

          <Field label="Epic Number *">
            <input
              required
              maxLength={10}
              value={form.epic_number}
              onChange={(e) => {
                set("epic_number", e.target.value.toUpperCase());
                if (epicError) setEpicError("");
              }}
              onBlur={(e) => {
                if (e.target.value && !EPIC_NUMBER_REGEX.test(e.target.value)) {
                  setEpicError("Invalid format. Example: EPIC-1234");
                } else {
                  setEpicError("");
                }
              }}
            />
            {epicError && (
              <p className="small" style={{ color: "var(--danger)", margin: "4px 0 0" }}>
                {epicError}
              </p>
            )}
          </Field>

          <Field label="Change Type *">
            <select
              value={form.change_type}
              onChange={(e) => set("change_type", e.target.value)}
            >
              {CHANGE_TYPES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Vendor / SI Partner">
            <input
              value={form.vendor_si_partner}
              maxLength={15}
              placeholder="Enter Vendor / SI Partner"
              onChange={(e) =>
                set("vendor_si_partner", e.target.value.toUpperCase())
              }
            />
          </Field>
          <Field label="Technology Stack *">
            <input
              required
              maxLength={30}
              placeholder="Enter Technology Stack"
              value={form.technology_stack}
              onChange={(e) =>
                set("technology_stack", e.target.value.toUpperCase())
              }
            />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Release &amp; Environment</div>
        <div className="form-row">
          <Field label="Release Version">
            <input
              value={form.release_version}
              maxLength={10}
              placeholder="Enter release version"
              onChange={(e) => set("release_version", e.target.value)}
            />
          </Field>
          <Field label="Build Number">
            <input
              value={form.build_number}
              maxLength={10}
              placeholder="Enter Build Number"
              onChange={(e) => set("build_number", e.target.value)}
            />
          </Field>
          <Field label="Deployment Environment *">
            <select
              value={form.environment}
              onChange={(e) => {
                const nextEnv = e.target.value;
                set("environment", nextEnv);
                // Target Promotion Environment must always stay strictly
                // later than Deployment Environment in the SIT -> UAT ->
                // Pre-Production -> Production pipeline -- if the
                // already-picked target is no longer valid against the
                // newly-picked deployment environment (e.g. Deployment
                // flipped from SIT to Production while Target was still
                // UAT), snap it forward to the nearest valid stage instead
                // of silently leaving an invalid combination selected. Keeps
                // this dropdown's own "always a real, non-blank value"
                // invariant intact (see validation.ts's detailsStepError
                // comment) rather than falling back to an empty selection.
                const validTargets = validTargetPromotionOptions(nextEnv);
                if (!validTargets.includes(form.target_promotion_environment)) {
                  set("target_promotion_environment", validTargets[0] || "");
                }
              }}
            >
              {DEPLOYMENT_ENVIRONMENTS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          {/* Reported directly: this dropdown could be left on its blank
              placeholder and Next/Submit still went through -- fixed in
              validation.ts's detailsStepError, which now actually blocks
              that. targetOptions/hasTargetOptions below still guard the
              "Production has nowhere later to promote to" edge case
              (validTargetPromotionOptions('Production') === []), even
              though Deployment Environment's own dropdown above no longer
              offers "Production" at all (see DEPLOYMENT_ENVIRONMENTS'
              own comment) -- this stays purely as a safety net for any
              pre-existing Draft saved with environment='Production' before
              that change, so reopening one doesn't show a required field
              with genuinely nothing to select. */}
          {(() => {
            const targetOptions = validTargetPromotionOptions(form.environment);
            const hasTargetOptions = targetOptions.length > 0;
            return (
              <Field
                label={`Target Promotion Environment${hasTargetOptions ? " *" : ""}`}
              >
                <select
                  value={form.target_promotion_environment}
                  disabled={!hasTargetOptions}
                  onChange={(e) =>
                    set("target_promotion_environment", e.target.value)
                  }
                >
                  <option value="">
                    {hasTargetOptions
                      ? "Select Target Promotion Environment"
                      : "Not applicable -- Production is the final stage"}
                  </option>
                  {targetOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </Field>
            );
          })()}
          <Field label="Target Release Date">
            <input
              type="date"
              min={new Date().toISOString().split("T")[0]}
              value={form.target_release_date}
              onChange={(e) => set("target_release_date", e.target.value)}
            />
          </Field>
        </div>
      </div>
    </>
  );
}
