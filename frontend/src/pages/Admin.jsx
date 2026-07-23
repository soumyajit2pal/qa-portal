import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader } from '../components/Common'
import { ROLE_LABELS, ALL_ROLES, LOGIN_TYPES, LOGIN_TYPE_LABELS, DEPARTMENTS, hasRole } from '../constants'
import { IconPlus, IconLock, IconWarning, IconCheckCircle } from '../components/Icons'
import SearchableSelect from '../components/SearchableSelect'

const EMPTY_FORM = {
  username: '', full_name: '', email: '', department: '',
  roles: ['REQUESTER'], login_type: 'STANDARD', password: '',
}

function RoleChipSelect({ value, onChange, disabled }) {
  function toggle(role) {
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

function CreateUserModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e) {
    e.preventDefault()
    if (form.roles.length === 0) {
      setError(new Error('Select at least one role'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = { ...form }
      if (payload.login_type === 'LDAP') delete payload.password
      const created = await api.post('/api/auth/users', payload)
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
              options={DEPARTMENTS}
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

function ResetPasswordModal({ userRow, onClose, onDone }) {
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
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

export default function Admin() {
  const { user } = useAuth()
  const [users, setUsers] = useState([])
  const [error, setError] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [resetTarget, setResetTarget] = useState(null)
  const [savingId, setSavingId] = useState(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.get('/api/auth/users/all')
      // Surface accounts awaiting review first -- these are typically brand-new
      // LDAP logins that were auto-provisioned with the default low-privilege role.
      rows.sort((a, b) => (b.needs_role_review === true) - (a.needs_role_review === true))
      setUsers(rows)
    } catch (err) { setError(err) }
  }, [])

  const reviewCount = users.filter((u) => u.needs_role_review).length

  useEffect(() => { load() }, [load])

  if (!hasRole(user, 'ADMIN')) {
    return (
      <Card title="Access Restricted">
        <p className="muted">The Admin section is only available to Administrator accounts.</p>
      </Card>
    )
  }

  async function patchUser(id, changes) {
    setError(null)
    setSavingId(id)
    try {
      const updated = await api.patch(`/api/auth/users/${id}`, changes)
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
            ) },
            { key: 'department', header: 'Department', render: (u) => (
              <div style={{ minWidth: 220 }}>
                <SearchableSelect
                  value={u.department || ''}
                  disabled={savingId === u.id}
                  onChange={(v) => patchUser(u.id, { department: v })}
                  options={DEPARTMENTS}
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
            ) },
            { key: 'login_type', header: 'Login Type', render: (u) => (
              <span className={`badge ${u.login_type === 'LDAP' ? 'badge-blue' : 'badge-gray'}`}>
                {u.login_type === 'LDAP' ? 'LDAP' : 'Standard'}
              </span>
            ) },
            { key: 'is_active', header: 'Status', render: (u) => (
              <button
                className={`btn btn-sm ${u.is_active ? '' : 'btn-danger'}`}
                disabled={savingId === u.id || u.id === user.id}
                title={u.id === user.id ? "You can't deactivate your own account" : ''}
                onClick={() => patchUser(u.id, { is_active: !u.is_active })}
              >
                {u.is_active ? 'Active' : 'Disabled'}
              </button>
            ) },
            { key: 'actions', header: '', render: (u) => (
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

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load() }}
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
