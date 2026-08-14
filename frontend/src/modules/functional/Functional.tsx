import React, { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import {
  Card,
  Table,
  Badge,
  Modal,
  Field,
  ErrorText,
  PageHeader,
  ApprovalDecisionButtons,
  DetailSection,
  DetailField,
  RequestDocuments,
  ChecklistEvidence,
  useChecklistDocuments,
  applicationNameAwareStatusLabel,
} from "../../components/Common";
import MultiUserAssignSelect from "../../components/MultiUserAssignSelect";
import UserAssignSelect from "../../components/UserAssignSelect";
import ConfirmModal from "../../components/ConfirmModal";
import JiraActivity from "../../components/JiraActivity";
import ClearableSearchInput from "../../components/ClearableSearchInput";
import RoleGroupLink from "../../components/RoleGroupLink";
import {
  QA_STATUSES,
  QA_STATUS_LABELS,
  QA_PENDING_WITH,
  QA_EXECUTION_GROUP_ROLE,
  TESTER_REASSIGNABLE_STATUSES,
  PRIORITIES,
  RISK_RATINGS,
  DEPLOYMENT_ENVIRONMENTS,
  CHANGE_TYPES,
  hasRole,
  hasDepartment,
  validTargetPromotionOptions,
  validEnvironmentPromotion,
  canManageReadinessEvidence,
  QA_DEPARTMENT,
} from "../../constants";
import {
  FunctionalOut,
  FunctionalListOut,
  UserOut,
  ChecklistItemOut,
  ApprovalActionOut,
  SignOffOut,
  EligibleTestCycleOut,
} from "../../types";
import { usePaginatedList } from "../../hooks/usePaginatedList";
// Reused as-is from the Governance module -- the app is now a single
// consolidated Vite app (see README "Frontend architecture"), so importing
// across module folders is a plain relative import, no remote/federation
// boundary involved. Raising sign-off from a Functional Testing Request
// always means the certificate is FOR that request, so it's opened here
// with `presetRequest={req}` (locks the Testing Request ID picker instead
// of showing a search box -- see NewSignOffModal in SignOff.tsx).
import { NewSignOffModal } from "../governance/SignOff";

// Priority/Risk Rating are real columns on FunctionalRequest itself. Every
// other field here (Application Name, CR Number/EPIC Number, Change Type,
// Deployment Environment, Target Promotion Environment, Release Version,
// Build Number, Target Release Date) is otherwise delegated (read-only) from
// the parent QA Request -- update_functional (backend) writes those straight
// through to the linked QA Request instead, since the QA Request gateway
// itself can no longer be edited once it's left Draft (see
// GATEWAY_EDITABLE_STATUSES) -- this is the only place left to fix one of
// them after that point. Application Name/CR Number/EPIC Number identify
// *which* request this actually is, so -- once raised -- only an Admin can
// change them (backend-enforced too, see update_functional's
// _ADMIN_ONLY_FIELDS); everyone else sees them locked. Department stays
// read-only everywhere (fixed to the requester's own profile).
function FunctionalFormModal({
  onClose,
  onSaved,
  editing,
}: {
  onClose: () => void;
  onSaved: (f: FunctionalOut) => void;
  editing: FunctionalOut;
}) {
  const { user } = useAuth();
  const isAdmin = hasRole(user, "ADMIN");
  const [form, setForm] = useState({
    priority: editing.priority || "Medium",
    risk_rating: editing.risk_rating || "Medium",
    application_name: editing.application_name || "",
    cr_number: editing.cr_number || editing.epic_number || "",
    change_type: editing.change_type || "New",
    environment: editing.environment || "SIT",
    target_promotion_environment: editing.target_promotion_environment || "UAT",
    release_version: editing.release_version || "",
    build_number: editing.build_number || "",
    target_release_date: editing.target_release_date || "",
  });
  // Lets the requester revisit their "Ready for Testing" readiness checklist
  // self-declaration from here too -- previously the only place to tick
  // these was the QA Request wizard at intake time, with no way back in
  // even while this request was still sitting in the requester's own hands
  // (e.g. Draft or returned for changes). Same pattern as Performance.tsx's
  // PerformanceFormModal/SAST.tsx's SASTFormModal.
  const [checkedItems, setCheckedItems] = useState<string[]>(
    editing.checklist_items
      .filter((c) => c.requester_checked)
      .map((c) => c.item)
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments(
    "/api/functional-requests",
    editing.id
  );
  // Mirrors the identity check the detail view computes for canEditDetails/
  // canSMDecide/canDepartmentHeadDecide -- this modal only ever opens via
  // that same canEditDetails gate, but the checklist evidence controls
  // inside it need their own explicit identity+status check (see
  // canManageReadinessEvidence's isOwner param) rather than assuming the
  // status alone means this particular viewer may attach/remove evidence.
  const isRequesterModal = editing.requester_id === user?.id || isAdmin;
  const sameDeptModal = hasDepartment(user, editing.department);
  const canSMDecideModal = hasRole(user, "SM") && editing.status === "SM_APPROVAL_PENDING" && sameDeptModal;
  const canDeptHeadDecideModal =
    hasRole(user, "DEPARTMENT_HEAD_CM", "DEPARTMENT_HEAD_AGM") &&
    editing.status === "DEPARTMENT_HEAD_APPROVAL_PENDING" && sameDeptModal;
  const canManageEvidenceModal =
    isAdmin ||
    (editing.status === "SM_APPROVAL_PENDING" ? canSMDecideModal :
    editing.status === "DEPARTMENT_HEAD_APPROVAL_PENDING" ? canDeptHeadDecideModal :
    isRequesterModal);
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  function toggleChecked(item: string) {
    setCheckedItems((items) =>
      items.includes(item) ? items.filter((i) => i !== item) : [...items, item]
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Same Deployment/Target Promotion Environment ordering rule as the QA
    // Request wizard's DetailsStep.tsx -- this modal's own dropdown already
    // only offers valid Target options and auto-corrects on Deployment
    // change (see the two selects below), so this should never actually
    // trip, but it's the last line of defense before the PUT goes out.
    if (!validEnvironmentPromotion(form.environment, form.target_promotion_environment)) {
      setError(
        new Error(
          `Target Promotion Environment ('${form.target_promotion_environment}') must be later than Deployment Environment ('${form.environment}') in the pipeline SIT -> UAT -> Pre-Production -> Production.`
        )
      );
      return;
    }
    setBusy(true);
    try {
      const saved = await api.put<FunctionalOut>(
        `/api/functional-requests/${editing.id}`,
        {
          ...form,
          target_release_date: form.target_release_date || null,
          checked_items: checkedItems,
        }
      );
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${editing.request_id}`} onClose={onClose} wide>
      {editing?.qa_request && (
        <p className="muted small" style={{ marginTop: -8 }}>
          Auto-created from QA Request {editing.qa_request.request_id} --
          changes below (other than Priority/Risk Rating) are saved back onto
          that QA Request, since it can no longer be edited directly once
          raised.
        </p>
      )}
      {!isAdmin && (
        <p className="muted small" style={{ marginTop: -4 }}>
          Application Name and CR Number/EPIC Number are locked once
          this request has been raised -- only an Administrator can change them.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-section">
          {/* <div className="form-section-title">
            Identity{!isAdmin ? " (Admin-only)" : ""}
          </div> */}
          <div className="form-row">
            <Field label="Application Name">
              <input
                disabled={!isAdmin}
                value={form.application_name}
                onChange={(e) => set("application_name", e.target.value)}
              />
            </Field>
            <Field label="CR Number/EPIC Number">
              <input
                disabled={!isAdmin}
                value={form.cr_number}
                onChange={(e) => set("cr_number", e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Classification</div>
          <div className="form-row">
            <Field label="Priority">
              <select
                value={form.priority}
                onChange={(e) => set("priority", e.target.value)}
              >
                {PRIORITIES.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Risk Rating">
              <select
                value={form.risk_rating}
                onChange={(e) => set("risk_rating", e.target.value)}
              >
                {RISK_RATINGS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Change &amp; Environment</div>
          <div className="form-row">
            <Field label="Change Type">
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
            <Field label="Deployment Environment">
              <select
                value={form.environment}
                onChange={(e) => {
                  const nextEnv = e.target.value;
                  set("environment", nextEnv);
                  // Target Promotion Environment must always stay strictly
                  // later than Deployment Environment in the SIT -> UAT ->
                  // Pre-Production -> Production pipeline -- snap it forward
                  // to the nearest valid stage if the already-picked target
                  // is no longer valid against the newly-picked deployment
                  // environment, same as DetailsStep.tsx.
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
            <Field label="Target Promotion Environment">
              <select
                value={form.target_promotion_environment}
                onChange={(e) =>
                  set("target_promotion_environment", e.target.value)
                }
              >
                <option value="">Select Target Promotion Environment</option>
                {validTargetPromotionOptions(form.environment).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Release Version / Hash Value">
              <input
                value={form.release_version}
                onChange={(e) => set("release_version", e.target.value)}
              />
            </Field>
            <Field label="Build Number / Hash Value">
              <input
                value={form.build_number}
                onChange={(e) => set("build_number", e.target.value)}
              />
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

        {editing.checklist_items.length > 0 && (
          <div className="form-section">
            <div className="form-section-title">
              Readiness Checklist — Self-Declaration
            </div>
            <p
              className="muted small"
              style={{ marginTop: -4, marginBottom: 8 }}
            >
              Update what's already in place. This is your own declaration for
              reference only -- QA independently verifies every mandatory item
              during Readiness Verification.
            </p>
            {/* Reported directly: "Attach Evidence is not uniform everywhere.
                On edit details it should be like while creating the
                request." -- reuses the exact same grid-table layout
                (security-checklist-table/-header/-row/-check/-criterion)
                as the QA Request wizard's ReadinessChecklistSection.tsx,
                instead of the ad-hoc flex row this used to be, so the
                Evidence column lines up identically here and at intake
                time. */}
            <div className="security-checklist-table" role="group" aria-label="Functional readiness checklist">
              <div className="security-checklist-header" aria-hidden="true">
                <span>Ready</span>
                <span>Readiness criterion</span>
                <span>Supporting evidence</span>
              </div>
              {editing.checklist_items.map((c) => {
                const checked = checkedItems.includes(c.item)
                const checkboxId = `functional-edit-checklist-${c.id}`
                return (
                  <div className={`security-checklist-row ${checked ? "is-checked" : ""}`} key={c.id}>
                    <div className="security-checklist-check">
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChecked(c.item)}
                      />
                    </div>
                    <label className="security-checklist-criterion" htmlFor={checkboxId}>
                      <span>
                        <strong>{c.item}</strong>
                        {c.owner && <span className="muted small">({c.owner})</span>}
                        {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
                        {c.is_complete && <span className="badge badge-green">QA verified</span>}
                      </span>
                    </label>
                    <ChecklistEvidence apiBase="/api/functional-requests" reqId={editing.id} itemId={c.id}
                      canManage={canManageReadinessEvidence(editing.status, canManageEvidenceModal)}
                      required={c.is_mandatory || c.requester_checked}
                      documents={documentsByItem[c.id] || []}
                      onReload={reloadEvidence}
                      checked={checked} />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <ErrorText error={error} />
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Saving..." : "Save Changes"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Compact "what happens after submit" preview -- mirrors the real lifecycle
// order (see backend app/constants.py QAStatus docstring): Draft -> SM ->
// Department Head -> QA -> Sign-off.
const LIFECYCLE_STAGES = [
  "Draft",
  "SM Approval",
  "Dept. Head Approval",
  "QA Activity",
  "Sign-off",
  "Closed",
];

// Reported directly: "sm approval not completed but still QA Lead assigned"
// -- the "Assigned Group" field/column used to hardcode "QA Lead"
// unconditionally, regardless of the request's actual current status, so it
// showed "QA Lead" even while a request was still sitting at
// SM_APPROVAL_PENDING (or earlier). This maps the real backend status (see
// routers/functional.py's own status transitions -- SM_APPROVAL_PENDING is
// gated by Role.SM, DEPARTMENT_HEAD_APPROVAL_PENDING by
// Role.DEPARTMENT_HEAD_CM/AGM, everything from QA_LEAD_ASSIGNED through
// QA_COMPLETED by Role.QA_LEAD) to whichever group is genuinely holding the
// request right now. Returns null for every requester-owned/terminal/
// Sign-off-phase status (Draft, Submitted, any RETURNED_BY_*/*_REJECTED,
// QA Sign-off phase, Requester Verification, Closed, Cancelled) -- those
// aren't sitting with a review group at all, so the field shows "—" instead
// of a misleading group.
// Derived from QA_PENDING_WITH (constants.ts) -- the same table that already
// drives the list's "Pending With" column and is itself kept in exact sync
// with dashboard.py's STAGE_TEAM/backend require_roles() gates -- rather
// than re-deriving its own status list, so this can never drift out of sync
// with "Pending With" or silently miss a status. Only labels that name an
// actual role-holding group get a RoleGroupLink; "Requester" (an individual,
// not a group) and "--" (terminal/dead-end) both resolve to null, which
// callers render as "--".
function assignedGroupFor(
  status: string,
  applicationMasterStatus?: string | null,
  department?: string | null,
): { role: string | string[]; label: string; department?: string | null } | null {
  // Reported directly: while the request's own status is still
  // SM_APPROVAL_PENDING but its Application Name is a brand-new entry
  // awaiting the Application Owner (see applicationNameAwareStatusLabel in
  // Common.tsx, which overrides the Status badge the same way), the actual
  // work is sitting with the Application Owner, not the SM yet -- checked
  // first, ahead of the normal QA_PENDING_WITH-derived mapping below, since
  // this is a sub-state of SM_APPROVAL_PENDING rather than its own status
  // value. `department` is passed through here (and nowhere else in this
  // function) because Application Owner is a department-scoped role
  // enforced server-side (require_same_department in
  // decide_app_owner_name) -- RoleGroupLink filters its member list to it
  // when provided.
  if (applicationNameAwareStatusLabel(status, applicationMasterStatus)) {
    return { role: "APPLICATION_OWNER", label: "Application Owner", department };
  }
  const pendingWith = QA_PENDING_WITH[status];
  // Reported directly: "SM mapping should be based on department level. but
  // SM group details showing those are from different department." SM and
  // Department Head are BOTH department-scoped roles enforced server-side
  // (require_same_department in sm_decision/department_head_decision,
  // functional.py) exactly like Application Owner above -- `department` was
  // missing here, so RoleGroupLink showed every SM/Department Head in the
  // system instead of just the ones who could actually act on this request.
  if (pendingWith === "SM") return { role: "SM", label: "SM", department };
  if (pendingWith === "Department Head") {
    return { role: ["DEPARTMENT_HEAD_CM", "DEPARTMENT_HEAD_AGM"], label: "Department Head", department };
  }
  // Reported directly: this "QA Lead group members" list should only show
  // literal QA_LEAD role holders -- Chief Manager - QA / AGM - QA act on
  // this work via their own separate Executive bypass (isAssignedQALead
  // below), not by being members of the QA Lead group, so they're
  // deliberately excluded from this roster even though they can still open
  // the request and act on it directly.
  if (pendingWith === "QA Lead") return { role: "QA_LEAD", label: "QA Lead" };
  // "QA" covers TESTER_ASSIGNED/TEST_DESIGN/EXECUTION_IN_PROGRESS/RETESTING --
  // limited to QA_ENGINEER only (reported directly) -- "Assigned Tester(s)"
  // elsewhere on the page names the specific individual, this names the
  // execution-team group accountable for the stage; QA_LEAD has its own
  // separate group above instead of also appearing here.
  if (pendingWith === "QA") return { role: QA_EXECUTION_GROUP_ROLE, label: "QA" };
  return null;
}

function StartExecutionModal({ req, busy, onCancel, onStart }: {
  req: FunctionalOut;
  busy: boolean;
  onCancel: () => void;
  onStart: (cycleId: number | null) => void;
}) {
  const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
  const [cycles, setCycles] = useState<EligibleTestCycleOut[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const linkedCycle = req.linked_test_cycles?.[0];

  useEffect(() => {
    if (answer !== "yes") return;
    setLoading(true);
    setError(null);
    api.get<EligibleTestCycleOut[]>(`/api/functional-requests/${req.id}/eligible-test-cycles`)
      .then(setCycles).catch(setError).finally(() => setLoading(false));
  }, [answer, req.id]);

  const query = search.trim().toLowerCase();
  const visibleCycles = cycles.filter((cycle) => !query ||
    cycle.cycle_key.toLowerCase().includes(query) ||
    cycle.name.toLowerCase().includes(query) ||
    cycle.project_key.toLowerCase().includes(query) ||
    cycle.project_name.toLowerCase().includes(query));

  return <Modal
    title="Start Functional Test Execution"
    onClose={onCancel}
    wide={!linkedCycle}
    variant={linkedCycle ? "dialog" : "drawer"}
    preventBackdropClose={!!linkedCycle}
  >
    {linkedCycle ? <>
      <div className="execution-cycle-existing">
        <span className="execution-cycle-existing-icon">✓</span>
        <div>
          <strong>
            Test Cycle <Link to={`/test-execution?project=${linkedCycle.project_id}&cycle=${linkedCycle.id}`}>{linkedCycle.cycle_key}</Link> is already linked to this request.
          </strong>
          <p>Do you want to start execution?</p>
          <small>{linkedCycle.name} · {linkedCycle.status}</small>
        </div>
      </div>
      <div className="execution-cycle-actions">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onStart(null)}>{busy ? "Starting…" : "Start Execution"}</button>
      </div>
    </> : <>
    <div className="execution-cycle-question">
      <strong>No test cycle is currently linked to this request.</strong>
      <p>Do you want to link a test cycle before starting execution?</p>
      <div className="execution-cycle-answer">
        <button type="button" className={`btn ${answer === "yes" ? "btn-primary" : ""}`} disabled={busy} onClick={() => { setAnswer("yes"); setSelectedCycleId(null); }}>Yes, Link Test Cycle</button>
        <button type="button" className={`btn ${answer === "no" ? "btn-primary" : ""}`} disabled={busy} onClick={() => { setAnswer("no"); setSelectedCycleId(null); }}>No, Start Without Linking</button>
      </div>
    </div>

    {answer === "yes" && <div className="execution-cycle-picker">
      <ClearableSearchInput value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch("")} placeholder="Search cycle name, ID or project…" clearLabel="Clear test cycle search" />
      {loading && <p className="muted">Loading eligible test cycles…</p>}
      {!loading && cycles.length === 0 && !error && <div className="execution-cycle-empty"><strong>No eligible test cycles found</strong><span>Only unlinked Not Started or In Progress cycles from an active project for this application can be selected.</span></div>}
      {!loading && cycles.length > 0 && visibleCycles.length === 0 && <p className="muted">No test cycles match your search.</p>}
      <div className="execution-cycle-list">
        {visibleCycles.map((cycle) => <button type="button" key={cycle.id} className={selectedCycleId === cycle.id ? "selected" : ""} onClick={() => setSelectedCycleId(cycle.id)}>
          <span><strong>{cycle.name}</strong><small>{cycle.cycle_key} · {cycle.project_key} — {cycle.project_name}</small></span>
          <Badge status={cycle.status} />
        </button>)}
      </div>
      <ErrorText error={error} />
    </div>}

    {answer === "no" && <div className="execution-cycle-advice">Test execution can start without a cycle. Linking test cases and a cycle is recommended for traceability and reporting.</div>}

    <div className="execution-cycle-actions">
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={busy || answer === null || (answer === "yes" && selectedCycleId === null)} onClick={() => onStart(answer === "yes" ? selectedCycleId : null)}>{busy ? "Starting…" : "Start Execution"}</button>
    </div>
    </>}
  </Modal>;
}

// Reported directly: while an Application Name is still with the
// Application Owner -- the first of the two approval tiers a name goes
// through, see ApplicationNameBanner -- this request's own `status` is
// already SM_APPROVAL_PENDING under the hood (same reason
// applicationNameAwareStatusLabel in components/Common.tsx overrides the
// Status badge), so this stepper would otherwise highlight "SM Approval" as
// the current stage even though there's nothing for the SM to do yet.
// `applicationOwnerPending` inserts an extra "Application Owner" step ahead
// of "SM Approval" and highlights THAT one as current instead -- only while
// genuinely at that exact sub-step (SM Approval stage AND
// application_master_status is still PENDING_APP_OWNER); collapses back to
// the normal stage list the moment the name clears that tier (or was never
// gated by one at all, e.g. an older request with no ApplicationMaster row).
function LifecyclePreview({
  status,
  history,
  applicationOwnerPending,
}: {
  status?: string;
  history: ApprovalActionOut[];
  applicationOwnerPending?: boolean;
}) {
  let stages = [...LIFECYCLE_STAGES];
  let effectiveActiveIndex = lifecycleStageIndex(status);

  // A return is a branch back to the requester, not continued forward
  // progress at the reviewer who returned it. Keep the stages genuinely
  // reached before the decision, then show where the request is now.
  if (status === "RETURNED_BY_SM" || status === "SM_REJECTED") {
    stages = ["Draft", "SM Approval", "Requester Action", "Dept. Head Approval", "QA Activity", "Sign-off", "Closed"];
    effectiveActiveIndex = 2;
  } else if (status === "RETURNED_BY_DEPARTMENT_HEAD") {
    stages = ["Draft", "SM Approval", "Dept. Head Approval", "Requester Action", "QA Activity", "Sign-off", "Closed"];
    effectiveActiveIndex = 3;
  } else if (status === "RETURNED_BY_QA_LEAD") {
    stages = ["Draft", "SM Approval", "Dept. Head Approval", "QA Activity", "Requester Action", "Sign-off", "Closed"];
    effectiveActiveIndex = 4;
  }

  const latestRejection = [...history].reverse().find((item) =>
    String(item.decision || "").toLowerCase() === "rejected"
  );
  const rejectionStep = latestRejection?.step_name || "";
  const terminalAfterRejection = status === "CLOSED" && !!latestRejection;

  // Rejection/early closure is a terminal branch. Do not paint QA Activity
  // and Sign-off as completed when the request never entered those stages.
  if (status === "DEPARTMENT_HEAD_REJECTED" || (terminalAfterRejection && rejectionStep.includes("Department Head"))) {
    stages = ["Draft", "SM Approval", "Dept. Head Approval", "Closed"];
    effectiveActiveIndex = 3;
  } else if (terminalAfterRejection && rejectionStep.includes("SM Approval")) {
    stages = ["Draft", "SM Approval", "Closed"];
    effectiveActiveIndex = 2;
  } else if (status === "CANCELLED") {
    stages = ["Draft", "Closed"];
    effectiveActiveIndex = 1;
  }

  const showAppOwnerStage = !!applicationOwnerPending && status === "SM_APPROVAL_PENDING";
  if (showAppOwnerStage) {
    stages = [LIFECYCLE_STAGES[0], "Application Owner", ...LIFECYCLE_STAGES.slice(1)];
    effectiveActiveIndex = 1;
  }
  return (
    <div className="stepper" style={{ margin: "4px 0 18px" }}>
      {stages.map((label, i) => (
        <React.Fragment key={label}>
          <div className={`step ${i <= effectiveActiveIndex ? "filled" : ""} ${i === effectiveActiveIndex ? "current" : ""}`}>
            <div className="circle">{i + 1}</div>
            <div className="step-label">{label}</div>
          </div>
          {i < stages.length - 1 && (
            <div className={`connector ${i < effectiveActiveIndex ? "filled" : ""}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function lifecycleStageIndex(status?: string): number {
  if (!status || status === "DRAFT") return 0;
  if (["SUBMITTED", "SM_APPROVAL_PENDING", "RETURNED_BY_SM"].includes(status))
    return 1;
  if (
    [
      "DEPARTMENT_HEAD_APPROVAL_PENDING",
      "RETURNED_BY_DEPARTMENT_HEAD",
    ].includes(status)
  )
    return 2;
  if (
    [
      "QA_LEAD_ASSIGNED",
      "READINESS_VERIFICATION",
      "RETURNED_BY_QA_LEAD",
      "QA_ACTIVITY_INITIATED",
      "PLANNING",
      "TESTER_ASSIGNED",
      "TEST_DESIGN",
      "EXECUTION_IN_PROGRESS",
      "DEFECT_RAISED",
      "WAITING_FOR_FIX",
      "RETESTING",
      "QA_COMPLETED",
    ].includes(status)
  )
    return 3;
  if (
    ["QA_SIGNOFF_PENDING", "QA_SIGNED_OFF", "REQUESTER_VERIFICATION"].includes(
      status
    )
  )
    return 4;
  if (
    ["CLOSED", "CANCELLED", "SM_REJECTED", "DEPARTMENT_HEAD_REJECTED"].includes(
      status
    )
  )
    return 5;
  return 0;
}

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id);
  return u ? u.full_name : null;
}

interface FunctionalDetailProps {
  req: FunctionalOut;
  onClose: () => void;
  onChanged: (req: FunctionalOut) => void;
  users: UserOut[];
}

function FunctionalDetail({
  req,
  onClose,
  onChanged,
  users,
}: FunctionalDetailProps) {
  const { user } = useAuth();
  const [tab, setTab] = useState("overview");
  const [checklist, setChecklist] = useState<ChecklistItemOut[]>([]);
  const [history, setHistory] = useState<ApprovalActionOut[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [comments, setComments] = useState("");
  const [selectedQALead, setSelectedQALead] = useState("");
  const [selectedTesters, setSelectedTesters] = useState<string[]>([]);
  // 2026-08 Reassignment CR -- a reason is mandatory when this is a genuine
  // reassignment (not the very first tester assignment); the backend
  // enforces this too (reassignment.require_reason), this is just the UI
  // half. Reset whenever the request itself changes, same as selectedTesters.
  const [reassignReason, setReassignReason] = useState("");
  // Whether the "require Department Head re-approval on return" popup (see
  // canReadinessDecide below) is open -- reported directly: an always-visible
  // checkbox next to "Readiness Failed" was easy to miss/forget before
  // clicking, so this is now asked as a pop-up at the moment of failing
  // readiness instead.
  const [showReapprovalConfirm, setShowReapprovalConfirm] = useState(false);
  const [readinessPassError, setReadinessPassError] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [showSignoffModal, setShowSignoffModal] = useState(false);
  const [showStartExecution, setShowStartExecution] = useState(false);
  const [executionNotice, setExecutionNotice] = useState("");
  const { documentsByItem, reload: reloadEvidence } = useChecklistDocuments(
    "/api/functional-requests",
    req.id
  );

  const load = useCallback(async () => {
    try {
      const [cl, hist] = await Promise.all([
        api.get<ChecklistItemOut[]>(
          `/api/functional-requests/${req.id}/checklist`
        ),
        api.get<ApprovalActionOut[]>(
          `/api/functional-requests/${req.id}/history`
        ),
      ]);
      setChecklist(cl);
      setHistory(hist);
    } catch (err) {
      setError(err);
    }
  }, [req.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(action: string, extra?: Record<string, unknown>) {
    setError(null);
    const isReadinessPass = action === "readiness-decision" && extra?.decision === "Passed";
    if (isReadinessPass) setReadinessPassError(null);
    setBusyAction(action);
    try {
      const updated = await api.post<FunctionalOut>(
        `/api/functional-requests/${req.id}/${action}`,
        extra || {}
      );
      onChanged(updated);
      setComments("");
      await load();
    } catch (err) {
      if (isReadinessPass) setReadinessPassError(err);
      else setError(err);
    } finally {
      setBusyAction(null);
    }
  }

  // Called once the QA Sign-off Certificate modal has successfully created
  // its Draft certificate (POST /api/signoffs) -- immediately links it to
  // this request and moves the request to QA_SIGNOFF_PENDING via the
  // existing request-signoff transition (see routers/functional.py::
  // request_signoff's new optional signoff_id, which is exactly what
  // schemas.RequestSignoffIn exists for).
  async function requestSignoffWithCertificate(cert: SignOffOut) {
    setShowSignoffModal(false);
    await act("request-signoff", { signoff_id: cert.id });
  }

  async function startExecution(cycleId: number | null) {
    setError(null);
    setBusyAction("start-execution");
    try {
      const updated = await api.post<FunctionalOut>(
        `/api/functional-requests/${req.id}/start-execution`,
        { link_test_cycle: cycleId !== null, test_cycle_id: cycleId }
      );
      onChanged(updated);
      setShowStartExecution(false);
      setExecutionNotice(cycleId !== null
        ? "Test cycle linked successfully. Test execution has started."
        : req.linked_test_cycles?.length
          ? `Test Cycle ${req.linked_test_cycles[0].cycle_key} was already linked. Test execution has started.`
          : "Execution has started without a linked test cycle. Linking a test cycle is recommended for traceability and reporting.");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyAction(null);
    }
  }

  async function unlinkTestCycle(cycle: FunctionalOut["linked_test_cycles"][number]) {
    if (!window.confirm(`Unlink ${cycle.cycle_key} - ${cycle.name} from ${req.request_id}? Test cases and execution results will not be deleted.`)) return;
    setError(null);
    setBusyAction(`unlink-cycle-${cycle.id}`);
    try {
      const updated = await api.del<FunctionalOut>(`/api/functional-requests/${req.id}/test-cycles/${cycle.id}`);
      onChanged(updated);
      setExecutionNotice(`Test cycle ${cycle.cycle_key} was unlinked successfully. Existing test cases and execution results were preserved.`);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleChecklistItem(item: ChecklistItemOut) {
    setError(null);
    try {
      await api.put(`/api/functional-requests/${req.id}/checklist/${item.id}`, {
        is_complete: !item.is_complete,
      });
      load();
    } catch (err) {
      setError(err);
    }
  }

  const qaLeads = users.filter((u) =>
    u.is_active && hasDepartment(u, QA_DEPARTMENT) && (u.roles || []).includes("QA_LEAD")
  );
  const testers = users.filter((u) =>
    u.is_active && hasDepartment(u, QA_DEPARTMENT) && (u.roles || []).includes("QA_ENGINEER")
  );

  const isAdmin = hasRole(user, "ADMIN");
  const isRequester = req.requester_id === user?.id || isAdmin;
  const isRequesterVerifier = isRequester || hasRole(user, "APPLICATION_OWNER");

  const status = req.status;
  const sameDept = hasDepartment(user, req.department);
  // Executive bypass: CHIEF_MANAGER_QA/AGM_QA can act on every QA-Lead-
  // gated action, same as Admin, without being listed as "QA Lead group"
  // members anywhere (display-only concern, kept to literal QA_LEAD --
  // see assignedGroupFor below). ORACLE_MIGRATION_2026-07.md section 59.
  const isQALead = hasRole(user, "QA_LEAD", "CHIEF_MANAGER_QA", "AGM_QA");
  const isAssignedQALead = isAdmin || isQALead;
  const assignedTesterIds = new Set(
    (req.assigned_tester_ids || "").split(",").filter(Boolean).map(Number)
  );
  const isAssignedTester = isAdmin || (hasRole(user, "QA_ENGINEER") && !!user?.id && assignedTesterIds.has(user.id));

  const canVerifyChecklist =
    isAssignedQALead &&
    status === "READINESS_VERIFICATION";

  const canSubmit = isRequester && status === "DRAFT";
  // SM_REJECTED included alongside the RETURNED_BY_* statuses -- reported
  // directly, a rejected request is now reopenable via the same resubmit
  // action instead of being a dead end (see resubmitLabel below for the
  // button's own wording).
  const canResubmit =
    isRequester &&
    [
      "RETURNED_BY_SM",
      "SM_REJECTED",
      "RETURNED_BY_DEPARTMENT_HEAD",
      "RETURNED_BY_QA_LEAD",
    ].includes(status);
  const resubmitLabel = status === "SM_REJECTED" ? "Reopen Request" : "Re-submit";
  // SM and Department Head approvals remain requester-department scoped.
  // QA is a central vertical, so QA Lead actions below are intentionally not
  // bound to the requester's department.
  // Blocks Sign/Approve on both the SM and Department Head decision panels
  // below while this request's Application Name is still PENDING/REJECTED
  // (not yet APPROVED) -- see ApplicationNameBanner. An unset status (no
  // ApplicationMaster row at all, e.g. an older request) doesn't block.
  const applicationNameBlocking =
    !!req.application_master_status &&
    req.application_master_status !== "APPROVED";
  // Reported directly: canEditDetails above lets the SM/Department Head
  // themselves open Edit Details while the request is sitting at their own
  // decision -- if they untick a mandatory Readiness checklist item there
  // (fix something, then decide), Sign/Approve must be blocked the exact
  // same way the QA Request wizard already blocks Submit/Raise for the same
  // reason (see QARequests/RequestDetail.tsx's own pendingMandatory), not
  // silently let through just because this is post-raise now.
  const pendingSelfDeclare = checklist
    .filter((c) => c.is_mandatory && !c.requester_checked)
    .map((c) => c.item);
  // Reported directly: the SM's own block message used to always say "your
  // decision above" even while the name was still sitting with the
  // Application Owner (i.e. not the SM's turn at all yet) -- misleading.
  // Tier-aware instead: names the actual holdup and who owns it. Updated
  // again when the decision banner itself moved off this page entirely (see
  // RequestDetail.tsx's own ApplicationNameBanner) -- "above" no longer
  // means anything here, so the PENDING_SM case now points to where the
  // decision actually happens.
  const smApplicationNameBlockedMessage =
    req.application_master_status === "PENDING_APP_OWNER"
      ? "This request's Application Name is still pending Application Owner approval -- it needs to be decided there before you can approve this request."
      : req.application_master_status === "REJECTED"
      ? "This request's Application Name was rejected -- the requester needs to pick a different name before this request can be approved."
      : "Application Name is still pending your decision -- decide it from this request's QA Request page before approving this request.";
  // Reported directly: a person who raised this request but also separately
  // holds SM/Department Head for the same department must not be able to
  // approve their own request just because they wear both hats -- someone
  // else holding that role has to decide it instead. Admin still bypasses
  // (matches the backend's require_not_requester, which does the same
  // check server-side regardless of what this button shows).
  const isSelfApproval = req.requester_id === user?.id && !isAdmin;
  const canSMDecide =
    hasRole(user, "SM") &&
    status === "SM_APPROVAL_PENDING" &&
    (sameDept || isAdmin) &&
    !isSelfApproval;
  const canDepartmentHeadDecide =
    hasRole(user, "DEPARTMENT_HEAD_CM", "DEPARTMENT_HEAD_AGM") &&
    status === "DEPARTMENT_HEAD_APPROVAL_PENDING" &&
    (sameDept || isAdmin) &&
    !isSelfApproval;
  // Reported directly: "only the assigned person can update" -- once the
  // request has moved past the requester (e.g. to SM_APPROVAL_PENDING), the
  // requester is no longer the current assignee, so evidence control passes
  // exclusively to whoever it's actually sitting with now, matching the
  // backend's own (now-exclusive) _can_upload_documents exactly. Combined
  // with canManageReadinessEvidence's own status gate below, this only ever
  // matters for the pre-QA-lead-assignment statuses it covers.
  const evidenceOwner =
    isAdmin ||
    (status === "SM_APPROVAL_PENDING" ? canSMDecide :
    status === "DEPARTMENT_HEAD_APPROVAL_PENDING" ? canDepartmentHeadDecide :
    isRequester);
  // Document and Evidence Access Control Based on Workflow Stage: exactly 3
  // upload stages, then a hard lock -- (1) the requester while it's Draft/
  // Submitted/Returned-by-*/Rejected/back for final verification, (2) the
  // SM only while SM_APPROVAL_PENDING, (3) the Department Head only while
  // DEPARTMENT_HEAD_APPROVAL_PENDING. Every QA-activity status after
  // Department Head approval is locked for everyone but Admin -- mirrors
  // the backend's own (now-simplified) _can_upload_documents exactly. Used
  // for the general Documents tab; evidenceOwner above covers the same 3
  // stages for checklist evidence.
  const canManageDocuments =
    isAdmin ||
    (["DRAFT", "SUBMITTED", "RETURNED_BY_SM", "SM_REJECTED", "RETURNED_BY_DEPARTMENT_HEAD",
      "RETURNED_BY_QA_LEAD", "REQUESTER_VERIFICATION"].includes(status)
      ? isRequester
      : status === "SM_APPROVAL_PENDING"
      ? canSMDecide
      : status === "DEPARTMENT_HEAD_APPROVAL_PENDING"
      ? canDepartmentHeadDecide
      : false);
  const canStartReadiness =
    isAssignedQALead && status === "QA_LEAD_ASSIGNED";
  const canReadinessDecide =
    isAssignedQALead && status === "READINESS_VERIFICATION";
  const canBeginPlanning =
    isAssignedQALead && status === "QA_ACTIVITY_INITIATED";
  // 2026-08 -- reported directly: "once assigned there are no other option
  // to reassign the tester or modify the tester. give qa lead to reassign as
  // well as the current assign people can reasign to another qa member."
  // Widened from "QA Lead group only, only while status === PLANNING" to:
  // the QA Lead group OR any currently-assigned tester, at any point across
  // TESTER_REASSIGNABLE_STATUSES (Planning through Retesting). The backend
  // (functional.py's assign_tester) enforces the exact same window/authors
  // -- this only decides whether the button renders.
  const isInitialTesterAssignment = status === "PLANNING";
  // 2026-08 Reassignment CR, reported directly: "Reassignment shall be
  // permitted to: the current assignee, the Department Head of the
  // department to which the current assignee belongs, or Admin users." --
  // then, reported directly again: QA_LEAD is required to keep reassignment
  // rights too, restoring parity with isAssignedQALead (which already gates
  // the first assignment). Mirrors functional.py's
  // _require_can_reassign_tester exactly.
  const isQADepartmentHead =
    isAdmin || (hasRole(user, "CHIEF_MANAGER_QA", "AGM_QA") && hasDepartment(user, QA_DEPARTMENT));
  const canReassignTester = isAssignedTester || isQADepartmentHead || hasRole(user, "QA_LEAD");
  const canAssignTester =
    (isInitialTesterAssignment ? isAssignedQALead || isAssignedTester : canReassignTester) &&
    TESTER_REASSIGNABLE_STATUSES.includes(status);
  const currentTesterIds = (req.assigned_tester_ids || "").split(",").filter(Boolean).map(Number).sort((a, b) => a - b);
  const nextTesterIds = selectedTesters.map(Number).sort((a, b) => a - b);
  const testerAssignmentChanged = currentTesterIds.length !== nextTesterIds.length || currentTesterIds.some((id, index) => id !== nextTesterIds[index]);
  // Pre-fill the picker with the currently-assigned tester(s) when this is a
  // reassignment (not the first-ever assignment) -- so reassigning defaults
  // to "hand off from the current roster" rather than starting blank. Only
  // runs once per loaded request (keyed on id + the assignment string
  // itself), so it won't stomp on in-progress edits to the picker.
  useEffect(() => {
    if (canAssignTester && !isInitialTesterAssignment) {
      setSelectedTesters((req.assigned_tester_ids || "").split(",").filter(Boolean));
    }
    // req.assigned_tester_ids only actually changes once a reassignment has
    // saved and reloaded, so clearing the reason field here (rather than
    // optimistically after the act() call, which resolves the same whether
    // the request succeeded or failed) only clears it on genuine success.
    setReassignReason("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.id, req.assigned_tester_ids, isInitialTesterAssignment]);
  const canStartTestDesign =
    isAssignedTester && status === "TESTER_ASSIGNED";
  const canStartExecution =
    isAssignedTester && status === "TEST_DESIGN";
  // Workflow change (reported directly: "raise defect, start retest
  // currently not required as everything is linked with test cycle") --
  // once a Test Cycle is linked, defects are raised/tracked/retested via
  // Test Execution + the Defects module against that cycle, not this
  // request's own manual Defect Raised/Waiting For Fix/Retesting states.
  // The backend enforces this too (see functional.py's
  // _require_no_linked_cycle_for_manual_defect_flow) -- this just keeps the
  // button from ever being offered in that case. Still shown for a request
  // started without linking a cycle (link_test_cycle=false at Start
  // Execution remains supported), where it's the only defect-tracking path.
  const hasLinkedCycle = (req.linked_test_cycles?.length ?? 0) > 0;
  const openLinkedCycles = (req.linked_test_cycles || []).filter(
    (cycle) => cycle.status !== "Completed"
  );
  const canRaiseDefect =
    isAssignedTester &&
    status === "EXECUTION_IN_PROGRESS" &&
    !hasLinkedCycle;
  const canMarkWaitingForFix =
    isAssignedTester && status === "DEFECT_RAISED";
  const canStartRetest =
    isAssignedTester && status === "WAITING_FOR_FIX";
  // Mark QA Complete now also requires every linked Test Cycle to have
  // actually reached Completed -- see functional.py::complete_qa's matching
  // gate. A request with no linked cycle has nothing to wait on.
  const canCompleteQA =
    isAssignedTester &&
    ["EXECUTION_IN_PROGRESS", "RETESTING"].includes(
      status
    ) &&
    openLinkedCycles.length === 0;
  const completeQABlockedByCycle =
    isAssignedTester &&
    ["EXECUTION_IN_PROGRESS", "RETESTING"].includes(status) &&
    openLinkedCycles.length > 0;
  // 2026-08 -- reported directly: "'Request Sign Off' button is not
  // enable[d] for QA lead ... if tester [is] no[t] available then at least
  // [o]n behalf of QA he can raise the request." Previously this only
  // checked isAssignedTester, so a QA Lead (not also the assigned tester)
  // never saw the button even though whoever ran QA through to completion
  // should be able to raise the certificate -- widened to match the
  // backend's now-fixed "QA Lead group OR current tester" gate on both
  // POST /{id}/request-signoff (functional.py) and POST /api/signoffs
  // (signoff.py), so the QA Lead can raise it themselves when a tester
  // isn't available to.
  const canRequestSignoff =
    (isAssignedTester || isAssignedQALead) &&
    (hasRole(user, "ADMIN") || hasDepartment(user, QA_DEPARTMENT)) &&
    status === "QA_COMPLETED";
  // "Confirm Sign-off" (a manual QA Lead click) removed -- the linked
  // certificate reaching ISSUED now auto-advances this request straight to
  // Requester Verification (see routers/signoff.py::
  // _sync_linked_functional_request), so there's nothing left to manually
  // confirm here. While a certificate is still working through its own
  // Tester -> SM -> Department Head COE chain, this request just sits at
  // "QA Sign-off Pending" with no action available on this side -- correct,
  // since it's genuinely waiting on someone else's decision, not on QA.
  const canRequesterDecide =
    isRequesterVerifier && status === "REQUESTER_VERIFICATION";
  // Mirrors backend FUNCTIONAL_EDITABLE_STATUSES/_can_edit_details exactly:
  // the requester (or admin) may edit while it's Draft or sitting with them
  // after a return (RETURNED_BY_SM/RETURNED_BY_DEPARTMENT_HEAD/
  // RETURNED_BY_QA_LEAD) -- returning a request hands it back to the
  // requester to fix and resubmit, so the reviewer who returned it doesn't
  // also keep edit access. Separately, the SM/Department Head may edit
  // while the request is genuinely pending *their own* decision
  // (SM_APPROVAL_PENDING/DEPARTMENT_HEAD_APPROVAL_PENDING) -- fix
  // something, then decide -- but that access disappears the moment
  // they've approved/returned/rejected; it never extends past Department
  // Head's own decision into QA's post-approval readiness/execution
  // stages.
  const canEditDetails =
    isAdmin ||
    (isRequester &&
      [
        "DRAFT",
        "RETURNED_BY_SM",
        "SM_REJECTED",
        "RETURNED_BY_DEPARTMENT_HEAD",
        "RETURNED_BY_QA_LEAD",
      ].includes(status)) ||
    (hasRole(user, "SM") && status === "SM_APPROVAL_PENDING" && sameDept) ||
    (hasRole(user, "DEPARTMENT_HEAD_CM", "DEPARTMENT_HEAD_AGM") &&
      status === "DEPARTMENT_HEAD_APPROVAL_PENDING" &&
      sameDept);

  return (
    <Modal
      title={`${req.request_id} — ${req.application_name || ""}`}
      onClose={onClose}
      wide
    >
      <div className="tabs">
        {["overview", "checklist", "documents", "history"].map(
          (t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t === "history" ? "Activity" : t[0].toUpperCase() + t.slice(1)}
            </button>
          )
        )}
      </div>
      <ErrorText error={error} />

      {tab === "overview" && (
        <div>
          <LifecyclePreview
            status={req.status}
            history={history}
            applicationOwnerPending={req.application_master_status === "PENDING_APP_OWNER"}
          />

          <DetailSection title="Status">
            <DetailField label="Status">
              <Badge status={req.status} label={applicationNameAwareStatusLabel(req.status, req.application_master_status)} />
              {req.needs_dept_head_reapproval && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                  Department Head re-approval required after changes
                </span>
              )}
            </DetailField>
            <DetailField label="Priority / Risk">
              {req.priority || "—"} / {req.risk_rating || "—"}
            </DetailField>
            <DetailField label="Request Type(s)">
              {req.request_types || "—"}
            </DetailField>
            <DetailField label="Created">
              {new Date(req.created_at).toLocaleString()}
            </DetailField>
            <DetailField label="Last Updated">
              {new Date(req.updated_at).toLocaleString()}
            </DetailField>
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Application Name">
              {req.application_name || "—"}
              {req.application_master_status === "PENDING_APP_OWNER" && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                  Application Owner Approval Pending
                </span>
              )}
              {req.application_master_status === "PENDING_SM" && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                  Pending SM Approval
                </span>
              )}
              {req.application_master_status === "REJECTED" && (
                <span className="badge badge-red" style={{ marginLeft: 8 }}>
                  Rejected — pick a different name
                </span>
              )}
            </DetailField>
            <DetailField label="CR Number/EPIC Number">
              {req.cr_number || req.epic_number || "—"}
            </DetailField>
            <DetailField label="Change Type">
              {req.change_type || "—"}
            </DetailField>
            <DetailField label="Department">
              {req.department || "—"}
            </DetailField>
            <DetailField label="Application Owner">
              {req.application_owner || "—"}
            </DetailField>
          </DetailSection>

          <DetailSection title="Environment & Release">
            <DetailField label="Deployment Environment">
              {req.environment || "—"}
            </DetailField>
            <DetailField label="Target Promotion Environment">
              {req.target_promotion_environment || "—"}
            </DetailField>
            <DetailField label="Release Version / Hash Value">
              {req.release_version || "—"}
            </DetailField>
            <DetailField label="Build Number / Hash Value">
              {req.build_number || "—"}
            </DetailField>
            <DetailField label="Target Release Date">
              {req.target_release_date || "—"}
            </DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">
              {userName(users, req.requester_id) || "—"}
            </DetailField>
            <DetailField label="Department Head">
              {userName(users, req.department_head_id) || "—"}
            </DetailField>
            <DetailField label="Assigned Group">
              {(() => {
                const assigned = assignedGroupFor(req.status, req.application_master_status, req.department);
                return assigned ? <RoleGroupLink users={users} role={assigned.role} label={assigned.label} department={assigned.department} /> : "—";
              })()}
            </DetailField>
            <DetailField label="Assigned Tester(s)">
              {req.assigned_tester_ids
                ? req.assigned_tester_ids
                    .split(",")
                    .map((id) => userName(users, Number(id)) || id)
                    .join(", ")
                : "—"}
            </DetailField>
          </DetailSection>

          {req.linked_test_cycles?.length > 0 && (
            <DetailSection title="Linked Test Cycle">
              {req.linked_test_cycles.map((cycle) => (
                <DetailField key={cycle.id} label={cycle.cycle_key}>
                  <Link className="linked-cycle-link" to={`/test-execution?project=${cycle.project_id}&cycle=${cycle.id}`}><strong>{cycle.name}</strong></Link> · {cycle.status}
                  {(cycle.start_date || cycle.end_date) && <span className="muted small"> · {cycle.start_date || "—"} to {cycle.end_date || "—"}</span>}
                  {(isAssignedTester || isAssignedQALead) && <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} disabled={!!busyAction} onClick={() => unlinkTestCycle(cycle)}>{busyAction === `unlink-cycle-${cycle.id}` ? "Unlinking…" : "Unlink"}</button>}
                </DetailField>
              ))}
            </DetailSection>
          )}

          {req.qa_request && (
            <p className="muted small">
              Raised alongside QA Request{" "}
              <strong>{req.qa_request.request_id}</strong> — see that request
              for supporting documents and any other linked
              SAST/DAST/Performance requests.
            </p>
          )}

          {(canSMDecide || canDepartmentHeadDecide) &&
            pendingSelfDeclare.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  marginBottom: 8,
                  background: "#fffaeb",
                  border: "1px solid #fde68a",
                  borderRadius: 10,
                  padding: "10px 14px",
                  color: "#92400e",
                  fontSize: 13,
                }}
              >
                <strong>Cannot Sign/Approve yet</strong> — the following
                mandatory Readiness checklist item(s) must be self-declared
                ready first (Edit Details):
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {pendingSelfDeclare.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

          <div className="section-title">Workflow Actions</div>
          {executionNotice && <div className={`execution-start-notice ${req.linked_test_cycles?.length ? "linked" : "unlinked"}`} role="status"><strong>{executionNotice.includes("was unlinked") ? "Test cycle unlinked" : req.linked_test_cycles?.length ? "Execution started" : "Execution started without a cycle"}</strong><span>{executionNotice}</span></div>}
          {completeQABlockedByCycle && (
            <div
              style={{
                marginTop: 8,
                marginBottom: 8,
                background: "#fffaeb",
                border: "1px solid #fde68a",
                borderRadius: 10,
                padding: "10px 14px",
                color: "#92400e",
                fontSize: 13,
              }}
            >
              <strong>Mark QA Complete is locked</strong> — every linked Test
              Cycle must reach Completed first. Still open:{" "}
              {openLinkedCycles
                .map((cycle) => `${cycle.cycle_key} (${cycle.status})`)
                .join(", ")}
              . Raise and retest defects from Test Execution / the Defects
              module against the linked cycle.
            </div>
          )}
          <div className="actions-panel">
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <button
                className="btn btn-sm"
                onClick={() =>
                  api.downloadFile(
                    `/api/functional-requests/${req.id}/export`,
                    `${req.request_id}.pdf`
                  )
                }
              >
                Export PDF
              </button>
              {canEditDetails && (
                <button
                  className="btn btn-sm"
                  disabled={!!busyAction}
                  onClick={() => setEditingDetails(true)}
                >
                  Edit Details
                </button>
              )}
              {canSubmit && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("submit")}
                >
                  Submit for SM Approval
                </button>
              )}
              {canResubmit && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("resubmit")}
                >
                  {resubmitLabel}
                </button>
              )}

              {canSMDecide && (
                <ApprovalDecisionButtons
                  userName={user?.full_name}
                  comments={comments}
                  busy={!!busyAction}
                  signBlocked={applicationNameBlocking || pendingSelfDeclare.length > 0}
                  signBlockedMessage={
                    applicationNameBlocking
                      ? smApplicationNameBlockedMessage
                      : pendingSelfDeclare.length > 0
                      ? "Mandatory Readiness checklist item(s) are not self-declared ready -- see the notice above."
                      : undefined
                  }
                  onApprove={(signed) =>
                    act("sm-decision", {
                      decision: "Approved",
                      comments: signed,
                    })
                  }
                  onReturn={(actionNote) =>
                    act("sm-decision", { decision: "Returned", comments: actionNote })
                  }
                  onReject={(actionNote) =>
                    act("sm-decision", { decision: "Rejected", comments: actionNote })
                  }
                />
              )}

              {canDepartmentHeadDecide && (
                <ApprovalDecisionButtons
                  userName={user?.full_name}
                  comments={comments}
                  busy={!!busyAction}
                  signBlocked={applicationNameBlocking || pendingSelfDeclare.length > 0}
                  signBlockedMessage={
                    applicationNameBlocking
                      ? "This request's Application Name is not yet approved by SM."
                      : pendingSelfDeclare.length > 0
                      ? "Mandatory Readiness checklist item(s) are not self-declared ready -- see the notice above."
                      : undefined
                  }
                  extraControlLabel="Assign to group"
                  extraControl={<RoleGroupLink users={users} role="QA_LEAD" label="QA Lead" />}
                  extraReady
                  onApprove={(signed) =>
                    act("department-head-decision", {
                      decision: "Approved",
                      comments: signed,
                    })
                  }
                  onReturn={(actionNote) =>
                    act("department-head-decision", {
                      decision: "Returned",
                      comments: actionNote,
                    })
                  }
                  onReject={(actionNote) =>
                    act("department-head-decision", {
                      decision: "Rejected",
                      comments: actionNote,
                    })
                  }
                />
              )}

              {canStartReadiness && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("start-readiness-verification")}
                >
                  Start Readiness Verification
                </button>
              )}
              {canReadinessDecide && (
                <>
                  <div className="form-field" style={{ width: "100%" }}>
                    <label htmlFor="readiness-earlier-behaviour">
                      What was the behaviour earlier? <small className="muted">(optional)</small>
                    </label>
                    <textarea
                      id="readiness-earlier-behaviour"
                      rows={3}
                      value={comments}
                      onChange={(e) => setComments(e.target.value)}
                      placeholder="Describe what the application's behaviour was before this QA cycle, for the tester's reference…"
                      disabled={!!busyAction}
                    />
                  </div>
                  <button
                    className="btn btn-success btn-sm"
                    disabled={!!busyAction}
                    onClick={() =>
                      act("readiness-decision", {
                        decision: "Passed",
                        comments,
                      })
                    }
                  >
                    Readiness Passed
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={!!busyAction}
                    onClick={() => setShowReapprovalConfirm(true)}
                  >
                    Readiness Failed
                  </button>
                </>
              )}
              {showReapprovalConfirm && (
                <ConfirmModal
                  title="Readiness Failed"
                  message="Require Department Head re-approval when this request is returned to the requester?"
                  confirmLabel="Yes, require re-approval"
                  cancelLabel="No, skip re-approval"
                  busy={!!busyAction}
                  onConfirm={() => {
                    setShowReapprovalConfirm(false);
                    act("readiness-decision", {
                      decision: "Failed",
                      comments,
                      require_dept_head_reapproval: true,
                    });
                  }}
                  onCancel={() => {
                    setShowReapprovalConfirm(false);
                    act("readiness-decision", {
                      decision: "Failed",
                      comments,
                      require_dept_head_reapproval: false,
                    });
                  }}
                />
              )}

              {canBeginPlanning && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("begin-planning")}
                >
                  Begin Planning
                </button>
              )}
              {canAssignTester && (
                <>
                  <MultiUserAssignSelect
                    value={selectedTesters}
                    onChange={setSelectedTesters}
                    users={testers}
                    placeholder={
                      isInitialTesterAssignment
                        ? "Assign Tester(s)..."
                        : "Reassign Tester(s)..."
                    }
                    disabled={!!busyAction}
                    style={{ minWidth: 260 }}
                  />
                  {!isInitialTesterAssignment && (
                    <input
                      className="reassign-reason-input"
                      style={{ minWidth: 220 }}
                      placeholder="Reason for reassignment *"
                      value={reassignReason}
                      onChange={(e) => setReassignReason(e.target.value)}
                      disabled={!!busyAction}
                    />
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={
                      selectedTesters.length === 0 ||
                      !!busyAction ||
                      (!isInitialTesterAssignment && (!testerAssignmentChanged || !reassignReason.trim()))
                    }
                    onClick={() =>
                      act("assign-tester", {
                        tester_ids: selectedTesters.map(Number),
                        ...(isInitialTesterAssignment ? {} : { reason: reassignReason.trim() }),
                      })
                    }
                  >
                    {isInitialTesterAssignment
                      ? "Assign Tester(s)"
                      : "Reassign Tester(s)"}
                  </button>
                </>
              )}
              {canStartTestDesign && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("start-test-design")}
                >
                  Start Test Design
                </button>
              )}
              {canStartExecution && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => { setExecutionNotice(""); setShowStartExecution(true); }}
                >
                  Start Execution
                </button>
              )}

              {canRaiseDefect && (
                <button
                  className="btn btn-danger btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("raise-defect", { comments })}
                >
                  Raise Defect
                </button>
              )}
              {canMarkWaitingForFix && (
                <button
                  className="btn btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("mark-waiting-for-fix", { comments })}
                >
                  Mark Waiting For Fix
                </button>
              )}
              {canStartRetest && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("start-retesting", { comments })}
                >
                  Start Retesting
                </button>
              )}
              {canCompleteQA && (
                <button
                  className="btn btn-success btn-sm"
                  disabled={!!busyAction}
                  onClick={() => act("complete-qa", { comments })}
                >
                  Mark QA Completed
                </button>
              )}

              {canRequestSignoff && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction}
                  onClick={() => setShowSignoffModal(true)}
                >
                  Request Sign-off
                </button>
              )}

              {canRequesterDecide && (
                <>
                  <button
                    className="btn btn-success btn-sm"
                    disabled={!!busyAction}
                    onClick={() =>
                      act("requester-decision", {
                        decision: "Accepted",
                        comments,
                      })
                    }
                  >
                    Accept &amp; Close
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={!!busyAction}
                    onClick={() =>
                      act("requester-decision", {
                        decision: "ChangesRequired",
                        comments,
                      })
                    }
                  >
                    Changes Required
                  </button>
                </>
              )}

              {!canEditDetails &&
                !canSubmit &&
                !canResubmit &&
                !canSMDecide &&
                !canDepartmentHeadDecide &&
                !canStartReadiness &&
                !canReadinessDecide &&
                !canBeginPlanning &&
                !canAssignTester &&
                !canStartTestDesign &&
                !canStartExecution &&
                !canRaiseDefect &&
                !canMarkWaitingForFix &&
                !canStartRetest &&
                !canCompleteQA &&
                !canRequestSignoff &&
                !canRequesterDecide && (
                  <span className="muted small">
                    No actions available for your role at this stage.
                  </span>
                )}
            </div>
          </div>

          {editingDetails && (
            <FunctionalFormModal
              editing={req}
              onClose={() => setEditingDetails(false)}
              onSaved={(saved) => {
                setEditingDetails(false);
                onChanged(saved);
                // Keep the Checklist tab's own state in sync immediately --
                // it's otherwise only fetched once, in `load()` above.
                setChecklist(saved.checklist_items || []);
              }}
            />
          )}

          {showSignoffModal && (
            <NewSignOffModal
              presetRequest={req}
              onClose={() => setShowSignoffModal(false)}
              onCreated={requestSignoffWithCertificate}
            />
          )}
        </div>
      )}

      {tab === "checklist" && (
        <div>
          <p className="muted small">
            "Ready for Testing" gate — all mandatory items must be complete
            before Testing Initiation.
          </p>
          <p className="muted small">
            <strong>Requester declared</strong> is the requester's own
            self-declaration at raise-time (reference only).{" "}
            <strong>QA Lead verified</strong> is the binding, independent
            verification — ticking a requester-declared item does NOT
            auto-approve it here.
          </p>
          {status !== "READINESS_VERIFICATION" && (
            <p className="muted small">
              QA Lead verification is locked outside the Readiness Verification
              stage (current status: {QA_STATUS_LABELS[status] || status}).
            </p>
          )}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "6px 0",
              fontWeight: 600,
              fontSize: 12,
              color: "var(--muted)",
            }}
          >
            <span style={{ flex: 1 }}>Item</span>
            <span style={{ width: 130, textAlign: "center" }}>
              Requester declared
            </span>
            <span style={{ width: 130, textAlign: "center" }}>
              QA Lead verified
            </span>
            <span style={{ width: 230, textAlign: "center" }}>Evidence</span>
          </div>
          {checklist.map((c) => (
            <div
              key={c.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "6px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ flex: 1 }}>
                {c.item} <span className="muted small">({c.owner})</span>{" "}
                {c.is_mandatory && (
                  <span className="badge badge-gray">Mandatory</span>
                )}
              </span>
              <span style={{ width: 130, textAlign: "center" }}>
                {c.requester_checked ? (
                  <span className="badge badge-blue">Declared</span>
                ) : (
                  <span className="muted small">Not ticked</span>
                )}
              </span>
              <span style={{ width: 130, textAlign: "center" }}>
                <input
                  type="checkbox"
                  checked={c.is_complete}
                  disabled={
                    !canVerifyChecklist ||
                    (!c.requester_checked && !c.is_complete)
                  }
                  title={
                    !canVerifyChecklist
                      ? "Only verifiable by QA Lead / QA Engineer / Business Analyst during Readiness Verification"
                      : !c.requester_checked && !c.is_complete
                      ? "The requester has not self-declared this item ready yet -- cannot verify it until they tick it"
                      : ""
                  }
                  onChange={() => toggleChecklistItem(c)}
                />
              </span>
              <ChecklistEvidence apiBase="/api/functional-requests" reqId={req.id} itemId={c.id}
                canManage={canManageReadinessEvidence(req.status, evidenceOwner)}
                required={c.is_mandatory || c.requester_checked}
                documents={documentsByItem[c.id] || []}
                onReload={reloadEvidence}
                checked={c.requester_checked} />
            </div>
          ))}
        </div>
      )}

      {tab === "history" && (
        <JiraActivity entityType="FUNCTIONAL_REQUEST" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      {tab === "documents" && (
        <RequestDocuments apiBase="/api/functional-requests" reqId={req.id} canManage={canManageDocuments} />
      )}

      <ErrorText
        error={readinessPassError}
        title="Readiness cannot be passed"
        guidance="Review the Readiness Checklist, complete the listed verification items, and then try “Readiness Passed” again."
      />
      {showStartExecution && <StartExecutionModal req={req} busy={busyAction === "start-execution"} onCancel={() => setShowStartExecution(false)} onStart={startExecution} />}
    </Modal>
  );
}

