import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { Field } from "../../components/Common";
import { CHANGE_TYPES, ENVIRONMENTS } from "../../constants";
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
  // here until an SM from the requester's department approves it (see
  // backend routers/applications.py::list_application_names and the new
  // "New Application Name Pending Approval" banner on each linked module's
  // own SM Approval screen). Always includes "Other" itself as a standing
  // option regardless of what's been approved so far.
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
            <select
              required={!showOther}
              value={showOther ? OTHER : form.application_name}
              onChange={(e) => {
                if (e.target.value === OTHER) {
                  setShowOther(true);
                  set("application_name", "");
                } else {
                  setShowOther(false);
                  set("application_name", e.target.value);
                }
              }}
            >
              <option value="">Select Application Name</option>
              {approvedNames.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
              <option value={OTHER}>Other (new application)</option>
            </select>
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
                  SM in your department before it appears in this dropdown for
                  everyone else -- your request isn't blocked on that, it just
                  shows as "Pending Approval" until then.
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
              onChange={(e) => set("cr_number", e.target.value.toUpperCase())}
              onBlur={(e) => {
                if (!CR_NUMBER_REGEX.test(e.target.value)) {
                  setCrError("Invalid format. Example: CR-1234");
                } else {
                  setCrError("");
                }
              }}
            />
            {crError && <span className="text-sm">{crError}</span>}
          </Field>

          <Field label="Epic Number *">
            <input
              required
              maxLength={10}
              value={form.epic_number}
              onChange={(epic_number) =>
                set("epic_number", epic_number.target.value.toUpperCase())
              }
              onBlur={(epic_number) => {
                if (!EPIC_NUMBER_REGEX.test(epic_number.target.value)) {
                  setEpicError("Invalid format. Example: EPIC-1234");
                } else {
                  setEpicError("");
                }
              }}
            />
            {epicError && <span className="text-sm">{epicError}</span>}
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
              onChange={(e) => set("environment", e.target.value)}
            >
              {ENVIRONMENTS.filter((e_) => e_ !== "Dev").map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Target Promotion Environment *">
            <select
              value={form.target_promotion_environment}
              onChange={(e) =>
                set("target_promotion_environment", e.target.value)
              }
            >
              {ENVIRONMENTS.filter((e_) => e_ !== "Dev" && e_ !== "SIT").map(
                (o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                )
              )}
            </select>
          </Field>
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
