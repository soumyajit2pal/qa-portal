import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { Link, useNavigate } from "react-router-dom";
import {
  Badge,
  DetailField,
  DetailSection,
  ErrorText,
  Modal,
  Table,
  applicationNameAwareStatusLabel,
} from "../components/Common";
import InfoModal from "../components/InfoModal";
import { ApplicationNameBanner } from "../components/ApplicationNameBanner";
import {
  GATEWAY_CANCELLABLE_STATUSES,
  GATEWAY_EDITABLE_STATUSES,
  GATEWAY_STATUS_LABELS,
  hasRole,
} from "../constants";
import { useChecklistTemplate } from "./steps/useChecklistTemplate";
import {
  QARequestOut,
  UserOut,
  QARequestDocumentOut,
  DraftChecklistEvidenceOut,
  ApprovalActionOut,
} from "../types";
import { GatewayPreview, gatewayStageIndex } from "./GatewayPreview";
import { classificationSummary, linkedSections, userName } from "./format";
import { NewRequestModal } from "./NewRequestModal";
import { AddDocuments } from "./AddDocuments";
import JiraActivity from "../components/JiraActivity";
import ConfirmModal from "../components/ConfirmModal";

interface RequestDetailProps {
  req: QARequestOut;
  onClose: () => void;
  onChanged: (req: QARequestOut) => void;
  users: UserOut[];
}

