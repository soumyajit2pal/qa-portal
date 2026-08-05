import React, { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import {
  Badge,
  Card,
  ErrorText,
  PageHeader,
  Table,
} from "../components/Common";
import InfoModal from "../components/InfoModal";
import { GATEWAY_STATUSES, GATEWAY_STATUS_LABELS, GATEWAY_PENDING_WITH, hasRole } from "../constants";
import { QARequestOut, UserOut } from "../types";
import { classificationSummary, userName } from "./format";
import { NewRequestModal } from "./NewRequestModal";
import { RequestDetail } from "./RequestDetail";
import ClearableSearchInput from "../components/ClearableSearchInput";

// The QA Requests list page -- the intake gateway. "Raise QA Request" opens
// the wizard (NewRequestModal); clicking a row opens the detail/edit view
// (RequestDetail). See ./buildSteps.ts, ./validation.ts and ./steps/* for how
// the wizard itself is put together.
export default function QARequests() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const [requests, setRequests] = useState<QARequestOut[]>([]);
  const [users, setUsers] = useState<UserOut[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState(
    searchParams.get("search") || searchParams.get("application_name") || ""
  );
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<QARequestOut | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Shown right after saving a brand-new request, as long as it's still sitting
  // in Draft (which it always is at this point -- creating a QA Request never
  // raises it) -- makes it explicit that nothing has actually been submitted
  // yet, since there's no separate "Draft saved" confirmation otherwise.
  const [draftNotice, setDraftNotice] = useState(false);

  useEffect(() => {
    // Reacts to location.state on every navigation to this route -- not just
    // on first mount -- so the topbar's "+ New QA request" button (which
    // navigates here with { state: { openNew: true } }) also works when the
    // user is already sitting on the QA Requests page (no remount happens
    // in that case, so a useState initializer alone would miss it).
    const state = location.state as { openNew?: boolean } | null;
    if (state?.openNew) {
      setShowNew(true);
      // Clear the nav state so refreshing/back/clicking the button again doesn't get stuck.
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, navigate]);

  useEffect(() => {
    // Same "no remount on this route" issue as the openNew effect above --
    // the topbar search box (components/Layout.tsx) navigates to
    // `/qa-requests?search=...` from anywhere in the app, including while
    // already sitting on this page. `search`'s useState initializer only
    // reads the URL once, on first mount, so a second search typed into the
    // topbar while already here updated the URL but never reached this
    // page's `search` state -- the list just kept showing the previous (or
    // no) filter. Re-syncing on every `location.search` change fixes that.
    setSearch(
      new URLSearchParams(location.search).get("search") ||
        new URLSearchParams(location.search).get("application_name") ||
        ""
    );
  }, [location.search]);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set("status_filter", statusFilter);
      if (search) qs.set("search", search);
      const [reqs, us] = await Promise.all([
        api.get<QARequestOut[]>(`/api/qa-requests?${qs.toString()}`),
        api.get<UserOut[]>("/api/auth/users"),
      ]);
      setRequests(reqs);
      setUsers(us);
    } catch (err) {
      setError(err);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    load();
  }, [load]);

  const canCreate = hasRole(user, "REQUESTER", "BUSINESS_ANALYST");

  function clearSearch() {
    setSearch("");
    const params = new URLSearchParams(location.search);
    params.delete("search");
    params.delete("application_name");
    const remaining = params.toString();
    navigate(`${location.pathname}${remaining ? `?${remaining}` : ""}`, { replace: true });
  }

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="QA Requests"
        count={requests.length}
        subtitle="The intake gateway — raise a request here, then track progress on each linked Functional/SAST/DAST/Performance request from its own page."
        // actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Raise QA Request</button>}
      />
      <div className="toolbar">
        <ClearableSearchInput
          placeholder="Search by request ID, application, or project..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={clearSearch}
          clearLabel="Clear QA Request search"
          wrapperClassName="search-grow"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {GATEWAY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {GATEWAY_STATUS_LABELS[s] || s}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <Table
          rowKey="id"
          onRowClick={(r) => setSelected(r)}
          columns={[
            {
              key: "request_id",
              header: "Request ID",
              // Not assigned until raised (see backend's request_id column
              // comment) -- a still-Draft row shows a placeholder instead of
              // a blank cell.
              render: (r) => r.request_id || `Draft #${r.id}`,
              filterValue: (r) => r.request_id || `Draft #${r.id}`,
            },
            { key: "application_name", header: "Application" },
            { key: "epic_number", header: "Epic Number" },
            {
              key: "requester_id",
              header: "Requester",
              render: (r) => userName(users, r.requester_id) || "—",
              filterValue: (r) => userName(users, r.requester_id) || "",
            },
            {
              key: "priority",
              header: "Priority / Risk (per type)",
              render: (r) => (
                <span
                  className="truncate-cell"
                  title={classificationSummary(r)}
                >
                  {classificationSummary(r)}
                </span>
              ),
              filterValue: (r) => classificationSummary(r),
            },
            {
              key: "status",
              header: "Status",
              render: (r) => <Badge status={r.status} />,
            },
            {
              key: "pending_with",
              header: "Pending With",
              render: (r) => GATEWAY_PENDING_WITH[r.status] || "—",
              filterValue: (r) => GATEWAY_PENDING_WITH[r.status] || "",
            },
            { key: "target_release_date", header: "Target Release" },
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

      {showNew && (
        <NewRequestModal
          onClose={() => setShowNew(false)}
          onCreated={(created) => {
            // Land straight on the new request's detail view instead of
            // dropping the user back on the bare list.
            setShowNew(false);
            load();
            setSelected(created);
            if (created.status === "DRAFT") setDraftNotice(true);
          }}
        />
      )}
      {selected && (
        <RequestDetail
          req={selected}
          users={users}
          onClose={() => setSelected(null)}
          onChanged={(updated) => {
            setSelected(updated);
            load();
          }}
        />
      )}
      {draftNotice && (
        <InfoModal title="Saved as Draft" onClose={() => setDraftNotice(false)}>
          <p style={{ marginTop: -4 }}>
            Your QA Request has been saved as a <strong>Draft</strong> — it has{" "}
            <strong>not</strong> been raised yet.
          </p>
          <p className="muted small">
            Nothing happens on any Functional/SAST/DAST/Performance request
            until you submit it. Open this request any time and click "Submit /
            Raise" when you're ready.
          </p>
        </InfoModal>
      )}
    </div>
  );
}
