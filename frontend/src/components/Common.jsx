import React from 'react'

import { QA_STATUS_LABELS } from '../constants'
import { IconFolder } from './Icons'

export function Badge({ status }) {
  // Colour families are semantic, not decorative: gray = neutral/closed,
  // blue = submitted/informational, purple = actively being worked
  // (planning/execution/scanning), teal = verification/sign-off checkpoints,
  // yellow = waiting on a person's decision, green = positive outcome,
  // red = rejected/blocked/defect. Spreading statuses across this wider
  // palette (rather than defaulting everything "in progress" to yellow)
  // makes list/table views easier to scan at a glance.
  const map = {
    // Legacy / other-module statuses
    Draft: 'badge-gray', Completed: 'badge-green', Returned: 'badge-red', Cancelled: 'badge-gray',
    Approved: 'badge-green', Rejected: 'badge-red', Passed: 'badge-green',
    Failed: 'badge-red', Blocked: 'badge-yellow', 'In Progress': 'badge-purple',
    'Not Started': 'badge-gray', 'Retest Passed': 'badge-green', NA: 'badge-gray',
    Open: 'badge-red', Closed: 'badge-gray', Issued: 'badge-green',
    'Pending Application Owner': 'badge-yellow', 'Pending Department Head': 'badge-yellow',
    Requested: 'badge-blue', Allocated: 'badge-blue', Scanning: 'badge-purple',
    'Report Ready': 'badge-green',
    // QA Request lifecycle
    DRAFT: 'badge-gray',
    SUBMITTED: 'badge-blue',
    DEPARTMENT_HEAD_APPROVAL_PENDING: 'badge-yellow',
    RETURNED_BY_DEPARTMENT_HEAD: 'badge-red',
    DEPARTMENT_HEAD_REJECTED: 'badge-red',
    QA_LEAD_ASSIGNED: 'badge-blue',
    READINESS_VERIFICATION: 'badge-teal',
    RETURNED_BY_QA_LEAD: 'badge-red',
    QA_ACTIVITY_INITIATED: 'badge-blue',
    PLANNING: 'badge-purple',
    TESTER_ASSIGNED: 'badge-blue',
    TEST_DESIGN: 'badge-purple',
    EXECUTION_IN_PROGRESS: 'badge-purple',
    DEFECT_RAISED: 'badge-red',
    WAITING_FOR_FIX: 'badge-red',
    RETESTING: 'badge-purple',
    REGRESSION_TESTING: 'badge-purple',
    QA_COMPLETED: 'badge-green',
    QA_SIGNOFF_PENDING: 'badge-teal',
    QA_SIGNED_OFF: 'badge-green',
    REQUESTER_VERIFICATION: 'badge-teal',
    CLOSED: 'badge-green',
    CANCELLED: 'badge-gray',
  }
  const label = QA_STATUS_LABELS[status] || status
  return <span className={`badge ${map[status] || 'badge-gray'}`}>{label}</span>
}

// Consistent "title + description + primary actions" header used at the top
// of every page, replacing the old ad hoc <div className="toolbar"> + bare
// <Card title="X (N)"> pairing that varied slightly page to page.
export function PageHeader({ title, subtitle, count, actions, children }) {
  return (
    <div className="page-header">
      <div className="titles">
        <h2>
          {title}
          {typeof count === 'number' && <span className="count-pill">{count}</span>}
        </h2>
        {subtitle && <p>{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

export function Card({ title, subtitle, children, right }) {
  return (
    <div className="card">
      {(title || right) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p className="muted small" style={{ margin: '2px 0 0' }}>{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  )
}

export function MetricCard({ label, value }) {
  return (
    <div className="metric-card">
      <div className="value">{value ?? 0}</div>
      <div className="label">{label}</div>
    </div>
  )
}

export function BarChart({ data }) {
  const entries = Object.entries(data || {}).filter(([k]) => k)
  const max = Math.max(1, ...entries.map(([, v]) => v))
  if (entries.length === 0) return <p className="muted small">No data yet.</p>
  return (
    <div className="bar-chart">
      {entries.map(([k, v]) => (
        <div className="bar-row" key={k}>
          <span>{k}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(v / max) * 100}%` }} /></div>
          <span>{v}</span>
        </div>
      ))}
    </div>
  )
}

// Right-side slide-over drawer (rather than a centered dialog) -- gives
// record detail views (QA Request, SAST/DAST, Suppression, Sign-off, Admin
// forms, etc.) room to breathe and keeps the surrounding page visible/in
// context, matching the panel pattern used by most modern SaaS dashboards.
export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`drawer ${wide ? 'drawer-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h3>{title}</h3>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, children }) {
  return (
    <div className="form-field">
      <label>{label}</label>
      {children}
    </div>
  )
}

export function ErrorText({ error }) {
  if (!error) return null
  return <p className="error-text">{String(error.message || error)}</p>
}

export function Table({ columns, rows, rowKey, onRowClick }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>
                <div className="empty-state">
                  <IconFolder width={26} height={26} />
                  <span className="msg">No records found.</span>
                </div>
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row[rowKey]} onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'row-clickable' : undefined}>
              {columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
