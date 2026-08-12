import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader } from '../../components/Common'
import { ROLE_LABELS, ALL_ROLES, LOGIN_TYPES, LOGIN_TYPE_LABELS, hasRole } from '../../constants'
import { IconPlus, IconLock, IconWarning, IconCheckCircle, IconSearch, IconFolder } from '../../components/Icons'
import { UserOut, UserSummaryOut, DepartmentOut, ApplicationMasterOut, ApplicationSeedResult, StorageSettingsOut, ApprovalNotificationSettingsOut } from '../../types'
import { usePaginatedList } from '../../hooks/usePaginatedList'

// Shared by every page that needs a department picker -- departments are
// DB-backed now (see backend app/models.py Department / routers/departments.py)
// instead of a hardcoded constants list, so this fetches the active set at
// call time. Exported so QARequests.tsx (and anywhere else) can reuse it
// instead of duplicating the fetch.
export async function loadActiveDepartments(): Promise<DepartmentOut[]> {
  return api.get<DepartmentOut[]>('/api/departments')
}

// `department` (singular) intentionally dropped from this form's own state
// -- 2026-08 "one user can be on multiple departments" CR moved department
// selection to its own `departments: string[]` state in CreateUserModal
// (DepartmentChipSelect), sent alongside this form's payload rather than
// living inside it.
const EMPTY_FORM = {
  username: '', full_name: '', email: '',
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

// 2026-08 "one user can be on multiple departments" CR -- mirrors
// RoleChipSelect's own checkbox-chip pattern above, just for a plain string
// list instead of a role-code-to-label lookup. The FIRST department a user
// is assigned acts as their "primary"/default wherever exactly one
// department is needed (e.g. a new QA Request) -- see backend
// models.User.primary_department -- so ordering here (the order chips were
// clicked in) matters; toggling one back off and on moves it to the end.
export function DepartmentChipSelect({ value, onChange, disabled, options }: {
  value: string[]; onChange: (departments: string[]) => void; disabled?: boolean; options: string[]
}) {
  function toggle(dept: string) {
    if (disabled) return
    const has = value.includes(dept)
    onChange(has ? value.filter((d) => d !== dept) : [...value, dept])
  }
  return (
    <div className="chip-select">
      {options.map((d) => {
        const active = value.includes(d)
        const primary = active && value[0] === d
        return (
          <label key={d} className={`chip-toggle ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}>
            <input type="checkbox" checked={active} disabled={disabled} onChange={() => toggle(d)} />
            <span className="chip-dot">{active && <IconCheckCircle width={9} height={9} strokeWidth={3} />}</span>
            {d}{primary && <small style={{ marginLeft: 4, opacity: 0.7 }}>(primary)</small>}
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
  const [departments, setDepartments] = useState<string[]>([])
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
      const payload: Partial<CreateUserForm> & { departments?: string[] } = { ...form, departments }
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
        </div>
        <Field label="Department(s) — a user may belong to more than one; the first one picked is their primary">
          <DepartmentChipSelect value={departments} onChange={setDepartments} options={departmentOptions} />
        </Field>
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

function ManageUserAccessModal({ userRow, departmentOptions, onClose, onDone }: {
  userRow: UserOut; departmentOptions: string[]; onClose: () => void; onDone: () => void
}) {
  const [departments, setDepartments] = useState<string[]>(userRow.departments?.length ? userRow.departments : (userRow.department ? [userRow.department] : []))
  const [roles, setRoles] = useState<string[]>(userRow.roles || [])
  const [adminManagedOnly, setAdminManagedOnly] = useState(!!userRow.admin_managed_only)
  const [active, setActive] = useState(userRow.is_active)
  const [departmentSearch, setDepartmentSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!roles.length) { setError(new Error('Select at least one role')); return }
    setBusy(true); setError(null)
    try {
      await api.patch(`/api/auth/users/${userRow.id}`, { departments, roles, admin_managed_only: adminManagedOnly, is_active: active })
      onDone()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  function toggleDepartment(department: string) {
    setDepartments((values) => values.includes(department) ? values.filter((value) => value !== department) : [...values, department])
  }

  function makePrimary(department: string) {
    setDepartments((values) => [department, ...values.filter((value) => value !== department)])
  }

  function toggleRole(role: string) {
    setRoles((values) => values.includes(role) ? values.filter((value) => value !== role) : [...values, role])
  }

  const visibleDepartments = departmentOptions.filter((department) => department.toLowerCase().includes(departmentSearch.trim().toLowerCase()))

  return <Modal title={`Manage access — ${userRow.full_name}`} onClose={onClose}>
    <form onSubmit={save} className="access-manage-form">
      <div className="access-manage-identity"><span className="access-user-avatar">{userRow.full_name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span><div><strong>{userRow.full_name}</strong><span>@{userRow.username}</span><small>{userRow.email || 'No email address'}</small></div></div>
      <section className="access-picker-panel">
        <header><div><small>01 · Organisational scope</small><h3>Department access</h3><p>Select one or more departments. Set one selected department as primary.</p></div><strong>{departments.length} selected</strong></header>
        <label className="access-picker-search"><IconSearch width={14} height={14} /><input value={departmentSearch} onChange={(event) => setDepartmentSearch(event.target.value)} placeholder="Find a department…" /></label>
        <div className="access-department-options">
          {visibleDepartments.map((department) => {
            const selected = departments.includes(department)
            const primary = departments[0] === department
            return <div className={`access-option-row ${selected ? 'selected' : ''}`} key={department}>
              <label><input type="checkbox" checked={selected} disabled={busy} onChange={() => toggleDepartment(department)} /><span>{department}</span></label>
              {primary ? <strong>Primary</strong> : selected ? <button type="button" onClick={() => makePrimary(department)}>Make primary</button> : null}
            </div>
          })}
        </div>
      </section>
      <section className="access-picker-panel">
        <header><div><small>02 · Permission profile</small><h3>Roles</h3><p>Assign the responsibilities this user can perform.</p></div><strong>{roles.length} selected</strong></header>
        <div className="access-role-options">{ALL_ROLES.map((role) => <label className={roles.includes(role) ? 'selected' : ''} key={role}><input type="checkbox" checked={roles.includes(role)} disabled={busy} onChange={() => toggleRole(role)} /><span>{ROLE_LABELS[role] || role}</span></label>)}</div>
      </section>
      <div className="access-manage-controls">
        <label><input type="checkbox" checked={adminManagedOnly} onChange={(event) => setAdminManagedOnly(event.target.checked)} disabled={busy} /><span><strong>Admin-managed account</strong><small>Hide from local department coordinator rosters.</small></span></label>
        <label><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={busy} /><span><strong>Active account</strong><small>User can sign in and access permitted modules.</small></span></label>
      </div>
      <ErrorText error={error} />
      <div className="modal-actions access-manage-actions"><span>Changes apply after saving.</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save access'}</button></div>
    </form>
  </Modal>
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
function ApplicationSeedCard({ departmentOptions }: { departmentOptions: string[] }) {
  const [file, setFile] = useState<File | null>(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<ApplicationSeedResult | null>(null)
  const [applications, setApplications] = useState<ApplicationMasterOut[]>([])
  const [applicationSearch, setApplicationSearch] = useState('')
  const [draftDepartments, setDraftDepartments] = useState<Record<number, string>>({})
  const [savingApplicationId, setSavingApplicationId] = useState<number | null>(null)
  const [savedApplicationId, setSavedApplicationId] = useState<number | null>(null)

  const loadApplications = useCallback(async () => {
    try {
      const rows = await api.get<ApplicationMasterOut[]>('/api/application-names')
      setApplications(rows)
      setDraftDepartments(Object.fromEntries(rows.map((row) => [row.id, row.department || ''])))
    } catch (err) { setError(err) }
  }, [])

  useEffect(() => { loadApplications() }, [loadApplications])

  async function updateDepartment(application: ApplicationMasterOut) {
    const department = draftDepartments[application.id] || ''
    if (!department) { setError(new Error('Select a department')); return }
    setSavingApplicationId(application.id); setSavedApplicationId(null); setError(null)
    try {
      const updated = await api.patch<ApplicationMasterOut>(`/api/application-names/${application.id}/department`, { department })
      setApplications((rows) => rows.map((row) => row.id === updated.id ? updated : row))
      setSavedApplicationId(application.id)
    } catch (err) { setError(err) } finally { setSavingApplicationId(null) }
  }

  const visibleApplications = applications.filter((application) => (
    `${application.name} ${application.department || ''}`.toLowerCase().includes(applicationSearch.trim().toLowerCase())
  ))

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
      <div className="application-department-manager">
        <div className="application-department-head">
          <div><small>Existing application master</small><h3>Application departments</h3><p>Assign or correct the owning department for an application already available in the system.</p></div>
          <strong>{applications.length} applications</strong>
        </div>
        <label className="application-department-search">
          <IconSearch width={15} height={15} />
          <input value={applicationSearch} onChange={(event) => setApplicationSearch(event.target.value)} placeholder="Search application or department…" />
        </label>
        <div className="application-department-list">
          {visibleApplications.map((application) => {
            const selected = draftDepartments[application.id] || ''
            const unchanged = selected === (application.department || '')
            return <div className="application-department-row" key={application.id}>
              <div><strong>{application.name}</strong><small>{application.department || 'Department not assigned'}</small></div>
              <select value={selected} onChange={(event) => { setDraftDepartments((values) => ({ ...values, [application.id]: event.target.value })); setSavedApplicationId(null) }}>
                <option value="">Select department</option>
                {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
              </select>
              <button type="button" className="btn btn-sm btn-primary" disabled={!selected || unchanged || savingApplicationId === application.id} onClick={() => updateDepartment(application)}>
                {savingApplicationId === application.id ? 'Updating…' : 'Update'}
              </button>
              {savedApplicationId === application.id && <span className="application-department-saved">✓ Updated</span>}
            </div>
          })}
          {!visibleApplications.length && <div className="empty-state compact"><strong>No applications found</strong><span>Try another application name or department.</span></div>}
        </div>
      </div>
    </Card>
  )
}

export default function Admin() {
  const { user } = useAuth()
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [summary, setSummary] = useState<UserSummaryOut | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [resetTarget, setResetTarget] = useState<UserOut | null>(null)
  const [accessTarget, setAccessTarget] = useState<UserOut | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [userSearch, setUserSearch] = useState('')
  const [accountFilter, setAccountFilter] = useState<'ALL' | 'ACTIVE' | 'DISABLED' | 'REVIEW'>('ALL')
  const [loginFilter, setLoginFilter] = useState<'ALL' | 'STANDARD' | 'LDAP'>('ALL')
  const [section, setSection] = useState<'users' | 'departments' | 'storage' | 'applications' | 'approval-notifications'>('users')

  // SRS 7.2 pagination rollout -- the user directory is now server-paginated
  // and server-filtered (search/account status/login type all become query
  // params instead of an in-browser .filter() over the whole directory).
  // "Surface accounts awaiting review first" is now the backend's own
  // default sort (needs_role_review desc, then name) rather than a
  // client-side .sort() after fetching everything.
  const {
    items: rows, page, pageSize, total, totalPages, hasNext, hasPrevious,
    loading: usersLoading, setPage, setPageSize, reload: reloadUsers,
  } = usePaginatedList<UserOut>('/api/auth/users/all', {
    search: userSearch,
    extra: {
      account_filter: accountFilter === 'ALL' ? undefined : accountFilter.toLowerCase(),
      login_type: loginFilter === 'ALL' ? undefined : loginFilter,
    },
  })
  const loadSummary = useCallback(() => {
    api.get<UserSummaryOut>('/api/auth/users/summary').then(setSummary).catch(setError)
  }, [])
  const refreshUsers = useCallback(() => { reloadUsers(); loadSummary() }, [reloadUsers, loadSummary])
  useEffect(() => { loadSummary() }, [loadSummary])

  const loadDepartments = useCallback(async () => {
    try {
      // /all (not the plain active-only /api/departments) so the manager
      // section below can show and re-activate deactivated rows too.
      const rows = await api.get<DepartmentOut[]>('/api/departments/all')
      setDepartments(rows)
    } catch (err) { setError(err) }
  }, [])

  const reviewCount = summary?.review_count || 0
  const activeCount = summary?.active_count || 0
  const ldapCount = summary?.ldap_count || 0
  const departmentOptions = departments.filter((d) => d.is_active).map((d) => d.name)
  const hasUserFilters = !!userSearch.trim() || accountFilter !== 'ALL' || loginFilter !== 'ALL'

  useEffect(() => { loadDepartments() }, [loadDepartments])

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
      // SRS 7.2 pagination rollout -- `rows` only ever holds the current
      // page, so a mutation reloads it (+ the summary strip) instead of
      // patching a locally-held full array, matching every other mutation
      // handler in this rollout.
      await api.patch<UserOut>(`/api/auth/users/${id}`, changes)
      refreshUsers()
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
        title="Users & Access" count={summary?.total || 0}
        subtitle="Create accounts, control role and department access, and manage Standard or LDAP authentication from one workspace."
        actions={section === 'users' ? (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <IconPlus width={14} height={14} /> Create User
          </button>
        ) : undefined}
      />

      <nav className="access-workspace-nav" aria-label="Administration sections">
        <button type="button" className={section === 'users' ? 'active' : ''} onClick={() => setSection('users')}><IconLock /><span><strong>User Directory</strong><small>Accounts, roles and access</small></span><em>{summary?.total || 0}</em></button>
        <button type="button" className={section === 'departments' ? 'active' : ''} onClick={() => setSection('departments')}><IconPlus /><span><strong>Departments</strong><small>Organisation structure</small></span><em>{departments.length}</em></button>
        <button type="button" className={section === 'storage' ? 'active' : ''} onClick={() => setSection('storage')}><IconFolder /><span><strong>Storage</strong><small>Document upload location</small></span></button>
        <button type="button" className={section === 'applications' ? 'active' : ''} onClick={() => setSection('applications')}><IconCheckCircle /><span><strong>Application Data</strong><small>Approved-name bulk setup</small></span></button>
        <button type="button" className={section === 'approval-notifications' ? 'active' : ''} onClick={() => setSection('approval-notifications')}><IconCheckCircle /><span><strong>Approval Notifications</strong><small>Reminder & escalation thresholds</small></span></button>
      </nav>

      {section === 'users' && <div className="access-workspace-panel">
      <div className="access-summary" aria-label="User account summary">
        <div><small>Total accounts</small><strong>{summary?.total || 0}</strong><span>All provisioned users</span></div>
        <div><small>Active accounts</small><strong>{activeCount}</strong><span>Can access the portal</span></div>
        <div><small>LDAP accounts</small><strong>{ldapCount}</strong><span>Directory authenticated</span></div>
        <div className={reviewCount ? 'needs-attention' : ''}><small>Needs review</small><strong>{reviewCount}</strong><span>Role assignment required</span></div>
      </div>

      <div className="card access-users-card">
        <div className="access-card-heading">
          <div><span>Access directory</span><h3>User accounts</h3><p>Search a user, then update their department, roles, access ownership, or account status directly.</p></div>
          <strong>{total} shown</strong>
        </div>
        <div className="access-user-toolbar">
          <label className="access-user-search">
            <IconSearch width={16} height={16} />
            <input
              aria-label="Search users by name, username, or email"
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              placeholder="Search by user name, username, email, or department…"
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
          server={{ page, pageSize, total, totalPages, hasNext, hasPrevious, onPageChange: setPage, onPageSizeChange: setPageSize, loading: usersLoading }}
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
            { key: 'department', header: 'Access scope', render: (u) => {
              const values = u.departments?.length ? u.departments : (u.department ? [u.department] : [])
              return <div className="access-scope-summary"><strong>{values[0] || 'No department'}</strong>{values.length > 1 && <span>+{values.length - 1} additional</span>}<small>Primary department</small></div>
            }, filterValue: (u) => (u.departments && u.departments.length ? u.departments : (u.department ? [u.department] : [])).join(' ') },
            { key: 'roles', header: 'Roles', render: (u) => (
              <div className="access-role-summary">{(u.roles || []).slice(0, 2).map((role) => <span key={role}>{ROLE_LABELS[role] || role}</span>)}{(u.roles || []).length > 2 && <small>+{(u.roles || []).length - 2} more</small>}</div>
            ), filterValue: (u) => (u.roles || []).join(' ') },
            { key: 'login_type', header: 'Login Type', render: (u) => (
              <span className={`badge ${u.login_type === 'LDAP' ? 'badge-blue' : 'badge-gray'}`}>
                {u.login_type === 'LDAP' ? 'LDAP' : 'Standard'}
              </span>
            ) },
            { key: 'is_active', header: 'Status', render: (u) => (
              <div className="access-status-summary"><span className={`badge ${u.is_active ? 'badge-green' : 'badge-red'}`}>{u.is_active ? 'Active' : 'Disabled'}</span>{u.admin_managed_only && <small>Admin managed</small>}</div>
            ), filterValue: (u) => u.is_active ? 'Active' : 'Disabled' },
            { key: 'actions', header: 'Actions', filterable: false, render: (u) => <div className="access-row-actions"><button className="btn btn-sm btn-primary" onClick={() => setAccessTarget(u)}>Manage access</button>{u.login_type === 'STANDARD' && <button className="btn btn-sm" onClick={() => setResetTarget(u)}><IconLock width={13} height={13} /> Reset password</button>}</div> },
          ]}
          rows={rows}
        />
        {rows.length === 0 && (
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
        <ApplicationSeedCard departmentOptions={departmentOptions} />
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
          onCreated={() => { setShowCreate(false); refreshUsers() }}
          departmentOptions={departmentOptions}
        />
      )}
      {accessTarget && <ManageUserAccessModal userRow={accessTarget} departmentOptions={departmentOptions} onClose={() => setAccessTarget(null)} onDone={() => { setAccessTarget(null); refreshUsers() }} />}
      {resetTarget && (
        <ResetPasswordModal
          userRow={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => { setResetTarget(null); refreshUsers() }}
        />
      )}
    </div>
  )
}
