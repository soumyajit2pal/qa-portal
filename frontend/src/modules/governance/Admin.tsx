import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader } from '../../components/Common'
import { ROLE_LABELS, ALL_ROLES, LOGIN_TYPES, LOGIN_TYPE_LABELS, hasRole } from '../../constants'
import { IconPlus, IconLock, IconWarning, IconCheckCircle, IconSearch, IconFolder } from '../../components/Icons'
import SearchableSelect from '../../components/SearchableSelect'
import { UserOut, DepartmentOut, ApplicationSeedResult, StorageSettingsOut, ApprovalNotificationSettingsOut } from '../../types'

// Shared by every page that needs a department picker -- departments are
// DB-backed now (see backend app/models.py Department / routers/departments.py)
// instead of a hardcoded constants list, so this fetches the active set at
// call time. Exported so QARequests.tsx (and anywhere else) can reuse it
// instead of duplicating the fetch.
export async function loadActiveDepartments(): Promise<DepartmentOut[]> {
  return api.get<DepartmentOut[]>('/api/departments')
}

const EMPTY_FORM = {
  username: '', full_name: '', email: '', department: '',
  roles: ['REQUESTER'] as string[], login_type: 'STANDARD', password: '',
}
type CreateUserForm = typeof EMPTY_FORM

