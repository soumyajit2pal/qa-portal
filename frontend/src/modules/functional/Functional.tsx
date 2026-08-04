import React, { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
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
  applicationNameAwareStatusLabel,
} from "../../components/Common";
import { ApplicationNameBanner } from "../../components/ApplicationNameBanner";
import MultiUserAssignSelect from "../../components/MultiUserAssignSelect";
import UserAssignSelect from "../../components/UserAssignSelect";
import ConfirmModal from "../../components/ConfirmModal";
import JiraActivity from "../../components/JiraActivity";
import {
  QA_STATUSES,
  QA_STATUS_LABELS,
  QA_PENDING_WITH,
  PRIORITIES,
  RISK_RATINGS,
  ENVIRONMENTS,
  CHANGE_TYPES,
  FUNCTIONAL_EDITABLE_STATUSES,
  hasRole,
  validTargetPromotionOptions,
  validEnvironmentPromotion,
  canManageReadinessEvidence,
  QA_DEPARTMENT,
} from "../../constants";
import {
  FunctionalOut,
  UserOut,
  ChecklistItemOut,
  WalkthroughOut,
  ApprovalActionOut,
  SignOffOut,
} from "../../types";
// Reused as-is from the Governance module -- the app is now a single
// consolidated Vite app (see README "Frontend architecture"), so importing
// across module folders is a plain relative import, no remote/federation
// boundary involved. Raising sign-off from a Functional Testing Request
// always means the certificate is FOR that request, so it's opened here
// with `presetRequest={req}` (locks the Testing Request ID picker instead
// of showing a search box -- see NewSignOffModal in SignOff.tsx).
import { NewSignOffModal } from "../governance/SignOff";