export default function Functional() {
  const [users, setUsers] = useState<UserOut[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  // SRS 7.2 PAG-006 -- the list only ever holds the lightweight
  // FunctionalListOut shape; opening a request fetches the full
  // FunctionalOut record fresh via GET /api/functional-requests/{id} before
  // FunctionalDetail (which needs every field) is shown.
  const [selected, setSelected] = useState<FunctionalOut | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    items: requests, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading, setPage, setPageSize, reload,
  } = usePaginatedList<FunctionalListOut>("/api/functional-requests", {
    status: statusFilter ? [statusFilter] : undefined,
  });

  useEffect(() => {
    api.get<UserOut[]>("/api/auth/users").then(setUsers).catch(setError);
  }, []);

  const openRequest = useCallback(async (idOrRow: number | FunctionalListOut) => {
    const id = typeof idOrRow === "number" ? idOrRow : idOrRow.id;
    setOpeningId(id);
    try {
      const full = await api.get<FunctionalOut>(`/api/functional-requests/${id}`);
      setSelected(full);
    } catch (err) {
      setError(err);
    } finally {
      setOpeningId(null);
    }
  }, []);

  // Deep-link support: the gateway QA Request's "Linked Requests" table
  // opens a specific request here via `?open=<request_id>`, e.g. navigating
  // straight from /qa-requests to /functional-requests?open=TQA-FUNC-...
  // Once the list has loaded, find the matching row and open its detail
  // exactly as a row click would, then drop the query param so it doesn't
  // re-trigger on refresh/back-navigation.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || requests.length === 0) return;
    const match = requests.find((r) => r.request_id === openId);
    if (match) openRequest(match.id);
    setSearchParams(
      (p) => {
        p.delete("open");
        return p;
      },
      { replace: true }
    );
  }, [requests, searchParams, setSearchParams, openRequest]);

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Functional QA Requests"
        count={total}
        subtitle="Combined Functional Testing, Regression Testing, Sanity Testing and UAT Support workflow --
                   raised via a QA Request (include any of these in its request types), then tracked here
                   through Department Head approval, readiness verification, execution and sign-off."
      />
      {/* <div className="toolbar">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {QA_STATUSES.map((s) => (
            <option key={s} value={s}>
              {QA_STATUS_LABELS[s] || s}
            </option>
          ))}
        </select>
      </div> */}

      <Card>
        <Table
          rowKey="id"
          onRowClick={(r) => openRequest(r)}
          server={{
            page, pageSize, total, totalPages, hasNext, hasPrevious,
            onPageChange: setPage, onPageSizeChange: setPageSize, loading,
          }}
          columns={[
            {
              key: "request_id",
              header: "Request ID",
              render: (r) => (openingId === r.id ? "Opening…" : r.request_id),
            },
            {
              key: "application_name",
              header: "Application",
              render: (r) => r.application_name || "—",
            },
            {
              key: "cr_number",
              header: "CR Number/EPIC Number",
              render: (r) => r.cr_number || r.epic_number || "—",
            },
            {
              key: "requester_id",
              header: "Requester",
              render: (r) => userName(users, r.requester_id) || "—",
              filterValue: (r) => userName(users, r.requester_id) || "",
            },
            {
              key: "qa_lead_id",
              header: "Assigned Group",
              render: (r) => assignedGroupFor(r.status, r.application_master_status)?.label || "—",
              filterValue: (r) => assignedGroupFor(r.status, r.application_master_status)?.label || "",
            },
            {
              key: "priority",
              header: "Priority",
              render: (r) => r.priority || "—",
            },
            {
              key: "status",
              header: "Status",
              render: (r) => <Badge status={r.status} label={applicationNameAwareStatusLabel(r.status, r.application_master_status)} />,
            },
            {
              key: "pending_with",
              header: "Pending With",
              render: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? "Application Owner" : (QA_PENDING_WITH[r.status] || "—"),
              filterValue: (r) => applicationNameAwareStatusLabel(r.status, r.application_master_status) ? "Application Owner" : (QA_PENDING_WITH[r.status] || ""),
            },
            {
              key: "qa_request",
              header: "QA Request",
              render: (r) => (r.qa_request ? r.qa_request.request_id : "—"),
              filterValue: (r) => (r.qa_request ? r.qa_request.request_id : ""),
            },
            {
              key: "created_at",
              header: "Created",
              render: (r) => new Date(r.created_at).toLocaleString(),
            },
            {
              key: "updated_at",
              header: "Updated",
              render: (r) => new Date(r.updated_at).toLocaleString(),
            },
          ]}
          rows={requests}
        />
      </Card>

      {selected && (
        <FunctionalDetail
          req={selected}
          users={users}
          onClose={() => setSelected(null)}
          onChanged={(updated) => {
            setSelected(updated);
            reload();
          }}
        />
      )}
    </div>
  );
}
