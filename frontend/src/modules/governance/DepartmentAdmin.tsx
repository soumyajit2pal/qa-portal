import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Navigate } from 'react-router-dom'
import { Card, Table, Modal, Field, ErrorText, PageHeader } from '../../components/Common'
import { ROLE_LABELS, DEPARTMENT_ADMIN_ASSIGNABLE_ROLES, QA_ADMIN_ASSIGNABLE_ROLES } from '../../constants'
import { UserOut } from '../../types'
import { RoleChipSelect } from './Admin'

// "Local admin" -- lets a Department Head (business departments) or a QA
// Executive (the QA department, CHIEF_MANAGER_QA/AGM_QA -- the "Executive
// Group," 2026-08) assign working-level roles and activate/deactivate
// accounts for users already mapped to their own department, without going
// through a System Admin for every routine role change. Deliberately much
// narrower than Admin.tsx: no user creation, no password resets, no
// department reassignment, no touching ADMIN/DEPARTMENT_HEAD_CM/
// DEPARTMENT_HEAD_AGM/CHIEF_MANAGER_QA/AGM_QA on anyone -- see
// routers/auth.py's local-admin endpoints for the matching server-side
// guard rails (this page is a convenience UI; the real enforcement is
// there). The two KINDS of local admin assign a different role subset
// each: a business Department Head gets DEPARTMENT_ADMIN_ASSIGNABLE_ROLES
// (Requester/Other, Business Analyst, Application Owner, SM), while a QA
// Executive gets QA_ADMIN_ASSIGNABLE_ROLES (QA Engineer, QA Lead, Security
// Analyst) -- see assignableRoles below.
export default function DepartmentAdmin() {
  const { user } = useAuth()
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [emailTarget, setEmailTarget] = useState<UserOut | null>(null)

  // `hasRole()` intentionally makes an ADMIN satisfy every role check across
  // normal portal workflows. This access-management page is different: its
  // purpose is a *bounded* department coordinator workspace. Read the real
  // assignments here so an Administrator is sent to the unrestricted Users
  // & Access workspace instead of seeing coordinator-only API errors.
  const assignedRoles = user?.roles || []
  const isSystemAdmin = assignedRoles.includes('ADMIN')
  const isQAAdmin = assignedRoles.some((role) => ['CHIEF_MANAGER_QA', 'AGM_QA'].includes(role))
  const isDeptAdmin = assignedRoles.some((role) => ['DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM'].includes(role))

  // SRS 7.2 pagination rollout -- deliberately left unpaginated (see
  // routers/auth.py::list_local_admin_users' own docstring). This roster is
  // scoped to one department's own headcount, not an org-wide directory.
  const load = useCallback(async () => {
    try { setUsers(await api.get<UserOut[]>('/api/auth/local-admin/users')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    if (!isSystemAdmin) void load()
  }, [isSystemAdmin, load])

  const pendingReviewCount = users.filter((row) => row.needs_role_review && row.roles.length === 0).length

  if (isSystemAdmin) return <Navigate to="/admin" replace />

  if (!isQAAdmin && !isDeptAdmin) {
    return (
      <Card title="Access Restricted">
        <p className="muted">The Department Coordinator section is only available to Department Head or Executive accounts.</p>
      </Card>
    )
  }

  // Mirrors routers/auth.py::_local_admin_assignable_roles -- an Executive
  // COE manages the QA team's own working roles, a business Department Head
  // manages everyone else's.
  const assignableRoles = isQAAdmin ? QA_ADMIN_ASSIGNABLE_ROLES : DEPARTMENT_ADMIN_ASSIGNABLE_ROLES

  async function patchUser(id: number, changes: { email?: string | null; roles?: string[]; is_active?: boolean }): Promise<boolean> {
    setError(null)
    setSavingId(id)
    try {
      const updated = await api.patch<UserOut>(`/api/auth/local-admin/users/${id}`, changes)
      setUsers((rows) => rows.map((r) => (r.id === id ? updated : r)))
      return true
    } catch (err) {
      setError(err)
      return false
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Department Coordinator" count={users.length}
        subtitle={
          `Assign ${isQAAdmin ? 'QA team' : 'working-level'} roles and activate/deactivate accounts mapped to ` +
          `${(user?.departments && user.departments.length ? user.departments.join(', ') : user?.department) || 'your department'} -- Administrator, Department Head, and Executive access ` +
          'still require a System Admin, as does any account marked "Managed by Admin Only" (won\'t appear below).'
        }
      />
      {pendingReviewCount > 0 && (
        <div className="alert-banner" style={{ marginBottom: 16 }}>
          <div className="body">
            <div className="title">{pendingReviewCount} access request{pendingReviewCount === 1 ? '' : 's'} awaiting your review</div>
            <div className="sub">Assign an appropriate role below to approve access for a new LDAP user in your department.</div>
          </div>
        </div>
      )}
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
              // DEPARTMENT_HEAD_AGM/CHIEF_MANAGER_QA/AGM_QA on someone who
              // wears two hats, but
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
            { key: 'email', header: 'Notification Email', render: (u) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{u.email || 'Not set'}</span>
                <button className="btn btn-sm" disabled={savingId === u.id} onClick={() => setEmailTarget(u)}>Update</button>
              </div>
            ), filterValue: (u) => u.email || '' },
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
      {emailTarget && (
        <EmailEditor
          userRow={emailTarget}
          busy={savingId === emailTarget.id}
          onClose={() => setEmailTarget(null)}
          onSave={async (email) => {
            const saved = await patchUser(emailTarget.id, { email })
            if (saved) setEmailTarget(null)
            return saved
          }}
        />
      )}
    </div>
  )
}

function EmailEditor({ userRow, busy, onClose, onSave }: {
  userRow: UserOut; busy: boolean; onClose: () => void; onSave: (email: string | null) => Promise<boolean>
}) {
  const [email, setEmail] = useState(userRow.email || '')
  const [formError, setFormError] = useState<unknown>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    try {
      setFormError(null)
      await onSave(email.trim() || null)
    } catch (err) {
      setFormError(err)
    }
  }

  return (
    <Modal title={`Update notification email — ${userRow.full_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Email address">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoFocus />
        </Field>
        <p className="muted small">This address receives QA Portal workflow notifications for this user.</p>
        <ErrorText error={formError} />
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save email'}</button></div>
      </form>
    </Modal>
  )
}
