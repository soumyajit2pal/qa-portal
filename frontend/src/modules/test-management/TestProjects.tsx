import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import SearchableSelect from '../../components/SearchableSelect'
import { hasRole } from '../../constants'
import { ApplicationMasterOut, TestProjectOut, TestCaseOut, TestCycleOut, ApprovalActionOut } from '../../types'
import JiraActivity from '../../components/JiraActivity'
import ClearableSearchInput from '../../components/ClearableSearchInput'

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

// Reported directly: "Once Project is created, give option to edit
// details." Before this, the only post-creation action on a Project was
// Activate/Deactivate -- name, linked Application, department, and
// description could never be changed again. Mirrors NewProjectModal's own
// fields/behavior (including auto-filling name/department when an
// Application is picked), just pre-filled from the existing project and
// PATCHing instead of POSTing.
function EditProjectModal({ project, applications, onClose, onUpdated }: {
  project: TestProjectOut
  applications: ApplicationMasterOut[]
  onClose: () => void
  onUpdated: (p: TestProjectOut) => void
}) {
  const [applicationId, setApplicationId] = useState<number | ''>(project.application_master_id ?? '')
  const [name, setName] = useState(project.name)
  const [department, setDepartment] = useState(project.department || '')
  const [description, setDescription] = useState(project.description || '')
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
      const updated = await api.patch<TestProjectOut>(`/api/test-projects/${project.id}`, {
        name: name.trim(),
        application_master_id: applicationId || null,
        department: department.trim() || null,
        description: description.trim() || null,
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
        <Field label="Department">
          <input value={department} onChange={(e) => setDepartment(e.target.value)} />
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
  const [error, setError] = useState<unknown>(null)
  const [showNew, setShowNew] = useState(false)
  const [summaries, setSummaries] = useState<Record<number, { cases: number; cycles: number }>>({})
  const [activityProject, setActivityProject] = useState<TestProjectOut | null>(null)
  const [activity, setActivity] = useState<ApprovalActionOut[]>([])
  const [statusProject, setStatusProject] = useState<TestProjectOut | null>(null)
  const [editProject, setEditProject] = useState<TestProjectOut | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [projectFilter, setProjectFilter] = useState<'active' | 'inactive' | 'all'>('active')
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
  const activeCount = projects.filter((project) => project.is_active).length
  const inactiveCount = projects.length - activeCount
  const visibleProjects = useMemo(() => {
    let rows = projects.filter((project) => (
      projectFilter === 'all' || (projectFilter === 'active' ? project.is_active : !project.is_active)
    ))
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
      <div className="toolbar" style={{ marginBottom: 14 }}>
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
            {project.pending_is_active != null && (
              <div className="info-banner">
                <strong>{project.pending_is_active ? 'Reactivation' : 'Deactivation'} requested</strong> by{' '}
                {project.pending_requested_by_name || 'a QA Engineer'} — pending QA Lead approval.
              </div>
            )}
            <div className="tm-project-actions">
              <button onClick={() => navigate(`/test-repository?project=${project.id}`)}>Open repository</button>
              <button onClick={() => navigate(`/test-execution?project=${project.id}`)}>View execution</button>
              <button onClick={() => openActivity(project)}>Activity</button>
              {canManage && (
                <button onClick={() => setEditProject(project)}>Edit</button>
              )}
              {project.pending_is_active != null ? (
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
      {editProject && (
        <EditProjectModal
          project={editProject}
          applications={applications}
          onClose={() => setEditProject(null)}
          onUpdated={(p) => { setProjects((prev) => prev.map((project) => project.id === p.id ? p : project)); setEditProject(null) }}
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
          hideCloseButton
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
          hideCloseButton
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
