import React, { ReactNode, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from './components/Common'
import {
  IconApprove,
  IconArrowRight,
  IconCertificate,
  IconChart,
  IconCheckCircle,
  IconFolder,
  IconHelp,
  IconPlay,
  IconSearch,
  IconShield,
  IconUsers,
  IconWarning,
  IconWorkflow,
} from './components/Icons'

interface ManualTopic {
  id: string
  number: string
  title: string
  summary: string
  keywords: string
}

const MANUAL_TOPICS: ManualTopic[] = [
  {
    id: 'getting-started', number: '01', title: 'Getting started',
    summary: 'Login, profile, navigation, dashboard, table controls, and your first request.',
    keywords: 'login ldap standard profile department navigation dashboard portfolio analytics columns table drawer pending approval request quick start pagination toast confirmation success message',
  },
  {
    id: 'roles', number: '02', title: 'Roles and access model',
    summary: 'What each role can do, department scope, assignment, and separation of duties.',
    keywords: 'role access permission requester business analyst application owner sm department head qa engineer tester qa lead security analyst Executive  administrator',
  },
  {
    id: 'multi-role', number: '03', title: 'Multiple roles on one account',
    summary: 'How combined roles work, including the SM and Application Owner example.',
    keywords: 'multiple multi role combined additive sm application owner switch account approval self approval segregation',
  },
  {
    id: 'role-sop', number: '04', title: 'Role-management SOP',
    summary: 'Create, review, change, deactivate, reactivate, and periodically certify access; administer the Application Master list.',
    keywords: 'sop provision create user ldap role review department coordinator admin deactivate reactivate access certification managed by admin application master application name rename inactive department department not assigned',
  },
  {
    id: 'qa-request', number: '05', title: 'Raise and track a QA request',
    summary: 'Prepare evidence, complete the gateway form, submit, and follow linked requests.',
    keywords: 'qa request form draft submit gateway functional sast dast performance evidence readiness checklist returned edit details change description cr number what changed',
  },
  {
    id: 'workflows', number: '06', title: 'Approval and testing workflows',
    summary: 'Functional, Performance, SAST, DAST, Suppression, and QA Clearance lifecycles.',
    keywords: 'workflow sm department head qa lead tester security analyst approval readiness scanning execution signoff clearance suppression false positive coe decision design identity confirmation return reject approval workflow log search',
  },
  {
    id: 'evidence', number: '07', title: 'Readiness, evidence, and decisions',
    summary: 'When documents must be attached and how approve, return, and reject differ.',
    keywords: 'readiness checklist self declaration evidence attachment document approve return reject remarks mandatory comment reason popup modal error refresh upload',
  },
  {
    id: 'test-management', number: '08', title: 'Test case management',
    summary: 'Test Projects, sharing, repository, testcase versions, cycles, folders, assignment, execution, defects, and export.',
    keywords: 'project shared with you view access view only repository folder tag testcase test case version major minor superseded compare details bulk import select all filter skipped approve qa lead cycle child request link unlink lifecycle ready start resume complete my executions qa group runner assign reassign reason change attempt defect rejected duplicate not a defect blocked checkout checkin export actual result image test cycle folder department access restricted unfiled folder scoped stats summary cards',
  },
  {
    id: 'document-portal', number: '09', title: 'Document Portal',
    summary: 'Controlled documents, folders, downloads, uploads, and document-only access.',
    keywords: 'document portal document management viewer contributor manager upload folder rename move download zip selection storage deletion disabled access only document role',
  },
  {
    id: 'collaboration', number: '10', title: 'Comments and collaboration',
    summary: 'Jira-style comments, rich text, images, attachments, and activity history.',
    keywords: 'comment activity rich text bullet image paste attachment collaboration jira edit delete history table merged cell colspan rowspan pdf export',
  },
  {
    id: 'find-report', number: '11', title: 'Find, monitor, and report',
    summary: 'Global search, dashboard periods, tester tracking, occupancy, approval search, and exports.',
    keywords: 'search id tqa tc dashboard portfolio analytics columns date range last 7 days 30 days 3 months 6 months custom raised date historical completed requests closed history active pending qa tester overview request ledger current completed occupancy capacity points grouped parent child pending approvals report export workflow log cr number epic number exact match',
  },
  {
    id: 'audit', number: '12', title: 'Audit and control',
    summary: 'Login history, access changes, workflow actions, evidence, and audit review.',
    keywords: 'audit log login logout access change roles status approval evidence export trace who when what',
  },
  {
    id: 'troubleshooting', number: '13', title: 'Troubleshooting and FAQ',
    summary: 'Missing actions, 400/403/404 errors, import issues, storage paths, assignments, and escalation.',
    keywords: 'error 400 403 404 popup reason guidance missing button import skipped failed permission inactive unassigned upload path storage excel troubleshoot faq',
  },
]

const ROLE_ROWS = [
  ['Requester / Others', 'Raise QA requests; add request details and evidence; correct returned requests; confirm completion.', 'Own requests and returned actions.'],
  ['Business Analyst', 'Raise QA requests and provide business or requirement context.', 'Request initiation.'],
  ['Application Owner', 'Approve or reject a newly proposed application name for the same department.', 'Same-department application-name decisions.'],
  ['SM', 'Review the requester’s submission before Department Head review.', 'Same department; cannot approve their own request.'],
  ['Chief Manager / AGM – Department', 'Approve or return a request and assign a COE - Quality Assurance QA Lead.', 'Business department checkpoint; Department Coordinator access.'],
  ['QA Engineer (QA)', 'Author test cases, execute assigned work, record results, link defects, and raise QA Clearance.', 'COE - Quality Assurance working role.'],
  ['QA Lead', 'Verify readiness, assign QA/Security work, review test cases, manage testing, and approve QA Clearance.', 'Cross-department QA delivery role.'],
  ['Security Analyst (QA)', 'Configure and perform SAST/DAST scans, validate findings, rescan, and review suppression requests.', 'COE - Quality Assurance security delivery role.'],
  ['Chief Manager / AGM – COE', 'Approve QA Clearance and coordinate QA-team working roles.', 'COE - Quality Assurance governance role; Department Coordinator access.'],
  ['View Only', 'Browse organisation-wide requests, testing records, dashboards, and reports without changing workflow data.', 'Cross-department read access; Document Portal requires a separate Document Portal role.'],
  ['Document Portal Viewer', 'Browse, search, and download files or folder/selection ZIP files.', 'Document Portal only when this is the account’s only role.'],
  ['Document Portal Contributor', 'Viewer capabilities plus create folders, upload, rename, and move documents.', 'Document Portal only when this is the account’s only role; deletion is disabled.'],
  ['Document Portal Manager', 'Same controlled repository capabilities as Contributor in the current portal.', 'Document Portal only when this is the account’s only role; deletion is disabled.'],
  ['Administrator', 'Manage all accounts, departments, privileged roles, checklist configuration, and system-wide access.', 'System-wide; assign only when operationally required.'],
]

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'does', 'for', 'how', 'i', 'in', 'is',
  'my', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'why', 'will', 'work',
])