// `roles` defaults to every assignable role (ALL_ROLES) -- exported with that
// default so DepartmentAdmin.tsx can reuse this same chip-select, just
// restricted to whichever of DEPARTMENT_ADMIN_ASSIGNABLE_ROLES /
// QA_ADMIN_ASSIGNABLE_ROLES applies to the logged-in local admin, instead of
// duplicating the checkbox/styling logic for its own narrower role picker.
export function RoleChipSelect({ value, onChange, disabled, roles = ALL_ROLES }: {
  value: string[]; onChange: (roles: string[]) => void; disabled?: boolean; roles?: string[]
}) {
  function toggle(role: string) {
    if (disabled) return
    const has = value.includes(role)
    onChange(has ? value.filter((r) => r !== role) : [...value, role])
  }
  return (
    <div className="chip-select">
      {roles.map((r) => {
        const active = value.includes(r)
        return (
          <label key={r} className={`chip-toggle ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}>
            <input type="checkbox" checked={active} disabled={disabled} onChange={() => toggle(r)} />
            <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
            {ROLE_LABELS[r]}
          </label>
        )
      })}
    </div>
  )
}

function CreateUserModal({ onClose, onCreated, departmentOptions }: {
  onClose: () => void; onCreated: (u: UserOut) => void; departmentOptions: string[]
}) {
  const [form, setForm] = useState<CreateUserForm>(EMPTY_FORM)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  function set<K extends keyof CreateUserForm>(k: K, v: CreateUserForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (form.roles.length === 0) {
      setError(new Error('Select at least one role'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload: Partial<CreateUserForm> = { ...form }
      if (payload.login_type === 'LDAP') delete payload.password
      const created = await api.post<UserOut>('/api/auth/users', payload)
      onCreated(created)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Create User" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Username *"><input required value={form.username} onChange={(e) => set('username', e.target.value)} /></Field>
          <Field label="Full Name *"><input required value={form.full_name} onChange={(e) => set('full_name', e.target.value)} /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Department (searchable)">
            <SearchableSelect
              value={form.department}
              onChange={(v) => set('department', v)}
              options={departmentOptions}
              placeholder="Select department..."
            />
          </Field>
        </div>
        <Field label="Role(s) * — a user may hold more than one">
          <RoleChipSelect value={form.roles} onChange={(v) => set('roles', v)} />
        </Field>
        <div className="form-row" style={{ marginTop: 12 }}>
          <Field label="Login Type">
            <select value={form.login_type} onChange={(e) => set('login_type', e.target.value)}>
              {LOGIN_TYPES.map((t) => <option key={t} value={t}>{LOGIN_TYPE_LABELS[t]}</option>)}
            </select>
          </Field>
        </div>
        {form.login_type === 'STANDARD' ? (
          <Field label="Password *">
            <input type="password" required value={form.password} onChange={(e) => set('password', e.target.value)} />
          </Field>
        ) : (
          <p className="muted small">
            This account authenticates against the configured LDAP / Active Directory server —
            no local password is stored; the username must match their LDAP identity.
          </p>
        )}
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating...' : 'Create User'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function ResetPasswordModal({ userRow, onClose, onDone }: { userRow: UserOut; onClose: () => void; onDone: () => void }) {
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/auth/users/${userRow.id}/reset-password`, { new_password: newPassword })
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Reset Password — ${userRow.full_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="New Password *">
          <input type="password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Set Password'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Admin section: "provision to add department" -- lists every department
// (active and deactivated), lets an admin add a new one, rename one, or
// toggle it active/inactive. Deactivating (rather than deleting) keeps
// existing users/requests that already reference the name intact.
function DepartmentManagerCard({ departments, onChanged }: { departments: DepartmentOut[]; onChanged: () => void }) {
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [savingId, setSavingId] = useState<number | null>(null)

  async function addDepartment(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/departments', { name })
      setNewName('')
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(d: DepartmentOut) {
    setSavingId(d.id)
    setError(null)
    try {
      await api.patch(`/api/departments/${d.id}`, { is_active: !d.is_active })
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card title="Departments">
      <p className="muted small" style={{ marginTop: -4, marginBottom: 12 }}>
        Departments picked throughout the portal (user mapping, QA Request form, etc.) come from this
        list — deactivating one keeps existing records intact but hides it from new pickers.
      </p>
      <form onSubmit={addDepartment} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          style={{ flex: 1 }}
          placeholder="New department name..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !newName.trim()}>
          <IconPlus width={13} height={13} /> Add
        </button>
      </form>
      <ErrorText error={error} />
      <Table
        rowKey="id"
        columns={[
          { key: 'name', header: 'Name' },
          { key: 'is_active', header: 'Status', render: (d) => (
            <button
              className={`btn btn-sm ${d.is_active ? '' : 'btn-danger'}`}
              disabled={savingId === d.id}
              onClick={() => toggleActive(d)}
            >
              {d.is_active ? 'Active' : 'Inactive'}
            </button>
          ), filterValue: (d) => d.is_active ? 'Active' : 'Inactive' },
        ]}
        rows={departments}
      />
    </Card>
  )
}

function UploadStorageCard() {
  const [settings, setSettings] = useState<StorageSettingsOut | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    api.get<StorageSettingsOut>('/api/system-settings/storage').then((value) => {
      setSettings(value); setPath(value.upload_path)
    }).catch(setError)
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setSaved(false); setError(null)
    try {
      const value = await api.patch<StorageSettingsOut>('/api/system-settings/storage', { upload_path: path.trim() })
      setSettings(value); setPath(value.upload_path); setSaved(true)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><IconFolder /> Upload Storage</span>}>
      <p className="muted small">
        Absolute filesystem path on the backend server used for all new documents and checklist evidence.
        The server validates and creates this directory before saving.
      </p>
      <p className="muted small">
        If the backend runs as more than one process (multiple workers, containers, or replicas), make sure
        this path points at storage that is persistent and shared identically across all of them — otherwise
        downloads for files written by one process can report "file is missing on disk" to another.
      </p>
      <form onSubmit={save} className="storage-setting-form">
        <Field label="Upload directory path">
          <input required value={path} onChange={(e) => { setPath(e.target.value); setSaved(false) }} placeholder="/data/qa-portal/uploads" />
        </Field>
        <div className="storage-setting-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !path.trim() || path.trim() === settings?.upload_path}>
            {busy ? 'Validating…' : 'Save storage path'}
          </button>
          {settings && path !== settings.default_path && (
            <button type="button" className="btn" disabled={busy} onClick={() => setPath(settings.default_path)}>Use default</button>
          )}
          {saved && <span className="storage-setting-saved">✓ Storage path updated</span>}
        </div>
      </form>
      <ErrorText error={error} />
      {settings?.legacy_paths.length ? (
        <div className="storage-legacy-paths">
          <strong>Previous locations retained for existing downloads</strong>
          {settings.legacy_paths.map((legacy) => <code key={legacy}>{legacy}</code>)}
        </div>
      ) : null}
    </Card>
  )
}

// 2026-08 "Test Approval Workflow" refactor (spec section 10) -- Admin-only
// thresholds controlling when a pending Stage 1/Stage 2 review decision
// triggers a reminder vs. an escalation notification (see backend
// app/routers/notifications.py's own reminder/escalation sweep). Mirrors
// UploadStorageCard's own load/save/feedback pattern above; client-side
// validation here mirrors the backend's own checks in
// system_settings.py::update_approval_notification_settings exactly, so a
// bad combination is caught before the round-trip instead of only surfacing
// as a 400.
function ApprovalNotificationSettingsCard() {
  const [settings, setSettings] = useState<ApprovalNotificationSettingsOut | null>(null)
  const [reminderDays, setReminderDays] = useState('2')
  const [escalationDays, setEscalationDays] = useState('5')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    api.get<ApprovalNotificationSettingsOut>('/api/system-settings/approval-notifications').then((value) => {
      setSettings(value)
      setReminderDays(String(value.reminder_business_days))
      setEscalationDays(String(value.escalation_business_days))
    }).catch(setError)
  }, [])

  const reminderValue = Number(reminderDays)
  const escalationValue = Number(escalationDays)
  const validationError = !reminderDays.trim() || !escalationDays.trim()
    ? null
    : !Number.isFinite(reminderValue) || !Number.isFinite(escalationValue)
      ? 'Enter whole numbers of business days'
      : reminderValue < 1 || escalationValue < 1
        ? 'Both thresholds must be at least 1 business day'
        : escalationValue <= reminderValue
          ? 'Escalation threshold must be greater than the reminder threshold'
          : null

  const unchanged = !!settings && reminderValue === settings.reminder_business_days && escalationValue === settings.escalation_business_days

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (validationError) { setError(new Error(validationError)); return }
    setBusy(true); setSaved(false); setError(null)
    try {
      const value = await api.patch<ApprovalNotificationSettingsOut>('/api/system-settings/approval-notifications', {
        reminder_business_days: reminderValue,
        escalation_business_days: escalationValue,
      })
      setSettings(value)
      setReminderDays(String(value.reminder_business_days))
      setEscalationDays(String(value.escalation_business_days))
      setSaved(true)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><IconCheckCircle /> Approval Reminders & Escalation</span>}>
      <p className="muted small">
        Controls when a test case sitting at a pending review decision (In Review / Review Completed) triggers an
        in-app reminder, then an escalation notification, for whoever it's currently pending with. No email/SMS is
        sent -- notifications are in-app only (see the bell icon in the topbar).
      </p>
      <form onSubmit={save} className="storage-setting-form">
        <div className="form-row">
          <Field label="Reminder threshold (business days)">
            <input required type="number" min={1} value={reminderDays} onChange={(e) => { setReminderDays(e.target.value); setSaved(false) }} />
          </Field>
          <Field label="Escalation threshold (business days)">
            <input required type="number" min={1} value={escalationDays} onChange={(e) => { setEscalationDays(e.target.value); setSaved(false) }} />
          </Field>
        </div>
        {validationError && <p className="muted small" style={{ color: '#dc2626' }}>{validationError}</p>}
        <div className="storage-setting-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !!validationError || unchanged}>
            {busy ? 'Saving…' : 'Save thresholds'}
          </button>
          {saved && <span className="storage-setting-saved">✓ Thresholds updated</span>}
        </div>
      </form>
      <ErrorText error={error} />
    </Card>
  )
}

// Admin section: "add one functionality on admin section to upload excel
// and based on data present on excel Application name will be seed" -- lets
// an Admin bulk-load a spreadsheet of known-good Application Names straight
// into ApplicationMaster at APPROVED (see routers/applications.py::
// bulk_seed_application_names for exactly how existing pending/approved/
// rejected rows are each handled), instead of every name only ever entering
// the master list one at a time via a requester typing "Other" on the QA
// Request wizard and waiting on Application Owner review.
function ApplicationSeedCard() {
  const [file, setFile] = useState<File | null>(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<ApplicationSeedResult | null>(null)

  async function downloadTemplate() {
    setDownloadingTemplate(true)
    setError(null)
    try {
      await api.downloadFile('/api/application-names/bulk-seed-template', 'application_names_seed_template.xlsx')
    } catch (err) { setError(err) } finally { setDownloadingTemplate(false) }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { setError(new Error('Choose an .xlsx file first')); return }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.uploadForm<ApplicationSeedResult>('/api/application-names/bulk-seed', { file })
      setResult(res)
      setFile(null)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Application Names — Bulk Seed from Excel">
      <p className="muted small" style={{ marginTop: -4, marginBottom: 12 }}>
        Upload a spreadsheet of known-good Application Names to seed them straight into the master list at
        Approved — skips the usual Application Owner review, since an Admin bulk upload is asserting these are
        already valid. Expects an "Application Name" column (an optional "Department" column is also read).
        A name already awaiting approval elsewhere is approved outright; an already-Approved name is left
        untouched; a Rejected name is left untouched too — reinstate that one from its own request instead.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-sm" onClick={downloadTemplate} disabled={downloadingTemplate}>
          {downloadingTemplate ? 'Downloading…' : 'Download Template'}
        </button>
        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !file}>
          {busy ? 'Seeding…' : 'Upload & Seed'}
        </button>
      </form>
      <ErrorText error={error} />
      {result && (
        <div className="access-summary" aria-label="Application name seed result" style={{ marginBottom: 12 }}>
          <div><small>Created</small><strong>{result.created}</strong><span>New Approved names</span></div>
          <div><small>Approved existing</small><strong>{result.approved_existing}</strong><span>Cleared from a pending queue</span></div>
          <div><small>Already Approved</small><strong>{result.skipped_duplicate}</strong><span>Left untouched</span></div>
          <div className={result.skipped_rejected ? 'needs-attention' : ''}>
            <small>Previously Rejected</small><strong>{result.skipped_rejected}</strong><span>Left untouched</span>
          </div>
        </div>
      )}
      {result && result.skipped_invalid > 0 && (
        <p className="muted small">{result.skipped_invalid} row{result.skipped_invalid !== 1 ? 's' : ''} had no Application Name value and were skipped.</p>
      )}
      {result && result.created === 0 && result.approved_existing === 0 && result.failure_reason && (
        <div className="import-primary-reason" role="alert">
          <strong>Reason</strong>
          <p>{result.failure_reason}</p>
        </div>
      )}
      {result && result.errors.length > 0 && (
        <div className="import-issues" role="alert">
          <strong>Row-level detail</strong>
          <ul>{result.errors.map((message, idx) => <li key={idx}>{message}</li>)}</ul>
        </div>
      )}
    </Card>
  )
}

export default function Admin() {
  const { user } = useAuth()
  const [users, setUsers] = useState<UserOut[]>([])
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [resetTarget, setResetTarget] = useState<UserOut | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [userSearch, setUserSearch] = useState('')
  const [accountFilter, setAccountFilter] = useState<'ALL' | 'ACTIVE' | 'DISABLED' | 'REVIEW'>('ALL')
  const [loginFilter, setLoginFilter] = useState<'ALL' | 'STANDARD' | 'LDAP'>('ALL')
  const [section, setSection] = useState<'users' | 'departments' | 'storage' | 'applications' | 'approval-notifications'>('users')

  const load = useCallback(async () => {
    try {
      const rows = await api.get<UserOut[]>('/api/auth/users/all')
      // Surface accounts awaiting review first -- these are typically brand-new
      // LDAP logins that were auto-provisioned with the default low-privilege role.
      rows.sort((a, b) => Number(b.needs_role_review === true) - Number(a.needs_role_review === true))
      setUsers(rows)
    } catch (err) { setError(err) }
  }, [])

  const loadDepartments = useCallback(async () => {
    try {
      // /all (not the plain active-only /api/departments) so the manager
      // section below can show and re-activate deactivated rows too.
      const rows = await api.get<DepartmentOut[]>('/api/departments/all')
      setDepartments(rows)
    } catch (err) { setError(err) }
  }, [])

  const reviewCount = users.filter((u) => u.needs_role_review).length
  const activeCount = users.filter((u) => u.is_active).length
  const ldapCount = users.filter((u) => u.login_type === 'LDAP').length
  const departmentOptions = departments.filter((d) => d.is_active).map((d) => d.name)
  const filteredUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase()
    return users.filter((account) => {
      const matchesQuery = !query || [
        account.full_name,
        account.username,
        account.email,
        account.department,
        ...(account.roles || []).map((role) => ROLE_LABELS[role] || role),
      ].some((value) => String(value || '').toLowerCase().includes(query))
      const matchesAccount = accountFilter === 'ALL'
        || (accountFilter === 'ACTIVE' && account.is_active)
        || (accountFilter === 'DISABLED' && !account.is_active)
        || (accountFilter === 'REVIEW' && account.needs_role_review)
      const matchesLogin = loginFilter === 'ALL' || account.login_type === loginFilter
      return matchesQuery && matchesAccount && matchesLogin
    })
  }, [users, userSearch, accountFilter, loginFilter])
  const hasUserFilters = !!userSearch.trim() || accountFilter !== 'ALL' || loginFilter !== 'ALL'

  useEffect(() => { load(); loadDepartments() }, [load, loadDepartments])

  if (!hasRole(user, 'ADMIN')) {
    return (
      <Card title="Access Restricted">
        <p className="muted">The Admin section is only available to Administrator accounts.</p>
      </Card>
    )
  }

  async function patchUser(id: number, changes: Partial<UserOut>) {
    setError(null)
    setSavingId(id)
    try {
      const updated = await api.patch<UserOut>(`/api/auth/users/${id}`, changes)
      setUsers((rows) => rows.map((r) => (r.id === id ? updated : r)))
    } catch (err) {
      setError(err)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="access-page">
      <ErrorText error={error} />
      {section === 'users' && reviewCount > 0 && (
        <div className="alert-banner">
          <div className="icon-wrap"><IconWarning width={16} height={16} /></div>
          <div className="body">
            <div className="title">{reviewCount} account{reviewCount > 1 ? 's' : ''} need role review</div>
            <div className="sub">
              Auto-provisioned on first LDAP login with the default Requester role — assign the
              correct role below to grant proper access and clear the flag.
            </div>
          </div>
        </div>
      )}
      <PageHeader
        title="Users & Access" count={users.length}
        subtitle="Create accounts, control role and department access, and manage Standard or LDAP authentication from one workspace."
        actions={section === 'users' ? (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <IconPlus width={14} height={14} /> Create User
          </button>
        ) : undefined}
      />

      <nav className="access-workspace-nav" aria-label="Administration sections">
        <button type="button" className={section === 'users' ? 'active' : ''} onClick={() => setSection('users')}><IconLock /><span><strong>User Directory</strong><small>Accounts, roles and access</small></span><em>{users.length}</em></button>
        <button type="button" className={section === 'departments' ? 'active' : ''} onClick={() => setSection('departments')}><IconPlus /><span><strong>Departments</strong><small>Organisation structure</small></span><em>{departments.length}</em></button>
        <button type="button" className={section === 'storage' ? 'active' : ''} onClick={() => setSection('storage')}><IconFolder /><span><strong>Storage</strong><small>Document upload location</small></span></button>
        <button type="button" className={section === 'applications' ? 'active' : ''} onClick={() => setSection('applications')}><IconCheckCircle /><span><strong>Application Data</strong><small>Approved-name bulk setup</small></span></button>
        <button type="button" className={section === 'approval-notifications' ? 'active' : ''} onClick={() => setSection('approval-notifications')}><IconCheckCircle /><span><strong>Approval Notifications</strong><small>Reminder & escalation thresholds</small></span></button>
      </nav>

      {section === 'users' && <div className="access-workspace-panel">
      <div className="access-summary" aria-label="User account summary">
        <div><small>Total accounts</small><strong>{users.length}</strong><span>All provisioned users</span></div>
        <div><small>Active accounts</small><strong>{activeCount}</strong><span>Can access the portal</span></div>
        <div><small>LDAP accounts</small><strong>{ldapCount}</strong><span>Directory authenticated</span></div>
        <div className={reviewCount ? 'needs-attention' : ''}><small>Needs review</small><strong>{reviewCount}</strong><span>Role assignment required</span></div>
      </div>

      <div className="card access-users-card">
        <div className="access-card-heading">
          <div><span>Access directory</span><h3>User accounts</h3><p>Search a user, then update their department, roles, access ownership, or account status directly.</p></div>
          <strong>{filteredUsers.length} shown</strong>
        </div>
        <div className="access-user-toolbar">
          <label className="access-user-search">
            <IconSearch width={16} height={16} />
            <input
              aria-label="Search users by name, username, or email"
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              placeholder="Search by user name, username, email, department, or role…"
            />
            {userSearch && <button type="button" aria-label="Clear user search" onClick={() => setUserSearch('')}>×</button>}
          </label>
          <select aria-label="Filter by account status" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value as typeof accountFilter)}>
            <option value="ALL">All account statuses</option>
            <option value="ACTIVE">Active accounts</option>
            <option value="DISABLED">Disabled accounts</option>
            <option value="REVIEW">Needs role review</option>
          </select>
          <select aria-label="Filter by login type" value={loginFilter} onChange={(event) => setLoginFilter(event.target.value as typeof loginFilter)}>
            <option value="ALL">All login types</option>
            <option value="STANDARD">Standard</option>
            <option value="LDAP">LDAP</option>
          </select>
          {hasUserFilters && <button type="button" className="btn btn-sm" onClick={() => { setUserSearch(''); setAccountFilter('ALL'); setLoginFilter('ALL') }}>Clear filters</button>}
        </div>
        <Table
          rowKey="id"
          columns={[
            { key: 'full_name', header: 'Name', render: (u) => (
              <div className="access-user-identity">
                <span className="access-user-avatar" aria-hidden="true">{u.full_name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || u.username.slice(0, 2).toUpperCase()}</span>
                <div>
                  <strong>
                    {u.full_name}
                    {u.needs_role_review && <span className="badge badge-yellow">Needs Review</span>}
                  </strong>
                  <span>@{u.username}</span>
                  {u.email && <small>{u.email}</small>}
                </div>
              </div>
            ), filterValue: (u) => `${u.full_name} ${u.username} ${u.email || ''}` },
            { key: 'department', header: 'Department', render: (u) => (
              <div style={{ minWidth: 220 }}>
                <SearchableSelect
                  value={u.department || ''}
                  disabled={savingId === u.id}
                  onChange={(v) => patchUser(u.id, { department: v })}
                  options={departmentOptions}
                  placeholder="Not set"
                />
              </div>
            ) },
            { key: 'roles', header: 'Role(s)', render: (u) => (
              <div style={{ minWidth: 260 }}>
                <RoleChipSelect
                  value={u.roles || []}
                  disabled={savingId === u.id}
                  onChange={(v) => patchUser(u.id, { roles: v })}
                />
              </div>
            ), filterValue: (u) => (u.roles || []).join(' ') },
            { key: 'login_type', header: 'Login Type', render: (u) => (
              <span className={`badge ${u.login_type === 'LDAP' ? 'badge-blue' : 'badge-gray'}`}>
                {u.login_type === 'LDAP' ? 'LDAP' : 'Standard'}
              </span>
            ) },
            { key: 'admin_managed_only', header: 'Managed by Admin Only', render: (u) => (
              <button
                className={`btn btn-sm ${u.admin_managed_only ? 'btn-primary' : ''}`}
                disabled={savingId === u.id}
                title="When set to Yes, this user is hidden from Department Coordinator / Executive COE rosters -- only a System Admin can assign their role(s) or change their status."
                onClick={() => patchUser(u.id, { admin_managed_only: !u.admin_managed_only })}
              >
                {u.admin_managed_only ? 'Yes' : 'No'}
              </button>
            ), filterValue: (u) => u.admin_managed_only ? 'Yes' : 'No' },
            { key: 'is_active', header: 'Status', render: (u) => (
              <button
                className={`btn btn-sm ${u.is_active ? '' : 'btn-danger'}`}
                disabled={savingId === u.id || u.id === user?.id}
                title={u.id === user?.id ? "You can't deactivate your own account" : ''}
                onClick={() => patchUser(u.id, { is_active: !u.is_active })}
              >
                {u.is_active ? 'Active' : 'Disabled'}
              </button>
            ), filterValue: (u) => u.is_active ? 'Active' : 'Disabled' },
            { key: 'actions', header: '', filterable: false, render: (u) => (
              u.login_type === 'STANDARD' ? (
                <button className="btn btn-sm" onClick={() => setResetTarget(u)}>
                  <IconLock width={13} height={13} /> Reset Password
                </button>
              ) : <span className="muted small">Managed via LDAP</span>
            ) },
          ]}
          rows={filteredUsers}
        />
        {filteredUsers.length === 0 && (
          <div className="access-empty-search">
            <strong>No users match these filters</strong>
            <span>Try another name, username, email, department, role, or account status.</span>
            <button type="button" className="btn" onClick={() => { setUserSearch(''); setAccountFilter('ALL'); setLoginFilter('ALL') }}>Clear filters</button>
          </div>
        )}
      </div>
      </div>}

      {section === 'departments' && <div className="access-workspace-panel access-departments-section">
        <DepartmentManagerCard departments={departments} onChanged={loadDepartments} />
      </div>}

      {section === 'applications' && <div className="access-workspace-panel access-departments-section">
        <ApplicationSeedCard />
      </div>}

      {section === 'storage' && <div className="access-workspace-panel access-departments-section">
        <UploadStorageCard />
      </div>}

      {section === 'approval-notifications' && <div className="access-workspace-panel access-departments-section">
        <ApprovalNotificationSettingsCard />
      </div>}

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load() }}
          departmentOptions={departmentOptions}
        />
      )}
      {resetTarget && (
        <ResetPasswordModal
          userRow={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => { setResetTarget(null); load() }}
        />
      )}
    </div>
  )
}
