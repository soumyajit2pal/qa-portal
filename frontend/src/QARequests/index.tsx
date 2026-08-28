import React, { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { formatDateTimeIST } from "../time";
import {
  Badge,
  Card,
  ErrorText,
  PageHeader,
  Table,
} from "../components/Common";
import InfoModal from "../components/InfoModal";
import { GATEWAY_STATUSES, GATEWAY_STATUS_LABELS, GATEWAY_PENDING_WITH } from "../constants";
import { QARequestListOut, QARequestOut, UserOut } from "../types";
import { classificationSummary, userName } from "./format";
import { NewRequestModal } from "./NewRequestModal";
import { RequestDetail } from "./RequestDetail";
import ClearableSearchInput from "../components/ClearableSearchInput";
import { usePaginatedList } from "../hooks/usePaginatedList";

// The QA Requests list page -- the intake gateway. "Raise QA Request" opens
// the wizard (NewRequestModal); clicking a row opens the detail/edit view
// (RequestDetail). See ./buildSteps.ts, ./validation.ts and ./steps/* for how
// the wizard itself is put together.
export default function QARequests() {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const [users, setUsers] = useState<UserOut[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [assignedOnly, setAssignedOnly] = useState(false);
  const [search, setSearch] = useState(
    searchParams.get("search") || searchParams.get("application_name") || searchParams.get("cr_number") || ""
  );
  // Set only when arriving via a CR/EPIC-number global search (see
  // components/Layout.tsx's submitSearch) -- drives an exact-match filter
  // (GET /api/qa-requests?cr_number=...) instead of the free-text `search`
  // param's substring match, so CR-102 doesn't also pull in CR-1023/
  // CR-1024. Cleared as soon as the box is edited by hand, reverting to
  // ordinary free-text search.
  const [crNumber, setCrNumber] = useState(searchParams.get("cr_number") || "");
  const [showNew, setShowNew] = useState(false);
  // SRS 7.2 PAG-006 -- the list only ever holds the lightweight
  // QARequestListOut shape now; opening a request fetches the full
  // QARequestOut record fresh via GET /api/qa-requests/{id} before
  // RequestDetail (which needs every field) is shown. `openingId` drives a
  // small inline loading state on the row being opened while that fetch is
  // in flight.
  const [selected, setSelected] = useState<QARequestOut | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Shown right after saving a brand-new request, as long as it's still sitting
  // in Draft (which it always is at this point -- creating a QA Request never
  // raises it) -- makes it explicit that nothing has actually been submitted
  // yet, since there's no separate "Draft saved" confirmation otherwise.
  const [draftNotice, setDraftNotice] = useState(false);

  const {
    items: requests, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading, setPage, setPageSize, reload,
  } = usePaginatedList<QARequestListOut>("/api/qa-requests", {
    // While an exact CR/EPIC-number filter is active, the free-text
    // substring `search` param is suppressed -- cr_number below already
    // narrows to exactly that CR, and combining both would just be
    // redundant (harmless, but pointless) until the user edits the box.
    search: crNumber ? undefined : search,
    status: statusFilter ? [statusFilter] : undefined,
    extra: { assigned_to_me: assignedOnly ? "true" : undefined, cr_number: crNumber || undefined },
  });

  useEffect(() => {
    api.get<UserOut[]>("/api/auth/users").then(setUsers).catch(setError);
  }, []);

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
    const params = new URLSearchParams(location.search);
    setSearch(params.get("search") || params.get("application_name") || params.get("cr_number") || "");
    setCrNumber(params.get("cr_number") || "");
  }, [location.search]);

  const openRequest = useCallback(async (idOrRow: number | QARequestListOut) => {
    const id = typeof idOrRow === "number" ? idOrRow : idOrRow.id;
    setOpeningId(id);
    try {
      const full = await api.get<QARequestOut>(`/api/qa-requests/${id}`);
      setSelected(full);
    } catch (err) {
      setError(err);
    } finally {
      setOpeningId(null);
    }
  }, []);

  // Pending Approvals and other deep links can open the parent gateway's
  // drawer immediately instead of landing on its filtered list first.
  useEffect(() => {
    const recordId = Number(new URLSearchParams(location.search).get("openId"));
    const openId = new URLSearchParams(location.search).get("open");
    if (Number.isInteger(recordId) && recordId > 0) {
      openRequest(recordId);
    } else if (openId) {
      const match = requests.find((request) => request.request_id === openId);
      if (!match) return;
      openRequest(match.id);
    } else {
      return;
    }
    const params = new URLSearchParams(location.search);
    params.delete("open");
    params.delete("openId");
    navigate(`${location.pathname}${params.toString() ? `?${params}` : ""}`, { replace: true });
  }, [requests, location.search, location.pathname, navigate, openRequest]);

  function clearSearch() {
    setSearch("");
    setCrNumber("");
    const params = new URLSearchParams(location.search);
    params.delete("search");
    params.delete("application_name");
    params.delete("cr_number");
    const remaining = params.toString();
    navigate(`${location.pathname}${remaining ? `?${remaining}` : ""}`, { replace: true });
  }

  return (
    <div>
      <ErrorText error={error} />
      {/* "Raise QA Request" lives in the topbar instead (see
          components/Layout.tsx's "New QA request" button, gated on the same
          REQUESTER/BUSINESS_ANALYST roles) -- not duplicated here. */}
      <PageHeader
        title="QA Requests"
        count={total}
        subtitle="The intake gateway — raise a request here, then track progress on each linked Functional/SAST/DAST/Performance request from its own page."
      />
      <div className="toolbar">
        <ClearableSearchInput
          placeholder="Search by request ID, application, CR number, or project..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setCrNumber(""); }}
          onClear={clearSearch}
          clearLabel="Clear QA Request search"
          wrapperClassName="search-grow"
        />
        {crNumber && (
          <span className="badge badge-blue" title={`Showing every QA Request raised under ${crNumber} exactly`}>
            Exact match: {crNumber}
          </span>
        )}
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
        <div className="tabs" style={{ margin: 0 }}>
          <button type="button" className={!assignedOnly ? "active" : ""} onClick={() => setAssignedOnly(false)}>
            All Requests
          </button>
          <button type="button" className={assignedOnly ? "active" : ""} onClick={() => setAssignedOnly(true)}>
            My Drafts / Delegated
          </button>
        </div>
      </div>

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
              // Not assigned until raised (see backend's request_id column
              // comment) -- a still-Draft row shows a placeholder instead of
              // a blank cell.
              render: (r) => (openingId === r.id ? "Opening…" : (r.request_id || `Draft #${r.id}`)),
              filterValue: (r) => r.request_id || `Draft #${r.id}`,
            },
            { key: "application_name", header: "Application" },
            {
              key: "cr_number",
              header: "CR Number/EPIC Number",
              // Reported directly: "why CR number is blank, though input is
              // provided" -- the backend's list schema was missing cr_number
              // entirely (fixed, see schemas.QARequestListOut), but this
              // also falls back to the legacy epic_number for older rows
              // that predate the consolidated field, same fallback
              // NewRequestModal.tsx already uses when reopening a Draft.
              render: (r) => r.cr_number || r.epic_number || "—",
              filterValue: (r) => r.cr_number || r.epic_number || "",
            },
            {
              key: "change_description",
              header: "Change Description",
              render: (r) => (
                <span className="truncate-cell" title={r.change_description || ""}>
                  {r.change_description || "—"}
                </span>
              ),
              filterValue: (r) => r.change_description || "",
            },
            {
              key: "requester_id",
              header: "Requester",
              render: (r) => userName(users, r.requester_id) || "—",
              filterValue: (r) => userName(users, r.requester_id) || "",
            },
            {
              key: "assigned_to",
              header: "Assigned To",
              render: (r) => r.active_delegation?.assigned_to_name || "—",
              filterValue: (r) => r.active_delegation?.assigned_to_name || "",
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
              render: (r) => formatDateTimeIST(r.created_at),
            },
            {
              key: "updated_at",
              header: "Updated",
              render: (r) => formatDateTimeIST(r.updated_at),
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
            reload();
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
            reload();
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