function ManualSection({ id, number, title, summary, children }: ManualTopic & { children: ReactNode }) {
  return (
    <section id={id} className="help-manual-section">
      <div className="help-section-heading">
        <span>{number}</span>
        <div>
          <h2>{title}</h2>
          <p>{summary}</p>
        </div>
      </div>
      <div className="help-section-body">{children}</div>
    </section>
  )
}

function SopSteps({ items }: { items: Array<{ title: string; text: ReactNode }> }) {
  return (
    <ol className="help-sop-steps">
      {items.map((item, index) => (
        <li key={item.title}>
          <span>{index + 1}</span>
          <div><strong>{item.title}</strong><p>{item.text}</p></div>
        </li>
      ))}
    </ol>
  )
}

function Workflow({ label, steps }: { label: string; steps: string[] }) {
  return (
    <div className="help-workflow">
      <strong>{label}</strong>
      <div className="help-workflow-steps">
        {steps.map((step, index) => (
          <React.Fragment key={`${label}-${step}`}>
            <span>{step}</span>
            {index < steps.length - 1 && <IconArrowRight aria-hidden="true" />}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'success'; title: string; children: ReactNode }) {
  return (
    <div className={`help-callout ${tone}`}>
      {tone === 'warning' ? <IconWarning aria-hidden="true" /> : <IconCheckCircle aria-hidden="true" />}
      <div><strong>{title}</strong><p>{children}</p></div>
    </div>
  )
}

export default function Help() {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleTopics = useMemo(() => {
    if (!normalizedQuery) return MANUAL_TOPICS
    const searchTokens = normalizedQuery
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token))
    if (searchTokens.length === 0) return MANUAL_TOPICS
    return MANUAL_TOPICS.filter((topic) => {
      const searchable = `${topic.title} ${topic.summary} ${topic.keywords}`.toLowerCase()
      return searchable.includes(normalizedQuery) || searchTokens.every((token) => searchable.includes(token))
    })
  }, [normalizedQuery])
  const visibleIds = new Set(visibleTopics.map((topic) => topic.id))
  const topic = (id: string) => MANUAL_TOPICS.find((item) => item.id === id)!

  return (
    <div className="help-page">
      <PageHeader
        title="Help & User Manual"
        subtitle="Standard operating procedures for requests, approvals, role management, test management, evidence, and audit controls."
        actions={<button type="button" className="btn" onClick={() => window.print()}>Print / Save PDF</button>}
      />

      <div className="help-hero">
        <div className="help-hero-icon"><IconHelp /></div>
        <div className="help-hero-copy">
          <span>QualityOps · Operating Guide</span>
          <h1>What do you need help with?</h1>
          <p>Search by task, role, workflow, error code, or module name. This guide follows the portal’s current access controls and approval stages.</p>
          <label className="help-search">
            <IconSearch aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try “multiple roles”, “SAST”, “400 error”, or “bulk execution”"
              aria-label="Search the user manual"
            />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear manual search">×</button>}
          </label>
          {normalizedQuery && (
            <div className="help-search-count">
              {visibleTopics.length} {visibleTopics.length === 1 ? 'topic' : 'topics'} found for “{query.trim()}”
            </div>
          )}
        </div>
        <div className="help-hero-meta">
          <span>Audience</span><strong>All portal users</strong>
          <span>Manual status</span><strong>Current portal workflow</strong>
          <span>Last reviewed</span><strong>31 August 2026</strong>
        </div>
      </div>

      {!normalizedQuery && (
        <div className="help-quick-links" aria-label="Common portal actions">
          <Link to="/qa-requests"><IconWorkflow /><span><strong>Raise a QA Request</strong><small>Start the intake form</small></span><IconArrowRight /></Link>
          <Link to="/pending-approvals"><IconApprove /><span><strong>My Pending Approvals</strong><small>See actions waiting for you</small></span><IconArrowRight /></Link>
          <Link to="/document-portal"><IconFolder /><span><strong>Document Portal</strong><small>Browse controlled documents</small></span><IconArrowRight /></Link>
          <Link to="/test-execution"><IconPlay /><span><strong>Test Execution</strong><small>Run assigned test cases</small></span><IconArrowRight /></Link>
        </div>
      )}

      <div className="help-layout">
        <aside className="help-toc">
          <div className="help-toc-title"><IconHelp /><span>User manual</span></div>
          <nav aria-label="User manual contents">
            {visibleTopics.map((item) => (
              <a key={item.id} href={`#${item.id}`}><span>{item.number}</span>{item.title}</a>
            ))}
          </nav>
          <div className="help-toc-note">
            <strong>Need operational support?</strong>
            <p>Copy the exact red popup message, record ID, current status, and attempted action when escalating an issue.</p>
          </div>
        </aside>

        <main className="help-manual">
          {visibleTopics.length === 0 && (
            <div className="help-no-results">
              <IconSearch />
              <strong>No manual topic matches “{query.trim()}”</strong>
              <p>Try a role name, module, workflow stage, or error code.</p>
              <button type="button" className="btn" onClick={() => setQuery('')}>Show complete manual</button>
            </div>
          )}

          {visibleIds.has('getting-started') && (
            <ManualSection {...topic('getting-started')}>
              <div className="help-card-grid three">
                <article><IconUsers /><h3>1. Confirm your profile</h3><p>Open the signed-in user menu and verify your department and all assigned roles. Workflow actions depend on both.</p></article>
                <article><IconChart /><h3>2. Review your work</h3><p>Use Dashboard and Pending Approvals to find requests, reviews, or executions waiting for your action.</p></article>
                <article><IconWorkflow /><h3>3. Start from the gateway</h3><p>Use QA Requests for Functional, SAST, DAST, or Performance intake. One submission can create multiple linked requests.</p></article>
              </div>
              <SopSteps items={[
                { title: 'Sign in', text: 'Use the login method assigned to your account: Standard credentials or LDAP / Active Directory.' },
                { title: 'Complete first-login setup', text: 'A new LDAP user selects exactly one primary department. Secondary department access can be added later only by an Administrator. No portal role is granted at this step: an Administrator or the selected department’s Coordinator must approve access and assign the correct role.' },
                { title: 'Add a notification email when prompted', text: 'After access is approved, an LDAP account without an email address must supply one before using portal screens. This ensures workflow notifications have a valid recipient.' },
                { title: 'Check pending work', text: 'Review Pending Approvals and status badges before starting a new action.' },
                { title: 'Use record IDs', text: 'Reference the full TQA ID in comments, evidence, exports, and support requests so the exact record is traceable.' },
              ]} />
              <h3 className="help-subheading">Working efficiently in lists and details</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Use the Columns control on portal data tables to add API fields or hide columns. The original designed columns remain the default and your choices are saved for that table.</li>
                <li><IconCheckCircle />Use the filter icon beside a column heading, type to search the suggested values, then select one; tables paginate automatically.</li>
                <li><IconCheckCircle />Request drawers open expanded. They remain open until Close is selected; use the expand control to switch between expanded and standard width.</li>
                <li><IconCheckCircle />QA Request lists refresh after an action in the same browser. While the tab is visible, the list also checks for another user’s change; an open request drawer refreshes the actual record status without a browser reload.</li>
                <li><IconCheckCircle />Dashboard keeps operational items on the landing view. Open Portfolio Analytics for focused SAST, DAST, Suppression, or cross-workflow 3W analysis.</li>
                <li><IconCheckCircle />After a successful create, save, assignment, upload, workflow decision, or removal, a green toast confirms that the server accepted the action.</li>
                <li><IconCheckCircle />Approval, return, rejection, reassignment, deletion, and other consequential actions use a confirmation or decision dialog before submission.</li>
              </ul>
            </ManualSection>
          )}

          {visibleIds.has('roles') && (
            <ManualSection {...topic('roles')}>
              <Callout title="Access is role-based and context-aware">
                A role makes an action eligible; the request stage, department, assignment, account status, and self-approval rules determine whether the action is available on a particular record.
              </Callout>
              <div className="help-table-wrap">
                <table className="help-role-table">
                  <thead><tr><th>Role</th><th>Primary responsibility</th><th>Control scope</th></tr></thead>
                  <tbody>{ROLE_ROWS.map((row) => <tr key={row[0]}><td><strong>{row[0]}</strong></td><td>{row[1]}</td><td>{row[2]}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="help-rule-grid">
                <article><strong>Business approvals</strong><p>SM and Department Head decisions are normally limited to the requester’s department.</p></article>
                <article><strong>QA delivery</strong><p>QA Lead, QA Engineer, and Security Analyst work across requester departments but are governed as the COE - Quality Assurance team.</p></article>
                <article><strong>Assigned work</strong><p>Some actions require both the correct role and assignment to that request, test case, or execution.</p></article>
                <article><strong>Self-approval</strong><p>Holding an approval role does not allow a user to approve a request they created where separation of duties is enforced.</p></article>
              </div>
            </ManualSection>
          )}

          {visibleIds.has('multi-role') && (
            <ManualSection {...topic('multi-role')}>
              <div className="help-multi-role-example">
                <div className="help-role-stack"><span>SM</span><b>+</b><span>Application Owner</span><b>=</b><span className="result">One account, both responsibilities</span></div>
                <p>The user does not switch roles. The portal evaluates all active roles whenever a page or action is opened.</p>
              </div>
              <SopSteps items={[
                { title: 'Application-name decision', text: 'When a request proposes a new application name, the user can act as Application Owner for the same department.' },
                { title: 'Request-stage decision', text: 'After the application name is approved and the linked request reaches SM Approval Pending, the same account can perform the SM responsibility for an eligible same-department request.' },
                { title: 'Controls still apply', text: 'The account cannot bypass the current stage, department scope, assignment requirement, or self-approval restriction merely because it has both roles.' },
                { title: 'Audit remains explicit', text: 'Every decision records the person, timestamp, action, comments, and the complete role set held by that account.' },
              ]} />
              <Callout tone="warning" title="Do not add roles only to make a button appear">
                Assign each role only when it reflects a real job responsibility. Use the minimum role combination needed and remove a role when that responsibility ends.
              </Callout>
            </ManualSection>
          )}

          {visibleIds.has('role-sop') && (
            <ManualSection {...topic('role-sop')}>
              <h3 className="help-subheading">Who manages which roles?</h3>
              <div className="help-card-grid three">
                <article><IconUsers /><h3>System Administrator</h3><p>Creates accounts; changes departments; assigns Administrator, Department Head, and Executive  roles; manages protected accounts.</p></article>
                <article><IconApprove /><h3>Business Department Coordinator</h3><p>A Department Head can assign Requester, Business Analyst, Application Owner, and SM roles to users in their own department.</p></article>
                <article><IconShield /><h3>QA Department Coordinator</h3><p>An Executive  can assign QA Engineer, QA Lead, and Security Analyst roles to users mapped to COE - Quality Assurance.</p></article>
              </div>
              <h3 className="help-subheading">SOP: create or change user access</h3>
              <SopSteps items={[
                { title: 'Validate the access request', text: 'Confirm the user’s identity, department, employment status, requested responsibilities, approver, and effective period.' },
                { title: 'Find or create the account', text: 'System Administrators use Users & Access. Department Coordinators search their department roster and manage an existing eligible user.' },
                { title: 'Set the correct department', text: 'Department mapping must be correct before roles are assigned. Business approvals use this mapping; QA delivery roles must be mapped to COE - Quality Assurance.' },
                { title: 'Assign all required roles', text: 'Select every approved role chip. Existing roles outside a Department Coordinator’s assignable scope are preserved and cannot be removed from that page.' },
                { title: 'Apply document-only access deliberately', text: 'Only a System Administrator assigns Document Portal Viewer, Contributor, or Manager. An account holding only document roles is limited to Document Portal; other navigation routes show an access message.' },
                { title: 'Confirm and verify', text: 'Review the confirmation, save, then search for the user again and verify department, roles, login type, and Active status.' },
                { title: 'Record and review', text: 'Use Audit Log to verify the change. Review multi-role and privileged access periodically and remove roles that are no longer justified.' },
              ]} />
              <h3 className="help-subheading">SOP: leaver, transfer, or temporary access expiry</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Deactivate the account when access must stop; do not delete audit history.</li>
                <li><IconCheckCircle />For a department transfer, update the department first and revalidate every retained role.</li>
                <li><IconCheckCircle />Reassign open requests, test cases, cycles, and executions before deactivation.</li>
                <li><IconCheckCircle />Reactivate only after confirming the current department and least-privilege role set.</li>
                <li><IconCheckCircle />Use “Managed by Admin Only” for accounts that Department Coordinators must not modify.</li>
              </ul>
              <h3 className="help-subheading">SOP: administer the Application Master list</h3>
              <p>Administrator-only, from Admin → Applications. This is the same registry every QA request draws its Application Name from, so a correction here is reflected everywhere that name is used.</p>
              <SopSteps items={[
                { title: 'Assign or correct the owning department', text: 'Search for the application, choose the correct system department from the dropdown (active departments only), and select Update. If the currently assigned department has since been deactivated, the row shows an “Inactive department” badge and keeps that value selectable so it stays visible until you pick a replacement.' },
                { title: 'Rename an application', text: 'Edit the application name directly in its row and select Rename. The name is normalized and checked for a collision with another application before saving.' },
                { title: 'Understand the rename impact', text: 'A rename updates every existing QA Request, Functional, SAST, DAST, Performance, Suppression, Clearance, and Defect record that already used the old name so they read the new one too—nothing is left behind under the old spelling.' },
                { title: 'Bulk-seed known-good names', text: 'Use Download Template, complete the Application Name (and optional Department) columns, then Upload & Seed to approve a batch of names in one step instead of one at a time through the request wizard.' },
              ]} />
              <Callout tone="warning" title="Rename before renaming a department, not after">
                Renaming an application only changes the application’s own name. If a department itself needs a new name or must be retired, use the Departments section’s own rename/active-inactive toggle instead.
              </Callout>
            </ManualSection>
          )}

          {visibleIds.has('qa-request') && (
            <ManualSection {...topic('qa-request')}>
              <SopSteps items={[
                { title: 'Prepare before opening the form', text: 'Collect the change reference, application, environments, release date, contacts, testing scope, repository or URL details, risk, and readiness evidence.' },
                { title: 'Select required testing', text: 'Choose Functional, Sanity, Regression, UAT Support, Performance, SAST, and/or DAST. The form displays the correct detail and self-declaration section for each selection.' },
                { title: 'Complete readiness self-declaration', text: 'Confirm each applicable criterion and attach evidence for every mandatory item during request creation. A request cannot be raised while mandatory evidence is missing.' },
                { title: 'Save Draft or Submit', text: 'Draft keeps the gateway editable. Submit validates mandatory data and raises linked request records when any required application-name approval is complete.' },
                { title: 'Delegate for input when needed', text: 'Whenever a request is with the requester for drafting or corrections, the requester can assign any active user—even from another department—to edit it and upload documents. The requester remains the owner and workflow progression stays locked until the assignee returns it or the requester recalls it.' },
                { title: 'Track linked records', text: 'Open the gateway details to see each generated TQA-FUNC, TQA-SAST, TQA-DAST, or TQA-PERF ID and its independent status.' },
                { title: 'Correct returned requests', text: 'Read the approver’s reason, edit details, attach requested evidence, comment with the correction, and resubmit.' },
              ]} />
              <Callout title="The QA Request is the intake gateway">
                After it is raised, operational approvals and testing progress live on the linked Functional, SAST, DAST, and Performance records—not on the gateway itself.
              </Callout>
              <Callout title="Bug Fix traceability">
                When Change Type is Bug Fix, you may optionally select an earlier completed request for the same application and department. This records where the original implementation was tested and completed.
              </Callout>
              <Callout title="Change Description is mandatory">
                Every gateway requires a short Change Description explaining what is changing and why. It is collected once on the QA Request and carried automatically onto every linked Functional, SAST, DAST, Performance, and Clearance record—so it also appears in each of their own list and detail views, and in the Dashboard’s My Requests & My Department table—without needing to be re-entered anywhere.
              </Callout>
              <Callout title="Delegation is temporary input access">
                Use Delegate for Input while drafting or whenever SM, Department Head, QA Lead, Security Lead, or Performance QA returns the request for correction. The assignee can edit details, attach evidence, upload documents, and then Return to Requester with mandatory comments. They cannot submit, resubmit, cancel, approve, or change the request department. Assignment, return, and recall are recorded in Activity.
              </Callout>
              <Callout title="Lifecycle paths reflect actual movement">
                Returned requests show Requester Action as the current destination. Rejected or cancelled requests that close early connect directly to Closed without marking unreached QA or Clearance stages as complete.
              </Callout>
            </ManualSection>
          )}

          {visibleIds.has('workflows') && (
            <ManualSection {...topic('workflows')}>
              <Workflow label="Functional testing" steps={['Requester', 'SM', 'Department Head', 'QA Lead readiness', 'QA Tester', 'QA Clearance', 'Requester verification', 'Closed']} />
              <Workflow label="Performance testing" steps={['Requester', 'SM', 'Department Head', 'QA Lead readiness', 'QA execution', 'Results & report', 'Clearance', 'Closed']} />
              <Workflow label="SAST / DAST" steps={['Requester', 'SM', 'Department Head', 'QA Lead readiness', 'Security Analyst', 'Finding validation', 'Remediation / rescan', 'Report ready']} />
              <Workflow label="Suppression / false positive" steps={['Requester', 'SM', 'Department Head', 'Security verification', 'Done / Rejected']} />
              <Workflow label="QA Clearance" steps={['QA Engineer raises', 'QA Lead approves', 'Executive approves', 'Issued']} />
              <div className="help-rule-grid">
                <article><strong>Functional</strong><p>The Department Head assigns a COE - Quality Assurance QA Lead. The QA Lead verifies readiness and assigns one or more QA Testers.</p></article>
                <article><strong>Performance</strong><p>The Department Head assigns COE - Quality Assurance for readiness; QA owns planning, execution, analysis, reporting, and clearance.</p></article>
                <article><strong>SAST / DAST</strong><p>The QA Lead performs Security Readiness and assigns a COE - Quality Assurance Security Analyst for scan execution and findings.</p></article>
                <article><strong>QA Clearance</strong><p>Only COE - Quality Assurance can raise the request. It follows QA Engineer → QA Lead → Executive , with no SM stage.</p></article>
              </div>
            </ManualSection>
          )}

          {visibleIds.has('evidence') && (
            <ManualSection {...topic('evidence')}>
              <div className="help-decision-grid">
                <article className="approve"><IconCheckCircle /><h3>Approve</h3><p>Confirms the stage is acceptable and advances the request. Add a clear approval comment.</p></article>
                <article className="return"><IconWorkflow /><h3>Return</h3><p>Sends the request back for correction. State exactly what must change or which evidence is missing.</p></article>
                <article className="reject"><IconWarning /><h3>Reject</h3><p>Use for a decision that should not proceed. Provide the business, control, or technical reason.</p></article>
              </div>
              <Callout title="The decision panel is consistent across workflows">
                Select Add e-signature, review the locked logged-in identity, choose Professional, Classic, or Handwritten style, accept the electronic-signature consent statement, and apply the signature. Then choose Approve, Return to Requester, or Reject in Workflow Decision. Approval records the signer, selected style, intent, signature reference, account, role, and authoritative server timestamp in the Approval Workflow Log. QA Clearance details and exported certificates show the selected signature style together with its full Signature ID and signing time.
              </Callout>
              <Callout tone="warning" title="Remarks are mandatory for Return and Reject">
                Return and Reject cannot be submitted with blank remarks. State the corrective action, missing evidence, policy reason, or technical reason clearly enough for the next user and the audit reviewer to understand the decision.
              </Callout>
              <p className="help-inline-note">This is an auditable in-application electronic signature. A certificate-based PKI signature using a USB token, DSC provider, or enterprise signing gateway requires a separately configured trust-provider integration.</p>
              <h3 className="help-subheading">Evidence rules</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Attach evidence beside the relevant readiness criterion during request preparation. A mandatory criterion needs both its requester declaration and at least one uploaded evidence file before Submit / Raise is allowed.</li>
                <li><IconCheckCircle />Evidence is editable before Department Head approval.</li>
                <li><IconCheckCircle />After Department Head approval, normal evidence upload is locked to protect the approved record.</li>
                <li><IconCheckCircle />If any later stage returns the request, Edit Details allows the requester to add the corrective evidence.</li>
                <li><IconCheckCircle />Functional, SAST, DAST, and Performance use the same evidence control, file count, delete confirmation, locked-state message, and post-upload refresh behavior.</li>
                <li><IconCheckCircle />After Save Changes, the evidence list is reloaded so newly uploaded or deleted files are shown without reopening the request.</li>
                <li><IconCheckCircle />Use comments to explain what the attachment proves; do not upload unexplained files.</li>
              </ul>
              <Callout title="Readiness validation behaves the same in every testing module">
                Readiness Passed remains an available action. If mandatory checklist data is incomplete, Functional, SAST, DAST, and Performance show the same error dialog with the missing conditions instead of silently disabling the button or using a module-specific inline error.
              </Callout>
              <Callout tone="warning" title="When an action fails">
                The portal shows a red popup containing the exact backend reason and corrective guidance. Read it fully before retrying; repeated clicks do not resolve missing data, status, assignment, or permission conditions.
              </Callout>
            </ManualSection>
          )}

          {visibleIds.has('test-management') && (
            <ManualSection {...topic('test-management')}>
              <div className="help-test-path">
                <div><span>1</span><IconFolder /><strong>Project</strong><p>Create and maintain the governed container.</p></div>
                <IconArrowRight />
                <div><span>2</span><IconCertificate /><strong>Repository</strong><p>Author, import, review, approve, and version test cases.</p></div>
                <IconArrowRight />
                <div><span>3</span><IconPlay /><strong>Execution</strong><p>Create cycles, assign runners, record attempts, and link defects.</p></div>
              </div>
              <h3 className="help-subheading">Repository SOP</h3>
              <SopSteps items={[
                { title: 'Select an active project', text: 'A project requires a Department selected from the system list. Selecting an Application automatically uses and locks its mapped Department. Create folders and subfolders for release, module, epic, or test scope.' },
                { title: 'Create or import test cases', text: 'Complete the ID-linked hierarchy and all fields including epic, CR, module, priority, pre-condition, scenario, steps, expected result, and data.' },
                { title: 'Enter repository details consistently', text: 'For SAST repository scope, enter each repository as its own structured row with Repository URL, Branch, Commit ID, Technology Stack, and Build Number. Use Add repository only when the project spans more than one repository.' },
                { title: 'Review import results', text: 'The completion dialog identifies created and skipped rows and gives a reason for each issue. The uploaded xlsx is parsed in memory; the source workbook is not retained in document storage.' },
                { title: 'Submit for QA recommendation', text: 'A new or materially updated testcase moves to Pending QA Recommendation and cannot be used in a cycle until final approval.' },
                { title: 'Two-stage group approval', text: 'Stage 1 is shared by the eligible QA Group except the author. After recommendation, Stage 2 moves to the QA Lead Group for final approval, return, or rejection. The status filter shows this current workflow; retired reviewer-assignment statuses remain visible only on historical records.' },
                { title: 'Use check-out for editing', text: 'Check Out reserves the case so others know it is being edited. Save the work, then Check In to release the editing reservation.' },
                { title: 'Maintain in bulk', text: 'Use tags to filter matching test cases. Bulk update can change Test Type, Folder, Module Name, and Priority. Confirm the selected count before bulk update or delete.' },
              ]} />
              <Callout title="Stat cards follow the selected folder">
                The Total, Approved, In Review, and Critical counts above the test case list reflect whichever folder (or Unfiled, or the whole project) is currently selected—not the whole project regardless of folder. Select a different folder to see that folder’s own counts.
              </Callout>
              <Callout title="Terminal workflow rows do not have a pending actor">
                Approved, Rejected, and Archived test cases show only their final workflow status. “Pending with” and pending duration appear only while an actual recommendation or approval action is waiting for a person or group.
              </Callout>
              <h3 className="help-subheading">Testcase versioning and comparison</h3>
              <div className="help-rule-grid">
                <article><strong>Minor version</strong><p>Normal approved revisions increment the number after the decimal: v1.8 → v1.9 → v1.10. Version numbers are numeric components, so v1.10 follows v1.9.</p></article>
                <article><strong>Major version</strong><p>A major version is created through the final QA approval flow when the revision is explicitly approved as a major change with its required justification: v1.10 → v2.0.</p></article>
                <article><strong>Current version</strong><p>Only the latest version keeps its actual current status. Every older version is displayed as Superseded, preserving the historical snapshot without presenting it as active.</p></article>
                <article><strong>Version details</strong><p>Open Version History and select a row to render that version’s complete stored details, author, timestamps, and reviewer decisions.</p></article>
              </div>
              <SopSteps items={[
                { title: 'Open version history', text: 'Select the history action from the testcase. The newest version appears first and prior versions are marked Superseded.' },
                { title: 'Inspect one version', text: 'Click the required version row. Review its stored testcase fields and approval metadata; this view does not alter the current testcase.' },
                { title: 'Choose two different versions', text: 'In Compare two versions, select the baseline on the left and the revision on the right. The same version cannot be meaningfully compared with itself.' },
                { title: 'Compare changes', text: 'Select Compare to see field-by-field old and new values with clear separation and change highlighting. Unchanged fields remain identifiable for context.' },
              ]} />
              <h3 className="help-subheading">Execution SOP</h3>
              <SopSteps items={[
                { title: 'Organize cycles into folders', text: 'Create a Test Cycle Folder to group related cycles, then create cycles under it (or leave a cycle Unfiled). A folder starts open to everyone with project access; use Manage Access to restrict it to specific departments and/or users—once at least one grant exists, only those departments/users (plus QA Lead Group, QA Engineer, the project owner, and the folder’s creator) can see that folder and its cycles. Folder deletion requires the same governance-tier role as other destructive QA Lead Group actions, and only an empty folder can be deleted.' },
                { title: 'Create or edit a test cycle', text: 'Choose an active project and provide the mandatory start and end dates. You can also define the cycle scope, place it in a folder, and optionally link it to a child Functional, SAST, DAST, or Performance request ID. Existing cycles can be edited.' },
                { title: 'Add approved test cases', text: 'Open Add Test Cases to load approved candidates on demand. Search and move through cursor-based pages, select individual rows, or use Select all matching. Already-linked and unapproved cases are excluded by the database.' },
                { title: 'Mark the cycle ready', text: 'A cycle can move from Draft to Ready once it has at least one approved testcase and valid dates. Testcases do not all need to be assigned at this stage.' },
                { title: 'Assign runners', text: 'While the cycle is Ready, assign each testcase before its execution attempt. Any COE - Quality Assurance QA Engineer or QA Lead can assign or reassign cases to an eligible active QA Engineer or QA Lead.' },
                { title: 'Follow the cycle workflow', text: 'Move through Draft → Ready → In Progress. An In Progress cycle can be blocked with a mandatory reason and resumed. Completion remains blocked until every testcase has an execution result; Completed is final.' },
                { title: 'Execute an attempt', text: 'While the cycle is In Progress, the assigned runner opens the test case, reviews all repository details, and records status, actual result, comments, and evidence.' },
                { title: 'Use rich Actual Result', text: 'Format text, add bullets, paste images, or upload supported images. Keep results specific enough for another person to reproduce.' },
                { title: 'Link defects', text: 'For Fail or Blocked outcomes, add the defect reference and explain the observed behavior. Use a new execution attempt for retest history rather than overwriting evidence. Link existing defect also accepts a governed defect that already has a primary execution elsewhere -- it is added as an additional trace on this execution too, without moving its original link.' },
                { title: 'Operate in bulk', text: 'Use bulk assignment, execution, or removal after checking the confirmation summary. Adding more than 500 testcases, Excel imports, and lifecycle/repository exports run as background jobs so the page does not wait on one long API request.' },
                { title: 'Maintain request links', text: 'Link or unlink a child request from either Functional Request details or Test Lifecycle while the cycle remains active.' },
              ]} />
              <Callout title="My Executions is a QA-only personal queue">
                My Executions is visible only to users in the COE - Quality Assurance group. It shows the signed-in user’s assigned execution items; use Open cycle for the full cycle context. Non-QA users do not see the menu and cannot open the route.
              </Callout>
              <h3 className="help-subheading">Assignment and reassignment control</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />An initial assignment requires an eligible active assignee but is not treated as a reassignment.</li>
                <li><IconCheckCircle />For reassignment, first change the selected user or assignment set. Typing only a reason does not enable the Reassign button.</li>
                <li><IconCheckCircle />A genuine change requires a non-blank reason. Re-selecting the existing assignee, or the same multi-select set in a different order, is not a change.</li>
                <li><IconCheckCircle />Successful reassignment records the old assignee, new assignee, reason, actor, and timestamp in history.</li>
              </ul>
              <h3 className="help-subheading">Defect lifecycle and terminal triage</h3>
              <Workflow label="Standard defect path" steps={['New', 'Assigned', 'In Progress', 'Resolved', 'Retest', 'Closed']} />
              <div className="help-table-wrap">
                <table className="help-role-table">
                  <thead><tr><th>Outcome</th><th>Who can mark it</th><th>Required condition</th></tr></thead>
                  <tbody>
                    <tr><td><strong>Not a Defect</strong></td><td>QA Lead or Defect Reporter</td><td>Record the discussion with the Developer/Dev Lead and confirmation against requirements.</td></tr>
                    <tr><td><strong>Duplicate</strong></td><td>QA Lead or Defect Reporter</td><td>Select and link the original defect ID.</td></tr>
                    <tr><td><strong>Rejected</strong></td><td>QA Lead or Defect Reporter</td><td>Enter a valid rejection reason and include supporting evidence, either already attached or newly pasted/uploaded.</td></tr>
                  </tbody>
                </table>
              </div>
              <Callout tone="warning" title="Terminal triage is available from New">
                Rejected, Duplicate, and Not a Defect close that triage path and remain visible in defect details and history. Use Deferred when valid work is intentionally postponed; it can later return to Assigned.
              </Callout>
              <h3 className="help-subheading">Project view sharing</h3>
              <SopSteps items={[
                { title: 'Open project access', text: 'An authorized project manager opens View Access for the project.' },
                { title: 'Select the recipient', text: 'Grant access to a department or one particular active user. Duplicate grants and the project’s own department are excluded.' },
                { title: 'Confirm the recipient view', text: 'The recipient sees the project in Quality workspace with Shared with you and View only badges.' },
                { title: 'Understand the boundary', text: 'A view grant allows visibility into the project’s Repository, Execution, Reports, and Defects. It does not grant project management or write authority.' },
                { title: 'Remove when no longer needed', text: 'Remove the grant from View Access. Project history remains intact while the recipient’s extra visibility ends.' },
              ]} />
              <Callout title="One test case can be executed many times">
                Execution attempts preserve runner, result, timestamps, evidence, and linked defects independently. This provides a complete run and retest trail.
              </Callout>
            </ManualSection>
          )}

          {visibleIds.has('document-portal') && (
            <ManualSection {...topic('document-portal')}>
              <div className="help-card-grid three">
                <article><IconFolder /><h3>Viewer</h3><p>Browse the repository, search, download a file, or download one or more selected items as a ZIP.</p></article>
                <article><IconUsers /><h3>Contributor</h3><p>Also create folders, upload files or folder trees, rename items, and move them within the repository.</p></article>
                <article><IconShield /><h3>Manager</h3><p>Has the same controlled repository actions as Contributor today. Deletion is disabled for every role.</p></article>
              </div>
              <SopSteps items={[
                { title: 'Open the controlled repository', text: 'Use Document Portal from the navigation. Search first when you know the name; otherwise use the folder tree and breadcrumb trail to navigate.' },
                { title: 'Upload deliberately', text: 'Contributors and Managers can upload files or a folder hierarchy. Select how duplicates are handled: keep both, replace the existing file, or skip and report the duplicate.' },
                { title: 'Organize without deleting', text: 'Create folders and use Rename or Move to correct organization. The repository deliberately has no delete action, preserving recoverability and audit evidence.' },
                { title: 'Download safely', text: 'Download a single file, a folder ZIP, or a selected set. Large archive preparation can take time; keep the page open until the browser receives the download.' },
              ]} />
              <Callout title="Document-only access stays inside Document Portal">
                An account with only Document Portal roles can use this repository but cannot access requests, dashboards, approvals, or other portal modules. The restriction is enforced in both navigation and the API.
              </Callout>
              <p className="help-inline-note">All Document Portal timestamps are shown in India Standard Time (IST). In production, file transfers run in the dedicated Document Portal service so uploads and ZIP work do not consume core workflow capacity.</p>
            </ManualSection>
          )}

          {visibleIds.has('collaboration') && (
            <ManualSection {...topic('collaboration')}>
              <div className="help-card-grid three">
                <article><IconEditNote /><h3>Write for the next action</h3><p>State the observation, expected action, owner, and any date or dependency. Avoid comments such as “done” without context.</p></article>
                <article><IconFolder /><h3>Add usable evidence</h3><p>Paste or upload screenshots at the cursor to place them between surrounding text. Explain what each image or attachment demonstrates.</p></article>
                <article><IconWorkflow /><h3>Preserve the timeline</h3><p>New comments appear immediately in Activity. Workflow decisions and comments remain in chronological audit history.</p></article>
              </div>
              <h3 className="help-subheading">Recommended comment format</h3>
              <div className="help-comment-example">
                <div className="help-comment-avatar">SP</div>
                <div>
                  <strong>Readiness evidence updated</strong>
                  <p><b>Change:</b> Attached the UAT deployment confirmation and approved test data.</p>
                  <ul><li>Environment: UAT</li><li>Build: 2026.08.05-rc2</li><li>Action requested: QA Lead to repeat readiness verification</li></ul>
                </div>
              </div>
              <ul className="help-check-list">
                <li><IconCheckCircle />After posting, the editor clears and the new comment is shown immediately.</li>
                <li><IconCheckCircle />Inline images preserve their position: text → image → more text. Select an image to open the authenticated full-size version.</li>
                <li><IconCheckCircle />Tables pasted from spreadsheet or Jira-style content preserve merged rows and columns in the editor, record view, and PDF export.</li>
                <li><IconCheckCircle />Images from older comments remain available in their attachment gallery even though those records do not contain inline position information.</li>
                <li><IconCheckCircle />Do not place credentials, secrets, production customer data, or unmasked personal information in comments or screenshots.</li>
                <li><IconCheckCircle />Use the workflow action dialog for an approval reason; use Activity for ongoing collaboration and supporting context.</li>
              </ul>
            </ManualSection>
          )}

          {visibleIds.has('find-report') && (
            <ManualSection {...topic('find-report')}>
              <div className="help-card-grid three">
                <article><IconSearch /><h3>Global search</h3><p>Search a full TQA ID from the top bar. Short test-case input such as TC-02 is normalized to TQA-TC-02 automatically. A CR or EPIC number (e.g. CR-1042) jumps to the QA Requests list showing every request raised under that exact CR, with its linked Functional/SAST/DAST/Performance/Clearance requests alongside each row.</p></article>
                <article><IconChart /><h3>Dashboard</h3><p>The Dashboard opens to the last 30 days and provides Last 7 days, Last 30 days, Last 3 months, Last 6 months, and a custom From/To range. Use Reports & Export Centre for unrestricted historical exports. Attention cards explain their source and open consolidated, server-paginated records for the selected metric.</p></article>
                <article><IconApprove /><h3>Approval queues</h3><p>Pending Approvals groups pending child requests under their parent request or Test Project, supports category filters, and provides server-side page-size and next/previous controls. Approval Workflow Log supports server-side search and entity filtering.</p></article>
              </div>
              <Callout title="Historical completed requests">
                Each request list has an optional <strong>Historical completed requests</strong> Raised-date range. It filters closed, cancelled, and finally rejected records in the database. Draft, active, assigned, returned, and approval-pending work always remains visible, regardless of age.
              </Callout>
              <h3 className="help-subheading">QA Tester Overview: who worked on which request</h3>
              <p><strong>Contribution & Coverage</strong> is the default management view. It reports original testcases created, governed defects raised, governed defect retests, retained execution attempts, distinct Test Projects with actual activity, current execution assignments, and the tester's last activity in the selected period. Testcase versions do not inflate authoring totals.</p>
              <SopSteps items={[
                { title: 'Choose a period', text: 'Use Last 7 days, Last 30 days, Last 3 months, Last 6 months, or Custom. For Custom, enter From and To dates; the To date includes the complete selected day. Use Reports & Export Centre for unrestricted historical exports.' },
                { title: 'Filter the management view', text: 'Search for a tester or filter by department and project. Summary cards, charts, the table, and CSV export all follow the visible filtered set.' },
                { title: 'Open contribution evidence', text: 'Select a tester or any metric count to inspect testcases, defects, retests, execution attempts, projects, or current execution assignments. Select an evidence row to open its source record.' },
                { title: 'Review capacity separately', text: 'Switch to Capacity & Occupancy for current Functional, Performance, SAST, and DAST assignment load and the completed-request ledger.' },
              ]} />
              <Callout title="What does “period” mean?">
                The selected period uses the authoritative timestamp for each contribution: testcase creation, defect reporting, defect retest, or execution time. It filters completed-request history by completion time. Current assignments remain visible even when they began before the period.
              </Callout>
              <h3 className="help-subheading">How occupancy is calculated</h3>
              <p>Occupancy is an explainable estimate of concurrent QA workload, not timesheet utilization. Each active assignment contributes lifecycle-weighted points. Eight points equal 100%, and shared Functional or Performance work is divided equally among its assigned testers.</p>
              <div className="help-table-wrap">
                <table className="help-role-table">
                  <thead><tr><th>Work state</th><th>Points</th><th>Examples</th></tr></thead>
                  <tbody>
                    <tr><td><strong>Fully active</strong></td><td>1.00</td><td>Functional test design/execution, Performance setup/script/load execution, Security scanning.</td></tr>
                    <tr><td><strong>Configuration, validation, baseline, or retest</strong></td><td>0.75</td><td>Performance baseline/retest; Security configuration, validation, or rescan; Functional retesting.</td></tr>
                    <tr><td><strong>Queued or remediation</strong></td><td>0.50</td><td>Tester assigned, defect raised, or Security remediation.</td></tr>
                    <tr><td><strong>Analysis</strong></td><td>0.25</td><td>Performance result analysis.</td></tr>
                    <tr><td><strong>Near complete</strong></td><td>0.05–0.15</td><td>QA completed/clearance/verification, report, or security-complete stages.</td></tr>
                    <tr><td><strong>Waiting</strong></td><td>0.00</td><td>Waiting for fix does not consume planned active capacity.</td></tr>
                  </tbody>
                </table>
              </div>
              <div className="help-rule-grid">
                <article><strong>Example 1: single tester</strong><p>Four active 1-point assignments = 4 points. 4 ÷ 8 × 100 = 50% occupancy.</p></article>
                <article><strong>Example 2: mixed stages</strong><p>Execution 1.00 + retest 0.75 + analysis 0.25 + remediation 0.50 = 2.50 points, or 31% after rounding.</p></article>
                <article><strong>Example 3: shared request</strong><p>A 1-point Functional request shared by two testers contributes 0.50 point to each tester.</p></article>
                <article><strong>Example 4: overload</strong><p>Nine fully active assignments = 9 points. 9 ÷ 8 × 100 = 113%, displayed as Overloaded.</p></article>
              </div>
              <p><a className="btn btn-sm" href="/docs/qa-tester-occupancy-guide.pdf" target="_blank" rel="noreferrer">Open detailed occupancy calculation guide</a></p>
              <h3 className="help-subheading">Approval Workflow Log search</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Search by request ID, workflow step, decision, actor, actor role, previous/new status, or comment text.</li>
                <li><IconCheckCircle />Combine text search with the Entity filter to narrow results to QA Request, Functional, SAST, DAST, Performance, Suppression, or Clearance.</li>
                <li><IconCheckCircle />Results are searched and paginated on the server. Clear the search to restore the complete accessible log.</li>
              </ul>
              <ul className="help-check-list">
                <li><IconCheckCircle />Use the filter icon in a table column to narrow its visible results; QA Requests does not duplicate this with a separate page-level status selector.</li>
                <li><IconCheckCircle />Use Reports & Export Centre for the QA Request Register, Functional Request Register, cycle execution summary, defect/retest register, performance and security registers, testcase approval backlog, application scorecard, QA Clearance register, and approval audit evidence.</li>
                <li><IconCheckCircle />The Reporting period panel applies an IST From/To range to every export. Leave both dates empty to include all historical data available to your access scope.</li>
                <li><IconCheckCircle />Use Repository and Test Execution exports for detailed test assets and run results.</li>
                <li><IconCheckCircle />Inactive projects remain discoverable through the project status filter but cannot accept new repository or execution changes until reactivated.</li>
                <li><IconCheckCircle />QA Certificate validation notes, defect review, and residual-risk sections support rich text, lists, and tables; exported PDFs preserve the formatted content.</li>
              </ul>
            </ManualSection>
          )}

          {visibleIds.has('audit') && (
            <ManualSection {...topic('audit')}>
              <Callout title="Audit records answer who, when, what, and where">
                Use Audit Log for authentication events, account and role changes, status changes, and other governed activity. Use each record’s Activity and Approval Workflow Log for its business decision history.
              </Callout>
              <div className="help-audit-grid">
                <article><span>01</span><strong>Authentication</strong><p>Login outcome, user, time, and available session context.</p></article>
                <article><span>02</span><strong>Access management</strong><p>User creation, department, roles, activation status, and protected-account changes.</p></article>
                <article><span>03</span><strong>Workflow</strong><p>Submission, assignment, approve, return, reject, readiness, execution, and closure actions.</p></article>
                <article><span>04</span><strong>Evidence</strong><p>Attachments, comments, execution images, exports, and linked business record IDs.</p></article>
              </div>
              <h3 className="help-subheading">Audit review SOP</h3>
              <SopSteps items={[
                { title: 'Define scope', text: 'Record the review period, user, department, action type, and relevant TQA record IDs.' },
                { title: 'Filter and inspect', text: 'Use Audit Log and workflow history to reconstruct events in time order.' },
                { title: 'Verify authorization', text: 'Confirm the actor held an eligible role, belonged to the required department, and was assigned where assignment was mandatory.' },
                { title: 'Reconcile evidence', text: 'Match decision comments, attachments, results, and defects with the related status change.' },
                { title: 'Export and retain', text: 'Export the applicable audit evidence under the organization’s retention and information-security policy.' },
              ]} />
            </ManualSection>
          )}

          {visibleIds.has('troubleshooting') && (
            <ManualSection {...topic('troubleshooting')}>
              <div className="help-error-table">
                <div className="head"><span>Symptom</span><span>Likely reason</span><span>What to do</span></div>
                <div><strong>Action button is missing</strong><span>Wrong stage, role, department, assignment, or inactive account.</span><span>Check profile roles, Pending With, record assignment, and current status.</span></div>
                <div><strong>400 popup</strong><span>Required data or workflow precondition is incomplete.</span><span>Follow the exact backend reason and corrective guidance shown in the red popup.</span></div>
                <div><strong>403 popup</strong><span>Your account is authenticated but not authorized for this action.</span><span>Verify role, department, self-approval rule, and assignment; request an access review if incorrect.</span></div>
                <div><strong>404 popup / page</strong><span>The record does not exist, was removed, or the ID/route is incorrect.</span><span>Search the full TQA ID, verify the module, and confirm the record still exists.</span></div>
                <div><strong>Import skipped or failed</strong><span>Duplicate, invalid, missing, unsupported, or unapproved data.</span><span>Open the issue summary and correct each row using its displayed reason; do not retry unchanged data.</span></div>
                <div><strong>Upload path error</strong><span>The deployment-controlled upload path is not absolute, writable, or mounted for the backend container.</span><span>Ask the platform administrator to verify UPLOAD_STORAGE_ROOT and the Docker volume/bind mount; this path is not changed from the portal UI.</span></div>
                <div><strong>Cannot execute</strong><span>Test case is unapproved, project inactive, or runner not assigned.</span><span>Approve the case, reactivate the project if authorized, and assign a COE - Quality Assurance runner.</span></div>
              </div>
              <Callout title="Excel import storage">
                Test-case import workbooks are read in memory and are not retained under the configured upload path. Documents, checklist evidence, execution images, and other retained attachments use the active Admin-configured upload root.
              </Callout>
              <h3 className="help-subheading">Escalation checklist</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Full TQA record ID and module name.</li>
                <li><IconCheckCircle />Current status and, for a non-terminal record, its Pending With value.</li>
                <li><IconCheckCircle />Your department and assigned roles—never include a password.</li>
                <li><IconCheckCircle />Exact popup reason and corrective guidance.</li>
                <li><IconCheckCircle />Timestamp, attempted action, and a masked screenshot if useful.</li>
              </ul>
            </ManualSection>
          )}
        </main>
      </div>
    </div>
  )
}

function IconEditNote(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 4h9l5 5v11H5z" /><path d="M14 4v5h5" /><path d="M8 14h8M8 17h5" />
    </svg>
  )
}
