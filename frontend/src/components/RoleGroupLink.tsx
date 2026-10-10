import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ErrorText, Modal } from './Common'
import { userDepartments } from '../constants'
import type { UserOption } from '../types'
import { api } from '../api'

export default function RoleGroupLink({ role, label, department, repositoryGroup = false, testCaseId, renderTrigger }: {
  // A single role (the common case) or several -- e.g. Department Head
  // Approval is held jointly by DEPARTMENT_HEAD_CM and DEPARTMENT_HEAD_AGM
  // (identical authority, split only so approval logs show the exact
  // position), so that stage's group is "anyone holding either role,"
  // not two separate groups.
  role: string | string[]
  label: string
  // SM and Department Head groups require a matching department. Application
  // Owners decide new names across departments in the workspace. Optional so
  // existing non-department-scoped callers (QA Lead, Security Analyst,
  // Executive -- none of those are department-restricted) are unaffected;
  // when provided, members are further filtered to a matching department.
  department?: string | null
  // Repository groups use their workspace QA directory, rather than the
  // department-scoped assignment picker used by other approval workflows.
  repositoryGroup?: boolean
  // Repository approval groups must be resolved against the testcase's
  // creating workspace and maker-checker history, not the viewer's active
  // workspace. Non-repository callers leave this unset.
  testCaseId?: number
  // Reported directly ("I AM ASKING HERE" -- the QA Request gateway's own
  // Application Name field, whose existing yellow "Application Owner
  // Approval Pending" status pill needed to open this same modal without
  // losing its pill styling/wording, unlike every other consumer of this
  // component, which is fine with the default "{label} {count}" button).
  // When provided, this renders instead of the default trigger button --
  // same member list/modal, caller controls the clickable element itself.
  renderTrigger?: (count: number | null, onClick: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const roles = useMemo(() => (Array.isArray(role) ? role : [role]), [role])
  const scopedDepartment = roles.length === 1 && roles[0] === 'APPLICATION_OWNER' ? null : department
  const query = new URLSearchParams(repositoryGroup ? {} : { purpose: 'approver' })
  query.set('roles', roles.join(','))
  if (scopedDepartment) { query.set('department', scopedDepartment); query.set('department_scoped', 'true') }
  if (testCaseId) query.set('test_case_id', String(testCaseId))
  const url = `${repositoryGroup ? '/api/test-projects/eligible-users' : '/api/auth/user-options'}?${query}`
  const [members, setMembers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const requestGeneration = useRef(0)

  useEffect(() => {
    requestGeneration.current += 1
    setOpen(false)
    setMembers([])
    setLoading(false)
    setLoaded(false)
    setError(null)
  }, [url])

  async function showMembers(force = false) {
    setOpen(true)
    if ((loaded || loading) && !force) return
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    try {
      const rows = await api.get<UserOption[]>(url)
      if (generation !== requestGeneration.current) return
      setMembers(rows)
      setLoaded(true)
    } catch (failure) {
      if (generation === requestGeneration.current) setError(failure)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  const count = loaded ? members.length : null

  return <>
    {renderTrigger
      ? renderTrigger(count, () => void showMembers())
      : <button type="button" className="role-group-link" onClick={() => void showMembers()}>
          {label}<span>{count ?? 'View'}</span>
        </button>}
    {open && <Modal title={`${label} group members`} onClose={() => setOpen(false)} variant="dialog" preventBackdropClose>
      <div className="role-group-modal-summary">
        <strong>{loading ? 'Loading active members…' : loaded ? `${members.length} active member${members.length !== 1 ? 's' : ''}` : 'Unable to confirm active members'}</strong>
        <span>{testCaseId ? 'These members are eligible to act on this test case.' : `Any member of this group can act on work assigned to ${label}${scopedDepartment ? ` in ${scopedDepartment}` : ' in this workspace'}.`}</span>
      </div>
      {loading ? <p className="role-group-empty" role="status">Loading group members…</p>
        : error ? <div className="role-group-empty"><ErrorText error={error} title="Could not load group members" /><button type="button" className="btn" onClick={() => void showMembers(true)}>Retry</button></div>
        : members.length ? <div className="role-group-members">
        {members.map((member) => <div className="role-group-member" key={member.id}>
          <span className="role-group-avatar">{member.full_name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>
          <span><strong>{member.full_name}</strong></span>
          <em>{userDepartments(member).length ? userDepartments(member).join(', ') : 'Department not set'}</em>
        </div>)}
      </div> : <div className="role-group-empty">
        <strong>No active members</strong>
        <span>Assign the {label} role to at least one active user{scopedDepartment ? ` in ${scopedDepartment}` : ' in this workspace'} from User &amp; Access.</span>
      </div>}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Close</button></div>
    </Modal>}
  </>
}
