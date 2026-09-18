import './ParentWorkspaceAdmin.css'
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
    if (!member.is_active) continue
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
  const [loading, setLoading] = useState(true)
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [workspaceSearch, setWorkspaceSearch] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [accessFilter, setAccessFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [page, setPage] = useState(1)

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
    } catch (err) { setError(err) } finally { setLoading(false) }
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
    ...directMembers.map((member) => ({ ...member, roles: [...new Set([...member.roles, ...(inheritedMembers.find(row => row.user_id === member.user_id)?.roles || [])])], inherited: inheritedIds.has(member.user_id) })),
    ...inheritedMembers.filter((member) => !directMembers.some((direct) => direct.user_id === member.user_id))
      .map((member) => ({ ...member, inherited: true })),
  ]

  const loadCandidates = useCallback(async (workspaceId: number) => {
    try {
      setCandidates(await api.get<LocalAdminWorkspaceCandidateOut[]>(`/api/workspaces/${workspaceId}/member-candidates`))
    } catch (err) { setCandidates([]); setError(err) }
  }, [])
  useEffect(() => {
    let active = true
    setMemberId(''); setCandidates([]); setAdding(false)
    setMemberSearch(''); setAccessFilter('all'); setPage(1)
    if (!selectedId) { setCandidateLoading(false); return }
    setCandidateLoading(true)
    api.get<LocalAdminWorkspaceCandidateOut[]>(`/api/workspaces/${selectedId}/member-candidates`)
      .then(rows => { if (active) setCandidates(rows) })
      .catch(err => { if (active) setError(err) })
      .finally(() => { if (active) setCandidateLoading(false) })
    return () => { active = false }
  }, [selectedId])
  useEffect(() => { setPage(1) }, [memberSearch, accessFilter])
  const visibleMembers = displayedMembers.filter(member =>
    member.user_name.toLowerCase().includes(memberSearch.trim().toLowerCase())
    && (accessFilter === 'all' || (accessFilter === 'inherited' ? member.inherited : !member.inherited))
  ).sort((a, b) => a.user_name.localeCompare(b.user_name))
  const pageCount = Math.max(1, Math.ceil(visibleMembers.length / 12))
  const currentPage = Math.min(page, pageCount)
  const pageMembers = visibleMembers.slice((currentPage - 1) * 12, currentPage * 12)
  const availableCandidates = candidates.filter(candidate => !directMembers.some(member => member.user_id === candidate.id))
  const workspaceMatches = (workspace: QAWorkspaceOut) => `${workspace.name} ${workspace.workspace_key}`.toLowerCase().includes(workspaceSearch.trim().toLowerCase())
  const workspaceGroups = parents.map(root => ({ root, children: managedWorkspaces.filter(row => row.parent_workspace_id === root.id) }))
    .filter(group => workspaceMatches(group.root) || group.children.some(workspaceMatches))

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
    if (!candidate || directMembers.some(member => member.user_id === candidate.id)) return
    await replace([...directMembers, {
      user_id: candidate.id, user_name: candidate.full_name, roles: ['WORKSPACE_MEMBER'], required: false,
    }])
    setMemberId('')
  }

  function workspaceButton(workspace: QAWorkspaceOut, child = false) {
    return <button type="button" key={workspace.id} className={`members-workspace-option${workspace.id === selectedId ? ' active' : ''}${child ? ' child' : ''}`} aria-current={workspace.id === selectedId ? 'true' : undefined} disabled={busy} onClick={() => setSelectedId(workspace.id)}>
      <span className="members-workspace-icon" aria-hidden="true">{child ? '↳' : '▦'}</span>
      <span><strong>{workspace.name}</strong><small>{workspace.workspace_key}{!workspace.is_active ? ' · Inactive' : ''}</small></span>
      <b title="Direct members">{groupedMembers(workspace).length}</b>
    </button>
  }

  return <div className="members-page">
    <PageHeader eyebrow="Administration" title="Workspace members" subtitle="Manage the people who can access your workspaces." />
    <ErrorText error={error} />
    {loading ? <div className="members-empty" role="status">Loading workspace members…</div> : <div className="members-layout">
      <aside className="members-directory" aria-label="Managed workspaces">
        <header><strong>Workspaces</strong><span>{managedWorkspaces.length}</span></header>
        <label className="members-search"><span className="sr-only">Search workspaces</span><input value={workspaceSearch} onChange={event => setWorkspaceSearch(event.target.value)} placeholder="Find a workspace…" /></label>
        <div className="members-workspace-list">
          {workspaceGroups.map(({ root, children }) => <div className="members-workspace-group" key={root.id}>
            {workspaceButton(root)}
            {children.filter(child => workspaceMatches(root) || workspaceMatches(child)).map(child => workspaceButton(child, true))}
          </div>)}
          {!workspaceGroups.length && <p className="members-empty">{managedWorkspaces.length ? 'No workspaces match your search.' : 'No workspaces are available to manage.'}</p>}
        </div>
        <footer>Select a workspace to manage its members.</footer>
      </aside>
      {selected ? <main className="members-content" aria-label="Workspace membership">
        <header className="members-heading"><div><span className="members-eyebrow">{selected.parent_workspace_name ? `${selected.parent_workspace_name} / ${selected.workspace_key}` : selected.workspace_key}</span><h2>{selected.name}</h2><p>{selected.parent_workspace_id ? 'Child workspace' : 'Parent workspace'} · People and access</p></div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} aria-expanded={adding} aria-controls="workspace-add-member" onClick={() => setAdding(!adding)}><IconPlus width={14} /> Add member</button>
        </header>
        <div className="members-statistics" aria-label="Membership summary">
          <div><strong>{displayedMembers.length}</strong><span>People with access</span></div>
          <div><strong>{directMembers.length}</strong><span>Direct memberships</span></div>
          <div><strong>{inheritedMembers.length}</strong><span>Inherited memberships</span></div>
        </div>
        {adding && <section className="members-add" id="workspace-add-member"><div><h3>Add a member</h3><p>Give an active user direct access to {selected.name}.</p></div>
          <div className="members-add-controls"><UserAssignSelect value={memberId} onChange={setMemberId} users={availableCandidates} disabled={busy || candidateLoading} placeholder={candidateLoading ? 'Loading active users…' : 'Search by name or department…'} />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || candidateLoading || !memberId} onClick={() => void addMember()}>{busy ? 'Saving…' : 'Add to workspace'}</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
          {!candidateLoading && !availableCandidates.length && <p role="status">No additional users are available to add.</p>}
        </section>}
        <section className="members-register" aria-label="People with access">
          <div className="members-toolbar"><label className="members-search"><span className="sr-only">Search members</span><input value={memberSearch} onChange={event => setMemberSearch(event.target.value)} placeholder="Search members…" /></label>
            <select aria-label="Filter membership source" value={accessFilter} onChange={event => setAccessFilter(event.target.value)}><option value="all">All access</option><option value="direct">Direct access only</option><option value="inherited">Inherited access</option></select>
          </div>
          <div className="members-table-scroll"><table className="members-table"><thead><tr><th>Member</th><th>Access source</th><th>Permission</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {pageMembers.map(member => <tr key={member.user_id}>
              <td><div className="members-person"><span className="members-avatar" aria-hidden="true">{member.user_name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</span><strong>{member.user_name}</strong></div></td>
              <td><span className={`members-source ${member.inherited ? 'inherited' : ''}`}>{member.inherited ? 'Inherited' : 'Direct'}</span>{member.inherited && <small className="members-origin">{parent?.name || 'Parent workspace'}</small>}</td>
              <td><span className="members-permission">{member.required ? 'System administrator' : member.roles.includes('PARENT_WORKSPACE_ADMIN') ? 'Parent administrator' : member.roles.includes('PARENT_WORKSPACE_VIEWER') ? 'Parent viewer' : 'Workspace member'}</span></td>
              <td>{member.inherited || member.required || member.roles.some(role => role === 'PARENT_WORKSPACE_ADMIN' || role === 'PARENT_WORKSPACE_VIEWER')
                ? <span className="members-managed" title="This access is managed by a System Administrator">Admin managed</span>
                : <button type="button" className="members-remove" disabled={busy} aria-label={`Remove ${member.user_name} from ${selected.name}`} onClick={() => void replace(directMembers.filter(row => row.user_id !== member.user_id))}>Remove</button>}</td>
            </tr>)}
            {!pageMembers.length && <tr><td colSpan={4}><div className="members-empty"><strong>{displayedMembers.length ? 'No matching members' : 'No members yet'}</strong><p>{displayedMembers.length ? 'Try another name or access filter.' : 'Add a member to give them access to this workspace.'}</p></div></td></tr>}
          </tbody></table></div>
          <footer className="members-pagination"><span>{visibleMembers.length ? `${(currentPage - 1) * 12 + 1}–${Math.min(currentPage * 12, visibleMembers.length)} of ${visibleMembers.length} members` : '0 members'}</span><div><button type="button" className="btn btn-sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage} / {pageCount}</span><button type="button" className="btn btn-sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></div></footer>
        </section>
        <p className="members-guidance">Inherited access and administrator permissions are managed by a System Administrator. Adding a member here does not change their permission profile.</p>
      </main> : <div className="members-empty">Select an available workspace to see its members.</div>}
    </div>}
  </div>
}
