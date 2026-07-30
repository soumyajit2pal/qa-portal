import React, {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  QA_STATUS_LABELS,
  SAST_DAST_STATUS_LABELS,
  SUPPRESSION_STATUS_LABELS,
  PERFORMANCE_STATUS_LABELS,
  SIGNOFF_STATUS_LABELS,
} from "../constants";
import { IconFolder, IconFilter } from "./Icons";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import type { RequestDocumentOut } from "../types";

// Every status across every module (QA Request, SAST/DAST,
// Performance, Suppression, Sign-off) funnels through this one Badge, so its
// label lookup merges all of their *_STATUS_LABELS maps rather than just
// QA_STATUS_LABELS -- otherwise a SAST/DAST/Performance/
// Suppression/Sign-off status would render as its raw SNAKE_CASE value
// instead of a human label. Shared status names (SM_APPROVAL_PENDING,
// RETURNED_BY_SM, SM_REJECTED, DEPARTMENT_HEAD_APPROVAL_PENDING, etc.)
// resolve identically no matter which map they came from, so merge order
// doesn't matter for those.
const ALL_STATUS_LABELS: Record<string, string> = {
  ...QA_STATUS_LABELS,
  ...SAST_DAST_STATUS_LABELS,
  ...SUPPRESSION_STATUS_LABELS,
  ...PERFORMANCE_STATUS_LABELS,
  ...SIGNOFF_STATUS_LABELS,
};