// Priority/Risk Rating are real columns on FunctionalRequest itself. Every
// other field here (Application Name, Epic Number, CR Number, Change Type,
// Deployment Environment, Target Promotion Environment, Release Version,
// Build Number, Target Release Date) is otherwise delegated (read-only) from
// the parent QA Request -- update_functional (backend) writes those straight
// through to the linked QA Request instead, since the QA Request gateway
// itself can no longer be edited once it's left Draft (see
// GATEWAY_EDITABLE_STATUSES) -- this is the only place left to fix one of
// them after that point. Application Name/Epic Number/CR Number identify
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
    epic_number: editing.epic_number || "",
    cr_number: editing.cr_number || "",
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
          Application Name, Epic Number and Change Request ID(s) are locked once
          this request has been raised -- only an Administrator can change them.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title">
            Identity{!isAdmin ? " (Admin-only)" : ""}
          </div>
          <div className="form-row">
            <Field label="Application Name">
              <input
                disabled={!isAdmin}
                value={form.application_name}
                onChange={(e) => set("application_name", e.target.value)}
              />
            </Field>
            <Field label="Epic Number">
              <input
                disabled={!isAdmin}
                value={form.epic_number}
                onChange={(e) => set("epic_number", e.target.value)}
              />
            </Field>
            <Field label="Change Request ID(s)">
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
                {ENVIRONMENTS.filter((e_) => e_ !== "Dev").map((o) => (
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
            {editing.checklist_items.map((c) => (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "5px 0",
                }}
              >
                <label style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={checkedItems.includes(c.item)}
                    onChange={() => toggleChecked(c.item)}
                  />
                  <span>
                    {c.item}{" "}
                    {c.owner && <span className="muted small">({c.owner})</span>}{" "}
                    {c.is_mandatory && <span className="badge badge-gray">Mandatory</span>}
                  </span>
                </label>
                {c.is_complete && (
                  <span className="badge badge-green">
                    QA verified
                  </span>
                )}
                <ChecklistEvidence apiBase="/api/functional-requests" reqId={editing.id} itemId={c.id}
                  canManage={canManageReadinessEvidence(editing.status)}
                  required={c.is_mandatory || c.requester_checked} />
              </div>
            ))}
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
  activeIndex,
  applicationOwnerPending,
}: {
  activeIndex: number;
  applicationOwnerPending?: boolean;
}) {
  const showAppOwnerStage = !!applicationOwnerPending && activeIndex === 1;
  const stages = showAppOwnerStage
    ? [LIFECYCLE_STAGES[0], "Application Owner", ...LIFECYCLE_STAGES.slice(1)]
    : LIFECYCLE_STAGES;
  const effectiveActiveIndex = showAppOwnerStage ? 1 : activeIndex;
  return (
    <div className="stepper" style={{ margin: "4px 0 18px" }}>
      {stages.map((label, i) => (
        <React.Fragment key={label}>
          <div className={`step ${i <= effectiveActiveIndex ? "filled" : ""}`}>
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
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughOut[]>([]);
  const [history, setHistory] = useState<ApprovalActionOut[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [comments, setComments] = useState("");
  const [selectedQALead, setSelectedQALead] = useState("");
  const [selectedTesters, setSelectedTesters] = useState<string[]>([]);
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

  const load = useCallback(async () => {
    try {
      const [cl, wt, hist] = await Promise.all([
        api.get<ChecklistItemOut[]>(
          `/api/functional-requests/${req.id}/checklist`
        ),
        api.get<WalkthroughOut[]>(
          `/api/functional-requests/${req.id}/walkthroughs`
        ),
        api.get<ApprovalActionOut[]>(
          `/api/functional-requests/${req.id}/history`
        ),
      ]);
      setChecklist(cl);
      setWalkthroughs(wt);
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

  // After an SM approves/rejects this request's Application Name (see
  // ApplicationNameBanner below) -- refetches this request specifically
  // (not a whole separate endpoint) since that's the only thing that
  // changed; application_master_status flips away from PENDING and the
  // banner then hides itself on its own.
  async function reloadAfterApplicationNameDecision() {
    const fresh = await api.get<FunctionalOut>(
      `/api/functional-requests/${req.id}`
    );
    onChanged(fresh);
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
    u.is_active && u.department === QA_DEPARTMENT && (u.roles || []).includes("QA_LEAD")
  );
  const testers = users.filter((u) =>
    u.is_active && u.department === QA_DEPARTMENT && (u.roles || []).includes("QA_ENGINEER")
  );

  const isAdmin = hasRole(user, "ADMIN");
  const isRequester = req.requester_id === user?.id || isAdmin;
  const isRequesterVerifier = isRequester || hasRole(user, "APPLICATION_OWNER");

  const status = req.status;
  const sameDept = !!user?.department && user.department === req.department;
  const isQALead = hasRole(user, "QA_LEAD");
  const isAssignedQALead = isAdmin || (isQALead && req.qa_lead_id === user?.id);
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
  // Reported directly: the SM's own block message used to always say "your
  // decision above" even while the name was still sitting with the
  // Application Owner (i.e. not the SM's turn at all yet, and no "decision
  // above" for them to make since the banner only renders for whoever owns
  // the CURRENT tier) -- misleading. Tier-aware instead: names the actual
  // holdup and who owns it.
  const smApplicationNameBlockedMessage =
    req.application_master_status === "PENDING_APP_OWNER"
      ? "This request's Application Name is still pending Application Owner approval -- it needs to be decided there before you can approve this request."
      : req.application_master_status === "REJECTED"
      ? "This request's Application Name was rejected -- the requester needs to pick a different name before this request can be approved."
      : "Application Name is still pending your decision above -- decide it before approving this request.";
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
  const canStartReadiness =
    isAssignedQALead && status === "QA_LEAD_ASSIGNED";
  const canReadinessDecide =
    isAssignedQALead && status === "READINESS_VERIFICATION";
  const canBeginPlanning =
    isAssignedQALead && status === "QA_ACTIVITY_INITIATED";
  const canAssignTester = isAssignedQALead && status === "PLANNING";
  const canStartTestDesign =
    isAssignedTester && status === "TESTER_ASSIGNED";
  const canStartExecution =
    isAssignedTester && status === "TEST_DESIGN";
  const canRaiseDefect =
    isAssignedTester &&
    status === "EXECUTION_IN_PROGRESS";
  const canMarkWaitingForFix =
    isAssignedTester && status === "DEFECT_RAISED";
  const canStartRetest =
    isAssignedTester && status === "WAITING_FOR_FIX";
  const canCompleteQA =
    isAssignedTester &&
    ["EXECUTION_IN_PROGRESS", "RETESTING"].includes(
      status
    );
  // Matches the backend's own role gate on POST /{id}/request-signoff and
  // POST /api/signoffs (both require_roles(Role.QA_LEAD, Role.QA_ENGINEER))
  // -- whichever of them actually ran QA through to completion should be
  // able to raise the certificate, not just the QA Lead.
  const canRequestSignoff =
    isAssignedTester &&
    (hasRole(user, "ADMIN") || user?.department === QA_DEPARTMENT) &&
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
        {["overview", "checklist", "walkthroughs", "documents", "history"].map(
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
            activeIndex={lifecycleStageIndex(req.status)}
            applicationOwnerPending={req.application_master_status === "PENDING_APP_OWNER"}
          />

          {(sameDept || isAdmin) && (
            <ApplicationNameBanner
              applicationMasterId={req.application_master_id}
              applicationMasterStatus={req.application_master_status}
              applicationName={req.application_name}
              onDecided={reloadAfterApplicationNameDecision}
            />
          )}

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
                  Pending Application Owner Approval
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
            <DetailField label="Epic Number">
              {req.epic_number || "—"}
            </DetailField>
            <DetailField label="Change Request ID(s)">
              {req.cr_number || "—"}
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
            <DetailField label="Assigned QA Lead">
              {userName(users, req.qa_lead_id) || "Not assigned"}
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

          {req.qa_request && (
            <p className="muted small">
              Raised alongside QA Request{" "}
              <strong>{req.qa_request.request_id}</strong> — see that request
              for supporting documents and any other linked
              SAST/DAST/Performance requests.
            </p>
          )}

          <div className="section-title">Workflow Actions</div>
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
                  signBlocked={applicationNameBlocking}
                  signBlockedMessage={smApplicationNameBlockedMessage}
                  onApprove={(signed) =>
                    act("sm-decision", {
                      decision: "Approved",
                      comments: signed,
                    })
                  }
                  onReturn={() =>
                    act("sm-decision", { decision: "Returned", comments })
                  }
                  onReject={() =>
                    act("sm-decision", { decision: "Rejected", comments })
                  }
                />
              )}

              {canDepartmentHeadDecide && (
                <ApprovalDecisionButtons
                  userName={user?.full_name}
                  comments={comments}
                  busy={!!busyAction}
                  signBlocked={applicationNameBlocking}
                  signBlockedMessage="This request's Application Name is not yet approved by SM."
                  extraControlLabel="Assign IT-QA QA Lead"
                  extraControl={
                    <UserAssignSelect
                      value={selectedQALead}
                      onChange={setSelectedQALead}
                      users={qaLeads}
                      placeholder="Select QA Lead..."
                      disabled={!!busyAction}
                      style={{ minWidth: 260 }}
                    />
                  }
                  extraReady={!!selectedQALead}
                  onApprove={(signed) =>
                    act("department-head-decision", {
                      decision: "Approved",
                      comments: signed,
                      qa_lead_id: Number(selectedQALead),
                    })
                  }
                  onReturn={() =>
                    act("department-head-decision", {
                      decision: "Returned",
                      comments,
                    })
                  }
                  onReject={() =>
                    act("department-head-decision", {
                      decision: "Rejected",
                      comments,
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
                    placeholder="Assign Tester(s)..."
                    disabled={!!busyAction}
                    style={{ minWidth: 260 }}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={selectedTesters.length === 0 || !!busyAction}
                    onClick={() =>
                      act("assign-tester", {
                        tester_ids: selectedTesters.map(Number),
                      })
                    }
                  >
                    Assign Tester(s)
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
                  onClick={() => act("start-execution")}
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
            {(canSMDecide ||
              canDepartmentHeadDecide ||
              canReadinessDecide ||
              canRaiseDefect ||
              canMarkWaitingForFix ||
              canStartRetest ||
              canCompleteQA ||
              canRequesterDecide) && (
              <input
                placeholder="Action note (optional — attached to the next workflow action)"
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                style={{
                  marginTop: 8,
                  width: "100%",
                  padding: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                }}
              />
            )}
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
                canManage={canManageReadinessEvidence(req.status)}
                required={c.is_mandatory || c.requester_checked} />
            </div>
          ))}
        </div>
      )}

      {tab === "walkthroughs" && (
        <div>
          <Table
            rowKey="id"
            columns={[
              {
                key: "session_date",
                header: "Date",
                render: (r) => new Date(r.session_date).toLocaleString(),
              },
              { key: "conducted_by", header: "Conducted By" },
              { key: "participants", header: "Participants" },
              {
                key: "qa_acknowledged_at",
                header: "QA Acknowledged",
                render: (r) => (r.qa_acknowledged_at ? "Yes" : "No"),
                filterValue: (r) => (r.qa_acknowledged_at ? "Yes" : "No"),
              },
            ]}
            rows={walkthroughs}
          />
          <AddWalkthrough reqId={req.id} onAdded={load} />
        </div>
      )}

      {tab === "history" && (
        <JiraActivity entityType="FUNCTIONAL_REQUEST" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      {tab === "documents" && (
        <RequestDocuments apiBase="/api/functional-requests" reqId={req.id} />
      )}

      <ErrorText
        error={readinessPassError}
        title="Readiness cannot be passed"
        guidance="Review the Readiness Checklist, complete the listed verification items, and then try “Readiness Passed” again."
      />
    </Modal>
  );
}

function AddWalkthrough({
  reqId,
  onAdded,
}: {
  reqId: number;
  onAdded: () => void;
}) {
  const [conducted_by, setConductedBy] = useState("");
  const [participants, setParticipants] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/functional-requests/${reqId}/walkthroughs`, {
        conducted_by,
        participants,
        notes,
      });
      setConductedBy("");
      setParticipants("");
      setNotes("");
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}
    >
      <input
        placeholder="Conducted by"
        value={conducted_by}
        onChange={(e) => setConductedBy(e.target.value)}
      />
      <input
        placeholder="Participants"
        value={participants}
        onChange={(e) => setParticipants(e.target.value)}
      />
      <input
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button className="btn btn-sm" disabled={busy}>
        Log Walkthrough Session
      </button>
    </form>
  );
}

export default function Functional() {
  const [requests, setRequests] = useState<FunctionalOut[]>([]);
  const [users, setUsers] = useState<UserOut[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<FunctionalOut | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    try {
      const [reqs, us] = await Promise.all([
        api.get<FunctionalOut[]>("/api/functional-requests"),
        api.get<UserOut[]>("/api/auth/users"),
      ]);
      setRequests(
        statusFilter ? reqs.filter((r) => r.status === statusFilter) : reqs
      );
      setUsers(us);
    } catch (err) {
      setError(err);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

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
    if (match) setSelected(match);
    setSearchParams(
      (p) => {
        p.delete("open");
        return p;
      },
      { replace: true }
    );
  }, [requests, searchParams, setSearchParams]);

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Functional QA Requests"
        count={requests.length}
        subtitle="Combined Functional Testing, Regression Testing, Sanity Testing and UAT Support workflow --
                   raised via a QA Request (include any of these in its request types), then tracked here
                   through Department Head approval, readiness verification, execution and sign-off."
      />
      <div className="toolbar">
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
      </div>

      <Card>
        <Table
          rowKey="id"
          onRowClick={(r) => setSelected(r)}
          columns={[
            { key: "request_id", header: "Request ID" },
            {
              key: "application_name",
              header: "Application",
              render: (r) => r.application_name || "—",
            },
            {
              key: "epic_number",
              header: "Epic Number",
              render: (r) => r.epic_number || "—",
            },
            {
              key: "requester_id",
              header: "Requester",
              render: (r) => userName(users, r.requester_id) || "—",
              filterValue: (r) => userName(users, r.requester_id) || "",
            },
            {
              key: "qa_lead_id",
              header: "Assigned QA Lead",
              render: (r) => userName(users, r.qa_lead_id) || "Not assigned",
              filterValue: (r) => userName(users, r.qa_lead_id) || "",
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
            load();
          }}
        />
      )}
    </div>
  );
}
