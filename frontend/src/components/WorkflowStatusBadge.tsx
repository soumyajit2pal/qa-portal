import { approvalDirectoryRequest, type ApprovalDirectoryContext } from '../approvalStage'
import { useState, type ReactNode } from 'react'
import { Badge, Modal, ErrorText } from './Common'
import { api } from '../api'
import { activeWorkspaceId } from '../constants'
import { useAuth } from '../context/AuthContext'
import type { SuppressionOut, UserOption } from '../types'

type Context = ApprovalDirectoryContext & {
  status?: string | null
  application_master_status?: string | null
  sm_id?: number | null
  entity_type?: string | null
  entity_id?: number | null
  department_approvals?: Array<{
    department_name?: string | null
    decision: string
  }>
}

type ApproverMember = UserOption & { approvalDepartments?: string[] }

function pendingApprovalDepartments(record: Context, status?: string | null): string[] {
  if (status !== 'DEPARTMENT_HEAD_APPROVAL_PENDING') return []
  return [...new Set((record.department_approvals || [])
    .filter(approval => approval.decision === 'Pending')
    .map(approval => approval.department_name?.trim())
    .filter((name): name is string => Boolean(name)))]
}

export default function WorkflowStatusBadge({ status, label, record, workflow, testCaseId }: {
  status?: string | null; label?: ReactNode; record: Context; workflow?: 'signoff'; testCaseId?: number | null
}) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<ApproverMember[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resolvedDepartments, setResolvedDepartments] = useState<string[]>([])
  const directory = approvalDirectoryRequest({
    status,
    applicationMasterStatus: record.application_master_status,
    workflow,
    context: record,
    fallbackWorkspaceId: activeWorkspaceId(user),
    testCaseId,
  })
  if (!directory) return <Badge status={status} label={label} />
  const { group, departmentScoped, path } = directory
  const pendingDepartments = pendingApprovalDepartments(record, status)
  const displayedDepartments = pendingDepartments.length ? pendingDepartments : resolvedDepartments
  const load = async () => {
    setOpen(true); setLoading(true); setError(''); setMembers([])
    try {
      let approvalRecord = record
      let departments = pendingDepartments
      // Pending Approvals uses a compact cross-module row. Resolve the full
      // suppression before building its directory so a display-only value
      // such as "Payments, Treasury" is never sent as one fake department.
      if (!departments.length && status === 'DEPARTMENT_HEAD_APPROVAL_PENDING'
          && record.entity_type === 'SUPPRESSION' && record.entity_id) {
        const suppression = await api.get<SuppressionOut>(`/api/suppressions/${record.entity_id}`)
        approvalRecord = { ...record, ...suppression }
        departments = pendingApprovalDepartments(approvalRecord, status)
      }
      setResolvedDepartments(departments)
      if (departments.length > 0) {
        // Suppressions can wait on several Department Heads in parallel.
        // Resolve each still-pending department separately instead of using
        // the request's owning department for every badge. The API excludes
        // the requester; the recorded SM is filtered here as the second
        // maker-checker exclusion because user-options accepts one exclude.
        const results = await Promise.allSettled(departments.map(async department => {
          const request = approvalDirectoryRequest({
            status,
            applicationMasterStatus: approvalRecord.application_master_status,
            workflow,
            context: { ...approvalRecord, department },
            fallbackWorkspaceId: activeWorkspaceId(user),
            testCaseId,
          })
          if (!request) return { department, members: [] as UserOption[] }
          return { department, members: await api.get<UserOption[]>(request.path) }
        }))
        const byId = new Map<number, ApproverMember>()
        results.forEach(result => {
          if (result.status !== 'fulfilled') return
          result.value.members
            .filter(member => member.id !== approvalRecord.created_by_id && member.id !== approvalRecord.sm_id)
            .forEach(member => {
              const existing = byId.get(member.id)
              if (existing) {
                existing.approvalDepartments = [...new Set([...(existing.approvalDepartments || []), result.value.department])]
              } else {
                byId.set(member.id, { ...member, approvalDepartments: [result.value.department] })
              }
            })
        })
        setMembers([...byId.values()])
        const failures = results.filter(result => result.status === 'rejected').length
        if (failures) setError(`Unable to load approvers for ${failures} of ${departments.length} pending department${departments.length === 1 ? '' : 's'}.`)
      } else {
        setMembers(await api.get<UserOption[]>(path))
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load approvers.') }
    finally { setLoading(false) }
  }
  return <>
    <button type="button" style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', font: 'inherit' }} title="View responsible approvers" aria-label={`View responsible approvers for ${typeof label === 'string' ? label : group}`} onClick={event => { event.stopPropagation(); void load() }}><Badge status={status} label={label} /></button>
    {open && <Modal title="Responsible approvers" variant="dialog" compact preventBackdropClose onClose={() => setOpen(false)}>
      <section className="approver-directory" aria-label="Approval responsibility">
        <div className="approver-directory-summary">
          <div><span className="approver-directory-eyebrow">CURRENT APPROVAL STAGE</span><h4>{group}</h4>{departmentScoped && (displayedDepartments.length > 0 || record.department) && <p>{displayedDepartments.length > 0 ? displayedDepartments.join(', ') : record.department}</p>}</div>
          {!loading && <span className="approver-directory-count">{members.length} approver{members.length === 1 ? '' : 's'}{error && members.length ? ' loaded' : ''}</span>}
        </div>
        {loading ? <p className="approver-directory-message" role="status">Loading approvers…</p> : <>
          {error && <div className="approver-directory-message"><ErrorText error={error} /><button type="button" className="btn" onClick={() => void load()}>Retry</button></div>}
          {members.length ? <ul className="approver-directory-list">{members.map(member => <li className="approver-directory-member" key={member.id}>
              <span className="approver-directory-avatar" aria-hidden="true">{member.full_name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</span>
              <div className="approver-directory-identity"><strong>{member.full_name}</strong>{member.approvalDepartments?.length ? <small>{member.approvalDepartments.join(', ')}</small> : null}</div>
            </li>)}</ul>
          : !error && <p className="approver-directory-message">No active approvers are configured for this stage and scope. Contact your administrator.</p>}
        </>}
        <div className="approver-directory-footer"><button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Close</button></div>
      </section>
    </Modal>}
  </>
}
