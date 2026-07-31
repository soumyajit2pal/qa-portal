import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { useAuth } from '../../context/AuthContext'
import { Card, Table, Modal, Field, ErrorText, PageHeader, Badge } from '../../components/Common'
import { hasRole } from '../../constants'
import { ApplicationMasterOut, TestProjectOut } from '../../types'

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
  const { user } = useAuth()
  const canManage = hasRole(user, ...CAN_MANAGE_ROLES)
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [applications, setApplications] = useState<ApplicationMasterOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        api.get<TestProjectOut[]>('/api/test-projects'),
        api.get<ApplicationMasterOut[]>('/api/application-names'),
      ])
      setProjects(p); setApplications(a)
    } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Test Projects" count={projects.length}
        subtitle="Project Management -- one Project per Application. Test Repository and Test Execution both start here."
        actions={canManage && (
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Project</button>
        )}
      />
      <Card>
        <Table
          rowKey="id"
          columns={[
            { key: 'project_key', header: 'Project Key' },
            { key: 'name', header: 'Name' },
            { key: 'department', header: 'Department', render: (p) => p.department || '—' },
            { key: 'is_active', header: 'Status', render: (p) => <Badge status={p.is_active ? 'Active' : 'Deprecated'} /> },
            { key: 'created_at', header: 'Created', render: (p) => new Date(p.created_at).toLocaleString() },
          ]}
          rows={projects}
        />
      </Card>
      {showNew && (
        <NewProjectModal
          applications={applications}
          onClose={() => setShowNew(false)}
          onCreated={(p) => { setProjects((prev) => [p, ...prev]); setShowNew(false) }}
        />
      )}
    </div>
  )
}
