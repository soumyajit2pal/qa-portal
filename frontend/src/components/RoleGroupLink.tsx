import { useUserOptions } from '../hooks/useUserOptions'
import { useMemo, useState, type ReactNode } from 'react'
import { Modal } from './Common'
import { userDepartments } from '../constants'
import type { UserOption } from '../types'

export default function RoleGroupLink({ users, role, label, department, repositoryGroup = false, renderTrigger }: {
  users: UserOption[]
  // A single role (the common case) or several -- e.g. Department Head
  // Approval is held jointly by DEPARTMENT_HEAD_CM and DEPARTMENT_HEAD_AGM
  // (identical authority, split only so approval logs show the exact
  // position), so that stage's group is "anyone holding either role,"
  // not two separate groups.
  role: string | string[]
  label: string
  // Reported directly (Application Owner): "whoever Application Owner on
  // that department should show" -- department-scoped roles (Application
  // Owner, SM, Department Head) are actually enforced server-side by
  // require_same_department, so a role-only member list can show people who
  // could never really act on this specific piece of work. Optional so
  // existing non-department-scoped callers (QA Lead, Security Analyst,
  // Executive -- none of those are department-restricted) are unaffected;
  // when provided, members are further filtered to a matching department.
  department?: string | null
  // Repository groups use their workspace QA directory, rather than the
  // department-scoped assignment picker used by other approval workflows.
  repositoryGroup?: boolean
  // Reported directly ("I AM ASKING HERE" -- the QA Request gateway's own
  // Application Name field, whose existing yellow "Application Owner
  // Approval Pending" status pill needed to open this same modal without
  // losing its pill styling/wording, unlike every other consumer of this
  // component, which is fine with the default "{label} {count}" button).
  // When provided, this renders instead of the default trigger button --
  // same member list/modal, caller controls the clickable element itself.
  renderTrigger?: (count: number, onClick: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const roles = useMemo(() => (Array.isArray(role) ? role : [role]), [role])
  const members = useUserOptions('approver', undefined, undefined, roles.join(','), department, repositoryGroup)

  return <>
    {renderTrigger
      ? renderTrigger(members.length, () => setOpen(true))
      : <button type="button" className="role-group-link" onClick={() => setOpen(true)}>
          {label}<span>{members.length}</span>
        </button>}
    {open && <Modal title={`${label} group members`} onClose={() => setOpen(false)} variant="dialog" preventBackdropClose>
      <div className="role-group-modal-summary">
        <strong>{members.length} active member{members.length !== 1 ? 's' : ''}</strong>
        <span>Any member of this group can act on work assigned to {label}{department ? ` in ${department}` : ''}.</span>
      </div>
      {members.length ? <div className="role-group-members">
        {members.map((member) => <div className="role-group-member" key={member.id}>
          <span className="role-group-avatar">{member.full_name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>
          <span><strong>{member.full_name}</strong></span>
          <em>{userDepartments(member).length ? userDepartments(member).join(', ') : 'Department not set'}</em>
        </div>)}
      </div> : <div className="role-group-empty">
        <strong>No active members</strong>
        <span>Assign the {label} role to at least one active user{department ? ` in ${department}` : ''} from User &amp; Access.</span>
      </div>}
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Close</button></div>
    </Modal>}
  </>
}
