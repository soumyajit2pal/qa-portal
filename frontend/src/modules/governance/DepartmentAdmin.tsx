import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, ErrorText, PageHeader } from '../../components/Common'
import { hasRole, ROLE_LABELS, DEPARTMENT_ADMIN_ASSIGNABLE_ROLES, QA_ADMIN_ASSIGNABLE_ROLES } from '../../constants'
import { UserOut } from '../../types'
import { RoleChipSelect } from './Admin'

// "Local admin" -- lets a Department Head (business departments) or an
// Executive COE (the QA department) assign working-level roles and
// activate/deactivate accounts for users already mapped to their own
// department, without going through a System Admin for every routine role
// change. Deliberately much narrower than Admin.tsx: no user creation, no
// password resets, no department reassignment, no touching ADMIN/
// DEPARTMENT_HEAD_CM/DEPARTMENT_HEAD_AGM/DEPARTMENT_HEAD_COE_CM/
// DEPARTMENT_HEAD_COE_AGM on anyone -- see routers/auth.py's local-admin
// endpoints for the matching server-side guard rails (this page is a
// convenience UI; the real enforcement is there). The two role-pairs each
// carry identical authority within their own kind (CM vs AGM, split only so
// approval logs show the exact position of the approver) -- but the two
// KINDS assign a different role subset each: a business Department Head
// gets DEPARTMENT_ADMIN_ASSIGNABLE_ROLES (Requester/Other, Business
// Analyst, Application Owner, SM), while an Executive COE gets
// QA_ADMIN_ASSIGNABLE_ROLES (QA Engineer, QA Lead, Security Analyst) --
// see assignableRoles below.
export default function DepartmentAdmin() {
  const { user } = useAuth()
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [savingId, setSavingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try { setUsers(await api.get<UserOut[]>('/api/auth/local-admin/users')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  const isQAAdmin = hasRole(user, 'DEPARTMENT_HEAD_COE_CM', 'DEPARTMENT_HEAD_COE_AGM')
  const isDeptAdmin = hasRole(user, 'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM')

  if (!isQAAdmin && !isDeptAdmin) {
    return (
      <Card title="Access Restricted">
        <p className="muted">The Department Admin section is only available to Department Head or Executive COE accounts.</p>
      </Card>
    )
  }

  // Mirrors routers/auth.py::_local_admin_assignable_roles -- an Executive
  // COE manages the QA team's own working roles, a business Department Head
  // manages everyone else's. hasRole(user, 'ADMIN', ...) always short-
  // circuits true, so an Admin account (which can also reach this page)
  // falls through to the QA-Admin check first here purely for a stable
  // default -- Admins normally use /admin instead of this page anyway.
  const assignableRoles = isQAAdmin ? QA_ADMIN_ASSIGNABLE_ROLES : DEPARTMENT_ADMIN_ASSIGNABLE_ROLES

  async function patchUser(id: number, changes: { roles?: string[]; is_active?: boolean }) {
    setError(null)
    setSavingId(id)
    try {
      const updated = await api.patch<UserOut>(`/api/auth/local-admin/users/${id}`, changes)
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
      <PageHeader
        title="Department Admin" count={users.length}
        subtitle={
          `Assign ${isQAAdmin ? 'QA team' : 'working-level'} roles and activate/deactivate accounts mapped to ` +
          `${user?.department || 'your department'} -- Administrator, Department Head, and Executive COE access ` +
          'still require a System Admin.'
        }
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
            { key: 'roles', header: 'Role(s)', render: (u) => {
              // A user can also hold a role outside THIS local admin's own
              // authority -- most commonly DEPARTMENT_HEAD_CM/
              // DEPARTMENT_HEAD_AGM/DEPARTMENT_HEAD_COE_CM/
              // DEPARTMENT_HEAD_COE_AGM on someone who wears two hats, but
              // also the OTHER kind of local admin's own role subset (e.g. a
              // business Department Head viewing someone who also holds
              // QA_LEAD) -- PATCH /local-admin/users/{id} already preserves
              // those server-side no matter what's submitted here, but
              // they're still surfaced read-only so it's clear this page
              // isn't the full picture of that person's access.
              const otherRoles = (u.roles || []).filter((r) => !assignableRoles.includes(r))
              return (
                <div style={{ minWidth: 260 }}>
                  <RoleChipSelect
                    value={(u.roles || []).filter((r) => assignableRoles.includes(r))}
                    disabled={savingId === u.id}
                    roles={assignableRoles}
                    onChange={(v) => patchUser(u.id, { roles: v })}
                  />
                  {otherRoles.length > 0 && (
                    <div className="muted small" style={{ marginTop: 4 }}>
                      Also holds: {otherRoles.map((r) => ROLE_LABELS[r] || r).join(', ')} (managed by a System Admin)
                    </div>
                  )}
                </div>
              )
            }, filterValue: (u) => (u.roles || []).join(' ') },
            { key: 'is_active', header: 'Status', render: (u) => (
              <button
                className={`btn btn-sm ${u.is_active ? '' : 'btn-danger'}`}
                disabled={savingId === u.id}
                onClick={() => patchUser(u.id, { is_active: !u.is_active })}
              >
                {u.is_active ? 'Active' : 'Disabled'}
              </button>
            ), filterValue: (u) => u.is_active ? 'Active' : 'Disabled' },
          ]}
          rows={users}
        />
        {users.length === 0 && (
          <p className="muted small" style={{ margin: '10px 2px 2px' }}>
            No other users are currently mapped to your department.
          </p>
        )}
      </Card>
    </div>
  )
}
