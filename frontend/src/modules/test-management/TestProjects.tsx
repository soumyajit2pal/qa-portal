import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import { hasRole, TEST_PROJECT_ROLES } from '../../constants'
import {
  ApplicationMasterOut, TestProjectOut, TestCaseOut, TestCycleOut, ApprovalActionOut, DepartmentOut,
  UserOut, TestProjectMemberOut,
} from '../../types'
import JiraActivity from '../../components/JiraActivity'
import ClearableSearchInput from '../../components/ClearableSearchInput'
import ConfirmModal from '../../components/ConfirmModal'

// Project Management module -- one Test Project per Application, by
// explicit product decision (reuses the existing Application Name Master
// list rather than a second, parallel "application name" concept). This is
// the entry point for the whole Test Management feature (Project
// Management / Test Repository / Test Execution): Test Repository and Test
// Execution both start with "pick a Project" before showing anything else.
const CAN_MANAGE_ROLES = ['QA_ENGINEER', 'QA_LEAD']

// SRS PRJ-001/PRJ-005 -- editing a project's own record (name/department/
// application/description/owner) is restricted to that project's Owner, or
// system QA_LEAD/Admin -- a QA_ENGINEER who isn't this specific project's
// owner can no longer edit its details, even though they still manage
// Projects in general (create, request activation/deactivation). Mirrors
// backend deps.py::can_manage_project exactly.
function canEditProjectDetails(user: UserOut | null | undefined, project: TestProjectOut): boolean {
  return hasRole(user, 'QA_LEAD') || (hasRole(user, 'QA_ENGINEER') && project.owner_id === user?.id)
}

