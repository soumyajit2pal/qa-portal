import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Navigate } from 'react-router-dom'
import { Card, Table, Modal, Field, ErrorText, PageHeader } from '../../components/Common'
import { ROLE_LABELS } from '../../constants'
import { LocalAdminApprovalWorkspaceOut, UserOut } from '../../types'
import { RoleChipSelect } from './Admin'
import SearchableSelect from '../../components/SearchableSelect'

// Local administration is granted explicitly for one department in one
// workspace. It is independent of the user's job-title/permission roles.
export default function DepartmentAdmin() {
  const { user } = useAuth()
  const [assignableRoles, setAssignableRoles] = useState<string[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [emailTarget, setEmailTarget] = useState<UserOut | null>(null)
  const [reviewRoles, setReviewRoles] = useState<Record<number, string[]>>({})
  const [reviewWorkspaceIds, setReviewWorkspaceIds] = useState<Record<number, string>>({})
  const [approvalWorkspaces, setApprovalWorkspaces] = useState<LocalAdminApprovalWorkspaceOut[]>([])

  // `hasRole()` intentionally makes an ADMIN satisfy every role check across
  // normal portal workflows. This access-management page is different: its
  // purpose is a *bounded* department coordinator workspace. Read the real
  // assignments here so an Administrator is sent to the unrestricted Users
  // & Access workspace instead of seeing coordinator-only API errors.
  const isSystemAdmin = (user?.roles || []).includes('ADMIN')
  const activeWorkspaceId = Number(
    localStorage.getItem('active_workspace_id') || localStorage.getItem('qa_active_workspace_id'),
  ) || user?.preferred_workspace_id || user?.preferred_qa_workspace_id
  const activeApprovalWorkspace = approvalWorkspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const managedDepartments = activeApprovalWorkspace?.coordinator_departments || []
  const isDepartmentCoordinator = managedDepartments.length > 0

  // SRS 7.2 pagination rollout -- deliberately left unpaginated (see
  // routers/auth.py::list_local_admin_users' own docstring). This roster is
  // scoped to one department's own headcount, not an org-wide directory.
  const load = useCallback(async () => {
    try {
      const [rows, workspaces, allowedRoles] = await Promise.all([
        api.get<UserOut[]>('/api/auth/local-admin/users'),
        api.get<LocalAdminApprovalWorkspaceOut[]>('/api/auth/local-admin/approval-workspaces'),
        api.get<string[]>('/api/auth/local-admin/assignable-roles'),
      ])
      setUsers(rows)
      setAssignableRoles(allowedRoles)
      setApprovalWorkspaces(workspaces)
      setReviewRoles(Object.fromEntries(rows.filter((row) => row.needs_role_review).map((row) => [
        row.id,
        row.roles.filter((role) => allowedRoles.includes(role)),
      ])))
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => {
    if (!isSystemAdmin) void load()
  }, [isSystemAdmin, load])

  const pendingUsers = users.filter((row) => row.needs_role_review)
  const approvedUsers = users.filter((row) => !row.needs_role_review)

  if (isSystemAdmin) return <Navigate to="/admin" replace />

  if (!isDepartmentCoordinator) {
    return (
      <Card title="Access Restricted">
        <p className="muted">You have not been assigned as a Department Coordinator in this workspace.</p>
      </Card>
    )
  }

  function assignableRolesFor(target: UserOut): string[] {
    void target
    return assignableRoles
  }

  async function patchUser(id: number, changes: { email?: string | null; roles?: string[]; is_active?: boolean; workspace_id?: number }): Promise<boolean> {
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

  async function approvePendingUser(target: UserOut) {
    const roles = reviewRoles[target.id] || []
    const workspaceId = Number(reviewWorkspaceIds[target.id])
    if (!roles.length || !workspaceId) return
    if (await patchUser(target.id, { roles, workspace_id: workspaceId })) await load()
  }

  function approvalWorkspaceOptions(target: UserOut) {
    const targetDepartments = new Set(
      (target.departments?.length ? target.departments : [target.department]).filter(Boolean),
    )
    const unique = new Map<number, { value: string; label: string }>()
    for (const workspace of approvalWorkspaces) {
      if (!workspace.coordinator_departments.some((department) => targetDepartments.has(department))) continue
      unique.set(workspace.id, {
        value: String(workspace.id),
        label: `${workspace.name} · ${workspace.workspace_key}${workspace.parent_workspace_id ? ' · Child workspace' : ''}`,
      })
    }
    return [...unique.values()]
  }

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Department Coordinator" count={users.length}
        subtitle={
          `Manage working roles and account status for ${managedDepartments.join(', ')} in ` +
          `${activeApprovalWorkspace?.name || 'the active workspace'}. Protected access remains managed by a System Admin.`
        }
      />
      <div className="card coordinator-scope-summary" aria-label="Your coordinator scope">
        <div><small>YOUR MANAGEMENT SCOPE</small><strong>Users visible on this page</strong><span>You can manage only users who match one of these assignments.</span></div>
        <div className="coordinator-scope-badges">
          {managedDepartments.map((department) => <span key={department}>
            <b>{department}</b>
            <small>{activeApprovalWorkspace?.parent_workspace_id ? `Inherited in ${activeApprovalWorkspace.name}` : activeApprovalWorkspace?.name || 'Active workspace'}</small>
          </span>)}
        </div>
      </div>
      <div className="workspace-instruction"><strong>Clear responsibility:</strong> You manage working roles, notification email, and account status for existing members of your assigned department. A System Administrator or Parent Workspace Admin adds or removes workspace members.</div>
      <Card title={`Pending role reviews (${pendingUsers.length})`}>
        <p className="muted small">These users completed first-login department selection and cannot enter the portal yet. Select their permitted role(s), choose the workspace where they will work, and approve the request.</p>
        <div className="coordinator-review-list">
          {pendingUsers.map((target) => <div key={target.id}>
            <span className="coordinator-review-identity"><strong>{target.full_name}</strong><small>{target.username} · {(target.departments?.length ? target.departments : [target.department]).filter(Boolean).join(', ')}</small></span>
            <div className="coordinator-review-workspace"><small>Destination workspace</small><SearchableSelect ariaLabel={`Destination workspace for ${target.full_name}`} value={reviewWorkspaceIds[target.id] || ''} onChange={(workspaceId) => setReviewWorkspaceIds((current) => ({ ...current, [target.id]: workspaceId }))} options={approvalWorkspaceOptions(target)} placeholder="Select workspace…" disabled={savingId === target.id} /></div>
            <button type="button" className="btn btn-primary coordinator-review-action" disabled={savingId === target.id || !(reviewRoles[target.id] || []).length || !reviewWorkspaceIds[target.id]} onClick={() => void approvePendingUser(target)}>{savingId === target.id ? 'Approving…' : 'Approve access'}</button>
            <div className="coordinator-review-roles"><small>Approved role(s)</small><RoleChipSelect value={reviewRoles[target.id] || []} onChange={(roles) => setReviewRoles((current) => ({ ...current, [target.id]: roles }))} disabled={savingId === target.id} roles={assignableRolesFor(target)} /></div>
          </div>)}
          {!pendingUsers.length && <p className="muted small">No access requests are waiting for your review.</p>}
        </div>
      </Card>
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
            { key: 'department_scope', header: 'Department', render: (u) => {
              const departmentNames = u.departments?.length ? u.departments : (u.department ? [u.department] : [])
              return <div className="coordinator-user-scope">
                <strong>{departmentNames.join(', ') || 'No department'}</strong>
                <small>Identity and approval scope</small>
              </div>
            }, filterValue: (u) => (u.departments || []).join(' ') },
            { key: 'roles', header: 'Role(s)', render: (u) => {
              const assignableRoles = assignableRolesFor(u)
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
          rows={approvedUsers}
        />
        {approvedUsers.length === 0 && (
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