// The "view an existing QA Request" modal -- Overview / Documents / History
// tabs, plus the gateway-level actions (Submit, Cancel, Edit) and the "Edit
// Request" wizard (reuses NewRequestModal in its `editing` mode).
export function RequestDetail({
  req,
  onClose,
  onChanged,
  users,
}: RequestDetailProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState("overview");
  const [documents, setDocuments] = useState<QARequestDocumentOut[]>([]);
  const [history, setHistory] = useState<ApprovalActionOut[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editingReq, setEditingReq] = useState(false);
  // Evidence-document count per draft checklist item, keyed "<kind>:<index>"
  // -- used only to build a heads-up prompt at Submit/Raise time (see
  // handleSubmitClick below). Evidence is no longer mandatory (Raise/Submit
  // is never blocked on it), but it's still useful to nudge the requester
  // upfront -- at request-creation time -- about which readiness checklist
  // item(s) have no evidence attached yet, rather than a QA Lead discovering
  // that gap much later at Readiness Verification.
  const [draftEvidenceCounts, setDraftEvidenceCounts] = useState<Record<string, number>>({});
  // Set when Submit/Raise is clicked and at least one checklist item still
  // has no evidence attached -- shows the informational pop-up below instead
  // of submitting immediately. Confirming from that pop-up proceeds anyway.
  const [confirmSubmitNoEvidence, setConfirmSubmitNoEvidence] = useState(false);
  // Shown after saving edits to a request that's still sitting in Draft --
  // same "nothing has actually been submitted yet" reminder as the one shown
  // right after creating a brand-new request (see ./index.tsx).
  const [draftNotice, setDraftNotice] = useState(false);
  // Shown right after "Submit / Raise" succeeds -- holds the just-raised
  // request so its linked_*_requests can be read to tell the person exactly
  // which section(s) to go review/submit next (see format.ts::linkedSections).
  const [raisedNotice, setRaisedNotice] = useState<QARequestOut | null>(null);
  const [pendingDeleteDoc, setPendingDeleteDoc] = useState<QARequestDocumentOut | null>(null);
  const [deleteDocBusy, setDeleteDocBusy] = useState(false);
  // Cancelling is destructive/irreversible (see GATEWAY_TERMINAL_STATUSES --
  // Cancelled has no way back), so it's now gated behind a confirmation
  // pop-up instead of firing straight off the button click.
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Set when an Application Owner/SM's decision on this request's
  // Application Name (see ApplicationNameBanner below) succeeds but the
  // follow-up reload can't -- typically because rejecting a brand-new name
  // at the Application Owner tier reverts this gateway straight back to
  // Draft (see routers/applications.py::decide_app_owner_name), which is
  // requester/admin-only, so the reviewer who just rejected it loses the
  // ability to even view it again. Holds the message to show; dismissing it
  // closes this whole modal too, since there's nothing left here for that
  // viewer to look at.
  const [appNameDecisionNotice, setAppNameDecisionNotice] = useState<string | null>(null);

  // Every readiness checklist is Admin-configurable now (see
  // backend checklist_config.py) -- fetched live instead of the old
  // hardcoded constants.ts lists, same as the wizard steps themselves (see
  // steps/useChecklistTemplate.ts).
  const { items: functionalChecklist } = useChecklistTemplate("FUNCTIONAL");
  const { items: sastChecklist } = useChecklistTemplate("SAST");
  const { items: dastChecklist } = useChecklistTemplate("DAST");
  const { items: performanceChecklist } = useChecklistTemplate("PERFORMANCE");

  const load = useCallback(async () => {
    try {
      const [docs, hist] = await Promise.all([
        api.get<QARequestDocumentOut[]>(`/api/qa-requests/${req.id}/documents`),
        api.get<ApprovalActionOut[]>(`/api/qa-requests/${req.id}/history`),
      ]);
      setDocuments(docs);
      setHistory(hist);
    } catch (err) {
      setError(err);
    }
  }, [req.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Pulled out as its own callback (rather than only living inline inside a
  // useEffect) so it can also be re-run on demand -- specifically whenever
  // the "Edit Request" wizard closes below, since ChecklistEvidencePicker
  // uploads/deletes evidence immediately against the backend as soon as the
  // requester clicks Attach/Remove, independent of whether they ever click
  // the wizard's own Save. Without an explicit re-run there, this component
  // has no way to know evidence changed -- its dependency array (req.id/
  // status/request_types) doesn't change just because a file was attached,
  // so the Submit/Raise heads-up prompt would stay stuck at whatever it read
  // on first load until a full page reload remounted this component.
  const loadDraftEvidenceCounts = useCallback(async () => {
    if (req.status !== "DRAFT") {
      setDraftEvidenceCounts({});
      return;
    }
    // One batched call instead of one GET per checklist item (reported
    // directly, twice: this used to loop sequentially -- awaited one at a
    // time, not even in parallel -- over every mandatory/checked item across
    // every selected module just to get a per-item file count). Same
    // endpoint NewRequestModal.tsx's own loadSavedEvidence uses; grouped
    // into counts here since that's all this component needs.
    try {
      const rows = await api.get<DraftChecklistEvidenceOut[]>(
        `/api/qa-requests/${req.id}/checklist-evidence/documents`
      );
      const counts: Record<string, number> = {};
      for (const row of rows) {
        const key = `${row.kind}:${row.item_index}`;
        counts[key] = (counts[key] || 0) + 1;
      }
      setDraftEvidenceCounts(counts);
    } catch {
      setDraftEvidenceCounts({});
    }
  }, [req.id, req.status]);

  useEffect(() => {
    loadDraftEvidenceCounts();
  }, [loadDraftEvidenceCounts]);

  async function act(action: string) {
    setError(null);
    setBusyAction(action);
    try {
      const updated = await api.post<QARequestOut>(
        `/api/qa-requests/${req.id}/${action}`,
        {}
      );
      onChanged(updated);
      load();
      if (action === "submit") setRaisedNotice(updated);
    } catch (err) {
      setError(err);
    } finally {
      setBusyAction(null);
    }
  }

  const isAdmin = hasRole(user, "ADMIN");
  const isRequester = req.requester_id === user?.id || isAdmin;
  const status = req.status;
  // Reported directly: "Request Raised with new application name... it must
  // be at master request level, not on individual request level of childs."
  // The App Owner/SM decision banner (ApplicationNameBanner) used to only
  // ever render on the linked Functional/SAST/DAST/Performance request's own
  // page -- moved here instead, the one master QA Request gateway page,
  // since application_master_id/status already live on this same QARequestOut
  // and the decision endpoints (routers/applications.py) key off the
  // ApplicationMaster row directly, not off any specific child request --
  // nothing backend-side needed to change. Same same-department gate every
  // other approval checkpoint in the app uses.
  const sameDept = !!user?.department && user.department === req.department;

  // After an Application Owner/SM approves or rejects this request's
  // Application Name (see ApplicationNameBanner below), refetch this
  // specific request so application_master_status moves on
  // (PENDING_APP_OWNER -> PENDING_SM -> APPROVED, or -> REJECTED) and the
  // rest of this modal (status badges, Application Name field, etc.) picks
  // that up. Reported directly (twice): this used to throw straight into
  // the banner's own try/catch whenever it failed, showing a confusing raw
  // "Action could not be completed" error even though the decision itself
  // had already succeeded -- and since nothing here ever updated `req`, the
  // banner kept re-rendering with its stale pre-decision props, buttons
  // re-enabled, letting the same reviewer click Approve/Reject again and
  // again.
  //
  // Rejecting a brand-new name at the Application Owner tier reverts the
  // gateway straight back to Draft (see routers/applications.py::
  // decide_app_owner_name / section 173) -- Draft is requester/admin-only
  // (_can_view_gateway) -- so this reload is GUARANTEED to fail for any
  // reviewer who isn't also the requester or an admin. Rather than firing
  // it anyway and reacting to the predictable 403 after the fact (a round
  // trip that also left a window for the stale-banner bug above), that
  // specific case is detected up front from what's already known locally
  // (this decision + the gateway's own tier just before the call) and
  // skips the network call entirely -- deterministic, and the notice below
  // shows immediately instead of waiting on a request that was never going
  // to succeed.
  async function reloadAfterApplicationNameDecision(decision: "Approved" | "Rejected") {
    const wasAppOwnerTier = req.application_master_status === "PENDING_APP_OWNER";
    if (decision === "Rejected" && wasAppOwnerTier && !isRequester && !isAdmin) {
      setAppNameDecisionNotice(
        "Application Name rejected. Since no linked request had been generated yet for this QA Request, it has been returned to the requester as a Draft and is no longer visible to you here."
      );
      return;
    }
    try {
      // Refresh Activity together with the gateway record. The decision API
      // writes its ApprovalAction before returning, but this drawer's
      // `history` state previously stayed on the pre-decision snapshot until
      // the user closed/reopened it or reloaded the page.
      const [fresh, freshHistory] = await Promise.all([
        api.get<QARequestOut>(`/api/qa-requests/${req.id}`),
        api.get<ApprovalActionOut[]>(`/api/qa-requests/${req.id}/history`),
      ]);
      setHistory(freshHistory);
      onChanged(fresh);
    } catch (err) {
      // Fallback for any other way this reload could fail (e.g. someone
      // else cancelled the request in the meantime) -- same message pattern,
      // still never leaks the raw backend error into a blocking pop-up.
      setAppNameDecisionNotice(
        decision === "Rejected"
          ? "Application Name rejected. This request is no longer visible to you here."
          : "Application Name decision recorded, but this request is no longer visible to you here."
      );
    }
  }

  // Reported directly (again, after sections 175/177): the Approve/Reject
  // buttons could still be showing after a click. The one remaining gap
  // (see ApplicationNameBanner.tsx's own onRefresh docstring): if the
  // decision POST itself failed -- most commonly because someone else in
  // the same department had already decided this exact name a moment
  // earlier, so the backend correctly 400s a second attempt -- the banner's
  // local `decided` state never gets set, and it kept showing the same
  // now-stale buttons with nothing to make them go away short of manually
  // closing and reopening the drawer. Unlike reloadAfterApplicationNameDecision
  // above, this makes no assumption a decision succeeded (so it must never
  // show the "rejected, returned to requester" notice) -- it's a plain,
  // silent best-effort resync: pick up whatever the real current state is,
  // and if this reviewer can no longer even view it (e.g. it turned out to
  // already be Draft), just leave the existing error dialog as the
  // explanation and do nothing further.
  function silentRefreshRequest() {
    api.get<QARequestOut>(`/api/qa-requests/${req.id}`).then(onChanged).catch(() => {});
  }

  // Mirrors the backend's own gate on POST .../submit (see routers/
  // qa_requests.py::submit_request) -- surfaced here too so the requester
  // sees exactly what's missing before even clicking the button, instead of
  // only finding out from the error after the fact. Covers all four request
  // types now -- each checklist's own mandatory items (Admin-configurable,
  // see checklist_config.py) block Raise the same way.
  const requestTypeList = (req.request_types || "")
    .split(",")
    .map((t) => t.trim());

  const pendingMandatory: string[] = [];

  if (requestTypeList.includes("Functional Testing")) {
    const checkedSet = new Set(req.draft_checked_items || []);
    pendingMandatory.push(
      ...functionalChecklist.filter(
        (c) => c.is_mandatory && !checkedSet.has(c.item)
      ).map((c) => c.item)
    );
  }

  if (requestTypeList.includes("SAST")) {
    const checkedSet = new Set(req.draft_sast_checked_items || []);
    pendingMandatory.push(
      ...sastChecklist.filter(
        (c) => c.is_mandatory && !checkedSet.has(c.item)
      ).map((c) => c.item)
    );
  }
  if (requestTypeList.includes("DAST")) {
    const checkedSet = new Set(req.draft_dast_checked_items || []);
    pendingMandatory.push(
      ...dastChecklist.filter(
        (c) => c.is_mandatory && !checkedSet.has(c.item)
      ).map((c) => c.item)
    );
  }
  if (requestTypeList.includes("Performance Testing")) {
    const checkedSet = new Set(req.draft_performance_checked_items || []);
    pendingMandatory.push(
      ...performanceChecklist.filter(
        (c) => c.is_mandatory && !checkedSet.has(c.item)
      ).map((c) => c.item)
    );
  }

  // Informational only -- evidence is never itself required to Submit/Raise
  // (see handleSubmitClick below; being self-declared ready IS required for
  // a mandatory item, on any of the four modules -- see pendingMandatory
  // above). Still worth flagging upfront which readiness checklist item(s)
  // have nothing attached yet, since it's easier for the requester to add it
  // now, while everything's fresh, than to be asked for it later during
  // Readiness Verification. Applies to all 4 request types.
  const itemsWithoutEvidence: string[] = [];

  if (requestTypeList.includes("Functional Testing")) {
    const checkedSet = new Set(req.draft_checked_items || []);
    functionalChecklist.forEach((c, index) => {
      if (
        (c.is_mandatory || checkedSet.has(c.item)) &&
        (draftEvidenceCounts[`functional:${index}`] ?? 0) === 0
      ) {
        itemsWithoutEvidence.push(c.item);
      }
    });
  }
  if (requestTypeList.includes("SAST")) {
    const checkedSet = new Set(req.draft_sast_checked_items || []);
    sastChecklist.forEach((c, index) => {
      if (
        (c.is_mandatory || checkedSet.has(c.item)) &&
        (draftEvidenceCounts[`sast:${index}`] ?? 0) === 0
      ) {
        itemsWithoutEvidence.push(c.item);
      }
    });
  }
  if (requestTypeList.includes("DAST")) {
    const checkedSet = new Set(req.draft_dast_checked_items || []);
    dastChecklist.forEach((c, index) => {
      if (
        (c.is_mandatory || checkedSet.has(c.item)) &&
        (draftEvidenceCounts[`dast:${index}`] ?? 0) === 0
      ) {
        itemsWithoutEvidence.push(c.item);
      }
    });
  }
  if (requestTypeList.includes("Performance Testing")) {
    const checkedSet = new Set(req.draft_performance_checked_items || []);
    performanceChecklist.forEach((c, index) => {
      if (
        (c.is_mandatory || checkedSet.has(c.item)) &&
        (draftEvidenceCounts[`performance:${index}`] ?? 0) === 0
      ) {
        itemsWithoutEvidence.push(c.item);
      }
    });
  }

  // Submit/Raise itself is never blocked on evidence -- if some checklist
  // item(s) have nothing attached, show a one-time heads-up (ConfirmModal
  // below) instead of submitting immediately; "Raise Anyway" proceeds,
  // "Go Back" just closes the pop-up so the requester can attach evidence
  // first if they want to.
  function handleSubmitClick() {
    if (itemsWithoutEvidence.length > 0) {
      setConfirmSubmitNoEvidence(true);
    } else {
      act("submit");
    }
  }

  // Reported directly: a "sibling" gateway that resolved to the exact same
  // brand-new Application Name as a DIFFERENT request could still be raised
  // clean even after that name was rejected -- application_master_status is
  // a live property (see models.QARequest), so this reads REJECTED here
  // immediately once any Application Owner/SM rejects the shared name,
  // without this request itself needing to be touched. Mirrors the new
  // backend gate in routers/qa_requests.py::submit_request -- blocked here
  // too so the requester sees why up front instead of only after clicking
  // Submit and getting a 400.
  const applicationNameRejected = req.application_master_status === "REJECTED";
  const canSubmit = isRequester && status === "DRAFT";
  // Mirrors backend GATEWAY_CANCELLABLE_STATUSES -- the gateway can only be
  // cancelled while still Draft (i.e. before it's ever been raised).
  const canCancel =
    isRequester && GATEWAY_CANCELLABLE_STATUSES.includes(status);
  // Mirrors backend GATEWAY_EDITABLE_STATUSES.
  const canEditRequest =
    isRequester && GATEWAY_EDITABLE_STATUSES.includes(status);

  const hasLinked =
    req.linked_functional_requests?.length > 0 ||
    req.linked_sast_requests?.length > 0 ||
    req.linked_dast_requests?.length > 0 ||
    req.linked_performance_requests?.length > 0;

  // One row per linked request across all four request types, feeding the
  // "Linked Requests" table below. `path` is that type's own module page --
  // clicking a row closes this gateway modal and navigates there with
  // `?open=<request_id>` so the module page can auto-open that specific
  // request's own detail view (see Functional.tsx/SAST.tsx/DAST.tsx/
  // Performance.tsx's matching `useSearchParams`-based deep-link effect).
  interface LinkedRow {
    key: string;
    type: string;
    request_id: string;
    status?: string | null;
    path: string;
  }
  const linkedRows: LinkedRow[] = [
    ...(req.linked_functional_requests || []).map((f) => ({
      key: `func-${f.id}`,
      type: "Functional QA",
      request_id: f.request_id,
      status: f.status,
      path: "/functional-requests",
    })),
    ...(req.linked_sast_requests || []).map((s) => ({
      key: `sast-${s.id}`,
      type: "SAST",
      request_id: s.request_id,
      status: s.status,
      path: "/sast",
    })),
    ...(req.linked_dast_requests || []).map((d) => ({
      key: `dast-${d.id}`,
      type: "DAST",
      request_id: d.request_id,
      status: d.status,
      path: "/dast",
    })),
    ...(req.linked_performance_requests || []).map((p) => ({
      key: `perf-${p.id}`,
      type: "Performance",
      request_id: p.request_id,
      status: p.status,
      path: "/performance",
    })),
  ];

  function openLinked(row: LinkedRow) {
    onClose();
    navigate(`${row.path}?open=${encodeURIComponent(row.request_id)}`);
  }

  // request_id is only assigned once this gateway is actually raised (a
  // still-Draft request has none yet -- see the backend's matching column
  // comment on models.QARequest.request_id).
  const displayId = req.request_id || `Draft #${req.id}`;

  return (
    <Modal
      title={`${displayId} — ${req.application_name}`}
      onClose={onClose}
      wide
    >
      <div className="tabs">
        {["overview", "documents", "history"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t === "history" ? "Activity" : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === "overview" && (
        <div>
          <GatewayPreview activeIndex={gatewayStageIndex(req.status)} />

          {/* Gated on status !== "DRAFT" -- application_master_id/status get
              set on the ApplicationMaster row the moment a brand-new "Other"
              name is typed (see _resolve_application_name's own docstring: it
              runs on every create/edit, not just Submit/Raise), so without
              this gate an Application Owner could approve/reject a name
              before the requester has even raised the request -- while it's
              still a private, freely-editable Draft nobody else should be
              acting on yet. Once raised, this is the only place the name's
              own Approve/Reject decision is made (see the comment on the
              badges below for why it moved here from each linked child
              request's own page). */}
          {(sameDept || isAdmin) && req.status !== "DRAFT" && (
            <ApplicationNameBanner
              applicationMasterId={req.application_master_id}
              applicationMasterStatus={req.application_master_status}
              applicationName={req.application_name}
              onDecided={reloadAfterApplicationNameDecision}
              onRefresh={silentRefreshRequest}
            />
          )}

          <DetailSection title="Status">
            <DetailField label="Status">
              <Badge status={req.status} />
            </DetailField>
            <DetailField label="Priority / Risk (per type)">
              {classificationSummary(req)}
            </DetailField>
            <DetailField label="Request Type(s)">
              {req.request_types || "—"}
              {req.request_type_other ? ` (${req.request_type_other})` : ""}
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
              {/* PENDING_APP_OWNER/PENDING_SM get set on the ApplicationMaster
                  row the moment a brand-new "Other" name is typed -- even
                  while this gateway is still sitting in Draft (see
                  _resolve_application_name's own docstring: it runs on every
                  create/edit, not just Submit/Raise). Reported directly:
                  "Request Raised with new application name... it must be at
                  master request level, not on individual request level of
                  childs" -- the actual App Owner/SM decision banner
                  (ApplicationNameBanner, above) now lives on this one master
                  QA Request page instead of being duplicated across every
                  linked Functional/SAST/DAST/Performance request's own page.
                  It's also still gated to status !== "DRAFT" (see the banner
                  above), same reasoning as this badge: showing "Pending ...
                  Approval" while still Draft would wrongly imply the name is
                  already under active review, when nothing can act on it yet
                  -- softened to a neutral, accurate note for that case; the
                  real "Pending" badges only show once raised. REJECTED is
                  left as-is regardless of Draft status: unlike "Pending",
                  it's immediately actionable information (pick a different
                  name) even before raising, and can genuinely apply to a
                  still-open Draft if another request sharing the same name
                  gets it rejected in the meantime. */}
              {req.status === "DRAFT" &&
                (req.application_master_status === "PENDING_APP_OWNER" ||
                  req.application_master_status === "PENDING_SM") && (
                  <span className="badge badge-gray" style={{ marginLeft: 8 }}>
                    New name — enters approval once raised
                  </span>
                )}
              {req.status !== "DRAFT" &&
                req.application_master_status === "PENDING_APP_OWNER" && (
                  <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                    Application Owner Approval Pending
                  </span>
                )}
              {req.status !== "DRAFT" &&
                req.application_master_status === "PENDING_SM" && (
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
            <DetailField label="Department">
              {req.department || "—"}
            </DetailField>
            <DetailField label="Change Request ID(s)">
              {req.cr_number || "—"}
            </DetailField>
            <DetailField label="Epic Number">
              {req.epic_number || "—"}
            </DetailField>
            <DetailField label="Change Type">
              {req.change_type || "—"}
            </DetailField>
            <DetailField label="Vendor / SI Partner">
              {req.vendor_si_partner || "—"}
            </DetailField>
            <DetailField label="Technology Stack">
              {req.technology_stack || "—"}
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
          </DetailSection>

          {hasLinked && (
            <div style={{ marginTop: 8 }}>
              <div className="section-title">Linked Requests</div>
              <Table
                rowKey="key"
                onRowClick={openLinked}
                columns={[
                  { key: "type", header: "Request Type" },
                  { key: "request_id", header: "Request Id" },
                  {
                    key: "status",
                    header: "Current Status",
                    // Every row here is one of THIS gateway's own linked
                    // children, so they all share this same gateway's
                    // application_master_status (each delegates it from
                    // `self.qa_request.application_master_status` on the
                    // backend) -- no need for a per-row value.
                    render: (r) => <Badge status={r.status} label={applicationNameAwareStatusLabel(r.status, req.application_master_status)} />,
                  },
                ]}
                rows={linkedRows}
              />
            </div>
          )}
          {status === "DRAFT" && (
            <p className="muted small">
              Submitting will raise whichever linked request(s) your selected
              types call for — nothing shows here until then.
            </p>
          )}
          {canSubmit && applicationNameRejected && (
            <div
              style={{
                marginTop: 8,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: 10,
                padding: "10px 14px",
                color: "#991b1b",
                fontSize: 13,
              }}
            >
              <strong>Cannot Submit / Raise</strong> — the Application Name{" "}
              <strong>{req.application_name || "—"}</strong> was rejected.
              Edit this request and either choose a different Application
              Name, or re-select/re-type this same name to resubmit it for
              fresh approval, before raising.
            </div>
          )}
          {canSubmit && !applicationNameRejected && pendingMandatory.length > 0 && (
            <div
              style={{
                marginTop: 8,
                background: "#fffaeb",
                border: "1px solid #fde68a",
                borderRadius: 10,
                padding: "10px 14px",
                color: "#92400e",
                fontSize: 13,
              }}
            >
              <strong>Cannot Submit / Raise yet</strong> — the following
              mandatory Readiness checklist item(s) must be self-declared ready
              first (Edit Request):
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {pendingMandatory.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {req.remarks && (
            <p>
              <strong>Remarks:</strong> {req.remarks}
            </p>
          )}

          <div className="actions-panel">
            <div className="section-title" style={{ marginTop: 0 }}>
              Gateway Actions
            </div>
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
                    `/api/qa-requests/${req.id}/export`,
                    `${displayId}.pdf`
                  )
                }
              >
                Export PDF
              </button>
              {canEditRequest && (
                <button
                  className="btn btn-sm"
                  disabled={!!busyAction}
                  onClick={() => setEditingReq(true)}
                >
                  Edit Request
                </button>
              )}
              {canSubmit && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!busyAction || applicationNameRejected || pendingMandatory.length > 0}
                  title={
                    applicationNameRejected
                      ? "This request's Application Name was rejected -- edit the request first"
                      : pendingMandatory.length > 0
                      ? "Complete the mandatory checklist item(s) below first"
                      : undefined
                  }
                  onClick={handleSubmitClick}
                >
                  Submit / Raise
                </button>
              )}
              {canCancel && (
                <button
                  className="btn btn-danger btn-sm"
                  disabled={!!busyAction}
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel Request
                </button>
              )}
              {!canEditRequest && !canSubmit && !canCancel && (
                <span className="muted small">
                  No gateway actions available — this request has been{" "}
                  {(GATEWAY_STATUS_LABELS[status] || status).toLowerCase()}.
                  {status === "SUBMITTED" &&
                    " Its Application Name is a brand-new entry awaiting Application Owner approval (see above) — no linked request has been generated yet."}
                  {hasLinked &&
                    " Manage progress on each linked request's own page from here."}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "documents" && (
        <div>
          <Table
            rowKey="id"
            columns={[
              { key: "file_name", header: "File" },
              {
                key: "file_size",
                header: "Size",
                render: (d) =>
                  d.file_size ? `${(d.file_size / 1024).toFixed(1)} KB` : "—",
              },
              {
                key: "uploaded_at",
                header: "Uploaded",
                render: (d) => new Date(d.uploaded_at).toLocaleString(),
              },
              {
                key: "actions",
                header: "",
                filterable: false,
                render: (d) => (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        api.downloadFile(
                          `/api/qa-requests/${req.id}/documents/${d.id}/download`,
                          d.file_name
                        )
                      }
                    >
                      Download
                    </button>
                    {(isAdmin || d.uploaded_by_id === user?.id) && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setPendingDeleteDoc(d)}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                ),
              },
            ]}
            rows={documents}
          />
          {status === "CANCELLED" ? (
            <p className="muted small" style={{ marginTop: 14 }}>
              Documents cannot be added — this request has been cancelled.
            </p>
          ) : (
            <AddDocuments reqId={req.id} onAdded={load} />
          )}
        </div>
      )}

      {pendingDeleteDoc && (
        <Modal
          title="Delete document?"
          onClose={() => setPendingDeleteDoc(null)}
          variant="dialog"
          preventBackdropClose
          hideCloseButton
        >
          <div style={{ fontSize: 13.5 }}>
            Delete <strong>{pendingDeleteDoc.file_name}</strong>? This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteDocBusy}
              onClick={async () => {
                setDeleteDocBusy(true);
                setError(null);
                try {
                  await api.del(
                    `/api/qa-requests/${req.id}/documents/${pendingDeleteDoc.id}`
                  );
                  setPendingDeleteDoc(null);
                  load();
                } catch (err) {
                  setError(err);
                } finally {
                  setDeleteDocBusy(false);
                }
              }}
            >
              {deleteDocBusy ? "Deleting..." : "Delete"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={deleteDocBusy}
              onClick={() => setPendingDeleteDoc(null)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {tab === "history" && (
        <JiraActivity entityType="QA_REQUEST" entityId={req.id} items={history} onPosted={(item) => setHistory((prev) => [...prev, item])} />
      )}

      {editingReq && (
        <NewRequestModal
          editing={req}
          onClose={() => {
            setEditingReq(false);
            // Evidence attach/remove inside the wizard's checklist steps
            // happens immediately against the backend (ChecklistEvidencePicker
            // uploads/deletes on click, not on wizard Save) -- so evidence may
            // have changed even if the requester closes without saving
            // anything else. Re-check it here too, not just in onCreated below.
            loadDraftEvidenceCounts();
          }}
          onCreated={(updated) => {
            setEditingReq(false);
            onChanged(updated);
            load();
            loadDraftEvidenceCounts();
            if (updated.status === "DRAFT") setDraftNotice(true);
          }}
        />
      )}

      {confirmCancel && (
        <ConfirmModal
          title="Cancel this QA Request?"
          message={
            <div style={{ fontSize: 13.5 }}>
              <p style={{ margin: 0 }}>
                Cancel <strong>{displayId}</strong> ({req.application_name})?
                This cannot be undone — a cancelled request cannot be
                resubmitted or reopened.
              </p>
              <ErrorText error={error} />
            </div>
          }
          confirmLabel={busyAction === "cancel" ? "Cancelling..." : "Cancel Request"}
          cancelLabel="Keep Request"
          destructive
          busy={busyAction === "cancel"}
          onConfirm={async () => {
            setError(null);
            setBusyAction("cancel");
            try {
              const updated = await api.post<QARequestOut>(
                `/api/qa-requests/${req.id}/cancel`,
                {}
              );
              onChanged(updated);
              load();
              setConfirmCancel(false);
            } catch (err) {
              setError(err);
            } finally {
              setBusyAction(null);
            }
          }}
          onCancel={() => {
            setConfirmCancel(false);
            setError(null);
          }}
        />
      )}

      {confirmSubmitNoEvidence && (
        <ConfirmModal
          title="Evidence not attached yet"
          message={
            <div style={{ fontSize: 13.5 }}>
              <p style={{ margin: 0 }}>
                The following readiness checklist item(s) don't have any
                evidence document attached yet. It's easier to attach it now,
                during request creation, than to be asked for it later --
                but this won't stop you from raising the request:
              </p>
              <ul style={{ margin: "10px 0 0", paddingLeft: 20 }}>
                {itemsWithoutEvidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          }
          confirmLabel={busyAction === "submit" ? "Raising..." : "Raise Anyway"}
          cancelLabel="Go Back"
          busy={busyAction === "submit"}
          onConfirm={() => {
            setConfirmSubmitNoEvidence(false);
            act("submit");
          }}
          onCancel={() => setConfirmSubmitNoEvidence(false)}
        />
      )}

      {draftNotice && (
        <InfoModal title="Saved as Draft" onClose={() => setDraftNotice(false)}>
          <p style={{ marginTop: -4 }}>
            Your changes have been saved — this request is still a{" "}
            <strong>Draft</strong> and has <strong>not</strong> been raised yet.
          </p>
          <p className="muted small">
            Nothing happens on any Functional/SAST/DAST/Performance request
            until you click "Submit / Raise".
          </p>
        </InfoModal>
      )}

      {/* 2026-08: a brand-new "Other" Application Name defers child-request
          creation until an Application Owner approves it (see
          routers/qa_requests.py::submit_request) -- this modal fires right
          after Submit either way (see act() above), but when that's the
          case raisedNotice.status is "SUBMITTED", not "RAISED", and there
          is genuinely nothing under linkedSections() yet (every linked_*
          array is still empty). Showing the normal "go review each section"
          copy against an empty list would be confusing, so this case gets
          its own explanation instead; the normal copy only applies once
          status is actually RAISED. */}
      {raisedNotice && raisedNotice.status === "SUBMITTED" && (
        <InfoModal title="Request Submitted" onClose={() => setRaisedNotice(null)}>
          <p style={{ marginTop: -4 }}>
            <strong>{raisedNotice.request_id}</strong> has been submitted, but
            not raised yet — its Application Name{" "}
            <strong>{raisedNotice.application_name || "—"}</strong> is a
            brand-new entry and needs Application Owner approval first.
          </p>
          <p className="muted small">
            No Functional/SAST/DAST/Performance request has been created yet.
            Once the Application Owner approves the name, this request will
            move to Raised automatically, its linked request(s) will be
            generated, and they'll be assigned to SM — you'll see them appear
            on this page and its respective section(s) at that point. If the
            name is rejected instead, this request reverts to Draft so you
            can edit and resubmit under a different name.
          </p>
        </InfoModal>
      )}
      {raisedNotice && raisedNotice.status !== "SUBMITTED" && (
        <InfoModal title="Request Raised" onClose={() => setRaisedNotice(null)}>
          <p style={{ marginTop: -4 }}>
            <strong>{raisedNotice.request_id}</strong> has been raised. Each
            selected request type now has its own independent request and
            workflow — go to the respective section(s) below, review the
            details, and submit each one:
          </p>
          <ul style={{ margin: "10px 0 0", paddingLeft: 20 }}>
            {linkedSections(raisedNotice).map((s) => (
              <li key={s.path} style={{ padding: "3px 0" }}>
                <Link to={s.path} onClick={() => setRaisedNotice(null)}>
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </InfoModal>
      )}

      {appNameDecisionNotice && (
        <InfoModal
          title="Application Name Decision Recorded"
          onClose={() => {
            setAppNameDecisionNotice(null);
            onClose();
          }}
        >
          <p style={{ marginTop: -4 }}>{appNameDecisionNotice}</p>
        </InfoModal>
      )}
    </Modal>
  );
}
