import './ParentWorkspaceAdmin.css'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { ErrorText, PageHeader } from '../../components/Common'
import UserAssignSelect from '../../components/UserAssignSelect'
import { IconPlus, IconUsers } from '../../components/Icons'
import { uniqueWorkspaceAccess } from '../../constants'
import { LocalAdminWorkspaceCandidateOut, QAWorkspaceOut } from '../../types'

type GroupedMember = {
  user_id: number
  user_name: string
  username: string
  departments: string[]
  roles: string[]
  required: boolean
}

type DirectoryUser = GroupedMember & {
  inherited: boolean
  profileRoles: string[]
  access: 'direct' | 'inherited' | 'none'
}

type DepartmentDirectoryGroup = {
  key: string
  name: string
  members: DirectoryUser[]
}

function initials(value: string, fallback: string) {
  return value.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]).join('').toUpperCase() || fallback
}

function groupUsersByDepartment(members: DirectoryUser[]): DepartmentDirectoryGroup[] {
  const groups = new Map<string, DepartmentDirectoryGroup>()
  for (const member of members) {
    const departments = member.departments.length ? member.departments : ['']
    for (const department of departments) {
      const key = department || '__no_department__'
      const group = groups.get(key) || { key, name: department || 'No department', members: [] }
      group.members.push(member)
      groups.set(key, group)
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      members: [...group.members].sort((left, right) => left.user_name.localeCompare(right.user_name)),
    }))
    .sort((left, right) => (
      Number(left.key === '__no_department__') - Number(right.key === '__no_department__')
      || left.name.localeCompare(right.name)
    ))
}

