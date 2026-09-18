import './RoleSelector.css'
import WorkspaceDefectWorkflow from '../../components/WorkspaceDefectWorkflow'
import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader, type TableColumn } from '../../components/Common'
import { ROLE_LABELS, ALL_ROLES, LOGIN_TYPES, LOGIN_TYPE_LABELS, hasRole, isSelectableUser, uniqueWorkspaceAccess } from '../../constants'
import { IconPlus, IconLock, IconWarning, IconCheckCircle, IconSearch, IconUsers } from '../../components/Icons'
import { UserOut, UserSummaryOut, DepartmentOut, ApplicationMasterOut, ApplicationSeedResult, QAWorkspaceOut } from '../../types'
import { usePaginatedList } from '../../hooks/usePaginatedList'
import SearchableSelect from '../../components/SearchableSelect'
import UserAssignSelect from '../../components/UserAssignSelect'
import ClearableSearchInput from '../../components/ClearableSearchInput'

function CoordinatorRolePolicy() {
  const [roles, setRoles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const options = ALL_ROLES.filter(role => !['ADMIN', 'SCALE_6_PLUS', 'VIEW_ONLY'].includes(role))
  useEffect(() => {
    let active = true
    api.get<string[]>('/api/auth/local-admin/assignable-roles')
      .then(value => { if (active) { setRoles(value); setLoading(false) } })
      .catch(err => { if (active) setError(err) })
    return () => { active = false }
  }, [])
  async function save() {
    setBusy(true); setError(null); setSaved(false)
    try {
      const value = await api.put<string[]>('/api/auth/local-admin/assignable-roles', roles)
      setRoles(value); setSaved(true)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <section className="workflow-panel"><h4>Roles coordinators may assign</h4>
    <p>This system-wide setting applies to all department coordinators. Their department and workspace access boundaries still apply. Administrator and confidential roles remain System Admin only.</p>
    <p className="muted small">Removing a role here prevents future coordinator assignments; it does not remove roles already assigned to users. An empty selection disables role assignment by coordinators.</p>
    <ErrorText error={error} />
    {loading ? <p>Loading role policy…</p> : <><RoleChipSelect value={roles} roles={options} disabled={busy} onChange={value => { setRoles(value); setSaved(false) }} /><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save coordinator role policy'}</button></>}
    {saved && <p role="status">Role policy saved. Coordinators will see the updated choices when they reopen their user management page.</p>}
  </section>
}

type AdminSection = 'users' | 'departments' | 'workspaces' | 'applications' | 'email'
type WorkspacePanel = 'members' | 'administrators' | 'settings'
type WorkspaceMemberView = 'current' | 'add'
const ADMIN_SECTIONS: AdminSection[] = ['users', 'departments', 'workspaces', 'applications', 'email']

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
const DOCUMENT_PORTAL_ROLE_CODES = new Set([
  'DOCUMENT_PORTAL_VIEWER', 'DOCUMENT_PORTAL_CONTRIBUTOR', 'DOCUMENT_PORTAL_MANAGER',
])

function rolesAfterToggle(values: string[], role: string): string[] {
  if (values.includes(role)) return values.filter((value) => value !== role)
  if (role === 'VIEW_ONLY') {
    return ['VIEW_ONLY', ...values.filter((value) => DOCUMENT_PORTAL_ROLE_CODES.has(value))]
  }
  if (DOCUMENT_PORTAL_ROLE_CODES.has(role)) return [...values, role]
  return [...values.filter((value) => value !== 'VIEW_ONLY'), role]
}

// `roles` defaults to every assignable role (ALL_ROLES) -- exported with that
// default so DepartmentAdmin.tsx can reuse this same chip-select, just
// restricted to whichever of DEPARTMENT_ADMIN_ASSIGNABLE_ROLES /
// QA_ADMIN_ASSIGNABLE_ROLES applies to the logged-in local admin, instead of
// duplicating the checkbox/styling logic for its own narrower role picker.
export function RoleChipSelect({ value, onChange, disabled, disabledRoles = [], roles = ALL_ROLES }: {
  value: string[]; onChange: (roles: string[]) => void; disabled?: boolean; disabledRoles?: string[]; roles?: string[]
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const label = (role: string) => ROLE_LABELS[role] || role
  const groups: [string, string[]][] = [
    ['Business & delivery', ['REQUESTER', 'DEVELOPER', 'BUSINESS_ANALYST', 'APPLICATION_OWNER', 'SM', 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM']],
    ['Quality & security', ['QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'CHIEF_MANAGER_QA', 'AGM_QA']],
    ['Other permissions', roles.filter(role => !['REQUESTER', 'DEVELOPER', 'BUSINESS_ANALYST', 'APPLICATION_OWNER', 'SM', 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM', 'QA_ENGINEER', 'QA_LEAD', 'SECURITY_ANALYST', 'CHIEF_MANAGER_QA', 'AGM_QA'].includes(role))],
  ]
  const visibleGroups = groups.map(([name, entries]) => [name, entries.filter(role => roles.includes(role) && (!selectedOnly || draft.includes(role)) && label(role).toLowerCase().includes(query.trim().toLowerCase()))] as [string, string[]]).filter(([, entries]) => entries.length)
  function toggle(role: string) {
    if (disabled || disabledRoles.includes(role)) return
    const next = rolesAfterToggle(draft, role)
    if (disabledRoles.some(locked => draft.includes(locked) !== next.includes(locked))) return
    setDraft(next)
  }
  const added = draft.filter(role => !value.includes(role)).length
  const removed = value.filter(role => !draft.includes(role)).length
  return <div className="role-access-control">
    <div className="role-access-summary">
      <span className="role-access-count" aria-label={`${value.length} selected roles`}>{value.length}</span>
      <div className="role-access-names">{value.length ? <>{value.slice(0, 2).map(role => <span key={role}>{label(role)}</span>)}{value.length > 2 && <small title={value.slice(2).map(label).join(', ')}>+{value.length - 2} more</small>}</> : <span className="role-access-empty">No roles selected</span>}</div>
      <button type="button" className="role-access-edit" disabled={disabled} onClick={() => { setDraft([...value]); setQuery(''); setSelectedOnly(false); setOpen(true) }} aria-label="Manage selected roles">Manage</button>
    </div>
    {open && <Modal title="Manage roles" variant="dialog" compact onClose={() => setOpen(false)} preventBackdropClose>
      <div className="role-editor">
        <p>Select the roles this user needs. Review your changes before applying.</p>
        <div className="role-editor-tools"><input autoFocus aria-label="Search roles" placeholder="Find a role…" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" aria-pressed={selectedOnly} onClick={() => setSelectedOnly(!selectedOnly)}>Selected <b>{draft.length}</b></button></div>
        <div className="role-editor-options">
          {visibleGroups.map(([name, entries]) => <fieldset key={name}><legend>{name}</legend>{entries.map(role => {
            const next = rolesAfterToggle(draft, role)
            const locked = !!disabled || disabledRoles.includes(role) || disabledRoles.some(code => draft.includes(code) !== next.includes(code))
            return <label key={role} className={`role-editor-option${draft.includes(role) ? ' selected' : ''}${locked ? ' locked' : ''}`}><input type="checkbox" checked={draft.includes(role)} disabled={locked} onChange={() => toggle(role)} /><span>{label(role)}</span>{disabledRoles.includes(role) && <small>Protected</small>}</label>
          })}</fieldset>)}
          {!visibleGroups.length && <p className="role-editor-empty">{selectedOnly ? 'No selected roles match this view.' : 'No roles match your search.'}</p>}
        </div>
        <div className="role-editor-footer"><span>{added || removed ? `${added} added · ${removed} removed` : 'No changes'}<small>{draft.length} role{draft.length === 1 ? '' : 's'} selected</small></span><div><button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn btn-primary btn-sm" disabled={disabled || (!added && !removed)} onClick={() => { onChange(draft); setOpen(false) }}>Apply roles</button></div></div>
      </div>
    </Modal>}
  </div>
}


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

function CreateUserModal({ onClose, onCreated, departmentOptions, departmentRows }: {
  onClose: () => void; onCreated: (u: UserOut) => void; departmentOptions: string[]; departmentRows: DepartmentOut[]
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
      const created = await api.createUser<UserOut>({ ...form, departments })
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
        <p className="muted small">Roles define what the user can do. Add the user to one or more workspaces to define where those roles apply. Document Portal permissions remain separate.</p>
        <div className="form-row" style={{ marginTop: 12 }}>
          <Field label="Login Type">
            <SearchableSelect ariaLabel="Login type" value={form.login_type} onChange={(value) => set('login_type', value)} options={LOGIN_TYPES.map((type) => ({ value: type, label: LOGIN_TYPE_LABELS[type] }))} searchable={false} />
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
      await api.resetUserPassword(userRow.id, newPassword)
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

function ManageUserAccessModal({ userRow, currentUserId, departmentOptions, departmentRows, onClose, onDone }: {
  userRow: UserOut; currentUserId: number; departmentOptions: string[]; departmentRows: DepartmentOut[]; onClose: () => void; onDone: () => void
}) {
  const [email, setEmail] = useState(userRow.email || '')
  const [departments, setDepartments] = useState<string[]>(userRow.departments?.length ? userRow.departments : (userRow.department ? [userRow.department] : []))
  const [roles, setRoles] = useState<string[]>(userRow.roles || [])
  const [adminManagedOnly, setAdminManagedOnly] = useState(!!userRow.admin_managed_only)
  const [showInUserDropdowns, setShowInUserDropdowns] = useState(userRow.show_in_user_dropdowns !== false)
  const [active, setActive] = useState(userRow.is_active)
  const [departmentSearch, setDepartmentSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [unlockMessage, setUnlockMessage] = useState('')
  async function unlockLogin() {
    setBusy(true); setError(null); setUnlockMessage('')
    try {
      const result = await api.post<{ message: string }>(`/api/auth/users/${userRow.id}/unlock-login`, {})
      setUnlockMessage(result.message)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  const isOwnAdminAccount = userRow.id === currentUserId && (userRow.roles || []).includes('ADMIN')
  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!roles.length) { setError(new Error('Select at least one role')); return }
    setBusy(true); setError(null)
    try {
      await api.patch(`/api/auth/users/${userRow.id}`, { email: email.trim() || null, departments, roles, admin_managed_only: adminManagedOnly, show_in_user_dropdowns: showInUserDropdowns, is_active: active })
      onDone()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  function toggleDepartment(department: string) {
    setDepartments((values) => {
      const next = values.includes(department) ? values.filter((value) => value !== department) : [...values, department]
      return next
    })
  }

  function makePrimary(department: string) {
    setDepartments((values) => [department, ...values.filter((value) => value !== department)])
  }

  function toggleRole(role: string) {
    if (isOwnAdminAccount && (role === 'ADMIN' || role === 'VIEW_ONLY')) return
    setRoles((values) => {
      return rolesAfterToggle(values, role)
    })
  }

  const visibleDepartments = departmentOptions.filter((department) => department.toLowerCase().includes(departmentSearch.trim().toLowerCase()))
  const workspaceAccess = uniqueWorkspaceAccess(userRow)

  return <Modal title={`Manage access — ${userRow.full_name}`} onClose={onClose}>
    <form onSubmit={save} className="access-manage-form">
      <div className="access-manage-identity"><span className="access-user-avatar">{userRow.full_name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span><div><strong>{userRow.full_name}</strong><span>@{userRow.username}</span><small>{userRow.email || 'No email address'}</small></div></div>
      <Field label="Notification email">
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
      </Field>
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
        <header><div><small>02 · Permission profile</small><h3>Roles</h3><p>Choose what this user can do in every workspace they can access.</p></div><strong>{roles.length} selected</strong></header>
        {isOwnAdminAccount && <p className="muted small">Your own Administrator access is protected. Only another Administrator can remove it or deactivate this account.</p>}
        <p className="muted small">Roles do not grant access to another workspace. Workspace membership controls which workspace data the user can see.</p>
        <div className="access-role-options">{ALL_ROLES.map((role) => {
          const protectedSelfRole = isOwnAdminAccount && (role === 'ADMIN' || role === 'VIEW_ONLY')
          return <label className={`${roles.includes(role) ? 'selected' : ''} ${protectedSelfRole ? 'disabled' : ''}`} key={role} title={protectedSelfRole ? 'Another Administrator must change your Administrator access.' : undefined}><input type="checkbox" checked={roles.includes(role)} disabled={busy || protectedSelfRole} onChange={() => toggleRole(role)} /><span>{ROLE_LABELS[role] || role}</span></label>
        })}</div>
      </section>
      <section className="access-picker-panel access-workspace-summary">
        <header><div><small>03 · Workspace access</small><h3>Where these roles apply</h3><p>Manage membership from the Workspaces section. This screen manages the permission profile only.</p></div><strong>{workspaceAccess.filter((row) => row.is_active).length} workspace{workspaceAccess.filter((row) => row.is_active).length === 1 ? '' : 's'}</strong></header>
        <div className="access-workspace-badges">
          {workspaceAccess.filter((row) => row.is_active).map((row) => <span key={row.workspace_id}>{row.workspace_name || row.workspace_key}</span>)}
          {!workspaceAccess.some((row) => row.is_active) && <span className="empty">No workspace access</span>}
        </div>
      </section>
      <div className="access-manage-controls">
        <label><input type="checkbox" checked={showInUserDropdowns} onChange={(event) => setShowInUserDropdowns(event.target.checked)} disabled={busy} /><span><strong>Show in assignment dropdowns</strong><small>Allow this account to be selected for workflow and ownership assignments.</small></span></label>
        <label><input type="checkbox" checked={adminManagedOnly} onChange={(event) => setAdminManagedOnly(event.target.checked)} disabled={busy} /><span><strong>Admin-managed account</strong><small>Hide from local department coordinator rosters.</small></span></label>
        <label title={isOwnAdminAccount ? 'Another Administrator must deactivate your account.' : undefined}><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={busy || isOwnAdminAccount} /><span><strong>Active account</strong><small>{isOwnAdminAccount ? 'Another Administrator must deactivate your account.' : 'User can sign in and access permitted modules.'}</small></span></label>
      </div>
      <section className="access-picker-panel">
        <h3>Sign-in recovery</h3>
        <p>Five failed attempts from the same IP address within 15 minutes temporarily block sign-in. Clear this user's failed attempts across all IP addresses to let them retry now.</p>
        <button type="button" className="btn" disabled={busy} onClick={unlockLogin}>Unlock sign-in now</button>
        <p>This takes effect immediately. It does not reset the password, activate a disabled account, or unlock an account in the bank directory.</p>
        {unlockMessage && <p role="status">{unlockMessage}</p>}
      </section>
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
      <ErrorText error={error} />
      <section className="organization-panel">
      <p className="muted small">
        Create the main business departments used across users, requests, and approvals. Inactive departments remain on historical records.
      </p>
      <form onSubmit={addDepartment} className="organization-create-row">
        <input
          style={{ flex: 1 }}
          placeholder="Department name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !newName.trim()}>
          <IconPlus width={13} height={13} /> Add department
        </button>
      </form>
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
      </section>
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
function ApplicationSeedCard({ departmentOptions, departments }: { departmentOptions: string[]; departments: DepartmentOut[] }) {
  const [newApplicationName, setNewApplicationName] = useState('')
  const [newApplicationDepartment, setNewApplicationDepartment] = useState('')
  const [creatingApplication, setCreatingApplication] = useState(false)
  const [createSuccess, setCreateSuccess] = useState('')
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
  // "edit option for renaming the application name" -- per-row inline
  // rename input, mirrors the draftDepartments/savingApplicationId/
  // savedApplicationId triple already used for the department column.
  const [draftNames, setDraftNames] = useState<Record<number, string>>({})
  const [renamingApplicationId, setRenamingApplicationId] = useState<number | null>(null)
  const [renamedApplicationId, setRenamedApplicationId] = useState<number | null>(null)

  // "active inactive department option" -- a row's assigned department can
  // be deactivated later from the Departments section without this list
  // knowing; look it up by name so a stale/deactivated department is
  // flagged instead of silently looking like any other value.
  const departmentActiveByName = Object.fromEntries(departments.map((d) => [d.name, d.is_active]))

  const loadApplications = useCallback(async () => {
    try {
      const rows = await api.get<ApplicationMasterOut[]>('/api/application-names')
      setApplications(rows)
      setDraftDepartments(Object.fromEntries(rows.map((row) => [row.id, row.department || ''])))
      setDraftNames(Object.fromEntries(rows.map((row) => [row.id, row.name])))
    } catch (err) { setError(err) }
  }, [])

  useEffect(() => { loadApplications() }, [loadApplications])

  async function createApplication(e: React.FormEvent) {
    e.preventDefault()
    const name = newApplicationName.trim()
    if (!name) { setError(new Error('Enter an application name')); return }
    if (!newApplicationDepartment) { setError(new Error('Select the owning department')); return }
    setCreatingApplication(true)
    setCreateSuccess('')
    setError(null)
    try {
      const created = await api.post<ApplicationMasterOut>('/api/application-names', {
        name,
        department: newApplicationDepartment,
      })
      await loadApplications()
      setNewApplicationName('')
      setNewApplicationDepartment('')
      setCreateSuccess(`${created.name} was added to the approved application master.`)
    } catch (err) {
      setError(err)
    } finally {
      setCreatingApplication(false)
    }
  }

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

  async function renameApplication(application: ApplicationMasterOut) {
    const name = (draftNames[application.id] || '').trim()
    if (!name) { setError(new Error('Application name is required')); return }
    setRenamingApplicationId(application.id); setRenamedApplicationId(null); setError(null)
    try {
      const updated = await api.patch<ApplicationMasterOut>(`/api/application-names/${application.id}/name`, { name })
      setApplications((rows) => rows.map((row) => row.id === updated.id ? updated : row))
      setDraftNames((values) => ({ ...values, [application.id]: updated.name }))
      setRenamedApplicationId(application.id)
    } catch (err) { setError(err) } finally { setRenamingApplicationId(null) }
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
      if (res.created || res.approved_existing) await loadApplications()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Application Names" subtitle="Maintain the approved application list used across requests and test management.">
      <section className="application-create-section">
        <div className="application-create-heading">
          <div>
            <small>Add one application</small>
            <h3>New application name</h3>
            <p>Add a known application directly to the approved master list.</p>
          </div>
        </div>
        <form className="application-create-form" onSubmit={createApplication}>
          <Field label="Application name *">
            <input
              value={newApplicationName}
              onChange={(event) => { setNewApplicationName(event.target.value); setCreateSuccess('') }}
              placeholder="e.g. MOBILE BANKING"
              maxLength={150}
              disabled={creatingApplication}
            />
          </Field>
          <Field label="Owning department *">
            <SearchableSelect
              ariaLabel="Owning department"
              value={newApplicationDepartment}
              onChange={(value) => { setNewApplicationDepartment(value); setCreateSuccess('') }}
              options={departmentOptions.map((department) => ({ value: department, label: department }))}
              placeholder="Select department"
              disabled={creatingApplication}
            />
          </Field>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creatingApplication || !newApplicationName.trim() || !newApplicationDepartment}
          >
            <IconPlus width={15} height={15} />
            {creatingApplication ? 'Adding…' : 'Add application'}
          </button>
        </form>
        {createSuccess && <div className="document-upload-summary application-create-success" role="status"><strong>✓ {createSuccess}</strong></div>}
        <ErrorText error={error} />
      </section>

      <section className="application-bulk-section">
        <div className="application-create-heading">
          <div>
            <small>Add many applications</small>
            <h3>Bulk seed from Excel</h3>
          </div>
        </div>
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
      </section>
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
            const deptIsInactive = !!application.department && departmentActiveByName[application.department] === false
            const nameDraft = draftNames[application.id] ?? application.name
            const nameUnchanged = nameDraft.trim() === application.name
            return <div className="application-department-row" key={application.id}>
              <div className="application-department-rename">
                <input
                  className="application-name-input"
                  value={nameDraft}
                  onChange={(event) => { setDraftNames((values) => ({ ...values, [application.id]: event.target.value })); setRenamedApplicationId(null) }}
                />
                <small>
                  {application.department || 'Department not assigned'}
                  {deptIsInactive && <span className="application-department-inactive-badge"> · Inactive department</span>}
                </small>
              </div>
              <button
                type="button" className="btn btn-sm"
                disabled={!nameDraft.trim() || nameUnchanged || renamingApplicationId === application.id}
                onClick={() => renameApplication(application)}
              >
                {renamingApplicationId === application.id ? 'Renaming…' : 'Rename'}
              </button>
              {renamedApplicationId === application.id && <span className="application-department-saved">✓ Renamed</span>}
              <SearchableSelect
                ariaLabel={`Department for ${application.name}`}
                value={selected}
                onChange={(value) => { setDraftDepartments((values) => ({ ...values, [application.id]: value })); setSavedApplicationId(null) }}
                options={[{ value: '', label: 'Select department' }, ...(selected && deptIsInactive ? [{ value: selected, label: `${selected} (Inactive)` }] : []), ...departmentOptions.map((department) => ({ value: department, label: department }))]}
                placeholder="Select department"
              />
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

function TestEmailCard({ defaultRecipient }: { defaultRecipient?: string | null }) {
  const [recipient, setRecipient] = useState(defaultRecipient || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [success, setSuccess] = useState('')

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSuccess('')
    try {
      const result = await api.post<{ ok: boolean; message: string }>('/api/auth/admin/test-email', { recipient })
      setSuccess(result.message)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Test Email Delivery">
      <p className="muted small">
        Send a real test message through the configured SMTP server. This verifies the relay connection,
        authentication, sender address, TLS settings, and delivery to the entered mailbox.
      </p>
      <form onSubmit={send} style={{ maxWidth: 560, marginTop: 14 }}>
        <Field label="Recipient email *">
          <input
            type="email"
            required
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="name@example.com"
          />
        </Field>
        <ErrorText error={error} title="Test email failed" />
        {success && <div className="document-upload-summary" role="status"><strong>✓ {success}</strong></div>}
        <button type="submit" className="btn btn-primary" disabled={busy || !recipient.trim()} style={{ marginTop: 12 }}>
          {busy ? 'Sending test email…' : 'Send Test Email'}
        </button>
      </form>
    </Card>
  )
}

function QAWorkspaceManager({ onManageUser, departments }: { onManageUser: (user: UserOut) => void; departments: DepartmentOut[] }) {
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false)
  const [workspaces, setWorkspaces] = useState<QAWorkspaceOut[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [parentWorkspaceId, setParentWorkspaceId] = useState('')
  const [newQuotaGb, setNewQuotaGb] = useState('')
  const [candidateSearch, setCandidateSearch] = useState('')
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<number[]>([])
  const [candidateWorkspaceAccess, setCandidateWorkspaceAccess] = useState<Record<number, string>>({})
  const [coordinatorUserId, setCoordinatorUserId] = useState('')
  const [coordinatorDepartmentId, setCoordinatorDepartmentId] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [memberView, setMemberView] = useState<WorkspaceMemberView>('current')
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>('members')
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editQuotaGb, setEditQuotaGb] = useState('')
  const [editParentId, setEditParentId] = useState('')
  const [editingHierarchy, setEditingHierarchy] = useState(false)
  const [editActive, setEditActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      const [workspaceRows, userRows] = await Promise.all([
        api.get<QAWorkspaceOut[]>('/api/workspaces'),
        api.get<UserOut[]>('/api/auth/users?all_workspaces=true'),
      ])
      setWorkspaces(workspaceRows)
      setUsers(userRows)
      setSelectedId((current) => current && workspaceRows.some((row) => row.id === current) ? current : workspaceRows[0]?.id || null)
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => { void load() }, [load])
  const selected = workspaces.find((row) => row.id === selectedId) || null
  useEffect(() => {
    if (!selected) return
    setEditName(selected.name)
    setEditDescription(selected.description || '')
    setEditQuotaGb(selected.document_portal_quota_bytes ? String(Number((selected.document_portal_quota_bytes / 1024**3).toFixed(3))) : '')
    setEditParentId(selected.parent_workspace_id ? String(selected.parent_workspace_id) : '')
    setEditingHierarchy(false)
    setEditActive(selected.is_active)
  }, [selected])
  const rootWorkspaces = workspaces.filter((workspace) => !workspace.parent_workspace_id)
  const orderedWorkspaces = rootWorkspaces.flatMap((root) => [
    root,
    ...workspaces.filter((workspace) => workspace.parent_workspace_id === root.id),
  ])
  const listedWorkspaceIds = new Set(orderedWorkspaces.map((workspace) => workspace.id))
  orderedWorkspaces.push(...workspaces.filter((workspace) => !listedWorkspaceIds.has(workspace.id)))
  const directGroupedMembers = groupedMembers()
  const parentWorkspace = selected?.parent_workspace_id
    ? workspaces.find((workspace) => workspace.id === selected.parent_workspace_id) || null
    : null
  const directCoordinators = (selected?.department_coordinators || []).filter((row) => row.is_active)
  const inheritedParentCoordinators = (parentWorkspace?.department_coordinators || [])
    .filter((row) => row.is_active)
    .filter((row) => !directCoordinators.some((direct) => (
      direct.user_id === row.user_id && direct.department_id === row.department_id
    )))
  const visibleCoordinators = [
    ...directCoordinators.map((assignment) => ({ assignment, inherited: false })),
    ...inheritedParentCoordinators.map((assignment) => ({ assignment, inherited: true })),
  ]
  const inheritedParentMembers = (() => {
    const rows = new Map<number, string[]>()
    for (const member of parentWorkspace?.members || []) {
      if (member.is_active && (member.role === 'PARENT_WORKSPACE_VIEWER' || member.role === 'PARENT_WORKSPACE_ADMIN')) {
        rows.set(member.user_id, [...(rows.get(member.user_id) || []), member.role])
      }
    }
    return [...rows].map(([user_id, roles]) => ({ user_id, roles }))
  })()
  const inheritedParentIds = new Set(inheritedParentMembers.map((member) => member.user_id))
  const members = directGroupedMembers.map((member) => ({
    ...member,
    user: users.find((user) => user.id === member.user_id),
    isSystemAdministrator: (selected?.members || []).some(
      (row) => row.user_id === member.user_id && row.is_system_administrator,
    ),
    isInheritedParentAccess: inheritedParentIds.has(member.user_id),
  })).concat(inheritedParentMembers
    .filter((member) => !directGroupedMembers.some((direct) => direct.user_id === member.user_id))
    .map((member) => ({
      ...member,
      user: users.find((user) => user.id === member.user_id),
      isSystemAdministrator: false,
      isInheritedParentAccess: true,
    })))
  const memberNeedle = memberSearch.trim().toLowerCase()
  const filteredMembers = members.filter(({ user }) => !memberNeedle || [
    user?.full_name, user?.username, user?.department, ...(user?.departments || []),
    ...(user?.roles || []).map((role) => ROLE_LABELS[role] || role),
  ].some((value) => value?.toLowerCase().includes(memberNeedle)))
  const currentMemberIds = new Set(members.map((member) => member.user_id))
  const candidateNeedle = candidateSearch.trim().toLowerCase()
  const memberCandidates = users
    .filter((user) => isSelectableUser(user) && !currentMemberIds.has(user.id))
    .filter((user) => !candidateNeedle || [
      user.full_name, user.username, user.department, ...(user.departments || []),
      ...(user.roles || []).map((role) => ROLE_LABELS[role] || role),
    ].some((value) => value?.toLowerCase().includes(candidateNeedle)))
    .sort((left, right) => left.full_name.localeCompare(right.full_name))
  const selectedCandidateSet = new Set(selectedCandidateIds)
  const allCandidatesSelected = memberCandidates.length > 0
    && memberCandidates.every((user) => selectedCandidateSet.has(user.id))
  const coordinatorUsers = users.filter(isSelectableUser)
  const selectedCoordinator = users.find((user) => String(user.id) === coordinatorUserId)
  const coordinatorDepartmentNames = selectedCoordinator
    ? (selectedCoordinator.departments?.length
      ? selectedCoordinator.departments
      : (selectedCoordinator.department ? [selectedCoordinator.department] : []))
    : []
  const coordinatorDepartments = departments.filter((department) => (
    department.is_active && coordinatorDepartmentNames.includes(department.name)
  ))
  const coordinatorDepartment = coordinatorDepartments.find(
    (department) => String(department.id) === coordinatorDepartmentId,
  )
  const coordinatorDepartmentOptions = coordinatorDepartments.map((department) => ({
    value: String(department.id), label: department.name,
  }))

  function selectCoordinator(userId: string) {
    setCoordinatorUserId(userId)
    const user = users.find((candidate) => String(candidate.id) === userId)
    const assignedNames = user?.departments?.length
      ? user.departments
      : (user?.department ? [user.department] : [])
    const assignedDepartments = departments.filter((department) => (
      department.is_active && assignedNames.includes(department.name)
    ))
    const primaryDepartment = assignedDepartments.find(
      (department) => department.name === user?.department,
    ) || assignedDepartments[0]
    setCoordinatorDepartmentId(primaryDepartment ? String(primaryDepartment.id) : '')
  }

  function selectWorkspace(workspace: QAWorkspaceOut) {
    // Reset the settings draft at the same time as the selected row. Waiting
    // for an effect left one render where the previous workspace's parent was
    // displayed, which could make a top-level workspace appear to belong to
    // whichever parent had been viewed immediately before it.
    setSelectedId(workspace.id)
    setEditName(workspace.name)
    setEditDescription(workspace.description || '')
    setEditQuotaGb(workspace.document_portal_quota_bytes ? String(Number((workspace.document_portal_quota_bytes / 1024**3).toFixed(3))) : '')
    setEditParentId(workspace.parent_workspace_id ? String(workspace.parent_workspace_id) : '')
    setEditingHierarchy(false)
    setEditActive(workspace.is_active)
    setWorkspacePanel('members')
    setMemberView('current')
    setCandidateSearch('')
    setSelectedCandidateIds([])
    setCandidateWorkspaceAccess({})
    setCoordinatorUserId('')
    setCoordinatorDepartmentId('')
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const quotaBytes = Math.round(Number(newQuotaGb) * 1024**3)
      if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error('Enter a positive Document Portal storage limit.')
      const parent = workspaces.find((workspace) => String(workspace.id) === parentWorkspaceId)
      if (parent && (!parent.document_portal_quota_bytes || quotaBytes > parent.document_portal_quota_bytes))
        throw new Error('The child storage limit must be no higher than the configured parent limit.')
      await api.post('/api/workspaces', { workspace_key: key, name, parent_workspace_id: parentWorkspaceId ? Number(parentWorkspaceId) : null, is_active: true, document_portal_quota_bytes: quotaBytes })
      setName(''); setKey(''); setParentWorkspaceId(''); setNewQuotaGb(''); setShowCreateWorkspace(false); await load()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function replaceMembers(next: { user_id: number; roles: string[] }[]) {
    if (!selected) return
    setBusy(true); setError(null)
    try { await api.put(`/api/workspaces/${selected.id}/members`, { members: next }); await load() }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  function groupedMembers() {
    const grouped = new Map<number, string[]>()
    for (const row of selected?.members || []) grouped.set(row.user_id, [...(grouped.get(row.user_id) || []), row.role])
    // Older databases can contain both WORKSPACE_MEMBER and a parent access
    // role for the same person. The table already presents their effective
    // access as one value; submit that same normalized value so an unrelated
    // legacy duplicate cannot block adding another member. A successful save
    // also rewrites the workspace memberships into the one-row invariant.
    return [...grouped].map(([user_id, roles]) => ({
      user_id,
      roles: [workspaceAccessRole(roles)],
    }))
  }

  function workspaceAccessRole(roles: string[]) {
    if (roles.includes('PARENT_WORKSPACE_ADMIN')) return 'PARENT_WORKSPACE_ADMIN'
    if (roles.includes('PARENT_WORKSPACE_VIEWER')) return 'PARENT_WORKSPACE_VIEWER'
    return 'WORKSPACE_MEMBER'
  }

  async function setWorkspaceAccessRole(userId: number, role: string) {
    const next = groupedMembers().map((member) => (
      member.user_id === userId ? { ...member, roles: [role] } : member
    ))
    await replaceMembers(next)
  }

  function toggleCandidate(userId: number) {
    setSelectedCandidateIds((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId])
  }

  function setCandidateAccess(userId: number, role: string) {
    setCandidateWorkspaceAccess((current) => ({ ...current, [userId]: role }))
    setSelectedCandidateIds((current) => current.includes(userId) ? current : [...current, userId])
  }

  function toggleAllCandidates() {
    const candidateIds = memberCandidates.map((user) => user.id)
    setSelectedCandidateIds((current) => {
      if (candidateIds.length && candidateIds.every((id) => current.includes(id))) {
        return current.filter((id) => !candidateIds.includes(id))
      }
      return [...new Set([...current, ...candidateIds])]
    })
  }

  async function addSelectedMembers() {
    if (!selectedCandidateIds.length || !selected) return
    const next = groupedMembers()
    for (const userId of selectedCandidateIds) {
      if (!next.some((entry) => entry.user_id === userId)) {
        next.push({ user_id: userId, roles: [candidateWorkspaceAccess[userId] || 'WORKSPACE_MEMBER'] })
      }
    }
    await replaceMembers(next)
    setSelectedCandidateIds([])
    setCandidateWorkspaceAccess({})
    setCandidateSearch('')
    setMemberView('current')
  }

  async function addCoordinator() {
    if (!selected || !coordinatorUserId || !coordinatorDepartment) return
    setBusy(true); setError(null)
    try {
      await api.post(`/api/workspaces/${selected.id}/department-coordinators`, {
        user_id: Number(coordinatorUserId), department_id: coordinatorDepartment.id,
      })
      setCoordinatorUserId(''); setCoordinatorDepartmentId(''); await load()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function removeCoordinator(assignmentId: number) {
    if (!selected) return
    setBusy(true); setError(null)
    try { await api.del(`/api/workspaces/${selected.id}/department-coordinators/${assignmentId}`); await load() }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function saveWorkspaceSettings(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || !editName.trim()) return
    setBusy(true); setError(null)
    try {
      const shownQuota = selected.document_portal_quota_bytes
        ? String(Number((selected.document_portal_quota_bytes / 1024**3).toFixed(3))) : ''
      const quotaBytes = editQuotaGb === shownQuota && selected.document_portal_quota_bytes != null
        ? selected.document_portal_quota_bytes
        : Math.round(Number(editQuotaGb) * 1024**3)
      if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error('Enter a positive Document Portal storage limit.')
      const parent = workspaces.find((workspace) => String(workspace.id) === editParentId)
      if (parent && (!parent.document_portal_quota_bytes || quotaBytes > parent.document_portal_quota_bytes))
        throw new Error('The child storage limit must be no higher than the configured parent limit.')
      if (!parent && workspaces.some((workspace) => workspace.parent_workspace_id === selected.id &&
        (workspace.document_portal_quota_bytes || 0) > quotaBytes))
        throw new Error('The parent storage limit must be at least as high as each child limit.')
      await api.patch(`/api/workspaces/${selected.id}`, {
        name: editName.trim(), description: editDescription.trim() || null,
        document_portal_quota_bytes: quotaBytes,
        parent_workspace_id: editParentId ? Number(editParentId) : null,
        is_active: editActive,
      })
      setEditingHierarchy(false)
      await load()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const candidateColumns: TableColumn<UserOut>[] = [
    {
      key: 'selection',
      header: <input type="checkbox" aria-label="Select all matching users" checked={allCandidatesSelected} disabled={!memberCandidates.length} onChange={toggleAllCandidates} />,
      filterable: false,
      render: (user) => <input type="checkbox" aria-label={`Select ${user.full_name}`} checked={selectedCandidateSet.has(user.id)} onChange={() => toggleCandidate(user.id)} />,
    },
    {
      key: 'full_name', header: 'User', filterable: false,
      render: (user) => <span className="workspace-table-identity"><strong>{user.full_name}</strong><small>{user.username}</small><small>{(user.departments?.length ? user.departments : (user.department ? [user.department] : [])).join(', ') || 'No department'}</small></span>,
    },
    {
      key: 'roles', header: 'Permission profile', filterable: false,
      render: (user) => user.roles.map((role) => ROLE_LABELS[role] || role).join(' · ') || 'Awaiting role assignment',
    },
    {
      key: 'workspace_access', header: 'Workspace access', filterable: false,
      render: (user) => !selected?.parent_workspace_id && !selected?.is_default
        ? <SearchableSelect ariaLabel={`Workspace access for ${user.full_name}`} searchable={false} value={candidateWorkspaceAccess[user.id] || 'WORKSPACE_MEMBER'} onChange={(role) => setCandidateAccess(user.id, role)} options={[
          { value: 'WORKSPACE_MEMBER', label: 'This workspace only' },
          { value: 'PARENT_WORKSPACE_VIEWER', label: 'Parent Workspace Viewer' },
          { value: 'PARENT_WORKSPACE_ADMIN', label: 'Parent Workspace Admin' },
        ]} />
        : <span className="workspace-access-label">Direct member</span>,
    },
  ]

  type WorkspaceMemberRow = (typeof members)[number]
  const currentMemberColumns: TableColumn<WorkspaceMemberRow>[] = [
    {
      key: 'member', header: 'Member', filterable: false,
      render: (member) => <span className="workspace-table-identity"><strong>{member.user?.full_name || `User ${member.user_id}`}</strong><small>{member.user?.username || 'Unknown user'}</small><small>{(member.user?.departments?.length ? member.user.departments : (member.user?.department ? [member.user.department] : [])).join(', ') || 'No department'}</small></span>,
    },
    {
      key: 'roles', header: 'Permission profile', filterable: false,
      render: (member) => (member.user?.roles || []).map((role) => ROLE_LABELS[role] || role).join(' · ') || 'Awaiting role assignment',
    },
    {
      key: 'workspace_access', header: 'Workspace access', filterable: false,
      render: (member) => !selected?.parent_workspace_id && !selected?.is_default && !member.isSystemAdministrator
        ? <SearchableSelect ariaLabel={`Parent workspace permission for ${member.user?.full_name || `user ${member.user_id}`}`} searchable={false} value={workspaceAccessRole(member.roles)} onChange={(role) => void setWorkspaceAccessRole(member.user_id, role)} disabled={busy} options={[
          { value: 'WORKSPACE_MEMBER', label: 'This workspace only' },
          { value: 'PARENT_WORKSPACE_VIEWER', label: 'Parent Workspace Viewer' },
          { value: 'PARENT_WORKSPACE_ADMIN', label: 'Parent Workspace Admin' },
        ]} />
        : <span className={`workspace-access-label ${member.isInheritedParentAccess ? 'inherited' : ''}`}>{member.isSystemAdministrator ? 'System-wide administrator' : member.isInheritedParentAccess ? 'Inherited from parent' : 'Direct member'}</span>,
    },
    {
      key: 'actions', header: 'Actions', filterable: false,
      render: (member) => <div className="workspace-member-actions">
        {member.user && <button type="button" className="btn btn-sm" title="Manage permission profile" onClick={() => onManageUser(member.user!)}>Permissions</button>}
        {member.isSystemAdministrator
          ? <span className="badge badge-blue" title="System Administrators belong to every workspace">Required</span>
          : member.isInheritedParentAccess
            ? <button type="button" className="btn btn-sm inherited-member-lock" disabled title="Change this user’s permission on the parent workspace">Inherited</button>
            : <button type="button" className="btn btn-sm workspace-remove-member" aria-label={`Remove ${member.user?.full_name || 'user'} from workspace`} disabled={busy} onClick={() => void replaceMembers(groupedMembers().filter((row) => row.user_id !== member.user_id))}>Remove</button>}
      </div>,
    },
  ]

  return <div className="qa-workspace-admin">
    <ErrorText error={error} />
    <div className="card qa-workspace-intro">
      <div><small>WORKSPACE HIERARCHY</small><h3>Organize access around real operating teams</h3><p>Create a parent for consolidated oversight and child workspaces for separate projects, requests, testing, defects, and reports.</p></div>
      <button type="button" className="btn btn-primary" onClick={() => setShowCreateWorkspace(true)}><IconPlus width={14} /> New workspace</button>
    </div>
    <div className="qa-workspace-grid">
      <aside className="card qa-workspace-list">
        {orderedWorkspaces.map((workspace) => <button type="button" key={workspace.id} className={`${workspace.id === selectedId ? 'active' : ''} ${workspace.parent_workspace_id ? 'child' : 'parent'}`} onClick={() => selectWorkspace(workspace)}>
          <span><strong>{workspace.name}</strong><small>{workspace.parent_workspace_id ? `Child of ${workspace.parent_workspace_name || 'parent workspace'}` : 'Parent workspace'} · {workspace.workspace_key}</small></span>
          {(() => { const count = new Set(workspace.members.map((member) => member.user_id)).size; return <em>{count} {count === 1 ? 'member' : 'members'}</em> })()}
        </button>)}
        {!workspaces.length && <p className="muted">Create the first workspace to organise users and work.</p>}
      </aside>
      {selected && <main className="card qa-workspace-detail">
        <header><div><small>{selected.parent_workspace_name ? `${selected.parent_workspace_name} / ` : ''}{selected.workspace_key}</small><h3>{selected.name}</h3><p>{selected.parent_workspace_id ? 'Independent child workspace with its own membership and operational records.' : 'Parent workspace for direct work and consolidated visibility across accessible children.'}</p></div>
          {selected.is_default && <span className="badge badge-blue">Default workspace</span>}
        </header>
        <nav className="workspace-detail-tabs" aria-label={`${selected.name} settings`}>
          <button type="button" className={workspacePanel === 'members' ? 'active' : ''} aria-current={workspacePanel === 'members' ? 'page' : undefined} onClick={() => setWorkspacePanel('members')}><strong>Members</strong><small>{members.length} people with access</small></button>
          <button type="button" className={workspacePanel === 'administrators' ? 'active' : ''} aria-current={workspacePanel === 'administrators' ? 'page' : undefined} onClick={() => setWorkspacePanel('administrators')}><strong>Local admins</strong><small>{visibleCoordinators.length} department assignments</small></button>
          <button type="button" className={workspacePanel === 'settings' ? 'active' : ''} aria-current={workspacePanel === 'settings' ? 'page' : undefined} onClick={() => setWorkspacePanel('settings')}><strong>Settings</strong><small>Name, storage, parent, and status</small></button>
        </nav>
        {workspacePanel === 'members' && <section className="workspace-members-section">
          <div className="workspace-members-heading">
            <div><h4>Workspace members</h4><p className="muted small">Control who can enter this workspace and how far their access extends.</p></div>
            <div className="workspace-members-view-tabs" role="tablist" aria-label="Workspace member views">
              <button type="button" role="tab" aria-selected={memberView === 'current'} className={memberView === 'current' ? 'active' : ''} onClick={() => setMemberView('current')}>Current <span>{members.length}</span></button>
              <button type="button" role="tab" aria-selected={memberView === 'add'} className={memberView === 'add' ? 'active' : ''} onClick={() => setMemberView('add')}><IconPlus width={13} /> Add members <span>{memberCandidates.length}</span></button>
            </div>
          </div>
          {!selected.parent_workspace_id && !selected.is_default && <details className="workspace-access-help">
            <summary>How parent workspace access works</summary>
            <div className="parent-access-guide" aria-label="Parent workspace permission guide">
              <div><strong>This workspace only</strong><span>Access to this parent only.</span></div>
              <div><strong>Parent Workspace Viewer</strong><span>Read-only access to this parent and every active child.</span></div>
              <div><strong>Parent Workspace Admin</strong><span>Can view children and manage their membership.</span></div>
            </div>
          </details>}
          {memberView === 'add' ? <div className="workspace-add-members-panel" role="tabpanel">
            <div className="workspace-member-toolbar"><div><strong>Add members</strong><small>Choose access in the table, select users, then add once.</small></div><ClearableSearchInput value={candidateSearch} onChange={(event) => setCandidateSearch(event.target.value)} onClear={() => setCandidateSearch('')} placeholder="Search name, username, department, or role…" clearLabel="Clear available user search" /></div>
            <div className="workspace-bulk-action-bar">
              <span><strong>{selectedCandidateIds.length}</strong> selected</span>
              {selectedCandidateIds.length > 0 && <button type="button" className="workspace-clear-selection" onClick={() => setSelectedCandidateIds([])}>Clear</button>}
              <button type="button" className="btn btn-primary" disabled={busy || !selectedCandidateIds.length} onClick={() => void addSelectedMembers()}><IconPlus width={14} /> {busy ? 'Adding…' : `Add ${selectedCandidateIds.length || ''} member${selectedCandidateIds.length === 1 ? '' : 's'}`}</button>
            </div>
            <div className="workspace-member-data-table"><Table<UserOut> tableId="workspace-member-candidates" columns={candidateColumns} rows={memberCandidates} rowKey="id" pageSize={5} resetKey={`${selected.id}:${candidateSearch}`} showColumnControls={false} /></div>
            {!memberCandidates.length && <p className="muted small workspace-member-result-note">{candidateSearch.trim() ? 'No available users match this search.' : 'All active users already have access to this workspace.'}</p>}
          </div> : <div className="workspace-current-members-panel" role="tabpanel">
            <div className="workspace-member-toolbar"><div><strong>Current members</strong><small>Update workspace access or open a member's permission profile.</small></div><ClearableSearchInput value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} onClear={() => setMemberSearch('')} placeholder="Search members or roles…" clearLabel="Clear member search" /></div>
            <div className="workspace-member-data-table"><Table<WorkspaceMemberRow> tableId="workspace-current-members" columns={currentMemberColumns} rows={filteredMembers} rowKey="user_id" pageSize={5} resetKey={`${selected.id}:${memberSearch}`} showColumnControls={false} /></div>
            {!filteredMembers.length && <p className="muted small workspace-member-result-note">No workspace members match this search.</p>}
          </div>}
        </section>}
        {workspacePanel === 'administrators' && <section><h4>Local administrators</h4>
          <CoordinatorRolePolicy />
          <p className="muted small">Let a trusted person administer users from one department inside this workspace.</p>
          <p className="workspace-instruction"><strong>Access boundary:</strong> an assignment on a parent also applies in every active child. An assignment made directly on a child stays in that child.</p>
          <div className="qa-workspace-form-row workspace-coordinator-add">
            <Field label="Coordinator *"><UserAssignSelect value={coordinatorUserId} onChange={selectCoordinator} users={coordinatorUsers} placeholder="Select user…" /></Field>
            <Field label="Manages users in">
              {coordinatorDepartments.length > 1
                ? <SearchableSelect value={coordinatorDepartmentId} onChange={setCoordinatorDepartmentId} options={coordinatorDepartmentOptions} placeholder="Select managed department…" />
                : <input
                    value={coordinatorUserId ? (coordinatorDepartment?.name || 'No active department assigned') : 'Select a coordinator first'}
                    readOnly
                    aria-readonly="true"
                    title="Automatically taken from the coordinator’s department"
                  />}
              <small className="workspace-derived-field-note">{coordinatorDepartments.length > 1 ? 'Primary department selected by default. Choose another assigned department if needed.' : 'Automatically taken from the coordinator’s department.'}</small>
            </Field>
            <button type="button" className="btn btn-primary" disabled={busy || !coordinatorUserId || !coordinatorDepartment} onClick={() => void addCoordinator()}><IconPlus width={14} /> Assign</button>
          </div>
          {coordinatorUserId && !coordinatorDepartment && <p className="muted small workspace-coordinator-scope-note">Assign an active department to this user before making them a local administrator.</p>}
          <div className="qa-workspace-chips workspace-coordinator-list">
            {visibleCoordinators.map(({ assignment, inherited }) => <div key={`${inherited ? 'parent' : 'direct'}-${assignment.id}`}>
              <span className="workspace-member-identity"><strong>{assignment.user_name || `User ${assignment.user_id}`}</strong><small>{assignment.department_name || 'Department'} · {inherited ? `Inherited from ${parentWorkspace?.name || 'parent'}` : 'This workspace'}</small></span>
              <span className={`badge ${inherited ? '' : 'badge-blue'}`}>{inherited ? 'Inherited local admin' : 'Department Coordinator'}</span>
              {users.find((user) => user.id === assignment.user_id) && <button type="button" className="workspace-manage-access" onClick={() => onManageUser(users.find((user) => user.id === assignment.user_id)!)}>Manage permissions</button>}
              {inherited
                ? <button type="button" className="btn btn-sm inherited-member-lock" disabled title="Remove or change this assignment on the parent workspace">Inherited</button>
                : <button type="button" disabled={busy} aria-label={`Remove ${assignment.user_name || 'user'} as department coordinator`} onClick={() => void removeCoordinator(assignment.id)}>Remove</button>}
            </div>)}
          </div>
          {!visibleCoordinators.length && <p className="muted small workspace-no-members">No local administrators assigned.</p>}
        </section>}
        {workspacePanel === 'settings' && <section><WorkspaceDefectWorkflow key={selected.id} workspace={selected} /><h4>Workspace settings</h4>
          <p className="muted small">Review the workspace identity and its current place in the organisation.</p>
          <form onSubmit={saveWorkspaceSettings} className="workspace-settings-form">
            <Field label="Workspace name *"><input value={editName} onChange={(event) => setEditName(event.target.value)} disabled={selected.is_default} required /></Field>
            <div className="workspace-hierarchy-summary">
              <span><small>Current hierarchy</small><strong>{selected.parent_workspace_id ? `Child of ${selected.parent_workspace_name || 'parent workspace'}` : 'Top-level workspace'}</strong><em>{selected.parent_workspace_id ? 'Members and records remain separate from the parent.' : 'This workspace is independent and may contain child workspaces.'}</em></span>
              {!selected.is_default && <button type="button" className="btn btn-sm" disabled={workspaces.some((workspace) => workspace.parent_workspace_id === selected.id)} onClick={() => setEditingHierarchy(true)}>{selected.parent_workspace_id ? 'Change hierarchy' : 'Move under workspace'}</button>}
            </div>
            {editingHierarchy && <div className="workspace-hierarchy-editor">
              <Field label="Place this workspace under">
                <SearchableSelect value={editParentId} onChange={setEditParentId} options={[
                  { value: '', label: 'No parent — keep as top-level' },
                  ...rootWorkspaces.filter((workspace) => workspace.id !== selected.id && !workspace.is_default).map((workspace) => ({ value: String(workspace.id), label: workspace.name })),
                ]} placeholder="Choose a parent workspace" />
              </Field>
              <p className="muted small">Changing this controls consolidated visibility. It does not merge members or records.</p>
              <button type="button" className="btn btn-sm" onClick={() => { setEditParentId(selected.parent_workspace_id ? String(selected.parent_workspace_id) : ''); setEditingHierarchy(false) }}>Cancel hierarchy change</button>
            </div>}
            {workspaces.some((workspace) => workspace.parent_workspace_id === selected.id) && <small className="muted">This workspace already has children. Move or remove them before placing this workspace under another parent.</small>}
            <Field label="Description"><textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} rows={3} placeholder="What work belongs in this workspace?" /></Field>
            <Field label="Maximum Document Portal storage (GB) *"><input type="number" min="0.001" step="0.001" value={editQuotaGb} onChange={(event) => setEditQuotaGb(event.target.value)} placeholder="Set a workspace storage limit" required /><small className="muted">{editParentId ? 'This child limit cannot exceed the parent limit. Its files stay in its own folder, while uploads also count against the shared parent limit.' : 'For a parent workspace, this limit covers its own files and every child workspace. Lowering it keeps existing files and blocks uploads above the cap.'}</small></Field>
            <label className="workspace-active-toggle"><input type="checkbox" checked={editActive} onChange={(event) => setEditActive(event.target.checked)} disabled={selected.is_default} /><span><strong>Active workspace</strong><small>Inactive workspaces cannot be selected. Existing records remain retained.</small></span></label>
            <button type="submit" className="btn btn-primary" disabled={busy || !editName.trim()}>{busy ? 'Saving…' : 'Save settings'}</button>
          </form>
        </section>}
      </main>}
    </div>
    {showCreateWorkspace && <Modal title="Create workspace" onClose={() => setShowCreateWorkspace(false)}>
      <p className="muted small">Choose a parent only when this workspace needs separate members and records under a larger business area.</p>
      <form onSubmit={createWorkspace}>
        <Field label="Parent workspace">
          <SearchableSelect value={parentWorkspaceId} onChange={setParentWorkspaceId} searchable={rootWorkspaces.length > 8} placeholder="No parent — create a top-level workspace" options={[
            { value: '', label: 'No parent — top-level workspace' },
            ...rootWorkspaces.filter((workspace) => !workspace.is_default).map((workspace) => ({ value: String(workspace.id), label: workspace.name })),
          ]} />
          <small className="muted">Leave empty for a top-level workspace. Only one parent-child level is supported.</small>
        </Field>
        <Field label="Workspace name *"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: DBD Quality Assurance" required /></Field>
        <Field label="Short key *"><input value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} placeholder="Example: DBD-QA" required /><small className="muted">A short, unique code used to identify the workspace.</small></Field>
        <Field label="Maximum Document Portal storage (GB) *"><input type="number" min="0.001" step="0.001" value={newQuotaGb} onChange={(event) => setNewQuotaGb(event.target.value)} placeholder="Enter a storage limit" required /><small className="muted">{parentWorkspaceId ? 'This child limit cannot exceed its parent limit. Child files stay in their own folder and share the parent storage budget.' : 'This top-level limit also covers any child workspaces added later. There is no preset storage limit.'}</small></Field>
        <div className="modal-actions"><button type="button" className="btn" onClick={() => setShowCreateWorkspace(false)}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create workspace'}</button></div>
      </form>
    </Modal>}
  </div>
}

export default function Admin() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
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
  const [workspaceRevision, setWorkspaceRevision] = useState(0)

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
  const requestedSection = searchParams.get('section') as AdminSection | null
  const section: AdminSection = requestedSection && ADMIN_SECTIONS.includes(requestedSection) ? requestedSection : 'users'
  const sectionMeta: Record<AdminSection, { title: string; subtitle: string; count?: number }> = {
    users: { title: 'People', subtitle: 'Create accounts and update roles, department scope, login method, and account status.', count: summary?.total || 0 },
    departments: { title: 'Organization', subtitle: 'Maintain department names used for identity, ownership, and approvals.', count: departments.length },
    workspaces: { title: 'Workspaces', subtitle: 'Control membership, local administration, and where new requests are routed.' },
    applications: { title: 'Application directory', subtitle: 'Maintain approved application names and their owning departments.' },
    email: { title: 'Email diagnostics', subtitle: 'Send a test message to verify the configured email service.' },
  }
  function setSection(next: AdminSection) {
    const nextParams = new URLSearchParams(searchParams)
    if (next === 'users') nextParams.delete('section')
    else nextParams.set('section', next)
    setSearchParams(nextParams)
  }

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
      <PageHeader
        eyebrow="Administration"
        title={sectionMeta[section].title} count={sectionMeta[section].count}
        subtitle={sectionMeta[section].subtitle}
        actions={section === 'users' ? <>
          <button className="btn" onClick={() => api.downloadFile('/api/audit/user-access-report', 'qualityops-user-access-report.xlsx').catch(setError)}>Download user access report</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <IconPlus width={14} height={14} /> Create User
          </button>
        </> : undefined}
      />

      <div className="admin-navigation-shell">
        <nav className="admin-primary-nav" aria-label="Primary administration sections">
          <button type="button" className={section === 'users' ? 'active' : ''} aria-current={section === 'users' ? 'page' : undefined} onClick={() => setSection('users')}><IconLock /><span><strong>People</strong><small>Accounts and permissions</small></span><em>{summary?.total || 0}</em></button>
          <button type="button" className={section === 'departments' ? 'active' : ''} aria-current={section === 'departments' ? 'page' : undefined} onClick={() => setSection('departments')}><IconPlus /><span><strong>Organization</strong><small>Department directory</small></span><em>{departments.length}</em></button>
          <button type="button" className={section === 'workspaces' ? 'active' : ''} aria-current={section === 'workspaces' ? 'page' : undefined} onClick={() => setSection('workspaces')}><IconUsers /><span><strong>Workspaces</strong><small>Hierarchy and data access</small></span></button>
        </nav>
        <div className="admin-system-tools">
          <span><strong>System tools</strong><small>Occasional setup and checks</small></span>
          <SearchableSelect ariaLabel="Choose a system administration tool" searchable={false} value={section === 'applications' || section === 'email' ? section : ''} onChange={(value) => value && setSection(value as AdminSection)} placeholder="Choose a tool…" options={[
            { value: 'applications', label: 'Application directory' },
            { value: 'email', label: 'Email diagnostics' },
          ]} />
        </div>
      </div>

      {section === 'users' && <div className="access-workspace-panel">
      {reviewCount > 0 && (
        <div className="alert-banner">
          <div className="icon-wrap"><IconWarning width={16} height={16} /></div>
          <div className="body">
            <div className="title">{reviewCount} account{reviewCount > 1 ? 's' : ''} need role review</div>
            <div className="sub">Confirm each person’s roles and access scope to complete their account review.</div>
          </div>
        </div>
      )}
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
          <ClearableSearchInput aria-label="Search users by name, username, or email" wrapperClassName="access-user-search" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} onClear={() => setUserSearch('')} clearLabel="Clear user search" placeholder="Search by user name, username, email, or department…" />
          <SearchableSelect ariaLabel="Filter by account status" value={accountFilter} onChange={(value) => setAccountFilter(value as typeof accountFilter)} searchable={false} style={{ minWidth: 180 }} options={[
            { value: 'ALL', label: 'All account statuses' }, { value: 'ACTIVE', label: 'Active accounts' }, { value: 'DISABLED', label: 'Disabled accounts' }, { value: 'REVIEW', label: 'Needs role review' },
          ]} />
          <SearchableSelect ariaLabel="Filter by login type" value={loginFilter} onChange={(value) => setLoginFilter(value as typeof loginFilter)} searchable={false} style={{ minWidth: 150 }} options={[
            { value: 'ALL', label: 'All login types' }, { value: 'STANDARD', label: 'Standard' }, { value: 'LDAP', label: 'LDAP' },
          ]} />
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
                  <label className="access-user-dropdown-toggle" title="Control whether this user appears in workflow and ownership dropdowns">
                    <input type="checkbox" checked={u.show_in_user_dropdowns !== false} disabled={savingId === u.id} onChange={(event) => void patchUser(u.id, { show_in_user_dropdowns: event.target.checked })} />
                    <small>Show in dropdowns</small>
                  </label>
                  {u.email && <small>{u.email}</small>}
                </div>
              </div>
            ), filterValue: (u) => `${u.full_name} ${u.username} ${u.email || ''}` },
            { key: 'department', header: 'Access scope', render: (u) => {
              const values = u.departments?.length ? u.departments : (u.department ? [u.department] : [])
              return <div className="access-scope-summary"><strong>{values[0] || 'No department'}</strong>{values.length > 1 && <span>+{values.length - 1} additional</span>}<small>Organization profile</small></div>
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

      {section === 'workspaces' && <div className="access-workspace-panel access-departments-section">
        <QAWorkspaceManager key={workspaceRevision} onManageUser={setAccessTarget} departments={departments} />
      </div>}

      {section === 'applications' && <div className="access-workspace-panel access-departments-section">
        <ApplicationSeedCard departmentOptions={departmentOptions} departments={departments} />
      </div>}

      {section === 'email' && <div className="access-workspace-panel access-departments-section">
        <TestEmailCard defaultRecipient={user?.email} />
      </div>}

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refreshUsers() }}
          departmentOptions={departmentOptions}
          departmentRows={departments}
        />
      )}
      {accessTarget && <ManageUserAccessModal userRow={accessTarget} currentUserId={user!.id} departmentOptions={departmentOptions} departmentRows={departments} onClose={() => setAccessTarget(null)} onDone={() => { setAccessTarget(null); refreshUsers(); setWorkspaceRevision((revision) => revision + 1) }} />}
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
