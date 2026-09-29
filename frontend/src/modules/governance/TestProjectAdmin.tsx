import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { ErrorText, Field, Modal, Table, type TableColumn } from '../../components/Common'
import ClearableSearchInput from '../../components/ClearableSearchInput'
import SearchableSelect from '../../components/SearchableSelect'
import UserAssignSelect from '../../components/UserAssignSelect'
import { isSelectableUser } from '../../constants'
import {
  DepartmentOut, TestProjectOut, UserOption, UserOut,
} from '../../types'
import { ManageViewAccessModal } from '../test-management/TestProjects'


function projectStatus(project: TestProjectOut): 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' {
  if (project.is_archived) return 'ARCHIVED'
  return project.is_active ? 'ACTIVE' : 'INACTIVE'
}


function ChangeProjectOwnerModal({ project, onClose, onSaved }: {
  project: TestProjectOut
  onClose: () => void
  onSaved: (project: TestProjectOut) => void
}) {
  const [candidates, setCandidates] = useState<UserOption[]>([])
  const [ownerId, setOwnerId] = useState(project.owner_id ? String(project.owner_id) : '')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let active = true
    api.get<UserOption[]>(`/api/test-projects/eligible-users?project_id=${project.id}`)
      .then((rows) => { if (active) { setCandidates(rows); setLoading(false) } })
      .catch((err) => { if (active) { setError(err); setLoading(false) } })
    return () => { active = false }
  }, [project.id])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!ownerId) { setError(new Error('Select a project owner')); return }
    setBusy(true); setError(null)
    try {
      const updated = await api.patch<TestProjectOut>(`/api/test-projects/${project.id}`, {
        owner_id: Number(ownerId),
      })
      onSaved(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return <Modal title={`Change owner · ${project.project_key}`} onClose={onClose} variant="dialog" preventBackdropClose closeDisabled={busy}>
    <form onSubmit={save}>
      <p className="muted small">The new owner must be active, assignment-visible, and have working QA access to <strong>{project.qa_workspace_name || 'the owning workspace'}</strong>.</p>
      <Field label="Project owner *">
        <UserAssignSelect
          value={ownerId}
          onChange={setOwnerId}
          disabled={loading || busy}
          placeholder={loading ? 'Loading eligible owners…' : 'Select an eligible owner…'}
          users={candidates.filter(isSelectableUser)}
        />
      </Field>
      <ErrorText error={error} />
      <div className="access-row-actions">
        <button className="btn btn-primary" disabled={loading || busy || !ownerId || Number(ownerId) === project.owner_id}>{busy ? 'Saving…' : 'Update owner'}</button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </form>
  </Modal>
}


export default function TestProjectAdmin() {
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [directoryUsers, setDirectoryUsers] = useState<UserOut[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'>('ALL')
  const [workspace, setWorkspace] = useState('ALL')
  const [ownerProject, setOwnerProject] = useState<TestProjectOut | null>(null)
  const [sharingProject, setSharingProject] = useState<TestProjectOut | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [projectRows, departmentRows, userRows] = await Promise.all([
        api.getAll<TestProjectOut>('/api/test-projects?include_inactive=true'),
        api.get<DepartmentOut[]>('/api/departments'),
        api.get<UserOut[]>('/api/auth/users?all_workspaces=true'),
      ])
      setProjects(projectRows)
      setDepartments(departmentRows)
      setDirectoryUsers(userRows)
    } catch (err) { setError(err) } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const workspaceOptions = useMemo(() => {
    const names = new Map<number, string>()
    for (const project of projects) {
      if (project.qa_workspace_id != null) names.set(project.qa_workspace_id, project.qa_workspace_name || `Workspace #${project.qa_workspace_id}`)
    }
    return Array.from(names, ([id, name]) => ({ value: String(id), label: name })).sort((a, b) => a.label.localeCompare(b.label))
  }, [projects])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return projects.filter((project) => {
      if (status !== 'ALL' && projectStatus(project) !== status) return false
      if (workspace !== 'ALL' && String(project.qa_workspace_id || '') !== workspace) return false
      if (!needle) return true
      return [project.project_key, project.name, project.application_name, project.department, project.owner_name, project.qa_workspace_name]
        .some((value) => (value || '').toLowerCase().includes(needle))
    })
  }, [projects, search, status, workspace])

  const columns: TableColumn<TestProjectOut>[] = [
    { key: 'project_key', header: 'Project', render: (project) => <div className="access-person-cell"><span className="access-avatar">{project.name.slice(0, 2).toUpperCase()}</span><span><strong>{project.project_key}</strong><small>{project.name}</small></span></div>, filterValue: (project) => `${project.project_key} ${project.name}` },
    { key: 'application_name', header: 'Application', render: (project) => project.application_name || '—' },
    { key: 'qa_workspace_name', header: 'Owning workspace', render: (project) => <div className="access-scope-summary"><strong>{project.qa_workspace_name || 'Not assigned'}</strong><small>Workspace-owned metadata</small></div> },
    { key: 'department', header: 'Team / department', render: (project) => project.department || '—' },
    { key: 'owner_name', header: 'Project owner', render: (project) => <div className="access-scope-summary"><strong>{project.owner_name || 'Unassigned'}</strong><small>{project.owner_id ? `User #${project.owner_id}` : 'Needs assignment'}</small></div> },
    { key: 'is_active', header: 'Status', render: (project) => { const value = projectStatus(project); return <span className={`badge ${value === 'ACTIVE' ? 'badge-green' : value === 'ARCHIVED' ? 'badge-gray' : 'badge-yellow'}`}>{value === 'ACTIVE' ? 'Active' : value === 'ARCHIVED' ? 'Archived' : 'Inactive'}</span> }, filterValue: projectStatus },
    { key: 'actions', header: 'Governance', filterable: false, render: (project) => <div className="access-row-actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => setOwnerProject(project)}>Change owner</button><button type="button" className="btn btn-sm" onClick={() => setSharingProject(project)}>Manage sharing</button></div> },
  ]

  return <div className="card access-users-card">
    <div className="access-card-heading">
      <div><span>Test management governance</span><h3>Test projects</h3><p>Reassign ownership and share a project with another department/team, individual, or workspace without moving its existing test assets.</p></div>
      <strong>{visible.length} shown</strong>
    </div>
    <div className="access-user-toolbar">
      <ClearableSearchInput aria-label="Search test projects" wrapperClassName="access-user-search" value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch('')} clearLabel="Clear project search" placeholder="Search project, application, owner, department, or workspace…" />
      <SearchableSelect ariaLabel="Filter projects by status" searchable={false} value={status} onChange={(value) => setStatus(value as typeof status)} options={[
        { value: 'ALL', label: 'All project statuses' }, { value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }, { value: 'ARCHIVED', label: 'Archived' },
      ]} />
      <SearchableSelect ariaLabel="Filter projects by workspace" value={workspace} onChange={setWorkspace} options={[{ value: 'ALL', label: 'All workspaces' }, ...workspaceOptions]} />
      <button type="button" className="btn" disabled={loading} onClick={() => void load()}>{loading ? 'Loading…' : 'Refresh'}</button>
    </div>
    <ErrorText error={error} />
    {!loading && <Table<TestProjectOut> rowKey="id" rows={visible} columns={columns} />}
    {!loading && visible.length === 0 && <div className="access-empty-search"><strong>No test projects match these filters</strong><span>Try another project, owner, workspace, or status.</span><button type="button" className="btn" onClick={() => { setSearch(''); setStatus('ALL'); setWorkspace('ALL') }}>Clear filters</button></div>}
    {ownerProject && <ChangeProjectOwnerModal project={ownerProject} onClose={() => setOwnerProject(null)} onSaved={(updated) => { setProjects((rows) => rows.map((row) => row.id === updated.id ? updated : row)); setOwnerProject(null) }} />}
    {sharingProject && <ManageViewAccessModal project={sharingProject} departments={departments} directoryUsers={directoryUsers} onClose={() => setSharingProject(null)} />}
  </div>
}