function groupedMembers(workspace: QAWorkspaceOut | null): GroupedMember[] {
  const rows = new Map<number, GroupedMember>()
  for (const member of workspace?.members || []) {
    if (!member.is_active) continue
    const current = rows.get(member.user_id) || {
      user_id: member.user_id,
      user_name: member.user_name || `User ${member.user_id}`,
      username: member.user_username || '',
      departments: [],
      roles: [],
      required: false,
    }
    if (!current.username && member.user_username) current.username = member.user_username
    current.departments = [...new Set([...current.departments, ...(member.user_departments || [])])]
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
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [page, setPage] = useState(1)
  const [directoryState, setDirectoryState] = useState<{ workspaceId: number; departmentKey: string | null } | null>(null)

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
  const displayedMemberIds = new Set(displayedMembers.map((member) => member.user_id))
  const directoryUsers: DirectoryUser[] = [
    ...displayedMembers.map((member) => ({
      ...member,
      profileRoles: [],
      access: member.inherited ? 'inherited' as const : 'direct' as const,
    })),
    ...candidates.filter((candidate) => !displayedMemberIds.has(candidate.id)).map((candidate) => ({
      user_id: candidate.id,
      user_name: candidate.full_name,
      username: candidate.username,
      departments: candidate.departments?.length
        ? candidate.departments
        : candidate.department ? [candidate.department] : [],
      roles: [],
      required: false,
      inherited: false,
      profileRoles: candidate.roles || [],
      access: 'none' as const,
    })),
  ]
  const departmentOptions = [...new Set(directoryUsers.flatMap((member) => member.departments))]
    .sort((left, right) => left.localeCompare(right))

  const loadCandidates = useCallback(async (workspaceId: number) => {
    try {
      setCandidates(await api.get<LocalAdminWorkspaceCandidateOut[]>(`/api/workspaces/${workspaceId}/member-candidates`))
    } catch (err) { setCandidates([]); setError(err) }
  }, [])
  useEffect(() => {
    let active = true
    setMemberId(''); setCandidates([]); setAdding(false)
    setMemberSearch(''); setAccessFilter('all'); setDepartmentFilter('all'); setPage(1)
    if (!selectedId) { setCandidateLoading(false); return }
    setCandidateLoading(true)
    api.get<LocalAdminWorkspaceCandidateOut[]>(`/api/workspaces/${selectedId}/member-candidates`)
      .then(rows => { if (active) setCandidates(rows) })
      .catch(err => { if (active) setError(err) })
      .finally(() => { if (active) setCandidateLoading(false) })
    return () => { active = false }
  }, [selectedId])
  useEffect(() => { setPage(1); setDirectoryState(null) }, [selectedId, memberSearch, accessFilter, departmentFilter])
  const normalizedMemberSearch = memberSearch.trim().toLowerCase()
  const visibleMembers = directoryUsers.filter(member => {
    const matchesSearch = !normalizedMemberSearch || [
      member.user_name,
      member.username,
      ...member.departments,
      ...member.profileRoles,
    ].some((value) => value.toLowerCase().includes(normalizedMemberSearch))
    const matchesAccess = accessFilter === 'all'
      || (accessFilter === 'access' && member.access !== 'none')
      || member.access === accessFilter
    const matchesDepartment = departmentFilter === 'all'
      || (departmentFilter === '__none__' ? !member.departments.length : member.departments.includes(departmentFilter))
    return matchesSearch && matchesAccess && matchesDepartment
  }).sort((left, right) => {
    const leftDepartment = left.departments[0] || '\uffff'
    const rightDepartment = right.departments[0] || '\uffff'
    return leftDepartment.localeCompare(rightDepartment) || left.user_name.localeCompare(right.user_name)
  })
  const departmentGroups = groupUsersByDepartment(visibleMembers)
  const departmentPlacementCount = departmentGroups.reduce((total, group) => total + group.members.length, 0)
  const pageCount = Math.max(1, Math.ceil(departmentGroups.length / 6))
  const currentPage = Math.min(page, pageCount)
  const pageGroups = departmentGroups.slice((currentPage - 1) * 6, currentPage * 6)
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
    await addDirectoryMember(Number(memberId))
    setMemberId('')
  }

  async function addDirectoryMember(userId: number) {
    const candidate = candidates.find((row) => row.id === userId)
    if (!candidate || directMembers.some(member => member.user_id === candidate.id)) return
    await replace([...directMembers, {
      user_id: candidate.id,
      user_name: candidate.full_name,
      username: candidate.username,
      departments: candidate.departments || [],
      roles: ['WORKSPACE_MEMBER'],
      required: false,
    }])
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
          <div><strong>{directoryUsers.length}</strong><span>Directory users</span></div>
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
        <section className="members-register" aria-label="Workspace user directory">
          <div className="members-toolbar"><label className="members-search"><span className="sr-only">Search users</span><input value={memberSearch} onChange={event => setMemberSearch(event.target.value)} placeholder="Search name, user ID, department, or role…" /></label>
            <select aria-label="Filter workspace access" value={accessFilter} onChange={event => setAccessFilter(event.target.value)}><option value="all">All users</option><option value="access">People with access</option><option value="direct">Direct access only</option><option value="inherited">Inherited access</option><option value="none">Not added</option></select>
            <select aria-label="Filter department" value={departmentFilter} onChange={event => setDepartmentFilter(event.target.value)}><option value="all">All departments</option>{departmentOptions.map(department => <option key={department} value={department}>{department}</option>)}<option value="__none__">No department</option></select>
          </div>
          <div className="members-directory-heading">
            <div><small>DEPARTMENT DIRECTORY</small><h3>Member directory</h3><p>{visibleMembers.length} {visibleMembers.length === 1 ? 'person' : 'people'} across {departmentPlacementCount} department {departmentPlacementCount === 1 ? 'placement' : 'placements'}. Open a department to review its users and workspace access.</p></div>
            <span className="members-directory-count"><IconUsers width={14} height={14} /> {departmentGroups.length} {departmentGroups.length === 1 ? 'department' : 'departments'}</span>
          </div>
          {pageGroups.length ? <div className="members-department-grid">
            {pageGroups.map((group, groupIndex) => {
              const directCount = group.members.filter((member) => member.access === 'direct').length
              const inheritedCount = group.members.filter((member) => member.access === 'inherited').length
              const notAddedCount = group.members.length - directCount - inheritedCount
              const isGroupOpen = directoryState?.workspaceId === selected.id
                ? directoryState.departmentKey === group.key
                : groupIndex === 0
              return <details className="members-department-card" key={group.key} open={isGroupOpen}>
                <summary className="members-department-head" onClick={(event) => {
                  event.preventDefault()
                  setDirectoryState({ workspaceId: selected.id, departmentKey: isGroupOpen ? null : group.key })
                }}>
                  <span className="members-department-icon" aria-hidden="true">{initials(group.name, 'DP')}</span>
                  <span className="members-department-copy"><strong>{group.name}</strong><small>{directCount ? `${directCount} direct` : 'No direct access'}{inheritedCount ? ` · ${inheritedCount} inherited` : ''}{notAddedCount ? ` · ${notAddedCount} not added` : ''}</small></span>
                  <span className="members-department-count">{group.members.length} {group.members.length === 1 ? 'user' : 'users'}</span>
                </summary>
                <div className="members-department-roster">
                  {group.members.map((member) => <div className="members-person-row" key={`${group.key}-${member.user_id}`}>
                    <span className="members-avatar" aria-hidden="true">{initials(member.user_name, 'U')}</span>
                    <span className="members-person-copy"><strong>{member.user_name}</strong><small>{member.username ? `User ID: ${member.username}` : `User ${member.user_id}`}</small><span className="members-access-detail"><span className={`members-source ${member.access}`}>{member.access === 'inherited' ? 'Inherited' : member.access === 'direct' ? 'Direct' : 'Not added'}</span><span className="members-permission">{member.access === 'none' ? 'No workspace access' : member.required ? 'System administrator' : member.roles.includes('PARENT_WORKSPACE_ADMIN') ? 'Parent administrator' : member.roles.includes('PARENT_WORKSPACE_VIEWER') ? 'Parent viewer' : 'Workspace member'}</span>{member.inherited && <small className="members-origin">from {parent?.name || 'Parent workspace'}</small>}</span></span>
                    <span className="members-person-actions">{member.access === 'none'
                      ? <button type="button" className="members-add-inline" disabled={busy || candidateLoading} aria-label={`Add ${member.user_name} to ${selected.name}`} onClick={() => void addDirectoryMember(member.user_id)}>Add member</button>
                      : member.inherited || member.required || member.roles.some(role => role === 'PARENT_WORKSPACE_ADMIN' || role === 'PARENT_WORKSPACE_VIEWER')
                      ? <span className="members-managed" title="This access is managed by a System Administrator">Admin managed</span>
                      : <button type="button" className="members-remove" disabled={busy} aria-label={`Remove ${member.user_name} from ${selected.name}`} onClick={() => void replace(directMembers.filter(row => row.user_id !== member.user_id))}>Remove</button>}</span>
                  </div>)}
                </div>
              </details>
            })}
          </div> : <div className="members-empty"><strong>{directoryUsers.length ? 'No matching users' : candidateLoading ? 'Loading department directory…' : 'No users available'}</strong><p>{directoryUsers.length ? 'Try another search, access, or department filter.' : candidateLoading ? 'Active users will appear here shortly.' : 'No active visible users are available for this workspace.'}</p></div>}
          <footer className="members-pagination"><span>{departmentGroups.length ? `${(currentPage - 1) * 6 + 1}–${Math.min(currentPage * 6, departmentGroups.length)} of ${departmentGroups.length} departments` : '0 departments'}</span><div><button type="button" className="btn btn-sm" disabled={currentPage === 1} onClick={() => { setDirectoryState(null); setPage(currentPage - 1) }}>Previous</button><span>{currentPage} / {pageCount}</span><button type="button" className="btn btn-sm" disabled={currentPage === pageCount} onClick={() => { setDirectoryState(null); setPage(currentPage + 1) }}>Next</button></div></footer>
        </section>
        <p className="members-guidance">Inherited access and administrator permissions are managed by a System Administrator. Adding a member here does not change their permission profile.</p>
      </main> : <div className="members-empty">Select an available workspace to see its members.</div>}
    </div>}
  </div>
}