function NewProjectModal({ applications, departments, users, currentUserId, onClose, onCreated }: {
  applications: ApplicationMasterOut[]
  departments: DepartmentOut[]
  users: UserOut[]
  currentUserId?: number
  onClose: () => void
  onCreated: (p: TestProjectOut) => void
}) {
  const [applicationId, setApplicationId] = useState<number | ''>('')
  const [name, setName] = useState('')
  const [department, setDepartment] = useState('')
  const [description, setDescription] = useState('')
  const [ownerId, setOwnerId] = useState<number | ''>(currentUserId ?? '')
  const [defaultReviewerId, setDefaultReviewerId] = useState<number | ''>('')
  const [defaultQaLeadId, setDefaultQaLeadId] = useState<number | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  function pickApplication(idStr: string) {
    const id = idStr ? Number(idStr) : ''
    setApplicationId(id)
    const app = applications.find((a) => a.id === id)
    if (app) {
      setName(app.name)
      setDepartment(departments.some((item) => item.name === app.department) ? (app.department || '') : '')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Project name cannot be blank')); return }
    if (!department) { setError(new Error('Select a department')); return }
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<TestProjectOut>('/api/test-projects', {
        name: name.trim(),
        application_master_id: applicationId || null,
        department,
        description: description.trim() || null,
        owner_id: ownerId || null,
        default_reviewer_id: defaultReviewerId || null,
        default_qa_lead_id: defaultQaLeadId || null,
      })
      onCreated(created)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Test Project" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Application (optional -- links this Project to an approved application)">
          {/* Searchable -- same growing-list case as Application Name in the
              QA Request wizard (this reuses that same approved-name list). */}
          <SearchableSelect
            value={applicationId === '' ? '' : String(applicationId)}
            onChange={pickApplication}
            placeholder="-- Not linked --"
            options={[
              { value: '', label: '-- Not linked --' },
              ...applications.map((a) => ({ value: String(a.id), label: a.name })),
            ]}
          />
        </Field>
        <Field label="Project Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Department *">
          <SearchableSelect disabled={applicationId !== ''} value={department} onChange={setDepartment} placeholder={applicationId !== '' ? "Mapped from selected application" : "Select department…"} options={departments.map((item) => ({ value: item.name, label: item.name }))} />
          {applicationId !== '' && <small className="muted">Department is controlled by the selected Application.</small>}
        </Field>
        {/* SRS PRJ-001/PRJ-005 -- the owner is auto-added as a project member
            with role "Owner" and is the only person (besides QA Lead/Admin)
            who can add/remove other members. Defaults to whoever is creating
            the project. */}
        <Field label="Owner">
          <SearchableSelect
            value={ownerId === '' ? '' : String(ownerId)}
            onChange={(v) => setOwnerId(v ? Number(v) : '')}
            placeholder="-- Select owner --"
            options={users.filter((u) => u.is_active).map((u) => ({ value: String(u.id), label: u.full_name }))}
          />
        </Field>
        {/* 2026-08 Test Approval Workflow refactor (APR-001) -- project-level
            defaults only, used to pre-fill Stage 1/Stage 2 assignment when a
            test case has no per-item override yet (see PATCH .../approvers on
            TestRepository.tsx). The selected assignee owns that stage's
            decision after the required project-role check. */}
        <Field label="Default Reviewer (Stage 1)">
          <SearchableSelect
            value={defaultReviewerId === '' ? '' : String(defaultReviewerId)}
            onChange={(v) => setDefaultReviewerId(v ? Number(v) : '')}
            placeholder="-- No default --"
            options={users.filter((u) => u.is_active && u.id !== currentUserId && u.id !== ownerId).map((u) => ({ value: String(u.id), label: u.full_name }))}
          />
          <small className="muted">The selected person is automatically added to Members as Reviewer and becomes the Stage 1 default.</small>
        </Field>
        <Field label="Default Project Lead (Stage 2)">
          <SearchableSelect
            value={defaultQaLeadId === '' ? '' : String(defaultQaLeadId)}
            onChange={(v) => setDefaultQaLeadId(v ? Number(v) : '')}
            placeholder="-- No default --"
            options={users.filter((u) => u.is_active && u.roles.includes('QA_LEAD')).map((u) => ({ value: String(u.id), label: u.full_name }))}
          />
          <small className="muted">The selected person is automatically added to Members as Project Lead and becomes the Stage 2 default.</small>
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating...' : 'Create Project'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// Reported directly: "Once Project is created, give option to edit
// details." Before this, the only post-creation action on a Project was
// Activate/Deactivate -- name, linked Application, department, and
// description could never be changed again. Mirrors NewProjectModal's own
// fields/behavior (including auto-filling name/department when an
// Application is picked), just pre-filled from the existing project and
// PATCHing instead of POSTing.
function EditProjectModal({ project, applications, departments, users, onClose, onUpdated }: {
  project: TestProjectOut
  applications: ApplicationMasterOut[]
  departments: DepartmentOut[]
  users: UserOut[]
  onClose: () => void
  onUpdated: (p: TestProjectOut) => void
}) {
  const [applicationId, setApplicationId] = useState<number | ''>(project.application_master_id ?? '')
  const [name, setName] = useState(project.name)
  const [department, setDepartment] = useState(project.department || '')
  const [description, setDescription] = useState(project.description || '')
  const [ownerId, setOwnerId] = useState<number | ''>(project.owner_id ?? '')
  const [defaultReviewerId, setDefaultReviewerId] = useState<number | ''>(project.default_reviewer_id ?? '')
  const [defaultQaLeadId, setDefaultQaLeadId] = useState<number | ''>(project.default_qa_lead_id ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  function pickApplication(idStr: string) {
    const id = idStr ? Number(idStr) : ''
    setApplicationId(id)
    const app = applications.find((a) => a.id === id)
    if (app) {
      setName(app.name)
      setDepartment(departments.some((item) => item.name === app.department) ? (app.department || '') : '')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Project name cannot be blank')); return }
    if (!department) { setError(new Error('Select a department')); return }
    setBusy(true)
    setError(null)
    try {
      const updated = await api.patch<TestProjectOut>(`/api/test-projects/${project.id}`, {
        name: name.trim(),
        application_master_id: applicationId || null,
        department,
        description: description.trim() || null,
        owner_id: ownerId || null,
        default_reviewer_id: defaultReviewerId || null,
        default_qa_lead_id: defaultQaLeadId || null,
      })
      onUpdated(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Edit ${project.project_key}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Application (optional -- links this Project to an approved application)">
          <SearchableSelect
            value={applicationId === '' ? '' : String(applicationId)}
            onChange={pickApplication}
            placeholder="-- Not linked --"
            options={[
              { value: '', label: '-- Not linked --' },
              ...applications.map((a) => ({ value: String(a.id), label: a.name })),
            ]}
          />
        </Field>
        <Field label="Project Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Department *">
          <SearchableSelect disabled={applicationId !== ''} value={department} onChange={setDepartment} placeholder={applicationId !== '' ? "Mapped from selected application" : "Select department…"} options={departments.map((item) => ({ value: item.name, label: item.name }))} />
          {applicationId !== '' && <small className="muted">Department is controlled by the selected Application.</small>}
        </Field>
        <Field label="Owner">
          <SearchableSelect
            value={ownerId === '' ? '' : String(ownerId)}
            onChange={(v) => setOwnerId(v ? Number(v) : '')}
            placeholder="-- Select owner --"
            options={users.filter((u) => u.is_active).map((u) => ({ value: String(u.id), label: u.full_name }))}
          />
        </Field>
        <Field label="Default Reviewer (Stage 1)">
          <SearchableSelect
            value={defaultReviewerId === '' ? '' : String(defaultReviewerId)}
            onChange={(v) => setDefaultReviewerId(v ? Number(v) : '')}
            placeholder="-- No default --"
            options={users.filter((u) => u.is_active && u.id !== ownerId).map((u) => ({ value: String(u.id), label: u.full_name }))}
          />
          <small className="muted">The selected person is automatically added to Members as Reviewer and becomes the Stage 1 default.</small>
        </Field>
        <Field label="Default Project Lead (Stage 2)">
          <SearchableSelect
            value={defaultQaLeadId === '' ? '' : String(defaultQaLeadId)}
            onChange={(v) => setDefaultQaLeadId(v ? Number(v) : '')}
            placeholder="-- No default --"
            options={users.filter((u) => u.is_active && u.roles.includes('QA_LEAD')).map((u) => ({ value: String(u.id), label: u.full_name }))}
          />
          <small className="muted">The selected person is automatically added to Members as Project Lead and becomes the Stage 2 default.</small>
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

// PRJ-003 -- archiving is deliberately final-feeling (separate from the
// two-step activate/deactivate approval flow above): QA Lead/Admin only, an
// optional reason for the audit trail, and always also forces is_active
// False on the backend.
function ArchiveProjectModal({ project, onClose, onDone }: {
  project: TestProjectOut
  onClose: () => void
  onDone: (p: TestProjectOut) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.post<TestProjectOut>(`/api/test-projects/${project.id}/archive`, {
        reason: reason.trim() || null,
      })
      onDone(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Archive ${project.project_key}?`} onClose={onClose} variant="dialog" preventBackdropClose>
      <p>
        Archiving <strong>{project.project_key} · {project.name}</strong> also deactivates it. Existing folders,
        test cases, cycles, executions, and activity are retained but the project can no longer be used for new
        test work until it's unarchived.
      </p>
      <Field label="Reason (optional)">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this project being archived?" />
      </Field>
      <ErrorText error={error} />
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn btn-danger" disabled={busy} onClick={submit}>{busy ? 'Archiving…' : 'Archive project'}</button>
        <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

function UnarchiveProjectModal({ project, onClose, onDone }: {
  project: TestProjectOut
  onClose: () => void
  onDone: (p: TestProjectOut) => void
}) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.post<TestProjectOut>(`/api/test-projects/${project.id}/unarchive`, {})
      onDone(updated)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Restore ${project.project_key} from archive?`} onClose={onClose} variant="dialog" preventBackdropClose>
      <p>
        <strong>{project.project_key} · {project.name}</strong> will come back as Inactive, not Active --
        reactivating it for new work is still a separate step.
      </p>
      <ErrorText error={error} />
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Restoring…' : 'Restore project'}</button>
        <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

// PRJ-005/GOV-001 -- membership management, restricted (on the backend) to
// this project's own owner or a QA Lead/Admin.
function ProjectMembersModal({ project, users, canManageMembers, onClose }: {
  project: TestProjectOut
  users: UserOut[]
  canManageMembers: boolean
  onClose: () => void
}) {
  const [members, setMembers] = useState<TestProjectMemberOut[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [addUserId, setAddUserId] = useState<number | ''>('')
  const [addRole, setAddRole] = useState<string>(TEST_PROJECT_ROLES[TEST_PROJECT_ROLES.length - 1] || 'Tester')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setMembers(await api.get<TestProjectMemberOut[]>(`/api/test-projects/${project.id}/members`)) }
    catch (err) { setError(err) } finally { setLoading(false) }
  }, [project.id])
  useEffect(() => { load() }, [load])

  const memberUserIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members])
  const addableUsers = useMemo(() => users.filter((u) => u.is_active && !memberUserIds.has(u.id)), [users, memberUserIds])

  async function addMember() {
    if (!addUserId) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<TestProjectMemberOut>(`/api/test-projects/${project.id}/members`, {
        user_id: addUserId, project_role: addRole,
      })
      setMembers((prev) => [...prev, created])
      setAddUserId('')
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function changeRole(member: TestProjectMemberOut, role: string) {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.patch<TestProjectMemberOut>(`/api/test-projects/${project.id}/members/${member.id}`, { project_role: role })
      setMembers((prev) => prev.map((m) => m.id === updated.id ? updated : m))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  async function removeMember(member: TestProjectMemberOut) {
    setBusy(true)
    setError(null)
    try {
      await api.del(`/api/test-projects/${project.id}/members/${member.id}`)
      setMembers((prev) => prev.filter((m) => m.id !== member.id))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title={`${project.project_key} · Members`} onClose={onClose} wide>
      <ErrorText error={error} />
      {loading ? <p className="muted">Loading members…</p> : (
        <table className="simple-table">
          <thead><tr><th>Name</th><th>Email</th><th>Project role</th>{canManageMembers && <th></th>}</tr></thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id}>
                <td>{member.user_name || `User #${member.user_id}`}</td>
                <td>{member.user_email || '—'}</td>
                <td>
                  {canManageMembers && member.user_id !== project.owner_id ? (
                    <select value={member.project_role} disabled={busy} onChange={(e) => changeRole(member, e.target.value)}>
                      {TEST_PROJECT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : member.project_role}
                </td>
                {canManageMembers && (
                  <td>
                    {member.user_id !== project.owner_id && (
                      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => removeMember(member)}>Remove</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {members.length === 0 && (
              <tr><td colSpan={canManageMembers ? 4 : 3} className="muted">No members yet.</td></tr>
            )}
          </tbody>
        </table>
      )}
      {canManageMembers && (
        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Field label="Add member">
              <SearchableSelect
                value={addUserId === '' ? '' : String(addUserId)}
                onChange={(v) => setAddUserId(v ? Number(v) : '')}
                placeholder="-- Select user --"
                options={addableUsers.map((u) => ({ value: String(u.id), label: u.full_name }))}
              />
            </Field>
          </div>
          <Field label="Role">
            <select value={addRole} onChange={(e) => setAddRole(e.target.value)}>
              {TEST_PROJECT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <button className="btn btn-primary" disabled={busy || !addUserId} onClick={addMember}>Add</button>
        </div>
      )}
    </Modal>
  )
}

export default function TestProjects() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const canManage = hasRole(user, ...CAN_MANAGE_ROLES)
  // Reported directly: "Project Activation, deactivation should need
  // approval from QA lead." QA Lead (Admin bypasses via hasRole) can still
  // flip is_active immediately, same as before -- only a QA Engineer's
  // toggle now goes through a request/approve step (see changeProjectStatus
  // and the new Approve/Reject flow below).
  const canReview = hasRole(user, 'QA_LEAD')
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [applications, setApplications] = useState<ApplicationMasterOut[]>([])
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [showNew, setShowNew] = useState(false)
  const [summaries, setSummaries] = useState<Record<number, { cases: number; cycles: number }>>({})
  const [activityProject, setActivityProject] = useState<TestProjectOut | null>(null)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [statusProject, setStatusProject] = useState<TestProjectOut | null>(null)
  const [editProject, setEditProject] = useState<TestProjectOut | null>(null)
  const [archiveProject, setArchiveProject] = useState<TestProjectOut | null>(null)
  const [unarchiveProject, setUnarchiveProject] = useState<TestProjectOut | null>(null)
  const [membersProject, setMembersProject] = useState<TestProjectOut | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [projectFilter, setProjectFilter] = useState<'active' | 'inactive' | 'archived' | 'all'>('active')
  // Reported directly, alongside the approval workflow above: "Search under
  // project is not working" -- this page never had a search box at all, only
  // the Active/Inactive/All pill-tabs, so typing anywhere did nothing.
  const [search, setSearch] = useState('')
  const [activationReview, setActivationReview] = useState<{ project: TestProjectOut; decision: 'APPROVE' | 'REJECT' } | null>(null)
  const [reviewComments, setReviewComments] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)

  async function openActivity(project: TestProjectOut) {
    setActivityProject(project)
    try { setActivity(await api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_PROJECT&entity_id=${project.id}`)) }
    catch (err) { setError(err); setActivity([]) }
  }

  const load = useCallback(async () => {
    try {
      const [p, a, d, u] = await Promise.all([
        api.get<TestProjectOut[]>('/api/test-projects?include_inactive=true'),
        api.get<ApplicationMasterOut[]>('/api/application-names'),
        api.get<DepartmentOut[]>('/api/departments'),
        // Test Management-scoped picker -- see constants.
        // TEST_MANAGEMENT_ELIGIBLE_DEPARTMENTS on the backend; do not swap
        // this back to the app-wide /api/auth/users list.
        api.get<UserOut[]>('/api/test-projects/eligible-users'),
      ])
      setProjects(p); setApplications(a); setDepartments(d); setUsers(u)
      const stats = await Promise.all(p.map(async (project) => {
        const [cases, cycles] = await Promise.all([
          api.get<TestCaseOut[]>(`/api/test-repository/projects/${project.id}/test-cases`),
          api.get<TestCycleOut[]>(`/api/test-execution/projects/${project.id}/cycles`),
        ])
        return [project.id, { cases: cases.length, cycles: cycles.length }] as const
      }))
      setSummaries(Object.fromEntries(stats))
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  // Deep-link support, same pattern as Functional.tsx/SAST.tsx/etc.'s own
  // `?open=<request_id>` -- this page has no separate single-project detail
  // view to jump into (the pending-activation banner is shown inline per
  // row, see below), so "opening" a project here means filtering the list
  // down to just that one project_key instead. Used by the Pending
  // Approvals feed to land a QA Lead directly on the specific project
  // awaiting their activation/deactivation decision.
  useEffect(() => {
    const openKey = searchParams.get('open')
    if (!openKey || projects.length === 0) return
    setSearch(openKey)
    setSearchParams((p) => { p.delete('open'); return p }, { replace: true })
  }, [projects, searchParams, setSearchParams])

  const applicationNameById = useMemo(() => new Map(applications.map((a) => [a.id, a.name])), [applications])
  const archivedCount = projects.filter((project) => project.is_archived).length
  const activeCount = projects.filter((project) => project.is_active && !project.is_archived).length
  const inactiveCount = projects.filter((project) => !project.is_active && !project.is_archived).length
  const visibleProjects = useMemo(() => {
    let rows = projects.filter((project) => {
      if (projectFilter === 'all') return true
      if (projectFilter === 'archived') return project.is_archived
      if (project.is_archived) return false
      return projectFilter === 'active' ? project.is_active : !project.is_active
    })
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((project) => [
        project.name, project.project_key, project.department,
        project.application_master_id ? applicationNameById.get(project.application_master_id) : null,
      ].some((v) => String(v || '').toLowerCase().includes(q)))
    }
    return rows
  }, [projects, projectFilter, search, applicationNameById])

  async function changeProjectStatus() {
    if (!statusProject) return
    setStatusBusy(true)
    setError(null)
    try {
      const updated = await api.patch<TestProjectOut>(`/api/test-projects/${statusProject.id}`, {
        is_active: !statusProject.is_active,
      })
      setProjects((rows) => rows.map((project) => project.id === updated.id ? updated : project))
      setStatusProject(null)
    } catch (err) {
      setError(err)
    } finally {
      setStatusBusy(false)
    }
  }

  async function submitActivationReview() {
    if (!activationReview) return
    if (activationReview.decision === 'REJECT' && !reviewComments.trim()) {
      setError(new Error('Enter a reason for rejecting this request'))
      return
    }
    setReviewBusy(true)
    setError(null)
    try {
      const updated = await api.post<TestProjectOut>(`/api/test-projects/${activationReview.project.id}/activation-review`, {
        decision: activationReview.decision,
        comments: reviewComments.trim() || null,
      })
      setProjects((rows) => rows.map((project) => project.id === updated.id ? updated : project))
      setActivationReview(null)
      setReviewComments('')
    } catch (err) {
      setError(err)
    } finally {
      setReviewBusy(false)
    }
  }

  return (
    <div className="tm-page">
      <ErrorText error={error} />
      <PageHeader
        title="Projects" count={visibleProjects.length}
        subtitle="Plan testing work, organize reusable test assets, and monitor execution from one project workspace."
        actions={canManage && (
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Project</button>
        )}
      />
      <div className="toolbar tm-project-toolbar" style={{ marginBottom: 14 }}>
        <ClearableSearchInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          clearLabel="Clear project search"
          wrapperClassName="search-grow"
          placeholder="Search projects by name, key, department, or application…"
          aria-label="Search projects"
        />
        <div className="pill-tabs" aria-label="Filter projects by status">
          <button className={projectFilter === 'active' ? 'active' : ''} onClick={() => setProjectFilter('active')}>
            Active <span>{activeCount}</span>
          </button>
          <button className={projectFilter === 'inactive' ? 'active' : ''} onClick={() => setProjectFilter('inactive')}>
            Inactive <span>{inactiveCount}</span>
          </button>
          <button className={projectFilter === 'archived' ? 'active' : ''} onClick={() => setProjectFilter('archived')}>
            Archived <span>{archivedCount}</span>
          </button>
          <button className={projectFilter === 'all' ? 'active' : ''} onClick={() => setProjectFilter('all')}>
            All <span>{projects.length}</span>
          </button>
        </div>
      </div>
      <div className="tm-project-grid">
        {visibleProjects.map((project) => (
          <article className="tm-project-card" key={project.id}>
            <div className="tm-project-card-head">
              <span className="tm-project-key">{project.project_key}</span>
              <Badge status={project.is_archived ? 'Archived' : project.is_active ? 'Active' : 'Inactive'} />
            </div>
            <h3>{project.name}</h3>
            <p>{project.description || 'Test design and execution workspace for this application.'}</p>
            <div className="tm-project-stats">
              <div><strong>{summaries[project.id]?.cases ?? '—'}</strong><span>Test cases</span></div>
              <div><strong>{summaries[project.id]?.cycles ?? '—'}</strong><span>Test cycles</span></div>
              <div><strong>{project.department || '—'}</strong><span>Department</span></div>
              <div><strong>{project.owner_name || '—'}</strong><span>Owner</span></div>
              <div><strong>{project.default_reviewer_name || '—'}</strong><span>Default Reviewer</span></div>
              <div><strong>{project.default_qa_lead_name || '—'}</strong><span>Default CM-QA</span></div>
            </div>
            {project.is_archived && (
              <div className="info-banner">
                <strong>Archived</strong> by {project.archived_by_name || 'a QA Lead'}
                {project.archived_at && ` on ${new Date(project.archived_at).toLocaleDateString()}`}
                {project.archived_reason && ` — ${project.archived_reason}`}
              </div>
            )}
            {project.pending_is_active != null && (
              <div className="info-banner">
                <strong>{project.pending_is_active ? 'Reactivation' : 'Deactivation'} requested</strong> by{' '}
                {project.pending_requested_by_name || 'a QA Engineer'} — pending QA Lead approval.
              </div>
            )}
            <div className="tm-project-actions">
              <button onClick={() => navigate(`/test-repository?project=${project.id}`)}>Open repository</button>
              <button onClick={() => navigate(`/test-execution?project=${project.id}`)}>View execution</button>
              <button onClick={() => setMembersProject(project)}>Members</button>
              <button onClick={() => openActivity(project)}>Activity</button>
              {!project.is_archived && canEditProjectDetails(user, project) && (
                <button onClick={() => setEditProject(project)}>Edit</button>
              )}
              {!project.is_archived && (project.pending_is_active != null ? (
                canReview && (
                  <>
                    <button className="primary" onClick={() => setActivationReview({ project, decision: 'APPROVE' })}>Approve</button>
                    <button className="danger" onClick={() => setActivationReview({ project, decision: 'REJECT' })}>Reject</button>
                  </>
                )
              ) : canReview ? (
                <button className={project.is_active ? 'danger' : ''} onClick={() => setStatusProject(project)}>
                  {project.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
              ) : canManage && (
                <button onClick={() => setStatusProject(project)}>
                  {project.is_active ? 'Request deactivation' : 'Request reactivation'}
                </button>
              ))}
              {canReview && (
                project.is_archived
                  ? <button onClick={() => setUnarchiveProject(project)}>Unarchive</button>
                  : <button className="danger" onClick={() => setArchiveProject(project)}>Archive</button>
              )}
            </div>
          </article>
        ))}
        {visibleProjects.length === 0 && (
          <div className="tm-empty">
            <strong>{projectFilter === 'inactive' ? 'No inactive projects' : projectFilter === 'active' ? 'No active projects' : projectFilter === 'archived' ? 'No archived projects' : 'No projects yet'}</strong>
            <span>{projectFilter === 'inactive' ? 'Deactivated projects will appear here.' : projectFilter === 'archived' ? 'Archived projects will appear here.' : 'Create or reactivate a project to begin organizing test cases and execution cycles.'}</span>
          </div>
        )}
      </div>
      {showNew && (
        <NewProjectModal
          applications={applications}
          departments={departments}
          users={users}
          currentUserId={user?.id}
          onClose={() => setShowNew(false)}
          onCreated={(p) => { setProjects((prev) => [p, ...prev]); setShowNew(false) }}
        />
      )}
      {editProject && (
        <EditProjectModal
          project={editProject}
          applications={applications}
          departments={departments}
          users={users}
          onClose={() => setEditProject(null)}
          onUpdated={(p) => { setProjects((prev) => prev.map((project) => project.id === p.id ? p : project)); setEditProject(null) }}
        />
      )}
      {archiveProject && (
        <ArchiveProjectModal
          project={archiveProject}
          onClose={() => setArchiveProject(null)}
          onDone={(p) => { setProjects((prev) => prev.map((project) => project.id === p.id ? p : project)); setArchiveProject(null) }}
        />
      )}
      {unarchiveProject && (
        <UnarchiveProjectModal
          project={unarchiveProject}
          onClose={() => setUnarchiveProject(null)}
          onDone={(p) => { setProjects((prev) => prev.map((project) => project.id === p.id ? p : project)); setUnarchiveProject(null) }}
        />
      )}
      {membersProject && (
        <ProjectMembersModal
          project={membersProject}
          users={users}
          canManageMembers={hasRole(user, 'QA_LEAD') || membersProject.owner_id === user?.id}
          onClose={() => setMembersProject(null)}
        />
      )}
      {activityProject && (
        <Modal title={`${activityProject.project_key} · Activity`} onClose={() => setActivityProject(null)} wide>
          <JiraActivity entityType="TEST_PROJECT" entityId={activityProject.id} items={activity} onPosted={(item) => setActivity((prev) => [...prev, item])} />
        </Modal>
      )}
      {statusProject && (
        <Modal
          title={canReview
            ? (statusProject.is_active ? 'Deactivate project?' : 'Reactivate project?')
            : (statusProject.is_active ? 'Request deactivation?' : 'Request reactivation?')}
          onClose={() => setStatusProject(null)}
          variant="dialog"
          preventBackdropClose
        >
          <p>
            {canReview ? (
              statusProject.is_active
                ? `Deactivate ${statusProject.project_key} · ${statusProject.name}? Existing folders, test cases, cycles, executions, and activity will be retained, but no new test work can be added.`
                : `Reactivate ${statusProject.project_key} · ${statusProject.name} so it can be used for new repository and execution work again?`
            ) : (
              statusProject.is_active
                ? `Ask a QA Lead to deactivate ${statusProject.project_key} · ${statusProject.name}? This won't take effect until a QA Lead approves it.`
                : `Ask a QA Lead to reactivate ${statusProject.project_key} · ${statusProject.name}? This won't take effect until a QA Lead approves it.`
            )}
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button className={canReview && statusProject.is_active ? 'btn btn-danger' : 'btn btn-primary'} disabled={statusBusy} onClick={changeProjectStatus}>
              {statusBusy ? 'Updating…' : canReview ? (statusProject.is_active ? 'Deactivate' : 'Reactivate') : 'Send request'}
            </button>
            <button className="btn" disabled={statusBusy} onClick={() => setStatusProject(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {activationReview && (
        <Modal
          title={`${activationReview.decision === 'APPROVE' ? 'Approve' : 'Reject'} ${activationReview.project.pending_is_active ? 'reactivation' : 'deactivation'} request?`}
          onClose={() => { setActivationReview(null); setReviewComments('') }}
          variant="dialog"
          preventBackdropClose
        >
          <p>
            {activationReview.project.pending_requested_by_name || 'A QA Engineer'} requested{' '}
            {activationReview.project.pending_is_active ? 'reactivating' : 'deactivating'}{' '}
            <strong>{activationReview.project.project_key} · {activationReview.project.name}</strong>.
          </p>
          <Field label={activationReview.decision === 'REJECT' ? 'Reason (required)' : 'Comments (optional)'}>
            <textarea
              value={reviewComments}
              onChange={(e) => setReviewComments(e.target.value)}
              placeholder={activationReview.decision === 'REJECT' ? 'Why is this request being rejected?' : 'Optional note for the audit trail'}
            />
          </Field>
          <ErrorText error={error} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button
              className={activationReview.decision === 'APPROVE' ? 'btn btn-primary' : 'btn btn-danger'}
              disabled={reviewBusy}
              onClick={submitActivationReview}
            >
              {reviewBusy ? 'Submitting…' : activationReview.decision === 'APPROVE' ? 'Approve' : 'Reject'}
            </button>
            <button className="btn" disabled={reviewBusy} onClick={() => { setActivationReview(null); setReviewComments('') }}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
