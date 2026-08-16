import React, { useMemo, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { hasRole } from '../constants'
import { QARequestDelegationOut, UserOut } from '../types'
import { ErrorText, Field, Modal } from './Common'
import UserAssignSelect from './UserAssignSelect'

type ChildDelegationTarget = 'FUNCTIONAL' | 'SAST' | 'DAST' | 'PERFORMANCE'

interface DelegatableChildRequest {
  id: number
  request_id: string
  requester_id?: number | null
  status: string
  qa_request?: { id: number; request_id?: string | null } | null
  active_delegation?: QARequestDelegationOut | null
}

interface ChildRequestDelegationProps<T extends DelegatableChildRequest> {
  targetType: ChildDelegationTarget
  request: T
  users: UserOut[]
  onChanged: (updated: T) => void | Promise<void>
}

const REQUESTER_STATUSES: Record<ChildDelegationTarget, Set<string>> = {
  FUNCTIONAL: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD',
  ]),
  SAST: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD',
  ]),
  DAST: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD',
  ]),
  PERFORMANCE: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER',
  ]),
}

const DETAIL_BASE: Record<ChildDelegationTarget, string> = {
  FUNCTIONAL: '/api/functional-requests',
  SAST: '/api/sast-requests',
  DAST: '/api/dast-requests',
  PERFORMANCE: '/api/performance-requests',
}

/**
 * Shared child-workflow delegation control.
 *
 * Delegation is intentionally attached to the exact Functional/SAST/DAST/
 * Performance request, never to its parent intake record. The delegate can
 * edit that one child and return it; the requester retains recall control but
 * cannot submit/resubmit while the assignment is active.
 */
export default function ChildRequestDelegation<T extends DelegatableChildRequest>({
  targetType,
  request,
  users,
  onChanged,
}: ChildRequestDelegationProps<T>) {
  const { user } = useAuth()
  const [dialog, setDialog] = useState<'assign' | 'return' | 'recall' | null>(null)
  const [assigneeId, setAssigneeId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const parentId = request.qa_request?.id
  const active = request.active_delegation?.status === 'ACTIVE'
    ? request.active_delegation
    : null
  const isAdmin = hasRole(user, 'ADMIN')
  const ownsRequest = request.requester_id === user?.id
  const canManage = ownsRequest || isAdmin
  const canAssign = !!parentId
    && canManage
    && !active
    && REQUESTER_STATUSES[targetType].has(request.status)
  const canReturn = !!parentId && active?.assigned_to_id === user?.id
  const canRecall = !!parentId && !!active && canManage

  const candidates = useMemo(
    () => users.filter((candidate) => candidate.is_active && candidate.id !== request.requester_id),
    [request.requester_id, users],
  )

  if (!parentId || (!canAssign && !canReturn && !canRecall && !active)) return null

  function closeDialog() {
    if (busy) return
    setDialog(null)
    setAssigneeId('')
    setNote('')
    setError(null)
  }

  async function refresh() {
    const updated = await api.get<T>(`${DETAIL_BASE[targetType]}/${request.id}`)
    await onChanged(updated)
  }

  async function submit() {
    const trimmed = note.trim()
    if (!trimmed) {
      setError(new Error(dialog === 'assign' ? 'Assignment reason is required.' : dialog === 'return' ? 'Return comments are required.' : 'Recall reason is required.'))
      return
    }
    if (dialog === 'assign' && !assigneeId) {
      setError(new Error('Select a user to receive this request.'))
      return
    }
    if (!dialog || !parentId) return

    setBusy(true)
    setError(null)
    try {
      const route = `/api/qa-requests/${parentId}/child-delegations/${targetType}/${request.id}`
      if (dialog === 'assign') {
        await api.post(route, { assigned_to_id: Number(assigneeId), reason: trimmed })
      } else {
        await api.post(`${route}/${dialog}`, { comments: trimmed })
      }
      await refresh()
      setDialog(null)
      setAssigneeId('')
      setNote('')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {active && (
        <span className="badge badge-info" title={active.assignment_reason}>
          Input assigned to {active.assigned_to_name || `user #${active.assigned_to_id}`}
        </span>
      )}
      {canAssign && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('assign')}>
          Delegate for Input
        </button>
      )}
      {canReturn && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('return')}>
          Return to Requester
        </button>
      )}
      {canRecall && (
        <button type="button" className="btn btn-sm" onClick={() => setDialog('recall')}>
          Recall Delegation
        </button>
      )}

      {dialog && (
        <Modal
          title={dialog === 'assign' ? `Delegate ${request.request_id} for input` : dialog === 'return' ? 'Return to requester' : 'Recall delegation'}
          onClose={closeDialog}
          variant="dialog"
          preventBackdropClose
        >
          <p className="muted small">
            {dialog === 'assign'
              ? 'The selected user can edit and upload documents on this request only. They cannot submit it or take approval decisions.'
              : dialog === 'return'
              ? 'Return this request after completing the requested changes. The requester will regain edit and submission control.'
              : 'End the assignment and restore edit control to the requester.'}
          </p>
          {dialog === 'assign' && (
            <Field label="Assign to *">
              <UserAssignSelect
                value={assigneeId}
                onChange={setAssigneeId}
                users={candidates}
                placeholder="Search any active user..."
                disabled={busy}
              />
            </Field>
          )}
          <Field label={dialog === 'assign' ? 'Reason for assignment *' : dialog === 'return' ? 'Return comments *' : 'Recall reason *'}>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
              rows={4}
              disabled={busy}
            />
          </Field>
          <ErrorText error={error} />
          <div className="form-actions">
            <button type="button" className="btn btn-sm" onClick={closeDialog} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
              {busy ? 'Saving...' : dialog === 'assign' ? 'Delegate Request' : dialog === 'return' ? 'Return Request' : 'Recall Delegation'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
