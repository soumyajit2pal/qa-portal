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
    summary: 'Login, profile, navigation, dashboard, table controls, notifications, and first request.',
    keywords: 'login ldap standard profile department navigation dashboard insights columns table drawer pending approval notification request quick start',
  },
  {
    id: 'roles', number: '02', title: 'Roles and access model',
    summary: 'What each role can do, department scope, assignment, and separation of duties.',
    keywords: 'role access permission requester business analyst application owner sm department head qa engineer tester qa lead security analyst executive coe administrator',
  },
  {
    id: 'multi-role', number: '03', title: 'Multiple roles on one account',
    summary: 'How combined roles work, including the SM and Application Owner example.',
    keywords: 'multiple multi role combined additive sm application owner switch account approval self approval segregation',
  },
  {
    id: 'role-sop', number: '04', title: 'Role-management SOP',
    summary: 'Create, review, change, deactivate, reactivate, and periodically certify access.',
    keywords: 'sop provision create user ldap role review department coordinator admin deactivate reactivate access certification managed by admin',
  },
  {
    id: 'qa-request', number: '05', title: 'Raise and track a QA request',
    summary: 'Prepare evidence, complete the gateway form, submit, and follow linked requests.',
    keywords: 'qa request form draft submit gateway functional sast dast performance evidence readiness checklist returned edit details',
  },
  {
    id: 'workflows', number: '06', title: 'Approval and testing workflows',
    summary: 'Functional, Performance, SAST, DAST, Suppression, and QA Sign-off lifecycles.',
    keywords: 'workflow sm department head qa lead tester security analyst approval readiness scanning execution signoff suppression false positive coe',
  },
  {
    id: 'evidence', number: '07', title: 'Readiness, evidence, and decisions',
    summary: 'When documents must be attached and how approve, return, and reject differ.',
    keywords: 'readiness checklist self declaration evidence attachment document approve return reject comment reason popup error',
  },
  {
    id: 'test-management', number: '08', title: 'Test management',
    summary: 'Projects, repository, test-case review, cycles, assignment, execution, defects, and export.',
    keywords: 'project department application repository folder tag testcase test case bulk import select all filter skipped approve qa lead cycle child request link unlink lifecycle ready start resume complete execution runner assign attempt defect blocked checkout checkin export actual result image',
  },
  {
    id: 'collaboration', number: '09', title: 'Comments and collaboration',
    summary: 'Jira-style comments, rich text, images, attachments, and activity history.',
    keywords: 'comment activity rich text bullet image paste attachment collaboration jira edit delete history',
  },
  {
    id: 'find-report', number: '10', title: 'Find, monitor, and report',
    summary: 'Global ID search, dashboard filters, approvals, exports, and workload views.',
    keywords: 'search id tqa tc dashboard insights columns date range occupancy grouped parent child pending approvals report export workflow log',
  },
  {
    id: 'audit', number: '11', title: 'Audit and control',
    summary: 'Login history, access changes, workflow actions, evidence, and audit review.',
    keywords: 'audit log login logout access change roles status approval evidence export trace who when what',
  },
  {
    id: 'troubleshooting', number: '12', title: 'Troubleshooting and FAQ',
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
  ['QA Engineer (QA)', 'Author test cases, execute assigned work, record results, link defects, and raise QA Sign-off.', 'COE - Quality Assurance working role.'],
  ['QA Lead', 'Verify readiness, assign QA/Security work, review test cases, manage testing, and approve QA Sign-off.', 'Cross-department QA delivery role.'],
  ['Security Analyst (QA)', 'Configure and perform SAST/DAST scans, validate findings, rescan, and review suppression requests.', 'COE - Quality Assurance security delivery role.'],
  ['Chief Manager / AGM – COE', 'Approve QA Sign-off and coordinate QA-team working roles.', 'COE - Quality Assurance governance role; Department Coordinator access.'],
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
          <span>QualityShield · Operating Guide</span>
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
          <span>Last reviewed</span><strong>07 August 2026</strong>
        </div>
      </div>

      {!normalizedQuery && (
        <div className="help-quick-links" aria-label="Common portal actions">
          <Link to="/qa-requests"><IconWorkflow /><span><strong>Raise a QA Request</strong><small>Start the intake form</small></span><IconArrowRight /></Link>
          <Link to="/pending-approvals"><IconApprove /><span><strong>My Pending Approvals</strong><small>See actions waiting for you</small></span><IconArrowRight /></Link>
          <Link to="/test-repository"><IconFolder /><span><strong>Test Repository</strong><small>Author and review test cases</small></span><IconArrowRight /></Link>
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
                { title: 'Complete first-login setup', text: 'A new LDAP user selects a department and initially receives the lowest-privilege Requester role until access is reviewed.' },
                { title: 'Check pending work', text: 'Review the login notification, Pending Approvals, and status badges before starting a new action.' },
                { title: 'Use record IDs', text: 'Reference the full TQA ID in comments, evidence, exports, and support requests so the exact record is traceable.' },
              ]} />
              <h3 className="help-subheading">Working efficiently in lists and details</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Use the Columns control on portal data tables to add API fields or hide columns. The original designed columns remain the default and your choices are saved for that table.</li>
                <li><IconCheckCircle />Use the filter icon beside a column heading to filter that field; tables paginate automatically.</li>
                <li><IconCheckCircle />Request drawers open expanded. They remain open until Close is selected; use the expand control to switch between expanded and standard width.</li>
                <li><IconCheckCircle />Dashboard keeps operational items on the landing view. Open Insights for focused Security, Suppression, or 3W analysis.</li>
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
                <article><IconUsers /><h3>System Administrator</h3><p>Creates accounts; changes departments; assigns Administrator, Department Head, and Executive COE roles; manages protected accounts.</p></article>
                <article><IconApprove /><h3>Business Department Coordinator</h3><p>A Department Head can assign Requester, Business Analyst, Application Owner, and SM roles to users in their own department.</p></article>
                <article><IconShield /><h3>QA Department Coordinator</h3><p>An Executive COE can assign QA Engineer, QA Lead, and Security Analyst roles to users mapped to COE - Quality Assurance.</p></article>
              </div>
              <h3 className="help-subheading">SOP: create or change user access</h3>
              <SopSteps items={[
                { title: 'Validate the access request', text: 'Confirm the user’s identity, department, employment status, requested responsibilities, approver, and effective period.' },
                { title: 'Find or create the account', text: 'System Administrators use Users & Access. Department Coordinators search their department roster and manage an existing eligible user.' },
                { title: 'Set the correct department', text: 'Department mapping must be correct before roles are assigned. Business approvals use this mapping; QA delivery roles must be mapped to COE - Quality Assurance.' },
                { title: 'Assign all required roles', text: 'Select every approved role chip. Existing roles outside a Department Coordinator’s assignable scope are preserved and cannot be removed from that page.' },
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
            </ManualSection>
          )}

          {visibleIds.has('qa-request') && (
            <ManualSection {...topic('qa-request')}>
              <SopSteps items={[
                { title: 'Prepare before opening the form', text: 'Collect the change reference, application, environments, release date, contacts, testing scope, repository or URL details, risk, and readiness evidence.' },
                { title: 'Select required testing', text: 'Choose Functional, SAST, DAST, and/or Performance. The form displays the correct detail and self-declaration section for each selection.' },
                { title: 'Complete readiness self-declaration', text: 'Confirm each applicable criterion and attach its evidence during request creation. Evidence is expected before the request reaches approvers or QA readiness.' },
                { title: 'Save Draft or Submit', text: 'Draft keeps the gateway editable. Submit validates mandatory data and raises linked request records when any required application-name approval is complete.' },
                { title: 'Track linked records', text: 'Open the gateway details to see each generated TQA-FUNC, TQA-SAST, TQA-DAST, or TQA-PERF ID and its independent status.' },
                { title: 'Correct returned requests', text: 'Read the approver’s reason, edit details, attach requested evidence, comment with the correction, and resubmit.' },
              ]} />
              <Callout title="The QA Request is the intake gateway">
                After it is raised, operational approvals and testing progress live on the linked Functional, SAST, DAST, and Performance records—not on the gateway itself.
              </Callout>
              <Callout title="Lifecycle paths reflect actual movement">
                Returned requests show Requester Action as the current destination. Rejected or cancelled requests that close early connect directly to Closed without marking unreached QA or Sign-off stages as complete.
              </Callout>
            </ManualSection>
          )}

          {visibleIds.has('workflows') && (
            <ManualSection {...topic('workflows')}>
              <Workflow label="Functional testing" steps={['Requester', 'SM', 'Department Head', 'QA Lead readiness', 'QA Tester', 'QA Sign-off', 'Requester verification', 'Closed']} />
              <Workflow label="Performance testing" steps={['Requester', 'SM', 'Department Head', 'QA Lead readiness', 'QA execution', 'Results & report', 'Sign-off', 'Closed']} />
              <Workflow label="SAST / DAST" steps={['Requester', 'SM', 'Department Head', 'QA Lead readiness', 'Security Analyst', 'Finding validation', 'Remediation / rescan', 'Report ready']} />
              <Workflow label="Suppression / false positive" steps={['Requester', 'SM', 'Department Head', 'Security verification', 'Done / Rejected']} />
              <Workflow label="QA Sign-off" steps={['QA Engineer raises', 'QA Lead approves', 'Executive COE approves', 'Issued']} />
              <div className="help-rule-grid">
                <article><strong>Functional</strong><p>The Department Head assigns a COE - Quality Assurance QA Lead. The QA Lead verifies readiness and assigns one or more QA Testers.</p></article>
                <article><strong>Performance</strong><p>The Department Head assigns COE - Quality Assurance for readiness; QA owns planning, execution, analysis, reporting, and sign-off.</p></article>
                <article><strong>SAST / DAST</strong><p>The QA Lead performs Security Readiness and assigns a COE - Quality Assurance Security Analyst for scan execution and findings.</p></article>
                <article><strong>QA Sign-off</strong><p>Only COE - Quality Assurance can raise the request. It follows QA Engineer → QA Lead → Executive COE, with no SM stage.</p></article>
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
              <h3 className="help-subheading">Evidence rules</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Attach evidence beside the relevant readiness criterion during request preparation.</li>
                <li><IconCheckCircle />Evidence is editable before Department Head approval.</li>
                <li><IconCheckCircle />After Department Head approval, normal evidence upload is locked to protect the approved record.</li>
                <li><IconCheckCircle />If any later stage returns the request, Edit Details allows the requester to add the corrective evidence.</li>
                <li><IconCheckCircle />Use comments to explain what the attachment proves; do not upload unexplained files.</li>
              </ul>
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
                { title: 'Review import results', text: 'The completion dialog identifies created and skipped rows and gives a reason for each issue. The uploaded xlsx is parsed in memory; the source workbook is not retained in document storage.' },
                { title: 'Submit for Reviewer recommendation', text: 'A new or materially updated testcase first moves to Pending Reviewer Recommendation and cannot be used in a cycle.' },
                { title: 'Two-stage group approval', text: 'Submission automatically enters the shared Stage 1 queue for every eligible QA reviewer except the author. The first valid action wins. After Stage 1 approval, CM QA and AGM QA receive Stage 2 simultaneously; either may approve, return, or reject. Approved cases become Active.' },
                { title: 'Use check-out for editing', text: 'Check Out reserves the case so others know it is being edited. Save the work, then Check In to release the editing reservation.' },
                { title: 'Maintain in bulk', text: 'Use tags to filter matching test cases. Bulk update can change Test Type, Folder, Module Name, and Priority. Confirm the selected count before bulk update or delete.' },
              ]} />
              <h3 className="help-subheading">Execution SOP</h3>
              <SopSteps items={[
                { title: 'Create or edit a test cycle', text: 'Choose an active project, define cycle scope and dates, and optionally link the cycle to a child Functional, SAST, DAST, or Performance request ID. Existing cycles can be edited.' },
                { title: 'Add approved test cases', text: 'Use Select all, column filters, pagination, and configurable columns in Add Test Cases to Cycle. Already-linked and unapproved cases are excluded.' },
                { title: 'Assign runners', text: 'Any COE - Quality Assurance QA Engineer or QA Lead can assign or reassign cases to an active COE - Quality Assurance QA Engineer or QA Lead.' },
                { title: 'Follow the cycle workflow', text: 'Move through Draft → Ready → In Progress. An In Progress cycle can be blocked with a mandatory reason, resumed, or completed. Completed is final.' },
                { title: 'Execute an attempt', text: 'While the cycle is In Progress, the assigned runner opens the test case, reviews all repository details, and records status, actual result, comments, and evidence.' },
                { title: 'Use rich Actual Result', text: 'Format text, add bullets, paste images, or upload supported images. Keep results specific enough for another person to reproduce.' },
                { title: 'Link defects', text: 'For Fail or Blocked outcomes, add the defect reference and explain the observed behavior. Use a new execution attempt for retest history rather than overwriting evidence.' },
                { title: 'Operate in bulk', text: 'Use bulk assignment, bulk execution, bulk removal from the cycle, or export after validating the selected cases and confirmation summary.' },
                { title: 'Maintain request links', text: 'Link or unlink a child request from either Functional Request details or Test Lifecycle while the cycle remains active.' },
              ]} />
              <Callout title="One test case can be executed many times">
                Execution attempts preserve runner, result, timestamps, evidence, and linked defects independently. This provides a complete run and retest trail.
              </Callout>
            </ManualSection>
          )}

          {visibleIds.has('collaboration') && (
            <ManualSection {...topic('collaboration')}>
              <div className="help-card-grid three">
                <article><IconEditNote /><h3>Write for the next action</h3><p>State the observation, expected action, owner, and any date or dependency. Avoid comments such as “done” without context.</p></article>
                <article><IconFolder /><h3>Add usable evidence</h3><p>Paste screenshots, upload files, and use bullets or numbered lists. Explain what each image or attachment demonstrates.</p></article>
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
                <li><IconCheckCircle />Do not place credentials, secrets, production customer data, or unmasked personal information in comments or screenshots.</li>
                <li><IconCheckCircle />Use the workflow action dialog for an approval reason; use Activity for ongoing collaboration and supporting context.</li>
              </ul>
            </ManualSection>
          )}

          {visibleIds.has('find-report') && (
            <ManualSection {...topic('find-report')}>
              <div className="help-card-grid three">
                <article><IconSearch /><h3>Global search</h3><p>Search a full TQA ID from the top bar. Short test-case input such as TC-02 is normalized to TQA-TC-02 automatically.</p></article>
                <article><IconChart /><h3>Dashboard</h3><p>Dashboard filters apply to the whole dashboard. QA-only occupancy shows active workload across Functional, Performance, SAST, and DAST.</p></article>
                <article><IconApprove /><h3>Approval queues</h3><p>Pending Approvals groups pending child requests under their parent request ID and opens the selected item directly. Approval Workflow Log provides the decision trail.</p></article>
              </div>
              <ul className="help-check-list">
                <li><IconCheckCircle />Use module filters and status badges to narrow operational lists.</li>
                <li><IconCheckCircle />Use Reports & Export Centre for governed summaries and audit evidence exports.</li>
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
                <div><strong>Upload path error</strong><span>The Admin-configured server path is not absolute, writable, mounted, or available to every API container.</span><span>Use System Settings to enter an absolute production path and verify the same persistent volume is mounted at that path for all API replicas.</span></div>
                <div><strong>Cannot execute</strong><span>Test case is unapproved, project inactive, or runner not assigned.</span><span>Approve the case, reactivate the project if authorized, and assign a COE - Quality Assurance runner.</span></div>
              </div>
              <Callout title="Excel import storage">
                Test-case import workbooks are read in memory and are not retained under the configured upload path. Documents, checklist evidence, execution images, and other retained attachments use the active Admin-configured upload root.
              </Callout>
              <h3 className="help-subheading">Escalation checklist</h3>
              <ul className="help-check-list">
                <li><IconCheckCircle />Full TQA record ID and module name.</li>
                <li><IconCheckCircle />Current status and Pending With value.</li>
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
