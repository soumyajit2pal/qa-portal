import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { Card, ErrorText, PageHeader, Table } from '../../components/Common'
import { REPORTS, hasWorkflowRole } from '../../constants'
import { useAuth } from '../../context/AuthContext'
import { PageOut, TestCycleOut, TestProjectOut } from '../../types'

const GROUPS = ['Operational', 'Security', 'Management', 'Documents']
const IST_OFFSET = '+05:30'

const SOURCE_DOCUMENTS = [
  { key: 'qa-request', label: 'QA Request PDF', source: 'QA Requests', format: 'PDF', route: '/qa-requests', description: 'The parent request and its intake approval details.' },
  { key: 'functional', label: 'Functional Request PDF', source: 'Functional Requests', format: 'PDF', route: '/functional-requests', description: 'Functional scope, workflow, and checklist evidence for a selected request.' },
  { key: 'sast', label: 'SAST Request PDF', source: 'SAST Requests', format: 'PDF', route: '/sast', description: 'Security testing request and its governed details.' },
  { key: 'dast', label: 'DAST Request PDF', source: 'DAST Requests', format: 'PDF', route: '/dast', description: 'Dynamic security testing request and its governed details.' },
  { key: 'performance', label: 'Performance Request PDF', source: 'Performance Testing', format: 'PDF', route: '/performance', description: 'Performance testing request and completed report context.' },
  { key: 'suppression', label: 'Suppression Decision PDF', source: 'Suppression', format: 'PDF', route: '/suppression', description: 'A selected finding suppression decision and approval trail.' },
  { key: 'certificate', label: 'QA Clearance Certificate', source: 'QA Clearance', format: 'PDF', route: '/signoff', description: 'The issued certificate with frozen test and defect evidence and e-signatures.' },
  { key: 'repository', label: 'Test Repository Workbook', source: 'Test Repository', format: 'XLSX', route: '/test-repository', description: 'A selected project’s testcase register and version data.' },
  { key: 'cycle', label: 'Test Cycle Lifecycle Workbook', source: 'Test Execution', format: 'XLSX', route: '/test-execution', description: 'A selected cycle’s executions, attempts, links, and audit history.' },
  { key: 'rtm', label: 'Requirements Traceability Matrix', source: 'Test Reports', format: 'XLSX', route: '/test-reports', description: 'Project-scoped requirement, testcase, execution, and defect coverage.' },
  { key: 'test-reports', label: 'Test Report Catalogue Workbooks', source: 'Test Reports', format: 'XLSX', route: '/test-reports', description: 'Repository health, cycle progress, defect quality, incomplete traceability, version impact, and portfolio.' },
  { key: 'portal', label: 'Document Portal Files', source: 'Document Portal', format: 'Original / ZIP', route: '/document-portal', description: 'Uploaded workspace files and selected folders, within your workspace access.' },
  { key: 'user-access', label: 'User Access Audit Workbook', source: 'Audit Log', format: 'XLSX', route: '/audit-log', description: 'Current user roles and workspace grants; System Administrator only.' },
]

const PROJECT_REPORTS = [
  { key: 'traceability', label: 'Requirements Traceability Matrix', scope: 'project', description: 'EPIC, CR, Feature and User Story coverage through testcases, cycles, attempts and defects.' },
  { key: 'health', label: 'Repository Health', scope: 'project', description: 'Testcase status, ownership, age and never-executed coverage.' },
  { key: 'cycle-progress', label: 'Cycle Progress', scope: 'cycle', description: 'Execution completion and assignment coverage for a selected cycle.' },
  { key: 'defects', label: 'Defect Quality', scope: 'project', description: 'Resolution, reopen and retest quality in a selected project.' },
  { key: 'incomplete-defects', label: 'Incomplete Defect Traceability', scope: 'none', description: 'Visible defects without a complete execution trail.' },
  { key: 'version-impact', label: 'Version Impact', scope: 'project', description: 'Cycles with pinned testcase versions that need review.' },
  { key: 'portfolio', label: 'Project Portfolio', scope: 'none', description: 'Cross-project status, ownership and delivery trends.' },
]

function asIstDateTime(date: string, time: string): string {
  return date ? `${date}T${time}${IST_OFFSET}` : ''
}