export function Badge({ status }: { status?: string | null }) {
  // Colour families are semantic, not decorative: gray = neutral/closed,
  // blue = submitted/informational, purple = actively being worked
  // (planning/execution/scanning), teal = verification/sign-off checkpoints,
  // yellow = waiting on a person's decision, green = positive outcome,
  // red = rejected/blocked/defect. Spreading statuses across this wider
  // palette (rather than defaulting everything "in progress" to yellow)
  // makes list/table views easier to scan at a glance.
  const map: Record<string, string> = {
    // Legacy / other-module statuses
    Draft: "badge-gray",
    Completed: "badge-green",
    Returned: "badge-red",
    Cancelled: "badge-gray",
    Approved: "badge-green",
    Rejected: "badge-red",
    Passed: "badge-green",
    Failed: "badge-red",
    "In Progress": "badge-purple",
    Open: "badge-red",
    Closed: "badge-gray",
    Issued: "badge-green",
    Done: "badge-green",
    // Shared across QA Request / SAST-DAST / Performance / Suppression
    DRAFT: "badge-gray",
    SUBMITTED: "badge-blue",
    SM_APPROVAL_PENDING: "badge-yellow",
    RETURNED_BY_SM: "badge-red",
    SM_REJECTED: "badge-red",
    DEPARTMENT_HEAD_APPROVAL_PENDING: "badge-yellow",
    RETURNED_BY_DEPARTMENT_HEAD: "badge-red",
    DEPARTMENT_HEAD_REJECTED: "badge-red",
    CLOSED: "badge-green",
    CANCELLED: "badge-gray",
    REQUESTER_VERIFICATION: "badge-teal",
    SIGNOFF_PENDING: "badge-teal",
    SIGNED_OFF: "badge-green",
    // QA Request lifecycle
    QA_LEAD_ASSIGNED: "badge-blue",
    READINESS_VERIFICATION: "badge-teal",
    RETURNED_BY_QA_LEAD: "badge-red",
    QA_ACTIVITY_INITIATED: "badge-blue",
    PLANNING: "badge-purple",
    TESTER_ASSIGNED: "badge-blue",
    TEST_DESIGN: "badge-purple",
    EXECUTION_IN_PROGRESS: "badge-purple",
    DEFECT_RAISED: "badge-red",
    WAITING_FOR_FIX: "badge-red",
    RETESTING: "badge-purple",
    REGRESSION_TESTING: "badge-purple",
    QA_COMPLETED: "badge-green",
    QA_SIGNOFF_PENDING: "badge-teal",
    QA_SIGNED_OFF: "badge-green",
    // SAST/DAST lifecycle
    SECURITY_LEAD_ASSIGNED: "badge-blue",
    SECURITY_READINESS: "badge-teal",
    RETURNED_BY_SECURITY_LEAD: "badge-red",
    CONFIGURATION: "badge-purple",
    SCANNING: "badge-purple",
    FINDING_VALIDATION: "badge-teal",
    REMEDIATION: "badge-red",
    ASSIGNED_TO_REQUESTER: "badge-red",
    ASSIGNED_TO_LEAD: "badge-purple",
    RESCAN: "badge-purple",
    SECURITY_COMPLETE: "badge-green",
    REPORT_READY: "badge-green",
    // Performance Testing lifecycle
    READINESS: "badge-teal",
    FEASIBILITY: "badge-teal",
    SCRIPT_DEVELOPMENT: "badge-purple",
    ENVIRONMENT_SETUP: "badge-purple",
    BASELINE: "badge-purple",
    LOAD_TEST_EXECUTION: "badge-purple",
    RESULT_ANALYSIS: "badge-teal",
    DEFECT_FIX_RETEST: "badge-red",
    REPORT: "badge-teal",
    // Suppression lifecycle
    SECURITY_TEAM_VERIFICATION: "badge-teal",
  };
  const label = (status && ALL_STATUS_LABELS[status]) || status || "";
  return (
    <span className={`badge ${(status && map[status]) || "badge-gray"}`}>
      {label}
    </span>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  count?: number;
  actions?: ReactNode;
  children?: ReactNode;
}

// Consistent "title + description + primary actions" header used at the top
// of every page, replacing the old ad hoc <div className="toolbar"> + bare
// <Card title="X (N)"> pairing that varied slightly page to page.
export function PageHeader({
  title,
  subtitle,
  count,
  actions,
  children,
}: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="titles">
        <h2>
          {title}
          {typeof count === "number" && (
            <span className="count-pill">{count}</span>
          )}
        </h2>
        {subtitle && <p>{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  right?: ReactNode;
  style?: React.CSSProperties;
}

export function Card({ title, subtitle, children, right, style }: CardProps) {
  return (
    <div className="card" style={style}>
      {(title || right) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && (
              <p className="muted small" style={{ margin: "2px 0 0" }}>
                {subtitle}
              </p>
            )}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  // One plain-English line explaining exactly what's being counted --
  // reported directly: several dashboard numbers (e.g. "Total Pending
  // Items", which is the same count as the Command Centre's Ageing
  // Distribution donut) had no visible explanation of their scope, so
  // people had to ask what they meant instead of reading it on screen.
  // Always rendered (not a hover-only tooltip) so it's self-explanatory
  // at a glance.
  hint?: ReactNode;
}) {
  return (
    <div className="metric-card">
      <div className="value">{value ?? 0}</div>
      <div className="label">{label}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function BarChart({ data }: { data?: Record<string, number> | null }) {
  const entries = Object.entries(data || {}).filter(([k]) => k);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (entries.length === 0) return <p className="muted small">No data yet.</p>;
  return (
    <div className="bar-chart">
      {entries.map(([k, v]) => (
        <div className="bar-row" key={k}>
          <span>{k}</span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${(v / max) * 100}%` }}
            />
          </div>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  wide?: boolean;
  // 'drawer' (default): right-side slide-over -- gives most record detail
  // views (SAST/DAST, Suppression, Sign-off, Admin forms, etc.) room to
  // breathe and keeps the surrounding page visible/in context, matching the
  // panel pattern used by most modern SaaS dashboards.
  // 'dialog': centered on screen -- used for longer multi-step forms (the
  // QA Request wizard) where a narrow side-anchored panel cramps a step's
  // worth of fields/checklist content; a centered box gives it more usable
  // width without needing to be as tall as the viewport.
  variant?: "drawer" | "dialog";
  // When true, clicking the backdrop (the dimmed area outside the panel)
  // does nothing instead of closing the modal -- only the panel's own
  // explicit "Close"/"Cancel" button (or whatever the caller renders) can
  // close it. Use this for anything holding typed-but-not-yet-saved data
  // (e.g. the QA Request wizard), where an accidental outside click
  // shouldn't be able to silently throw away everything filled in so far.
  // A brief shake on the panel gives feedback that the click did register,
  // rather than the modal just feeling unresponsive.
  preventBackdropClose?: boolean;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  variant = "drawer",
  preventBackdropClose,
}: ModalProps) {
  const [shake, setShake] = useState(false);

  function handleBackdropClick() {
    if (!preventBackdropClose) {
      onClose();
      return;
    }
    setShake(true);
    setTimeout(() => setShake(false), 320);
  }

  if (variant === "dialog") {
    return (
      <div
        className="modal-overlay modal-overlay-center"
        onClick={handleBackdropClick}
      >
        <div
          className={`dialog ${wide ? "dialog-wide" : ""} ${
            shake ? "modal-shake" : ""
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="drawer-header">
            <h3>{title}</h3>
            <button className="btn btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="drawer-body">{children}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div
        className={`drawer ${wide ? "drawer-wide" : ""} ${
          shake ? "modal-shake" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h3>{title}</h3>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

// Read-only display of the acting (logged-in) user's own name + a "Sign"
// button, used alongside "Approve" on SM/Department Head decision steps.
// Used to be a free-text input the user had to type their name/employee ID
// into -- reported directly as something that should just log whatever
// name is already on the system instead of letting it be typed/edited, so
// there's no longer any way to sign as someone other than the account
// that's actually logged in. Approve stays disabled until Sign is clicked.
export function SignField({
  userName,
  onSignedChange,
  disabled = false,
}: {
  userName?: string;
  onSignedChange: (name: string | null) => void;
  disabled?: boolean;
}) {
  const [signed, setSigned] = useState(false);

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span
        style={{
          display: "inline-block",
          minWidth: 190,
          padding: "6px 9px",
          border: "1px solid var(--border)",
          borderRadius: 7,
          fontSize: 12.5,
          background: "var(--panel-soft, #f4f6f8)",
          color: userName ? "var(--navy)" : "var(--muted)",
        }}
      >
        {userName || "Unknown user"}
      </span>
      <button
        type="button"
        className={`btn btn-sm ${signed ? "btn-success" : ""}`}
        disabled={disabled || !userName}
        onClick={() => {
          setSigned(true);
          onSignedChange(userName as string);
        }}
      >
        {signed ? "Signed ✓" : "Sign"}
      </button>
    </span>
  );
}

// Appends the typed signature to whatever comments were entered, so the
// signed name travels with the approval into ApprovalAction.comments without
// needing a new backend column.
export function withSignature(
  comments: string,
  signedBy: string | null
): string {
  if (!signedBy) return comments;
  const base = (comments || "").trim();
  return `${base ? base + " " : ""}[Signed by: ${signedBy}]`;
}

interface ApprovalDecisionButtonsProps {
  // Name pre-filled into the Sign field -- normally the acting user's own name.
  userName?: string;
  // Whatever's in the page's "Comments (optional)" box; gets the signature
  // appended before being sent with the Approve action (Return/Reject are
  // sent as typed, unsigned).
  comments: string;
  busy: boolean;
  onApprove: (signedComments: string) => void;
  onReturn: () => void;
  onReject: () => void;
  approveLabel?: string;
  returnLabel?: string;
  rejectLabel?: string;
  // For steps that need something picked before Approve makes sense (e.g.
  // Department Head assigning a QA Lead / Security Lead) -- rendered in its
  // own labeled row above the Sign field, and Approve also stays disabled
  // until `extraReady`. extraControlLabel is the caption shown next to it
  // (e.g. "Assign QA Lead") -- without one it just renders unlabeled.
  extraControl?: ReactNode;
  extraControlLabel?: string;
  extraReady?: boolean;
  // Set while this request's Application Name is still not APPROVED (i.e.
  // PENDING or REJECTED -- see ApplicationNameBanner/application_master_status)
  // -- disables both Sign and Approve (Return/Reject stay usable, since an
  // approver should still be able to bounce a request back over an
  // unapproved name rather than being stuck unable to act on it at all).
  // signBlockedMessage is shown next to the buttons while blocked.
  signBlocked?: boolean;
  signBlockedMessage?: string;
}

// The one-stop replacement for the "Sign, Approve, Return to Requester,
// Reject" button group that used to be copy-pasted (with the Sign button
// added by hand into all six of them) across every SM/Department Head
// decision step: Functional, SAST, DAST, Performance,
// Suppression. Changing how approvals work now means editing this one
// component instead of six near-identical blocks of JSX.
export function ApprovalDecisionButtons({
  userName,
  comments,
  busy,
  onApprove,
  onReturn,
  onReject,
  approveLabel = "Approve",
  returnLabel = "Return to Requester",
  rejectLabel = "Reject",
  extraControl,
  extraControlLabel,
  extraReady = true,
  signBlocked = false,
  signBlockedMessage,
}: ApprovalDecisionButtonsProps) {
  const [signedBy, setSignedBy] = useState<string | null>(null);
  // Whether an assignment (QA Lead/Security Lead/Engineer) is still needed
  // before this decision can be confirmed -- see assignModalOpen below. An
  // inline row for this (tried first) sat directly above Sign/Approve/
  // Return/Reject inside the same flex-wrap row, and its search popover
  // (position: fixed) visually overlapped those buttons and the Comments box
  // beneath them, since opening it doesn't push that content down -- reported
  // directly, twice, with screenshots. A modal sidesteps the problem
  // entirely: it's a dedicated overlay with its own stacking context, so
  // there's nothing underneath for its popover to collide with.
  const [assignModalOpen, setAssignModalOpen] = useState(false);

  function handleApproveClick() {
    if (extraControl) {
      setAssignModalOpen(true);
    } else {
      onApprove(withSignature(comments, signedBy));
    }
  }

  return (
    <>
      <SignField
        userName={userName}
        onSignedChange={setSignedBy}
        disabled={busy || signBlocked}
      />
      <button
        className="btn btn-success btn-sm"
        disabled={busy || !signedBy || signBlocked}
        onClick={handleApproveClick}
      >
        {approveLabel}
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={onReturn}>
        {returnLabel}
      </button>
      <button
        className="btn btn-danger btn-sm"
        disabled={busy}
        onClick={onReject}
      >
        {rejectLabel}
      </button>
      {signBlocked && signBlockedMessage && (
        <span style={{ fontSize: 12.5, color: "#b45309" }}>
          {signBlockedMessage}
        </span>
      )}
      {assignModalOpen && (
        <Modal
          title={extraControlLabel ? `${extraControlLabel} & ${approveLabel}` : approveLabel}
          onClose={() => setAssignModalOpen(false)}
          variant="dialog"
          preventBackdropClose
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              {extraControlLabel && (
                <label
                  style={{
                    display: "block",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--navy)",
                    marginBottom: 6,
                  }}
                >
                  {extraControlLabel}
                </label>
              )}
              {extraControl}
            </div>
            {!extraReady && (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                Select someone above before confirming {approveLabel.toLowerCase()}.
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setAssignModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-success btn-sm"
                disabled={!extraReady}
                onClick={() => {
                  onApprove(withSignature(comments, signedBy));
                  setAssignModalOpen(false);
                }}
              >
                Confirm {approveLabel}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function Field({
  label,
  children,
}: {
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="form-field">
      <label>{label}</label>
      {children}
    </div>
  );
}

// Read-only field grouping for request detail "Overview" tabs. Replaces the
// old pattern of one long flat <div className="grid grid-2"> holding every
// field (status, priority, department, CR number, environment, people...)
// with no visual grouping at all -- splitting a detail screen into a handful
// of small, labeled clusters (Application & Change / Classification /
// Environment & Release / People) reads far more clearly than one wall of
// 12-15 facts. Reuses the same .detail-section/.detail-section-title
// classes across every module's detail page for a consistent look.
export function DetailSection({
  title,
  children,
  columns = 2,
}: {
  title?: ReactNode;
  children?: ReactNode;
  columns?: 1 | 2 | 3;
}) {
  return (
    <div className="detail-section">
      {title && <div className="detail-section-title">{title}</div>}
      <div className={`grid grid-${columns}`}>{children}</div>
    </div>
  );
}

// Caller is responsible for its own "—" fallback (e.g. `{req.x || '—'}`),
// same convention already used everywhere else in this codebase -- kept
// dumb here rather than guessing what counts as "empty" for every caller.
export function DetailField({
  label,
  children,
}: {
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="detail-field">
      <div className="label">{label}</div>
      <div className="value">{children}</div>
    </div>
  );
}

export interface RepeatableGroupField {
  key: string;
  label: string;
  placeholder?: string;
}
export type RepeatableGroupRow = Record<string, string>;

function blankGroupRow(fields: RepeatableGroupField[]): RepeatableGroupRow {
  return Object.fromEntries(fields.map((f) => [f.key, ""]));
}

// A whole set of fields that repeats together as one unit (e.g. a project
// with several repositories, each with its own branch, commit ID, tech stack
// and build number). One row = one full set of inputs; the single "+" (on
// the last row) adds a new, entirely blank row; "x" removes a row. Never
// down to zero rows, so there's always at least one row to fill in.
export function RepeatableGroupInput({
  fields,
  rows,
  onChange,
  required,
}: {
  fields: RepeatableGroupField[];
  rows: RepeatableGroupRow[];
  onChange: (rows: RepeatableGroupRow[]) => void;
  required?: boolean;
}) {
  const data = rows.length > 0 ? rows : [blankGroupRow(fields)];
  function setAt(i: number, key: string, v: string) {
    onChange(data.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
  }
  function addRow() {
    onChange([...data, blankGroupRow(fields)]);
  }
  function removeRow(i: number) {
    onChange(
      data.length > 1
        ? data.filter((_, idx) => idx !== i)
        : [blankGroupRow(fields)]
    );
  }
  return (
    <div>
      {data.map((row, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: 6,
            marginBottom: i < data.length - 1 ? 8 : 0,
            alignItems: "center",
          }}
        >
          {fields.map((f) => (
            <input
              key={f.key}
              required={required && i === 0}
              placeholder={f.placeholder || f.label}
              value={row[f.key] || ""}
              onChange={(e) => setAt(i, f.key, e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
          ))}
          {data.length > 1 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => removeRow(i)}
            >
              &times;
            </button>
          )}
          {i === data.length - 1 && (
            <button type="button" className="btn btn-sm" onClick={addRow}>
              +
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// Like RepeatableGroupInput, but for a row of mixed field types (selects,
// checkboxes, conditionally-shown fields) that a single `fields` config
// can't express -- the caller supplies its own row JSX via renderRow, and
// this just handles the add/remove/"always at least one row" mechanics
// around it (single "+" on the last row, "x" to remove a row).
export function RepeatableRows<T>({
  rows,
  blankRow,
  onChange,
  renderRow,
}: {
  rows: T[];
  blankRow: () => T;
  onChange: (rows: T[]) => void;
  renderRow: (
    row: T,
    setField: <K extends keyof T>(key: K, value: T[K]) => void,
    index: number
  ) => ReactNode;
}) {
  const data = rows.length > 0 ? rows : [blankRow()];
  function addRow() {
    onChange([...data, blankRow()]);
  }
  function removeRow(i: number) {
    onChange(
      data.length > 1 ? data.filter((_, idx) => idx !== i) : [blankRow()]
    );
  }
  return (
    <div>
      {data.map((row, i) => {
        function setField<K extends keyof T>(key: K, value: T[K]) {
          onChange(
            data.map((r, idx) => (idx === i ? { ...r, [key]: value } : r))
          );
        }
        return (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 6,
              marginBottom: i < data.length - 1 ? 10 : 0,
              alignItems: "flex-start",
            }}
          >
            <div style={{ flex: 1, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {renderRow(row, setField, i)}
            </div>
            {data.length > 1 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => removeRow(i)}
              >
                &times;
              </button>
            )}
            {i === data.length - 1 && (
              <button type="button" className="btn btn-sm" onClick={addRow}>
                +
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ErrorText({ error }: { error?: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <p className="error-text">{message}</p>;
}

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  // Set false to hide the filter box for this column entirely -- for
  // action-only columns (a lone "Download" button, icons with no text) where
  // a text filter wouldn't match anything meaningful. Every other column gets
  // one automatically.
  filterable?: boolean;
  // The plain text a typed filter is matched against for this column.
  // Defaults to String(row[key]) which works fine for columns that render
  // their own raw field, but must be supplied explicitly wherever `render`
  // displays something derived from the row rather than the field at `key`
  // itself (a user-ID column showing a looked-up name, a linked-object column
  // showing a badge, a findings array shown as a count, etc.) -- otherwise
  // the filter would silently compare against the wrong underlying value.
  filterValue?: (row: T) => string;
}

interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: keyof T;
  onRowClick?: (row: T) => void;
  // Every Table paginates -- 5 rows per page by default, everywhere in the
  // app, per the "everywhere in project table, list add pagination, show 5
  // items only per page" requirement. Left as an overridable prop (rather
  // than a hardcoded constant) purely as an escape hatch for some future
  // call site that genuinely needs a different page size, not because any
  // current one does.
  pageSize?: number;
}

export function Table<T extends Record<string, any>>({
  columns,
  rows,
  rowKey,
  onRowClick,
  pageSize = 10,
}: TableProps<T>) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  // Which column's filter popover is currently open -- at most one at a
  // time, closed by clicking its icon again, pressing Escape, or clicking
  // anywhere outside the popover (see the document listener below). Having a
  // value typed in a column's filter and the popover being closed are
  // independent: closing the popover doesn't clear that column's filter, it
  // just hides the input (the icon itself gets a filled/active style so it's
  // still obvious a filter is applied).
  const [openFilterKey, setOpenFilterKey] = useState<string | null>(null);
  // Screen coordinates for the currently-open popover, captured from the
  // filter icon's own bounding box at click time. The popover itself is
  // rendered with position:fixed at these coordinates -- rather than
  // position:absolute nested inside the <th> -- specifically so it isn't
  // clipped by .table-wrap's overflow-x:auto/overflow-y:hidden scroll box
  // and always paints in front of every table row underneath it instead of
  // visually overlapping/blending into the first row's cell text.
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openFilterKey) return;
    function onDocMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node))
        setOpenFilterKey(null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenFilterKey(null);
    }
    function onReposition() {
      setOpenFilterKey(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    // Closing on scroll/resize (rather than tracking + repositioning) keeps
    // this simple -- a filter popover doesn't need to survive the page
    // moving underneath it.
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [openFilterKey]);

  function toggleFilter(key: string, e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (openFilterKey === key) {
      setOpenFilterKey(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setPopoverPos({ top: rect.bottom + 6, left: rect.left });
    setOpenFilterKey(key);
  }

  function textFor(col: TableColumn<T>, row: T): string {
    if (col.filterValue) return col.filterValue(row);
    const v = (row as any)[col.key];
    return v === null || v === undefined ? "" : String(v);
  }

  const activeFilters = Object.entries(filters).filter(
    ([, v]) => v.trim() !== ""
  );

  const filteredRows = useMemo(() => {
    if (activeFilters.length === 0) return rows;
    return rows.filter((row) =>
      activeFilters.every(([key, value]) => {
        const col = columns.find((c) => c.key === key);
        if (!col) return true;
        return textFor(col, row)
          .toLowerCase()
          .includes(value.trim().toLowerCase());
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, columns]);

  // Reset to page 1 whenever the filtered set changes shape (a new filter
  // typed, or the underlying row count changes, e.g. fresh data loaded) --
  // otherwise narrowing a filter while sitting on page 3 could strand you on
  // a now-empty page instead of showing the first (most relevant) matches.
  // Keyed on rows.length rather than `rows` itself -- several call sites
  // pass a freshly-computed array (e.g. `rows={items.slice(0, 8)}`) on every
  // render, and resetting on identity rather than content would snap back
  // to page 1 on any unrelated parent re-render, not just an actual data
  // change.
  useEffect(() => {
    setPage(1);
  }, [filters, rows.length]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  // Clamp separately from the reset above -- covers the case where `page`
  // was already >1 and filteredRows.length shrinks for a reason that didn't
  // go through the filters/rows reset (e.g. pageSize itself changing).
  const currentPage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () =>
      filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filteredRows, currentPage, pageSize]
  );

  function clearFilters() {
    setFilters({});
    setOpenFilterKey(null);
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>
                <div className="th-cell">
                  <span>{c.header}</span>
                  {c.filterable !== false && (
                    <button
                      type="button"
                      className={`th-filter-btn ${
                        filters[c.key] ? "active" : ""
                      }`}
                      title={`Filter ${
                        typeof c.header === "string" ? c.header : "column"
                      }`}
                      onClick={(e) => toggleFilter(c.key, e)}
                    >
                      <IconFilter width={12} height={12} />
                    </button>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filteredRows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>
                <div className="empty-state">
                  <IconFolder width={26} height={26} />
                  <span className="msg">
                    {rows.length === 0
                      ? "No records found."
                      : "No rows match the current filters."}
                  </span>
                  {activeFilters.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={clearFilters}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              </td>
            </tr>
          )}
          {pagedRows.map((row) => (
            <tr
              key={String(row[rowKey])}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "row-clickable" : undefined}
            >
              {columns.map((c) => (
                <td key={c.key}>
                  {c.render ? c.render(row) : (row as any)[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filteredRows.length > 0 &&
        (activeFilters.length > 0 || totalPages > 1) && (
          <div className="table-footer">
            <div className="table-footer-filters">
              {activeFilters.length > 0 && (
                <>
                  <span>
                    Showing {filteredRows.length} of {rows.length} rows
                  </span>
                  <button type="button" onClick={clearFilters}>
                    Clear filters
                  </button>
                </>
              )}
            </div>
            {totalPages > 1 && (
              <div className="table-pagination">
                <span>
                  {(currentPage - 1) * pageSize + 1}–
                  {Math.min(currentPage * pageSize, filteredRows.length)} of{" "}
                  {filteredRows.length}
                </span>
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  ‹ Prev
                </button>
                <span>
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next ›
                </button>
              </div>
            )}
          </div>
        )}
      {openFilterKey &&
        popoverPos &&
        (() => {
          const col = columns.find((c) => c.key === openFilterKey);
          if (!col) return null;
          return (
            <div
              className="th-filter-popover"
              ref={popoverRef}
              style={{ top: popoverPos.top, left: popoverPos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                className="table-filter-input"
                placeholder="Filter..."
                value={filters[col.key] || ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, [col.key]: e.target.value }))
                }
              />
              {filters[col.key] && (
                <button
                  type="button"
                  className="th-filter-popover-clear"
                  onClick={() => setFilters((f) => ({ ...f, [col.key]: "" }))}
                >
                  Clear
                </button>
              )}
            </div>
          );
        })()}
    </div>
  );
}

// Shared "Documents" tab body -- multiple supporting files uploaded any time
// after a request has been raised. Used by every module EXCEPT the Gateway
// QA Request, which has its own bespoke Documents tab/upload flow in
// QARequests.tsx predating this (documents collected during the wizard
// itself, not just after raising). `apiBase` is that module's own request
// router prefix, e.g. "/api/functional-requests" -- this component always
// talks to `${apiBase}/${reqId}/documents[...]`, matching the endpoints
// added in each router (see backend/app/documents.py).
export function RequestDocuments({
  apiBase,
  reqId,
}: {
  apiBase: string;
  reqId: number;
}) {
  const { user } = useAuth();
  const isAdmin = !!user?.roles?.includes("ADMIN");
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pendingDelete, setPendingDelete] = useState<RequestDocumentOut | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDocuments(
        await api.get<RequestDocumentOut[]>(`${apiBase}/${reqId}/documents`)
      );
    } catch (err) {
      setError(err);
    }
  }, [apiBase, reqId]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadFiles(`${apiBase}/${reqId}/documents`, files);
      setFiles([]);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setError(null);
    try {
      await api.del(`${apiBase}/${reqId}/documents/${pendingDelete.id}`);
      setPendingDelete(null);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div>
      <ErrorText error={error} />
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
                      `${apiBase}/${reqId}/documents/${d.id}/download`,
                      d.file_name
                    )
                  }
                >
                  Download
                </button>
                {(isAdmin || d.uploaded_by_id === user?.id) && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => setPendingDelete(d)}
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
      <form onSubmit={submit} style={{ marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <input
            type="file"
            multiple
            onChange={(e) =>
              setFiles((prev) => [...prev, ...Array.from(e.target.files || [])])
            }
          />
          <button className="btn btn-sm" disabled={busy || files.length === 0}>
            {busy ? "Uploading..." : "Upload"}
          </button>
        </div>
        {files.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              margin: "8px 0 0",
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {files.map((f, idx) => (
              <li
                key={`${f.name}-${idx}`}
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}
              >
                <span>{f.name}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    setFiles((prev) => prev.filter((_, i) => i !== idx))
                  }
                  aria-label={`Remove ${f.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
      {pendingDelete && (
        <Modal
          title="Delete document?"
          onClose={() => setPendingDelete(null)}
          variant="dialog"
          preventBackdropClose
        >
          <div style={{ fontSize: 13.5 }}>
            Delete <strong>{pendingDelete.file_name}</strong>? This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteBusy}
              onClick={confirmDelete}
            >
              {deleteBusy ? "Deleting..." : "Delete"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={deleteBusy}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
