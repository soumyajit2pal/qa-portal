import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import { hasRole } from '../../constants'
import { ApplicationMasterOut, TestProjectOut, TestCaseOut, TestCycleOut, ApprovalActionOut } from '../../types'
import JiraActivity from '../../components/JiraActivity'

// Project Management module -- one Test Project per Application, by
// explicit product decision (reuses the existing Application Name Master
// list rather than a second, parallel "application name" concept). This is
// the entry point for the whole Test Management feature (Project
// Management / Test Repository / Test Execution): Test Repository and Test
// Execution both start with "pick a Project" before showing anything else.
const CAN_MANAGE_ROLES = ['QA_ENGINEER', 'QA_LEAD']

function NewProjectModal({ applications, onClose, onCreated }: {
  applications: ApplicationMasterOut[]
  onClose: () => void
  onCreated: (p: TestProjectOut) => void
}) {
  const [applicationId, setApplicationId] = useState<number | ''>('')
  const [name, setName] = useState('')
  const [department, setDepartment] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  function pickApplication(idStr: string) {
    const id = idStr ? Number(idStr) : ''
    setApplicationId(id)
    const app = applications.find((a) => a.id === id)
    if (app) {
      setName(app.name)
      setDepartment(app.department || '')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError(new Error('Project name cannot be blank')); return }
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<TestProjectOut>('/api/test-projects', {
        name: name.trim(),
        application_master_id: applicationId || null,
        department: department.trim() || null,
        description: description.trim() || null,
      })
      onCreated(created)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New Test Project" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Application (optional -- links this Project to an approved application)">
          <select value={applicationId} onChange={(e) => pickApplication(e.target.value)}>
            <option value="">-- Not linked --</option>
            {applications.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Project Name *">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Department">
          <input value={department} onChange={(e) => setDepartment(e.target.value)} />
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

export default function TestProjects() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const canManage = hasRole(user, ...CAN_MANAGE_ROLES)
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [applications, setApplications] = useState<ApplicationMasterOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [showNew, setShowNew] = useState(false)
  const [summaries, setSummaries] = useState<Record<number, { cases: number; cycles: number }>>({})
  const [activityProject, setActivityProject] = useState<TestProjectOut | null>(null)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [statusProject, setStatusProject] = useState<TestProjectOut | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [projectFilter, setProjectFilter] = useState<'active' | 'inactive' | 'all'>('active')

  async function openActivity(project: TestProjectOut) {
    setActivityProject(project)
    try { setActivity(await api.get<ApprovalActionOut[]>(`/api/approvals?entity_type=TEST_PROJECT&entity_id=${project.id}`)) }
    catch (err) { setError(err); setActivity([]) }
  }

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        api.get<TestProjectOut[]>('/api/test-projects?include_inactive=true'),
        api.get<ApplicationMasterOut[]>('/api/application-names'),
      ])
      setProjects(p); setApplications(a)
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

  const activeCount = projects.filter((project) => project.is_active).length
  const inactiveCount = projects.length - activeCount
  const visibleProjects = projects.filter((project) => (
    projectFilter === 'all' || (projectFilter === 'active' ? project.is_active : !project.is_active)
  ))

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
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="pill-tabs" aria-label="Filter projects by status">
          <button className={projectFilter === 'active' ? 'active' : ''} onClick={() => setProjectFilter('active')}>
            Active <span>{activeCount}</span>
          </button>
          <button className={projectFilter === 'inactive' ? 'active' : ''} onClick={() => setProjectFilter('inactive')}>
            Inactive <span>{inactiveCount}</span>
          </button>
          <button className={projectFilter === 'all' ? 'active' : ''} onClick={() => setProjectFilter('all')}>
            All <span>{projects.length}</span>
          </button>
        </div>
      </div>
      <div className="tm-project-grid">
        {visibleProjects.map((project) => (
          <article className="tm-project-card" key={project.id}>
            <div className="tm-project-card-head"><span className="tm-project-key">{project.project_key}</span><Badge status={project.is_active ? 'Active' : 'Inactive'} /></div>
            <h3>{project.name}</h3>
            <p>{project.description || 'Test planning and execution workspace for this application.'}</p>
            <div className="tm-project-stats">
              <div><strong>{summaries[project.id]?.cases ?? '—'}</strong><span>Test cases</span></div>
              <div><strong>{summaries[project.id]?.cycles ?? '—'}</strong><span>Test cycles</span></div>
              <div><strong>{project.department || '—'}</strong><span>Department</span></div>
            </div>
            <div className="tm-project-actions">
              <button onClick={() => navigate(`/test-repository?project=${project.id}`)}>Open repository</button>
              <button onClick={() => navigate(`/test-execution?project=${project.id}`)}>View execution</button>
              <button onClick={() => openActivity(project)}>Activity</button>
              {canManage && (
                <button className={project.is_active ? 'danger' : ''} onClick={() => setStatusProject(project)}>
                  {project.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
              )}
            </div>
          </article>
        ))}
        {visibleProjects.length === 0 && (
          <div className="tm-empty">
            <strong>{projectFilter === 'inactive' ? 'No inactive projects' : projectFilter === 'active' ? 'No active projects' : 'No projects yet'}</strong>
            <span>{projectFilter === 'inactive' ? 'Deactivated projects will appear here.' : 'Create or reactivate a project to begin organizing test cases and execution cycles.'}</span>
          </div>
        )}
      </div>
      {showNew && (
        <NewProjectModal
          applications={applications}
          onClose={() => setShowNew(false)}
          onCreated={(p) => { setProjects((prev) => [p, ...prev]); setShowNew(false) }}
        />
      )}
      {activityProject && (
        <Modal title={`${activityProject.project_key} · Activity`} onClose={() => setActivityProject(null)} wide>
          <JiraActivity entityType="TEST_PROJECT" entityId={activityProject.id} items={activity} onPosted={(item) => setActivity((prev) => [...prev, item])} />
        </Modal>
      )}
      {statusProject && (
        <Modal
          title={statusProject.is_active ? 'Deactivate project?' : 'Reactivate project?'}
          onClose={() => setStatusProject(null)}
          variant="dialog"
          preventBackdropClose
        >
          <p>
            {statusProject.is_active
              ? `Deactivate ${statusProject.project_key} · ${statusProject.name}? Existing folders, test cases, cycles, executions, and activity will be retained, but no new test work can be added.`
              : `Reactivate ${statusProject.project_key} · ${statusProject.name} so it can be used for new repository and execution work again?`}
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button className={statusProject.is_active ? 'btn btn-danger' : 'btn btn-primary'} disabled={statusBusy} onClick={changeProjectStatus}>
              {statusBusy ? 'Updating…' : statusProject.is_active ? 'Deactivate' : 'Reactivate'}
            </button>
            <button className="btn" disabled={statusBusy} onClick={() => setStatusProject(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