export default function Reports() {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [projects, setProjects] = useState<TestProjectOut[]>([])
  const [cycles, setCycles] = useState<TestCycleOut[]>([])
  const [projectId, setProjectId] = useState('')
  const [cycleId, setCycleId] = useState('')

  useEffect(() => {
    let active = true
    async function loadProjects() {
      try {
        const found: TestProjectOut[] = []
        let pageNumber = 1
        let hasNext = true
        while (hasNext) {
          const page = await api.get<PageOut<TestProjectOut>>(`/api/test-projects?include_inactive=true&page_size=100&page=${pageNumber}`)
          found.push(...page.items)
          hasNext = page.has_next
          pageNumber += 1
        }
        if (active) setProjects(found)
      } catch (err) { if (active) setError(err) }
    }
    void loadProjects()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!projectId) { setCycles([]); setCycleId(''); return }
    let active = true
    async function loadCycles() {
      try {
        const found: TestCycleOut[] = []
        let pageNumber = 1
        let hasNext = true
        while (hasNext) {
          const page = await api.get<PageOut<TestCycleOut>>(`/api/test-execution/projects/${projectId}/cycles?page_size=100&page=${pageNumber}`)
          found.push(...page.items)
          hasNext = page.has_next
          pageNumber += 1
        }
        if (active) setCycles(found)
      } catch (err) { if (active) setError(err) }
    }
    setCycleId(''); setCycles([])
    void loadCycles()
    return () => { active = false }
  }, [projectId])

  async function download(key: string, format: string) {
    setBusyKey(`${key}-${format}`)
    setError(null)
    try {
      const label = dateFrom || dateTo ? `Reporting period (IST): ${dateFrom || 'Beginning'} to ${dateTo || 'Today'}` : ''
      if (key === 'document-portal-inventory') {
        const params = new URLSearchParams({ format })
        if (dateFrom) params.set('date_from', asIstDateTime(dateFrom, '00:00:00'))
        if (dateTo) params.set('date_to', asIstDateTime(dateTo, '23:59:59.999'))
        await api.downloadFile(`/api/document-portal/inventory/export?${params}`, `document-portal-inventory.${format}`)
      } else {
        await api.downloadReport(key, format, label, asIstDateTime(dateFrom, '00:00:00'), asIstDateTime(dateTo, '23:59:59.999'))
      }
    } catch (err) { setError(err) } finally { setBusyKey(null) }
  }

  async function downloadUserAccess() {
    setBusyKey('user-access')
    setError(null)
    try { await api.downloadFile('/api/audit/user-access-report', 'qualityops-user-access-report.xlsx') }
    catch (err) { setError(err) }
    finally { setBusyKey(null) }
  }

  async function downloadProjectReport(key: string, scope: string) {
    if (scope === 'project' && !projectId) { setError(new Error('Select a Test Project before exporting this report.')); return }
    if (scope === 'cycle' && !cycleId) { setError(new Error('Select a Test Cycle before exporting this report.')); return }
    setBusyKey(`project-${key}`)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (scope !== 'none') params.set('project_id', projectId)
      if (scope === 'cycle') params.set('cycle_id', cycleId)
      await api.downloadFile(`/api/test-reports/export/${key}${params.size ? `?${params}` : ''}`, `test-report-${key}.xlsx`)
    } catch (err) { setError(err) }
    finally { setBusyKey(null) }
  }

  const sourceDocuments = SOURCE_DOCUMENTS.filter(item =>
    item.key === 'portal' ? hasWorkflowRole(user, 'DOCUMENT_PORTAL_VIEWER', 'DOCUMENT_PORTAL_CONTRIBUTOR', 'DOCUMENT_PORTAL_MANAGER')
      : item.key === 'user-access' ? hasWorkflowRole(user, 'ADMIN') : true)
  const visibleReports = REPORTS.filter(report => report.key !== 'document-portal-inventory'
    || hasWorkflowRole(user, 'DOCUMENT_PORTAL_VIEWER', 'DOCUMENT_PORTAL_CONTRIBUTOR', 'DOCUMENT_PORTAL_MANAGER'))

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="Reports & Export Centre"
        subtitle="Download workspace reports, project workbooks, and governed documents from one catalogue. Access follows your role and workspace grants."
      />
      <Card className="report-period-card">
        <div className="report-period-heading">
          <div className="report-period-title">
            <span className="report-period-icon" aria-hidden="true">◷</span>
            <div>
              <span>Reporting period</span>
            <p>Limit the operational, security, management, and document inventory exports by their relevant date.</p>
            </div>
          </div>
          <span className="report-period-timezone">IST · India Standard Time</span>
        </div>
        <div className="report-period-controls">
          <label className="report-period-field">
            <span>From date</span>
            <input aria-label="Report date range from" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <span className="report-period-arrow" aria-hidden="true">→</span>
          <label className="report-period-field">
            <span>To date</span>
            <input aria-label="Report date range to" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} />
          </label>
          {(dateFrom || dateTo) && <button className="btn btn-sm report-period-clear" onClick={() => { setDateFrom(''); setDateTo('') }}>Reset period</button>}
        </div>
        <p className="report-period-note">Leave both dates empty for all available records in the catalogue reports. Project workbooks and source documents use their own scope.</p>
      </Card>
      <Card className="all-data-report-card">
        <div className="all-data-report-heading">
          <div>
            <span className="all-data-report-eyebrow">WORKSPACE-WIDE REPORT</span>
            <h2>All Data Report</h2>
            <p>See each workspace first, then open the records behind its totals.</p>
          </div>
          <div className="all-data-report-actions">
            {['xlsx', 'pdf', 'csv'].map((fmt) => (
              <button key={fmt} className="btn btn-sm" disabled={busyKey === `all-data-report-${fmt}`}
                      onClick={() => download('all-data-report', fmt)}>
                {busyKey === `all-data-report-${fmt}` ? 'Preparing...' : `Download ${fmt.toUpperCase()}`}
              </button>
            ))}
          </div>
        </div>
        <div className="all-data-report-map">
          <div><strong>1 · Workspace Overview</strong><span>Main and child requests, projects, testcases, cycles, execution results, defects, and clearances per workspace.</span></div>
          <div><strong>2 · Status Breakdown</strong><span>Counts by workspace, record type, and current status. Defect severity is a breakdown of defects.</span></div>
          <div><strong>3 · Record Details</strong><span>Separate sections for requests, projects, testcases, cycles, executions, attempts, defects, and governance.</span></div>
        </div>
        <p className="all-data-report-note">The Excel file has a Guide tab and separate tabs for each section. Main QA requests are counted once; linked child requests appear separately. The selected period filters record dates, while project and cycle linked figures reflect their current linked records.</p>
      </Card>
      {GROUPS.filter(group => visibleReports.some(report => report.group === group)).map((group) => (
        <Card key={group} title={`${group} Reports`}>
          <Table
            tableId={`reports-${group.toLowerCase()}`}
            rowKey="key"
            rows={visibleReports.filter((r) => r.group === group)}
            columns={[
              { key: 'label', header: 'Report' },
              { key: 'description', header: 'Purpose' },
              {
                key: 'export', header: 'Export', filterable: false,
                render: (r) => (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['xlsx', 'pdf', 'csv'].map((fmt) => (
                      <button key={fmt} className="btn btn-sm" disabled={busyKey === `${r.key}-${fmt}`}
                              onClick={() => download(r.key, fmt)}>
                        {busyKey === `${r.key}-${fmt}` ? '...' : fmt.toUpperCase()}
                      </button>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      ))}
      <Card title="Test Management Project Reports">
        <p className="muted small">These are the Excel workbooks from Test Reports. Select a project, and a cycle where required. They describe the current project or cycle population and do not use the reporting-period dates above.</p>
        <div className="report-project-scope">
          <label><span>Test Project</span><select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.project_key} · {project.name}</option>)}</select></label>
          <label><span>Test Cycle</span><select value={cycleId} onChange={event => setCycleId(event.target.value)} disabled={!projectId}><option value="">Select a cycle</option>{cycles.map(cycle => <option key={cycle.id} value={cycle.id}>{cycle.cycle_key} · {cycle.name}</option>)}</select></label>
          <Link to="/test-reports" className="btn btn-sm">Open Test Reports</Link>
        </div>
        <Table tableId="reports-test-management-project" rowKey="key" rows={PROJECT_REPORTS} columns={[
          { key: 'label', header: 'Report' },
          { key: 'description', header: 'Purpose' },
          { key: 'scope', header: 'Required scope', render: item => item.scope === 'none' ? 'All visible projects' : item.scope === 'cycle' ? 'Test Cycle' : 'Test Project' },
          { key: 'export', header: 'Export', filterable: false, render: item => <button className="btn btn-sm" disabled={busyKey !== null || (item.scope === 'project' && !projectId) || (item.scope === 'cycle' && !cycleId)} onClick={() => downloadProjectReport(item.key, item.scope)}>{busyKey === `project-${item.key}` ? 'Preparing…' : 'Download XLSX'}</button> },
        ]} />
      </Card>
      <Card title="Generated Documents & Source Exports" className="report-source-documents">
        <p className="muted small">Choose a record or Test Project in its source module before downloading a governed PDF or workbook. This catalogue lists the document exports already available in the application; uploaded files stay under their record or workspace access.</p>
        <Table tableId="reports-source-documents" rowKey="key" rows={sourceDocuments} columns={[
          { key: 'label', header: 'Document' },
          { key: 'source', header: 'Source' },
          { key: 'format', header: 'Format' },
          { key: 'description', header: 'What it contains' },
          { key: 'action', header: 'Access', filterable: false, render: (item) => item.key === 'user-access'
            ? <button className="btn btn-sm" disabled={busyKey === 'user-access'} onClick={downloadUserAccess}>{busyKey === 'user-access' ? 'Preparing…' : 'Download XLSX'}</button>
            : <Link className="btn btn-sm" to={item.route}>Open {item.source}</Link> },
        ]} />
      </Card>
    </div>
  )
}
