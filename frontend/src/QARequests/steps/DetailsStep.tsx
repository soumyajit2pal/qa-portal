import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { Field } from "../../components/Common";
import SearchableSelect from "../../components/SearchableSelect";
import { CHANGE_TYPES, DEPLOYMENT_ENVIRONMENTS, validTargetPromotionOptions } from "../../constants";
import { ApplicationMasterOut } from "../../types";
import { QARequestForm, SetField } from "../types";
import { CR_OR_EPIC_NUMBER_REGEX } from "../validation";

// Sentinel dropdown value for "Other" -- never a real application name (all
// real names are always upper-cased, see backend routers/qa_requests.py::
// _resolve_application_name), so this can't collide with one.
const OTHER = "__OTHER__";

interface Props {
  form: QARequestForm;
  set: SetField;
  // 2026-08 "one user can be on multiple departments" CR, follow-up: the
  // requester's own department(s) only -- never the full org-wide list (that
  // stays enforced server-side too, see routers/qa_requests.py::
  // _resolve_requester_department).
  departmentOptions: string[];
  departmentLocked?: boolean;
}

interface BugFixSourceOption {
  request_id: string;
  functional_request_id: string;
  application_name: string;
  cr_number?: string | null;
  completed_at?: string | null;
}

// First wizard step -- the core "Application & Change Details" and
// "Release & Environment" fields, shared by every request type.
export function DetailsStep({ form, set, departmentOptions, departmentLocked = false }: Props) {
  // An already-Draft request's saved department might not be in the
  // requester's CURRENT department list any more (e.g. an Admin later
  // removed that department from their profile) -- keep it selectable
  // rather than silently dropping/blanking an already-valid saved value.
  const departmentSelectOptions = form.department && !departmentOptions.includes(form.department)
    ? [form.department, ...departmentOptions]
    : departmentOptions;
  const [crError, setCrError] = useState("");
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
  const [bugFixSources, setBugFixSources] = useState<BugFixSourceOption[]>([]);

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

  // A Bug Fix may optionally point back to the completed Functional Testing
  // request where the original implementation was verified. The endpoint
  // already narrows candidates to this application and department, so the
  // shared searchable picker stays compact even when the portal has a large
  // request history.
  useEffect(() => {
    if (form.change_type !== "Bug Fix" || !form.application_name || !form.department) {
      setBugFixSources([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        application_name: form.application_name,
        department: form.department,
      });
      api
        .get<BugFixSourceOption[]>(`/api/qa-requests/bug-fix-source-options?${params}`)
        .then((rows) => { if (!cancelled) setBugFixSources(rows); })
        .catch(() => { if (!cancelled) setBugFixSources([]); });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [form.change_type, form.application_name, form.department]);

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
                New names are automatically capitalized and remain “Pending Approval” until approved by 
                your department’s Application Owner and SM. Your request can proceed during approval.
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
          <Field label="Department *">
            <SearchableSelect
              value={form.department || ""}
              onChange={(v) => set("department", v)}
              options={departmentSelectOptions}
              placeholder="Select department..."
              disabled={departmentLocked}
            />
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              {departmentLocked
                ? "Department is fixed while this request is delegated for input."
                : departmentSelectOptions.length > 1
                ? "Defaults to your primary department -- pick any department you're assigned to."
                : "Fixed to your registered department. Contact an Administrator to add more."}
            </p>
          </Field>
          <Field label="CR Number/EPIC Number *">
            <input
              required
              maxLength={15}
              placeholder="e.g. CR-1234 or EPIC-123456"
              value={form.cr_number}
              onChange={(e) => {
                set("cr_number", e.target.value.toUpperCase());
                // Clear as soon as they start correcting it -- otherwise the
                // stale message just sits there under the field, unrelated
                // to whatever they're currently typing, until the next blur.
                if (crError) setCrError("");
              }}
              onBlur={(e) => {
                if (e.target.value && !CR_OR_EPIC_NUMBER_REGEX.test(e.target.value)) {
                  setCrError("Invalid format. Example: CR-1234 or EPIC-123456");
                } else {
                  setCrError("");
                }
              }}
            />
            {/* Plain inline text, not the shared ErrorText -- that component
                renders a full blocking dialog (Modal), which is right for a
                stopped save/submit action but was wrong here: tabbing through
                this field was invalid. */}
            {crError && (
              <p className="small" style={{ color: "var(--danger)", margin: "4px 0 0" }}>
                {crError}
              </p>
            )}
          </Field>

          <Field label="Change Type *">
            <select
              value={form.change_type}
              onChange={(e) => {
                const value = e.target.value;
                set("change_type", value);
                if (value !== "Bug Fix") set("bug_fix_source_request_id", "");
              }}
            >
              {CHANGE_TYPES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          {form.change_type === "Bug Fix" && (
            <Field label="Previous Completed Request ID (optional)">
              <SearchableSelect
                value={form.bug_fix_source_request_id}
                onChange={(value) => set("bug_fix_source_request_id", value)}
                placeholder="Select the original completed request..."
                options={[
                  { value: "", label: "No previous request" },
                  ...bugFixSources.map((source) => ({
                    value: source.request_id,
                    label: `${source.request_id} · ${source.functional_request_id}${source.cr_number ? ` · ${source.cr_number}` : ""}`,
                  })),
                ]}
              />
              <p className="muted small" style={{ margin: "4px 0 0" }}>
                Use this to trace the bug fix back to the earlier request whose Functional Testing was completed.
              </p>
            </Field>
          )}
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
