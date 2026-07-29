import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader } from '../../components/Common'
import { ROLE_LABELS, ALL_ROLES, LOGIN_TYPES, LOGIN_TYPE_LABELS, hasRole } from '../../constants'
import { IconPlus, IconLock, IconWarning, IconCheckCircle } from '../../components/Icons'
import SearchableSelect from '../../components/SearchableSelect'
import { UserOut, DepartmentOut } from '../../types'

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

function RoleChipSelect({ value, onChange, disabled }: { value: string[]; onChange: (roles: string[]) => void; disabled?: boolean }) {
  function toggle(role: string) {
    if (disabled) return
    const has = value.includes(role)
    onChange(has ? value.filter((r) => r !== role) : [...value, role])
  }
  return (
    <div className="chip-select">
      {ALL_ROLES.map((r) => {
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

export default function Admin() {
  const { user } = useAuth()
  const [users, setUsers] = useState<UserOut[]>([])
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [resetTarget, setResetTarget] = useState<UserOut | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)

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
  const departmentOptions = departments.filter((d) => d.is_active).map((d) => d.name)

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
    <div>
      <ErrorText error={error} />
      {reviewCount > 0 && (
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
        subtitle="Create Standard (local password) or LDAP-backed accounts, and assign roles."
        actions={(
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <IconPlus width={14} height={14} /> Create User
          </button>
        )}
      />

      <Card>
        <Table
          rowKey="id"
          columns={[
            { key: 'full_name', header: 'Name', render: (u) => (
              <div>
                <div>
                  {u.full_name}
                  {u.needs_role_review && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>Needs Review</span>}
                </div>
                <div className="muted small">{u.username}{u.email ? ` · ${u.email}` : ''}</div>
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
          rows={users}
        />
      </Card>

      <div style={{ marginTop: 24 }}>
        <DepartmentManagerCard departments={departments} onChanged={loadDepartments} />
      </div>

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
