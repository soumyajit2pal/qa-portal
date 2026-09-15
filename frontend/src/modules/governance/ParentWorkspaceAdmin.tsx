import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { ErrorText, PageHeader } from '../../components/Common'
import UserAssignSelect from '../../components/UserAssignSelect'
import { IconPlus } from '../../components/Icons'
import { uniqueWorkspaceAccess } from '../../constants'
import { LocalAdminWorkspaceCandidateOut, QAWorkspaceOut } from '../../types'

type GroupedMember = { user_id: number; user_name: string; roles: string[]; required: boolean }

function groupedMembers(workspace: QAWorkspaceOut | null): GroupedMember[] {
  const rows = new Map<number, GroupedMember>()
  for (const member of workspace?.members || []) {
    const current = rows.get(member.user_id) || {
      user_id: member.user_id,
      user_name: member.user_name || `User ${member.user_id}`,
      roles: [],
      required: false,
    }
    current.roles.push(member.role)
    current.required ||= member.is_system_administrator
    rows.set(member.user_id, current)
  }
  return [...rows.values()]
}

export default function ParentWorkspaceAdmin() {
  const { user } = useAuth()
  const parentIds = useMemo(() => new Set(uniqueWorkspaceAccess(user)
    .filter((access) => access.role === 'PARENT_WORKSPACE_ADMIN')
    .map((access) => access.workspace_id)), [user])
  const [workspaces, setWorkspaces] = useState<QAWorkspaceOut[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<LocalAdminWorkspaceCandidateOut[]>([])
  const [memberId, setMemberId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.get<QAWorkspaceOut[]>('/api/workspaces')
      setWorkspaces(rows)
      const managed = rows.filter((workspace) =>
        parentIds.has(workspace.id) || Boolean(workspace.parent_workspace_id && parentIds.has(workspace.parent_workspace_id)),
      )
      setSelectedId((current) => current && managed.some((row) => row.id === current)
        ? current
        : managed.find((row) => parentIds.has(row.id))?.id || managed[0]?.id || null)
    } catch (err) { setError(err) }
  }, [parentIds])
  useEffect(() => { void load() }, [load])

  const parents = workspaces.filter((workspace) => parentIds.has(workspace.id))
  const managedWorkspaces = workspaces.filter((workspace) =>
    parentIds.has(workspace.id) || Boolean(workspace.parent_workspace_id && parentIds.has(workspace.parent_workspace_id)),
  ).sort((left, right) => {
    const leftLevel = left.parent_workspace_id ? 1 : 0
    const rightLevel = right.parent_workspace_id ? 1 : 0
    return leftLevel - rightLevel || left.name.localeCompare(right.name)
  })
  const selected = managedWorkspaces.find((workspace) => workspace.id === selectedId) || null
  const parent = selected ? parents.find((row) => row.id === selected.parent_workspace_id) || null : null
  const directMembers = groupedMembers(selected)
  const inheritedMembers = groupedMembers(parent).filter((member) =>
    member.roles.includes('PARENT_WORKSPACE_VIEWER') || member.roles.includes('PARENT_WORKSPACE_ADMIN'),
  )
  const inheritedIds = new Set(inheritedMembers.map((member) => member.user_id))
  const displayedMembers = [
    ...directMembers.map((member) => ({ ...member, inherited: inheritedIds.has(member.user_id) })),
    ...inheritedMembers.filter((member) => !directMembers.some((direct) => direct.user_id === member.user_id))
      .map((member) => ({ ...member, inherited: true })),
  ]

  const loadCandidates = useCallback(async (workspaceId: number) => {
    try {
      setCandidates(await api.get<LocalAdminWorkspaceCandidateOut[]>(`/api/workspaces/${workspaceId}/member-candidates`))
    } catch (err) { setCandidates([]); setError(err) }
  }, [])
  useEffect(() => {
    setMemberId('')
    if (selectedId) void loadCandidates(selectedId)
    else setCandidates([])
  }, [selectedId, loadCandidates])

  if (!parentIds.size) return <Navigate to="/" replace />

  async function replace(next: GroupedMember[]) {
    if (!selected) return
    setBusy(true); setError(null)
    try {
      await api.put(`/api/workspaces/${selected.id}/members`, {
        members: next.map((member) => ({ user_id: member.user_id, roles: member.roles })),
      })
      await load()
      await loadCandidates(selected.id)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function addMember() {
    const candidate = candidates.find((row) => row.id === Number(memberId))
    if (!candidate) return
    await replace([...directMembers, {
      user_id: candidate.id, user_name: candidate.full_name, roles: ['WORKSPACE_MEMBER'], required: false,
    }])
    setMemberId('')
  }

  return <div className="access-page">
    <ErrorText error={error} />
    <PageHeader eyebrow="Administration" title="Workspace membership" subtitle="Manage direct membership in your assigned parent workspace and its children. Workspace identity, hierarchy, status, routing, and parent-level permissions remain managed by a System Administrator." />
    <div className="qa-workspace-grid">
      <aside className="card qa-workspace-list">
        {managedWorkspaces.map((workspace) => <button type="button" key={workspace.id} className={`${workspace.id === selectedId ? 'active ' : ''}${workspace.parent_workspace_id ? 'child' : ''}`} onClick={() => setSelectedId(workspace.id)}><span><strong>{workspace.name}</strong><small>{workspace.parent_workspace_id ? `Child of ${workspace.parent_workspace_name}` : 'Parent workspace'}</small></span><em>{new Set(workspace.members.map((member) => member.user_id)).size} direct</em></button>)}
        {!managedWorkspaces.length && <p className="muted small">No workspaces are covered by your Parent Workspace Admin permission.</p>}
      </aside>
      {selected && <main className="card qa-workspace-detail">
        <header><div><small>{selected.parent_workspace_name ? `${selected.parent_workspace_name} / ` : ''}{selected.workspace_key}</small><h3>{selected.name}</h3><p>Membership administration only. The System Administrator controls workspace settings, hierarchy, routing, coordinator assignments, and Parent Viewer/Admin permissions.</p></div></header>
        <section><h4>Add member to this workspace</h4><p className="muted small">Search the complete active user directory. This adds direct access to {selected.name}; permission profiles remain managed separately.</p>
          <div className="qa-workspace-form-row workspace-member-add"><UserAssignSelect value={memberId} onChange={setMemberId} users={candidates} placeholder="Search active users by name or department…" /><button type="button" className="btn btn-primary" disabled={busy || !memberId} onClick={() => void addMember()}><IconPlus width={14} /> Add member</button></div>
        </section>
        <section><h4>People with access</h4><p className="muted small">Direct members can be removed here. Parent Viewer/Admin access is shown for traceability and must be changed by a System Administrator.</p>
          <div className="qa-workspace-chips parent-admin-member-list">{displayedMembers.map((member) => <div key={member.user_id}>
            <span className="workspace-member-identity"><strong>{member.user_name}</strong><small>{member.inherited ? `Inherited from ${parent?.name || 'parent workspace'}` : member.roles.includes('PARENT_WORKSPACE_ADMIN') ? 'Parent Workspace Admin permission' : member.roles.includes('PARENT_WORKSPACE_VIEWER') ? 'Parent Workspace Viewer permission' : 'Direct workspace member'}</small></span>
            {member.inherited || member.roles.some((role) => role === 'PARENT_WORKSPACE_ADMIN' || role === 'PARENT_WORKSPACE_VIEWER')
              ? <button type="button" className="btn btn-sm inherited-member-lock" disabled title="Parent-level permissions are managed by a System Administrator">Parent permission</button>
              : member.required
                ? <span className="badge badge-blue">Required member</span>
                : <button type="button" disabled={busy} onClick={() => void replace(directMembers.filter((row) => row.user_id !== member.user_id))}>Remove</button>}
          </div>)}</div>
        </section>
      </main>}
    </div>
  </div>
}
