import { approvalDirectoryRequest, type ApprovalDirectoryContext } from '../approvalStage'
import { useState, type ReactNode } from 'react'
import { Badge, Modal, ErrorText } from './Common'
import { api } from '../api'
import { activeWorkspaceId } from '../constants'
import { useAuth } from '../context/AuthContext'
import type { UserOption } from '../types'

type Context = ApprovalDirectoryContext & {
  status?: string | null
  application_master_status?: string | null
}

export default function WorkflowStatusBadge({ status, label, record, workflow, testCaseId }: {
  status?: string | null; label?: ReactNode; record: Context; workflow?: 'signoff'; testCaseId?: number | null
}) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
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
  const load = async () => {
    setOpen(true); setLoading(true); setError(''); setMembers([])
    try {
      setMembers(await api.get<UserOption[]>(path))
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load approvers.') }
    finally { setLoading(false) }
  }
  return <>
    <button type="button" style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', font: 'inherit' }} title="View responsible approvers" aria-label={`View responsible approvers for ${typeof label === 'string' ? label : group}`} onClick={event => { event.stopPropagation(); void load() }}><Badge status={status} label={label} /></button>
    {open && <Modal title="Responsible approvers" variant="dialog" compact preventBackdropClose onClose={() => setOpen(false)}>
      <section className="approver-directory" aria-label="Approval responsibility">
        <div className="approver-directory-summary">
          <div><span className="approver-directory-eyebrow">CURRENT APPROVAL STAGE</span><h4>{group}</h4>{departmentScoped && record.department && <p>{record.department}</p>}</div>
          {!loading && !error && <span className="approver-directory-count">{members.length} approver{members.length === 1 ? '' : 's'}</span>}
        </div>
        {loading ? <p className="approver-directory-message" role="status">Loading approvers…</p>
          : error ? <div className="approver-directory-message"><ErrorText error={error} /><button type="button" className="btn" onClick={() => void load()}>Retry</button></div>
          : members.length ? <ul className="approver-directory-list">{members.map(member => <li className="approver-directory-member" key={member.id}>
              <span className="approver-directory-avatar" aria-hidden="true">{member.full_name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</span>
              <div className="approver-directory-identity"><strong>{member.full_name}</strong></div>
            </li>)}</ul>
          : <p className="approver-directory-message">No active approvers are configured for this stage and scope. Contact your administrator.</p>}
        <div className="approver-directory-footer"><button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Close</button></div>
      </section>
    </Modal>}
  </>
}
